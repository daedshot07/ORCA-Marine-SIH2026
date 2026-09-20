/**
 * Distance to the nearest maritime boundary. Pure geometry, works offline.
 *
 * The margins are not written here. They travel in the bundle metadata,
 * copied from ORCA's core/geofence.py, so the app and ORCA cannot drift into
 * two different ideas of how much slack a boundary line deserves.
 */

import { METRES_PER_NM } from "../constants.ts";
import type { Bundle } from "../bundle/types.ts";
import { bearingDeg, compass, distanceToRun } from "./geo.ts";

/**
 * Zone types this figure will answer with, and why the list is short.
 *
 * INCLUDED
 *   imbl  a negotiated line between two states, stored as a real line. This is
 *         the boundary that actually gets a fishing boat seized, and in these
 *         waters it is the India-Sri Lanka line.
 *   mpa   a protected area. Entering it is the violation, so every part of its
 *         outline is a genuine limit no matter which side you approach from.
 *
 * EXCLUDED, and this is a known gap rather than an oversight
 *   baseline                    Not a limit at all. It is the landward
 *     reference the territorial sea is measured FROM, it runs along the coast,
 *     and it would win this figure for every boat in coastal water. Reporting
 *     someone as "at or over the baseline" would read as a violation of
 *     something when it only means they are near the shore.
 *
 *   territorial_sea, contiguous_zone, eez
 *     These arrive as the OUTLINE of a polygon, so each one includes the
 *     coastal side as well as the 12, 24 or 200 nautical mile arc. Near shore
 *     the nearest part of that outline is the coastline, so the honest reading
 *     of "1.1 km from the territorial sea" would be "1.1 km from the beach",
 *     which is true, useless, and easily misread as being about to cross a
 *     limit. Until the builder can separate the seaward arc from the coastal
 *     side, these are not offered as an answer to this question.
 *
 * All of them still travel in the bundle. This list governs one figure, not
 * what the file carries.
 */
const LIMIT_ZONE_TYPES = new Set(["imbl", "mpa"]);

export interface BoundaryResult {
  zoneType: string;
  zoneName: string;
  attribution: string;
  /** Straight-line distance to the line as drawn in the bundle, in metres. */
  distanceM: number;
  /** distance minus the uncertainty budget, floored at zero. Report THIS. */
  effectiveM: number;
  /** The budget applied, in metres. */
  marginM: number;
  bearingDeg: number;
  compass: string;
}

/**
 * Nearest boundary to a point.
 *
 * The reported figure is `effectiveM`, not the raw distance. ORCA's rule,
 * inherited here: the margin only ever shrinks the distance, so it can only
 * ever turn a clear verdict into an alert and never the reverse. Its stated
 * design target is zero false negatives on the India-Sri Lanka line.
 *
 * The budget is the zone's data uncertainty plus position uncertainty, then
 * the simplification tolerance on top, because these lines were thinned to
 * about 55 m before being packed and the app is the last place that knows it.
 */
export function nearestBoundary(
  bundle: Bundle, lat: number, lon: number,
): BoundaryResult | null {
  const budget = bundle.meta.geofence_budget_nm;
  const simplifyM = bundle.meta.boundary_simplify.tolerance_m_approx ?? 0;

  let best: BoundaryResult | null = null;

  for (const zone of bundle.zones) {
    if (!LIMIT_ZONE_TYPES.has(zone.zoneType)) continue;
    for (const part of zone.parts) {
      const hit = distanceToRun(lat, lon, part);
      if (hit === null) continue;
      if (best !== null && hit.distanceM >= best.distanceM) continue;

      const dataNm =
        budget.data_uncertainty[zone.zoneType] ?? budget.default_data_uncertainty;
      const marginM =
        (dataNm + budget.position_uncertainty) * METRES_PER_NM + simplifyM;

      best = {
        zoneType: zone.zoneType,
        zoneName: zone.name,
        attribution: zone.attribution,
        distanceM: hit.distanceM,
        effectiveM: Math.max(0, hit.distanceM - marginM),
        marginM,
        bearingDeg: bearingDeg(lat, lon, hit.lat, hit.lon),
        compass: compass(bearingDeg(lat, lon, hit.lat, hit.lon)),
      };
    }
  }
  return best;
}

/** Human label for a zone type, in the words a boundary is usually called by. */
export function zoneLabel(zoneType: string): string {
  switch (zoneType) {
    case "imbl": return "maritime boundary";
    case "eez": return "EEZ edge";
    case "territorial_sea": return "territorial sea";
    case "contiguous_zone": return "contiguous zone";
    case "baseline": return "baseline";
    case "mpa": return "protected area";
    default: return zoneType;
  }
}
