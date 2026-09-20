/** All DOM writing. Everything it renders is computed by the pure functions
 * in src/compute, so the screen has no arithmetic of its own to get wrong. */

import type { Bundle, Place } from "../bundle/types.ts";
import { locate } from "../compute/locate.ts";
import type { Position } from "../geo/position.ts";
import { hazardAge, sourceLines } from "../compute/age.ts";
import { nearestBoundary, zoneLabel } from "../compute/boundary.ts";
import { nearestHarbour } from "../compute/harbour.ts";
import {
  hourIndexFor,
  onLandVerdict,
  outsideVerdict,
  verdictForCell,
} from "../compute/verdict.ts";
import { formatDuration, formatKm } from "../compute/format.ts";
import { inMask, nearestCoast, onLand, type Land } from "../geo/land.ts";
import { DETOUR_FACTOR, UNKNOWN_SPEED_MS } from "../constants.ts";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`missing element #${id}`);
  return node as T;
}

// Re-exported so this module's surface is unchanged; the definitions moved to
// src/compute/format.ts when the verdict needed to state a distance too.
export { formatDuration, formatKm } from "../compute/format.ts";

/** Every place that can be selected: an INCOIS landing centre with a district. */
export function selectablePlaces(bundle: Bundle): Place[] {
  return bundle.places
    .filter((p) => p.district !== "")
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function districtsOf(places: Place[]): string[] {
  return [...new Set(places.map((p) => p.district))].sort((a, b) => a.localeCompare(b));
}

export function fillSelect(select: HTMLSelectElement, values: string[]): void {
  select.replaceChildren(
    ...values.map((v) => {
      const option = document.createElement("option");
      option.value = v;
      option.textContent = v;
      return option;
    }),
  );
}

export function fillPlaceSelect(select: HTMLSelectElement, places: Place[]): void {
  select.replaceChildren(
    ...places.map((p) => {
      const option = document.createElement("option");
      option.value = p.id;
      // A place whose cell has no forecast is marked in the list itself, so the
      // absence is visible before it is selected rather than only after.
      option.textContent = p.cellIndex === null ? `${p.name} — no data` : p.name;
      return option;
    }),
  );
}

export function renderRegion(bundle: Bundle): void {
  el("region").textContent = bundle.meta.region_name;
}

export function renderPlace(bundle: Bundle, place: Place, nowMs: number): void {
  // The reference point is the centre of the forecast cell, which is the water
  // this place fishes in, not the shore itself. Step 3 replaces it with a GPS
  // fix and none of the arithmetic below changes.
  const hasCell = place.cellIndex !== null;
  const refLat = hasCell ? bundle.cellLat[place.cellIndex!]! : place.lat;
  const refLon = hasCell ? bundle.cellLon[place.cellIndex!]! : place.lon;

  const hour = hourIndexFor(bundle, nowMs);
  const verdict = verdictForCell(bundle, place.cellIndex, hour);

  const verdictSection = el("verdict");
  verdictSection.className = `verdict verdict--${verdict.level}`;
  verdictSection.hidden = false;
  el("verdictLine").textContent = verdict.line;
  el("verdictNote").textContent = verdict.note;

  // The same three figures as the position path, measured from the cell
  // centre instead of a GPS fix. One implementation, so the two cannot drift.
  //
  // `ashore` is false and not tested: a landing centre IS on land, by
  // definition, and the land mask exists to catch a POSITION that is ashore,
  // not to argue with the user about a harbour they deliberately picked.
  renderFigures(bundle, refLat, refLon, nowMs, { covered: hasCell, ashore: false });

  // --- which water this describes ----------------------------------------
  const reference = el("reference");
  reference.hidden = false;
  if (!hasCell) {
    reference.textContent =
      `No forecast area covers ${place.name}. Nothing below the verdict describes ` +
      `the sea there.`;
  } else if (place.offsetM < 500) {
    reference.textContent = `Forecast for the water at ${place.name}.`;
  } else {
    reference.textContent =
      `Forecast for the water ${formatKm(place.offsetM)} from ${place.name}. ` +
      `Distances above are measured from there.`;
  }

  el("figures").hidden = false;
  renderProvenance(
    bundle, nearestBoundary(bundle, refLat, refLon)?.attribution ?? null, nowMs);
}

/**
 * Render for the user's own position rather than for a chosen place.
 *
 * Everything below the verdict is measured from the real position, not from a
 * cell centre, which is the swap the pure functions in src/compute were shaped
 * for. Nothing else about the screen changes.
 */
export function renderPosition(
  bundle: Bundle, pos: Position, nowMs: number, land: Land | null = null,
): void {
  // THE LAND TEST RUNS FIRST, BEFORE THE CELL LOOKUP.
  //
  // Order is the whole fix. locate() will happily hand back a hexagon for an
  // inland position: the cells are 8.5 km across and ORCA's hazard field does
  // not stop at the waterline, so 5.4 per cent of land in this region sits
  // inside one. Asking "are you at sea" only AFTER asking "which sea cell are
  // you in" is how a point 1.3 km inland came to be shown CAUTION, 18.5 per
  // cent chance of dangerous seas.
  //
  // `land` may be null when the mask has not loaded. That is survivable and it
  // is NOT silently treated as "at sea": the check simply has not run, and
  // renderProvenance says so.
  const ashore = land !== null && inMask(land, pos.lat, pos.lon) &&
    onLand(land, pos.lat, pos.lon);
  const coast = land === null ? null : nearestCoast(land, pos.lat, pos.lon);

  const located = locate(bundle, pos.lat, pos.lon);

  const hour = hourIndexFor(bundle, nowMs);
  // Three different reasons for there to be no number, kept apart because the
  // reader can do something different about each. There is no path from any of
  // them to a probability.
  const verdict = ashore
    ? onLandVerdict(coast?.distanceM ?? null)
    : located.cellIndex === null
      ? outsideVerdict()
      : verdictForCell(bundle, located.cellIndex, hour);

  const verdictSection = el("verdict");
  verdictSection.className = `verdict verdict--${verdict.level}`;
  verdictSection.hidden = false;
  el("verdictLine").textContent = verdict.line;
  el("verdictNote").textContent = verdict.note;

  // On land the forecast hour is not consulted at all, so `covered` is false
  // and the age figure reads "not used" rather than quoting the age of data
  // that is not being applied to anything.
  renderFigures(bundle, pos.lat, pos.lon, nowMs, {
    covered: !ashore && located.cellIndex !== null,
    ashore,
  });

  const accuracy = `Your position, accurate to about ${Math.round(pos.accuracyM)} m.`;
  const reference = el("reference");
  reference.hidden = false;
  if (ashore) {
    reference.textContent =
      `${accuracy} The nearest coast is ` +
      `${coast === null ? "not known" : formatKm(coast.distanceM)} away. ` +
      `Nothing on this screen describes the ground you are standing on.`;
  } else if (located.cellIndex === null) {
    reference.textContent = `${accuracy} No forecast area covers it.`;
  } else {
    reference.textContent =
      `${accuracy} Forecast is for the area around you; its centre is ` +
      `${formatKm(located.offsetM)} away. Distances are measured from you.`;
  }

  el("figures").hidden = false;
  renderProvenance(
    bundle, nearestBoundary(bundle, pos.lat, pos.lon)?.attribution ?? null, nowMs,
    land === null,
  );
}

interface FigureContext {
  /** A forecast cell applies to this point and its hour is in range. */
  covered: boolean;
  /** The point is on dry land, so a boat figure would be nonsense. */
  ashore: boolean;
}

/** The three figures, measured from a point. Shared by both render paths. */
function renderFigures(
  bundle: Bundle, lat: number, lon: number, nowMs: number, ctx: FigureContext,
): void {
  const { covered, ashore } = ctx;
  const boundary = nearestBoundary(bundle, lat, lon);
  const boundaryFig = el("figBoundary");
  if (boundary === null) {
    el("boundaryValue").textContent = "no data";
    el("boundarySub").textContent = "no boundary in this bundle";
    boundaryFig.className = "figure";
  } else {
    const inside = boundary.effectiveM === 0;
    el("boundaryValue").textContent = inside ? "AT OR OVER" : formatKm(boundary.effectiveM);
    el("boundarySub").textContent =
      `${zoneLabel(boundary.zoneType)} ${boundary.compass} · advisory, not a legal line`;
    boundaryFig.className = inside ? "figure figure--alarm" : "figure";
  }

  const harbour = nearestHarbour(bundle, lat, lon);
  if (harbour === null) {
    el("harbourLabel").textContent = "Time to harbour";
    el("harbourValue").textContent = "no data";
    el("harbourSub").textContent = "no landing place in this bundle";
  } else if (ashore) {
    // A transit time from an inland position would be a boat's speed applied
    // across a mountain range. The distance to the same place is a fact, and
    // it is also the thing an inland reader actually wants: where the nearest
    // covered coast is. The label changes with it, because a number under the
    // wrong label is worse than no number.
    el("harbourLabel").textContent = "Nearest covered coast";
    el("harbourValue").textContent = formatKm(harbour.distanceM);
    el("harbourSub").textContent = `${harbour.place.name} ${harbour.compass}`;
  } else {
    el("harbourLabel").textContent = "Time to harbour";
    el("harbourValue").textContent = formatDuration(harbour.seconds);
    el("harbourSub").textContent =
      `${harbour.place.name} ${harbour.compass} · straight line, optimistic`;
  }

  const age = hazardAge(bundle, nowMs);
  el("ageValue").textContent = covered ? age.text : "not used";
  el("ageSub").textContent = covered
    ? (age.isLowerBound ? "source gives no model run time" : "")
    : ashore ? "you are on land" : "no forecast applies here";
  el("figAge").className = covered && age.stale ? "figure figure--alarm" : "figure";

  const stale = el("stale");
  if (covered && age.stale) {
    stale.hidden = false;
    stale.textContent =
      age.ageMs === null
        ? "THIS FORECAST HAS NO RECORDED AGE. Do not rely on it."
        : `THIS FORECAST IS ${age.text.toUpperCase()}. Download a new bundle before going out.`;
  } else {
    stale.hidden = true;
  }
}

function renderProvenance(
  bundle: Bundle, attribution: string | null, nowMs: number,
  landUnavailable = false,
): void {
  const prov = el<HTMLDetailsElement>("prov");
  prov.hidden = false;

  const body = el("provBody");
  body.replaceChildren();

  const add = (text: string): void => {
    const p = document.createElement("p");
    p.textContent = text;
    body.append(p);
  };

  add(
    "This device does not forecast weather. The forecast was computed on shore " +
    "and packed into the bundle; this app only decides what it means for you.",
  );

  if (attribution !== null) add(attribution);
  add(bundle.meta.boundary_disclaimer);

  // Said out loud rather than left to be inferred from a screen that looks
  // normal. Without the mask the app cannot tell land from sea, which is the
  // one failure here that produces a confident wrong answer rather than none.
  if (landUnavailable) {
    add(
      "THE LAND CHECK DID NOT RUN. The land mask could not be loaded, so this " +
      "screen cannot tell whether you are at sea or ashore. Treat a verdict " +
      "with suspicion until the app has been online once.",
    );
  } else {
    add("Land: Natural Earth 1:10m physical, public domain. Coastline only; it " +
        "carries no national borders and none are shown.");
  }

  add(
    `Time to harbour is a straight line multiplied by ${DETOUR_FACTOR} at an assumed ` +
    `${UNKNOWN_SPEED_MS} m/s, about 6 knots. A real track is longer, and no allowance ` +
    `is made for a boat making less way in a heavy sea, so the figure is a lower bound. ` +
    `Depth under the keel is not checked at all.`,
  );

  add(
    `Boundary lines were simplified by up to about ` +
    `${bundle.meta.boundary_simplify.tolerance_m_approx} m before packing, and distances ` +
    `are reported after subtracting that and the uncertainty budget the shore system uses.`,
  );

  const heading = document.createElement("p");
  heading.className = "prov__heading";
  heading.textContent = `Data age, every source in this bundle (${bundle.meta.sources.length})`;
  body.append(heading);

  const list = document.createElement("ul");
  for (const line of sourceLines(bundle, nowMs)) {
    const li = document.createElement("li");
    li.textContent = line;
    list.append(li);
  }
  body.append(list);

  const check = bundle.meta.simulation_check;
  if (check !== undefined) {
    add(
      `Drill data check: ${check.active_scenarios.length} active scenarios, ` +
      `${check.simulated_risk_rows} simulated hazard rows, ` +
      `${check.simulated_observations} simulated observations, ` +
      `${check.masked_observations} displaced observations. ` +
      `This bundle carries ${bundle.containsSimulated ? "DRILL DATA" : "no drill data"}.`,
    );
  }

  if (bundle.containsSimulated) {
    add("THIS BUNDLE CONTAINS DRILL DATA. It is not a forecast.");
  }
  add(bundle.meta.dem_reason);
}

export function showError(message: string): void {
  const box = el("loadError");
  box.hidden = false;
  box.textContent = message;
}

export function clearError(): void {
  el("loadError").hidden = true;
}
