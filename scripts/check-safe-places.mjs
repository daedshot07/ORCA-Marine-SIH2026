#!/usr/bin/env node
/**
 * Every bundled place must be able to answer "where do I run".
 *
 *   node scripts/check-safe-places.mjs
 *
 * For each of the 547 selectable landing centres, and for each district, this
 * asks the same question the escape screen asks and insists on a usable
 * answer: at least one safe place, and a distance and bearing that are finite
 * numbers. A NaN here would reach the screen as a blank arrow and an empty
 * list, which is exactly the failure this script exists to catch before a
 * demo does.
 *
 * It also reports how far the nearest place is, per district. A district whose
 * nearest shelter is twenty kilometres away is not a bug, but it is something
 * to know before standing in front of judges and claiming coverage.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseBundle } from "../src/bundle/reader.ts";
import { nearestSafePlaces, parseSafePlaces, typeLabel } from "../src/escape/places.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Past this the escape screen tells the reader the nearest place is far. */
const FAR_M = 20000;

const bundlePath = process.argv[2] ?? join(ROOT, "public/bundles/kerala-tn.orcabundle");
const safePath = process.argv[3] ?? join(ROOT, "public/safe-places/kerala-tn.json");

for (const path of [bundlePath, safePath]) {
  if (!existsSync(path)) {
    console.error(`missing ${path}`);
    process.exit(1);
  }
}

const bf = readFileSync(bundlePath);
const bundle = parseBundle(bf.buffer.slice(bf.byteOffset, bf.byteOffset + bf.byteLength));
const safe = parseSafePlaces(JSON.parse(readFileSync(safePath, "utf8")));

console.log(`bundle      ${bundle.places.length} places, ${bundle.meta.region_name}`);
console.log(`safe places ${safe.places.length.toLocaleString()}, within ` +
            `${safe.coastFilterKm} km of the coast\n`);

const selectable = bundle.places.filter((p) => p.district !== "");
const districts = new Map();
const failures = [];
const far = [];

for (const place of selectable) {
  const near = nearestSafePlaces(safe.places, place.lat, place.lon, 3);

  if (near.length === 0) {
    failures.push(`${place.name} (${place.district}): no safe place returned`);
    continue;
  }
  const bad = near.filter(
    (r) => !Number.isFinite(r.distanceM) || !Number.isFinite(r.bearingDeg) ||
           !Number.isFinite(r.walkSeconds));
  if (bad.length > 0) {
    failures.push(
      `${place.name} (${place.district}): ${bad.length} of ${near.length} results ` +
      `had a non-finite distance, bearing or walking time`);
    continue;
  }

  const nearest = near[0];
  if (nearest.distanceM > FAR_M) {
    far.push({ place, nearest });
  }

  const seen = districts.get(place.district) ?? { count: 0, worst: 0, worstAt: null };
  seen.count++;
  if (nearest.distanceM > seen.worst) {
    seen.worst = nearest.distanceM;
    seen.worstAt = place;
  }
  districts.set(place.district, seen);
}

const km = (m) => `${(m / 1000).toFixed(1)} km`;

console.log(`districts: ${districts.size}`);
for (const name of [...districts.keys()].sort()) {
  const d = districts.get(name);
  const flag = d.worst > FAR_M ? "  <-- FAR" : "";
  console.log(
    `  ${name.padEnd(20)} ${String(d.count).padStart(3)} places  ` +
    `worst nearest ${km(d.worst).padStart(8)}  (${d.worstAt.name})${flag}`);
}

if (far.length > 0) {
  console.log(`\n${far.length} place(s) whose nearest safe place is over ${FAR_M / 1000} km.`);
  console.log(`These are not failures: the screen says so and lists them anyway.`);
  for (const { place, nearest } of far.slice(0, 10)) {
    console.log(`  ${place.name.padEnd(28)} (${place.district}) -> ` +
                `${km(nearest.distanceM)} ${nearest.compass} to ` +
                `${nearest.place.name || typeLabel(nearest.place.type)}`);
  }
  if (far.length > 10) console.log(`  ...and ${far.length - 10} more`);
}

console.log(`\nchecked ${selectable.length} selectable places across ${districts.size} districts`);

if (failures.length > 0) {
  console.error(`\n${failures.length} FAILURE(S):`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}

console.log("every place returns at least one safe place with finite distance and bearing.");
