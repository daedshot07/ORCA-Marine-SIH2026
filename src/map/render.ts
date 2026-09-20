/**
 * Draw the map. Canvas 2D, everything from the bundle, nothing from a network.
 *
 * Canvas rather than SVG: 965 pattern-filled hexagons plus a coastline is
 * roughly 1,600 nodes as SVG, and this has to pan on a cheap Android. Canvas
 * treats it as geometry, and a gesture can drop to outlines to stay smooth.
 */

import type { Bundle, Place } from "../bundle/types.ts";
import type { Land } from "../geo/land.ts";
import { locate } from "../compute/locate.ts";
import { TINT_LAND } from "../constants.ts";
import { verdictForCell } from "../compute/verdict.ts";
import { fillFor, makePatterns, type FillKind, type Patterns } from "./patterns.ts";
import {
  scaleBar,
  toLat,
  toLon,
  toScreenX,
  toScreenY,
  type View,
} from "./projection.ts";

const INK = "#000";
const PAPER = "#fff";
const RING_VERTICES = 6;

export interface Marker {
  lat: number;
  lon: number;
  /** Reported GPS accuracy in metres, drawn as a circle. */
  accuracyM: number;
}

export interface DrawOptions {
  /** The land mask, shaded so sea and shore can be told apart. */
  land: Land | null;
  hourIndex: number;
  selected: Place | null;
  marker: Marker | null;
  /** During a pan or pinch, skip the pattern fills and draw outlines only. */
  fast: boolean;
}

let patterns: Patterns | null = null;
let patternDpr = 0;

export function draw(
  ctx: CanvasRenderingContext2D,
  bundle: Bundle,
  view: View,
  dpr: number,
  opts: DrawOptions,
): void {
  if (patterns === null || patternDpr !== dpr) {
    patterns = makePatterns(ctx, dpr);
    patternDpr = dpr;
  }

  ctx.save();
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, view.width, view.height);

  // Land first, underneath everything. This is the change that made the map
  // readable: the coastline used to be a line with white on both sides, so
  // there was no way to tell which side was water except by noticing which
  // side the hexagons were on. Now the sea is the blank half.
  if (!opts.fast) drawLand(ctx, opts.land, view);
  drawCoastline(ctx, bundle, view);
  drawCells(ctx, bundle, view, opts);
  drawBoundaries(ctx, bundle, view);
  drawPlaces(ctx, bundle, view, opts.selected);
  if (opts.marker !== null) {
    drawYourCell(ctx, bundle, view, opts.marker);
    drawMarker(ctx, view, opts.marker);
  }
  if (opts.selected !== null) drawSelectedLabel(ctx, view, opts.selected);

  drawScaleBar(ctx, view);
  drawNorth(ctx, view);
  drawKey(ctx, bundle);
  ctx.restore();
}

/**
 * Shade the land.
 *
 * One path for every visible ring, filled even-odd, so a lagoon inside a
 * landmass comes out as water without this code needing to know which rings
 * were islands and which were holes -- the same rule onLand() uses.
 *
 * Skipped during a pan, like the hazard patterns: 11,375 points is more than a
 * cheap Android wants to fill on every frame of a drag, and the outline map it
 * falls back to is still legible.
 */
function drawLand(ctx: CanvasRenderingContext2D, land: Land | null, view: View): void {
  if (land === null) return;

  // The view's own box, so rings entirely off screen are never walked.
  const west = toLon(view, 0);
  const east = toLon(view, view.width);
  const north = toLat(view, 0);
  const south = toLat(view, view.height);

  ctx.beginPath();
  let drew = false;
  for (let r = 0; r < land.ringCount; r++) {
    const b = r * 4;
    if (land.ringBox[b + 2]! < west || land.ringBox[b]! > east ||
        land.ringBox[b + 3]! < south || land.ringBox[b + 1]! > north) {
      continue;
    }
    const first = land.ringFirst[r]!;
    const n = land.ringPoints[r]!;
    for (let i = 0; i < n; i++) {
      const x = toScreenX(view, land.lon[first + i]!);
      const y = toScreenY(view, land.lat[first + i]!);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    drew = true;
  }
  if (!drew) return;
  ctx.fillStyle = TINT_LAND;
  ctx.fill("evenodd");
}

/**
 * A heavy ring around the hexagon the user is actually in.
 *
 * Without it the verdict on screen belongs to one of 965 identical shapes and
 * the reader has no way to see which. This is the cell the number came from.
 */
function drawYourCell(
  ctx: CanvasRenderingContext2D, bundle: Bundle, view: View, marker: Marker,
): void {
  const rings = bundle.cellRings;
  if (rings === null) return;
  const located = locate(bundle, marker.lat, marker.lon);
  if (located.cellIndex === null) return;

  const base = located.cellIndex * RING_VERTICES * 2;
  ctx.beginPath();
  for (let v = 0; v < RING_VERTICES; v++) {
    const x = toScreenX(view, rings[base + v * 2]!);
    const y = toScreenY(view, rings[base + v * 2 + 1]!);
    if (v === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.strokeStyle = PAPER;
  ctx.lineWidth = 5;
  ctx.stroke();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2.5;
  ctx.stroke();
}

/** The chosen place, named on the map rather than only in the list. */
function drawSelectedLabel(
  ctx: CanvasRenderingContext2D, view: View, selected: Place,
): void {
  const x = toScreenX(view, selected.lon);
  const y = toScreenY(view, selected.lat);
  if (x < 0 || y < 0 || x > view.width || y > view.height) return;

  ctx.font = "800 11px system-ui, sans-serif";
  const text = selected.name;
  const w = ctx.measureText(text).width + 10;
  // Flipped to the left near the right edge so a long name is never clipped.
  const lx = x + w + 18 > view.width ? x - w - 16 : x + 16;
  const ly = y - 7;

  ctx.fillStyle = PAPER;
  ctx.fillRect(lx, ly, w, 16);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(lx + 0.75, ly + 0.75, w - 1.5, 14.5);
  ctx.fillStyle = INK;
  ctx.fillText(text, lx + 5, ly + 12);
}

/** North is up and never rotates, but a map with no north mark says nothing. */
function drawNorth(ctx: CanvasRenderingContext2D, view: View): void {
  const x = view.width - 20;
  const y = 22;
  ctx.fillStyle = PAPER;
  ctx.fillRect(x - 12, y - 14, 24, 38);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  ctx.strokeRect(x - 11.5, y - 13.5, 23, 37);

  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.moveTo(x, y - 9);
  ctx.lineTo(x + 5.5, y + 6);
  ctx.lineTo(x, y + 2);
  ctx.lineTo(x - 5.5, y + 6);
  ctx.closePath();
  ctx.fill();

  ctx.font = "900 11px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("N", x, y + 20);
  ctx.textAlign = "left";
}

// ---------------------------------------------------------------------------

function drawCoastline(ctx: CanvasRenderingContext2D, bundle: Bundle, view: View): void {
  if (bundle.coastline === null) return;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = "round";
  for (const part of bundle.coastline.parts) {
    ctx.beginPath();
    for (let i = 0; i < part.length; i += 2) {
      const x = toScreenX(view, part[i]!);
      const y = toScreenY(view, part[i + 1]!);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

function fillKind(bundle: Bundle, cell: number, hourIndex: number): FillKind {
  const v = verdictForCell(bundle, cell, hourIndex);
  return v.level;
}

function drawCells(
  ctx: CanvasRenderingContext2D, bundle: Bundle, view: View, opts: DrawOptions,
): void {
  const rings = bundle.cellRings;
  if (rings === null) return;

  // Grouped by fill so the pattern is set a handful of times rather than once
  // per cell. Setting fillStyle to a pattern is the expensive call here.
  const groups: Record<FillKind, number[]> = {
    danger: [], caution: [], safe: [], nodata: [],
  };
  for (let c = 0; c < bundle.nCells; c++) {
    groups[fillKind(bundle, c, opts.hourIndex)].push(c);
  }

  const path = (c: number): void => {
    const base = c * RING_VERTICES * 2;
    ctx.beginPath();
    for (let v = 0; v < RING_VERTICES; v++) {
      const x = toScreenX(view, rings[base + v * 2]!);
      const y = toScreenY(view, rings[base + v * 2 + 1]!);
      if (v === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  };

  if (!opts.fast) {
    for (const kind of ["safe", "caution", "nodata", "danger"] as FillKind[]) {
      const cells = groups[kind];
      if (cells.length === 0) continue;
      ctx.fillStyle = fillFor(patterns!, kind);
      for (const c of cells) {
        path(c);
        ctx.fill();
      }
    }
  }

  // Outlines always, so the grid is visible even where a cell is safe and
  // therefore blank, and so the resolution of the forecast is never hidden.
  ctx.strokeStyle = INK;
  ctx.lineWidth = 0.6;
  for (let c = 0; c < bundle.nCells; c++) {
    path(c);
    ctx.stroke();
  }
}

function drawBoundaries(ctx: CanvasRenderingContext2D, bundle: Bundle, view: View): void {
  for (const zone of bundle.zones) {
    // The baseline is a construction line, not a limit anyone can cross, and
    // drawing it as heavily as the maritime boundary would misrepresent it.
    const heavy = zone.zoneType === "imbl" || zone.zoneType === "mpa";
    ctx.lineWidth = heavy ? 4 : 1.6;
    ctx.strokeStyle = INK;
    ctx.setLineDash(zone.zoneType === "mpa" ? [10, 5] : []);
    for (const part of zone.parts) {
      ctx.beginPath();
      for (let i = 0; i < part.length; i += 2) {
        const x = toScreenX(view, part[i]!);
        const y = toScreenY(view, part[i + 1]!);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);
}

/**
 * Landing centres.
 *
 * 602 identical black squares at every zoom was noise, not information: at the
 * whole-region fit they merged into a dotted line along the coast that carried
 * no meaning and competed with the hazard patterns for attention. They appear
 * once the view is close enough for them to be individually tellable apart.
 * The selected one is always drawn, at any zoom, because it is the answer to
 * the question on screen.
 */
const PLACES_VISIBLE_ABOVE = 900; // roughly a 120 km span across a phone

function drawPlaces(
  ctx: CanvasRenderingContext2D, bundle: Bundle, view: View, selected: Place | null,
): void {
  if (view.scale >= PLACES_VISIBLE_ABOVE) {
    ctx.fillStyle = INK;
    for (const place of bundle.places) {
      const x = toScreenX(view, place.lon);
      const y = toScreenY(view, place.lat);
      if (x < -8 || y < -8 || x > view.width + 8 || y > view.height + 8) continue;
      ctx.fillRect(x - 2.5, y - 2.5, 5, 5);
    }
  }

  if (selected === null) return;
  const x = toScreenX(view, selected.lon);
  const y = toScreenY(view, selected.lat);
  // Filled square inside a ring: readable as "this one" without colour, and
  // distinguishable from the GPS cross below.
  ctx.fillStyle = INK;
  ctx.fillRect(x - 5, y - 5, 10, 10);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(x, y, 13, 0, Math.PI * 2);
  ctx.stroke();
}

function drawMarker(ctx: CanvasRenderingContext2D, view: View, marker: Marker): void {
  const x = toScreenX(view, marker.lon);
  const y = toScreenY(view, marker.lat);

  // The accuracy circle is not decoration. A bare dot claims a precision
  // consumer GPS does not have, on a map used to judge how close a boat is to
  // a line it must not cross.
  const metresPerDegLat = 111132.95;
  const radiusPx = (marker.accuracyM / metresPerDegLat) * view.scale;
  if (radiusPx > 4) {
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.arc(x, y, radiusPx, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Solid black dot inside a white ring. The white ring is what keeps it
  // visible on top of a dense danger hatch, where a plain black dot would
  // disappear into the pattern.
  ctx.beginPath();
  ctx.arc(x, y, 9, 0, Math.PI * 2);
  ctx.fillStyle = PAPER;
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(x, y, 5.5, 0, Math.PI * 2);
  ctx.fillStyle = INK;
  ctx.fill();
}

// ---------------------------------------------------------------------------
// furniture
// ---------------------------------------------------------------------------

function panel(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
): void {
  ctx.fillStyle = PAPER;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 3;
  ctx.strokeRect(x + 1.5, y + 1.5, w - 3, h - 3);
}

/**
 * The advisory note stays on the map, with the lines it describes.
 *
 * ORCA's rule, inherited: a boundary is never presented without saying what it
 * is. These are open data, not Survey of India definitions, and this map draws
 * them as thick black lines that otherwise look authoritative. One line in the
 * top-left corner, which is empty water at any useful zoom.
 */
/**
 * A key for the marks the legend strip does not cover.
 *
 * The strip under the map explains the four hazard fills. It says nothing
 * about the lines, and this map draws two kinds that look authoritative: a
 * heavy one for the maritime boundary and a dashed one for a protected area.
 * A reader who cannot tell them apart is being shown a boundary without being
 * told what it is, which is the one thing ORCA's rules forbid.
 */
function drawKey(ctx: CanvasRenderingContext2D, bundle: Bundle): void {
  const rows: Array<[string, "heavy" | "dashed" | "land"]> = [
    ["maritime boundary", "heavy"],
    ["protected area", "dashed"],
    ["land", "land"],
  ];
  ctx.font = "700 10px system-ui, sans-serif";
  const textW = Math.max(...rows.map(([t]) => ctx.measureText(t).width));
  const w = textW + 40;
  const h = rows.length * 14 + 20;

  ctx.fillStyle = PAPER;
  ctx.fillRect(6, 6, w, h);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1;
  ctx.strokeRect(6.5, 6.5, w - 1, h - 1);

  rows.forEach(([label, kind], i) => {
    const y = 20 + i * 14;
    if (kind === "land") {
      ctx.fillStyle = TINT_LAND;
      ctx.fillRect(12, y - 7, 20, 9);
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1;
      ctx.strokeRect(12.5, y - 6.5, 19, 8);
    } else {
      ctx.strokeStyle = INK;
      ctx.lineWidth = kind === "heavy" ? 3.5 : 1.6;
      ctx.setLineDash(kind === "dashed" ? [6, 4] : []);
      ctx.beginPath();
      ctx.moveTo(12, y - 3);
      ctx.lineTo(32, y - 3);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = INK;
    ctx.fillText(label, 38, y);
  });

  if (bundle.meta.boundaries_advisory_only) {
    ctx.fillStyle = INK;
    ctx.font = "700 9px system-ui, sans-serif";
    ctx.fillText("open data, advisory only", 12, h - 1);
  }
}

function drawScaleBar(ctx: CanvasRenderingContext2D, view: View): void {
  const bar = scaleBar(view, Math.min(150, view.width * 0.35));
  const h = 34;
  const w = bar.px + 24;
  const x = view.width - w - 10;
  const y = view.height - h - 10;

  panel(ctx, x, y, w, h);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x + 12, y + 22);
  ctx.lineTo(x + 12 + bar.px, y + 22);
  ctx.moveTo(x + 12, y + 16);
  ctx.lineTo(x + 12, y + 26);
  ctx.moveTo(x + 12 + bar.px, y + 16);
  ctx.lineTo(x + 12 + bar.px, y + 26);
  ctx.stroke();

  ctx.fillStyle = INK;
  ctx.font = "700 12px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(bar.label, x + 12 + bar.px / 2, y + 13);
  ctx.textAlign = "left";
}

/*
 * There is no legend drawn here any more. It lives in the DOM, in a strip
 * under the map, because these cells are told apart by pattern alone and a key
 * painted on top of them covers the water nearest the coast, which is exactly
 * where someone is looking. See .legend in src/ui/style.css, which repeats the
 * same four marks in CSS.
 *
 * The scale bar stays: it measures the map rather than competing with it, and
 * without it a field of shaded hexagons reads as far more precise than 8.5 km
 * across.
 */
