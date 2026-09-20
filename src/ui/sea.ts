/**
 * SEA MODE: getting a boat back to a harbour.
 *
 * A sibling of the escape screen and built the same way: one full-screen
 * layer, one decision at the top, everything else below it. The decision here
 * is a heading, and the thing that can override it is the India-Sri Lanka
 * line, so the boundary alarm sits ABOVE the heading and cannot be scrolled
 * away from it.
 *
 * FULLY OFFLINE, AND NOTHING NEW WAS DOWNLOADED FOR IT. The 602 landing
 * places and the four IMBL lines were already in the bundle; the land mask was
 * already precached for the escape screen. See src/compute/sea.ts.
 *
 * WHAT IT IS NOT. There is no bathymetry anywhere in this project, so nothing
 * here knows about depth, bars, reefs or traffic. The route avoids the shore
 * and the boundary and nothing else, and the screen says so.
 */

import type { Bundle } from "../bundle/types.ts";
import type { Land } from "../geo/land.ts";
import type { Position } from "../geo/position.ts";
import { TINT_LAND } from "../constants.ts";
import { formatKm } from "../compute/format.ts";
import { compassWords } from "../compute/geo.ts";
import type { Tides } from "../compute/tide.ts";
import { renderTide } from "./tide.ts";
import { arrowRotation, startHeading, stopHeading } from "../escape/heading.ts";
import {
  DEFAULT_BOAT_SPEED_KN,
  crossesImbl,
  crossesLand,
  imblProximity,
  knotsToMs,
  nearestHarbours,
  nextWaypoint,
  routeThroughWater,
  type HarbourOption,
  type ImblProximity,
  type SeaRoute,
} from "../compute/sea.ts";
import {
  fitTo,
  makeView,
  scaleBar,
  toLat,
  toLon,
  toScreenX,
  toScreenY,
  type View,
} from "../map/projection.ts";

const INK = "#000";
const PAPER = "#fff";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`missing element #${id}`);
  return node as T;
}

interface State {
  bundle: Bundle | null;
  land: Land | null;
  position: Position | null;
  manual: boolean;
  speedKn: number;
  options: HarbourOption[];
  target: number;
  route: SeaRoute | null;
  /** Null when the straight line was fine; set when a search failed. */
  routeFailed: SeaRoute["reason"] | null;
  imbl: ImblProximity | null;
  headingDeg: number | null;
  tides: Tides | null;
  open: boolean;
}

const state: State = {
  bundle: null,
  land: null,
  position: null,
  manual: false,
  speedKn: DEFAULT_BOAT_SPEED_KN,
  options: [],
  target: 0,
  route: null,
  routeFailed: null,
  imbl: null,
  headingDeg: null,
  tides: null,
  open: false,
};

let restoreScrollY = 0;
let pushedHistory = false;

export function setSeaData(bundle: Bundle | null, land: Land | null): void {
  state.bundle = bundle;
  state.land = land;
  if (state.open) render();
}

export function setSeaPosition(position: Position | null): void {
  state.position = position;
  if (position !== null) state.manual = false;
  if (state.open) render();
}

export function setSeaTides(tides: Tides | null): void {
  state.tides = tides;
  if (state.open) drawTide();
}

function drawTide(): void {
  const pos = state.position;
  renderTide(
    el("seaTide"), state.tides,
    pos === null ? null : pos.lat, pos === null ? null : pos.lon,
    Date.now(),
  );
}

export function isSeaOpen(): boolean {
  return state.open;
}

// ---------------------------------------------------------------------------
// open and close
// ---------------------------------------------------------------------------

export async function openSea(): Promise<void> {
  // As on the escape screen: everything that can throw comes AFTER the overlay
  // is visible and the way back is recorded, so CLOSE always works.
  restoreScrollY = window.scrollY;
  state.open = true;
  state.target = 0;
  el("sea").hidden = false;
  document.body.classList.add("body--escape");

  try {
    history.pushState({ orcaSea: true }, "");
    pushedHistory = true;
  } catch {
    pushedHistory = false;
  }

  try {
    render();
  } catch (err) {
    console.error("[orca] sea render failed:", err);
  }

  try {
    const outcome = await startHeading((deg) => {
      state.headingDeg = deg;
      if (state.open) {
        try {
          drawArrow();
        } catch { /* a bad reading must not spam every compass event */ }
      }
    });
    if (outcome.kind !== "ok") state.headingDeg = null;
    el("seaCompass").textContent = outcome.kind === "ok"
      ? "Arrow follows your boat's phone. Hold it flat."
      : "NORTH IS UP. No compass on this device, so the arrow is a chart bearing.";
  } catch (err) {
    console.warn("[orca] compass unavailable:", err);
    state.headingDeg = null;
  }
}

export function closeSea(): void {
  state.open = false;
  state.headingDeg = null;
  try {
    stopHeading();
  } catch (err) {
    console.warn("[orca] stopHeading failed:", err);
  }
  el("sea").hidden = true;
  document.body.classList.remove("body--escape");
  window.scrollTo(0, restoreScrollY);
  if (pushedHistory) {
    pushedHistory = false;
    try {
      history.back();
    } catch { /* already hidden, which is what mattered */ }
  }
}

window.addEventListener("popstate", () => {
  if (!state.open) return;
  pushedHistory = false;
  closeSea();
});

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

export function render(): void {
  if (!state.open) return;
  const bundle = state.bundle;
  const pos = state.position;

  const status = el("seaStatus");
  if (pos === null) {
    status.className = "escape__status escape__status--warn";
    status.textContent = "No position yet. Pick a place by hand below, or allow location.";
  } else if (state.manual) {
    status.className = "escape__status escape__status--warn";
    status.textContent =
      "MANUAL POSITION, not a GPS fix. Every bearing below is measured from " +
      "the point you picked.";
  } else {
    status.className = "escape__status";
    status.textContent =
      `Position: GPS, accurate to about ${Math.round(pos.accuracyM)} m. ` +
      `Works without internet.`;
  }

  state.options = bundle === null || pos === null
    ? []
    : nearestHarbours(bundle, pos.lat, pos.lon, 3, knotsToMs(state.speedKn));
  if (state.target >= state.options.length) state.target = 0;

  state.imbl = bundle === null || pos === null
    ? null
    : imblProximity(bundle, pos.lat, pos.lon);

  computeRoute();
  renderImbl();
  renderTarget();
  renderList();
  drawArrow();
  drawMap();
  drawTide();
}

/**
 * Work out the track to the chosen harbour.
 *
 * Only for the CHOSEN one. The grid search costs tens of milliseconds when it
 * succeeds and over a second when it has to widen the box and still fail, and
 * doing that three times over for harbours nobody selected would freeze the
 * screen for no reason.
 */
function computeRoute(): void {
  state.route = null;
  state.routeFailed = null;

  const bundle = state.bundle;
  const pos = state.position;
  const chosen = state.options[state.target];
  if (bundle === null || pos === null || chosen === undefined) return;

  const overLand = crossesLand(state.land, pos.lat, pos.lon, chosen.place.lat, chosen.place.lon);
  const overLine = crossesImbl(bundle, pos.lat, pos.lon, chosen.place.lat, chosen.place.lon);
  if (!overLand && !overLine) return;

  const found = routeThroughWater(
    bundle, state.land, [pos.lat, pos.lon], [chosen.place.lat, chosen.place.lon],
    overLand && overLine ? "both" : overLand ? "land" : "imbl",
  );
  const why: SeaRoute["reason"] = overLand && overLine ? "both" : overLand ? "land" : "imbl";
  if (found === null) state.routeFailed = why;
  else state.route = found;
}

/** The boundary alarm, above the heading and never scrollable away from it. */
function renderImbl(): void {
  const box = el("seaImbl");
  const imbl = state.imbl;

  if (imbl === null || imbl.level === "clear") {
    box.hidden = true;
    box.className = "sea__imbl";
    return;
  }

  box.hidden = false;
  box.className = imbl.level === "danger" ? "sea__imbl sea__imbl--danger" : "sea__imbl";
  box.textContent = imbl.level === "danger"
    ? `TURN BACK NOW — you are ${imbl.effectiveNm.toFixed(1)} NM from the ` +
      `${imbl.name} boundary, bearing ${Math.round(imbl.bearingDeg)}° ${imbl.compass}. ` +
      `Advisory line, not a legal boundary.`
    : `BOUNDARY ${imbl.effectiveNm.toFixed(1)} NM ${imbl.compass} — ` +
      `${imbl.name}. Advisory line, not a legal boundary.`;

  // A phone in a wet pocket is not being looked at. Vibration is the only
  // channel left, and it is a nicety: not every browser has it, and none of
  // the words above depend on it.
  if (imbl.level === "danger" && typeof navigator.vibrate === "function") {
    try {
      navigator.vibrate([400, 200, 400]);
    } catch { /* refused or unsupported; the banner still says it */ }
  }
}

function renderTarget(): void {
  const chosen = state.options[state.target];
  const steer = el("seaSteer");
  const name = el("seaTargetName");
  const detail = el("seaDetail");
  const route = el("seaRoute");

  if (chosen === undefined) {
    steer.textContent = state.bundle === null ? "NO BUNDLE ON THIS DEVICE" : "";
    name.textContent = "";
    detail.textContent = "";
    route.hidden = true;
    return;
  }

  const pos = state.position!;
  const bearing = steerBearing(chosen);

  // AT OR OVER THE LINE, THE HARBOUR IS NOT THE INSTRUCTION.
  //
  // The banner above says TURN BACK NOW. Without this the heading underneath
  // it pointed at the nearest harbour, which from over the boundary can be
  // straight along it or further across -- two contradictory instructions on
  // one screen, in the one situation where there is no time to work out which
  // to believe. Getting off the line comes first; the harbour is still listed
  // below and comes back the moment there is sea room.
  steer.textContent = state.imbl?.level === "danger"
    ? `TURN ${compassWords(bearing)}`
    : `STEER ${compassWords(bearing)}`;
  name.textContent = `${chosen.place.name} · ${chosen.place.type.replace(/_/g, " ")}`;

  const hours = Math.floor(chosen.seconds / 3600);
  const mins = Math.round((chosen.seconds % 3600) / 60);
  detail.textContent =
    `${Math.round(bearing)}° · ${formatKm(chosen.distanceM)} / ` +
    `${chosen.distanceNm.toFixed(1)} NM · about ${hours} h ${mins} min at ` +
    `${state.speedKn} kn`;

  route.hidden = false;
  if (state.imbl?.level === "danger") {
    route.textContent =
      `Get clear of the boundary first. ${chosen.place.name} is ` +
      `${formatKm(chosen.distanceM)} away on ${Math.round(chosen.bearingDeg)}°, ` +
      `and that heading is not safe to take until you have sea room.`;
  } else if (state.route !== null) {
    const extra = ((state.route.distanceM / chosen.distanceM - 1) * 100).toFixed(0);
    route.textContent =
      `Track goes around ${state.route.reason === "imbl" ? "the boundary" : "land"}: ` +
      `${formatKm(state.route.distanceM)} instead of ${formatKm(chosen.distanceM)} ` +
      `(+${extra}%). Steer for the next mark, not for the harbour.`;
  } else if (state.routeFailed !== null) {
    const what = state.routeFailed === "imbl"
      ? "the boundary"
      : state.routeFailed === "both" ? "land and the boundary" : "land";
    route.textContent =
      `The straight line crosses ${what}, and no way round was found on a ` +
      `500 m grid. A channel narrower than that cannot be seen here. Use your ` +
      `own knowledge of the water.`;
  } else {
    route.textContent = "Straight line: no land or boundary in the way.";
  }
}

/**
 * The heading to show, in one place so the arrow and the words cannot differ.
 *
 * Away from the boundary when over it, then along the track when there is one,
 * then straight at the harbour.
 */
function steerBearing(chosen: HarbourOption): number {
  const pos = state.position!;
  const imbl = state.imbl;
  if (imbl !== null && imbl.level === "danger") {
    // The reciprocal of the bearing TO the line: straight back off it.
    return (imbl.bearingDeg + 180) % 360;
  }
  const wp = state.route === null ? null : nextWaypoint(state.route, pos.lat, pos.lon);
  return wp === null ? chosen.bearingDeg : bearingTo(pos.lat, pos.lon, wp[0], wp[1]);
}

function bearingTo(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const DEG = Math.PI / 180;
  const p1 = aLat * DEG;
  const p2 = bLat * DEG;
  const dl = (bLon - aLon) * DEG;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) / DEG) + 360) % 360;
}

function renderList(): void {
  const list = el("seaList");
  list.replaceChildren();
  if (state.options.length === 0) return;

  state.options.forEach((option, index) => {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = index === state.target ? "safeplace safeplace--on" : "safeplace";
    button.addEventListener("click", () => {
      state.target = index;
      computeRoute();
      renderTarget();
      renderList();
      drawArrow();
      drawMap();
    });

    const name = document.createElement("span");
    name.className = "safeplace__name";
    name.textContent = option.place.name;

    const meta = document.createElement("span");
    meta.className = "safeplace__meta";
    const hours = Math.floor(option.seconds / 3600);
    const mins = Math.round((option.seconds % 3600) / 60);
    meta.textContent =
      `${option.place.type.replace(/_/g, " ")} · ${formatKm(option.distanceM)} / ` +
      `${option.distanceNm.toFixed(1)} NM · ${Math.round(option.bearingDeg)}° ` +
      `${option.compass} · ${hours} h ${mins} min`;

    button.append(name, meta);
    li.append(button);
    list.append(li);
  });
}

function drawArrow(): void {
  const arrow = el("seaArrowMark");
  const chosen = state.options[state.target];
  if (chosen === undefined || state.position === null) {
    arrow.setAttribute("hidden", "");
    return;
  }
  arrow.removeAttribute("hidden");
  arrow.style.transform =
    `rotate(${arrowRotation(steerBearing(chosen), state.headingDeg).toFixed(1)}deg)`;
}

// ---------------------------------------------------------------------------
// speed, SOS and the manual fallback
// ---------------------------------------------------------------------------

export function setSpeedKn(kn: number): void {
  if (!Number.isFinite(kn) || kn <= 0) return;
  state.speedKn = Math.min(30, Math.max(1, kn));
  if (state.open) render();
}

export function useSeaManualOrigin(lat: number, lon: number): void {
  state.position = { lat, lon, accuracyM: 0, at: Date.now() };
  state.manual = true;
  state.target = 0;
  render();
}

/** Degrees and decimal minutes, which is the format read aloud on VHF. */
export function degreesMinutes(lat: number, lon: number): string {
  const fmt = (v: number, pos: string, neg: string) => {
    const hemi = v >= 0 ? pos : neg;
    const abs = Math.abs(v);
    const deg = Math.floor(abs);
    const min = (abs - deg) * 60;
    return `${String(deg).padStart(2, "0")}° ${min.toFixed(1)}' ${hemi}`;
  };
  return `${fmt(lat, "N", "S")}  ${fmt(lon, "E", "W")}`;
}

/** The SMS body. Plain text, no link, so it survives any phone. */
export function sosText(): string {
  const pos = state.position;
  if (pos === null) return "SOS. Position unknown.";
  return `SOS. Fishing boat needs help. Position ${degreesMinutes(pos.lat, pos.lon)} ` +
    `(${pos.lat.toFixed(5)}, ${pos.lon.toFixed(5)}). Time ${new Date(pos.at).toISOString()}.`;
}

export function refreshSos(): void {
  const link = el<HTMLAnchorElement>("seaSosSms");
  const where = el("seaSosPos");
  const pos = state.position;
  if (pos === null) {
    link.hidden = true;
    where.textContent = "No position to send yet.";
    return;
  }
  link.hidden = false;
  link.href = `sms:?&body=${encodeURIComponent(sosText())}`;
  where.textContent = degreesMinutes(pos.lat, pos.lon);
}

// ---------------------------------------------------------------------------
// the chart
// ---------------------------------------------------------------------------

function drawMap(): void {
  const canvas = el<HTMLCanvasElement>("seaMap");
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;

  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(rect.width * ratio);
  canvas.height = Math.round(rect.height * ratio);
  const ctx = canvas.getContext("2d");
  if (ctx === null) return;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, rect.width, rect.height);

  const pos = state.position;
  const bundle = state.bundle;
  const chosen = state.options[state.target];
  if (pos === null || bundle === null || chosen === undefined) {
    ctx.fillStyle = INK;
    ctx.font = "800 13px system-ui, sans-serif";
    ctx.fillText("The chart appears once there is a position.", 12, 26);
    return;
  }

  // Frame the boat, the harbour and the whole track.
  let west = Math.min(pos.lon, chosen.place.lon);
  let east = Math.max(pos.lon, chosen.place.lon);
  let south = Math.min(pos.lat, chosen.place.lat);
  let north = Math.max(pos.lat, chosen.place.lat);
  if (state.route !== null) {
    for (const [la, lo] of state.route.points) {
      west = Math.min(west, lo);
      east = Math.max(east, lo);
      south = Math.min(south, la);
      north = Math.max(north, la);
    }
  }
  const pad = 0.2 * Math.max(east - west, north - south, 0.02);
  const box: [number, number, number, number] =
    [west - pad, south - pad, east + pad, north + pad];
  const view: View = fitTo(makeView(box, rect.width, rect.height), box);

  drawLand(ctx, view, rect);
  drawCoast(ctx, bundle, view);
  drawImblLines(ctx, bundle, view);
  drawTrack(ctx, view, pos, chosen);
  drawBoat(ctx, view, pos);
  drawScale(ctx, view);
}

function drawLand(
  ctx: CanvasRenderingContext2D, view: View, rect: { width: number; height: number },
): void {
  const land = state.land;
  if (land === null) return;
  const west = toLon(view, 0);
  const east = toLon(view, rect.width);
  const north = toLat(view, 0);
  const south = toLat(view, rect.height);

  ctx.beginPath();
  let drew = false;
  for (let r = 0; r < land.ringCount; r++) {
    const b = r * 4;
    if (land.ringBox[b + 2]! < west || land.ringBox[b]! > east ||
        land.ringBox[b + 3]! < south || land.ringBox[b + 1]! > north) continue;
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

function drawCoast(ctx: CanvasRenderingContext2D, bundle: Bundle, view: View): void {
  if (bundle.coastline === null) return;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
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

/** The boundary, drawn heavy because it is the line that gets a boat seized. */
function drawImblLines(ctx: CanvasRenderingContext2D, bundle: Bundle, view: View): void {
  ctx.strokeStyle = INK;
  ctx.lineWidth = 4;
  for (const zone of bundle.zones) {
    if (zone.zoneType !== "imbl") continue;
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
}

function drawTrack(
  ctx: CanvasRenderingContext2D, view: View, pos: Position, chosen: HarbourOption,
): void {
  ctx.strokeStyle = INK;
  ctx.lineWidth = 3;
  ctx.setLineDash([9, 5]);
  ctx.beginPath();
  if (state.route !== null) {
    state.route.points.forEach(([la, lo], i) => {
      const x = toScreenX(view, lo);
      const y = toScreenY(view, la);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
  } else {
    ctx.moveTo(toScreenX(view, pos.lon), toScreenY(view, pos.lat));
    ctx.lineTo(toScreenX(view, chosen.place.lon), toScreenY(view, chosen.place.lat));
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // The harbour: a filled square in a heavy ring, tellable from the boat by
  // shape alone, which is the rule the rest of this interface follows.
  const hx = toScreenX(view, chosen.place.lon);
  const hy = toScreenY(view, chosen.place.lat);
  ctx.fillStyle = INK;
  ctx.fillRect(hx - 6, hy - 6, 12, 12);
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(hx, hy, 15, 0, Math.PI * 2);
  ctx.stroke();
}

function drawBoat(ctx: CanvasRenderingContext2D, view: View, pos: Position): void {
  const x = toScreenX(view, pos.lon);
  const y = toScreenY(view, pos.lat);
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

function drawScale(ctx: CanvasRenderingContext2D, view: View): void {
  const bar = scaleBar(view, Math.min(120, view.width * 0.35));
  const h = 28;
  const w = bar.px + 24;
  const x = 10;
  const y = view.height - h - 10;
  ctx.fillStyle = PAPER;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x + 12, y + 19);
  ctx.lineTo(x + 12 + bar.px, y + 19);
  ctx.stroke();
  ctx.fillStyle = INK;
  ctx.font = "800 11px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(bar.label, x + 12 + bar.px / 2, y + 12);
  ctx.textAlign = "left";
}
