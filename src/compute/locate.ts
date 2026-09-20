/**
 * Turning a GPS position into a forecast cell, offline, with no library.
 *
 * The bundle ships each cell's hexagon, so this is an exact containment test
 * rather than a nearest-neighbour guess. That matters: "nearest cell" always
 * returns something, and something is exactly what must not be returned for a
 * boat outside the covered water.
 */

import type { Bundle, Place } from "../bundle/types.ts";
import { haversineM } from "./geo.ts";

const RING_VERTICES = 6;

/** How many nearest cells to test before concluding the point is outside. */
const CANDIDATES = 8;

export interface Located {
  /** Index into the cell arrays, or null when the position is not covered. */
  cellIndex: number | null;
  /** Distance from the position to that cell's centre, in metres. */
  offsetM: number;
}

/**
 * The cell containing this position.
 *
 * Nearest centroids first, then an exact point-in-polygon on each until one
 * contains the point. Hexagons tile the plane with no gaps and no overlaps, so
 * if the position is inside the covered area at all it is inside one of the
 * few nearest cells. Failing all of them means genuinely outside, and the
 * caller must say so rather than fall back to the closest.
 */
export function locate(bundle: Bundle, lat: number, lon: number): Located {
  const rings = bundle.cellRings;
  if (rings === null) {
    // A version 2 bundle has no hexagons. Without them there is no honest
    // containment test, so this reports "not covered" rather than guessing.
    return { cellIndex: null, offsetM: 0 };
  }

  // Squared degree distance is enough to rank candidates; the real distance is
  // only computed for the one that wins.
  const nearest: Array<{ index: number; d2: number }> = [];
  for (let c = 0; c < bundle.nCells; c++) {
    const dx = (bundle.cellLon[c]! - lon);
    const dy = (bundle.cellLat[c]! - lat);
    const d2 = dx * dx + dy * dy;
    if (nearest.length < CANDIDATES) {
      nearest.push({ index: c, d2 });
      nearest.sort((a, b) => a.d2 - b.d2);
    } else if (d2 < nearest[CANDIDATES - 1]!.d2) {
      nearest[CANDIDATES - 1] = { index: c, d2 };
      nearest.sort((a, b) => a.d2 - b.d2);
    }
  }

  for (const { index } of nearest) {
    if (inCell(rings, index, lat, lon)) {
      return {
        cellIndex: index,
        offsetM: haversineM(lat, lon, bundle.cellLat[index]!, bundle.cellLon[index]!),
      };
    }
  }
  return { cellIndex: null, offsetM: 0 };
}

/** Ray casting against one cell's stored hexagon. */
function inCell(rings: Float64Array, cell: number, lat: number, lon: number): boolean {
  const base = cell * RING_VERTICES * 2;
  let inside = false;
  for (let i = 0, j = RING_VERTICES - 1; i < RING_VERTICES; j = i++) {
    const xi = rings[base + i * 2]!;
    const yi = rings[base + i * 2 + 1]!;
    const xj = rings[base + j * 2]!;
    const yj = rings[base + j * 2 + 1]!;
    if ((yi > lat) !== (yj > lat) &&
        lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Is this position inside the bundle's region box at all? */
export function inRegion(bundle: Bundle, lat: number, lon: number): boolean {
  const [w, s, e, n] = bundle.meta.bbox;
  return lon >= w && lon <= e && lat >= s && lat <= n;
}

/** The selectable place closest to a position, for pre-filling the selectors. */
export function nearestPlace(places: readonly Place[], lat: number, lon: number): Place | null {
  let best: Place | null = null;
  let bestM = Infinity;
  for (const place of places) {
    const d = haversineM(lat, lon, place.lat, place.lon);
    if (d < bestM) {
      bestM = d;
      best = place;
    }
  }
  return best;
}
