/**
 * Nearest place to land, and how long it might take to get there.
 *
 * "Might" is doing real work in that sentence. See the caveats below; they are
 * shown to the user, not just written here.
 */

import { DETOUR_FACTOR, MIN_ASSUMED_SPEED_MS, UNKNOWN_SPEED_MS } from "../constants.ts";
import type { Bundle, Place } from "../bundle/types.ts";
import { bearingDeg, compass, haversineM } from "./geo.ts";

export interface HarbourResult {
  place: Place;
  distanceM: number;
  /** Straight line times the detour factor. Still optimistic. See below. */
  trackM: number;
  seconds: number;
  bearingDeg: number;
  compass: string;
  speedMs: number;
}

/**
 * The nearest landing place, excluding one you are already standing at.
 *
 * This is not a route. It is a great-circle distance multiplied by ORCA's 1.25
 * coastal-passage factor, at a deliberately slow assumed speed. Three things
 * it does not know, all of which make the real time longer:
 *
 *   - the track. A real one goes around headlands and shoals.
 *   - the weather. ORCA fixes speed for a whole route and never slows a boat
 *     in a heavy sea, so its own durations are calm-water times. We do not
 *     invent a sea-state penalty here, because that would be a number nobody
 *     computed.
 *   - the water under the keel. No bathymetry exists anywhere in ORCA, and
 *     none is guessed at here.
 *
 * All three point the same way, so the figure is a lower bound and the screen
 * says so. Routing over the cell graph is step 4 and will replace this.
 */
export function nearestHarbour(
  bundle: Bundle,
  lat: number,
  lon: number,
  opts: { excludeId?: string; speedMs?: number } = {},
): HarbourResult | null {
  const speedMs = Math.max(opts.speedMs ?? UNKNOWN_SPEED_MS, MIN_ASSUMED_SPEED_MS);

  let best: Place | null = null;
  let bestM = Infinity;

  for (const place of bundle.places) {
    if (opts.excludeId !== undefined && place.id === opts.excludeId) continue;
    const d = haversineM(lat, lon, place.lat, place.lon);
    if (d < bestM) {
      bestM = d;
      best = place;
    }
  }
  if (best === null) return null;

  const trackM = bestM * DETOUR_FACTOR;
  const b = bearingDeg(lat, lon, best.lat, best.lon);
  return {
    place: best,
    distanceM: bestM,
    trackM,
    seconds: trackM / speedMs,
    bearingDeg: b,
    compass: compass(b),
    speedMs,
  };
}
