/**
 * Spherical geometry. Pure functions, no dependencies, no network.
 *
 * Everything the app measures offline comes through here, so the arithmetic is
 * written out rather than pulled from a library.
 */

import { EARTH_RADIUS_M } from "../constants.ts";

const DEG = Math.PI / 180;

/** Great-circle distance in metres. */
export function haversineM(
  lat1: number, lon1: number, lat2: number, lon2: number,
): number {
  const p1 = lat1 * DEG;
  const p2 = lat2 * DEG;
  const dp = p2 - p1;
  const dl = (lon2 - lon1) * DEG;
  const a =
    Math.sin(dp / 2) ** 2 +
    Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

/** Initial bearing in degrees, 0 to 360, measured clockwise from true north. */
export function bearingDeg(
  lat1: number, lon1: number, lat2: number, lon2: number,
): number {
  const p1 = lat1 * DEG;
  const p2 = lat2 * DEG;
  const dl = (lon2 - lon1) * DEG;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) / DEG) + 360) % 360;
}

/** Sixteen-point compass name, for reading aloud rather than plotting. */
const POINTS = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
];

export function compass(deg: number): string {
  return POINTS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16]!;
}

export interface NearestOnLine {
  distanceM: number;
  lat: number;
  lon: number;
}

/**
 * Shortest distance from a point to a polyline, and where on it that falls.
 *
 * The segments are projected into metres on a plane centred on the query
 * point, with longitude scaled by cos(latitude). Over the few kilometres a
 * simplified boundary segment spans, the error from treating that plane as
 * flat is far below a metre, which is three orders of magnitude inside the
 * 926 m data-uncertainty budget the answer is reported through anyway.
 *
 * `run` is a flat [lon, lat, lon, lat, ...] array, which is how the reader
 * hands boundary geometry over: one allocation per part rather than one per
 * vertex, because this loop runs over ten thousand points on a cheap phone.
 */
export function distanceToRun(
  lat: number, lon: number, run: Float64Array,
): NearestOnLine | null {
  const n = run.length / 2;
  if (n === 0) return null;

  const mPerDegLat = EARTH_RADIUS_M * DEG;
  const mPerDegLon = mPerDegLat * Math.cos(lat * DEG);

  if (n === 1) {
    return { distanceM: haversineM(lat, lon, run[1]!, run[0]!), lat: run[1]!, lon: run[0]! };
  }

  let bestSq = Infinity;
  let bestLat = run[1]!;
  let bestLon = run[0]!;

  let ax = (run[0]! - lon) * mPerDegLon;
  let ay = (run[1]! - lat) * mPerDegLat;

  for (let i = 1; i < n; i++) {
    const bx = (run[i * 2]! - lon) * mPerDegLon;
    const by = (run[i * 2 + 1]! - lat) * mPerDegLat;

    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;

    let t = 0;
    if (lenSq > 0) {
      t = -(ax * dx + ay * dy) / lenSq;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
    }
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    const dSq = cx * cx + cy * cy;

    if (dSq < bestSq) {
      bestSq = dSq;
      bestLon = lon + cx / mPerDegLon;
      bestLat = lat + cy / mPerDegLat;
    }
    ax = bx;
    ay = by;
  }

  // Measured again on the sphere, so the number reported is a real great-circle
  // distance and not the planar approximation used to pick the point.
  return {
    distanceM: haversineM(lat, lon, bestLat, bestLon),
    lat: bestLat,
    lon: bestLon,
  };
}

/**
 * The compass point spelled out: "NORTH-EAST", not "NE".
 *
 * Abbreviations are for a chart table. This is read at a run, by someone who
 * may not use them daily and may be reading in their second language, so the
 * escape screen spells it. The short form stays for the dense list rows, where
 * the number beside it is doing the work.
 */
const POINT_WORDS: Record<string, string> = {
  N: "NORTH", NNE: "NORTH-NORTH-EAST", NE: "NORTH-EAST", ENE: "EAST-NORTH-EAST",
  E: "EAST", ESE: "EAST-SOUTH-EAST", SE: "SOUTH-EAST", SSE: "SOUTH-SOUTH-EAST",
  S: "SOUTH", SSW: "SOUTH-SOUTH-WEST", SW: "SOUTH-WEST", WSW: "WEST-SOUTH-WEST",
  W: "WEST", WNW: "WEST-NORTH-WEST", NW: "NORTH-WEST", NNW: "NORTH-NORTH-WEST",
};

export function compassWords(deg: number): string {
  return POINT_WORDS[compass(deg)] ?? compass(deg);
}

