"""Binary section writers for the ORCA Mobile bundle.

Normative spec: docs/BUNDLE_FORMAT.md. If this file and that document
disagree, the document wins and this file is the bug.

Everything is little-endian. Every section starts on an 8-byte boundary so
the app can lay a typed array over a section instead of reading field by
field.
"""

from __future__ import annotations

import json
import struct
from dataclasses import dataclass
from datetime import datetime
from typing import Any

MAGIC = b"ORCABND\x00"
HEADER_BYTES = 32
DIRECTORY_ENTRY_BYTES = 16

FORMAT_VERSION = 3
# The lowest reader that may safely open a version 3 bundle. Adding an
# optional section later bumps FORMAT_VERSION and leaves this at 1, so old
# apps keep working by skipping what they do not recognise. Changing the
# meaning of an existing field bumps both, and every old app then refuses the
# file instead of misreading it.
#
# Version 2 changed the landing centre record from 20 to 32 bytes, which is a
# change to an existing layout rather than an addition, so both numbers moved.
#
# Version 3 only ADDS sections 11 and 12, so this stays at 2. A version 2
# reader opens a version 3 bundle, skips the two sections it does not know, and
# shows the verdict screen without a map. That is the case the two-number
# handshake exists for, and it is worth having it actually happen.
MIN_READER_VERSION = 2

SECTION_META = 1
SECTION_CELLS = 2
SECTION_HAZARD = 3
SECTION_UNCERTAINTY = 4
SECTION_ZONES = 5
SECTION_HARBOURS = 6
SECTION_STRINGS = 7
SECTION_DEM = 8
SECTION_CELL_CENTROIDS = 10
SECTION_CELL_RINGS = 11
SECTION_COASTLINE = 12

SECTION_NAMES = {
    SECTION_META: "metadata",
    SECTION_CELLS: "cell index",
    SECTION_HAZARD: "hazard",
    SECTION_UNCERTAINTY: "uncertainty",
    SECTION_ZONES: "boundaries",
    SECTION_HARBOURS: "landing centres",
    SECTION_STRINGS: "string table",
    SECTION_DEM: "elevation (DEM)",
    SECTION_CELL_CENTROIDS: "cell centroids",
    SECTION_CELL_RINGS: "cell hexagons",
    SECTION_COASTLINE: "coastline",
}

FLAG_CONTAINS_SIMULATED = 0x01

# Quantisation. A byte holds 0..254 mapped linearly onto the probability
# range [0, 1]; 255 is reserved for "no data".
VALUE_SCALE = 254
NO_DATA = 255

COORD_SCALE = 10_000_000  # int32 units per degree, i.e. 1e-7 deg, about 1.1 cm

# Hexagon vertices are stored as int16 offsets from their own cell's centre at
# this scale, about 1.1 m. A resolution 5 hexagon reaches 0.091 degrees from
# its centre at most, against the 0.327 an int16 allows here, so there is room
# to spare and no risk of a vertex wrapping round to the far side of the cell.
RING_SCALE = 100_000  # 1e-5 degrees
RING_VERTICES = 6

ALIGN = 8


def align_up(n: int, a: int = ALIGN) -> int:
    return (n + a - 1) // a * a


# --------------------------------------------------------------------------
# quantisation
# --------------------------------------------------------------------------

def quantise(p: float | None) -> int:
    """Probability in [0,1] -> one byte. None -> the no-data sentinel.

    Rounding is written out as floor(x + 0.5) rather than left to round(),
    because Python's round() is banker's rounding and JavaScript's Math.round
    is half-up. Spelling it out is what makes the Python writer and the
    TypeScript reader agree on every byte.

    NULL becoming 255 rather than 0 is the whole point. ORCA permits a NULL
    hazard and states the rule in backend/app/core/risk.py: "no information
    about this cell" and "this cell is safe" are opposite claims. Collapsing
    the first into the second is the failure that gets someone killed, so it
    has to be impossible to express here.
    """
    if p is None:
        return NO_DATA
    if p < 0.0:
        p = 0.0
    elif p > 1.0:
        p = 1.0
    b = int(p * VALUE_SCALE + 0.5)
    # Defensive: floating point at the top of the range must not reach 255.
    return b if b < NO_DATA else VALUE_SCALE


def dequantise(b: int) -> float | None:
    """The exact inverse the app implements. Kept here so the round-trip
    test in verify_bundle.py can assert against the same formula."""
    return None if b == NO_DATA else b / VALUE_SCALE


def coord(deg: float) -> int:
    """Degrees -> int32 at 1e-7 degrees, half-up away from zero."""
    v = deg * COORD_SCALE
    i = int(v + 0.5) if v >= 0 else -int(-v + 0.5)
    if not (-2_147_483_648 <= i <= 2_147_483_647):
        raise ValueError(f"coordinate {deg} does not fit in int32 at 1e-7 degrees")
    return i


# --------------------------------------------------------------------------
# string table
# --------------------------------------------------------------------------

class StringTable:
    """Deduplicating UTF-8 string pool.

    Index 0 is always the empty string, so a reference of 0 means "absent"
    and the format needs no separate null sentinel.

    Deduplication matters more than it looks: every advisory zone carries the
    identical MarineRegions attribution string, which ORCA makes NOT NULL
    precisely so it cannot be dropped in transit. Interning keeps that
    guarantee cheap.
    """

    def __init__(self) -> None:
        self._index: dict[str, int] = {"": 0}
        self._items: list[bytes] = [b""]

    def intern(self, s: str | None) -> int:
        if not s:
            return 0
        i = self._index.get(s)
        if i is None:
            i = len(self._items)
            self._index[s] = i
            self._items.append(s.encode("utf-8"))
        return i

    def __len__(self) -> int:
        return len(self._items)

    def get(self, i: int) -> str:
        return self._items[i].decode("utf-8")

    def build(self) -> bytes:
        n = len(self._items)
        offsets: list[int] = []
        pos = 0
        for item in self._items:
            offsets.append(pos)
            pos += len(item)
        offsets.append(pos)

        head_len = 8 + (n + 1) * 4
        bytes_offset = align_up(head_len)

        out = bytearray()
        out += struct.pack("<II", n, bytes_offset)
        out += struct.pack(f"<{n + 1}I", *offsets)
        out += b"\x00" * (bytes_offset - head_len)
        for item in self._items:
            out += item
        return bytes(out)


# --------------------------------------------------------------------------
# sections
# --------------------------------------------------------------------------

def build_cells(cells: list[str]) -> bytes:
    """H3 indices as sorted uint64.

    ORCA stores h3_cell as a 15-character hex string; the app converts back
    with toString(16).padStart(15, "0"), which is the form h3-js wants. No
    cell coordinates are written: h3-js derives centroid and outline from the
    index, and a second copy of a computable truth is a second thing that can
    drift.
    """
    values = [int(c, 16) for c in cells]
    if values != sorted(values):
        raise ValueError("cell index must be sorted ascending by numeric H3 value")
    if len(set(values)) != len(values):
        raise ValueError("cell index contains duplicates")
    return struct.pack(f"<{len(values)}Q", *values)


def build_value_grid(
    cells: list[str],
    hours: list[datetime],
    values: dict[tuple[str, datetime], float | None],
) -> bytes:
    """One byte per cell per hour, cell-major.

    Cell-major, stride n_hours, so a cell's whole forecast profile is one
    contiguous run of bytes. The app's central question is "what happens where
    I am over the next three days", and this is the layout that answers it in
    a single read.

    A (cell, hour) pair absent from the database is written as no-data, not as
    zero.
    """
    out = bytearray(len(cells) * len(hours))
    i = 0
    for cell in cells:
        for hour in hours:
            out[i] = quantise(values.get((cell, hour)))
            i += 1
    return bytes(out)


@dataclass
class ZoneRecord:
    zone_type_id: int
    authority: int          # 0 open_data_advisory, 1 official
    geom_kind: int          # 0 open line, 1 closed ring
    name_str: int
    attribution_str: int
    source_url_str: int
    parts: list[list[tuple[float, float]]]


def build_zones(records: list[ZoneRecord]) -> bytes:
    n_zones = len(records)
    n_parts = sum(len(r.parts) for r in records)
    n_points = sum(len(p) for r in records for p in r.parts)

    head_len = 16 + n_zones * 24 + (n_parts + 1) * 4
    points_offset = align_up(head_len)

    zone_blob = bytearray()
    part_offsets: list[int] = []
    point_blob = bytearray()

    part_cursor = 0
    point_cursor = 0
    for r in records:
        zone_blob += struct.pack(
            "<HBBIIIII",
            r.zone_type_id, r.authority, r.geom_kind,
            r.name_str, r.attribution_str, r.source_url_str,
            part_cursor, len(r.parts),
        )
        for part in r.parts:
            part_offsets.append(point_cursor)
            for lon, lat in part:
                point_blob += struct.pack("<ii", coord(lon), coord(lat))
                point_cursor += 1
            part_cursor += 1
    part_offsets.append(point_cursor)

    assert part_cursor == n_parts
    assert point_cursor == n_points

    out = bytearray()
    out += struct.pack("<IIII", n_zones, n_parts, n_points, points_offset)
    out += zone_blob
    out += struct.pack(f"<{len(part_offsets)}I", *part_offsets)
    out += b"\x00" * (points_offset - head_len)
    out += point_blob
    return bytes(out)


@dataclass
class HarbourRecord:
    lat: float
    lon: float
    harbour_type_id: int
    source_index: int
    id_str: int
    name_str: int
    district_str: int
    cell_index: int          # index into the cell array, or NO_CELL
    offset_m: int            # metres from this place to that cell's centre


def build_harbours(records: list[HarbourRecord]) -> bytes:
    """32 bytes per record.

    `cell_index` is the hazard cell whose forecast applies to this place,
    resolved in the builder by cells.py. Shipping it means the app answers
    "what is the hazard here" by indexing an array, with no geometry library
    on the device at all.

    `offset_m` is how far that cell's centre is from the place itself. It is
    stored rather than derived so the screen can always say which water it is
    describing. A forecast for the sea 6 km off a village is a useful answer
    and an honest one; the same forecast presented as being for the village is
    neither.

    No date field. The snapshot date is not a property of an individual
    landing centre, it is a property of the layer it came from, so it lives
    once per source in the metadata and is reached through source_index. That
    is also the only place the app reads data age from, which keeps one
    answer to "how old is this" instead of two.
    """
    out = bytearray()
    for r in records:
        out += struct.pack(
            "<iiIIIIIBBH",
            coord(r.lat), coord(r.lon),
            r.cell_index, r.offset_m,
            r.id_str, r.name_str, r.district_str,
            r.harbour_type_id, r.source_index, 0,
        )
    return bytes(out)


def build_cell_centroids(points: list[tuple[float, float]]) -> bytes:
    """(lon, lat) per cell, in cell-index order.

    The app needs a position for a cell to measure anything from it. H3 can
    compute this from the index, but only by carrying 92 KB of gzipped
    JavaScript, which is most of the bundle download again for arithmetic the
    builder can do once for everyone.
    """
    out = bytearray()
    for lon, lat in points:
        out += struct.pack("<ii", coord(lon), coord(lat))
    return bytes(out)


def build_meta(meta: dict[str, Any]) -> bytes:
    # separators trims the whitespace; sort_keys keeps key order stable across
    # builds so a diff between two bundles shows what actually changed rather
    # than a reshuffled dict. (The files still differ: generated_at moves.)
    return json.dumps(meta, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False).encode("utf-8")


# --------------------------------------------------------------------------
# assembly
# --------------------------------------------------------------------------

@dataclass
class Section:
    type_id: int
    payload: bytes
    item_count: int


def assemble(
    sections: list[Section],
    n_cells: int,
    n_hours: int,
    h3_resolution: int,
    contains_simulated: bool,
) -> tuple[bytes, list[tuple[int, int, int, int]]]:
    """Lay out header, directory and payloads.

    Returns the file bytes and a per-section (type_id, offset, length,
    item_count) list for the size report.
    """
    sections = sorted(sections, key=lambda s: s.type_id)

    directory_bytes = len(sections) * DIRECTORY_ENTRY_BYTES
    cursor = align_up(HEADER_BYTES + directory_bytes)

    placed: list[tuple[int, int, int, int]] = []
    for s in sections:
        placed.append((s.type_id, cursor, len(s.payload), s.item_count))
        cursor = align_up(cursor + len(s.payload))

    file_bytes = cursor

    flags = FLAG_CONTAINS_SIMULATED if contains_simulated else 0
    out = bytearray(file_bytes)
    struct.pack_into(
        "<8sHHHHIIBBHI", out, 0,
        MAGIC, FORMAT_VERSION, MIN_READER_VERSION, HEADER_BYTES, len(sections),
        n_cells, n_hours, h3_resolution, flags, 0, file_bytes,
    )

    for i, (type_id, offset, length, item_count) in enumerate(placed):
        struct.pack_into(
            "<HHIII", out, HEADER_BYTES + i * DIRECTORY_ENTRY_BYTES,
            type_id, 0, offset, length, item_count,
        )

    for s, (_, offset, length, _) in zip(sections, placed):
        out[offset:offset + length] = s.payload

    return bytes(out), placed


def build_cell_rings(centroids: list[tuple[float, float]],
                     rings: list[list[tuple[float, float]]]) -> bytes:
    """Six vertices per cell, as int16 offsets from that cell's centre.

    This is what lets the map draw hexagons and lets GPS resolve a position to
    a cell by exact point-in-polygon, with no geometry library on the device.
    h3-js could do both, at 92 KB gzipped; this costs 24 bytes per cell.

    Storing offsets rather than absolute coordinates halves the size and loses
    nothing: an offset only has to span one hexagon, so 16 bits at 1e-5 degrees
    is ample where an absolute position would need 32.
    """
    out = bytearray()
    for i, ring in enumerate(rings):
        if len(ring) != RING_VERTICES:
            # H3 has twelve pentagons per resolution. None fall in this region,
            # but a future one could, and a pentagon silently written as a
            # hexagon would put a phantom edge through a cell. Fail instead.
            raise ValueError(
                f"cell {i} has {len(ring)} vertices, not {RING_VERTICES}. "
                "H3 pentagons are not representable in this section; the "
                "format needs a variable-length ring before this region can "
                "be built."
            )
        clon, clat = centroids[i]
        for lon, lat in ring:
            dlon = round((lon - clon) * RING_SCALE)
            dlat = round((lat - clat) * RING_SCALE)
            if not (-32768 <= dlon <= 32767 and -32768 <= dlat <= 32767):
                raise ValueError(
                    f"cell {i} vertex offset does not fit in int16: "
                    f"({dlon}, {dlat}). Is the H3 resolution coarser than 5?"
                )
            out += struct.pack("<hh", dlon, dlat)
    return bytes(out)


def build_coastline(parts: list[list[tuple[float, float]]],
                    attribution_str: int) -> bytes:
    """Coastline as a compressed-sparse polyline, same shape as the boundaries.

    Carries its own attribution index because it is the one layer in the bundle
    that does not come from ORCA. Natural Earth is public domain, and saying so
    on the map costs nothing.
    """
    n_parts = len(parts)
    n_points = sum(len(p) for p in parts)

    head_len = 16 + (n_parts + 1) * 4
    points_offset = align_up(head_len)

    offsets: list[int] = []
    blob = bytearray()
    cursor = 0
    for part in parts:
        offsets.append(cursor)
        for lon, lat in part:
            blob += struct.pack("<ii", coord(lon), coord(lat))
            cursor += 1
    offsets.append(cursor)

    out = bytearray()
    out += struct.pack("<IIII", n_parts, n_points, points_offset, attribution_str)
    out += struct.pack(f"<{len(offsets)}I", *offsets)
    out += b"\x00" * (points_offset - head_len)
    out += blob
    return bytes(out)
