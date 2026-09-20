#!/usr/bin/env node
/**
 * Fetch places worth running to, from OpenStreetMap, for one bundled region.
 *
 *   node scripts/fetch-safe-places.mjs --region kerala-tn
 *
 * Run this once. It needs network; ordinary builds do not, because the result
 * is committed at public/safe-places/<region>.json. A build that reaches the
 * internet is a build that produces different bytes depending on the day --
 * the same rule builder/fetch_coastline.py and builder/fetch_land.py follow.
 *
 * NOTHING HERE IS INVENTED. Every record carries the OSM element it came from
 * and the tag that qualified it, so any entry on the escape screen can be
 * traced back to a real object someone mapped. This script never promotes a
 * building to a shelter because it looks like one, and it never synthesises a
 * "high ground" point: see the elevation note below.
 *
 * WHY A COASTAL STRIP
 * -------------------
 * The region box holds 13,743 hospitals and 23,433 schools. Shipping those
 * would be several megabytes on a phone that has to precache them over 2G, and
 * almost all of them are irrelevant: the hazard this app describes is the sea,
 * and someone escaping it is on the coast. Only places within COAST_KM of the
 * coastline are kept, measured against the same land mask the app uses.
 *
 * WHAT IS NOT HERE: ELEVATION
 * ---------------------------
 * `elevation_m` is present only where OSM carries an `ele` tag, which is rare.
 * ORCA holds no DEM at all -- docs/BUNDLE_FORMAT.md section 8 is defined and
 * empty, and the bundle says so in `dem_reason` -- so there is no elevation
 * source to fall back on and no way to compute "high ground". Records without
 * `ele` carry null, and the screen shows nothing rather than a guess. Ranking
 * shelters by invented height is exactly the failure this project refuses.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { nearestCoast, onLand, parseLand } from "../src/geo/land.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const ENDPOINT = "https://overpass-api.de/api/interpreter";
const ATTRIBUTION =
  "Safe places: OpenStreetMap contributors, ODbL. Community-mapped, not an " +
  "official shelter register.";

/** Region boxes, mirroring builder/regions.py. West, south, east, north. */
const REGIONS = {
  "kerala-tn": { name: "Kerala and Tamil Nadu coast", bbox: [74.0, 7.0, 81.0, 13.6] },
};

/**
 * Keep a place only if it is this close to the coast. Override with --coast-km.
 *
 * Five kilometres, not fifteen. Two reasons, and the second is the real one.
 * Storm surge inundation is a coastal-strip phenomenon, so a shelter thirty
 * minutes inland is not the one anybody runs to. And the file is precached on
 * a phone over 2G: at 15 km this held 15,120 places and weighed 998 KB, which
 * is twice the entire rest of the app. The screen only ever shows the nearest
 * three.
 */
const DEFAULT_COAST_KM = 5;

/**
 * What counts, and in what order of usefulness when a place matches twice.
 *
 * A purpose-built cyclone shelter beats a school that is only sometimes one,
 * and both beat a hospital, which is where you go if you are hurt rather than
 * where you go to be out of the water. The order is the tie-break, not a
 * ranking shown to the user: the screen sorts by distance, because in a surge
 * the nearest solid building wins.
 */
const CATEGORIES = [
  { type: "cyclone_shelter", query: 'nwr["building"="cyclone_shelter"]' },
  { type: "cyclone_shelter", query: 'nwr["shelter_type"="cyclone_shelter"]' },
  { type: "shelter", query: 'nwr["amenity"="shelter"]' },
  { type: "shelter", query: 'nwr["social_facility"="shelter"]' },
  { type: "assembly_point", query: 'nwr["emergency"="assembly_point"]' },
  { type: "school", query: 'nwr["amenity"="school"]' },
  { type: "hospital", query: 'nwr["amenity"="hospital"]' },
];

/** Written into the file so the reader does not hardcode the same list. */
const TYPES = ["cyclone_shelter", "shelter", "assembly_point", "school", "hospital"];

const COORD_SCALE = 1e5; // about 1.1 m, ample for walking to a building

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
}

async function overpass(body, attempt = 1) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      // Overpass sits behind an Apache that returns 406 Not Acceptable to
      // Node's default User-Agent. The query is fine; the client string is
      // not. Identifying the tool is also the polite thing to do against a
      // volunteer-run endpoint.
      "User-Agent": "orca-marina-bundle-builder/1.0 (SIH coastal safety PWA)",
    },
    body: new URLSearchParams({ data: body }),
  });
  if (res.status === 429 || res.status === 504) {
    if (attempt >= 4) throw new Error(`Overpass ${res.status} after ${attempt} tries`);
    const wait = attempt * 20;
    console.log(`  Overpass ${res.status}, waiting ${wait}s and retrying`);
    await new Promise((r) => setTimeout(r, wait * 1000));
    return overpass(body, attempt + 1);
  }
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  return res.json();
}

/**
 * Overpass responses, cached on disk.
 *
 * Forty thousand elements take about seventy seconds to fetch and Overpass is
 * a volunteer-run endpoint. Re-tuning the coastal filter must not mean asking
 * for all of it again, so raw responses are kept and reused unless --refetch
 * is passed.
 */
async function fetchCategory(cacheDir, key, body) {
  const cached = join(cacheDir, `${key}.json`);
  if (!process.argv.includes("--refetch") && existsSync(cached)) {
    process.stdout.write("(cached) ");
    return JSON.parse(readFileSync(cached, "utf8"));
  }
  const json = await overpass(body);
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cached, JSON.stringify(json));
  return json;
}

async function main() {
  const regionId = arg("region", "kerala-tn");
  const coastKm = Number(arg("coast-km", DEFAULT_COAST_KM));
  const region = REGIONS[regionId];
  if (region === undefined) {
    console.error(`unknown region ${regionId}; known: ${Object.keys(REGIONS).join(", ")}`);
    process.exit(1);
  }
  const [w, s, e, n] = region.bbox;
  const box = `${s},${w},${n},${e}`; // Overpass takes south,west,north,east

  const landPath = join(ROOT, "public/land/india-land.bin");
  if (!existsSync(landPath)) {
    console.error(`${landPath} is missing. Run builder/fetch_land.py first: the`);
    console.error(`coastal filter measures against it.`);
    process.exit(1);
  }
  const lf = readFileSync(landPath);
  const land = parseLand(lf.buffer.slice(lf.byteOffset, lf.byteOffset + lf.byteLength));
  console.log(`land mask: ${land.ringCount} rings`);

  // Deduplicated by OSM element, because a building can be both a school and a
  // shelter and must appear once, under whichever type ranks first.
  const found = new Map();
  let raw = 0;

  const cacheDir = join(ROOT, ".overpass-cache", regionId);
  for (const [index, { type, query }] of CATEGORIES.entries()) {
    const body = `[out:json][timeout:300];${query}(${box});out center;`;
    process.stdout.write(`  ${type.padEnd(16)} ${query} ... `);
    const json = await fetchCategory(cacheDir, `${index}-${type}`, body);
    const elements = json.elements ?? [];
    raw += elements.length;
    let kept = 0;

    for (const el of elements) {
      const lat = el.lat ?? el.center?.lat;
      const lon = el.lon ?? el.center?.lon;
      if (typeof lat !== "number" || typeof lon !== "number") continue;

      const id = `${el.type[0]}${el.id}`;
      if (found.has(id)) continue;

      // On land and near the coast. A place in the water is a mapping error,
      // and a place inland is not where this app's users are.
      if (!onLand(land, lat, lon)) continue;
      const coast = nearestCoast(land, lat, lon);
      if (coast === null || coast.distanceM > coastKm * 1000) continue;

      const tags = el.tags ?? {};
      const ele = Number.parseFloat(tags.ele);
      found.set(id, {
        id,
        type,
        name: tags["name:en"] ?? tags.name ?? "",
        lat: Math.round(lat * COORD_SCALE),
        lon: Math.round(lon * COORD_SCALE),
        ele: Number.isFinite(ele) ? Math.round(ele) : null,
      });
      kept++;
    }
    console.log(`${elements.length} found, ${kept} kept`);
  }

  const places = [...found.values()].sort((a, b) => a.lat - b.lat || a.lon - b.lon);

  // Compact on purpose: a row per place, not an object per place. The keys
  // would be two thirds of the file, and this is precached on a 2G phone.
  const out = {
    v: 1,
    region_id: regionId,
    region_name: region.name,
    generated_at: new Date().toISOString(),
    attribution: ATTRIBUTION,
    source_url: "https://www.openstreetmap.org/",
    coast_filter_km: coastKm,
    coord_scale: COORD_SCALE,
    types: TYPES,
    /** [typeIndex, lat*1e5, lon*1e5, elevation_m|null, name, osmId] */
    columns: ["type", "lat", "lon", "elevation_m", "name", "osm_id"],
    places: places.map((p) => [
      TYPES.indexOf(p.type), p.lat, p.lon, p.ele, p.name, p.id,
    ]),
  };

  const dir = join(ROOT, "public/safe-places");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${regionId}.json`);
  writeFileSync(path, JSON.stringify(out));

  const bytes = readFileSync(path).length;
  const byType = {};
  for (const p of places) byType[p.type] = (byType[p.type] ?? 0) + 1;
  const named = places.filter((p) => p.name !== "").length;
  const withEle = places.filter((p) => p.ele !== null).length;

  console.log(`\n${raw.toLocaleString()} elements fetched, ${places.length.toLocaleString()} kept`);
  for (const t of TYPES) console.log(`  ${t.padEnd(16)} ${(byType[t] ?? 0).toLocaleString()}`);
  console.log(`  named ${named.toLocaleString()}, with elevation ${withEle.toLocaleString()}`);
  console.log(`wrote ${path}  ${bytes.toLocaleString()} bytes (${(bytes / 1024).toFixed(1)} KB)`);
  console.log(`  ${ATTRIBUTION}`);
}

await main();
