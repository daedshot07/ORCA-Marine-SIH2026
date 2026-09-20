/**
 * Everything the app knows, as plain text. No canvas, no SVG, no drawing.
 *
 * WHY THIS EXISTS. The map is the most fragile thing on the screen: it needs a
 * canvas context, a device pixel ratio, a layout that has settled, and a
 * position to centre on. When any of that goes wrong the result is a blank
 * rectangle, which tells the reader nothing and looks broken. Every number
 * behind the map is already computed by pure functions in src/compute, so this
 * view asks them the same questions and prints the answers.
 *
 * It is also the view that still works when the location does not: every
 * section falls back to the chosen landing centre, and says which one it used.
 *
 * Nothing here is a second source of truth. It calls the same functions the
 * graphical screens call, so the two cannot disagree about a verdict.
 */

import type { Bundle, Place } from "../bundle/types.ts";
import type { Land } from "../geo/land.ts";
import type { Position } from "../geo/position.ts";
import type { SafePlaces } from "../escape/places.ts";
import type { Tides } from "../compute/tide.ts";

import { formatDuration, formatKm } from "../compute/format.ts";
import { compass } from "../compute/geo.ts";
import { hazardAge, sourceLines } from "../compute/age.ts";
import { nearestBoundary, zoneLabel } from "../compute/boundary.ts";
import { nearestHarbour } from "../compute/harbour.ts";
import { locate } from "../compute/locate.ts";
import { hourIndexFor, onLandVerdict, outsideVerdict, verdictForCell } from "../compute/verdict.ts";
import { inMask, nearestCoast, onLand } from "../geo/land.ts";
import { nearestSafePlaces, typeLabel, walkTime } from "../escape/places.ts";
import {
  DEFAULT_BOAT_SPEED_KN, imblProximity, knotsToMs, nearestHarbours,
} from "../compute/sea.ts";
import { nearestPort, tideExtremes, tideHeight } from "../compute/tide.ts";

export interface TextContext {
  bundle: Bundle | null;
  land: Land | null;
  safe: SafePlaces | null;
  tides: Tides | null;
  /** A live fix, or null when the screen is following a chosen place. */
  position: Position | null;
  /** The chosen landing centre, used when there is no fix. */
  place: Place | undefined;
  nowMs: number;
}

/** One line. `head` is printed in bold; `body` is the rest of the line. */
interface Line {
  head?: string;
  body: string;
  /** Inverted, for the things that must not be skimmed past. */
  loud?: boolean;
}

export function textReport(ctx: TextContext): Line[] {
  const out: Line[] = [];
  const { bundle, land, nowMs } = ctx;

  if (bundle === null) {
    out.push({ body: "No forecast bundle on this device yet." });
    out.push({ body: "Open this app once with a connection to download one." });
    return out;
  }

  // --- where these answers are about -------------------------------------
  const pos = ctx.position;
  const place = ctx.place;
  let lat: number;
  let lon: number;
  let origin: string;

  if (pos !== null) {
    lat = pos.lat;
    lon = pos.lon;
    origin = `your GPS position, accurate to about ${Math.round(pos.accuracyM)} m`;
  } else if (place !== undefined) {
    // The cell centre, which is the water the place fishes in, not the beach.
    const hasCell = place.cellIndex !== null;
    lat = hasCell ? bundle.cellLat[place.cellIndex!]! : place.lat;
    lon = hasCell ? bundle.cellLon[place.cellIndex!]! : place.lon;
    origin = `${place.name}, ${place.district} (no GPS fix; chosen by hand)`;
  } else {
    out.push({ body: "No position and no place chosen yet." });
    return out;
  }

  out.push({ head: "AREA", body: bundle.meta.region_name });
  out.push({ head: "ABOUT", body: origin });
  out.push({ head: "POSITION", body: `${lat.toFixed(5)}, ${lon.toFixed(5)}` });

  // --- the verdict --------------------------------------------------------
  const ashore = land !== null && inMask(land, lat, lon) && onLand(land, lat, lon);
  const coast = land === null ? null : nearestCoast(land, lat, lon);
  const located = locate(bundle, lat, lon);
  const hour = hourIndexFor(bundle, nowMs);
  const verdict = ashore
    ? onLandVerdict(coast?.distanceM ?? null)
    : located.cellIndex === null
      ? outsideVerdict()
      : verdictForCell(bundle, located.cellIndex, hour);

  out.push({ head: "", body: "" });
  out.push({ body: verdict.line, loud: verdict.level === "danger" });
  if (verdict.note !== "") out.push({ body: verdict.note });

  // --- the three figures --------------------------------------------------
  const age = hazardAge(bundle, nowMs);
  if (age.stale) {
    out.push({
      body: age.ageMs === null
        ? "THIS FORECAST HAS NO RECORDED AGE. Do not rely on it."
        : `THIS FORECAST IS ${age.text.toUpperCase()}. Download a new bundle before going out.`,
      loud: true,
    });
  }

  out.push({ head: "", body: "" });
  const boundary = nearestBoundary(bundle, lat, lon);
  out.push({
    head: "NEAREST BOUNDARY",
    body: boundary === null
      ? "no boundary in this bundle"
      : boundary.effectiveM === 0
        ? `AT OR OVER the ${zoneLabel(boundary.zoneType)} — advisory, not a legal line`
        : `${formatKm(boundary.effectiveM)} ${boundary.compass} to the ` +
          `${zoneLabel(boundary.zoneType)} — advisory, not a legal line`,
  });

  const harbour = nearestHarbour(bundle, lat, lon);
  out.push({
    head: ashore ? "NEAREST COVERED COAST" : "TIME TO HARBOUR",
    body: harbour === null
      ? "no landing place in this bundle"
      : ashore
        ? `${formatKm(harbour.distanceM)} to ${harbour.place.name} ${harbour.compass}`
        : `${formatDuration(harbour.seconds)} to ${harbour.place.name} ` +
          `${harbour.compass} — straight line, optimistic`,
  });

  const covered = !ashore && located.cellIndex !== null;
  out.push({
    head: "DATA AGE",
    body: covered
      ? age.text + (age.isLowerBound ? " (source gives no model run time)" : "")
      : ashore ? "not used — you are on land" : "not used — no forecast applies here",
  });

  // --- where to run -------------------------------------------------------
  const runTo = ctx.safe?.places ?? [];
  if (runTo.length > 0) {
    out.push({ head: "", body: "" });
    out.push({ head: "SAFE PLACES ON LAND", body: "straight line, follow roads" });
    for (const r of nearestSafePlaces(runTo, lat, lon, 3)) {
      out.push({
        body: `${r.place.name || `unnamed ${typeLabel(r.place.type)}`} · ` +
          `${typeLabel(r.place.type)} · ${formatKm(r.distanceM)} ` +
          `${Math.round(r.bearingDeg)}° ${r.compass} · ` +
          `at least ${walkTime(r.walkSeconds)} on foot` +
          (r.place.elevationM !== null ? ` · ground ${r.place.elevationM} m above sea` : ""),
      });
    }
  }

  // --- getting a boat home ------------------------------------------------
  out.push({ head: "", body: "" });
  out.push({ head: "HARBOURS", body: `at ${DEFAULT_BOAT_SPEED_KN} knots` });
  for (const h of nearestHarbours(bundle, lat, lon, 3, knotsToMs(DEFAULT_BOAT_SPEED_KN))) {
    const hrs = Math.floor(h.seconds / 3600);
    const mins = Math.round((h.seconds % 3600) / 60);
    out.push({
      body: `${h.place.name} · ${formatKm(h.distanceM)} / ${h.distanceNm.toFixed(1)} NM · ` +
        `${Math.round(h.bearingDeg)}° ${h.compass} · ${hrs} h ${mins} min`,
    });
  }

  const imbl = imblProximity(bundle, lat, lon);
  if (imbl !== null && imbl.level !== "clear") {
    out.push({
      body: imbl.level === "danger"
        ? `TURN BACK NOW — ${imbl.effectiveNm.toFixed(1)} NM from the ${imbl.name} ` +
          `boundary, ${Math.round(imbl.bearingDeg)}° ${imbl.compass}. Advisory line.`
        : `BOUNDARY ${imbl.effectiveNm.toFixed(1)} NM ${imbl.compass} — ${imbl.name}. ` +
          `Advisory line, not a legal boundary.`,
      loud: true,
    });
  }

  // --- tide ---------------------------------------------------------------
  const tides = ctx.tides;
  if (tides !== null && tides.ports.length > 0) {
    const pick = nearestPort(tides, lat, lon)!;
    const now = tideHeight(pick.port, nowMs);
    out.push({ head: "", body: "" });
    out.push({
      head: "TIDE",
      body: `${pick.port.name}, ${pick.port.coast} — ${Math.round(pick.km)} km from here`,
    });
    if (pick.km > 75) {
      out.push({
        body: `THIS IS ${pick.port.name.toUpperCase()}'S TIDE, NOT YOURS. ` +
          `The nearest gauge is ${Math.round(pick.km)} km away.`,
        loud: true,
      });
    }
    if (now !== null) {
      out.push({ body: `Now ${now.toFixed(2)} m above recent mean sea level` });
      for (const e of tideExtremes(pick.port, nowMs, nowMs + 86400000).slice(0, 4)) {
        const d = new Date(e.atMs);
        const inMin = Math.round((e.atMs - nowMs) / 60000);
        const when = inMin < 60
          ? `in ${inMin} min`
          : `in ${Math.floor(inMin / 60)} h ${inMin % 60} min`;
        out.push({
          body: `${e.kind === "high" ? "HIGH" : "LOW "} ` +
            `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")} · ` +
            `${e.heightM.toFixed(2)} m · ${when}`,
        });
      }
      out.push({ body: "Astronomical tide only. Storm surge adds on top." });
    }
  }

  // --- where the numbers came from ----------------------------------------
  out.push({ head: "", body: "" });
  out.push({ head: "SOURCES", body: `${bundle.meta.sources.length} in this bundle` });
  for (const line of sourceLines(bundle, nowMs)) out.push({ body: line });
  out.push({ body: bundle.meta.boundary_disclaimer });
  out.push({
    body: "This device does not forecast weather. The forecast was computed on " +
      "shore and packed into the bundle; this app only decides what it means.",
  });
  if (land === null) {
    out.push({
      body: "THE LAND CHECK DID NOT RUN. This screen cannot tell whether you are " +
        "at sea or ashore.",
      loud: true,
    });
  }

  void compass;
  return out;
}

/** Render the report into a container as plain, selectable text. */
export function renderTextMode(root: HTMLElement, ctx: TextContext): void {
  root.replaceChildren();
  for (const line of textReport(ctx)) {
    if (line.head === "" && line.body === "") {
      const spacer = document.createElement("div");
      spacer.className = "txt__gap";
      root.append(spacer);
      continue;
    }
    const p = document.createElement("p");
    p.className = line.loud === true ? "txt__line txt__line--loud" : "txt__line";
    if (line.head !== undefined && line.head !== "") {
      const head = document.createElement("span");
      head.className = "txt__head";
      head.textContent = `${line.head} `;
      p.append(head);
    }
    p.append(document.createTextNode(line.body));
    root.append(p);
  }
}

/** The whole report as one string, for copying or reading aloud. */
export function textReportString(ctx: TextContext): string {
  return textReport(ctx)
    .map((l) => (l.head === "" && l.body === "")
      ? ""
      : `${l.head !== undefined && l.head !== "" ? l.head + ": " : ""}${l.body}`)
    .join("\n");
}
