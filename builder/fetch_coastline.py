#!/usr/bin/env python3
"""Fetch the Natural Earth coastline and vendor a clipped copy for one region.

    python builder/fetch_coastline.py --region kerala-tn

Run this once per region. It needs network; ordinary bundle builds do not,
because the clipped result is committed at builder/data/coastline-<region>.geojson
and build_bundle.py reads that. A build that reaches the internet is a build
that produces different bytes depending on the day.

Source: Natural Earth 1:10m physical coastline, public domain, via the
nvkelso/natural-earth-vector GeoJSON mirror. COASTLINE ONLY. Natural Earth also
publishes country and disputed-area boundaries; those are not fetched, not
clipped and not shipped. This app already carries maritime lines that are
labelled advisory open data, and adding a second set of political lines from a
different source would blur a distinction the rest of the project is careful
about.

The upstream file is about 10 MB and is not committed.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from pathlib import Path

import db
import regions

SOURCE_URL = (
    "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/"
    "master/geojson/ne_10m_coastline.geojson"
)
ATTRIBUTION = "Coastline: Natural Earth 1:10m physical, public domain."

#: Same halo as the maritime boundaries. The map can be panned a little beyond
#: the region, and a coastline that stops dead at the box edge looks like the
#: land ends there.
HALO_DEG = 1.0

#: About 55 m, the same tolerance the maritime boundaries use.
#:
#: Natural Earth 10m is already coarse here: the raw clip is only 2,012
#: vertices for roughly 2,500 km of coast, about one point per 1.2 km. There is
#: almost nothing left to remove, so simplifying hard would cost shape and save
#: a few kilobytes. 0.002 dropped it to 1,332 points and made harbours blocky
#: for a saving of 5 KB, which is the wrong trade on a map someone zooms into.
SIMPLIFY_DEG = 0.0005

DATA_DIR = Path(__file__).resolve().parent / "data"


def bbox_of(coords, box=None):
    """Bounding box of nested coordinate lists, without shapely."""
    if box is None:
        box = [180.0, 90.0, -180.0, -90.0]
    if coords and isinstance(coords[0], (int, float)):
        lon, lat = float(coords[0]), float(coords[1])
        box[0] = min(box[0], lon)
        box[1] = min(box[1], lat)
        box[2] = max(box[2], lon)
        box[3] = max(box[3], lat)
        return box
    for part in coords:
        bbox_of(part, box)
    return box


def overlaps(a, b) -> bool:
    return not (a[2] < b[0] or a[0] > b[2] or a[3] < b[1] or a[1] > b[3])


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--region", default="kerala-tn")
    ap.add_argument("--cache", default=None,
                    help="path to an already-downloaded ne_10m_coastline.geojson")
    args = ap.parse_args()

    region = regions.get(args.region)
    lon_min, lat_min, lon_max, lat_max = region.bbox
    env = (lon_min - HALO_DEG, lat_min - HALO_DEG,
           lon_max + HALO_DEG, lat_max + HALO_DEG)

    if args.cache is not None:
        raw = json.loads(Path(args.cache).read_text())
        print(f"read {args.cache}")
    else:
        print(f"downloading {SOURCE_URL}")
        with urllib.request.urlopen(SOURCE_URL, timeout=120) as resp:
            payload = resp.read()
        print(f"  {len(payload):,} bytes")
        raw = json.loads(payload)

    features = raw.get("features", [])
    candidates = [
        f for f in features
        if f.get("geometry") and overlaps(bbox_of(f["geometry"]["coordinates"]), env)
    ]
    print(f"{len(features)} coastline features, {len(candidates)} near this region")

    parts: list[list[list[float]]] = []
    raw_points = 0
    with db.connect() as conn, conn.cursor() as cur:
        for feature in candidates:
            geom = json.dumps(feature["geometry"])
            cur.execute(
                """
                SELECT ST_AsGeoJSON(
                         ST_SimplifyPreserveTopology(
                           ST_Intersection(
                             ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326),
                             ST_MakeEnvelope(%s, %s, %s, %s, 4326)),
                           %s)),
                       ST_NPoints(ST_Intersection(
                             ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326),
                             ST_MakeEnvelope(%s, %s, %s, %s, 4326)))
                """,
                (geom, *env, SIMPLIFY_DEG, geom, *env),
            )
            clipped, npoints = cur.fetchone()
            if clipped is None:
                continue
            raw_points += npoints or 0
            parts.extend(db._geojson_to_parts(json.loads(clipped)))

    kept = sum(len(p) for p in parts)
    print(f"clipped: {raw_points:,} vertices, {kept:,} after simplifying at "
          f"{SIMPLIFY_DEG} deg (~{round(SIMPLIFY_DEG * 111320)} m)")

    if not parts:
        print("no coastline in this region", file=sys.stderr)
        return 1

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    out = DATA_DIR / f"coastline-{region.region_id}.geojson"
    out.write_text(json.dumps({
        "type": "MultiLineString",
        "coordinates": [[[round(x, 6), round(y, 6)] for x, y in part] for part in parts],
        "properties": {
            "attribution": ATTRIBUTION,
            "source_url": SOURCE_URL,
            "simplify_deg": SIMPLIFY_DEG,
            "clip_bbox": list(env),
            "region_id": region.region_id,
        },
    }, separators=(",", ":")) + "\n")
    print(f"wrote {out}  {out.stat().st_size:,} bytes  {len(parts)} parts")
    return 0


if __name__ == "__main__":
    sys.exit(main())
