# Bundle builder

Reads the hazard field, maritime boundaries and landing centres that ORCA
already computes, and packs one file per coastal region for the offline app.

The format is specified in [`docs/BUNDLE_FORMAT.md`](../docs/BUNDLE_FORMAT.md).
That document is normative; if this code disagrees with it, this code is wrong.

## Run it

From the repo root:

```sh
python3 -m venv .venv
.venv/bin/pip install -r builder/requirements.txt

.venv/bin/python builder/build_bundle.py --region kerala-tn
.venv/bin/python builder/verify_bundle.py out/kerala-tn.orcabundle
```

The bundle is written to `out/<region>.orcabundle` relative to the repo,
whatever directory you run from.

ORCA's database must be reachable. With the local docker-compose stack running
(`timescale/timescaledb-ha:pg16`, container `orca-db`) the defaults work. For
anything else, set `DATABASE_URL`. Every query is a SELECT; the builder never
writes to ORCA.

Set `ORCA_ROOT` if the ORCA checkout is not at `~/SIH2026/orca`.

## Files

| File | What it does |
|---|---|
| `regions.py` | Region ids and bounding boxes. Adding a region is a change to this file alone. |
| `cells.py` | Cell centroids, and the rule that maps a shore-side landing centre to the sea cell whose forecast applies to it. |
| `db.py` | The read-only queries, and the halo rules for selecting cells, zones and landing centres. |
| `orca_source.py` | Lifts safety constants out of ORCA's own source with `ast`, so they cannot drift. |
| `writer.py` | Quantisation, the string table, section layout and file assembly. |
| `build_bundle.py` | Entry point. Prints the per-section byte report. |
| `verify_bundle.py` | Independent reader that checks the file against the database. |

## Why the verifier does not import the writer

`verify_bundle.py` parses the bundle with `struct` and re-derives every offset
from the spec. It never imports `writer.py`. A verifier built on the writer's
own helpers would inherit the writer's bugs and agree with them, so the two
only agree when the file on disk is what the spec describes.

It checks the header and both version fields, section alignment and bounds,
that a wrong magic, a truncated file and a too-new bundle are all refused,
that the cell index is sorted and identical to the database, **every** hazard
and uncertainty value against a fresh query, that the quantisation is a
bijection over 0..254 with 255 reserved, that no boundary lost its
attribution, that simplification really did stay inside the tolerance the
metadata advertises, and that every landing centre resolves to a source with a
date.

## Constants come from ORCA, not from here

The geofence error budget, the boundary disclaimer, the hazard thresholds and
the H3 resolution are all decided in ORCA. `orca_source.py` reads them out of
ORCA's source at build time using the standard library `ast` module, rather
than importing ORCA's package and dragging in its dependencies, and rather
than retyping them.

Retyped constants drift, and the copy in a fisherman's pocket is the one that
would be wrong. If ORCA is not present the builder falls back to embedded
copies and records `constants_provenance` in the bundle metadata saying so, so
a bundle never claims a provenance it does not have.

## Things the builder refuses to do

- **Ship simulated data as forecast.** ORCA's scenario runner rewrites
  `risk_cells` in place during a drill. If simulated rows are present the build
  fails with an explanation. `--allow-simulated` produces a bundle flagged as
  a drill in both the header and the metadata, and is never for production.
- **Turn a missing value into a safe one.** A NULL hazard is written as 255,
  never 0. This is the encoding's central property and it is tested directly.
- **Invent elevation.** ORCA has no elevation, bathymetry, terrain or surge
  data. The DEM section is defined and emitted empty. Nothing is interpolated
  from harbour depth or distance to shore.
- **Ship a boundary without its attribution.** ORCA makes the column NOT NULL
  so it cannot be lost in transit. A zone with no attribution fails the build.

## Dependencies

Two.

`psycopg[binary]`, the same driver ORCA uses. Clipping and simplification
happen in PostGIS and geometry returns as GeoJSON parsed by the standard
library, so `shapely` is not needed.

`h3`, pinned the way ORCA pins it, to give every cell a centroid and to
resolve each landing centre to the cell whose forecast applies to it. Doing
that here means the app ships no geometry library at all: `h3-js` is 92 KB
gzipped, most of a bundle download again, for arithmetic that does not need
to happen separately on every phone.
