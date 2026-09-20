# ORCA Mobile bundle format

Version 3. Normative. If the builder and this document disagree, this
document is wrong and must be corrected.

A bundle is one file per coastal region. The server publishes it to static
storage. The app downloads it, stores it in IndexedDB, and computes every
decision from it with no further network access. There is no API.

The file is designed to be read in TypeScript with `DataView`, `TextDecoder`
and `JSON.parse` alone. No parsing library, no code generation, no schema
runtime.

---

## 1. Conventions

- All integers are **little-endian**. The app must pass `true` as the
  `littleEndian` argument to every `DataView` getter.
- All offsets are absolute byte positions from the start of the file, unless
  a field explicitly says it is relative to its section.
- Every section begins on an **8-byte boundary**. The builder inserts zero
  padding between sections to guarantee this, so a reader may construct a
  `BigUint64Array` or `Int32Array` view directly onto a section instead of
  reading field by field.
- Coordinates are `int32` in units of 1e-7 degrees. Divide by 1e7 to get
  degrees. Resolution is about 1.1 cm, and the largest possible value,
  180 degrees, is 1.8e9, comfortably inside the int32 range of 2.147e9.
- Times in the metadata are ISO 8601 strings with an explicit UTC offset.
- The file extension is `.orcabundle`. The media type is
  `application/octet-stream`. Serve it gzipped; do not gzip inside the file.

---

## 2. Header

32 bytes at offset 0.

| Offset | Size | Type | Field |
|---|---|---|---|
| 0 | 8 | char[8] | `magic`, exactly `ORCABND\0` |
| 8 | 2 | uint16 | `format_version` |
| 10 | 2 | uint16 | `min_reader_version` |
| 12 | 2 | uint16 | `header_bytes`, 32 in version 1 |
| 14 | 2 | uint16 | `section_count` |
| 16 | 4 | uint32 | `n_cells` |
| 20 | 4 | uint32 | `n_hours` |
| 24 | 1 | uint8 | `h3_resolution` |
| 25 | 1 | uint8 | `flags` |
| 26 | 2 | uint16 | reserved, must be 0 |
| 28 | 4 | uint32 | `file_bytes`, total file length |

`flags` bit 0 set means the hazard field contains simulated data from a
drill or scenario run and **must not** be presented as a forecast. All other
bits are reserved and must be 0.

`n_hours` is authoritative. It is not always 72. ORCA computes from six hours
in the past to 72 hours ahead and the count varies with what the upstream
feeds actually returned. A reader that hardcodes 72 is broken.

### 2.1 Version handshake

The reader carries one constant, `READER_VERSION`, currently 1. It is the
highest `format_version` the reader fully understands.

The checks run in this order, and each failure is distinct and named:

1. File shorter than 32 bytes, or `magic` is not `ORCABND\0`.
   → **"This file is not an ORCA bundle."** Stop.
2. `file_bytes` does not equal the actual byte length.
   → **"This bundle is incomplete or corrupted."** Stop. A truncated download
   is the expected cause.
3. `min_reader_version > READER_VERSION`.
   → **"This bundle needs app version N or newer. This app reads version M."**
   Stop. Do not attempt a partial read.
4. `format_version < MIN_SUPPORTED_FORMAT`.
   → **"This bundle is an old format (version N). This app reads version M and
   newer."** Stop. This is the mirror of check 3 and the easy one to leave out.
   A version 1 file opened by a version 2 reader raises no error at all: the
   landing centre record went from 20 to 32 bytes, so the reader simply strides
   through it wrongly and produces positions that look entirely plausible. Too
   old must be refused as firmly as too new.
5. `format_version > READER_VERSION` but checks 3 and 4 passed.
   → Read normally. Skip unknown section types. Tell the user the bundle is
   newer than the app and some information may not be shown.
6. Otherwise read normally.

The two version numbers are what makes this work. `format_version` says what
the writer produced. `min_reader_version` says what a reader must be able to
do to read it **safely**. Adding a new optional section bumps
`format_version` only, and old apps keep working because they skip the
section they do not recognise. Changing the meaning of an existing field, or
the hazard encoding, bumps both, and every old app then refuses the file
instead of silently misreading it.

There is deliberately no fallback path in steps 3 or 4. A safety app that half-reads
an incompatible bundle is worse than one that refuses it.

---

## 3. Section directory

`section_count` entries of 16 bytes, starting at offset `header_bytes` (32).

| Offset | Size | Type | Field |
|---|---|---|---|
| 0 | 2 | uint16 | `type_id` |
| 2 | 2 | uint16 | `flags`, reserved, 0 |
| 4 | 4 | uint32 | `offset`, absolute, always a multiple of 8 |
| 8 | 4 | uint32 | `byte_length` |
| 12 | 4 | uint32 | `item_count`, meaning depends on the section |

Entries are sorted by ascending `type_id`. A reader must:

- ignore any `type_id` it does not know
- reject the bundle if `offset + byte_length > file_bytes`
- reject the bundle if a **required** section is missing, naming which one

| `type_id` | Section | Required |
|---|---|---|
| 1 | Metadata | yes |
| 2 | Cell index | yes |
| 3 | Hazard | yes |
| 4 | Uncertainty | yes |
| 5 | Boundaries | yes |
| 6 | Landing centres | yes |
| 7 | String table | yes |
| 8 | Elevation (DEM) | no, may be empty |
| 9 | Warnings | reserved, see 7.2 |
| 10 | Cell centroids | yes |
| 11 | Cell hexagons | no, map only |
| 12 | Coastline | no, map only |

In version 2 the directory holds nine entries and the payload begins at
offset 176. Type 9 is reserved and not emitted.

### 3.1 What changed in version 3

Sections 11 and 12 were added and nothing existing changed, so
`format_version` is 3 while `min_reader_version` stays at **2**. A version 2
reader opens a version 3 bundle, skips both sections and shows the verdict
screen without a map. A version 3 reader treats them as optional for the same
reason, disabling the map rather than rejecting an older bundle.

**Section 11, cell hexagons.** Six vertices per cell, as `int16` offsets from
that cell's own centroid at 1e-5 degrees, 24 bytes per cell.

```
per cell, six times:
  int16  dlon      add to cellLon[c], divide by 1e5
  int16  dlat      add to cellLat[c]
```

Offsets rather than absolute coordinates because an offset only has to span one
hexagon: at resolution 5 the largest reach from a centre is 0.091 degrees
against the 0.327 an int16 allows here. That halves the size and loses nothing.

Exactly six vertices, always. H3 has twelve pentagons per resolution; none fall
in this region, and the builder raises rather than writing a five-sided cell as
six. A phantom edge through a cell would put a boat on the wrong side of a
containment test.

This section is what keeps a geometry library off the device. It carries the
map's outlines and, more importantly, lets a GPS fix resolve to a cell by exact
point-in-polygon instead of a nearest-centroid guess. Nearest-centroid always
returns something, and "something" is exactly what must not be returned for a
position outside the covered water.

**Section 12, coastline.** Same compressed-sparse polyline shape as the
boundaries, plus its own attribution because it is the one layer that does not
come from ORCA.

```
0    uint32  n_parts
4    uint32  n_points
8    uint32  points_offset      relative to section start, multiple of 8
12   uint32  attribution_str    string table index, never 0
16   (n_parts + 1) x uint32     part offsets, then zero padding to 8
points_offset  n_points x (int32 lon_e7, int32 lat_e7)
```

Source is Natural Earth 1:10m physical coastline, public domain. **Coastline
only.** Natural Earth also publishes country and disputed-area boundaries;
those are deliberately not fetched and not shipped. This bundle already carries
maritime lines labelled advisory open data, and a second set of political lines
from a different source would blur a distinction the rest of the format is
careful about.

### 3.2 What changed in version 2

- The landing centre record grew from 20 to 32 bytes, gaining the forecast
  cell it resolves to, how far that cell's centre is, and its district. This
  is a change to an existing layout, not an addition, so `min_reader_version`
  moved to 2 as well and every version 1 reader refuses the file.
- Section 10, cell centroids, is new.

Both exist so the app can answer "what is the hazard here" and "how far is
that" with array indexing and arithmetic alone. The alternative was shipping
`h3-js` to the device, which is 92 KB gzipped, most of the bundle download
again, to recompute per phone what the builder can compute once.

---

## 4. Section 1 — Metadata

UTF-8 JSON, `item_count` = 1. Read with
`JSON.parse(new TextDecoder().decode(bytes))`.

Everything else in the file is bulk numeric data and stays binary. Only this
variable-length descriptive block is text, which is the same split glTF uses
for its binary container. It keeps attribution and provenance strings
extensible without a format change.

```jsonc
{
  "region_id": "kerala-tn",
  "region_name": "Kerala and Tamil Nadu coast",
  "bbox": [74.0, 7.0, 81.0, 13.6],          // lon_min, lat_min, lon_max, lat_max
  "generated_at": "2026-09-10T12:00:00+00:00",
  "forecast_start": "2026-09-10T00:00:00+00:00",
  "hour_count": 72,
  "hour_step_seconds": 3600,
  "h3_resolution": 5,

  "encoding": {
    "value_scale": 254,                      // byte b, 0..254, maps to b/254
    "no_data": 255,
    "coord_scale": 1e-7,
    "note": "hazard and uncertainty are probabilities in [0,1], not scores"
  },

  "boundary_simplify": {
    "tolerance_deg": 0.0005,
    "tolerance_m_approx": 55,
    "method": "ST_SimplifyPreserveTopology",
    "note": "vertices moved by up to this much; widen any margin accordingly"
  },

  "geofence_budget_nm": {                    // copied from ORCA core/geofence.py
    "data_uncertainty": {
      "imbl": 0.5, "eez": 0.5, "territorial_sea": 0.5,
      "contiguous_zone": 0.5, "baseline": 0.5, "mpa": 1.0
    },
    "default_data_uncertainty": 1.0,
    "position_uncertainty": 0.1,
    "default_buffer": 2.0,
    "rule": "effective_distance_nm = max(0, distance_nm - (data_uncertainty + position_uncertainty)); the margin may only turn CLEAR into ALERT, never the reverse"
  },

  "simulated_excluded": true,
  "advisory_only": true,
  "boundaries_advisory_only": true,
  "boundary_disclaimer": "…verbatim from ORCA…",

  "place_resolution": {
    "rule": "containing cell if bundled, else nearest bundled cell in the immediate H3 neighbour ring, else none",
    "no_cell": 4294967295,
    "note": "offset_m is how far the forecast cell's centre is from the place itself; always state it"
  },

  "zone_types": { "1": "imbl", "2": "eez", "3": "territorial_sea",
                  "4": "contiguous_zone", "5": "mpa", "6": "baseline" },
  "harbour_types": { "0": "unknown", "1": "landing_centre", "2": "fishing",
                     "3": "marina", "4": "port", "5": "shipyard" },

  "sources": [
    {
      "index": 0,
      "source_id": "open_meteo_marine",
      "name": "Open-Meteo Marine",
      "role": "hazard",
      "issued_at": "2026-09-10T05:16:49+00:00",
      "issued_time_kind": "fetch_proxy",
      "age_is_lower_bound": true,
      "reliability": 0.75
    },
    {
      "index": 2,
      "source_id": "incois_lc",
      "name": "INCOIS landing centres",
      "role": "landing_centre",
      "fetched_at": "2026-09-10T01:01:17+00:00",
      "snapshot_date": "2024-04-27",
      "is_snapshot": true,
      "age_is_lower_bound": false,
      "reliability": 0.95
    }
  ],

  "dem": null,
  "dem_reason": "ORCA holds no elevation, bathymetry, terrain or storm-surge data. Section 8 is defined and empty. Coastal evacuation mode is unavailable until a real elevation source exists."
}
```

### 4.1 Data age

`sources` is the only place the app reads data age from. Each entry carries
either `issued_at` (forecast sources) or `fetched_at` (static sources), and
some carry `snapshot_date`.

Two rules the app must honour:

- **`issued_time_kind` of `fetch_proxy` means the age is a lower bound.**
  ORCA records when it fetched, not when the model ran, because Open-Meteo
  publishes no run time. The real forecast is at least this old and may be
  older. The app says "at least N hours old", never "N hours old".
- **`snapshot_date` and `fetched_at` are different ages.** The INCOIS landing
  centres were fetched today from a layer frozen on 2024-04-27. Showing the
  fetch time alone would present positions that are years old as fresh. When
  `is_snapshot` is true, the age the user sees is derived from
  `snapshot_date`.

CLAUDE.md requires that data older than 12 hours is called out prominently.
That test runs against the hazard sources' `issued_at`.

---

## 5. Section 2 — Cell index

`item_count` = `n_cells`. `n_cells` × 8 bytes: H3 cell indices as uint64,
**sorted ascending**, no duplicates.

ORCA stores `h3_cell` as a 15-character hex string. The builder writes
`int(s, 16)`. The app reads with `getBigUint64` and converts back with
`v.toString(16).padStart(15, "0")`, which is the form `h3-js` expects.

Cell geometry is **not** stored. `h3-js` derives the centroid with
`cellToLatLng` and the outline with `cellToBoundary` from the index alone.
Shipping coordinates would put a second, divergeable copy of a computable
truth in the file.

Lookup is a binary search over this array, about ten comparisons for the
965 cells in the current region. The position found is the `cell_index` used
by sections 3 and 4.

All H3 indices in a bundle are at the resolution named in the header. ORCA
fixes this at 5, about 8.5 km edge and 252 km² per cell, matched to the
native grid of its upstream marine model. It is not tunable there, so it is
not tunable here.

---

## 6. Sections 3 and 4 — Hazard and uncertainty

Identical layout. `item_count` = `n_cells × n_hours`, one byte each.

**Cell-major.** The value for cell `c` at hour `h` is at byte

```
c * n_hours + h
```

so a cell's entire forecast profile is `n_hours` contiguous bytes. That is
the app's central question, "what happens where I am over the next three
days", so it is the access pattern the layout is built for. Hour `h` is
`forecast_start + h * hour_step_seconds`.

### 6.1 Encoding

```
encode:  b = 255                              if the value is NULL
         b = floor(clamp(p, 0, 1) * 254 + 0.5) otherwise

decode:  p = b / 254                          for b <= 254
         b == 255 means NO DATA
```

Rounding is half-up and explicit, not the language default, so Python and
TypeScript agree on every byte. Worst-case round-trip error is half a step,
1/508, which is 0.197 percentage points.

`hazard_prob` is a probability in [0, 1]. It is an exceedance probability,
P(a hazard variable crosses a small-craft danger threshold), computed
upstream by ORCA from significant wave height above 2.5 m and wind speed
above 12.5 m/s. It is not a score and must never be relabelled as one.

`uncertainty` is also in [0, 1] but is an additive heuristic, not a
calibrated probability. It grows with forecast lead time, missing variables,
neighbour-filled values, fetch-proxy ages and staleness. Present it as
confidence in the number, never as a second hazard.

### 6.2 The 255 rule

ORCA allows `hazard_prob` to be NULL and states the reason in
`backend/app/core/risk.py`: "we have no information about this cell" and
"this cell is safe" are opposite claims, and collapsing the first into the
second is how a recall system gets someone killed.

255 exists so that rule survives the trip into a byte array. **A reader must
never treat 255 as 0.** In the interface it renders as "no data for this
area", never as SAFE, and never as a grey shade that reads like calm.

---

## 7. Section 5 — Boundaries

`item_count` = number of zones.

Geometry is ORCA's `edge_geom`: the boundary line of a polygon zone, or the
line itself for a zone that is already a line. The IMBL and the straight
baseline are lines, not polygons. Distance-to-boundary measures against a
line, so shipping edges rather than fills is both smaller and directly
usable.

Geometry is clipped to the region bbox and simplified with
`ST_SimplifyPreserveTopology`. The tolerance is in the metadata.

Layout, all offsets relative to the section start:

```
0    uint32  n_zones
4    uint32  n_parts
8    uint32  n_points
12   uint32  points_offset      relative to section start, multiple of 8

16   n_zones × 24 bytes, the zone records
     +0   uint16  zone_type_id
     +2   uint8   authority          0 open_data_advisory, 1 official
     +3   uint8   geom_kind          0 open line, 1 closed ring
     +4   uint32  name_str           string table index, 0 = absent
     +8   uint32  attribution_str    string table index, never 0
     +12  uint32  source_url_str     string table index, 0 = absent
     +16  uint32  first_part         index into the part offset array
     +20  uint32  part_count

     then (n_parts + 1) × uint32, the part offset array
     then zero padding to the next 8-byte boundary

points_offset  n_points × 8 bytes
     +0   int32   lon_e7
     +4   int32   lat_e7
```

Zone `z` owns parts `first_part` through `first_part + part_count - 1`.
Part `p` spans points `part_offset[p]` up to but not including
`part_offset[p + 1]`. The final entry `part_offset[n_parts]` equals
`n_points`, so no special case is needed for the last part.

`geom_kind` of 1 means the first and last point of every part are identical
and the part is a closed ring. It is a rendering hint. Distance computation
does not care.

`points_offset` is stored rather than computed so the reader never has to
reproduce the padding arithmetic.

### 7.1 Using them honestly

Every zone carries an `attribution_str`, and it is never absent. ORCA makes
the column NOT NULL specifically so attribution cannot be dropped in transit.
The app must display it wherever a boundary is shown or a distance to one is
quoted.

`authority` is 0 for every zone in this section. The maritime boundaries come
from MarineRegions and OpenStreetMap. They are open data, they are **not**
Survey of India definitions, and they carry no legal authority. The verbatim
disclaimer is in the metadata.

`advisory_only` and `boundaries_advisory_only` are separate flags in the
metadata and must not be conflated. The second one governs whether a distance
may be presented as a legal line, and it does not change because some other
authoritative warning happens to be nearby.

### 7.2 Warnings are not boundaries, and section 9 is reserved for them

ORCA also stores `imd_warning` zones in the same table. They are **not** in
this section and must never be added to it.

An IMD warning is an authoritative, time-limited product with an onset and an
expiry. A maritime boundary is open data with no legal authority and no expiry.
ORCA keeps `advisory_only` and `boundaries_advisory_only` as separate flags
exactly so that an authoritative warning nearby cannot make an advisory
boundary look official, and calls conflating them misrepresentation. Putting a
warning in a section the app labels "advisory open data" would do precisely
that, in the direction that matters: it would also let an expired warning sit
in a section that has no concept of expiry.

Section type 9 is reserved for warnings when they are carried. It will hold a
validity window per record, `valid_from` and `valid_until`, and the reader
must compare both against the device clock and **drop an expired warning
rather than show it as current**. Because the device may be offline for days,
a warning whose window has passed is not merely stale, it is wrong, and there
is no newer bundle to correct it.

Adding section 9 bumps `format_version` and leaves `min_reader_version` at 1,
because an app that skips the section is still correct, just without warnings.

Not every zone in this section is offered as an answer to "how far to the
line I must not cross". The 12, 24 and 200 nautical mile zones arrive as
polygon outlines that include the coastal side, and the baseline is not a
limit at all. See `docs/KNOWN_LIMITATIONS.md` entry 1.

### 7.3 Distance

Distance must be reported through ORCA's budget, not raw:

```
margin_nm = data_uncertainty[zone_type] + position_uncertainty
effective_distance_nm = max(0, distance_nm - margin_nm)
```

The margin only ever shrinks the distance, so it can only ever turn a clear
verdict into an alert, never the reverse. ORCA's stated design target is zero
false negatives on the IMBL. Simplification error, up to the tolerance in the
metadata, is on top of that and the app should account for it too.

---

## 8. Section 6 — Landing centres

`item_count` = number of records, 32 bytes each.

```
+0   int32   lat_e7
+4   int32   lon_e7
+8   uint32  cell_index          into sections 2, 3, 4 and 10; 0xFFFFFFFF = none
+12  uint32  offset_m            metres from this place to that cell's centre
+16  uint32  id_str              string table index, ORCA's harbour_id
+20  uint32  name_str            string table index
+24  uint32  district_str        string table index, 0 when the source has none
+28  uint8   harbour_type_id
+29  uint8   source_index        index into metadata.sources
+30  uint16  flags               reserved, 0
```

### 8.1 cell_index and offset_m

A landing centre stands on the shore, and ORCA forecasts sea cells, so the H3
cell physically containing a place is very often absent from the bundle. The
forecast a fisherman there needs is the one for the water just off the beach.

The builder resolves it, in this order, and records which cell it chose:

1. the containing cell, if the bundle has it
2. otherwise the nearest bundled cell in the immediate H3 neighbour ring
3. otherwise `0xFFFFFFFF`, meaning none

Step 3 is the important one. Widening the search until something is always
found would mean answering a question about one stretch of water with the
forecast for another, and an answer that is always produced is the kind that
stops being checked. A reader must render `0xFFFFFFFF` as "no data for this
area" and never as SAFE. A `cell_index` at or beyond `n_cells` is corruption
and must be treated the same way, never as cell 0.

`offset_m` is how far that cell's centre lies from the place itself. It is
stored rather than derived because **the reader must say which water it is
describing**. In the kerala-tn region it averages 8.3 km and reaches 23.4 km,
which is what a resolution 5 cell allows for a point near a vertex. A forecast
for the sea 6 km off a village is a useful and honest answer; the same
forecast presented as being for the village is neither.

`offset_m` is 0 when `cell_index` is `0xFFFFFFFF`. It carries no meaning there.

### 8.2 Dates and depth

The snapshot date is not repeated on every record. It lives once per source
in the metadata and is reached through `source_index`, which is also where
the app reads that source's age and whether it is a frozen snapshot. Section
4.1 governs how that date is presented.

`harbour_type_id` distinguishes an INCOIS landing centre from an OSM marina,
port or shipyard. They are all in ORCA's `harbours` table together, and they
are not interchangeable as a place to bring a small boat.

Depth is deliberately absent. ORCA leaves `depth_m` NULL with
`depth_source = 'unknown'` for effectively every record and refuses to fill
it from GEBCO, on the grounds that seabed bathymetry on a 450 m grid cannot
see a dredged channel, and substituting one for the other manufactures a
safety claim out of data that does not contain one. The app must not imply
any under-keel clearance.

---

## 9. Section 7 — String table

`item_count` = number of strings.

```
0    uint32  n_strings
4    uint32  bytes_offset        relative to section start, multiple of 8
8    (n_strings + 1) × uint32    byte offsets into the blob, ascending
     then zero padding to the next 8-byte boundary
bytes_offset  the UTF-8 blob
```

String `i` is the blob bytes from `offset[i]` up to but not including
`offset[i + 1]`, decoded with `TextDecoder`. The final entry is the blob
length.

**Index 0 is always the empty string.** A string reference of 0 therefore
means "absent" and needs no separate sentinel.

Strings are deduplicated. The MarineRegions attribution is identical across
every advisory zone, so storing it once collapses several kilobytes to a few
hundred bytes.

---

## 10. Section 8 — Elevation (DEM)

**Defined, and empty in version 1.** `byte_length` = 0, `item_count` = 0.

ORCA computes and stores no elevation, DEM, SRTM, bathymetry, terrain,
storm-surge or inundation data of any kind. There is no upstream to pack.
The metadata says `"dem": null` and gives the reason.

The section exists in the directory rather than being omitted so that a
reader can tell the difference between "this bundle predates DEM support"
and "this bundle has DEM support and there is genuinely no data for this
region". Both currently produce an empty section, and both correctly disable
coastal evacuation mode.

**A reader must not synthesise elevation.** No interpolating from harbour
depth, no assuming a flat coastal plain, no deriving height from distance to
shore. Build order step 5, coastal evacuation mode, stays blocked until a
real elevation source exists.

When one does, the intended layout is a coarse regular raster covering the
coastal strip only:

```
0    uint32  n_cols
4    uint32  n_rows
8    int32   origin_lon_e7        west edge of the first column
12   int32   origin_lat_e7        north edge of the first row
16   int32   step_lon_e7          cell width, positive
20   int32   step_lat_e7          cell height, positive, rows run north to south
24   int16   elev_min_m
26   int16   elev_max_m
28   uint16  no_data              reserved value
30   uint16  reserved
32   n_rows × n_cols × uint16     quantised elevation, row-major
```

with the decode formula and vertical datum recorded in the metadata. Adding
it bumps `format_version` and leaves `min_reader_version` at 1, because an
app that skips the section is still correct, just without coastal mode.

---

## 11. Section 10 — Cell centroids

`item_count` = `n_cells`. `n_cells` pairs of int32, in the same order as the
cell index, so entry `i` is the centre of cell `i`.

```
+0   int32   lon_e7
+4   int32   lat_e7
```

Each is exactly what H3 gives for that index, computed by the builder with the
same library and resolution ORCA uses.

This is the section that keeps a geometry library off the device. Everything
the app measures offline starts from a position for a cell, and H3 can derive
one from the index, but only by carrying about 92 KB of gzipped JavaScript.
That is most of a whole bundle download again, on a connection where the
bundle itself is the expensive thing, to recompute on every phone what the
builder computes once for all of them.

Section 2 still carries the H3 indices. They are the provenance, and step 3
needs them to turn a GPS fix into a cell.

---

## 12. Reading it in TypeScript

The whole reader, in outline. This is the complete set of primitives the
format needs.

```ts
const READER_VERSION = 2;
const MIN_SUPPORTED_FORMAT = 2;   // refusing an OLD bundle matters as much
const MAGIC = "ORCABND\0";

const dv = new DataView(buf);
const td = new TextDecoder();

// magic, then the version handshake of section 2.1
const magic = td.decode(new Uint8Array(buf, 0, 8));
const formatVersion = dv.getUint16(8, true);
const minReader = dv.getUint16(10, true);
const sectionCount = dv.getUint16(14, true);
const nCells = dv.getUint32(16, true);
const nHours = dv.getUint32(20, true);

// directory
const sections = new Map<number, {off: number; len: number; count: number}>();
for (let i = 0; i < sectionCount; i++) {
  const p = 32 + i * 16;
  sections.set(dv.getUint16(p, true), {
    off: dv.getUint32(p + 4, true),
    len: dv.getUint32(p + 8, true),
    count: dv.getUint32(p + 12, true),
  });
}

// metadata
const m = sections.get(1)!;
const meta = JSON.parse(td.decode(new Uint8Array(buf, m.off, m.len)));

// cell index, aligned so a typed-array view is legal
const c = sections.get(2)!;
const cells = new BigUint64Array(buf, c.off, c.count);

// binary search, then the 72-byte profile for that cell
function findCell(h3: bigint): number {
  let lo = 0, hi = cells.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cells[mid] === h3) return mid;
    if (cells[mid] < h3) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
}

const hz = sections.get(3)!;
const hazard = new Uint8Array(buf, hz.off, hz.count);

function hazardAt(cellIndex: number, hour: number): number | null {
  const b = hazard[cellIndex * nHours + hour];
  return b === 255 ? null : b / 254;      // null is NOT zero
}
```

`hazardAt` returning `null` is the whole point of the 255 sentinel. The call
site must branch on it and render "no data for this area". A `?? 0` anywhere
near this function is a defect.

---

## 13. What this format refuses to carry

Stated so it does not get quietly added later.

- **No weather model.** The device does not forecast anything. Forecasts are
  computed upstream by ORCA and cached here. The device computes the
  decision. Describing this as offline prediction is false.
- **No elevation, until there is real elevation.** Section 10 of this document.
- **No interpolation to a finer grid.** ORCA computes at H3 resolution 5. A
  finer bundle grid would be invented numbers wearing a precision they do not
  have.
- **No under-keel or depth claim.** Section 8.2.
- **No boundary presented as legal.** Section 7.1.
- **No LLM-generated text.** Nothing in a bundle is phrased by a model. Every
  number comes from a formula, and every disclaimer is copied verbatim from
  ORCA.
