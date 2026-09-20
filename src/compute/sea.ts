/**
 * Getting a boat home. Pure functions, no network, no new data.
 *
 * Everything here reads what the device already has: the 602 landing places
 * and the India-Sri Lanka boundary lines from the bundle, and the land mask
 * that src/geo/land.ts loads. No build-time fetch was needed for sea mode, and
 * nothing here reaches a network at the moment it is used, which is the whole
 * point of a screen for someone who is lost.
 *
 * THE BOUNDARY IS ADVISORY. The IMBL lines come from MarineRegions/VLIZ under
 * CC-BY 4.0. They are not Survey of India definitions and carry no legal
 * authority; the bundle says so in `boundary_disclaimer` and the screen repeats
 * it. What they are good for is staying well clear, which is why every margin
 * below only ever shrinks the reported distance.
 */

import { METRES_PER_NM, MIN_ASSUMED_SPEED_MS } from "../constants.ts";
import type { Bundle, Place } from "../bundle/types.ts";
import type { Land } from "../geo/land.ts";
import { onLand } from "../geo/land.ts";
import { bearingDeg, compass, distanceToRun, haversineM } from "./geo.ts";

/** Six knots. The default a small boat is assumed to make for the passage. */
export const DEFAULT_BOAT_SPEED_KN = 6;

export const knotsToMs = (kn: number) => (kn * METRES_PER_NM) / 3600;

/**
 * Alarm thresholds against the India-Sri Lanka line, in nautical miles.
 *
 * THESE ARE OURS, not ORCA's. Five is the distance at which a boat still has
 * time to turn without hurrying; two is the distance at which it does not.
 * Both are compared against the EFFECTIVE distance, which already has ORCA's
 * uncertainty budget subtracted, so an alarm can only ever fire early. ORCA's
 * stated design target on this line is zero false negatives, and these inherit
 * it: crying wolf costs a wasted turn, staying quiet costs a seized boat.
 */
export const IMBL_WARN_NM = 5;
export const IMBL_DANGER_NM = 2;

export interface HarbourOption {
  place: Place;
  distanceM: number;
  distanceNm: number;
  bearingDeg: number;
  compass: string;
  /** Seconds at the chosen speed, straight line. A lower bound. */
  seconds: number;
}

/**
 * The nearest places to make for.
 *
 * Every landing place in the bundle counts, not only the eight tagged `port`:
 * a fishing boat goes to the landing centre it came from, and 547 of those are
 * exactly what INCOIS lists. Type is shown so the reader can prefer a real
 * harbour when two are equally close.
 */
export function nearestHarbours(
  bundle: Bundle, lat: number, lon: number, count: number, speedMs: number,
): HarbourOption[] {
  const speed = Math.max(speedMs, MIN_ASSUMED_SPEED_MS);
  const lonScale = Math.cos((lat * Math.PI) / 180);

  const bestIndex: number[] = [];
  const bestScore: number[] = [];
  for (let i = 0; i < bundle.places.length; i++) {
    const p = bundle.places[i]!;
    const dx = (p.lon - lon) * lonScale;
    const dy = p.lat - lat;
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
    const place = bundle.places[i]!;
    const distanceM = haversineM(lat, lon, place.lat, place.lon);
    const b = bearingDeg(lat, lon, place.lat, place.lon);
    return {
      place,
      distanceM,
      distanceNm: distanceM / METRES_PER_NM,
      bearingDeg: b,
      compass: compass(b),
      seconds: distanceM / speed,
    };
  });
}

export interface ImblProximity {
  name: string;
  /** Straight-line distance to the line as drawn, in metres. */
  distanceM: number;
  /** After the uncertainty budget. Report THIS. */
  effectiveM: number;
  effectiveNm: number;
  bearingDeg: number;
  compass: string;
  level: "clear" | "warn" | "danger";
}

/**
 * How close the boat is to the India-Sri Lanka line.
 *
 * Only `imbl` zones. The EEZ and territorial sea travel in the bundle too, but
 * they arrive as polygon outlines whose nearest edge in coastal water is the
 * coast itself -- see docs/KNOWN_LIMITATIONS.md -- and an alarm that fires
 * because you are near the beach is an alarm nobody keeps listening to.
 */
export function imblProximity(
  bundle: Bundle, lat: number, lon: number,
): ImblProximity | null {
  const budget = bundle.meta.geofence_budget_nm;
  const simplifyM = bundle.meta.boundary_simplify.tolerance_m_approx ?? 0;

  let best: ImblProximity | null = null;
  for (const zone of bundle.zones) {
    if (zone.zoneType !== "imbl") continue;
    for (const part of zone.parts) {
      const hit = distanceToRun(lat, lon, part);
      if (hit === null) continue;
      if (best !== null && hit.distanceM >= best.distanceM) continue;

      const dataNm = budget.data_uncertainty["imbl"] ?? budget.default_data_uncertainty;
      const marginM = (dataNm + budget.position_uncertainty) * METRES_PER_NM + simplifyM;
      const effectiveM = Math.max(0, hit.distanceM - marginM);
      const effectiveNm = effectiveM / METRES_PER_NM;
      const b = bearingDeg(lat, lon, hit.lat, hit.lon);

      best = {
        name: zone.name,
        distanceM: hit.distanceM,
        effectiveM,
        effectiveNm,
        bearingDeg: b,
        compass: compass(b),
        level: effectiveNm <= IMBL_DANGER_NM
          ? "danger"
          : effectiveNm <= IMBL_WARN_NM ? "warn" : "clear",
      };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// does the straight line work?
// ---------------------------------------------------------------------------

/** Sample spacing along a candidate track, in metres. */
const SAMPLE_M = 250;

/** True when the straight line from a to b passes over land. */
export function crossesLand(
  land: Land | null, aLat: number, aLon: number, bLat: number, bLon: number,
): boolean {
  if (land === null) return false;
  const total = haversineM(aLat, aLon, bLat, bLon);
  const steps = Math.max(2, Math.ceil(total / SAMPLE_M));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (onLand(land, aLat + (bLat - aLat) * t, aLon + (bLon - aLon) * t)) return true;
  }
  return false;
}

/** Do two segments cross? Plain orientation test, planar over these spans. */
function segmentsCross(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): boolean {
  const side = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) =>
    Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
  const d1 = side(ax, ay, bx, by, cx, cy);
  const d2 = side(ax, ay, bx, by, dx, dy);
  const d3 = side(cx, cy, dx, dy, ax, ay);
  const d4 = side(cx, cy, dx, dy, bx, by);
  return d1 !== d2 && d3 !== d4;
}

/** True when the straight line from a to b crosses an IMBL line. */
export function crossesImbl(
  bundle: Bundle, aLat: number, aLon: number, bLat: number, bLon: number,
): boolean {
  for (const zone of bundle.zones) {
    if (zone.zoneType !== "imbl") continue;
    for (const part of zone.parts) {
      for (let i = 0; i + 3 < part.length; i += 2) {
        if (segmentsCross(
          aLon, aLat, bLon, bLat,
          part[i]!, part[i + 1]!, part[i + 2]!, part[i + 3]!,
        )) {
          return true;
        }
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// a coarse route through water
// ---------------------------------------------------------------------------

/** Grid spacing, about 500 m at these latitudes. */
const CELL_DEG = 0.0045;
/** Stay this far off the boundary when routing around it. */
const IMBL_KEEP_OFF_M = IMBL_DANGER_NM * METRES_PER_NM;
/**
 * Refuse to search a box bigger than this many cells on a side.
 *
 * 320 by 320 is 102,400 cells, which A* explores a fraction of and which keeps
 * the worst case inside a fraction of a second. Beyond that the honest answer
 * is that this grid is the wrong tool.
 */
const MAX_SPAN = 320;

/** A tiny binary heap. No dependency, and it is forty lines. */
class Heap {
  private readonly keys: number[] = [];
  private readonly values: number[] = [];

  get size(): number {
    return this.values.length;
  }

  push(value: number, key: number): void {
    this.values.push(value);
    this.keys.push(key);
    let i = this.values.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent]! <= this.keys[i]!) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): number | undefined {
    if (this.values.length === 0) return undefined;
    const top = this.values[0]!;
    const lastV = this.values.pop()!;
    const lastK = this.keys.pop()!;
    if (this.values.length > 0) {
      this.values[0] = lastV;
      this.keys[0] = lastK;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let small = i;
        if (l < this.keys.length && this.keys[l]! < this.keys[small]!) small = l;
        if (r < this.keys.length && this.keys[r]! < this.keys[small]!) small = r;
        if (small === i) break;
        this.swap(i, small);
        i = small;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    [this.values[a], this.values[b]] = [this.values[b]!, this.values[a]!];
    [this.keys[a], this.keys[b]] = [this.keys[b]!, this.keys[a]!];
  }
}

export interface SeaRoute {
  /** Waypoints from the boat to the harbour, [lat, lon] pairs. */
  points: Array<[number, number]>;
  distanceM: number;
  /** Why the straight line was not used. */
  reason: "land" | "imbl" | "both";
}

/**
 * A route around land and around the boundary, on a coarse grid.
 *
 * A* over roughly 500 m cells, eight-connected, with the great-circle distance
 * as the heuristic. Passability is computed LAZILY and cached: testing every
 * cell in a 200 by 200 box against the land mask up front would cost seconds,
 * and A* only ever looks at a fraction of them.
 *
 * IT IS A COARSE TRACK, NOT A PASSAGE PLAN. There is no bathymetry anywhere in
 * this project, so this knows nothing about depth, reefs, bars or traffic. It
 * knows where the shore is and where the line is, and it keeps the boat off
 * both. The screen says so.
 *
 * Returns null when no water path exists inside the search box, which the
 * caller must treat as "no route", never as "go straight".
 */
export function routeThroughWater(
  bundle: Bundle,
  land: Land | null,
  from: [number, number],
  to: [number, number],
  reason: SeaRoute["reason"],
): SeaRoute | null {
  // THE BOX GROWS UNTIL A ROUTE FITS IN IT.
  //
  // One guess at a search box is always wrong somewhere. A boat in the Gulf of
  // Mannar heading for the north side of Rameswaram has to round Dhanushkodi
  // point, which sat about two kilometres outside a box drawn at half the
  // straight-line span -- so the search reported no route through water that a
  // boat crosses every day. Rather than pick a bigger constant and be wrong
  // somewhere else, it tries a tight box first, because that is fast and
  // usually right, and widens only when that fails.
  const spanDeg = Math.max(Math.abs(to[1] - from[1]), Math.abs(to[0] - from[0]));
  for (const factor of [0.5, 1.5, 3]) {
    const found = searchWater(
      bundle, land, from, to, reason, Math.max(CELL_DEG * 20, spanDeg * factor));
    if (found !== null) return found;
  }
  return null;
}

function searchWater(
  bundle: Bundle,
  land: Land | null,
  from: [number, number],
  to: [number, number],
  reason: SeaRoute["reason"],
  pad: number,
): SeaRoute | null {
  const [fromLat, fromLon] = from;
  const [toLat, toLon] = to;

  const west = Math.min(fromLon, toLon) - pad;
  const east = Math.max(fromLon, toLon) + pad;
  const south = Math.min(fromLat, toLat) - pad;
  const north = Math.max(fromLat, toLat) + pad;

  const cols = Math.ceil((east - west) / CELL_DEG);
  const rows = Math.ceil((north - south) / CELL_DEG);
  if (cols > MAX_SPAN || rows > MAX_SPAN || cols < 2 || rows < 2) return null;

  const n = cols * rows;
  const UNKNOWN = 0, WATER = 1, BLOCKED = 2;
  const passable = new Uint8Array(n);
  const cellLat = (r: number) => south + (r + 0.5) * CELL_DEG;
  const cellLon = (c: number) => west + (c + 0.5) * CELL_DEG;

  const isWater = (index: number): boolean => {
    const cached = passable[index]!;
    if (cached !== UNKNOWN) return cached === WATER;
    const r = Math.floor(index / cols);
    const c = index % cols;
    const lat = cellLat(r);
    const lon = cellLon(c);
    let ok = land === null || !onLand(land, lat, lon);
    if (ok) {
      const imbl = imblProximity(bundle, lat, lon);
      if (imbl !== null && imbl.distanceM < IMBL_KEEP_OFF_M) ok = false;
    }
    passable[index] = ok ? WATER : BLOCKED;
    return ok;
  };

  const indexOf = (lat: number, lon: number): number => {
    const c = Math.min(cols - 1, Math.max(0, Math.floor((lon - west) / CELL_DEG)));
    const r = Math.min(rows - 1, Math.max(0, Math.floor((lat - south) / CELL_DEG)));
    return r * cols + c;
  };

  const start = indexOf(fromLat, fromLon);
  const goal = indexOf(toLat, toLon);
  if (start === goal) return null;

  const gScore = new Float64Array(n).fill(Infinity);
  const cameFrom = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const open = new Heap();

  const h = (index: number): number => {
    const r = Math.floor(index / cols);
    const c = index % cols;
    return haversineM(cellLat(r), cellLon(c), toLat, toLon);
  };

  gScore[start] = 0;
  open.push(start, h(start));

  let found = false;
  let visited = 0;
  while (open.size > 0) {
    const current = open.pop()!;
    if (closed[current] === 1) continue;
    closed[current] = 1;
    visited++;
    if (current === goal) {
      found = true;
      break;
    }
    const r = Math.floor(current / cols);
    const c = current % cols;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
        const next = nr * cols + nc;
        if (closed[next] === 1) continue;
        // The goal cell is entered even if it tests as land: a harbour is on
        // the shore by definition, and refusing to arrive would be absurd.
        if (next !== goal && !isWater(next)) continue;
        const step = haversineM(cellLat(r), cellLon(c), cellLat(nr), cellLon(nc));
        const tentative = gScore[current]! + step;
        if (tentative < gScore[next]!) {
          gScore[next] = tentative;
          cameFrom[next] = current;
          open.push(next, tentative + h(next));
        }
      }
    }
  }

  if (!found) return null;

  const cells: number[] = [];
  for (let at = goal; at !== -1; at = cameFrom[at]!) cells.push(at);
  cells.reverse();

  const points: Array<[number, number]> = [[fromLat, fromLon]];
  // The goal cell is dropped: it is allowed to be on land so the search can
  // arrive at a harbour, but emitting its centre would put a visible inland
  // kink on the drawn track. The last water cell runs straight to the harbour.
  for (const index of cells) {
    if (index === goal) continue;
    const r = Math.floor(index / cols);
    const c = index % cols;
    points.push([cellLat(r), cellLon(c)]);
  }
  points.push([toLat, toLon]);

  let distanceM = 0;
  for (let i = 1; i < points.length; i++) {
    distanceM += haversineM(points[i - 1]![0], points[i - 1]![1], points[i]![0], points[i]![1]);
  }

  void visited;
  return { points, distanceM, reason };
}

/**
 * The next point to steer for, roughly `aheadM` along the track.
 *
 * Pointing an arrow straight at a harbour that is behind a headland is how a
 * boat ends up on the headland, so sea mode steers to the next waypoint rather
 * than to the destination.
 */
export function nextWaypoint(
  route: SeaRoute, lat: number, lon: number, aheadM = 800,
): [number, number] | null {
  if (route.points.length < 2) return null;
  // Find the nearest point on the track, then walk forward from it.
  let nearest = 0;
  let nearestD = Infinity;
  for (let i = 0; i < route.points.length; i++) {
    const d = haversineM(lat, lon, route.points[i]![0], route.points[i]![1]);
    if (d < nearestD) {
      nearestD = d;
      nearest = i;
    }
  }
  let walked = 0;
  for (let i = nearest; i + 1 < route.points.length; i++) {
    walked += haversineM(
      route.points[i]![0], route.points[i]![1],
      route.points[i + 1]![0], route.points[i + 1]![1],
    );
    if (walked >= aheadM) return route.points[i + 1]!;
  }
  return route.points[route.points.length - 1]!;
}
