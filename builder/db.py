"""Read-only queries against the ORCA Postgres.

Every statement here is a SELECT. The builder never writes to ORCA.

Connection follows ORCA's own convention: a DATABASE_URL environment
variable, defaulting to the local docker-compose credentials in
~/SIH2026/orca/docker-compose.yml.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Iterable

import psycopg

DEFAULT_DSN = "postgresql://orca:orca@localhost:5432/orca"

# Zone types carried in a bundle. All six of ORCA's boundary types, matching
# BOUNDARY_ZONE_TYPES in ORCA's core/geofence.py.
#
# 'imd_warning' is deliberately NOT here, and it is not an oversight. It is a
# time-limited official IMD warning, not a boundary. ORCA keeps advisory_only
# and boundaries_advisory_only as separate flags precisely so an authoritative
# warning nearby cannot make an open-data boundary look official, and folding
# a warning into this section would blur exactly that distinction.
#
# When warnings are carried they get their own section with a validity window,
# reserved as section type 9 in docs/BUNDLE_FORMAT.md, and an expired warning
# must never be shown as current.
BUNDLE_ZONE_TYPES = ("imbl", "eez", "territorial_sea", "contiguous_zone", "mpa",
                     "baseline")

# Numeric ids written into the bundle. Stable: changing one is a format break.
ZONE_TYPE_IDS = {
    "imbl": 1,
    "eez": 2,
    "territorial_sea": 3,
    "contiguous_zone": 4,
    "mpa": 5,
    "baseline": 6,
}

HARBOUR_TYPE_IDS = {
    None: 0,
    "unknown": 0,
    "landing_centre": 1,
    "fishing": 2,
    "marina": 3,
    "port": 4,
    "shipyard": 5,
}

# A cell is selected if its observed sample location falls inside the region
# box grown by this much. H3 resolution 5 has an edge of roughly 8.5 km, about
# 0.077 degrees, and observations.geom is the raw sample point rather than the
# cell centroid, so a cell that genuinely overlaps the region can report a
# point just outside it. Dropping those would punch holes in the hazard field
# exactly at the region edge, which is where a boat is most likely to be
# looking for the next region's data and not have it.
CELL_HALO_DEG = 0.1

# Boundaries are clipped to the region box grown by this much. Distance to a
# clipped line is wrong near the clip edge, so the halo has to exceed the
# distance a user might reasonably be told about. One degree is about 111 km,
# far beyond the 2 NM default alert buffer, and it costs about 1.8 KB here.
ZONE_HALO_DEG = 1.0

# Landing centres are selected with a halo for the same reason. The nearest
# safe place to land for a boat at the edge of a region may sit just inside
# the next one, and a refuge blind spot along a region seam is exactly the
# failure a fisherman would meet at the worst moment. Costs nothing today --
# the only harbours this admits or excludes here are in the Maldives, 120 km
# west of the region and correctly left out either way.
HARBOUR_HALO_DEG = 0.5


def connect() -> psycopg.Connection:
    dsn = os.environ.get("DATABASE_URL", DEFAULT_DSN)
    # autocommit because nothing here writes; it just avoids leaving an idle
    # transaction open against ORCA's database while we read for a while.
    return psycopg.connect(dsn, autocommit=True)


#: Sources that produce drill data rather than observations. ORCA seeds
#: 'scenario_sim' in its sources table for exactly this.
SIMULATION_SOURCE_IDS = ("scenario_sim",)


@dataclass
class SimulationFindings:
    """Every way ORCA can be holding exercise data, checked at once.

    The risk_cells.simulated flag alone is not enough. A scenario run rewrites
    risk cells in place, writes simulated rows into observations under
    'scenario_sim', and moves the real observations it displaced into
    observations_masked. A build that starts midway through one, or just after
    a crash left one uncleared, can find the flag clean and the data not.
    """

    active_scenarios: list[str]
    simulated_risk_rows: int
    simulated_observations: int
    masked_observations: int

    @property
    def clean(self) -> bool:
        return (not self.active_scenarios
                and self.simulated_risk_rows == 0
                and self.simulated_observations == 0
                and self.masked_observations == 0)

    def describe(self) -> str:
        lines = []
        if self.active_scenarios:
            lines.append(f"  scenario runs still active: "
                         f"{', '.join(self.active_scenarios)}")
        if self.simulated_risk_rows:
            lines.append(f"  risk_cells rows flagged simulated: "
                         f"{self.simulated_risk_rows}")
        if self.simulated_observations:
            lines.append(f"  observations from a simulation source: "
                         f"{self.simulated_observations}")
        if self.masked_observations:
            lines.append(f"  real observations displaced into "
                         f"observations_masked: {self.masked_observations}")
        return "\n".join(lines)


def check_no_simulation(conn: psycopg.Connection,
                        cells: Iterable[str]) -> SimulationFindings:
    """Look for drill data in every place ORCA can put it."""
    cell_list = list(cells)
    with conn.cursor() as cur:
        cur.execute(
            "SELECT scenario_id FROM scenario_runs WHERE cleared_at IS NULL "
            "ORDER BY activated_at")
        active = [r[0] for r in cur.fetchall()]

        cur.execute(
            "SELECT count(*) FROM risk_cells WHERE simulated AND h3_cell = ANY(%s)",
            (cell_list,))
        simulated_risk = cur.fetchone()[0]

        cur.execute(
            "SELECT count(*) FROM observations "
            "WHERE source_id = ANY(%s) AND h3_cell = ANY(%s)",
            (list(SIMULATION_SOURCE_IDS), cell_list))
        simulated_obs = cur.fetchone()[0]

        cur.execute("SELECT count(*) FROM observations_masked")
        masked = cur.fetchone()[0]

    return SimulationFindings(
        active_scenarios=active,
        simulated_risk_rows=simulated_risk,
        simulated_observations=simulated_obs,
        masked_observations=masked,
    )


# --------------------------------------------------------------------------
# hazard field
# --------------------------------------------------------------------------

@dataclass
class RiskField:
    cells: list[str]                      # 15-char hex, sorted by numeric value
    hours: list[datetime]                 # ascending, hourly
    hazard: dict[tuple[str, datetime], float | None]
    uncertainty: dict[tuple[str, datetime], float | None]
    simulated_rows: int                   # simulated rows seen in the region
    step_seconds: int


def fetch_risk_field(conn: psycopg.Connection, bbox: tuple[float, float, float, float]) -> RiskField:
    """Read the hazard field for one region.

    Simulated rows are excluded. ORCA's scenario runner rewrites risk_cells in
    place during a drill, so a bundle built mid-scenario would otherwise ship
    exercise data with a forecast's authority.
    """
    lon_min, lat_min, lon_max, lat_max = bbox
    h = CELL_HALO_DEG

    with conn.cursor() as cur:
        # Cell selection. risk_cells has no geometry of its own -- it is keyed
        # by H3 string -- and there is no h3 extension in this database, so the
        # cell is placed by the observations that produced it.
        cur.execute(
            """
            WITH placed AS (
                SELECT h3_cell, ST_Centroid(ST_Collect(geom)) AS g
                FROM observations
                WHERE geom IS NOT NULL
                GROUP BY h3_cell
            )
            SELECT DISTINCT r.h3_cell
            FROM risk_cells r
            JOIN placed p USING (h3_cell)
            WHERE NOT r.simulated
              AND ST_Intersects(p.g, ST_MakeEnvelope(%s, %s, %s, %s, 4326))
            """,
            (lon_min - h, lat_min - h, lon_max + h, lat_max + h),
        )
        cells = [r[0] for r in cur.fetchall()]
        # Sort by the numeric H3 value, which is what the bundle stores and
        # what the app binary searches. For equal-length lowercase hex this
        # happens to match string order, but relying on that is a trap the
        # first time a resolution changes the string length.
        cells.sort(key=lambda s: int(s, 16))

        if not cells:
            raise SystemExit("no risk cells found in this region; nothing to build")

        cur.execute(
            """
            SELECT valid_time, h3_cell, hazard_prob, uncertainty
            FROM risk_cells
            WHERE NOT simulated AND h3_cell = ANY(%s)
            """,
            (cells,),
        )
        hazard: dict[tuple[str, datetime], float | None] = {}
        uncertainty: dict[tuple[str, datetime], float | None] = {}
        hours_seen: set[datetime] = set()
        for valid_time, cell, hp, unc in cur:
            hours_seen.add(valid_time)
            hazard[(cell, valid_time)] = hp
            uncertainty[(cell, valid_time)] = unc

        cur.execute(
            "SELECT count(*) FROM risk_cells WHERE simulated AND h3_cell = ANY(%s)",
            (cells,),
        )
        simulated_rows = cur.fetchone()[0]

    hours = sorted(hours_seen)
    step = _hour_step(hours)
    return RiskField(
        cells=cells,
        hours=hours,
        hazard=hazard,
        uncertainty=uncertainty,
        simulated_rows=simulated_rows,
        step_seconds=step,
    )


def _hour_step(hours: list[datetime]) -> int:
    """The forecast step, in seconds, verified to be uniform.

    The bundle addresses hour h as forecast_start + h * step. That arithmetic
    is only valid if the steps really are even, so an irregular series is an
    error rather than something to paper over -- an off-by-one here shifts a
    danger time by an hour.
    """
    if len(hours) < 2:
        return 3600
    steps = {
        int((b - a).total_seconds())
        for a, b in zip(hours, hours[1:])
    }
    if len(steps) != 1:
        raise SystemExit(
            f"forecast hours are not evenly spaced (found steps: {sorted(steps)}); "
            "the bundle format addresses hours by index and cannot represent this"
        )
    return steps.pop()


# --------------------------------------------------------------------------
# boundaries
# --------------------------------------------------------------------------

@dataclass
class Zone:
    zone_id: str
    zone_type: str
    name: str | None
    authority: str
    attribution: str
    license: str | None
    source_url: str | None
    source_id: str | None
    parts: list[list[tuple[float, float]]] = field(default_factory=list)  # (lon, lat)
    closed: bool = False


def fetch_zones(
    conn: psycopg.Connection,
    bbox: tuple[float, float, float, float],
    tolerance_deg: float,
) -> list[Zone]:
    """Read boundary geometry, clipped to the region and simplified.

    Geometry is edge_geom, not geom. ORCA generates edge_geom as ST_Boundary
    for polygon zones and the line itself for line zones, which is exactly
    what a distance-to-boundary measurement needs: the IMBL and the baseline
    are lines, and for the EEZ or territorial sea it is the edge that matters,
    not the fill.
    """
    lon_min, lat_min, lon_max, lat_max = bbox
    h = ZONE_HALO_DEG
    env = (lon_min - h, lat_min - h, lon_max + h, lat_max + h)

    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT zone_id, zone_type, name, authority, attribution, license,
                   source_url, source_id,
                   ST_AsGeoJSON(
                       ST_SimplifyPreserveTopology(
                           ST_Intersection(edge_geom, ST_MakeEnvelope(%s,%s,%s,%s,4326)),
                           %s
                       )
                   ) AS gj
            FROM hazard_zones
            WHERE zone_type = ANY(%s)
              AND (valid_until IS NULL OR valid_until > now())
              AND ST_Intersects(edge_geom, ST_MakeEnvelope(%s,%s,%s,%s,4326))
            ORDER BY zone_type, zone_id
            """,
            (*env, tolerance_deg, list(BUNDLE_ZONE_TYPES), *env),
        )
        rows = cur.fetchall()

    zones: list[Zone] = []
    for (zone_id, zone_type, name, authority, attribution, lic,
         source_url, source_id, gj) in rows:
        parts = _geojson_to_parts(json.loads(gj)) if gj else []
        if not parts:
            # Clipping can leave a zone with nothing but a touching point.
            # A zone with no measurable geometry is not a zone to ship.
            continue
        closed = all(p[0] == p[-1] and len(p) > 3 for p in parts)
        zones.append(Zone(
            zone_id=zone_id, zone_type=zone_type, name=name,
            authority=authority, attribution=attribution, license=lic,
            source_url=source_url, source_id=source_id,
            parts=parts, closed=closed,
        ))
    return zones


def _geojson_to_parts(g: dict[str, Any]) -> list[list[tuple[float, float]]]:
    """Flatten clipped geometry to a list of coordinate runs.

    ST_Intersection of a line with a box can return a LineString, a
    MultiLineString, a bare Point where the line only grazes a corner, or a
    GeometryCollection mixing them. Points carry no length and no bearing, so
    they are dropped rather than stored as degenerate one-vertex parts.
    """
    t = g.get("type")
    if t == "LineString":
        return [[(float(x), float(y)) for x, y in g["coordinates"]]] if len(g["coordinates"]) >= 2 else []
    if t == "MultiLineString":
        return [
            [(float(x), float(y)) for x, y in line]
            for line in g["coordinates"] if len(line) >= 2
        ]
    if t == "Polygon":
        return [
            [(float(x), float(y)) for x, y in ring]
            for ring in g["coordinates"] if len(ring) >= 4
        ]
    if t == "MultiPolygon":
        out = []
        for poly in g["coordinates"]:
            out.extend([(float(x), float(y)) for x, y in ring]
                       for ring in poly if len(ring) >= 4)
        return out
    if t == "GeometryCollection":
        out = []
        for sub in g.get("geometries", []):
            out.extend(_geojson_to_parts(sub))
        return out
    # Point, MultiPoint, empty
    return []


# --------------------------------------------------------------------------
# landing centres
# --------------------------------------------------------------------------

@dataclass
class Harbour:
    harbour_id: str
    name: str
    lat: float
    lon: float
    harbour_type: str | None
    source_id: str | None
    district: str | None


def fetch_harbours(conn: psycopg.Connection, bbox: tuple[float, float, float, float]) -> list[Harbour]:
    lon_min, lat_min, lon_max, lat_max = bbox
    h = HARBOUR_HALO_DEG
    lon_min, lat_min, lon_max, lat_max = lon_min - h, lat_min - h, lon_max + h, lat_max + h
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT harbour_id, name, lat, lon, harbour_type, source_id,
                   meta ->> 'district' AS district
            FROM harbours
            WHERE geom && ST_MakeEnvelope(%s,%s,%s,%s,4326)
            ORDER BY harbour_id
            """,
            (lon_min, lat_min, lon_max, lat_max),
        )
        return [Harbour(*r) for r in cur.fetchall()]


# --------------------------------------------------------------------------
# provenance and data age
# --------------------------------------------------------------------------

def fetch_sources(
    conn: psycopg.Connection,
    hazard_cells: Iterable[str],
    harbour_source_ids: Iterable[str | None],
    zone_source_ids: Iterable[str | None],
) -> list[dict[str, Any]]:
    """Build the per-source age list that the app shows as "data age".

    Three different kinds of age live here and they are not interchangeable:

      * forecast sources report issued_time. ORCA also records
        issued_time_kind, and for Open-Meteo it is 'fetch_proxy' -- the
        upstream publishes no model run time, so ORCA stores when it fetched.
        The real forecast is at least that old and may be older, so the age is
        a lower bound and the bundle says so.
      * static sources report fetched_at, which is a true fetch time.
      * the INCOIS landing centres additionally carry meta.snapshot_date. The
        layer was frozen in April 2024 and merely fetched today. Reporting the
        fetch time alone would present positions that are years old as fresh.
    """
    cells = list(hazard_cells)
    out: list[dict[str, Any]] = []
    seen: set[str] = set()

    with conn.cursor() as cur:
        # Hazard side. risk_cells stores no issued_time of its own, so age
        # comes from the observations that produced the cells, which is the
        # same derivation ORCA's own recall path uses.
        cur.execute(
            """
            SELECT o.source_id, s.name, s.reliability,
                   max(o.issued_time) AS issued,
                   max(o.valid_time)  AS covers_to,
                   array_agg(DISTINCT o.issued_time_kind) AS kinds
            FROM observations o
            JOIN sources s USING (source_id)
            WHERE o.h3_cell = ANY(%s)
            GROUP BY o.source_id, s.name, s.reliability
            ORDER BY o.source_id
            """,
            (cells,),
        )
        for source_id, name, reliability, issued, covers_to, kinds in cur:
            kinds = [k for k in (kinds or []) if k]
            kind = kinds[0] if len(kinds) == 1 else ("mixed" if kinds else None)
            entry: dict[str, Any] = {
                "source_id": source_id,
                "name": name,
                "role": "hazard",
                "issued_at": _iso(issued),
                "issued_time_kind": kind,
                "age_is_lower_bound": kind != "model_run",
                "covers_to": _iso(covers_to),
                "reliability": _num(reliability),
            }
            # Every source in the bundle carries a fetch time. For a
            # fetch_proxy source the issue time IS the fetch time: the upstream
            # publishes no model run, so ORCA stored when it retrieved. Copying
            # it into its own field means the app never has to infer that, and
            # a source that genuinely knows its model run time will show two
            # different numbers here rather than one doing double duty.
            if kind == "fetch_proxy":
                entry["fetched_at"] = _iso(issued)
            elif kind == "model_run":
                entry["fetched_at"] = None
                entry["fetched_at_note"] = (
                    "not recorded: this source publishes a model run time and "
                    "ORCA stores that instead")
            out.append(entry)
            seen.add(source_id)

        wanted = {s for s in list(harbour_source_ids) + list(zone_source_ids) if s}
        for source_id in sorted(wanted - seen):
            cur.execute(
                "SELECT name, reliability FROM sources WHERE source_id = %s",
                (source_id,),
            )
            row = cur.fetchone()
            name, reliability = row if row else (source_id, None)

            cur.execute(
                """
                SELECT max(fetched_at),
                       max(meta ->> 'snapshot_date'),
                       bool_or(coalesce((meta ->> 'is_snapshot')::boolean, false))
                FROM harbours WHERE source_id = %s
                """,
                (source_id,),
            )
            h_fetched, snapshot_date, is_snapshot = cur.fetchone()

            cur.execute(
                "SELECT max(fetched_at) FROM hazard_zones WHERE source_id = %s",
                (source_id,),
            )
            z_fetched = cur.fetchone()[0]

            fetched = max([t for t in (h_fetched, z_fetched) if t], default=None)
            role = "landing_centre" if h_fetched else "boundary"
            entry: dict[str, Any] = {
                "source_id": source_id,
                "name": name,
                "role": role,
                "fetched_at": _iso(fetched),
                "age_is_lower_bound": False,
                "reliability": _num(reliability),
            }
            if snapshot_date:
                entry["snapshot_date"] = snapshot_date
                entry["is_snapshot"] = bool(is_snapshot)
                # The age the user is shown comes from the snapshot, not the
                # fetch. This flag is what stops the app picking the flattering
                # number of the two.
                entry["age_basis"] = "snapshot_date"
            out.append(entry)

    for i, entry in enumerate(out):
        entry["index"] = i
    return out


def _iso(t: datetime | date | None) -> str | None:
    return t.isoformat() if t is not None else None


def _num(v: Any) -> float | None:
    return float(v) if v is not None else None
