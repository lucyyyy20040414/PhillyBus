#!/usr/bin/env python3
"""Build the per-route data the app runs on, from SEPTA's official GTFS feed.

For every SEPTA bus/trolley route and each direction it writes:
  - the ORDERED stop list (from the most common trip pattern)
  - the route's shape (simplified polyline)
  - each stop's distance in meters along that shape ("s")
so the app can place a rider's GPS position on the route and know exactly
which stops and landmarks lie ahead, for any route, with no live lookups.

Output:  data/index.json            route number -> name (also used to validate input)
         data/routes/<route>.json   one small file per route

Usage:   python3 scripts/build_routes.py [path-to-google_bus.zip | extracted dir]
         (with no argument it downloads SEPTA's latest GTFS release)

Re-run whenever SEPTA publishes a new schedule pick; stop patterns change
a few times a year. Only the Python standard library is needed.
"""
import collections
import csv
import datetime
import io
import json
import math
import os
import re
import sys
import tempfile
import urllib.request
import zipfile

GTFS_URL = "https://github.com/septadev/GTFS/releases/latest/download/gtfs_public.zip"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "data")
KEEP_TYPES = {"3", "0"}  # bus, trolley: what SEPTA's live TransitView feed covers
R = 6371000.0
MAX_SLIP = [0.0]  # largest backward projection correction made (for the build log)
SLIPPY = []  # (route, direction, meters) for corrections over 50 m: worth a look


def open_source(arg):
    """Return a function name -> text file handle for the GTFS bus feed."""
    if arg and os.path.isdir(arg):
        return lambda name: open(os.path.join(arg, name), newline="", encoding="utf-8-sig")
    tmp = tempfile.mkdtemp()
    path = arg
    if not path:
        print("Downloading", GTFS_URL)
        path = os.path.join(tmp, "gtfs_public.zip")
        urllib.request.urlretrieve(GTFS_URL, path)
    z = zipfile.ZipFile(path)
    if "google_bus.zip" in z.namelist():
        z.extract("google_bus.zip", tmp)
        z = zipfile.ZipFile(os.path.join(tmp, "google_bus.zip"))
    return lambda name: io.TextIOWrapper(z.open(name), encoding="utf-8-sig", newline="")


def rows(opener, name):
    with opener(name) as f:
        for r in csv.DictReader(f):
            yield r


# ---------- geometry ----------
def xy(lat0, lng0, lat, lng):
    return (math.radians(lng - lng0) * math.cos(math.radians(lat0)) * R, math.radians(lat - lat0) * R)


def simplify(points, eps_m):
    """Ramer-Douglas-Peucker on [(lat, lng)], iterative, tolerance in meters."""
    if len(points) < 3:
        return points
    lat0, lng0 = points[0]
    p = [xy(lat0, lng0, la, lo) for la, lo in points]
    keep = [False] * len(p)
    keep[0] = keep[-1] = True
    stack = [(0, len(p) - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = p[a]
        bx, by = p[b]
        dx, dy = bx - ax, by - ay
        seg2 = dx * dx + dy * dy
        best, idx = -1.0, -1
        for i in range(a + 1, b):
            px, py = p[i]
            if seg2 == 0:
                d = math.hypot(px - ax, py - ay)
            else:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / seg2))
                d = math.hypot(px - (ax + t * dx), py - (ay + t * dy))
            if d > best:
                best, idx = d, i
        if best > eps_m and idx > 0:
            keep[idx] = True
            stack.append((a, idx))
            stack.append((idx, b))
    return [points[i] for i in range(len(points)) if keep[i]]


def cumulative(points):
    cum = [0.0]
    for i in range(1, len(points)):
        a, b = points[i - 1], points[i]
        x, y = xy(a[0], a[1], b[0], b[1])
        cum.append(cum[-1] + math.hypot(x, y))
    return cum


def project_stop(points, cum, lat, lng, start_seg, window=200):
    """Position of a stop along the polyline, searching forward from start_seg.

    Takes the EARLIEST segment that is about as close as the closest one, not just
    the nearest anywhere ahead: on routes that pass the same street twice (loops,
    out-and-back), the nearest match can be the wrong pass.
    -> (s_meters, dist_m, seg_index)"""
    hits = []
    last = min(len(points) - 1, start_seg + window)
    for i in range(start_seg, last):
        a, b = points[i], points[i + 1]
        ax, ay = xy(lat, lng, a[0], a[1])  # stop is the origin
        bx, by = xy(lat, lng, b[0], b[1])
        dx, dy = bx - ax, by - ay
        seg2 = dx * dx + dy * dy
        t = 0.0 if seg2 == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / seg2))
        hits.append((math.hypot(ax + t * dx, ay + t * dy), cum[i] + t * math.sqrt(seg2), i))
    if not hits:
        return cum[-1], 0.0, start_seg
    dmin = min(h[0] for h in hits)
    for d, s_m, i in hits:
        if d <= dmin + 12.0:
            return s_m, d, i
    return hits[0][1], hits[0][0], hits[0][2]


def safe_name(s):
    return re.sub(r"[^A-Za-z0-9_-]", "_", s.upper())


def main():
    opener = open_source(sys.argv[1] if len(sys.argv) > 1 else None)

    routes = {}
    for r in rows(opener, "routes.txt"):
        if r["route_type"] in KEEP_TYPES:
            routes[r["route_id"]] = (r["route_short_name"], r["route_long_name"])
    print(len(routes), "bus/trolley routes")

    dir_names = {}
    try:
        for r in rows(opener, "directions.txt"):
            dir_names[(r["route_id"], r["direction_id"])] = (r["direction"], r["direction_destination"])
    except KeyError:
        pass

    # trips: most common shape (= main pattern) per route + direction
    trip_info = {}
    shape_counts = collections.defaultdict(collections.Counter)
    headsigns = collections.defaultdict(collections.Counter)
    for t in rows(opener, "trips.txt"):
        if t["route_id"] not in routes or not t["shape_id"]:
            continue
        key = (t["route_id"], t["direction_id"])
        trip_info[t["trip_id"]] = (key, t["shape_id"])
        shape_counts[key][t["shape_id"]] += 1
        headsigns[key][t["trip_headsign"]] += 1
    modal = {key: c.most_common(1)[0][0] for key, c in shape_counts.items()}
    candidates = {tid for tid, (key, shape) in trip_info.items() if modal[key] == shape}
    print(len(candidates), "candidate trips on the main patterns")

    # pass A: pick, per pattern, the trip that serves the most stops
    counts = collections.Counter()
    for st in rows(opener, "stop_times.txt"):
        if st["trip_id"] in candidates:
            counts[st["trip_id"]] += 1
    best_trip = {}
    for tid in candidates:
        key = trip_info[tid][0]
        if key not in best_trip or counts[tid] > counts[best_trip[key]]:
            best_trip[key] = tid
    chosen = set(best_trip.values())

    # pass B: the ordered stops of those trips
    seqs = collections.defaultdict(list)
    for st in rows(opener, "stop_times.txt"):
        if st["trip_id"] in chosen:
            seqs[st["trip_id"]].append((int(st["stop_sequence"]), st["stop_id"]))

    stops = {}
    for s in rows(opener, "stops.txt"):
        try:
            stops[s["stop_id"]] = (s["stop_name"], float(s["stop_lat"]), float(s["stop_lon"]))
        except ValueError:
            continue  # a few non-boarding entries have no coordinates

    needed = {trip_info[t][1] for t in chosen}
    shapes = collections.defaultdict(list)
    for p in rows(opener, "shapes.txt"):
        if p["shape_id"] in needed:
            shapes[p["shape_id"]].append((int(p["shape_pt_sequence"]), float(p["shape_pt_lat"]), float(p["shape_pt_lon"])))

    os.makedirs(os.path.join(OUT_DIR, "routes"), exist_ok=True)
    index = {}
    for old in os.listdir(os.path.join(OUT_DIR, "routes")):
        os.remove(os.path.join(OUT_DIR, "routes", old))

    by_route = collections.defaultdict(dict)
    for key, tid in best_trip.items():
        rid, did = key
        raw = sorted(shapes[trip_info[tid][1]])
        pts = [(la, lo) for _, la, lo in raw]
        if len(pts) < 2:
            continue
        pts = simplify(pts, 3.0)
        cum = cumulative(pts)
        ordered = [sid for _, sid in sorted(seqs[tid])]
        out_stops = []
        seg = 0
        prev_s = 0.0
        for sid in ordered:
            if sid not in stops:
                continue
            name, la, lo = stops[sid]
            s, dist, seg = project_stop(pts, cum, la, lo, seg)
            slip = prev_s - s
            if slip > 0:
                MAX_SLIP[0] = max(MAX_SLIP[0], slip)
                if slip > 50:
                    SLIPPY.append((routes[rid][0], did, round(slip)))
                s = prev_s  # stop order along the route can never go backward
            prev_s = s
            out_stops.append({"id": sid, "n": name, "lat": round(la, 5), "lng": round(lo, 5), "s": int(round(s))})
        label, dest = dir_names.get(key, ("", ""))
        head = headsigns[key].most_common(1)[0][0]
        by_route[rid][did] = {
            "id": int(did),
            "label": label or "",
            "to": dest or head,
            "headsign": head,
            "len": int(round(cum[-1])),
            "shape": [[round(la, 5), round(lo, 5)] for la, lo in pts],
            "stops": out_stops,
        }

    total = 0
    for rid, dirs in by_route.items():
        short, long_name = routes[rid]
        doc = {"route": short, "name": long_name, "dirs": [dirs[k] for k in sorted(dirs)]}
        path = os.path.join(OUT_DIR, "routes", safe_name(short) + ".json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(doc, f, separators=(",", ":"), ensure_ascii=False)
        total += os.path.getsize(path)
        index[short] = {"name": long_name, "file": safe_name(short) + ".json"}

    with open(os.path.join(OUT_DIR, "index.json"), "w", encoding="utf-8") as f:
        json.dump({"built": datetime.date.today().isoformat(), "source": "SEPTA GTFS", "routes": index}, f, separators=(",", ":"), ensure_ascii=False)
    if SLIPPY:
        print("directions with a >50 m ordering correction (loops/branches; check these):", sorted(set(SLIPPY)))
    print("wrote", len(index), "routes,", round(total / 1e6, 2), "MB total; largest backward correction", round(MAX_SLIP[0]), "m")


if __name__ == "__main__":
    main()
