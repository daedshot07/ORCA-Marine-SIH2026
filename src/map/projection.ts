/**
 * Equirectangular projection, and the arithmetic for a scale bar.
 *
 * Longitude is scaled by cos(latitude) at the region centre. Over the seven
 * degrees of latitude this region spans, the error from treating that factor
 * as constant is under half a percent, which at the zoom levels this map uses
 * is a fraction of a pixel. A proper Mercator would be more code for less
 * legibility and no visible difference.
 *
 * Screen y grows downward, so latitude is negated once, here, rather than at
 * every call site.
 */

const DEG = Math.PI / 180;
const METRES_PER_DEG_LAT = 111132.95;

export interface View {
  /** Degrees at the centre of the canvas. */
  centreLon: number;
  centreLat: number;
  /** Pixels per degree of latitude. */
  scale: number;
  /** CSS pixels. */
  width: number;
  height: number;
  /** cos(latitude) at the region centre, fixed for the life of the view. */
  lonFactor: number;
}

export function makeView(
  bbox: readonly [number, number, number, number], width: number, height: number,
): View {
  const [w, s, e, n] = bbox;
  const centreLat = (s + n) / 2;
  const lonFactor = Math.cos(centreLat * DEG);
  const view: View = {
    centreLon: (w + e) / 2,
    centreLat,
    scale: 1,
    width,
    height,
    lonFactor,
  };
  return fitTo(view, bbox);
}

/** Scale and centre so a box fills the canvas with a small margin. */
export function fitTo(
  view: View, bbox: readonly [number, number, number, number], margin = 0.94,
): View {
  const [w, s, e, n] = bbox;
  const spanLon = Math.max(1e-6, (e - w) * view.lonFactor);
  const spanLat = Math.max(1e-6, n - s);
  return {
    ...view,
    centreLon: (w + e) / 2,
    centreLat: (s + n) / 2,
    scale: Math.min(view.width / spanLon, view.height / spanLat) * margin,
  };
}

export function toScreenX(view: View, lon: number): number {
  return view.width / 2 + (lon - view.centreLon) * view.lonFactor * view.scale;
}

export function toScreenY(view: View, lat: number): number {
  return view.height / 2 - (lat - view.centreLat) * view.scale;
}

export function toLon(view: View, x: number): number {
  return view.centreLon + (x - view.width / 2) / (view.lonFactor * view.scale);
}

export function toLat(view: View, y: number): number {
  return view.centreLat - (y - view.height / 2) / view.scale;
}

/** Metres per pixel at the view centre. */
export function metresPerPixel(view: View): number {
  return METRES_PER_DEG_LAT / view.scale;
}

/**
 * A scale bar length that is a round number of metres and fits the space.
 *
 * The bar is not decoration. At region zoom one hexagon is about 8.5 km
 * across, and without something to measure against, a field of shaded cells
 * reads as far more precise than it is.
 */
export function scaleBar(view: View, maxPx: number): { px: number; label: string } {
  const mpp = metresPerPixel(view);
  const target = maxPx * mpp;
  const pow = Math.pow(10, Math.floor(Math.log10(target)));
  let metres = pow;
  for (const step of [1, 2, 5, 10]) {
    if (pow * step <= target) metres = pow * step;
  }
  return {
    px: metres / mpp,
    label: metres >= 1000 ? `${Math.round(metres / 1000)} km` : `${Math.round(metres)} m`,
  };
}

/** Clamp a view so the region cannot be panned off the screen entirely. */
export function clamp(
  view: View, bbox: readonly [number, number, number, number],
): View {
  const [w, s, e, n] = bbox;
  return {
    ...view,
    centreLon: Math.min(Math.max(view.centreLon, w - 1), e + 1),
    centreLat: Math.min(Math.max(view.centreLat, s - 1), n + 1),
  };
}
