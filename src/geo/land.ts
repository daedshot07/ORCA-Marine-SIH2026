/**
 * Is this position on land?
 *
 * The app must never show a marine verdict to someone standing on land, and
 * before this file existed it did, routinely.
 *
 * Sampling the Kerala-TN region box on a 0.02 degree grid finds 56,882 points on
 * land, and 3,052 of them -- 5.4 per cent -- fell inside a forecast hexagon and
 * were handed a sea verdict. The worst was CAUTION, 18.5 per cent chance of
 * dangerous seas, for a point 1.3 km inland near Kanyakumari (8.18, 77.72). The
 * furthest inland was 81 km (13.00, 79.52). Hexagons at H3 resolution 5 are 8.5
 * km across and ORCA's hazard field does not stop at the waterline, so the cell
 * lookup answers confidently well inside the coast.
 *
 * That is the kind of wrong that costs you every other number on the screen.
 *
 * The mask is Natural Earth land, clipped to an envelope around India and
 * vendored by builder/fetch_land.py, whose docstring is the normative
 * description of the byte layout below. It is LAND ONLY: it knows where the
 * sea ends and it does not know where one country ends and another begins.
 *
 * One file for the whole country, fetched once and precached with the app
 * shell, rather than a per-region layer. Land does not change per region, and
 * the question "am I at sea" has to be answerable for a position that no
 * region bundle covers at all -- which is exactly the case a per-region layer
 * could not answer.
 */

import { EARTH_RADIUS_M } from "../constants.ts";
import { haversineM } from "../compute/geo.ts";

const LAND_URL = "/land/india-land.bin";
const MAGIC = "ORCALND\0";
const READER_VERSION = 1;
const HEADER_BYTES = 40;
const RING_RECORD_BYTES = 24;
const COORD_SCALE = 1e7;
const DEG = Math.PI / 180;

export interface Land {
  ringCount: number;
  /** Four per ring: min lon, min lat, max lon, max lat, in degrees. */
  ringBox: Float64Array;
  /** Index of each ring's first point in `lon` / `lat`. */
  ringFirst: Uint32Array;
  /** Point count per ring. Rings are closed: the last point repeats the first. */
  ringPoints: Uint32Array;
  /** Index of each ring's first segment in the coast bitmap. */
  ringFirstSegment: Uint32Array;
  lon: Float64Array;
  lat: Float64Array;
  /**
   * One bit per segment. Set means real coast; clear means a clip artefact,
   * an edge that exists only because the source polygon was cut to a box.
   *
   * Containment ignores this and walks every segment, because a ring has to
   * stay closed for an inside test to mean anything. Distance-to-coast honours
   * it, because measuring to the side of a bounding box and calling it the
   * coast would produce a plausible number that is simply false.
   */
  coast: Uint8Array;
  /** The clip envelope: west, south, east, north, in degrees. */
  envelope: [number, number, number, number];
}

export class LandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LandError";
  }
}

export function parseLand(buf: ArrayBuffer): Land {
  if (buf.byteLength < HEADER_BYTES) {
    throw new LandError("The land mask file is truncated.");
  }
  const dv = new DataView(buf);
  const magic = new TextDecoder().decode(new Uint8Array(buf, 0, 8));
  if (magic !== MAGIC) throw new LandError("That is not a land mask file.");

  const version = dv.getUint16(8, true);
  if (version > READER_VERSION) {
    throw new LandError(`The land mask is version ${version}; this app reads ${READER_VERSION}.`);
  }
  const headerBytes = dv.getUint16(10, true);
  const ringCount = dv.getUint32(12, true);
  const pointCount = dv.getUint32(16, true);
  const envelope: [number, number, number, number] = [
    dv.getInt32(20, true) / COORD_SCALE,
    dv.getInt32(24, true) / COORD_SCALE,
    dv.getInt32(28, true) / COORD_SCALE,
    dv.getInt32(32, true) / COORD_SCALE,
  ];
  const flagBytes = dv.getUint32(36, true);

  const ringsAt = headerBytes;
  const pointsAt = ringsAt + ringCount * RING_RECORD_BYTES;
  const flagsAt = pointsAt + pointCount * 8;
  if (flagsAt + flagBytes !== buf.byteLength) {
    throw new LandError("The land mask file is the wrong length.");
  }

  const ringBox = new Float64Array(ringCount * 4);
  const ringFirst = new Uint32Array(ringCount);
  const ringPoints = new Uint32Array(ringCount);
  const ringFirstSegment = new Uint32Array(ringCount);

  let segment = 0;
  for (let r = 0; r < ringCount; r++) {
    const at = ringsAt + r * RING_RECORD_BYTES;
    ringBox[r * 4] = dv.getInt32(at, true) / COORD_SCALE;
    ringBox[r * 4 + 1] = dv.getInt32(at + 4, true) / COORD_SCALE;
    ringBox[r * 4 + 2] = dv.getInt32(at + 8, true) / COORD_SCALE;
    ringBox[r * 4 + 3] = dv.getInt32(at + 12, true) / COORD_SCALE;
    ringFirst[r] = dv.getUint32(at + 16, true);
    ringPoints[r] = dv.getUint32(at + 20, true);
    ringFirstSegment[r] = segment;
    segment += ringPoints[r]! - 1;
  }

  const lon = new Float64Array(pointCount);
  const lat = new Float64Array(pointCount);
  for (let i = 0; i < pointCount; i++) {
    lon[i] = dv.getInt32(pointsAt + i * 8, true) / COORD_SCALE;
    lat[i] = dv.getInt32(pointsAt + i * 8 + 4, true) / COORD_SCALE;
  }

  return {
    ringCount,
    ringBox,
    ringFirst,
    ringPoints,
    ringFirstSegment,
    lon,
    lat,
    coast: new Uint8Array(buf, flagsAt, flagBytes),
    envelope,
  };
}

/**
 * Load the mask, or null if it is not there.
 *
 * Null is survivable and must stay survivable: the app still renders, it
 * simply cannot say whether a position is ashore, and the screen says so
 * rather than quietly going back to answering sea questions about dry land.
 * In practice the file is precached with the shell, so this only fails on a
 * first visit that had no network -- which is also a first visit with no
 * bundle.
 *
 * The URL is a constant. Nothing about the position is ever interpolated into
 * it, for the same reason src/bundle/source.ts refuses to build one.
 */
export async function loadLand(signal?: AbortSignal): Promise<Land | null> {
  try {
    const res = await fetch(LAND_URL, { signal });
    if (!res.ok) return null;
    return parseLand(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/** Ray casting against one closed ring. */
function inRing(land: Land, r: number, lat: number, lon: number): boolean {
  const first = land.ringFirst[r]!;
  const n = land.ringPoints[r]!;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = land.lon[first + i]!;
    const yi = land.lat[first + i]!;
    const xj = land.lon[first + j]!;
    const yj = land.lat[first + j]!;
    if ((yi > lat) !== (yj > lat) &&
        lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * True when this position is on land.
 *
 * Even-odd across every ring: a point inside an odd number of rings is on
 * land. That is what makes a lake inside a landmass come out as not-land
 * without this code needing to know which rings were islands and which were
 * holes -- the mask does not distinguish them and does not need to.
 *
 * A ring can only contain the point if its bounding box does, so the box test
 * is a sound filter rather than an approximation, and it skips almost all 253
 * rings for any given query.
 */
export function onLand(land: Land, lat: number, lon: number): boolean {
  let inside = false;
  for (let r = 0; r < land.ringCount; r++) {
    const b = r * 4;
    if (lon < land.ringBox[b]! || lon > land.ringBox[b + 2]! ||
        lat < land.ringBox[b + 1]! || lat > land.ringBox[b + 3]!) {
      continue;
    }
    if (inRing(land, r, lat, lon)) inside = !inside;
  }
  return inside;
}

/** True when a position falls inside the clipped area at all. */
export function inMask(land: Land, lat: number, lon: number): boolean {
  const [w, s, e, n] = land.envelope;
  return lon >= w && lon <= e && lat >= s && lat <= n;
}

export interface NearestCoast {
  distanceM: number;
  lat: number;
  lon: number;
}

/**
 * Distance to the nearest real coastline, in metres.
 *
 * Not `distanceToRun` from src/compute/geo.ts, and the difference is the whole
 * point of this file: that function measures to every segment it is given,
 * and roughly one segment in a thousand here is a clip artefact running down
 * the side of the bounding box. Eight of them, each hundreds of kilometres
 * long, sitting exactly where an inland user's nearest "coast" would be found.
 * Skipping them is not an optimisation, it is the correctness condition.
 *
 * Segments are projected onto a plane centred on the query point with
 * longitude scaled by cos(latitude), the same approximation and the same
 * reasoning as distanceToRun, and the winner is then re-measured on the
 * sphere so the reported number is a real great-circle distance.
 */
export function nearestCoast(land: Land, lat: number, lon: number): NearestCoast | null {
  const mPerDegLat = EARTH_RADIUS_M * DEG;
  const mPerDegLon = mPerDegLat * Math.cos(lat * DEG);

  let bestSq = Infinity;
  let bestLat = 0;
  let bestLon = 0;

  for (let r = 0; r < land.ringCount; r++) {
    const b = r * 4;
    // Lower bound on the distance to anything in this ring. Cheap, and it
    // discards most of the country for a coastal query.
    const dxBox = Math.max(land.ringBox[b]! - lon, 0, lon - land.ringBox[b + 2]!) * mPerDegLon;
    const dyBox = Math.max(land.ringBox[b + 1]! - lat, 0, lat - land.ringBox[b + 3]!) * mPerDegLat;
    if (dxBox * dxBox + dyBox * dyBox >= bestSq) continue;

    const first = land.ringFirst[r]!;
    const n = land.ringPoints[r]!;
    const firstSeg = land.ringFirstSegment[r]!;

    let ax = (land.lon[first]! - lon) * mPerDegLon;
    let ay = (land.lat[first]! - lat) * mPerDegLat;

    for (let i = 1; i < n; i++) {
      const bx = (land.lon[first + i]! - lon) * mPerDegLon;
      const by = (land.lat[first + i]! - lat) * mPerDegLat;

      const seg = firstSeg + i - 1;
      // Bit clear means clip artefact: an edge of the bounding box, not coast.
      if ((land.coast[seg >> 3]! & (1 << (seg & 7))) === 0) {
        ax = bx;
        ay = by;
        continue;
      }

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
  }

  if (bestSq === Infinity) return null;
  return {
    distanceM: haversineM(lat, lon, bestLat, bestLon),
    lat: bestLat,
    lon: bestLon,
  };
}
