/**
 * The escape screen: where to go, and which way that is.
 *
 * One screen, one decision, and the decision is a direction. Everything above
 * the fold is the arrow and the name of the place it points at; the list, the
 * map and the provenance sit below it in that order of urgency.
 *
 * IT ALL WORKS IN AIRPLANE MODE. The safe places are a precached file, the
 * coastline comes out of the bundle in IndexedDB, and the position comes from
 * GPS, which needs no network. Nothing in this module fetches anything at the
 * moment it is used.
 *
 * WHAT IT DOES NOT DO. It does not route. There is no road graph on the device
 * and inventing one would be worse than admitting its absence, so the arrow is
 * a straight-line bearing and the screen says so in a line that cannot be
 * scrolled away from the arrow.
 */

import type { Bundle } from "../bundle/types.ts";
import type { Position } from "../geo/position.ts";
import type { Land } from "../geo/land.ts";
import { formatKm } from "../compute/format.ts";
import { TINT_LAND } from "../constants.ts";
import { compass, compassWords } from "../compute/geo.ts";
import { arrowRotation, startHeading, stopHeading } from "../escape/heading.ts";
import {
  nearestSafePlaces,
  typeLabel,
  walkTime,
  type RankedPlace,
  type SafePlace,
  type SafePlaces,
} from "../escape/places.ts";
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
  /** Shaded, so the water between you and a shelter is visible. */
  land: Land | null;
  safe: SafePlaces | null;
  /** The list actually in use, whichever source it came from. */
  places: SafePlace[];
  sourceLine: string;
  position: Position | null;
  ranked: RankedPlace[];
  /** Index into `ranked` of the place the arrow points at. */
  target: number;
  headingDeg: number | null;
  open: boolean;
  /** Why there is no fix, so the screen can say something useful instead of nothing. */
  geo: "idle" | "searching" | "denied" | "timeout" | "unavailable" | "manual";
}

const state: State = {
  bundle: null,
  land: null,
  safe: null,
  places: [],
  sourceLine: "",
  position: null,
  ranked: [],
  target: 0,
  headingDeg: null,
  open: false,
  geo: "searching",
};

/** Where the page was scrolled before the overlay took over. */
let restoreScrollY = 0;
let restoreRestScroll = 0;
/** True when this screen pushed a history entry, so back can close it. */
let pushedHistory = false;

export function setEscapeGeoStatus(
  geo: "idle" | "searching" | "denied" | "timeout" | "unavailable" | "manual",
): void {
  state.geo = geo;
  if (state.open) render();
}

/**
 * Hand the screen its data. Called whenever a bundle or the place list lands,
 * which may be before or after the user has opened it.
 */
export function setEscapeData(bundle: Bundle | null, safe: SafePlaces | null): void {
  state.bundle = bundle;
  state.safe = safe;

  if (safe !== null && safe.places.length > 0) {
    state.places = safe.places;
    state.sourceLine =
      `${safe.places.length.toLocaleString()} places within ${safe.coastFilterKm} km ` +
      `of the coast. ${safe.attribution}` +
      (safe.elevationAttribution === null ? "" : ` ${safe.elevationAttribution}`) +
      ` Sorted by distance, never by height: on flat coastal ground the height ` +
      `error is larger than the spread between these places.`;
  } else if (bundle !== null) {
    // The bundle's landing centres are real, named, coastal places that are
    // already on the device. A worse list than the OSM one, and far better
    // than an empty screen.
    state.places = bundle.places.map((p) => ({
      type: p.type,
      lat: p.lat,
      lon: p.lon,
      elevationM: null,
      name: p.name,
      osmId: p.id,
    }));
    state.sourceLine =
      `Safe-place list unavailable, so this is showing the ${bundle.places.length} ` +
      `landing centres from the forecast bundle instead. These are harbours, ` +
      `not designated shelters.`;
  } else {
    state.places = [];
    state.sourceLine = "No place list on this device.";
  }
  if (state.open) render();
}

/**
 * Give the escape map the land mask.
 *
 * This is the closest thing to the water-crossing check the screen does not
 * have. It cannot tell you the straight line crosses a lagoon, but it can draw
 * the lagoon, and a reader who can see a backwater between themselves and a
 * school will not walk into it. Natural Earth 1:10m carries the big water --
 * Vembanad, Ashtamudi, Pulicat -- and not a thirty metre creek, so this helps
 * with the obstacles you can see coming and not with the ones you cannot.
 */
export function setEscapeLand(land: Land | null): void {
  state.land = land;
  if (state.open) drawMap();
}

export function setEscapePosition(position: Position | null): void {
  state.position = position;
  // A real fix supersedes a hand-picked one, and the label has to follow it or
  // the screen keeps calling a GPS position "manual".
  if (position !== null && state.geo === "manual") state.geo = "idle";
  if (state.open) render();
}

// ---------------------------------------------------------------------------
// open and close
// ---------------------------------------------------------------------------

/**
 * `open` must be called from a tap.
 *
 * iOS only grants the compass from inside a user gesture, so the permission
 * request rides on the button that opens the screen. Asking later, from a
 * timer or a position update, silently fails.
 */
export async function openEscape(): Promise<void> {
  // Nothing above this line may be able to throw. Showing the overlay and
  // remembering where we came from happens FIRST, so that however badly the
  // GPS, the compass or the canvas behave below, the screen is in a state the
  // CLOSE button can undo.
  restoreScrollY = window.scrollY;
  const rest = document.getElementById("rest");
  restoreRestScroll = rest === null ? 0 : rest.scrollTop;

  state.open = true;
  state.target = 0;
  el("escape").hidden = false;
  document.body.classList.add("body--escape");

  // A history entry, so the Android back button and the browser back arrow
  // close this the way every other full-screen thing on a phone closes.
  try {
    history.pushState({ orcaEscape: true }, "");
    pushedHistory = true;
  } catch {
    pushedHistory = false;
  }

  try {
    render();
  } catch (err) {
    console.error("[orca] escape render failed:", err);
  }

  // The compass is a nicety and it is the most likely thing here to fail:
  // Safari on a desktop has no DeviceOrientationEvent worth the name, iOS
  // throws if the call did not come from a gesture, and a denied permission
  // is normal. None of that may take the screen down with it.
  try {
    const outcome = await startHeading((deg) => {
      state.headingDeg = deg;
      if (state.open) {
        try {
          drawArrow();
        } catch {
          // A bad reading must not spam the console on every compass event.
        }
      }
    });
    if (outcome.kind !== "ok") state.headingDeg = null;
    renderCompassNote(outcome.kind);
  } catch (err) {
    console.warn("[orca] compass unavailable:", err);
    state.headingDeg = null;
    try {
      renderCompassNote("unavailable");
    } catch { /* nothing left worth reporting */ }
  }
}

export function closeEscape(): void {
  state.open = false;
  state.headingDeg = null;

  // Every listener this screen started, stopped. A compass left running after
  // the screen is gone is pure battery drain, and this app is used by people
  // who may need the phone for hours.
  try {
    stopHeading();
  } catch (err) {
    console.warn("[orca] stopHeading failed:", err);
  }

  el("escape").hidden = true;
  document.body.classList.remove("body--escape");

  // Put the page back exactly where it was, including the scroll position of
  // the region that actually scrolls.
  window.scrollTo(0, restoreScrollY);
  const rest = document.getElementById("rest");
  if (rest !== null) rest.scrollTop = restoreRestScroll;

  if (pushedHistory) {
    pushedHistory = false;
    try {
      history.back();
    } catch { /* the overlay is already hidden, which is what mattered */ }
  }
}

// Back button and the hardware back gesture. Registered once, at module load,
// so it is in place before anything can open the screen.
window.addEventListener("popstate", () => {
  if (!state.open) return;
  // The entry is already gone, so closeEscape must not pop a second time.
  pushedHistory = false;
  closeEscape();
});

export function isEscapeOpen(): boolean {
  return state.open;
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

/**
 * THIS SCREEN IS NEVER BLANK.
 *
 * Every state below writes something: waiting, refused, no list, nothing
 * nearby. A blank escape screen during an evacuation is indistinguishable from
 * a crashed one, and the user cannot tell which it is.
 */
export function render(): void {
  if (!state.open) return;

  const pos = state.position;
  const manual = el<HTMLDetailsElement>("escapeManual");

  state.ranked = pos === null || state.places.length === 0
    ? []
    : nearestSafePlaces(state.places, pos.lat, pos.lon, 3);
  if (state.target >= state.ranked.length) state.target = 0;

  renderStatus(pos, manual);
  renderTarget();
  renderList();
  drawArrow();
  drawMap();

  el("escapeSource").textContent = state.sourceLine;
}

function renderStatus(pos: Position | null, manual: HTMLDetailsElement): void {
  const status = el("escapeStatus");
  status.hidden = false;

  if (pos !== null) {
    if (state.geo === "manual") {
      status.className = "escape__status escape__status--warn";
      status.textContent =
        "MANUAL POSITION, not a GPS fix. Directions are measured from the " +
        "place you picked, not from where you are.";
    } else {
      status.className = "escape__status";
      status.textContent =
        `Location: GPS, accurate to about ${Math.round(pos.accuracyM)} m. ` +
        `Works without internet.`;
    }
    return;
  }

  // No position. Say WHY, and open the way out of it.
  status.className = "escape__status escape__status--warn";
  switch (state.geo) {
    case "denied":
      status.textContent =
        "Location is off for this app. Turn it on in your browser settings, " +
        "or pick your place by hand below.";
      manual.open = true;
      break;
    case "timeout":
      status.textContent =
        "No GPS fix yet. Go outside with a clear view of the sky, or pick " +
        "your place by hand below.";
      manual.open = true;
      break;
    case "unavailable":
      status.textContent =
        "This device cannot give a location. Pick your place by hand below.";
      manual.open = true;
      break;
    default:
      status.textContent =
        "Finding your location\u2026 (GPS works without internet)";
      break;
  }
}

function renderTarget(): void {
  const chosen = state.ranked[state.target];
  const go = el("escapeGo");
  const name = el("escapeTargetName");
  const dist = el("escapeDist");

  const gmaps = el<HTMLAnchorElement>("escapeGmaps");
  const gmapsNote = el("escapeGmapsNote");

  if (chosen === undefined) {
    gmaps.hidden = true;
    gmapsNote.hidden = true;
    // No number to show, so no word either: the same rule the verdict follows.
    go.textContent = state.places.length === 0
      ? "NO PLACE LIST ON THIS DEVICE"
      : "";
    name.textContent = state.places.length === 0
      ? "Open this app once with a connection to download one."
      : "";
    dist.textContent = "";
    return;
  }

  // The word and the number together, the same rule the verdict follows. The
  // direction is spelled out and the bearing in degrees sits beside it, so the
  // instruction survives a phone with no compass and a reader who does not use
  // chart abbreviations.
  go.textContent = `GO ${compassWords(chosen.bearingDeg)}`;
  name.textContent =
    (chosen.place.name || `unnamed ${typeLabel(chosen.place.type)}`) +
    ` · ${typeLabel(chosen.place.type)}`;
  // A plain link, built as a string. Nothing here calls a Google API, and no
  // route data of theirs is fetched or stored.
  //
  // DESTINATION ONLY, NEVER AN ORIGIN. Google will use the phone's own
  // location as the start once the app is open, which is between the user and
  // Google. Putting our GPS fix in the URL would mean this app had written a
  // position into a request to a third party, which src/bundle/source.ts goes
  // out of its way to make structurally impossible everywhere else.
  gmaps.href =
    `https://www.google.com/maps/dir/?api=1&destination=` +
    `${chosen.place.lat.toFixed(6)},${chosen.place.lon.toFixed(6)}` +
    `&travelmode=walking`;
  gmaps.hidden = false;
  gmapsNote.hidden = false;

  dist.textContent =
    `${Math.round(chosen.bearingDeg)}° ${chosen.compass} · ` +
    `${formatKm(chosen.distanceM)} · at least ${walkTime(chosen.walkSeconds)} on foot` +
    (chosen.place.elevationM !== null
      ? ` · ground ${chosen.place.elevationM} m above sea level`
      : "");
}

function renderCompassNote(kind: string): void {
  const note = el("escapeCompass");
  if (kind === "ok") {
    note.textContent = "Arrow follows your phone. Hold it flat.";
  } else {
    // Without a compass the arrow is a map bearing, so the map convention has
    // to be stated: north is up. An arrow that means one thing on a phone that
    // knows its heading and another on a phone that does not is worse than no
    // arrow, unless the screen says which one this is.
    note.textContent = "NORTH IS UP. No compass on this device, so the arrow " +
      "is a map bearing, not a point-the-phone arrow.";
  }
}

function renderList(): void {
  const list = el("escapeList");
  list.replaceChildren();
  const note = el("escapeListNote");

  if (state.ranked.length === 0) {
    note.hidden = false;
    note.textContent = state.places.length === 0
      ? "No list of places on this device."
      : "Waiting for a location before the nearest places can be worked out.";
    return;
  }

  // Nothing close by is a real answer and the screen gives it, then lists the
  // far ones anyway: a shelter an hour's walk away is still the best available
  // fact, and hiding it would leave the reader with nothing.
  // Twenty kilometres. Below that a shelter is a long walk but a real option;
  // above it, someone needs to be told plainly that there is nothing near,
  // rather than reading a list that looks like it is offering close by.
  const nearest = state.ranked[0]!.distanceM;
  note.hidden = nearest <= FAR_M;
  if (nearest > FAR_M) {
    note.textContent =
      `Nothing close by. The nearest is ${formatKm(nearest)} away, which is ` +
      `${walkTime(state.ranked[0]!.walkSeconds)} on foot. Shown anyway.`;
  }

  state.ranked.forEach((r, index) => {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className =
      index === state.target ? "safeplace safeplace--on" : "safeplace";
    button.addEventListener("click", () => {
      state.target = index;
      renderTarget();
      renderList();
      drawArrow();
      drawMap();
    });

    const name = document.createElement("span");
    name.className = "safeplace__name";
    name.textContent = r.place.name || `unnamed ${typeLabel(r.place.type)}`;

    const meta = document.createElement("span");
    meta.className = "safeplace__meta";
    meta.textContent =
      `${typeLabel(r.place.type)} · ${formatKm(r.distanceM)} ${r.compass} · ` +
      `${walkTime(r.walkSeconds)}+ walk` +
      (r.place.elevationM !== null ? ` · ${r.place.elevationM} m above sea` : "");

    button.append(name, meta);
    li.append(button);
    list.append(li);
  });
}

// ---------------------------------------------------------------------------
// the arrow
// ---------------------------------------------------------------------------

function drawArrow(): void {
  const arrow = el("escapeArrowMark");
  const chosen = state.ranked[state.target];

  // Hidden, not merely untransformed. An arrow with no target sat pointing
  // straight up, which reads as "go north" and is a direction this app has no
  // basis for giving.
  //
  // setAttribute, not `.hidden = true`. The arrow is an <svg>, and `hidden` is
  // an IDL property of HTMLElement only: assigning it to an SVGElement quietly
  // creates a plain JavaScript property and leaves the element on screen. The
  // global [hidden] rule in style.css is an attribute selector, so it matches
  // either way once the attribute is really there.
  if (chosen === undefined || state.position === null) {
    arrow.setAttribute("hidden", "");
    return;
  }
  arrow.removeAttribute("hidden");
  // A CSS rotation rather than a canvas redraw: one composited transform per
  // compass reading instead of a repaint, which matters when the readings
  // arrive many times a second and the battery has to last the evacuation.
  arrow.style.transform =
    `rotate(${arrowRotation(chosen.bearingDeg, state.headingDeg).toFixed(1)}deg)`;
  el("escapeArrowWrap").className = state.headingDeg === null
    ? "escape__arrowwrap escape__arrowwrap--nocompass"
    : "escape__arrowwrap";
}

// ---------------------------------------------------------------------------
// the map
// ---------------------------------------------------------------------------

/** Half-width of the box the map fits, in degrees. About 5 km at this latitude. */
const MAP_PAD_DEG = 0.045;

/** Past this, the nearest place is reported as far rather than offered plainly. */
const FAR_M = 20000;

function drawMap(): void {
  const canvas = el<HTMLCanvasElement>("escapeMap");
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
  const chosen = state.ranked[state.target];

  // A blank box looks broken. If there is nothing to draw, the box says why.
  if (pos === null || state.places.length === 0) {
    ctx.fillStyle = INK;
    ctx.font = "800 13px system-ui, sans-serif";
    const lines = state.places.length === 0
      ? ["No places on this device to map.",
         "Open the app once with a connection."]
      : ["The map appears once there is a location.",
         "Allow location, or pick a place by hand below."];
    lines.forEach((line, i) => ctx.fillText(line, 12, 26 + i * 18));
    return;
  }

  // Framed on the user, widened to hold the chosen place if it falls outside.
  let west = pos.lon - MAP_PAD_DEG;
  let east = pos.lon + MAP_PAD_DEG;
  let south = pos.lat - MAP_PAD_DEG;
  let north = pos.lat + MAP_PAD_DEG;
  if (chosen !== undefined) {
    west = Math.min(west, chosen.place.lon);
    east = Math.max(east, chosen.place.lon);
    south = Math.min(south, chosen.place.lat);
    north = Math.max(north, chosen.place.lat);
  }
  const pad = 0.15 * Math.max(east - west, north - south);
  const base = makeView(
    [west - pad, south - pad, east + pad, north + pad], rect.width, rect.height);
  const view: View = fitTo(base, [west - pad, south - pad, east + pad, north + pad]);

  drawEscapeLand(ctx, view, rect);
  drawCoastline(ctx, view);
  drawPlaceMarks(ctx, view);

  // The line to the target, drawn before the dot so the dot sits on top.
  if (chosen !== undefined) {
    ctx.strokeStyle = INK;
    ctx.lineWidth = 3;
    ctx.setLineDash([8, 5]);
    ctx.beginPath();
    ctx.moveTo(toScreenX(view, pos.lon), toScreenY(view, pos.lat));
    ctx.lineTo(toScreenX(view, chosen.place.lon), toScreenY(view, chosen.place.lat));
    ctx.stroke();
    ctx.setLineDash([]);
    markTarget(ctx, toScreenX(view, chosen.place.lon), toScreenY(view, chosen.place.lat));
  }

  drawUser(ctx, view, pos);

  // Furniture last, so it sits over the geometry rather than under it.
  drawNorth(ctx, rect.width);
  drawScale(ctx, view);
}

/**
 * A north mark.
 *
 * The map is drawn north-up and never rotates, so without this the reader has
 * no way to tie the picture to the arrow above it -- and when there is no
 * compass, the arrow IS a north-up bearing. This is what makes the two agree.
 */
function drawNorth(ctx: CanvasRenderingContext2D, width: number): void {
  const x = width - 22;
  const y = 20;
  ctx.fillStyle = PAPER;
  ctx.fillRect(x - 13, y - 15, 26, 40);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  ctx.strokeRect(x - 12.5, y - 14.5, 25, 39);

  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.moveTo(x, y - 10);
  ctx.lineTo(x + 6, y + 6);
  ctx.lineTo(x, y + 2);
  ctx.lineTo(x - 6, y + 6);
  ctx.closePath();
  ctx.fill();

  ctx.font = "900 11px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("N", x, y + 21);
  ctx.textAlign = "left";
}

/** Without a scale, a field of dots reads as far more precise than it is. */
function drawScale(ctx: CanvasRenderingContext2D, view: View): void {
  const bar = scaleBar(view, Math.min(120, view.width * 0.35));
  const h = 30;
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
  ctx.moveTo(x + 12, y + 20);
  ctx.lineTo(x + 12 + bar.px, y + 20);
  ctx.moveTo(x + 12, y + 15);
  ctx.lineTo(x + 12, y + 25);
  ctx.moveTo(x + 12 + bar.px, y + 15);
  ctx.lineTo(x + 12 + bar.px, y + 25);
  ctx.stroke();

  ctx.fillStyle = INK;
  ctx.font = "800 11px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(bar.label, x + 12 + bar.px / 2, y + 12);
  ctx.textAlign = "left";
}

/** Land, so sea and backwater are visible rather than implied. */
function drawEscapeLand(
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

function drawCoastline(ctx: CanvasRenderingContext2D, view: View): void {
  const coastline = state.bundle?.coastline;
  if (coastline == null) return;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  for (const part of coastline.parts) {
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

/** Every place in view as a small square; the ranked three get a ring. */
function drawPlaceMarks(ctx: CanvasRenderingContext2D, view: View): void {
  ctx.fillStyle = INK;
  for (const place of state.places) {
    const x = toScreenX(view, place.lon);
    const y = toScreenY(view, place.lat);
    if (x < -6 || y < -6 || x > view.width + 6 || y > view.height + 6) continue;
    ctx.fillRect(x - 2, y - 2, 4, 4);
  }
  for (const r of state.ranked) {
    const x = toScreenX(view, r.place.lon);
    const y = toScreenY(view, r.place.lat);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 8, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function markTarget(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  // A filled square in a heavy ring: tellable from the user's round dot by
  // shape alone, which is the rule the rest of this interface follows.
  ctx.fillStyle = INK;
  ctx.fillRect(x - 6, y - 6, 12, 12);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(x, y, 15, 0, Math.PI * 2);
  ctx.stroke();
}

function drawUser(ctx: CanvasRenderingContext2D, view: View, pos: Position): void {
  const x = toScreenX(view, pos.lon);
  const y = toScreenY(view, pos.lat);

  // The accuracy circle is not decoration. A bare dot claims a precision
  // consumer GPS does not have, and here it would be a claim about which side
  // of a road someone is standing on.
  const radiusPx = (pos.accuracyM / 111132.95) * view.scale;
  if (radiusPx > 4) {
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.arc(x, y, radiusPx, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

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
// manual fallback
// ---------------------------------------------------------------------------

/**
 * Rank from a chosen place instead of from a fix.
 *
 * Used when GPS is refused or cannot see the sky. The screen keeps saying the
 * position is manual, because a bearing computed from a guess is only as good
 * as the guess.
 */
export function useManualOrigin(lat: number, lon: number): void {
  state.position = { lat, lon, accuracyM: 0, at: Date.now() };
  state.geo = "manual";
  state.target = 0;
  render();
}

export function fillManualSelect(select: HTMLSelectElement, bundle: Bundle | null): void {
  const options = (bundle?.places ?? [])
    .filter((p) => p.district !== "")
    .sort((a, b) => a.name.localeCompare(b.name));
  select.replaceChildren(
    ...options.map((p) => {
      const option = document.createElement("option");
      option.value = `${p.lat},${p.lon}`;
      option.textContent = `${p.name} (${p.district})`;
      return option;
    }),
  );
}

/** Exposed for the compass note, which needs a cardinal name with no fix. */
export { compass };
