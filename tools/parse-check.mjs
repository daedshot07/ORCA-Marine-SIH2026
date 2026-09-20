#!/usr/bin/env node
/**
 * Run the app's own reader over a real bundle, outside a browser.
 *
 *   node tools/parse-check.mjs public/bundles/kerala-tn.orcabundle
 *
 * This imports exactly the modules the app ships, so it proves the DataView
 * parse and every computation before any UI is involved. If this prints the
 * right verdicts, the only thing left that can be wrong is the screen.
 *
 * It also exercises the cases a browser makes awkward to reach: a place with
 * no forecast cell, an hour before the forecast starts, and an hour after it
 * has run out.
 */

import { readFileSync } from "node:fs";

import { parseBundle } from "../src/bundle/reader.ts";
import { hazardAge, sourceLines } from "../src/compute/age.ts";
import { nearestBoundary, zoneLabel } from "../src/compute/boundary.ts";
import { nearestHarbour } from "../src/compute/harbour.ts";
import { hourIndexFor, outsideVerdict, verdictForCell } from "../src/compute/verdict.ts";
import { inRegion, locate, nearestPlace } from "../src/compute/locate.ts";

const path = process.argv[2] ?? "public/bundles/kerala-tn.orcabundle";
const file = readFileSync(path);
const buf = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);

const bundle = parseBundle(buf);

console.log(`${path}`);
console.log(
  `  format ${bundle.formatVersion}  ${bundle.nCells} areas x ${bundle.nHours} hours  ` +
  `H3 res ${bundle.h3Resolution}  ${file.byteLength.toLocaleString()} bytes`,
);
console.log(`  region ${bundle.meta.region_id}  ${bundle.meta.region_name}`);
console.log(`  ${bundle.zones.length} boundary zones, ${bundle.places.length} places`);
console.log(`  forecast ${bundle.meta.forecast_start} .. ${bundle.meta.forecast_end}`);

// Read the forecast at its own midpoint rather than at wall-clock now, so the
// output does not turn into a wall of NO DATA once the sample bundle ages out.
const midMs = bundle.forecastStartMs + Math.floor(bundle.nHours / 2) * bundle.hourStepMs;
const hour = hourIndexFor(bundle, midMs);
console.log(`  reading hour ${hour} of ${bundle.nHours} (${new Date(midMs).toISOString()})\n`);

const age = hazardAge(bundle, midMs);
console.log(`data age: ${age.text}${age.stale ? "  [STALE]" : ""}`);
for (const line of sourceLines(bundle, midMs)) console.log(`  ${line}`);
console.log("");

function show(place) {
  const hasCell = place.cellIndex !== null;
  const lat = hasCell ? bundle.cellLat[place.cellIndex] : place.lat;
  const lon = hasCell ? bundle.cellLon[place.cellIndex] : place.lon;

  const verdict = verdictForCell(bundle, place.cellIndex, hour);
  const boundary = nearestBoundary(bundle, lat, lon);
  const harbour = nearestHarbour(bundle, lat, lon);

  console.log(`${place.name}  (${place.district || "no district"})`);
  console.log(`  ${verdict.line}`);
  if (verdict.note) console.log(`  ${verdict.note}`);
  if (boundary !== null) {
    console.log(
      `  nearest boundary  ${(boundary.effectiveM / 1000).toFixed(1)} km ` +
      `${boundary.compass}  (${zoneLabel(boundary.zoneType)}, raw ` +
      `${(boundary.distanceM / 1000).toFixed(1)} km less a ` +
      `${(boundary.marginM / 1000).toFixed(1)} km margin)`,
    );
  }
  if (harbour !== null) {
    console.log(
      `  time to harbour   ${Math.round(harbour.seconds / 60)} min to ` +
      `${harbour.place.name} ${harbour.compass}  (optimistic)`,
    );
  }
  console.log(
    hasCell
      ? `  forecast for water ${(place.offsetM / 1000).toFixed(1)} km from the place\n`
      : `  no forecast area covers this place\n`,
  );
}

const named = ["Munambam", "Vizhinjam", "Rameswaram", "Chennai"];
for (const want of named) {
  const place = bundle.places.find((p) => p.name.startsWith(want) && p.district !== "");
  if (place !== undefined) show(place);
}

// A place the builder could not resolve to any forecast cell.
const unresolved = bundle.places.find((p) => p.cellIndex === null);
if (unresolved !== undefined) {
  console.log("--- a place with no forecast cell ---");
  show(unresolved);
}

// The two out-of-window cases. Neither may produce a number.
const sample = bundle.places.find((p) => p.cellIndex !== null);
console.log("--- outside the forecast window ---");
const before = verdictForCell(bundle, sample.cellIndex, hourIndexFor(bundle, bundle.forecastStartMs - 3_600_000));
console.log(`  before start: ${before.line}\n                ${before.note}`);
const after = verdictForCell(bundle, sample.cellIndex, hourIndexFor(bundle, bundle.forecastStartMs + bundle.nHours * bundle.hourStepMs));
console.log(`  after end:    ${after.line}\n                ${after.note}`);

for (const v of [before, after]) {
  if (v.p !== null) {
    console.error("\nFAIL: an out-of-window hour produced a number");
    process.exit(1);
  }
}

// The rule the whole encoding exists to protect.
const noData = verdictForCell(bundle, null, hour);
if (noData.level !== "nodata" || noData.p !== null || /SAFE/.test(noData.word)) {
  console.error("\nFAIL: a missing cell did not read as no data");
  process.exit(1);
}

// --- geometry and GPS ------------------------------------------------------

console.log("--- map geometry ---");
if (bundle.cellRings === null) {
  console.error("FAIL: no hexagons in this bundle");
  process.exit(1);
}
console.log(`  hexagons ${bundle.cellRings.length / 12} cells`);
console.log(
  bundle.coastline === null
    ? "  coastline: none"
    : `  coastline ${bundle.coastline.parts.length} parts, ` +
      `${bundle.coastline.parts.reduce((a, p) => a + p.length / 2, 0)} points`,
);

// Every cell must contain its own centre. This is the containment test the GPS
// path depends on, run against all 965 cells rather than a sample.
let misplaced = 0;
for (let c = 0; c < bundle.nCells; c++) {
  const got = locate(bundle, bundle.cellLat[c], bundle.cellLon[c]);
  if (got.cellIndex !== c) misplaced++;
}
if (misplaced > 0) {
  console.error(`\nFAIL: ${misplaced} cell centres resolve to the wrong cell`);
  process.exit(1);
}
console.log(`  every one of ${bundle.nCells} cell centres resolves to its own cell`);

console.log("\n--- GPS ---");

// A real position: just off Kochi, in the water this app is about.
const KOCHI = { lat: 9.92, lon: 76.10 };
const here = locate(bundle, KOCHI.lat, KOCHI.lon);
const hereVerdict = here.cellIndex === null
  ? outsideVerdict()
  : verdictForCell(bundle, here.cellIndex, hour);
const near = nearestPlace(bundle.places.filter((p) => p.district !== ""), KOCHI.lat, KOCHI.lon);
console.log(`  ${KOCHI.lat}, ${KOCHI.lon} (off Kochi)`);
console.log(`    in region: ${inRegion(bundle, KOCHI.lat, KOCHI.lon)}`);
console.log(`    cell ${here.cellIndex}, centre ${(here.offsetM / 1000).toFixed(1)} km away`);
console.log(`    ${hereVerdict.line}`);
console.log(`    nearest landing centre: ${near ? near.name : "none"}`);
if (here.cellIndex === null) {
  console.error("\nFAIL: a position in open water off Kochi resolved to no cell");
  process.exit(1);
}

// Far outside. This must never produce a verdict or a number.
const DELHI = { lat: 28.6139, lon: 77.2090 };
const away = locate(bundle, DELHI.lat, DELHI.lon);
const awayVerdict = away.cellIndex === null
  ? outsideVerdict()
  : verdictForCell(bundle, away.cellIndex, hour);
console.log(`  ${DELHI.lat}, ${DELHI.lon} (Delhi, far inland)`);
console.log(`    in region: ${inRegion(bundle, DELHI.lat, DELHI.lon)}`);
console.log(`    ${awayVerdict.line}`);
if (away.cellIndex !== null || awayVerdict.p !== null) {
  console.error("\nFAIL: a position far outside the region produced a cell or a number");
  process.exit(1);
}
if (!/OUTSIDE COVERED AREA/.test(awayVerdict.line)) {
  console.error("\nFAIL: an outside position did not say it was outside");
  process.exit(1);
}

console.log("\nParse and compute OK.");
