#!/usr/bin/env python3
"""Build one ORCA Mobile bundle from the live ORCA database.

    python builder/build_bundle.py --region kerala-tn

Reads the hazard field, maritime boundaries and landing centres that ORCA
already computes, and packs them into a single file the app downloads once and
then uses with no network at all.

Nothing here invents a number. Every value is either read from ORCA or derived
from one by a formula written out in docs/BUNDLE_FORMAT.md.
"""

from __future__ import annotations

import argparse
import gzip
import json
import struct
import sys
from datetime import datetime, timezone
from pathlib import Path

import cells as cellmod
import db
import orca_source
import regions
import writer
from writer import Section, ZoneRecord, HarbourRecord

# Simplification tolerance for boundary geometry, in degrees. 0.0005 degrees
# is about 55 m, which is inside consumer GPS error and far inside ORCA's own
# 0.5 NM (926 m) data-uncertainty budget for a maritime boundary, so it does
# not widen the margin the app already has to apply. Measured at 10,192 points
# for this region against 23,535 unsimplified.
SIMPLIFY_TOLERANCE_DEG = 0.0005
SIMPLIFY_TOLERANCE_M_APPROX = 55

#: Vendored by builder/fetch_coastline.py. Absent is not fatal: the bundle is
#: still valid, the app simply draws no land. Failing the whole build because a
#: decorative layer is missing would be the wrong trade.
COASTLINE_DIR = Path(__file__).resolve().parent / "data"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--region", default="kerala-tn",
                    help="region id from builder/regions.py")
    ap.add_argument("--out", default=None,
                    help="output path (default public/bundles/latest.orcabundle)")
    ap.add_argument("--allow-simulated", action="store_true",
                    help="build even if the region contains simulated risk cells, "
                         "flagging the bundle as a drill (never for production)")
    args = ap.parse_args()

    region = regions.get(args.region)
    # Default output lands in the app's static assets, so every `npm run build`
    # ships the current bundle and the app can fetch it on open instead of
    # asking a user to find a file. Anchored to the repo rather than to the
    # shell's working directory, so the builder can be run from anywhere.
    #
    # Named after the region rather than "latest": the app picks which region
    # to download by finding the one whose box contains the user, so several
    # can sit here side by side.
    repo_root = Path(__file__).resolve().parent.parent
    bundle_dir = repo_root / "public" / "bundles"
    out_path = (Path(args.out) if args.out
                else bundle_dir / f"{region.region_id}.orcabundle")
    out_path.parent.mkdir(parents=True, exist_ok=True)

    constants, provenance = orca_source.load()
    print(f"ORCA constants: {provenance}")

    generated_at = datetime.now(timezone.utc)

    with db.connect() as conn:
        print(f"region {region.region_id}  bbox {region.bbox}")

        # ------------------------------------------------------------------
        # hazard field
        # ------------------------------------------------------------------
        rf = db.fetch_risk_field(conn, region.bbox)
        print(f"  cells {len(rf.cells)}  hours {len(rf.hours)}  "
              f"({rf.hours[0].isoformat()} .. {rf.hours[-1].isoformat()})")

        # Every way ORCA can be holding drill data, checked together. The
        # risk_cells flag alone misses a scenario that is mid-flight or was
        # left uncleared by a crash.
        sim = db.check_no_simulation(conn, rf.cells)
        if not sim.clean and not args.allow_simulated:
            return fail(
                "this region is carrying simulation data:\n"
                f"{sim.describe()}\n\n"
                "ORCA's scenario runner rewrites risk_cells in place, writes "
                "simulated rows into observations, and displaces the real ones "
                "into observations_masked. A bundle built now would ship "
                "exercise data with a forecast's authority.\n"
                "Clear the scenario in ORCA, or pass --allow-simulated to build a "
                "bundle explicitly flagged as a drill."
            )
        print("  simulation check: clean" if sim.clean
              else "  simulation check: DRILL DATA PRESENT (--allow-simulated)")

        # ------------------------------------------------------------------
        # boundaries and landing centres
        # ------------------------------------------------------------------
        zones = db.fetch_zones(conn, region.bbox, SIMPLIFY_TOLERANCE_DEG)
        n_points = sum(len(p) for z in zones for p in z.parts)
        by_type: dict[str, int] = {}
        for z in zones:
            by_type[z.zone_type] = by_type.get(z.zone_type, 0) + 1
        print(f"  zones {len(zones)} ({', '.join(f'{k} {v}' for k, v in sorted(by_type.items()))}), "
              f"{n_points} points after simplify")

        harbours = db.fetch_harbours(conn, region.bbox)
        print(f"  landing centres {len(harbours)}")

        sources = db.fetch_sources(
            conn,
            rf.cells,
            [h.source_id for h in harbours],
            [z.source_id for z in zones],
        )
        source_index = {s["source_id"]: s["index"] for s in sources}

    # ----------------------------------------------------------------------
    # encode
    # ----------------------------------------------------------------------
    strings = writer.StringTable()

    zone_records = []
    for z in zones:
        if z.zone_type not in db.ZONE_TYPE_IDS:
            return fail(f"zone {z.zone_id} has unmapped zone_type {z.zone_type!r}")
        if not z.attribution:
            # ORCA makes this column NOT NULL so attribution cannot be lost in
            # transit. Losing it here would defeat that on purpose.
            return fail(f"zone {z.zone_id} has no attribution; refusing to ship it")
        zone_records.append(ZoneRecord(
            zone_type_id=db.ZONE_TYPE_IDS[z.zone_type],
            authority=1 if z.authority == "official" else 0,
            geom_kind=1 if z.closed else 0,
            name_str=strings.intern(z.name),
            attribution_str=strings.intern(z.attribution),
            source_url_str=strings.intern(z.source_url),
            parts=z.parts,
        ))

    # Resolve every landing centre to the hazard cell covering the water it
    # fishes in. See cells.resolve_places for the rule and why it refuses
    # rather than reaching further.
    resolved = cellmod.resolve_places(
        [(h.lat, h.lon) for h in harbours],
        rf.cells,
        constants["h3_resolution"],
    )
    how = {"containing": 0, "neighbour": 0, "none": 0}
    for r in resolved:
        how[r.how] += 1
    offsets = [r.offset_m for r in resolved if r.cell_index != cellmod.NO_CELL]
    print(f"  cell resolution: {how['containing']} in their own cell, "
          f"{how['neighbour']} in a neighbour, {how['none']} with no cell within "
          f"one ring")
    if offsets:
        print(f"  forecast offset: mean {sum(offsets) / len(offsets) / 1000:.1f} km, "
              f"max {max(offsets) / 1000:.1f} km")

    harbour_records = []
    for h, r in zip(harbours, resolved):
        harbour_records.append(HarbourRecord(
            lat=h.lat, lon=h.lon,
            harbour_type_id=db.HARBOUR_TYPE_IDS.get(h.harbour_type, 0),
            source_index=source_index.get(h.source_id, 255),
            id_str=strings.intern(h.harbour_id),
            name_str=strings.intern(h.name),
            district_str=strings.intern(h.district),
            cell_index=r.cell_index,
            offset_m=r.offset_m,
        ))

    centroids = cellmod.centroids(rf.cells)

    coastline_parts, coastline_meta = load_coastline(region.region_id)
    coastline_attribution_str = strings.intern(
        coastline_meta.get("attribution", "")) if coastline_meta else 0
    if coastline_parts:
        print(f"  coastline {len(coastline_parts)} parts, "
              f"{sum(len(p) for p in coastline_parts)} points")
    else:
        print("  coastline: none vendored for this region; the map will draw "
              "no land. Run builder/fetch_coastline.py.")

    meta = build_meta_dict(
        region=region,
        rf=rf,
        generated_at=generated_at,
        constants=constants,
        provenance=provenance,
        sources=sources,
        contains_simulated=not sim.clean,
        simulation=sim,
        coastline=(
            {
                "parts": len(coastline_parts),
                "points": sum(len(p) for p in coastline_parts),
                "attribution": coastline_meta.get("attribution"),
                "source_url": coastline_meta.get("source_url"),
                "simplify_deg": coastline_meta.get("simplify_deg"),
                "note": "coastline only; no land or political borders",
            }
            if coastline_parts else None
        ),
    )

    zones_payload = writer.build_zones(zone_records)
    harbours_payload = writer.build_harbours(harbour_records)
    strings_payload = strings.build()

    sections = [
        Section(writer.SECTION_META, writer.build_meta(meta), 1),
        Section(writer.SECTION_CELLS, writer.build_cells(rf.cells), len(rf.cells)),
        Section(writer.SECTION_HAZARD,
                writer.build_value_grid(rf.cells, rf.hours, rf.hazard),
                len(rf.cells) * len(rf.hours)),
        Section(writer.SECTION_UNCERTAINTY,
                writer.build_value_grid(rf.cells, rf.hours, rf.uncertainty),
                len(rf.cells) * len(rf.hours)),
        Section(writer.SECTION_ZONES, zones_payload, len(zone_records)),
        Section(writer.SECTION_HARBOURS, harbours_payload, len(harbour_records)),
        Section(writer.SECTION_STRINGS, strings_payload, len(strings)),
        # Defined and empty. ORCA holds no elevation data of any kind, and
        # there is nothing honest to put here. See docs/BUNDLE_FORMAT.md #10.
        Section(writer.SECTION_DEM, b"", 0),
        Section(writer.SECTION_CELL_CENTROIDS,
                writer.build_cell_centroids(centroids),
                len(rf.cells)),
        Section(writer.SECTION_CELL_RINGS,
                writer.build_cell_rings(centroids, cellmod.rings(rf.cells)),
                len(rf.cells)),
    ]

    if coastline_parts:
        sections.append(Section(
            writer.SECTION_COASTLINE,
            writer.build_coastline(coastline_parts, coastline_attribution_str),
            len(coastline_parts),
        ))

    blob, placed = writer.assemble(
        sections,
        n_cells=len(rf.cells),
        n_hours=len(rf.hours),
        h3_resolution=constants["h3_resolution"],
        contains_simulated=not sim.clean,
    )

    out_path.write_bytes(blob)
    gz = len(gzip.compress(blob, 9))

    report(out_path, blob, placed, gz)

    if args.out is None:
        write_region_index(bundle_dir)
    return 0


def write_region_index(bundle_dir: Path) -> None:
    """Rewrite public/bundles/index.json from the bundles actually present.

    The app downloads this first, decides locally which region contains the
    user, and then downloads that one bundle. That indirection exists for a
    privacy reason as much as an extensibility one: the choice is made on the
    device, so no request the app ever sends carries a position. A server-side
    "which region am I in" endpoint would be smaller and would leak exactly the
    thing this app has no business transmitting.
    """
    entries = []
    for region in sorted(regions.REGIONS.values(), key=lambda r: r.region_id):
        path = bundle_dir / f"{region.region_id}.orcabundle"
        if not path.exists():
            continue
        blob = path.read_bytes()
        # Read generated_at back out of the file rather than passing it in, so
        # the index cannot claim a date the bundle does not carry.
        meta = read_meta(blob)
        entries.append({
            "region_id": region.region_id,
            "name": region.name,
            "bbox": list(region.bbox),
            "file": f"{region.region_id}.orcabundle",
            "bytes": len(blob),
            "generated_at": meta["generated_at"],
            "format_version": struct.unpack_from("<H", blob, 8)[0],
        })

    index = {
        "index_version": 1,
        "regions": entries,
        "note": ("Region selection happens on the device. No request from the "
                 "app carries a position."),
    }
    index_path = bundle_dir / "index.json"
    index_path.write_text(json.dumps(index, indent=2, sort_keys=True) + "\n")
    print(f"wrote {index_path}  ({len(entries)} region"
          f"{'' if len(entries) == 1 else 's'})")


def read_meta(blob: bytes) -> dict:
    """Pull the metadata section out of a finished bundle."""
    section_count = struct.unpack_from("<H", blob, 14)[0]
    for i in range(section_count):
        type_id, _flags, offset, length, _count = struct.unpack_from(
            "<HHIII", blob, 32 + i * 16)
        if type_id == writer.SECTION_META:
            return json.loads(blob[offset:offset + length].decode("utf-8"))
    raise SystemExit("bundle has no metadata section")


def load_coastline(region_id: str):
    """Read the vendored coastline for a region, if there is one."""
    path = COASTLINE_DIR / f"coastline-{region_id}.geojson"
    if not path.exists():
        return [], None
    raw = json.loads(path.read_text())
    parts = [[(float(x), float(y)) for x, y in part] for part in raw["coordinates"]]
    return parts, raw.get("properties", {})


def build_meta_dict(*, region, rf, generated_at, constants, provenance,
                    sources, contains_simulated, simulation, coastline) -> dict:
    return {
        "region_id": region.region_id,
        "region_name": region.name,
        "bbox": list(region.bbox),
        "generated_at": generated_at.isoformat(),
        "forecast_start": rf.hours[0].isoformat(),
        "forecast_end": rf.hours[-1].isoformat(),
        "hour_count": len(rf.hours),
        "hour_step_seconds": rf.step_seconds,
        "h3_resolution": constants["h3_resolution"],

        "encoding": {
            "value_scale": writer.VALUE_SCALE,
            "no_data": writer.NO_DATA,
            "coord_scale": 1.0 / writer.COORD_SCALE,
            "decode": "p = b / 254 for b <= 254; b == 255 means NO DATA",
            "note": ("hazard and uncertainty are probabilities in [0,1], not scores. "
                     "NO DATA is not zero and must never render as SAFE."),
        },

        "hazard": {
            "definition": ("exceedance probability: P(a hazard variable crosses a "
                           "small-craft danger threshold), computed upstream by ORCA"),
            "thresholds": constants["hazard_thresholds"],
            "computed_on_device": False,
            "note": ("The device does not forecast weather. Forecasts are computed "
                     "upstream and cached here; the device computes the decision."),
        },
        "uncertainty": {
            "definition": ("additive heuristic in [0,1] covering forecast lead time, "
                           "missing variables, neighbour fill, fetch-proxy age and "
                           "staleness"),
            "calibrated": False,
            "note": "confidence in the hazard number, not a second hazard",
        },

        "boundary_simplify": {
            "tolerance_deg": SIMPLIFY_TOLERANCE_DEG,
            "tolerance_m_approx": SIMPLIFY_TOLERANCE_M_APPROX,
            "method": "ST_SimplifyPreserveTopology",
            "note": ("vertices may have moved by up to this much; widen any margin "
                     "accordingly"),
        },

        "geofence_budget_nm": {
            "data_uncertainty": constants["data_uncertainty_nm"],
            "default_data_uncertainty": constants["default_data_uncertainty_nm"],
            "position_uncertainty": constants["position_uncertainty_nm"],
            "default_buffer": constants["default_buffer_nm"],
            "rule": ("effective_distance_nm = max(0, distance_nm - (data_uncertainty"
                     " + position_uncertainty)); the margin may only turn CLEAR into "
                     "ALERT, never the reverse"),
        },

        "simulated_excluded": not contains_simulated,
        "contains_simulated": contains_simulated,
        "simulation_check": {
            "active_scenarios": simulation.active_scenarios,
            "simulated_risk_rows": simulation.simulated_risk_rows,
            "simulated_observations": simulation.simulated_observations,
            "masked_observations": simulation.masked_observations,
            "checked": ["scenario_runs.cleared_at", "risk_cells.simulated",
                        "observations.source_id", "observations_masked"],
        },
        "advisory_only": True,
        "boundaries_advisory_only": True,
        "boundary_disclaimer": constants["boundary_disclaimer"],
        "constants_provenance": provenance,

        "zone_types": {str(v): k for k, v in db.ZONE_TYPE_IDS.items()},
        "harbour_types": {"0": "unknown", "1": "landing_centre", "2": "fishing",
                          "3": "marina", "4": "port", "5": "shipyard"},

        "sources": sources,

        "place_resolution": {
            "rule": ("containing cell if bundled, else nearest bundled cell in the "
                     "immediate H3 neighbour ring, else none"),
            "no_cell": 0xFFFFFFFF,
            "note": ("offset_m is how far the forecast cell's centre is from the "
                     "place itself; always state it. A place with no cell reads "
                     "'no data for this area', never SAFE."),
        },

        "coastline": coastline,

        "dem": None,
        "dem_reason": ("ORCA holds no elevation, bathymetry, terrain or storm-surge "
                       "data. Section 8 is defined and empty. Coastal evacuation mode "
                       "is unavailable until a real elevation source exists."),
    }


def report(path: Path, blob: bytes, placed, gz: int) -> None:
    print()
    print(f"wrote {path}")
    print()
    print(f"{'section':<20}{'offset':>10}{'bytes':>12}{'items':>10}{'share':>8}")
    print("-" * 60)
    total = len(blob)
    for type_id, offset, length, item_count in placed:
        name = writer.SECTION_NAMES.get(type_id, f"type {type_id}")
        share = f"{100 * length / total:.1f}%" if total else "-"
        print(f"{name:<20}{offset:>10}{length:>12,}{item_count:>10,}{share:>8}")
    print("-" * 60)
    overhead = total - sum(p[2] for p in placed)
    print(f"{'header + padding':<20}{'':>10}{overhead:>12,}")
    print(f"{'TOTAL':<20}{'':>10}{total:>12,}")
    print()
    print(f"  on disk   {total:,} bytes  ({total / 1024:.1f} KiB)")
    print(f"  gzip -9   {gz:,} bytes  ({gz / 1024:.1f} KiB)")


def fail(msg: str) -> int:
    print(f"\nERROR: {msg}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
