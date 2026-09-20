#!/usr/bin/env python3
"""Fetch Natural Earth land and vendor a land mask for India.

    python builder/fetch_land.py

Run this once. It needs network; ordinary bundle builds do not, because the
result is committed at public/land/india-land.bin. A build that reaches the
internet is a build that produces different bytes depending on the day.

Source: Natural Earth 1:10m physical LAND, public domain, via the
nvkelso/natural-earth-vector GeoJSON mirror. LAND ONLY. Natural Earth also
publishes country and disputed-area boundaries; those are not fetched, not
clipped and not shipped. This app already carries maritime lines labelled as
advisory open data, and adding a second set of political lines from a different
source would blur a distinction the rest of the project is careful about. The
file below therefore knows where the sea ends. It does not know, and must never
be described as knowing, where one country ends and another begins.

WHY THIS EXISTS
---------------
The app must never show a marine verdict to someone standing on land, and
before this file existed it did, routinely.

Sampling the Kerala-TN region box on a 0.02 degree grid finds 56,882 points on
land, and 3,052 of them -- 5.4 per cent -- fell inside a forecast hexagon and
were handed a sea verdict. The worst was CAUTION, 18.5 per cent chance of
dangerous seas, for a point 1.3 km inland near Kanyakumari (8.18, 77.72). The
furthest inland was 81 km (13.00, 79.52). Hexagons at H3 resolution 5 are 8.5
km across and ORCA's hazard field does not stop at the waterline, so the cell
lookup answers confidently well inside the coast.

That is the kind of wrong that costs you every other number on the screen.

THE CLIP-EDGE TRAP
------------------
Natural Earth land is one polygon for the whole Asian landmass. Clipping it to
a box turns the four box edges into rings that look exactly like coastline, and
"distance to the nearest coast" would happily measure to one of them. For a
point in Punjab the nearest real coast and the nearest fake box edge are both
several hundred kilometres away, so the answer would look entirely plausible
and be wrong.

Every segment is therefore tagged. A segment whose two endpoints both sit on
the same side of the clip envelope is a clip artefact, not coast. Containment
uses every segment, because the rings must stay closed for the inside test to
mean anything. Distance-to-coast uses only the segments tagged as real.

FILE FORMAT, version 1. Normative; src/geo/land.ts reads exactly this.
--------------------------------------------------------------------
All integers little-endian. Coordinates are int32 in units of 1e-7 degrees,
the same convention docs/BUNDLE_FORMAT.md uses, so there is one coordinate
encoding in this project rather than two.

  offset size field
  0      8    magic, exactly b"ORCALND\\0"
  8      2    uint16 format_version
  10     2    uint16 header_bytes (40)
  12     4    uint32 ring_count
  16     4    uint32 point_count      total across all rings
  20     16   int32 x4 clip envelope: west, south, east, north
  36     4    uint32 flag_bytes       length of the coast bitmap

  40                 ring table, ring_count records of 24 bytes:
                       int32  min_lon, min_lat, max_lon, max_lat
                       uint32 first_point   index into the point array
                       uint32 n_points

  then               point array, point_count records of 8 bytes:
                       int32 lon, int32 lat

  then               coast bitmap, flag_bytes bytes. Bit i, counted from the
                     least significant bit of byte i//8, is 1 when segment i is
                     real coast and 0 when it is a clip artefact.

                     Segments are numbered globally in ring order. A ring of
                     n points is closed -- its last point repeats its first --
                     and contributes n-1 segments.
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
import urllib.request
from pathlib import Path

import db

SOURCE_URL = (
    "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/"
    "master/geojson/ne_10m_land.geojson"
)
ATTRIBUTION = "Land: Natural Earth 1:10m physical, public domain."

MAGIC = b"ORCALND\0"
FORMAT_VERSION = 1
HEADER_BYTES = 40
COORD_SCALE = 1e7

#: The clip envelope, west, south, east, north.
#:
#: Generous on purpose. India's own extent is about 68.1 to 97.4 east and 6.7
#: to 35.5 north, plus Lakshadweep out to 71.7 and the Andaman and Nicobar
#: islands down to 6.7. A box drawn tightly around that would put clip edges
#: within a few hundred kilometres of real users, and although those edges are
#: tagged and excluded from the coast distance, the tag is a safety net rather
#: than a licence to place the trap close to people. This box also keeps the
#: Pakistani, Sri Lankan, Bangladeshi and Burmese coasts, which is what makes
#: "distance to the nearest coast" honest near a land border instead of
#: measuring to a coast that is merely the nearest INDIAN one.
ENVELOPE = (66.0, 4.0, 99.5, 39.5)

#: About 55 m, the same tolerance the maritime boundaries and the coastline
#: use. The question this file answers is binary -- land or sea -- and near a
#: harbour mouth the answer changes over a few tens of metres, so this is not
#: the place to save bytes by rounding the coast off. See the size report the
#: script prints; if it ever needs to shrink, raise this rather than dropping
#: islands, because a dropped island tells someone standing on it that they are
#: at sea.
SIMPLIFY_DEG = 0.0005

OUT = Path(__file__).resolve().parent.parent / "public" / "land" / "india-land.bin"


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


def rings_of(geom) -> list[list[list[float]]]:
    """Every ring in a GeoJSON geometry, exterior and hole alike.

    Holes are kept and are NOT distinguished from exteriors. The inside test in
    src/geo/land.ts counts a point as on land when it falls inside an odd
    number of rings, which is exactly the even-odd rule, and that handles a
    lake inside a landmass correctly without either side needing to know which
    ring was which.
    """
    kind = geom.get("type")
    if kind == "Polygon":
        return [list(r) for r in geom["coordinates"]]
    if kind == "MultiPolygon":
        return [list(r) for poly in geom["coordinates"] for r in poly]
    if kind == "GeometryCollection":
        out = []
        for g in geom.get("geometries", []):
            out.extend(rings_of(g))
        return out
    # A clip can also yield lines or points where the box grazes a coast.
    # Nothing to close, so nothing to contain: drop them.
    return []


def quantise(ring) -> list[tuple[int, int]]:
    """Round to 1e-7 degrees and drop consecutive duplicates.

    Rounding first and testing afterwards matters: the clip-artefact flags are
    computed from these integers, so a flag can never disagree with the
    coordinate actually written to the file.
    """
    out: list[tuple[int, int]] = []
    for lon, lat in ring:
        p = (round(float(lon) * COORD_SCALE), round(float(lat) * COORD_SCALE))
        if not out or out[-1] != p:
            out.append(p)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cache", default=None,
                    help="path to an already-downloaded ne_10m_land.geojson")
    ap.add_argument("--simplify", type=float, default=SIMPLIFY_DEG)
    args = ap.parse_args()

    env = ENVELOPE
    env_i = tuple(round(v * COORD_SCALE) for v in env)

    if args.cache is not None:
        raw = json.loads(Path(args.cache).read_text())
        print(f"read {args.cache}")
    else:
        print(f"downloading {SOURCE_URL}")
        with urllib.request.urlopen(SOURCE_URL, timeout=180) as resp:
            payload = resp.read()
        print(f"  {len(payload):,} bytes")
        raw = json.loads(payload)

    features = raw.get("features", [])
    candidates = [
        f for f in features
        if f.get("geometry") and overlaps(bbox_of(f["geometry"]["coordinates"]), env)
    ]
    print(f"{len(features)} land features, {len(candidates)} overlap the envelope")

    rings: list[list[tuple[int, int]]] = []
    raw_points = 0
    with db.connect() as conn, conn.cursor() as cur:
        for feature in candidates:
            geom = json.dumps(feature["geometry"])
            cur.execute(
                """
                SELECT ST_AsGeoJSON(
                         ST_SimplifyPreserveTopology(
                           ST_Intersection(
                             ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326)),
                             ST_MakeEnvelope(%s, %s, %s, %s, 4326)),
                           %s)),
                       ST_NPoints(ST_Intersection(
                             ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326)),
                             ST_MakeEnvelope(%s, %s, %s, %s, 4326)))
                """,
                (geom, *env, args.simplify, geom, *env),
            )
            clipped, npoints = cur.fetchone()
            if clipped is None:
                continue
            raw_points += npoints or 0
            for ring in rings_of(json.loads(clipped)):
                q = quantise(ring)
                # A ring needs three distinct corners plus the repeated first
                # point to enclose any area at all.
                if len(q) < 4:
                    continue
                if q[0] != q[-1]:
                    q.append(q[0])
                rings.append(q)

    if not rings:
        print("no land in this envelope", file=sys.stderr)
        return 1

    total_points = sum(len(r) for r in rings)
    total_segments = sum(len(r) - 1 for r in rings)
    print(f"clipped: {raw_points:,} vertices, {total_points:,} after simplifying "
          f"at {args.simplify} deg (~{round(args.simplify * 111320)} m)")

    # --- assemble -----------------------------------------------------------
    ring_table = bytearray()
    points = bytearray()
    flags = bytearray((total_segments + 7) // 8)

    w, s, e, n = env_i
    first_point = 0
    seg_index = 0
    coast_segments = 0

    for ring in rings:
        lons = [p[0] for p in ring]
        lats = [p[1] for p in ring]
        ring_table += struct.pack(
            "<4i2I", min(lons), min(lats), max(lons), max(lats),
            first_point, len(ring),
        )
        for lon, lat in ring:
            points += struct.pack("<2i", lon, lat)

        # A segment is a clip artefact when both of its endpoints lie on the
        # same side of the envelope. Anything else is real coast.
        for i in range(len(ring) - 1):
            (x1, y1), (x2, y2) = ring[i], ring[i + 1]
            artefact = (
                (x1 == w and x2 == w) or (x1 == e and x2 == e) or
                (y1 == s and y2 == s) or (y1 == n and y2 == n)
            )
            if not artefact:
                flags[seg_index // 8] |= 1 << (seg_index % 8)
                coast_segments += 1
            seg_index += 1

        first_point += len(ring)

    header = struct.pack(
        "<8sHHII4iI", MAGIC, FORMAT_VERSION, HEADER_BYTES,
        len(rings), total_points, w, s, e, n, len(flags),
    )
    assert len(header) == HEADER_BYTES, len(header)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes(bytes(header) + bytes(ring_table) + bytes(points) + bytes(flags))

    size = OUT.stat().st_size
    print(f"rings {len(rings):,}  points {total_points:,}  segments {total_segments:,}")
    print(f"  real coast {coast_segments:,}, clip artefacts "
          f"{total_segments - coast_segments:,}")
    print(f"wrote {OUT}  {size:,} bytes  ({size / 1024:.1f} KB)")
    print(f"  {ATTRIBUTION}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
