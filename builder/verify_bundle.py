#!/usr/bin/env python3
"""Read a bundle back and prove it matches the database.

    python builder/verify_bundle.py out/kerala-tn.orcabundle

This file parses the bundle with struct alone and does NOT import writer.py.
That is deliberate: a verifier built on the writer's own helpers would agree
with the writer about a bug. The layout is re-derived here from
docs/BUNDLE_FORMAT.md, so the two only agree when the spec is what actually
got written.

Exits non-zero on the first check that fails.
"""

from __future__ import annotations

import json
import struct
import sys
from datetime import datetime, timedelta
from pathlib import Path

import cells as cellmod
import db
import regions

MAGIC = b"ORCABND\x00"
READER_VERSION = 2
# A reader must also refuse a bundle OLDER than it understands. Version 2
# changed the landing centre record from 20 to 32 bytes, so a version 2 reader
# turned loose on a version 1 file would stride through it wrongly and produce
# positions that look plausible and are not.
MIN_SUPPORTED_FORMAT = 2
NO_DATA = 255
VALUE_SCALE = 254
COORD_SCALE = 10_000_000

# One quantisation step. A decoded value may differ from the database by at
# most half of this, and floating point gives us a little slack on top.
STEP = 1.0 / VALUE_SCALE
VALUE_TOLERANCE = STEP / 2 + 1e-9
COORD_TOLERANCE_DEG = 1.0 / COORD_SCALE + 1e-12


class Failed(Exception):
    pass


def check(condition: bool, message: str) -> None:
    if not condition:
        raise Failed(message)


# --------------------------------------------------------------------------
# independent reader
# --------------------------------------------------------------------------

class Bundle:
    def __init__(self, blob: bytes) -> None:
        self.blob = blob
        check(len(blob) >= 32, "file is shorter than a header")

        (magic, self.format_version, self.min_reader_version, self.header_bytes,
         self.section_count, self.n_cells, self.n_hours, self.h3_resolution,
         self.flags, reserved, self.file_bytes) = struct.unpack_from("<8sHHHHIIBBHI", blob, 0)

        check(magic == MAGIC, f"bad magic {magic!r}, this is not an ORCA bundle")
        check(reserved == 0, "reserved header field is not zero")
        check(self.file_bytes == len(blob),
              f"header says {self.file_bytes} bytes, file is {len(blob)}")
        check(self.min_reader_version <= READER_VERSION,
              f"bundle needs reader version {self.min_reader_version}, "
              f"this verifier is {READER_VERSION}")
        check(self.format_version >= MIN_SUPPORTED_FORMAT,
              f"bundle is format version {self.format_version}; this reader "
              f"understands {MIN_SUPPORTED_FORMAT} and newer")

        self.sections: dict[int, tuple[int, int, int]] = {}
        for i in range(self.section_count):
            p = self.header_bytes + i * 16
            type_id, flags, offset, length, count = struct.unpack_from("<HHIII", blob, p)
            check(flags == 0, f"section {type_id} has non-zero reserved flags")
            check(offset % 8 == 0, f"section {type_id} offset {offset} is not 8-byte aligned")
            check(offset + length <= len(blob),
                  f"section {type_id} runs past the end of the file")
            self.sections[type_id] = (offset, length, count)

    def raw(self, type_id: int) -> tuple[int, int, int]:
        check(type_id in self.sections, f"required section {type_id} is missing")
        return self.sections[type_id]

    def meta(self) -> dict:
        off, length, count = self.raw(1)
        check(count == 1, "metadata item_count should be 1")
        return json.loads(self.blob[off:off + length].decode("utf-8"))

    def cells(self) -> list[int]:
        off, length, count = self.raw(2)
        check(length == count * 8, "cell index length does not match item_count")
        return list(struct.unpack_from(f"<{count}Q", self.blob, off))

    def grid(self, type_id: int) -> memoryview:
        off, length, count = self.raw(type_id)
        check(length == count, f"section {type_id} length does not match item_count")
        check(count == self.n_cells * self.n_hours,
              f"section {type_id} holds {count} bytes, expected n_cells*n_hours="
              f"{self.n_cells * self.n_hours}")
        return memoryview(self.blob)[off:off + length]

    def strings(self) -> list[str]:
        off, length, count = self.raw(7)
        n, bytes_offset = struct.unpack_from("<II", self.blob, off)
        check(n == count, "string table count disagrees with the directory")
        check(bytes_offset % 8 == 0, "string blob offset is not 8-byte aligned")
        offsets = struct.unpack_from(f"<{n + 1}I", self.blob, off + 8)
        base = off + bytes_offset
        out = []
        for i in range(n):
            a, b = offsets[i], offsets[i + 1]
            check(a <= b, f"string {i} has a negative length")
            check(base + b <= off + length, f"string {i} runs past the section")
            out.append(self.blob[base + a:base + b].decode("utf-8"))
        check(out and out[0] == "", "string index 0 must be the empty string")
        return out

    def zones(self) -> list[dict]:
        off, length, count = self.raw(5)
        n_zones, n_parts, n_points, points_offset = struct.unpack_from("<IIII", self.blob, off)
        check(n_zones == count, "zone count disagrees with the directory")
        check(points_offset % 8 == 0, "zone points offset is not 8-byte aligned")
        check(points_offset + n_points * 8 <= length, "zone points run past the section")

        part_base = off + 16 + n_zones * 24
        part_offsets = struct.unpack_from(f"<{n_parts + 1}I", self.blob, part_base)
        check(part_offsets[-1] == n_points,
              "final part offset does not equal n_points")
        check(list(part_offsets) == sorted(part_offsets),
              "part offsets are not ascending")

        pts_base = off + points_offset
        out = []
        for z in range(n_zones):
            (type_id, authority, geom_kind, name_str, attribution_str,
             source_url_str, first_part, part_count) = struct.unpack_from(
                "<HBBIIIII", self.blob, off + 16 + z * 24)
            check(first_part + part_count <= n_parts,
                  f"zone {z} references parts past the end")
            parts = []
            for p in range(first_part, first_part + part_count):
                a, b = part_offsets[p], part_offsets[p + 1]
                coords = struct.unpack_from(f"<{2 * (b - a)}i", self.blob, pts_base + a * 8)
                parts.append([
                    (coords[2 * i] / COORD_SCALE, coords[2 * i + 1] / COORD_SCALE)
                    for i in range(b - a)
                ])
            out.append({
                "zone_type_id": type_id, "authority": authority,
                "geom_kind": geom_kind, "name_str": name_str,
                "attribution_str": attribution_str, "source_url_str": source_url_str,
                "parts": parts,
            })
        return out

    def harbours(self) -> list[dict]:
        off, length, count = self.raw(6)
        check(length == count * 32, "landing centre length does not match item_count")
        out = []
        for i in range(count):
            (lat, lon, cell_index, offset_m, id_str, name_str, district_str,
             type_id, source_index, flags) = struct.unpack_from(
                "<iiIIIIIBBH", self.blob, off + i * 32)
            check(flags == 0, f"landing centre {i} has non-zero reserved flags")
            out.append({
                "lat": lat / COORD_SCALE, "lon": lon / COORD_SCALE,
                "cell_index": cell_index, "offset_m": offset_m,
                "harbour_type_id": type_id, "source_index": source_index,
                "id_str": id_str, "name_str": name_str, "district_str": district_str,
            })
        return out

    def rings(self) -> list[list[tuple[float, float]]] | None:
        if 11 not in self.sections:
            return None
        off, length, count = self.sections[11]
        stride = 6 * 4
        check(length == count * stride, "hexagon section is the wrong size")
        cent = self.centroids()
        out = []
        for c in range(count):
            clon, clat = cent[c]
            ring = []
            for v in range(6):
                dlon, dlat = struct.unpack_from("<hh", self.blob, off + c * stride + v * 4)
                ring.append((clon + dlon / 100_000, clat + dlat / 100_000))
            out.append(ring)
        return out

    def coastline(self) -> list[list[tuple[float, float]]] | None:
        if 12 not in self.sections:
            return None
        off, length, count = self.sections[12]
        n_parts, n_points, points_offset, _attr = struct.unpack_from("<IIII", self.blob, off)
        check(n_parts == count, "coastline part count disagrees with the directory")
        offsets = struct.unpack_from(f"<{n_parts + 1}I", self.blob, off + 16)
        check(offsets[-1] == n_points, "coastline offsets do not end at n_points")
        base = off + points_offset
        out = []
        for i in range(n_parts):
            a, b = offsets[i], offsets[i + 1]
            vals = struct.unpack_from(f"<{2 * (b - a)}i", self.blob, base + a * 8)
            out.append([(vals[2 * k] / COORD_SCALE, vals[2 * k + 1] / COORD_SCALE)
                        for k in range(b - a)])
        return out

    def centroids(self) -> list[tuple[float, float]]:
        off, length, count = self.raw(10)
        check(length == count * 8, "centroid length does not match item_count")
        vals = struct.unpack_from(f"<{2 * count}i", self.blob, off)
        return [(vals[2 * i] / COORD_SCALE, vals[2 * i + 1] / COORD_SCALE)
                for i in range(count)]


def decode(b: int) -> float | None:
    return None if b == NO_DATA else b / VALUE_SCALE


# --------------------------------------------------------------------------
# checks
# --------------------------------------------------------------------------

def verify(path: Path) -> None:
    blob = path.read_bytes()
    bundle = Bundle(blob)
    ok(f"header: format {bundle.format_version}, min reader "
       f"{bundle.min_reader_version}, {bundle.n_cells} cells x {bundle.n_hours} hours, "
       f"H3 res {bundle.h3_resolution}, {bundle.file_bytes:,} bytes")

    meta = bundle.meta()
    strings = bundle.strings()
    region = regions.get(meta["region_id"])
    ok(f"metadata parses: region {meta['region_id']!r}, {len(strings)} strings")

    with db.connect() as conn:
        check_versioning(bundle)
        check_meta(bundle, meta)
        cells = check_cells(conn, bundle, region)
        check_values(conn, bundle, cells, meta)
        check_no_data_rule()
        check_zones(conn, bundle, region, meta, strings)
        check_centroids(bundle, cells)
        check_rings(bundle, cells)
        check_coastline(bundle, region, meta)
        check_harbours(conn, bundle, region, strings, meta, cells)
        check_dem(bundle, meta)
        check_no_simulation(conn, cells, meta, bundle)


def check_versioning(bundle: Bundle) -> None:
    """The failure path an old app must take, exercised on a real file."""
    tampered = bytearray(bundle.blob)
    struct.pack_into("<H", tampered, 10, READER_VERSION + 1)   # min_reader_version
    try:
        Bundle(bytes(tampered))
    except Failed:
        pass
    else:
        raise Failed("a bundle demanding a newer reader was accepted")

    tampered = bytearray(bundle.blob)
    tampered[0:8] = b"NOTORCA\x00"
    try:
        Bundle(bytes(tampered))
    except Failed:
        pass
    else:
        raise Failed("a file with the wrong magic was accepted")

    try:
        Bundle(bundle.blob[:-8])
    except Failed:
        pass
    else:
        raise Failed("a truncated bundle was accepted")

    tampered = bytearray(bundle.blob)
    struct.pack_into("<HH", tampered, 8, MIN_SUPPORTED_FORMAT - 1, 1)  # format, min_reader
    try:
        Bundle(bytes(tampered))
    except Failed:
        pass
    else:
        raise Failed("a bundle older than this reader understands was accepted; "
                     "it would have been read with the wrong record stride")

    ok("version handshake: wrong magic, truncation, a too-new bundle and a "
       "too-old bundle are all refused")


def check_meta(bundle: Bundle, meta: dict) -> None:
    check(meta["hour_count"] == bundle.n_hours,
          "metadata hour_count disagrees with the header")
    check(meta["h3_resolution"] == bundle.h3_resolution,
          "metadata h3_resolution disagrees with the header")
    check(meta["encoding"]["no_data"] == NO_DATA, "metadata no_data is not 255")
    check(meta["encoding"]["value_scale"] == VALUE_SCALE,
          "metadata value_scale is not 254")

    header_simulated = bool(bundle.flags & 0x01)
    check(meta["contains_simulated"] == header_simulated,
          "metadata and header disagree about simulated data")
    check(meta["simulated_excluded"] != header_simulated,
          "simulated_excluded contradicts contains_simulated")

    check(meta["boundaries_advisory_only"] is True,
          "boundaries_advisory_only must be true; these are open data, not "
          "Survey of India definitions")
    check("Survey of India" in meta["boundary_disclaimer"],
          "the boundary disclaimer no longer names Survey of India")
    check(meta["hazard"]["computed_on_device"] is False,
          "hazard must be marked as computed upstream, not on the device")

    start = datetime.fromisoformat(meta["forecast_start"])
    end = datetime.fromisoformat(meta["forecast_end"])
    step = timedelta(seconds=meta["hour_step_seconds"])
    check(start + step * (bundle.n_hours - 1) == end,
          "forecast_start + hour_count * step does not land on forecast_end; "
          "the app would address the wrong hour")

    for s in meta["sources"]:
        has_time = s.get("issued_at") or s.get("fetched_at")
        check(has_time, f"source {s['source_id']} carries no age at all")
        if s.get("issued_time_kind") == "fetch_proxy":
            check(s["age_is_lower_bound"] is True,
                  f"source {s['source_id']} uses a fetch proxy but does not say "
                  "its age is a lower bound")
        if s.get("is_snapshot"):
            check(s.get("age_basis") == "snapshot_date",
                  f"source {s['source_id']} is a snapshot but its age is not "
                  "based on the snapshot date")
    ok(f"metadata invariants hold, including {len(meta['sources'])} source ages")


def check_cells(conn, bundle: Bundle, region) -> list[str]:
    values = bundle.cells()
    check(len(values) == bundle.n_cells, "cell index length disagrees with the header")
    check(values == sorted(values), "cell index is not sorted ascending")
    check(len(set(values)) == len(values), "cell index contains duplicate cells")

    cells = [f"{v:015x}" for v in values]
    for c in cells:
        # H3 resolution lives in bits 52-55 of the index.
        res = (int(c, 16) >> 52) & 0x0F
        check(res == bundle.h3_resolution,
              f"cell {c} is resolution {res}, header says {bundle.h3_resolution}")

    expected = db.fetch_risk_field(conn, region.bbox).cells
    check(cells == expected,
          f"cell index does not match the database "
          f"({len(cells)} in bundle, {len(expected)} in database)")
    ok(f"cell index: {len(cells)} cells, sorted, unique, all resolution "
       f"{bundle.h3_resolution}, identical to the database")
    return cells


def check_values(conn, bundle: Bundle, cells: list[str], meta: dict) -> None:
    """Every hazard and uncertainty value, not a sample."""
    rf = db.fetch_risk_field(conn, regions.get(meta["region_id"]).bbox)
    hours = rf.hours
    check(len(hours) == bundle.n_hours, "hour count disagrees with the database")

    hazard = bundle.grid(3)
    uncertainty = bundle.grid(4)

    checked = 0
    worst_h = 0.0
    worst_u = 0.0
    nulls = 0
    for ci, cell in enumerate(cells):
        base = ci * bundle.n_hours
        for hi, hour in enumerate(hours):
            for grid, source, worst_name in (
                (hazard, rf.hazard, "hazard"),
                (uncertainty, rf.uncertainty, "uncertainty"),
            ):
                truth = source.get((cell, hour))
                got = decode(grid[base + hi])
                if truth is None:
                    check(got is None,
                          f"{worst_name} for {cell} at {hour} is NULL in the database "
                          f"but decodes to {got} -- NO DATA must never become a number")
                    nulls += 1
                    continue
                check(got is not None,
                      f"{worst_name} for {cell} at {hour} is {truth} in the database "
                      f"but decodes to NO DATA")
                err = abs(got - truth)
                check(err <= VALUE_TOLERANCE,
                      f"{worst_name} for {cell} at {hour}: database {truth}, "
                      f"bundle {got}, error {err} exceeds half a quantisation step "
                      f"{VALUE_TOLERANCE}")
                if worst_name == "hazard":
                    worst_h = max(worst_h, err)
                else:
                    worst_u = max(worst_u, err)
                checked += 1

    ok(f"values: {checked:,} compared against the database, {nulls} NULLs preserved "
       f"as NO DATA; worst hazard error {worst_h * 100:.4f} pp, worst uncertainty "
       f"error {worst_u * 100:.4f} pp (limit {VALUE_TOLERANCE * 100:.4f} pp)")


def check_no_data_rule() -> None:
    """The encoding's central safety property, tested as pure arithmetic.

    The database currently holds no NULL hazard, so this cannot be exercised
    from real rows. It is still the rule most worth protecting, so it is
    tested directly rather than left to chance.
    """
    check(decode(NO_DATA) is None, "255 must decode to no data")
    check(decode(0) == 0.0, "0 must decode to probability 0")
    check(decode(VALUE_SCALE) == 1.0, "254 must decode to probability 1")
    for b in range(0, VALUE_SCALE + 1):
        v = decode(b)
        check(v is not None and 0.0 <= v <= 1.0, f"byte {b} decodes outside [0,1]")
        # Re-encoding with the writer's documented formula must return the
        # same byte, so the mapping is a genuine bijection over 0..254.
        check(int(v * VALUE_SCALE + 0.5) == b, f"byte {b} does not round-trip")
    ok("encoding: 0..254 round-trips exactly, 255 decodes to NO DATA and never to zero")


def check_zones(conn, bundle: Bundle, region, meta: dict, strings: list[str]) -> None:
    stored = bundle.zones()
    tolerance = meta["boundary_simplify"]["tolerance_deg"]
    truth = db.fetch_zones(conn, region.bbox, tolerance)

    check(len(stored) == len(truth),
          f"bundle has {len(stored)} zones, database has {len(truth)}")

    id_to_type = {v: k for k, v in db.ZONE_TYPE_IDS.items()}
    worst = 0.0
    total_points = 0
    for s, t in zip(stored, truth):
        check(id_to_type[s["zone_type_id"]] == t.zone_type,
              f"zone {t.zone_id} type mismatch")
        check(s["authority"] == (1 if t.authority == "official" else 0),
              f"zone {t.zone_id} authority mismatch")
        check(strings[s["attribution_str"]] == t.attribution,
              f"zone {t.zone_id} attribution was altered in transit")
        check(s["attribution_str"] != 0,
              f"zone {t.zone_id} lost its attribution")
        check(strings[s["name_str"]] == (t.name or ""),
              f"zone {t.zone_id} name mismatch")
        check(len(s["parts"]) == len(t.parts),
              f"zone {t.zone_id} has {len(s['parts'])} parts, database has {len(t.parts)}")
        for sp, tp in zip(s["parts"], t.parts):
            check(len(sp) == len(tp),
                  f"zone {t.zone_id} part length {len(sp)} vs {len(tp)}")
            for (slon, slat), (tlon, tlat) in zip(sp, tp):
                d = max(abs(slon - tlon), abs(slat - tlat))
                check(d <= COORD_TOLERANCE_DEG,
                      f"zone {t.zone_id} vertex moved by {d} degrees, more than "
                      f"one coordinate step")
                worst = max(worst, d)
                total_points += 1

    ok(f"boundaries: {len(stored)} zones, {total_points:,} vertices, worst coordinate "
       f"error {worst * 1e7:.2f} units of 1e-7 degrees")
    check_simplify_claim(conn, region, stored, truth, meta)


def check_simplify_claim(conn, region, stored, truth, meta: dict) -> None:
    """Is the simplification tolerance in the metadata actually true?

    The app widens its safety margin by this number. If simplification moved a
    line further than claimed, the margin is too small and the app reports a
    boundary as further away than it is. So it is measured against the
    unsimplified geometry in the database rather than trusted.
    """
    tolerance_deg = meta["boundary_simplify"]["tolerance_deg"]
    claimed_m = meta["boundary_simplify"]["tolerance_m_approx"]

    worst_m = 0.0
    worst_zone = None
    with conn.cursor() as cur:
        for s, t in zip(stored, truth):
            points = [p for part in s["parts"] for p in part]
            if not points:
                continue
            lons = [p[0] for p in points]
            lats = [p[1] for p in points]
            cur.execute(
                """
                SELECT max(ST_Distance(
                           ST_SetSRID(ST_MakePoint(l.lon, l.lat), 4326)::geography,
                           z.edge_geom::geography))
                FROM hazard_zones z,
                     unnest(%s::float8[], %s::float8[]) AS l(lon, lat)
                WHERE z.zone_id = %s
                """,
                (lons, lats, t.zone_id),
            )
            d = cur.fetchone()[0]
            if d is not None and d > worst_m:
                worst_m, worst_zone = d, t.zone_id

    # Degrees of longitude shrink with latitude; near 10 N one degree is about
    # 110 km, so the tolerance is an upper bound in metres.
    limit_m = tolerance_deg * 111_320 * 1.02
    check(worst_m <= limit_m,
          f"simplification moved a vertex {worst_m:.1f} m from the true line on zone "
          f"{worst_zone}, beyond the {limit_m:.1f} m the tolerance permits")
    check(worst_m <= claimed_m * 1.5,
          f"metadata claims about {claimed_m} m of simplification error but the "
          f"measured worst case is {worst_m:.1f} m")
    ok(f"simplify claim holds: worst vertex sits {worst_m:.1f} m from the "
       f"unsimplified line (metadata claims about {claimed_m} m)")


def check_harbours(conn, bundle: Bundle, region, strings: list[str], meta: dict,
                   cellbuf: list[str]) -> None:
    stored = bundle.harbours()
    truth = db.fetch_harbours(conn, region.bbox)
    check(len(stored) == len(truth),
          f"bundle has {len(stored)} landing centres, database has {len(truth)}")

    n_sources = len(meta["sources"])
    n_cells = bundle.n_cells
    worst = 0.0
    worst_offset = 0
    resolved = cellmod.resolve_places(
        [(t.lat, t.lon) for t in truth], cellbuf, bundle.h3_resolution)
    for s, t, r in zip(stored, truth, resolved):
        check(s["cell_index"] == r.cell_index,
              f"landing centre {t.harbour_id} resolved to cell index "
              f"{s['cell_index']}, recomputing gives {r.cell_index}")
        if s["cell_index"] == cellmod.NO_CELL:
            check(s["offset_m"] == 0,
                  f"landing centre {t.harbour_id} has no cell but a non-zero offset")
        else:
            check(s["cell_index"] < n_cells,
                  f"landing centre {t.harbour_id} points at cell {s['cell_index']} "
                  f"but only {n_cells} cells exist")
            check(abs(s["offset_m"] - r.offset_m) <= 1,
                  f"landing centre {t.harbour_id} offset {s['offset_m']} m does not "
                  f"match the recomputed {r.offset_m} m")
            worst_offset = max(worst_offset, s["offset_m"])
        check(strings[s["district_str"]] == (t.district or ""),
              f"landing centre {t.harbour_id} district was altered in transit")
    for s, t in zip(stored, truth):
        check(strings[s["id_str"]] == t.harbour_id,
              f"landing centre id mismatch: {strings[s['id_str']]} vs {t.harbour_id}")
        check(strings[s["name_str"]] == t.name,
              f"landing centre {t.harbour_id} name was altered in transit")
        check(s["harbour_type_id"] == db.HARBOUR_TYPE_IDS.get(t.harbour_type, 0),
              f"landing centre {t.harbour_id} type mismatch")
        check(s["source_index"] < n_sources,
              f"landing centre {t.harbour_id} points at source index "
              f"{s['source_index']} but only {n_sources} sources exist; its age "
              "could not be shown")
        d = max(abs(s["lat"] - t.lat), abs(s["lon"] - t.lon))
        check(d <= COORD_TOLERANCE_DEG,
              f"landing centre {t.harbour_id} moved by {d} degrees")
        worst = max(worst, d)

    # Every landing centre must be able to answer "how old is this".
    for s in stored:
        src = meta["sources"][s["source_index"]]
        check(src.get("fetched_at") or src.get("issued_at"),
              f"source {src['source_id']} carries no date for its landing centres")
    unresolved = sum(1 for s in stored if s["cell_index"] == cellmod.NO_CELL)
    ok(f"landing centres: {len(stored)} records, worst position error "
       f"{worst * 1e7:.2f} units of 1e-7 degrees, every one resolves to a dated source")
    ok(f"place resolution: cell index and offset recomputed for all {len(stored)}, "
       f"worst forecast offset {worst_offset / 1000:.1f} km, {unresolved} correctly "
       f"left with no cell")


def check_centroids(bundle: Bundle, cells: list[str]) -> None:
    """Every centroid must be the one H3 gives for that cell.

    These exist so the app can measure distances without carrying a geometry
    library. If one is wrong, every distance measured from that cell is wrong
    in a way nothing else in the file would reveal.
    """
    stored = bundle.centroids()
    check(len(stored) == len(cells),
          f"{len(stored)} centroids for {len(cells)} cells")
    truth = cellmod.centroids(cells)
    worst = 0.0
    for (slon, slat), (tlon, tlat), c in zip(stored, truth, cells):
        d = max(abs(slon - tlon), abs(slat - tlat))
        check(d <= COORD_TOLERANCE_DEG,
              f"centroid for cell {c} is off by {d} degrees")
        worst = max(worst, d)
    ok(f"cell centroids: all {len(stored)} match H3, worst error "
       f"{worst * 1e7:.2f} units of 1e-7 degrees")


def check_rings(bundle: Bundle, cells: list[str]) -> None:
    """Every hexagon recomputed from H3 and compared vertex by vertex.

    These rings decide two things: what the map draws, and which cell a GPS fix
    falls in. A wrong vertex is a wrong verdict for anyone standing near it.
    """
    stored = bundle.rings()
    if stored is None:
        ok("hexagons: section absent (a version 2 bundle); the map is disabled")
        return

    check(len(stored) == len(cells), "hexagon count does not match the cell index")
    worst = 0.0
    for ring, cell in zip(stored, cells):
        truth = [(lon, lat) for lat, lon in cellmod.h3.cell_to_boundary(cell)]
        check(len(ring) == len(truth) == 6,
              f"cell {cell} has {len(ring)} stored and {len(truth)} true vertices")
        for (slon, slat), (tlon, tlat) in zip(ring, truth):
            d = max(abs(slon - tlon), abs(slat - tlat))
            check(d <= 1e-5,
                  f"cell {cell} vertex is off by {d} degrees, more than one "
                  f"storage step")
            worst = max(worst, d)

    # Winding must be consistent, or a canvas fill rule and a point-in-polygon
    # test can disagree about the inside of the same cell.
    def signed_area(ring):
        return sum((ring[i][0] * ring[(i + 1) % 6][1] - ring[(i + 1) % 6][0] * ring[i][1])
                   for i in range(6)) / 2.0
    signs = {1 if signed_area(r) > 0 else -1 for r in stored}
    check(len(signs) == 1, "hexagon winding is not consistent across cells")

    # The containment rule the app relies on: a cell's own centre is inside it.
    cent = bundle.centroids()
    for i, ring in enumerate(stored):
        check(point_in_ring(cent[i][0], cent[i][1], ring),
              f"cell {cells[i]} does not contain its own centre")

    ok(f"hexagons: all {len(stored)} match H3 within {worst * 1e5:.2f} storage "
       f"steps, winding consistent, every cell contains its own centre")


def point_in_ring(lon: float, lat: float, ring) -> bool:
    hit = False
    n = len(ring)
    for i in range(n):
        xi, yi = ring[i]
        xj, yj = ring[i - 1]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
            hit = not hit
    return hit


def check_coastline(bundle: Bundle, region, meta: dict) -> None:
    parts = bundle.coastline()
    if parts is None:
        ok("coastline: section absent; the map will draw no land")
        return

    lon_min, lat_min, lon_max, lat_max = region.bbox
    halo = 1.05  # the clip halo, plus a rounding allowance
    points = 0
    for part in parts:
        check(len(part) >= 2, "a coastline part has fewer than two points")
        for lon, lat in part:
            check(lon_min - halo <= lon <= lon_max + halo
                  and lat_min - halo <= lat <= lat_max + halo,
                  f"coastline vertex ({lon}, {lat}) is outside the clip box")
            points += 1

    claimed = meta.get("coastline")
    check(claimed is not None, "coastline is shipped but not described in metadata")
    if claimed is not None:
        check(claimed["parts"] == len(parts),
              f"metadata claims {claimed['parts']} parts, file has {len(parts)}")
        check(claimed["points"] == points,
              f"metadata claims {claimed['points']} points, file has {points}")
        check(bool(claimed.get("attribution")),
              "the coastline has no attribution")
    ok(f"coastline: {len(parts)} parts, {points:,} vertices, all inside the clip "
       f"box, attributed")


def check_dem(bundle: Bundle, meta: dict) -> None:
    check(8 in bundle.sections, "the DEM section is missing from the directory")
    offset, length, count = bundle.sections[8]
    check(length == 0 and count == 0,
          f"DEM section is not empty ({length} bytes, {count} items) but ORCA has "
          "no elevation data to fill it with")
    check(meta["dem"] is None, "metadata claims DEM data that the section does not hold")
    check(meta.get("dem_reason"), "the empty DEM section carries no explanation")
    ok("DEM: section present, empty and explained; coastal mode correctly unavailable")


def check_no_simulation(conn, cells: list[str], meta: dict, bundle: Bundle) -> None:
    """Re-run every simulation check against the database, independently.

    The builder already refuses to ship drill data. This asks the database the
    same questions again from the finished file's cell list, so a bundle can be
    handed to someone and shown to be clean without trusting the process that
    produced it.
    """
    found = db.check_no_simulation(conn, cells)
    header_flag = bool(bundle.flags & 0x01)

    check(found.clean or header_flag,
          f"the database holds simulation data but the bundle is not flagged:\n"
          f"{found.describe()}")
    check(meta["contains_simulated"] == header_flag,
          "metadata and header disagree about simulated data")

    claimed = meta.get("simulation_check")
    check(claimed is not None,
          "the bundle records no simulation check at all")
    if claimed is not None:
        check(claimed["active_scenarios"] == found.active_scenarios,
              f"bundle claims active scenarios {claimed['active_scenarios']}, "
              f"database says {found.active_scenarios}")
        for field in ("simulated_risk_rows", "simulated_observations",
                      "masked_observations"):
            check(claimed[field] == getattr(found, field),
                  f"bundle claims {field}={claimed[field]}, database says "
                  f"{getattr(found, field)}")

    # Every source that fed the hazard field must be listed, with a fetch time.
    with conn.cursor() as cur:
        cur.execute(
            "SELECT DISTINCT source_id FROM observations WHERE h3_cell = ANY(%s)",
            (cells,))
        contributing = {r[0] for r in cur.fetchall() if r[0]}
    listed = {s["source_id"] for s in meta["sources"]}
    missing = contributing - listed
    check(not missing,
          f"sources fed this bundle but are not listed in it: {sorted(missing)}")

    undated = [s["source_id"] for s in meta["sources"]
               if not s.get("fetched_at") and not s.get("issued_at")
               and not s.get("snapshot_date")]
    check(not undated, f"sources listed with no date at all: {undated}")

    sim_listed = sorted(listed & set(db.SIMULATION_SOURCE_IDS))
    check(not sim_listed or header_flag,
          f"a simulation source is in the bundle unflagged: {sim_listed}")

    ok(f"no simulation: {len(found.active_scenarios)} active scenarios, "
       f"{found.simulated_risk_rows} simulated risk rows, "
       f"{found.simulated_observations} simulated observations, "
       f"{found.masked_observations} masked rows; all "
       f"{len(contributing)} contributing sources listed and dated")


def ok(msg: str) -> None:
    print(f"  PASS  {msg}")


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    path = Path(sys.argv[1])
    if not path.exists():
        print(f"no such file: {path}", file=sys.stderr)
        return 2

    print(f"verifying {path} ({path.stat().st_size:,} bytes)\n")
    try:
        verify(path)
    except Failed as e:
        print(f"\n  FAIL  {e}\n", file=sys.stderr)
        return 1
    print(f"\nAll checks passed. {path.stat().st_size:,} bytes.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
