/**
 * The map, which now lives on the main screen rather than behind a button.
 *
 * Mounted once when a bundle arrives and updated in place after that, so it
 * keeps whatever the user panned or pinched to instead of snapping back on
 * every redraw.
 *
 * Gestures are raw pointer events. One finger pans, two pinch. There is no
 * gesture library because there are only two gestures and both are short.
 */

import type { Bundle, Place } from "../bundle/types.ts";
import type { Land } from "../geo/land.ts";
import { hourIndexFor } from "../compute/verdict.ts";
import { draw, type Marker } from "./render.ts";
import {
  clamp,
  fitTo,
  makeView,
  toLat,
  toLon,
  type View,
} from "./projection.ts";

const MIN_SCALE_FACTOR = 0.5;   // no further out than half the region fit
const MAX_SCALE = 40000;        // about 3 m per pixel

/** Half-width of the box the map fits when it moves to a point, in degrees. */
const FOCUS_PAD = 0.5;

interface State {
  bundle: Bundle;
  /** Shaded so sea and shore are told apart. Null until the mask loads. */
  land: Land | null;
  view: View;
  selected: Place | null;
  marker: Marker | null;
  fast: boolean;
  fitScale: number;
}

let state: State | null = null;
/** Kept aside when the mask arrives before a bundle does. */
let pendingLand: Land | null = null;
let frame = 0;
let attached = false;

const canvas = (): HTMLCanvasElement =>
  document.getElementById("mapCanvas") as HTMLCanvasElement;

function dpr(): number {
  // Capped: a 3x buffer is four times the fill cost of a 1.5x one, for no
  // visible gain on hatch patterns.
  return Math.min(window.devicePixelRatio || 1, 2);
}

function resize(): void {
  if (state === null) return;
  const c = canvas();
  const rect = c.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;
  const ratio = dpr();
  c.width = Math.round(rect.width * ratio);
  c.height = Math.round(rect.height * ratio);
  state.view = { ...state.view, width: rect.width, height: rect.height };
  render();
}

function render(): void {
  if (state === null || frame !== 0) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    if (state === null) return;
    const ctx = canvas().getContext("2d");
    if (ctx === null) return;
    const ratio = dpr();
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    draw(ctx, state.bundle, state.view, ratio, {
      land: state.land,
      hourIndex: hourIndexFor(state.bundle, Date.now()),
      selected: state.selected,
      marker: state.marker,
      fast: state.fast,
    });
  });
}

// ---------------------------------------------------------------------------
// gestures
// ---------------------------------------------------------------------------

const pointers = new Map<number, { x: number; y: number }>();
let pinchStart: { dist: number; scale: number } | null = null;

function pinchDistance(): number {
  const [a, b] = [...pointers.values()];
  if (a === undefined || b === undefined) return 1;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function attach(c: HTMLCanvasElement): void {
  c.addEventListener("pointerdown", (e) => {
    c.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2 && state !== null) {
      pinchStart = { dist: pinchDistance(), scale: state.view.scale };
    }
    if (state !== null) state.fast = true;
  });

  c.addEventListener("pointermove", (e) => {
    const prev = pointers.get(e.pointerId);
    if (prev === undefined || state === null) return;
    const next = { x: e.clientX, y: e.clientY };

    if (pointers.size === 1) {
      const dx = next.x - prev.x;
      const dy = next.y - prev.y;
      const v = state.view;
      state.view = clamp({
        ...v,
        centreLon: v.centreLon - dx / (v.lonFactor * v.scale),
        centreLat: v.centreLat + dy / v.scale,
      }, panBounds());
    }

    pointers.set(e.pointerId, next);

    if (pointers.size === 2 && pinchStart !== null) {
      const wanted = pinchStart.scale * (pinchDistance() / pinchStart.dist);
      state.view = {
        ...state.view,
        scale: Math.min(MAX_SCALE, Math.max(state.fitScale * MIN_SCALE_FACTOR, wanted)),
      };
    }
    render();
  });

  const end = (e: PointerEvent): void => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchStart = null;
    if (pointers.size === 0 && state !== null) {
      // Patterns come back only when the fingers leave, so a pan stays smooth
      // and the detailed frame is drawn once at the end.
      state.fast = false;
      render();
    }
  };
  c.addEventListener("pointerup", end);
  c.addEventListener("pointercancel", end);

  // Desktop convenience for the demo. Not a phone gesture.
  c.addEventListener("wheel", (e) => {
    if (state === null) return;
    e.preventDefault();
    const rect = c.getBoundingClientRect();
    const lon = toLon(state.view, e.clientX - rect.left);
    const lat = toLat(state.view, e.clientY - rect.top);
    const scale = Math.min(
      MAX_SCALE,
      Math.max(state.fitScale * MIN_SCALE_FACTOR,
               state.view.scale * Math.exp(-e.deltaY / 400)),
    );
    // Keep the point under the cursor fixed while zooming.
    const ratio = state.view.scale / scale;
    state.view = clamp({
      ...state.view,
      scale,
      centreLon: lon + (state.view.centreLon - lon) * ratio,
      centreLat: lat + (state.view.centreLat - lat) * ratio,
    }, panBounds());
    render();
  }, { passive: false });
}

// ---------------------------------------------------------------------------
// mount and update
// ---------------------------------------------------------------------------

/** Called once per bundle. Fits the whole region until told otherwise. */
export function mountMap(bundle: Bundle): void {
  const c = canvas();
  const rect = c.getBoundingClientRect();
  const base = makeView(bundle.meta.bbox, rect.width || 320, rect.height || 280);

  state = {
    bundle,
    land: pendingLand,
    view: base,
    selected: null,
    marker: null,
    fast: false,
    fitScale: base.scale,
  };

  if (!attached) {
    attach(c);
    window.addEventListener("resize", resize);
    // The map is 45dvh, so a phone rotating or a browser bar sliding away
    // changes its height without a resize event on some engines.
    if ("ResizeObserver" in window) new ResizeObserver(resize).observe(c);
    attached = true;
  }
  resize();
}

/** Give the map the land mask. Safe to call before or after a bundle arrives. */
export function setMapLand(land: Land | null): void {
  pendingLand = land;
  if (state !== null) {
    state.land = land;
    render();
  }
}

export function isMounted(): boolean {
  return state !== null;
}

export interface MapUpdate {
  selected: Place | null;
  marker: Marker | null;
  /**
   * Move the view to this point. Omitted on an ordinary redraw so the map
   * keeps whatever the user panned to.
   */
  centreOn?: { lat: number; lon: number } | null;
}

/**
 * Update what the map shows.
 *
 * Both a selected place and a live marker can be set at once, on purpose: when
 * someone picks an area by hand the map moves there, and their own position
 * stays drawn if it falls inside the view. Seeing both at once is the point.
 */
export function updateMap(update: MapUpdate): void {
  if (state === null) return;
  state.selected = update.selected;
  state.marker = update.marker;

  if (update.centreOn !== undefined && update.centreOn !== null) {
    const { lat, lon } = update.centreOn;
    state.view = fitTo(state.view, [
      lon - FOCUS_PAD, lat - FOCUS_PAD, lon + FOCUS_PAD, lat + FOCUS_PAD,
    ]);
  }
  render();
}

/**
 * How far the map may be panned.
 *
 * The region's own box, widened to include the marker when there is one.
 * Without that, centring on a fix outside the region worked and then the first
 * drag snapped the view back across the country, which looks like the map
 * fighting the user.
 */
function panBounds(): [number, number, number, number] {
  const [w, s, e, n] = state!.bundle.meta.bbox;
  const marker = state!.marker;
  if (marker === null) return [w, s, e, n];
  return [
    Math.min(w, marker.lon), Math.min(s, marker.lat),
    Math.max(e, marker.lon), Math.max(n, marker.lat),
  ];
}

/** The "centre on me" button. No-op without a fix, and the button is disabled. */
export function centreOnMarker(): void {
  if (state === null || state.marker === null) return;
  const { lat, lon } = state.marker;
  state.view = fitTo(state.view, [
    lon - FOCUS_PAD, lat - FOCUS_PAD, lon + FOCUS_PAD, lat + FOCUS_PAD,
  ]);
  render();
}

/**
 * Put the whole region back in view.
 *
 * Used when a fix lands outside the loaded region. Centring on the user would
 * pan the map off its own data and leave a blank rectangle, so the map shows
 * the water it can actually describe instead, and the screen says in words
 * that the user is not in it.
 */
export function showRegion(): void {
  if (state === null) return;
  state.view = fitTo(state.view, state.bundle.meta.bbox);
  render();
}

/** Redraw without changing the view, for when the forecast hour rolls over. */
export function refreshMap(): void {
  render();
}
