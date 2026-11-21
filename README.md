# vietnam2026

Trip site for Vietnam, November 19–28, 2026 — Ho Chi Minh City → Hanoi, with a Ninh Binh day trip.

Static site, no build step. Live at https://vietnam.jonathanhsieh.dev.

## How the content works

Joyce's public Notion page is where the group plans:
https://joycebean.notion.site/Vietnam-2026-352df3b899898097909df34eb478c732

The site renders everything in the browser (`js/app.js`) from two data files:

| File | What | Who updates it |
|---|---|---|
| `data/trip.json` | Curated facts that rarely change: stays (addresses, Maps queries, check-in/out), people, places, day titles, "heads up" tips, missing-info list | Edited by hand, committed |
| `data/live/notion.json` | Day-by-day plans (the Notion "Vietnam Itinerary" database) and the Notion to-do list | The omashu server, every 5 minutes. Not in git |
| `data/notion.json` | Committed copy of the above, used when the live file is missing (e.g. local preview) | `tools/notion_export.py` |
| `notion/snapshot.md` | The whole Notion page tree as Markdown, so `git diff` shows what changed | `tools/notion_export.py` |

So an edit to a plan in Notion is live within about 5 minutes with no commit. A change to a stay, a flight to call out, or a day title needs an edit to `data/trip.json`.

How Notion rows are shown: a row whose name mentions check-in/out, a flight, departure, or an arrival is tagged and sorted by any time it mentions (e.g. "1pm"). Rows like "hcm - day 2" with no notes are treated as headers and skipped. A "?" or "tbd" in the name marks the item as *maybe*.

### Syncing the curated data with Notion

```
python3 tools/notion_export.py      # refresh data/notion.json + notion/snapshot.md
git diff notion/snapshot.md         # see what changed in Notion
```

If the diff touches stays, flights or other curated facts, update `data/trip.json` to match, then commit and push.

### Previewing a date

Add `?date=2026-11-24` to any page to see the site as it will look that day (today's card, "Day 6 of 10", past days dimmed).

## Structure

- `index.html` — today: countdown before the trip, then "Day N of 10", today's plan, tonight's stay, route map
- `calendar.html` — "Hours": one day at a time on an hour grid (Vietnam time). Items with a clock time ("1pm", "12:20pm - 2:30pm", or a time set on the Notion Date field) are solid blocks. Items without one are placed by keyword as dashed estimates ("daytime" ≈ 10–5, "night"/"bar" ≈ 9pm–1am, "dinner" ≈ 6–8:30pm, "day trip" ≈ 7–6). Anything with no clue goes in an "Anytime" strip. Suggested times like "leave by" live in `trip.json` `days[].events`. Link to a day with `calendar.html#2026-11-24`.
- `itinerary.html` — every day: logistics, plans from Notion, where we sleep; auto-scrolls to today during the trip
- `map.html` — "Map": one day at a time, its stops (`trip.json` `days[].stops`) as numbered pins joined in visiting order, with the travel time between each pair. A time the plans quote goes in a stop's `via` (e.g. `"Grab, ~8 min"`); the rest are computed by `python3 tools/travel_times.py`, which writes each stop's `hop` from OpenStreetMap routes (walk if ≤15 min, else Grab, padded for traffic). Re-run it after adding or moving stops. Link to a day with `map.html#2026-11-24` (`#2026-11-24/2` for the part after the flight).
- `housing.html` — stays, with Maps / copy address / "Show driver" (large address plus a Vietnamese "please take me here")
- `js/app.js` — all rendering; `css/style.css` — styles
- `sw.js` — service worker: network-first with a 4s timeout, falls back to the last saved copy offline
- `tools/notion_export.py` — Notion exporter (uses the public notion.site API; no token)

## Local preview

```
python3 -m http.server 8080
```

Then open `http://localhost:8080`.

## Deployment

Push to `main` — the site updates within about a minute. No manual step.

How it works, on the `omashu` GCE VM (`gcloud compute ssh omashu --project=omashu-420807 --zone=us-central1-a`):

- Apache vhost `vietnam.jonathanhsieh.dev` (HTTPS via Let's Encrypt/certbot) serves `/var/www/vietnam2026`, a symlink to the git clone at `/home/jonathanh1386/vietnam2026`.
- `vietnam2026-deploy.timer` runs `vietnam2026-deploy.service` every minute, which does `git fetch` + `git merge --ff-only origin/main` in that clone as `jonathanh1386`.
- `vietnam2026-notion.timer` runs `vietnam2026-notion.service` every 5 minutes, which runs `tools/notion_export.py --json data/live/notion.json` in that clone as `jonathanh1386`. If Notion fails or returns an empty itinerary, the previous file is kept.
- `/etc/apache2/conf-enabled/block-git.conf` returns 404 for any `/.git` path.

Never edit files or run git with `sudo` in the server clone — root-owned files break the pull. If a deploy or sync seems stuck:

```
sudo journalctl -u vietnam2026-deploy.service -n 20
sudo journalctl -u vietnam2026-notion.service -n 20
```
