#!/usr/bin/env python3
"""Export Joyce's public Notion trip page for the site.

Uses the unauthenticated endpoints that public *.notion.site pages use
themselves, so no integration token or workspace access is needed.

Outputs:
  --json PATH   structured data the site renders (to-dos + itinerary rows)
  --md PATH     the whole page tree as Markdown, for reading and git diffs

With no flags it refreshes both committed copies in the repo:
  data/notion.json and notion/snapshot.md

The omashu server runs it every few minutes with
  --json data/live/notion.json
so plan edits in Notion go live without a commit. See README "Notion sync".
"""
import argparse
import datetime as dt
import json
import os
import pathlib
import re
import sys
import tempfile
import urllib.request

SITE = "https://joycebean.notion.site"
ROOT = "352df3b8-9989-8097-909d-f34eb478c732"  # "Vietnam 2026"
PAGE_URL = f"{SITE}/Vietnam-2026-{ROOT.replace('-', '')}"
REPO = pathlib.Path(__file__).resolve().parent.parent


def api(endpoint, body):
    req = urllib.request.Request(
        f"{SITE}/api/v3/{endpoint}",
        data=json.dumps(body).encode(),
        # Notion returns 403 without a user agent.
        headers={"content-type": "application/json", "user-agent": "trip-site-sync"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def unwrap(rec):
    v = rec.get("value", {})
    return v.get("value", v) if isinstance(v, dict) else {}


class Store:
    """Every record fetched so far, keyed by id."""

    def __init__(self):
        self.blocks, self.collections = {}, {}

    def absorb(self, rm):
        for table, dest in (("block", self.blocks), ("collection", self.collections)):
            for k, rec in rm.get(table, {}).items():
                v = unwrap(rec)
                if v:
                    dest[k] = v

    def load_page(self, pid):
        cursor = {"stack": []}
        for _ in range(50):
            d = api("loadCachedPageChunkV2", {"page": {"id": pid}, "limit": 100,
                                              "cursor": cursor, "verticalColumns": False})
            self.absorb(d.get("recordMap", {}))
            cursors = d.get("cursors") or []
            if not cursors:
                break
            cursor = cursors[0]
        # Fetch any child blocks the chunk loader skipped.
        tried = set()
        while True:
            missing = [c for b in list(self.blocks.values()) for c in b.get("content", [])
                       if c not in self.blocks and c not in tried][:100]
            if not missing:
                break
            tried.update(missing)
            d = api("syncRecordValuesMain", {"requests": [
                {"pointer": {"table": "block", "id": i}, "version": -1} for i in missing]})
            self.absorb(d.get("recordMap", {}))

    def query_collection(self, block):
        cid, vids = block.get("collection_id"), block.get("view_ids") or []
        if not cid or not vids:
            return []
        space = block.get("space_id")
        d = api("queryCollection", {
            "collection": {"id": cid, "spaceId": space},
            "collectionView": {"id": vids[0], "spaceId": space},
            "loader": {"type": "reducer", "reducers": {"collection_group_results": {
                "type": "results", "limit": 500}}, "searchQuery": "", "userTimeZone": "UTC"},
        })
        self.absorb(d.get("recordMap", {}))
        res = d.get("result", {}).get("reducerResults", {}).get("collection_group_results", {})
        return res.get("blockIds", [])


# ---------- rich text ----------

def segments(store, rich):
    """Notion rich text -> [{"t": text, "href"?: url, "b"?: true}]."""
    out = []
    for seg in rich or []:
        s, seg_out = seg[0], {}
        for f in seg[1] if len(seg) > 1 else []:
            kind = f[0]
            if kind == "b":
                seg_out["b"] = True
            elif kind == "a":
                seg_out["href"] = f[1]
            elif kind == "lm":
                s, seg_out["href"] = f[1].get("title") or f[1]["href"], f[1]["href"]
            elif kind == "p":
                s = plain(store.blocks.get(f[1], {}).get("properties", {}).get("title")) or "a Notion page"
            elif kind == "u":
                s = "@someone"
            elif kind == "d":
                d = f[1]
                s = d.get("start_date", "") + (f" → {d['end_date']}" if d.get("end_date") else "")
        if s:
            out.append({"t": s, **seg_out})
    return out


def plain(rich):
    return "".join(seg[0] for seg in rich or [])


def to_md(segs):
    out = []
    for s in segs:
        t = s["t"]
        if s.get("b") and t.strip():
            t = f"**{t.strip()}** " if t.endswith(" ") else f"**{t}**"
        if s.get("href"):
            t = f"[{t}]({s['href']})"
        out.append(t)
    return "".join(out)


# ---------- page walk ----------

class Exporter:
    def __init__(self):
        self.store = Store()
        self.todos, self.itinerary, self.pages = [], [], []

    def run(self):
        done, queue = set(), [ROOT]
        while queue:
            pid = queue.pop(0)
            if pid in done:
                continue
            done.add(pid)
            self.store.load_page(pid)
            children = []
            body = self.render(pid, 0, children, collect_todos=(pid == ROOT))
            name = plain(self.store.blocks.get(pid, {}).get("properties", {}).get("title")) or pid
            self.pages.append((pid, name, body))
            queue += children
        return self

    def render(self, bid, depth, pages, collect_todos=False, todo_parent=None):
        S = self.store
        lines = []
        for cid in S.blocks.get(bid, {}).get("content", []):
            c = S.blocks.get(cid)
            if not c or not c.get("alive", True):
                continue
            t, ind = c.get("type"), "  " * depth
            segs = segments(S, c.get("properties", {}).get("title"))
            s = to_md(segs)
            if t == "page":
                pages.append(cid)
                lines.append(f"{ind}- 📄 {s}")
                continue
            if t in ("collection_view", "collection_view_page"):
                lines += self.render_collection(c, pages)
                continue
            child_parent = todo_parent
            if t == "to_do" and collect_todos:
                item = {"text": segs, "done": c.get("properties", {}).get("checked", [["No"]])[0][0] == "Yes",
                        "children": []}
                (todo_parent["children"] if todo_parent else self.todos).append(item)
                child_parent = item
            checked = "x" if c.get("properties", {}).get("checked", [["No"]])[0][0] == "Yes" else " "
            md = {
                "header": f"# {s}", "sub_header": f"## {s}", "sub_sub_header": f"### {s}",
                "bulleted_list": f"{ind}- {s}", "numbered_list": f"{ind}1. {s}",
                "to_do": f"{ind}- [{checked}] {s}", "toggle": f"{ind}- ▸ {s}",
                "quote": f"> {s}", "callout": f"> {s}", "code": f"```\n{plain(c.get('properties', {}).get('title'))}\n```",
                "divider": "---", "text": f"{ind}{s}",
            }.get(t)
            if md is None:
                src = c.get("properties", {}).get("source", [[""]])[0][0]
                md = f"{ind}[{t}] {s} {src}".rstrip() if (s or src) else ""
            if md.strip():
                lines.append(md)
            if c.get("content"):
                nested = t in ("bulleted_list", "numbered_list", "to_do", "toggle")
                lines += self.render(cid, depth + 1 if nested else depth, pages,
                                     collect_todos=collect_todos, todo_parent=child_parent)
        return lines

    def render_collection(self, block, pages):
        S = self.store
        rows = S.query_collection(block)
        coll = S.collections.get(block.get("collection_id"), {})
        schema = coll.get("schema", {})
        by_name = {v.get("name", ""): k for k, v in schema.items()}
        date_key = next((k for k, v in schema.items() if v.get("type") == "date"), None)
        check_key = next((k for k, v in schema.items() if v.get("type") == "checkbox"), None)

        def date_of(rid):
            for seg in S.blocks.get(rid, {}).get("properties", {}).get(date_key, []):
                for f in seg[1] if len(seg) > 1 else []:
                    if f[0] == "d":
                        return f[1].get("start_date", ""), f[1].get("start_time", ""), f[1].get("end_time", "")
            return "", "", ""

        # Stable sort: keeps Notion's order within a day.
        rows = sorted(rows, key=lambda r: date_of(r)[0] or "~")
        name = plain(coll.get("name")) or "Database"
        cols = ["title"] + [k for k in schema if k != "title" and schema[k].get("type") != "formula"]
        lines = [f"### 🗃 {name}", "",
                 "| " + " | ".join(schema[k].get("name") or "✓" for k in cols) + " |",
                 "|" + "---|" * len(cols)]
        for rid in rows:
            r = S.blocks.get(rid, {})
            props = r.get("properties", {})
            if r.get("content"):
                pages.append(rid)
            cells = []
            for k in cols:
                if k == check_key:
                    cells.append("✓" if props.get(k, [["No"]])[0][0] == "Yes" else "")
                elif k == date_key:
                    d0, t0, t1 = date_of(rid)
                    cells.append(" ".join(x for x in (d0, t0 and t0 + (f"–{t1}" if t1 else "")) if x))
                else:
                    cells.append(to_md(segments(S, props.get(k))))
            lines.append("| " + " | ".join(c.replace("|", "\\|").replace("\n", " ") for c in cells) + " |")
            if "Notes" in by_name and date_key:
                d, tm, tm_end = date_of(rid)
                if d:
                    self.itinerary.append({
                        "id": rid,
                        "date": d,
                        "time": tm or None,  # set when the Notion Date field includes a time
                        "endTime": tm_end or None,
                        "name": segments(S, props.get("title")),
                        "notes": segments(S, props.get(by_name["Notes"])),
                        "checked": bool(check_key) and props.get(check_key, [["No"]])[0][0] == "Yes",
                    })
        return lines + [""]

    def markdown(self):
        out = []
        for pid, name, body in self.pages:
            out += [f"<!-- notion:{pid} -->", f"# {name}", ""] + body + ["", ""]
        return "\n".join(out).rstrip() + "\n"

    def data(self):
        return {
            "source": PAGE_URL,
            "fetchedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "todos": self.todos,
            "itinerary": self.itinerary,
        }


def write_atomic(path, text):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--json", help="write site data here")
    ap.add_argument("--md", help="write Markdown snapshot here ('-' for stdout)")
    args = ap.parse_args()
    if not args.json and not args.md:
        args.json, args.md = REPO / "data/notion.json", REPO / "notion/snapshot.md"

    ex = Exporter().run()
    data = ex.data()
    # Guard against a bad fetch wiping the live site: never publish an empty itinerary.
    if not data["itinerary"]:
        sys.exit("notion_export: itinerary came back empty; leaving existing files alone")

    if args.json:
        write_atomic(args.json, json.dumps(data, ensure_ascii=False, indent=1) + "\n")
    if args.md == "-":
        sys.stdout.write(ex.markdown())
    elif args.md:
        write_atomic(args.md, ex.markdown())
    print(f"notion_export: {len(ex.pages)} pages, {len(data['itinerary'])} itinerary rows, "
          f"{len(data['todos'])} to-dos", file=sys.stderr)


if __name__ == "__main__":
    main()
