"""H3 work that happens once here so it never happens on a phone.

Two jobs:

  * give every bundled cell a centroid, so the app can measure distances with
    nothing but arithmetic
  * resolve every landing centre to the hazard cell that covers the water it
    fishes in

Both are done with the same `h3` library ORCA uses, at the resolution ORCA
fixes, so the app and ORCA cannot disagree about which cell a place is in.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import h3

#: Written into a landing centre record when no bundled cell is close enough.
#: The app renders this as "no data for this area", never as safe.
NO_CELL = 0xFFFFFFFF

EARTH_RADIUS_M = 6_371_008.8  # IUGG mean radius, the same figure ORCA uses


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(a))


def centroids(cells: list[str]) -> list[tuple[float, float]]:
    """(lon, lat) per cell, in the same order as the bundle's cell index."""
    out = []
    for c in cells:
        lat, lon = h3.cell_to_latlng(c)
        out.append((lon, lat))
    return out


def rings(cells: list[str]) -> list[list[tuple[float, float]]]:
    """(lon, lat) vertices per cell, in the bundle's cell order.

    H3 returns them as (lat, lng); everything else in this project is lon-first,
    and mixing the two is the bug that puts Kerala in Svalbard.
    """
    return [[(lon, lat) for lat, lon in h3.cell_to_boundary(c)] for c in cells]


@dataclass
class Resolved:
    cell_index: int          # index into the bundle's cell array, or NO_CELL
    offset_m: int            # distance from the place to that cell's centre
    how: str                 # "containing" | "neighbour" | "none"


def resolve_places(
    places: list[tuple[float, float]],
    cells: list[str],
    resolution: int,
) -> list[Resolved]:
    """Map each (lat, lon) to the hazard cell whose forecast applies to it.

    A landing centre stands on the shore, and ORCA only forecasts sea cells, so
    the cell physically containing a place is very often absent from the
    bundle. The forecast a fisherman there needs is the one for the water just
    off the beach.

    The rule, in order:

      1. the containing cell, if the bundle has it
      2. otherwise the nearest bundled cell in the immediate neighbour ring,
         which at resolution 5 reaches about 8.5 km
      3. otherwise nothing

    Step 3 is the important one. Widening the search until something is always
    found would mean quietly answering a question about one stretch of water
    with the forecast for another, and an answer that is always produced is
    exactly the kind that stops being checked.

    Measured over the 602 places in the kerala-tn region: 395 sit in a bundled
    cell of their own, 199 borrow a neighbour's, and 8 resolve to nothing. The
    centre of the forecast cell averages 8.3 km from the place and reaches
    23.4 km at worst, which is what a resolution 5 cell allows for a point near
    a vertex. That distance is stored per record so the screen can always say
    which water it is describing.
    """
    index_of = {c: i for i, c in enumerate(cells)}
    centre = {c: h3.cell_to_latlng(c) for c in cells}

    out: list[Resolved] = []
    for lat, lon in places:
        containing = h3.latlng_to_cell(lat, lon, resolution)

        if containing in index_of:
            clat, clon = centre[containing]
            out.append(Resolved(
                cell_index=index_of[containing],
                offset_m=round(haversine_m(lat, lon, clat, clon)),
                how="containing",
            ))
            continue

        best: tuple[float, str] | None = None
        for neighbour in h3.grid_disk(containing, 1):
            if neighbour not in index_of:
                continue
            nlat, nlon = centre[neighbour]
            d = haversine_m(lat, lon, nlat, nlon)
            if best is None or d < best[0]:
                best = (d, neighbour)

        if best is None:
            out.append(Resolved(cell_index=NO_CELL, offset_m=0, how="none"))
        else:
            d, neighbour = best
            out.append(Resolved(
                cell_index=index_of[neighbour],
                offset_m=round(d),
                how="neighbour",
            ))
    return out
