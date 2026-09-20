#!/usr/bin/env node
/**
 * Put a real ground height on every safe place.
 *
 *   node scripts/fetch-elevation.mjs --region kerala-tn
 *
 * Reads public/safe-places/<region>.json, looks each place up in SRTM 30 m via
 * OpenTopoData, and writes the elevations back into the same file. Run it after
 * scripts/fetch-safe-places.mjs. Needs network; ordinary builds do not.
 *
 * WHY THIS EXISTS
 * ---------------
 * In a storm surge the only question that matters about a building is how high
 * it is, and this app had no answer: ORCA holds no elevation, bathymetry or
 * surge data at all -- docs/BUNDLE_FORMAT.md section 8 is defined and empty --
 * and OSM had an `ele` tag on 2 of 7,722 places. So the escape screen ranked
 * shelters by distance alone and a beachfront school 200 m away outranked a
 * building on a rise 600 m away.
 *
 * WHAT THIS IS NOT
 * ----------------
 * It is NOT a surge check, and the screen must never imply that it is. Knowing
 * a shelter is 11 m up does not tell you the water will stop below 11 m,
 * because nothing in this system forecasts a surge height. INCOIS publishes
 * that; ORCA does not ingest it. Elevation lets a reader compare two shelters.
 * It does not certify either of them.
 *
 * THE ACCURACY, WHICH MATTERS MORE HERE THAN ALMOST ANYWHERE
 * ---------------------------------------------------------
 * SRTM's stated absolute vertical accuracy is about 16 m at 90 per cent
 * confidence, and it is a SURFACE model: over a building or tree canopy it
 * returns the top of it, not the ground. On the flat coastal land this app
 * covers, most readings come back 0, 1 or 2 metres, and the difference between
 * those is well inside the error.
 *
 * So the numbers are shown, and they are labelled as ground height from SRTM
 * with the error stated. They are NOT used to sort the list, because sorting by
 * a number whose error exceeds its spread would be inventing a ranking. See
 * docs/KNOWN_LIMITATIONS.md.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const ENDPOINT = "https://api.opentopodata.org/v1/srtm30m";
const ATTRIBUTION =
  "Elevation: SRTM 30 m via OpenTopoData. Ground height above sea level, " +
  "about 16 m accuracy at 90% confidence; it is not a surge forecast.";

/** OpenTopoData's free tier: 100 locations per call, one call per second. */
const BATCH = 100;
const GAP_MS = 1100;

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function lookup(points, attempt = 1) {
  const locations = points.map(([lat, lon]) => `${lat},${lon}`).join("|");
  const res = await fetch(`${ENDPOINT}?locations=${locations}`, {
    headers: { "User-Agent": "orca-marina-bundle-builder/1.0 (SIH coastal safety PWA)" },
  });
  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 4) throw new Error(`OpenTopoData ${res.status} after ${attempt} tries`);
    const wait = attempt * 5;
    console.log(`  ${res.status}, waiting ${wait}s`);
    await sleep(wait * 1000);
    return lookup(points, attempt + 1);
  }
  if (!res.ok) throw new Error(`OpenTopoData HTTP ${res.status}`);
  const body = await res.json();
  if (body.status !== "OK") throw new Error(`OpenTopoData: ${body.error ?? body.status}`);
  return body.results.map((r) => r.elevation);
}

async function main() {
  const regionId = arg("region", "kerala-tn");
  const path = join(ROOT, "public/safe-places", `${regionId}.json`);
  if (!existsSync(path)) {
    console.error(`${path} is missing. Run scripts/fetch-safe-places.mjs first.`);
    process.exit(1);
  }

  const file = JSON.parse(readFileSync(path, "utf8"));
  const scale = file.coord_scale;
  const places = file.places;
  console.log(`${places.length.toLocaleString()} places in ${regionId}`);

  // Cached by coordinate, so a re-run after re-fetching the places costs only
  // the lookups that are genuinely new.
  const cacheDir = join(ROOT, ".elevation-cache");
  const cachePath = join(cacheDir, `${regionId}.json`);
  const cache = existsSync(cachePath)
    ? new Map(Object.entries(JSON.parse(readFileSync(cachePath, "utf8"))))
    : new Map();
  console.log(`  ${cache.size.toLocaleString()} cached from a previous run`);

  const need = [];
  for (const p of places) {
    const key = `${p[1]},${p[2]}`;
    if (!cache.has(key)) need.push({ key, lat: p[1] / scale, lon: p[2] / scale });
  }
  console.log(`  ${need.length.toLocaleString()} to look up, ` +
              `${Math.ceil(need.length / BATCH)} request(s)\n`);

  for (let i = 0; i < need.length; i += BATCH) {
    const slice = need.slice(i, i + BATCH);
    const values = await lookup(slice.map((n) => [n.lat.toFixed(6), n.lon.toFixed(6)]));
    slice.forEach((n, j) => cache.set(n.key, values[j]));
    const done = Math.min(i + BATCH, need.length);
    process.stdout.write(`\r  ${done.toLocaleString()} / ${need.length.toLocaleString()}`);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cachePath, JSON.stringify(Object.fromEntries(cache)));
    if (done < need.length) await sleep(GAP_MS);
  }
  if (need.length > 0) console.log();

  let filled = 0;
  let missing = 0;
  const heights = [];
  for (const p of places) {
    const v = cache.get(`${p[1]},${p[2]}`);
    // null, not zero. A lookup that failed and a place at sea level are
    // opposite claims, and this file has carried that distinction since it was
    // written: see the 255 rule in docs/BUNDLE_FORMAT.md for the same idea.
    if (typeof v === "number" && Number.isFinite(v)) {
      p[3] = Math.round(v);
      heights.push(p[3]);
      filled++;
    } else {
      p[3] = null;
      missing++;
    }
  }

  file.elevation_attribution = ATTRIBUTION;
  file.elevation_dataset = "srtm30m";
  writeFileSync(path, JSON.stringify(file));

  heights.sort((a, b) => a - b);
  const at = (q) => heights[Math.floor(heights.length * q)];
  const bytes = readFileSync(path).length;
  console.log(`\nfilled ${filled.toLocaleString()}, missing ${missing.toLocaleString()}`);
  console.log(`  median ${at(0.5)} m, 90th ${at(0.9)} m, max ${heights[heights.length - 1]} m`);
  console.log(`  at or below 2 m: ` +
              `${heights.filter((h) => h <= 2).length.toLocaleString()} ` +
              `(${((heights.filter((h) => h <= 2).length / heights.length) * 100).toFixed(0)}%)`);
  console.log(`wrote ${path}  ${bytes.toLocaleString()} bytes`);
  console.log(`  ${ATTRIBUTION}`);
}

await main();
