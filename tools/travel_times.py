#!/usr/bin/env python3
"""Fill in travel time between consecutive stops on the Map page.

For every day in data/trip.json, each stop on the path (has lat/lng, not
"off") gets a "hop" describing how we get there from the stop before:

    "hop": {"mode": "walk" | "grab", "min": 12, "km": 0.9}

Times come from the public OSRM servers at routing.openstreetmap.de (OSM
data, no key). Walking is used when it takes 15 minutes or less, otherwise a
Grab. Car times there assume empty roads, so city Grab times are padded
(x1.8 + 2 min for pickup) to match what the hour-by-hour plans quote.

A stop can carry "via": "<text>" instead (e.g. "Grab, 25–35 min") to use a
time from the plans as is; the script leaves those alone and drops any "hop".

    python3 tools/travel_times.py          # update data/trip.json in place
"""
import json
import os
import re
import sys
import time
import urllib.request
from collections import OrderedDict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TRIP = os.path.join(ROOT, 'data', 'trip.json')
OSRM = 'https://routing.openstreetmap.de/routed-{}/route/v1/driving/{},{};{},{}?overview=false'
WALK_MAX_MIN = 15
_cache = {}


def route(profile, a, b):
    key = (profile, a['lat'], a['lng'], b['lat'], b['lng'])
    if key not in _cache:
        url = OSRM.format(profile, a['lng'], a['lat'], b['lng'], b['lat'])
        req = urllib.request.Request(url, headers={'User-Agent': 'vietnam2026-trip-site/1.0'})
        for attempt in range(4):
            try:
                data = json.load(urllib.request.urlopen(req, timeout=30))
                break
            except Exception:
                if attempt == 3:
                    raise
                time.sleep(2 ** attempt)
        r = data['routes'][0]
        _cache[key] = (r['duration'] / 60, r['distance'] / 1000)
        time.sleep(0.5)
    return _cache[key]


def hop(a, b):
    walk_min, walk_km = route('foot', a, b)
    if walk_min <= WALK_MAX_MIN:
        return OrderedDict(mode='walk', min=max(1, round(walk_min)), km=round(walk_km, 1))
    car_min, car_km = route('car', a, b)
    # City traffic: pad heavily. Long highway runs (airport, Ninh Binh) less so.
    est = car_min * 1.8 + 2 if car_km < 15 else car_min * 1.3 + 5
    return OrderedDict(mode='grab', min=int(5 * round(est / 5)) if est > 20 else max(1, round(est)), km=round(car_km, 1))


def main():
    trip = json.load(open(TRIP), object_pairs_hook=OrderedDict)
    for day in trip['days']:
        prev = None   # last stop on the path in this part of the day
        gap = False   # an unpinned stop (no address yet) sits between prev and the next one
        for s in day.get('stops', []):
            if 'leg' in s:
                prev, gap = None, False
                continue
            if s.get('off'):
                continue
            if s.get('lat') is None:
                gap = True
                continue
            s.pop('hop', None)
            same = prev is not None and (prev['lat'], prev['lng']) == (s['lat'], s['lng'])
            if prev is not None and not same and not gap and 'via' not in s:
                s['hop'] = hop(prev, s)
                print(day['date'], prev['name'], '->', s['name'], dict(s['hop']), file=sys.stderr)
            prev, gap = s, False
    out = json.dumps(trip, ensure_ascii=False, indent=1) + '\n'
    # Keep short [start, end] pairs on one line, as they are written by hand.
    out = re.sub(r'\[\n\s+("[^"\n]*"),\n\s+("[^"\n]*")\n\s+\]', r'[\1, \2]', out)
    open(TRIP, 'w').write(out)


if __name__ == '__main__':
    main()
