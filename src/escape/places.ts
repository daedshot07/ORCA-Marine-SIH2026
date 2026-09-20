/**
 * Places worth running to, and which of them is nearest.
 *
 * The file is vendored by scripts/fetch-safe-places.mjs from OpenStreetMap and
 * precached with the app shell, so this whole module works in airplane mode.
 * Nothing here fetches at the moment it is needed; by then there may be no
 * network, no tower, and no time.
 *
 * WHAT THESE RECORDS ARE, AND ARE NOT. They are community-mapped OSM objects:
 * shelters, assembly points, schools and hospitals within 5 km of the coast.
 * They are NOT an official shelter register, no authority has designated them,
 * and this app has not verified that any of them is open, staffed, above the
 * surge, or standing. Every one carries the OSM id it came from. The screen
 * says all of this out loud, because a list of buildings presented as "safe
 * places" during an evacuation is a claim, and this one has to be an honest
 * one.
 */

import { bearingDeg, compass, haversineM } from "../compute/geo.ts";
import { WALK_DETOUR_FACTOR, WALK_SPEED_MS } from "../constants.ts";

const URL_FOR = (regionId: string) => `/safe-places/${regionId}.json`;

// Re-exported so callers that already had it keep working; both now live in
// src/constants.ts, which is where every threshold this app applies is
// recorded along with where it came from.
export { WALK_DETOUR_FACTOR, WALK_SPEED_MS };

export interface SafePlace {
  type: string;
  lat: number;
  lon: number;
  /** Metres above sea level, or null. Almost always null: OSM rarely tags it. */
  elevationM: number | null;
  name: string;
  osmId: string;
}

export interface SafePlaces {
  regionId: string;
  attribution: string;
  /** Where the ground heights came from, and what they are not. */
  elevationAttribution: string | null;
  coastFilterKm: number;
  generatedAt: string;
  places: SafePlace[];
}

interface RawFile {
  v: number;
  region_id: string;
  attribution: string;
  elevation_attribution?: string;
  coast_filter_km: number;
  generated_at: string;
  coord_scale: number;
  types: string[];
  places: [number, number, number, number | null, string, string][];
}

const READER_VERSION = 1;

export function parseSafePlaces(raw: unknown): SafePlaces {
  const file = raw as RawFile;
  if (file.v > READER_VERSION) {
    throw new Error(`safe places file is version ${file.v}; this app reads ${READER_VERSION}`);
  }
  const scale = file.coord_scale;
  return {
    regionId: file.region_id,
    attribution: file.attribution,
    elevationAttribution: file.elevation_attribution ?? null,
    coastFilterKm: file.coast_filter_km,
    generatedAt: file.generated_at,
    places: file.places.map(([t, lat, lon, ele, name, osmId]) => ({
      type: file.types[t] ?? "unknown",
      lat: lat / scale,
      lon: lon / scale,
      elevationM: ele,
      name,
      osmId,
    })),
  };
}

/**
 * Load the list for a region, or null.
 *
 * Null is survivable: the escape screen falls back to the landing centres the
 * bundle already carries, which are real places on the coast with names, and
 * says which list it is using. An escape screen that renders nothing because a
 * file is missing would be the worst possible failure for this feature.
 */
export async function loadSafePlaces(
  regionId: string, signal?: AbortSignal,
): Promise<SafePlaces | null> {
  try {
    const res = await fetch(URL_FOR(regionId), { signal });
    if (!res.ok) return null;
    return parseSafePlaces(await res.json());
  } catch {
    return null;
  }
}

export interface RankedPlace {
  place: SafePlace;
  distanceM: number;
  bearingDeg: number;
  compass: string;
  /**
   * Seconds on foot: the straight line times WALK_DETOUR_FACTOR, at
   * WALK_SPEED_MS. Still a lower bound -- see the constant for why.
   */
  walkSeconds: number;
}

/**
 * The nearest `count` places to a position.
 *
 * Straight-line distance, and the screen says so in as many words. There is no
 * road graph on this device and inventing one would be worse than admitting
 * its absence: a route that looks authoritative and walks someone into a
 * flooded culvert is the failure mode. What this gives is a direction and a
 * distance, which is what a compass bearing has always given.
 *
 * A linear scan with no index: 7,722 places is small, and an index would be
 * another thing to get wrong for no gain anyone could measure.
 *
 * It allocates nothing per candidate, though, which is the part that matters.
 * The first version built a RankedPlace for every place and sorted the lot --
 * about 1.6 ms and 7,722 short-lived objects on every position update, every
 * three seconds, for the whole evacuation. Correct, and exactly the kind of
 * garbage a cheap Android does not need while someone is running. Now it keeps
 * three candidates by insertion and touches nothing else.
 *
 * Squared planar degrees rank the candidates; the real distance and the
 * bearing are computed only for the three that survive, since each is a trig
 * call. The ranking metric only has to ORDER them, and over a few kilometres
 * at one latitude it orders them identically to the great-circle distance.
 */
export function nearestSafePlaces(
  places: readonly SafePlace[], lat: number, lon: number, count = 3,
): RankedPlace[] {
  const lonScale = Math.cos(lat * Math.PI / 180);
  const bestIndex: number[] = [];
  const bestScore: number[] = [];

  for (let i = 0; i < places.length; i++) {
    const place = places[i]!;
    const dx = (place.lon - lon) * lonScale;
    const dy = place.lat - lat;
    const score = dx * dx + dy * dy;

    if (bestIndex.length === count && score >= bestScore[count - 1]!) continue;

    let at = bestIndex.length;
    while (at > 0 && bestScore[at - 1]! > score) at--;
    bestIndex.splice(at, 0, i);
    bestScore.splice(at, 0, score);
    if (bestIndex.length > count) {
      bestIndex.pop();
      bestScore.pop();
    }
  }

  return bestIndex.map((i) => {
    const place = places[i]!;
    const distanceM = haversineM(lat, lon, place.lat, place.lon);
    const bearing = bearingDeg(lat, lon, place.lat, place.lon);
    return {
      place,
      distanceM,
      bearingDeg: bearing,
      compass: compass(bearing),
      // The detour factor, not the raw straight line. Walking through
      // buildings is not a thing this app may quietly assume.
      walkSeconds: (distanceM * WALK_DETOUR_FACTOR) / WALK_SPEED_MS,
    };
  });
}

/** Plain-language type, in the words a person would use. */
export function typeLabel(type: string): string {
  switch (type) {
    case "cyclone_shelter": return "cyclone shelter";
    case "shelter": return "shelter";
    case "assembly_point": return "assembly point";
    case "school": return "school";
    case "hospital": return "hospital";
    case "landing_centre": return "landing centre";
    default: return type.replace(/_/g, " ");
  }
}

/** "12 min", "1 h 20 min". Walking, so minutes matter and seconds do not. */
export function walkTime(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}
