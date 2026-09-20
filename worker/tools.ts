/**
 * The tools the model may call. Every one reads OUR data and nothing else.
 *
 * This is where rule 4 is enforced structurally rather than by asking nicely.
 * The model can phrase an answer, but it cannot produce a number: the figures
 * come back from these functions, the Worker keeps them, and the evidence
 * array the client receives is built from what these returned -- not from
 * anything the model said. A model that hallucinates a wave height cannot get
 * that height into the evidence list, because it never passes through the
 * model at all.
 *
 * Each tool reads the same assets the app itself ships, through the ASSETS
 * binding, and computes with the same pure functions in src/compute. So the
 * chat and the screens cannot disagree about a verdict.
 *
 * THERE IS NO PFZ TOOL. The brief asked for get_pfz "if PFZ data exists". It
 * does not: nothing in this project ingests INCOIS potential fishing zone
 * advisories, and a tool that returns "no data" for every call is worse than
 * no tool -- it invites the model to talk about fishing zones it knows nothing
 * about. When a PFZ feed exists, it goes in the bundle first.
 */

import { parseBundle } from "../src/bundle/reader.ts";
import type { Bundle } from "../src/bundle/types.ts";
import { parseLand, onLand, inMask, nearestCoast, type Land } from "../src/geo/land.ts";
import {
  parseSafePlaces, nearestSafePlaces, typeLabel, walkTime, type SafePlaces,
} from "../src/escape/places.ts";
import { parseTides, nearestPort, tideExtremes, tideHeight, type Tides } from "../src/compute/tide.ts";
import { hazardAge } from "../src/compute/age.ts";
import { nearestBoundary, zoneLabel } from "../src/compute/boundary.ts";
import { nearestHarbour } from "../src/compute/harbour.ts";
import { locate } from "../src/compute/locate.ts";
import { hourIndexFor, onLandVerdict, outsideVerdict, verdictForCell } from "../src/compute/verdict.ts";
import { imblProximity } from "../src/compute/sea.ts";
import { formatKm, formatDuration } from "../src/compute/format.ts";
import { REGION_ID } from "./config.ts";

export interface Env {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  SARVAM_API_KEY?: string;
}

/** One claim the answer is allowed to make, with where it came from. */
export interface Evidence {
  claim: string;
  value: string;
  unit: string;
  source: string;
  timestamp: string;
}

export interface ToolResult {
  /** What the model sees. Plain, small, and already in words. */
  forModel: Record<string, unknown>;
  /** What the client sees. Built here, never by the model. */
  evidence: Evidence[];
  /** Optional GeoJSON for the map. */
  mapLayers?: unknown[];
}

// ---------------------------------------------------------------------------
// data, loaded once per isolate
// ---------------------------------------------------------------------------

interface Data {
  bundle: Bundle;
  land: Land | null;
  safe: SafePlaces | null;
  tides: Tides | null;
}

let cached: Promise<Data> | null = null;

async function asset(env: Env, path: string): Promise<Response> {
  // The host is ignored by the ASSETS binding; only the path matters.
  return env.ASSETS.fetch(new Request(`https://assets.local${path}`));
}

export function loadData(env: Env): Promise<Data> {
  if (cached !== null) return cached;
  cached = (async () => {
    const bundleRes = await asset(env, `/bundles/${REGION_ID}.orcabundle`);
    if (!bundleRes.ok) throw new Error(`bundle asset: HTTP ${bundleRes.status}`);
    const bundle = parseBundle(await bundleRes.arrayBuffer());

    const landRes = await asset(env, "/land/india-land.bin");
    const land = landRes.ok ? parseLand(await landRes.arrayBuffer()) : null;

    const safeRes = await asset(env, `/safe-places/${REGION_ID}.json`);
    const safe = safeRes.ok ? parseSafePlaces(await safeRes.json()) : null;

    const tideRes = await asset(env, `/tides/${REGION_ID}.json`);
    const tides = tideRes.ok ? parseTides(await tideRes.json()) : null;

    return { bundle, land, safe, tides };
  })();
  return cached;
}

// ---------------------------------------------------------------------------
// resolving "where"
// ---------------------------------------------------------------------------

export interface Point {
  lat: number;
  lon: number;
  label: string;
}

/**
 * Turn whatever the model or client said into a point, or fail loudly.
 *
 * A place name is matched against the bundle's own landing centres. An
 * unmatched name is an error, never a guess: answering about the wrong village
 * is the failure this whole app is built to avoid.
 */
export function resolvePlace(
  bundle: Bundle, place?: string, lat?: number, lon?: number,
): Point | { error: string } {
  if (typeof lat === "number" && typeof lon === "number" &&
      Number.isFinite(lat) && Number.isFinite(lon)) {
    return { lat, lon, label: `${lat.toFixed(4)}, ${lon.toFixed(4)}` };
  }
  if (typeof place === "string" && place.trim() !== "") {
    const want = place.trim().toLowerCase();
    const exact = bundle.places.find((p) => p.name.toLowerCase() === want);
    const loose = exact ?? bundle.places.find((p) => p.name.toLowerCase().includes(want));
    if (loose === undefined) {
      return {
        error: `No place called "${place}" is in this bundle. ` +
          `Ask the user to pick a landing centre from the list on screen.`,
      };
    }
    const hasCell = loose.cellIndex !== null;
    return {
      lat: hasCell ? bundle.cellLat[loose.cellIndex!]! : loose.lat,
      lon: hasCell ? bundle.cellLon[loose.cellIndex!]! : loose.lon,
      label: `${loose.name}, ${loose.district}`,
    };
  }
  return { error: "No place or coordinates were given." };
}

/** ISO timestamp for the forecast the bundle carries. */
function dataAsOf(bundle: Bundle): string {
  return bundle.meta.generated_at;
}

// ---------------------------------------------------------------------------
// the tools
// ---------------------------------------------------------------------------

export const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: "get_verdict",
      description:
        "Sea safety verdict for a place or point at a time. Returns the verdict " +
        "word, the probability behind it, and how old the forecast is. This is " +
        "the only source of a safety verdict.",
      parameters: {
        type: "object",
        properties: {
          place: { type: "string", description: "Landing centre name, e.g. Akkaraipettai" },
          lat: { type: "number" },
          lon: { type: "number" },
          hours_ahead: {
            type: "number",
            description: "Hours from now. 0 for now, 12 for tomorrow morning, etc.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_safe_places",
      description:
        "Nearest places to shelter on land: shelters, schools and hospitals " +
        "within 5 km of the coast, with distance, walking time and ground height.",
      parameters: {
        type: "object",
        properties: {
          place: { type: "string" }, lat: { type: "number" }, lon: { type: "number" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_tide",
      description:
        "Tide prediction: height now and the next high and low waters. Note the " +
        "gauge may be far away; the result says how far.",
      parameters: {
        type: "object",
        properties: {
          place: { type: "string" }, lat: { type: "number" }, lon: { type: "number" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_geofences",
      description:
        "Distance to maritime boundaries and protected areas, including the " +
        "India-Sri Lanka line. Use for any question about zones to avoid.",
      parameters: {
        type: "object",
        properties: {
          place: { type: "string" }, lat: { type: "number" }, lon: { type: "number" },
        },
      },
    },
  },
] as const;

type Args = { place?: string; lat?: number; lon?: number; hours_ahead?: number };

export async function runTool(
  env: Env, name: string, args: Args, nowMs: number,
): Promise<ToolResult> {
  const data = await loadData(env);
  const { bundle, land, safe, tides } = data;

  const where = resolvePlace(bundle, args.place, args.lat, args.lon);
  if ("error" in where) return { forModel: { error: where.error }, evidence: [] };
  const { lat, lon, label } = where;

  switch (name) {
    case "get_verdict": {
      const aheadMs = (args.hours_ahead ?? 0) * 3600000;
      const at = nowMs + aheadMs;
      const ashore = land !== null && inMask(land, lat, lon) && onLand(land, lat, lon);
      const located = locate(bundle, lat, lon);
      const hour = hourIndexFor(bundle, at);
      const coast = land === null ? null : nearestCoast(land, lat, lon);
      const verdict = ashore
        ? onLandVerdict(coast?.distanceM ?? null)
        : located.cellIndex === null
          ? outsideVerdict()
          : verdictForCell(bundle, located.cellIndex, hour);
      const age = hazardAge(bundle, at);

      const evidence: Evidence[] = [{
        claim: `Sea safety verdict at ${label}`,
        value: verdict.line,
        unit: "",
        source: "ORCA hazard forecast, in the downloaded bundle",
        timestamp: dataAsOf(bundle),
      }];
      if (verdict.p !== null) {
        evidence.push({
          claim: "Chance of dangerous seas",
          value: (verdict.p * 100).toFixed(1),
          unit: "%",
          source: "ORCA hazard forecast (significant wave height over 2.5 m or wind over 12.5 m/s)",
          timestamp: dataAsOf(bundle),
        });
      }
      evidence.push({
        claim: "Forecast age",
        value: age.text,
        unit: "",
        source: "bundle metadata",
        timestamp: dataAsOf(bundle),
      });

      return {
        forModel: {
          place: label,
          for_time: new Date(at).toISOString(),
          verdict: verdict.line,
          probability_percent: verdict.p === null ? null : Number((verdict.p * 100).toFixed(1)),
          on_land: ashore,
          covered_by_forecast: !ashore && located.cellIndex !== null,
          data_age: age.text,
          stale: age.stale,
          note: verdict.note,
        },
        evidence,
      };
    }

    case "get_safe_places": {
      if (safe === null) return { forModel: { error: "No safe-place list on this device." }, evidence: [] };
      const near = nearestSafePlaces(safe.places, lat, lon, 3);
      const evidence: Evidence[] = near.map((r) => ({
        claim: `Safe place near ${label}: ${r.place.name || `unnamed ${typeLabel(r.place.type)}`}`,
        value: `${formatKm(r.distanceM)} ${r.compass}, at least ${walkTime(r.walkSeconds)} on foot`,
        unit: "",
        source: `OpenStreetMap (${r.place.osmId}), ODbL`,
        timestamp: safe.generatedAt,
      }));
      return {
        forModel: {
          place: label,
          places: near.map((r) => ({
            name: r.place.name || `unnamed ${typeLabel(r.place.type)}`,
            type: typeLabel(r.place.type),
            distance: formatKm(r.distanceM),
            bearing: `${Math.round(r.bearingDeg)} degrees ${r.compass}`,
            walk: `at least ${walkTime(r.walkSeconds)}`,
            ground_height_m: r.place.elevationM,
          })),
          caveat: "Straight-line direction. Community-mapped buildings, not an official shelter register.",
        },
        evidence,
        mapLayers: [{
          type: "FeatureCollection",
          features: near.map((r) => ({
            type: "Feature",
            geometry: { type: "Point", coordinates: [r.place.lon, r.place.lat] },
            properties: { name: r.place.name, type: r.place.type },
          })),
        }],
      };
    }

    case "get_tide": {
      if (tides === null) return { forModel: { error: "No tide data on this device." }, evidence: [] };
      const pick = nearestPort(tides, lat, lon);
      if (pick === null) return { forModel: { error: "No tide port available." }, evidence: [] };
      const now = tideHeight(pick.port, nowMs);
      if (now === null) {
        return { forModel: { error: "The tide table on this device has run out." }, evidence: [] };
      }
      const turns = tideExtremes(pick.port, nowMs, nowMs + 86400000).slice(0, 4);
      const evidence: Evidence[] = [
        {
          claim: `Tide height now at ${pick.port.name}`,
          value: now.toFixed(2),
          unit: "m above recent mean sea level",
          source: `UHSLC gauge ${pick.port.id}, harmonic fit`,
          timestamp: pick.port.recordEnd,
        },
        ...turns.map((t) => ({
          claim: `${t.kind === "high" ? "High" : "Low"} water at ${pick.port.name}`,
          value: `${new Date(t.atMs).toISOString()} at ${t.heightM.toFixed(2)} m`,
          unit: "",
          source: `UHSLC gauge ${pick.port.id}, harmonic fit`,
          timestamp: pick.port.recordEnd,
        })),
      ];
      return {
        forModel: {
          port: pick.port.name,
          port_coast: pick.port.coast,
          port_distance_km: Math.round(pick.km),
          far_from_user: pick.km > 75,
          height_now_m: Number(now.toFixed(2)),
          next_turns: turns.map((t) => ({
            kind: t.kind,
            time: new Date(t.atMs).toISOString(),
            height_m: Number(t.heightM.toFixed(2)),
          })),
          caveat: "Astronomical tide only. Storm surge adds on top. Heights are " +
            "about recent mean sea level, not chart datum, so they are not depths.",
        },
        evidence,
      };
    }

    case "check_geofences": {
      const boundary = nearestBoundary(bundle, lat, lon);
      const imbl = imblProximity(bundle, lat, lon);
      const harbour = nearestHarbour(bundle, lat, lon);
      const evidence: Evidence[] = [];
      if (boundary !== null) {
        evidence.push({
          claim: `Nearest boundary to ${label}`,
          value: boundary.effectiveM === 0
            ? `at or over the ${zoneLabel(boundary.zoneType)}`
            : `${formatKm(boundary.effectiveM)} ${boundary.compass} to the ${zoneLabel(boundary.zoneType)}`,
          unit: "",
          source: bundle.meta.boundary_disclaimer,
          timestamp: dataAsOf(bundle),
        });
      }
      if (imbl !== null) {
        evidence.push({
          claim: "Distance to the India-Sri Lanka maritime boundary",
          value: imbl.effectiveNm.toFixed(1),
          unit: "nautical miles (after the uncertainty margin)",
          source: "MarineRegions/VLIZ, CC-BY 4.0. Advisory only, not a legal boundary.",
          timestamp: dataAsOf(bundle),
        });
      }
      return {
        forModel: {
          place: label,
          nearest_boundary: boundary === null ? null : {
            kind: zoneLabel(boundary.zoneType),
            distance: boundary.effectiveM === 0 ? "at or over it" : formatKm(boundary.effectiveM),
            bearing: boundary.compass,
          },
          india_sri_lanka_line: imbl === null ? null : {
            distance_nm: Number(imbl.effectiveNm.toFixed(1)),
            bearing: imbl.compass,
            alarm: imbl.level,
          },
          nearest_harbour: harbour === null ? null : {
            name: harbour.place.name,
            distance: formatKm(harbour.distanceM),
            time: formatDuration(harbour.seconds),
          },
          caveat: "Boundaries are open data, advisory only, and carry no legal authority.",
        },
        evidence,
      };
    }

    default:
      return { forModel: { error: `Unknown tool ${name}` }, evidence: [] };
  }
}
