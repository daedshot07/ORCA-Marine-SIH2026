"""Coastal region definitions.

A region is a name and a bounding box. Everything else about a bundle --
which cells, which zones, which landing centres -- follows from the box.

Adding or splitting regions is a change to this file alone. It is not a
change to the bundle format: the format carries n_cells and a bbox in the
header and metadata and never assumes a particular region.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class Region:
    region_id: str
    name: str
    # lon_min, lat_min, lon_max, lat_max -- web order (west, south, east, north).
    #
    # Axis order is a real hazard in this codebase's upstreams: MarineRegions
    # WFS takes lon,lat; Overpass takes lat,lon; CAP polygons are lat,lon.
    # ORCA documents this at each use site. Here there is exactly one
    # convention -- lon first -- and every query below converts explicitly.
    bbox: tuple[float, float, float, float]


REGIONS: dict[str, Region] = {
    # Reuses ORCA's own production ingest box verbatim rather than inventing a
    # new one, so the bundle covers exactly the water ORCA actually computes:
    #   .github/workflows/refresh-data.yml
    #     ingest_forecast --bbox 7.0 74.0 13.6 81.0   (S W N E)
    # named after backend/app/aoi.py:KERALA_TN_COAST.
    "kerala-tn": Region(
        region_id="kerala-tn",
        name="Kerala and Tamil Nadu coast",
        bbox=(74.0, 7.0, 81.0, 13.6),
    ),
}


def get(region_id: str) -> Region:
    try:
        return REGIONS[region_id]
    except KeyError:
        known = ", ".join(sorted(REGIONS))
        raise SystemExit(f"unknown region {region_id!r}; known regions: {known}")
