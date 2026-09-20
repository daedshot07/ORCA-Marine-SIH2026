#!/usr/bin/env node
/**
 * Render the screen against a stub DOM built from the real index.html.
 *
 *   node tools/screen-check.mjs public/bundles/kerala-tn.orcabundle
 *
 * This is not a visual test and does not pretend to be one. What it proves is
 * the wiring, which is the part that fails silently: every id the renderer
 * writes to actually exists in the markup, every element gets filled, and the
 * rules that must hold in the output really hold on real data.
 *
 * The stub only knows the id attributes in index.html, so asking for an id
 * that is not there is an error rather than a null nobody notices.
 */

import { readFileSync } from "node:fs";

const bundlePath = process.argv[2] ?? "public/bundles/kerala-tn.orcabundle";

// --- a DOM just large enough for src/ui/screen.ts ---------------------------

const html = readFileSync("index.html", "utf8");
const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);

class Node {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this._text = "";
    this.className = "";
    this.hidden = false;
    this.value = "";
  }
  set textContent(v) {
    this._text = String(v);
    this.children = [];
  }
  get textContent() {
    return this.children.length > 0
      ? this.children.map((c) => c.textContent).join(" ")
      : this._text;
  }
  append(...kids) { this.children.push(...kids); }
  replaceChildren(...kids) { this.children = kids; this._text = ""; }
}

const nodes = new Map(ids.map((id) => [id, new Node("div")]));
const asked = new Set();

globalThis.document = {
  getElementById(id) {
    asked.add(id);
    if (!nodes.has(id)) {
      throw new Error(
        `screen.ts asked for #${id}, which does not exist in index.html`,
      );
    }
    return nodes.get(id);
  },
  createElement: (tag) => new Node(tag),
};

// --- render ----------------------------------------------------------------

const { parseBundle } = await import("../src/bundle/reader.ts");
const screen = await import("../src/ui/screen.ts");

const file = readFileSync(bundlePath);
const bundle = parseBundle(
  file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength),
);

const places = screen.selectablePlaces(bundle);
const districts = screen.districtsOf(places);
console.log(`${places.length} selectable places across ${districts.length} districts`);
console.log(`  first district: ${districts[0]}, last: ${districts.at(-1)}`);

const districtSelect = new Node("select");
screen.fillSelect(districtSelect, districts);
const placeSelect = new Node("select");
screen.fillPlaceSelect(placeSelect, places.filter((p) => p.district === districts[0]));
console.log(
  `  select population: ${districtSelect.children.length} districts, ` +
  `${placeSelect.children.length} places in ${districts[0]}`,
);
if (districtSelect.children.length !== districts.length) {
  throw new Error("district select was not fully populated");
}

const problems = [];
const seen = new Set();
const midMs = bundle.forecastStartMs + Math.floor(bundle.nHours / 2) * bundle.hourStepMs;

screen.renderRegion(bundle);

for (const place of places) {
  screen.renderPlace(bundle, place, midMs);

  const line = nodes.get("verdictLine").textContent;
  const cls = nodes.get("verdict").className;
  const level = cls.replace("verdict verdict--", "");
  seen.add(level);

  // The rule the whole screen exists to protect: a word never stands alone.
  if (level !== "nodata" && !/\d/.test(line)) {
    problems.push(`${place.name}: verdict "${line}" has no number in it`);
  }
  if (level === "nodata" && !/not the same as safe/i.test(line)) {
    problems.push(`${place.name}: no-data verdict does not say it is not safe`);
  }
  if (level === "nodata" && /\bSAFE TO GO\b/.test(line)) {
    problems.push(`${place.name}: a no-data area rendered as safe`);
  }

  for (const id of ["boundaryValue", "harbourValue", "ageValue", "reference"]) {
    if (nodes.get(id).textContent.trim() === "") {
      problems.push(`${place.name}: #${id} rendered empty`);
    }
  }

  // Provenance must always carry the boundary disclaimer, since a distance to
  // an advisory line is shown next to it.
  if (!nodes.get("provBody").textContent.includes("Survey of India")) {
    problems.push(`${place.name}: provenance lost the boundary disclaimer`);
  }
}

// Ids owned by main.ts rather than by the renderer: the selector, the file
// input and the panels main.ts shows or hides. Everything else in the markup
// must be something renderPlace actually fills, or it is dead weight that a
// typo could hide behind.
const WIRED_BY_MAIN = new Set([
  "app", "pick", "district", "place", "changeAreaButton",
  "textModeButton", "textModeClose", "textMode", "textModeBody",
  // staging-only chat, owned by src/ui/chat.ts and hidden unless the flag is on
  "chatButton", "chat", "chatClose", "chatOffline", "chatLog", "chatInput", "chatSend",
  "load", "loadHint", "loadError", "file", "source",
  "prov",
  // the map screen, owned by src/map/view.ts
  "actions", "locateButton", "placeButton", "locate",
  "mapCanvas", "centreMe", "legend", "rest",
  // the escape screen, owned by src/ui/escape.ts
  "escape", "escapeOpen", "escapeClose", "escapeStatus", "escapeArrowWrap",
  "escapeArrowMark", "escapeGo", "escapeTargetName", "escapeDist",
  "escapeCompass", "escapeList", "escapeListNote", "escapeMap", "escapeManual",
  "escapeManualSelect", "escapeManualUse", "escapeSource",
  "escapeGmaps", "escapeGmapsNote",
  // sea mode, owned by src/ui/sea.ts
  "sea", "seaOpen", "seaClose", "seaStatus", "seaImbl", "seaArrowWrap",
  "seaArrowMark", "seaSteer", "seaTargetName", "seaDetail", "seaCompass",
  "seaRoute", "seaSpeed", "seaList", "seaMap", "seaManual",
  "seaManualSelect", "seaManualUse", "seaSos", "seaSosPos", "seaSosSms",
  "seaSosCall", "seaDisclaimer", "seaTide",
]);
const unused = ids.filter((id) => !asked.has(id) && !WIRED_BY_MAIN.has(id));
if (unused.length > 0) {
  problems.push(`markup has ids nothing writes to: ${unused.join(", ")}`);
}

// --- the [hidden] cascade ---------------------------------------------------
//
// THE BUG THIS GUARDS. `hidden` takes its display:none from the USER AGENT
// stylesheet, so any author rule that sets `display` outranks it. `.escape` is
// display:flex and starts hidden, so the escape overlay -- position:fixed,
// inset:0, z-index:10 -- painted itself over the home screen on page load,
// empty, and its CLOSE button could not put it away because setting the
// attribute had already lost to the class.
//
// One global rule fixes the whole class of bug. This check makes sure it stays.
const styleSheet = readFileSync("src/ui/style.css", "utf8");
if (!/\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(styleSheet)) {
  problems.push(
    "style.css has no `[hidden] { display: none !important }` rule. Without " +
    "it any class that sets `display` outranks the hidden attribute, and an " +
    "element meant to start hidden renders anyway.",
  );
}

// Every element that starts hidden, cross-checked against classes that set a
// display. These are only safe BECAUSE of the rule above; listing them keeps
// the reason visible.
const startsHidden = [...html.matchAll(/class="([^"]+)"[^>]*\shidden[\s>]/g)]
  .flatMap((m) => m[1].split(/\s+/));
const overridden = startsHidden.filter((cls) =>
  new RegExp(`^\\.${cls.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s,{][^}]*display:`, "m").test(styleSheet));
if (overridden.length > 0) {
  console.log(`  [hidden] cascade: ${overridden.length} hidden element(s) carry a ` +
              `display rule (${[...new Set(overridden)].join(", ")}) and rely on the ` +
              `global override`);
}

// A <details> must never carry a `display` rule.
//
// Setting display on a <details> stops the browser hiding its contents while
// it is closed, so the disclosure cannot collapse. "Change area" shipped like
// that: permanently expanded, and the button that opened it appeared dead.
for (const tag of html.matchAll(/<details[^>]*class="([^"]+)"[^>]*>/g)) {
  for (const cls of tag[1].split(/\s+/)) {
    const rule = new RegExp(`^\\.${cls.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s,{][^}]*`, "m")
      .exec(styleSheet);
    if (rule !== null && /display:/.test(rule[0])) {
      problems.push(
        `.${cls} is on a <details> and sets \`display\`, which stops the ` +
        `browser collapsing it. Move the layout to an inner wrapper.`,
      );
    }
  }
}

// The escape overlay must not be open on load.
const escapeTag = /<section[^>]*id="escape"[^>]*>/.exec(html);
if (escapeTag === null || !/\shidden[\s>]/.test(escapeTag[0])) {
  problems.push(
    "the escape overlay does not start hidden in the markup, so it would " +
    "cover the home screen on page load",
  );
}

// The position path writes the same elements from a GPS fix rather than a
// chosen place. Exercised here so both render paths are covered, including the
// one that must refuse to produce a number.
const OFF_KOCHI = { lat: 9.92, lon: 76.10, accuracyM: 12, at: Date.now() };
const FAR_AWAY = { lat: 28.6139, lon: 77.209, accuracyM: 40, at: Date.now() };

screen.renderPosition(bundle, OFF_KOCHI, midMs);
const inside = nodes.get("verdictLine").textContent;
if (!/\d/.test(inside)) problems.push("position inside the region rendered no number");

screen.renderPosition(bundle, FAR_AWAY, midMs);
const outside = nodes.get("verdictLine").textContent;
if (!/OUTSIDE COVERED AREA/.test(outside)) {
  problems.push(`position far outside rendered: ${outside}`);
}
if (/\d+\.\d%/.test(outside)) {
  problems.push("a position outside every area rendered a percentage");
}
console.log(`  position path: inside gives a number, outside gives none`);

// --- the land mask ---------------------------------------------------------
//
// The cases that matter are the ones where the CELL LOOKUP STILL SUCCEEDS,
// because those are the only ones that prove the land test runs first. Munnar
// is inland but its cell lookup returns null, so it would pass this check even
// with the ordering wrong. The two coastal points below would not:
//
//   8.18, 77.72   1.3 km inland near Kanyakumari, rendered CAUTION at 18.5%
//   13.00, 79.52  81 km inland in Tamil Nadu, rendered SAFE TO GO OUT
const { parseLand, onLand } = await import("../src/geo/land.ts");
const landFile = readFileSync("public/land/india-land.bin");
const land = parseLand(
  landFile.buffer.slice(landFile.byteOffset, landFile.byteOffset + landFile.byteLength),
);

const ASHORE = [
  ["1.3 km inland near Kanyakumari, which had a CAUTION verdict", 8.18, 77.72],
  ["81 km inland in Tamil Nadu, which had a SAFE verdict", 13.00, 79.52],
  ["Munnar, inland Kerala, inside the region bbox", 10.089, 77.059],
  ["Jalandhar, Punjab", 31.33, 75.58],
  ["Chennai, just ashore", 13.0500, 80.2824],
];
const AFLOAT = [
  ["off Kochi", 9.92, 76.10],
  ["Bay of Bengal off Chennai", 13.05, 80.45],
];

for (const [name, lat, lon] of ASHORE) {
  if (!onLand(land, lat, lon)) problems.push(`${name} was not detected as land`);
  screen.renderPosition(bundle, { lat, lon, accuracyM: 15, at: Date.now() }, midMs, land);
  const line = nodes.get("verdictLine").textContent;
  if (!/ON LAND/.test(line)) problems.push(`${name} rendered: ${line}`);
  if (/\d+\.\d%/.test(line)) problems.push(`${name} rendered a sea probability`);
  if (!/\d/.test(line)) problems.push(`${name} rendered no distance`);
}

for (const [name, lat, lon] of AFLOAT) {
  if (onLand(land, lat, lon)) problems.push(`${name} was wrongly detected as land`);
}

// The ordering, stated as its own assertion: this point IS on land AND the cell
// lookup does return a forecast cell for it. If the land test ever moves after
// the lookup, this is the line that fails.
const { locate } = await import("../src/compute/locate.ts");
if (locate(bundle, 8.18, 77.72).cellIndex === null) {
  problems.push(
    "the ordering test point no longer resolves to a cell, so it no longer " +
    "proves the land check runs before the cell lookup; pick another",
  );
}

// Without the mask the app must not quietly assume open water. Munnar with no
// mask falls back to the cell lookup, which is exactly the old bug -- so the
// screen has to admit the check did not run.
screen.renderPosition(bundle, { lat: 10.089, lon: 77.059, accuracyM: 15, at: Date.now() }, midMs, null);
if (!/LAND CHECK DID NOT RUN/.test(nodes.get("provBody").textContent)) {
  problems.push("a missing land mask was not disclosed on screen");
}

console.log(`  land mask: ${land.ringCount} rings, ${ASHORE.length} inland points ` +
            `refuse a verdict, ${AFLOAT.length} sea points keep one`);

// The layout rule, checked against the markup rather than trusted to CSS: the
// verdict and all three figures must sit OUTSIDE the scrolling region, so
// nothing added later can push them below the fold on a 360 by 640 phone.
const restStart = html.indexOf('id="rest"');
for (const id of ["verdict", "figures", "boundaryValue", "harbourValue", "ageValue"]) {
  const at = html.indexOf(`id="${id}"`);
  if (at > restStart) {
    problems.push(
      `#${id} is inside the scrolling region; it must be above it so it stays ` +
      `visible without scrolling`,
    );
  }
}
if (html.indexOf('id="mapCanvas"') > html.indexOf('id="verdict"')) {
  problems.push("the map must come before the verdict on the screen");
}

// The legend swatches are CSS and the map cells are canvas, so the four tints
// exist in two files. A legend that disagrees with the map it explains is
// worse than no legend, so they are compared rather than commented.
const css = readFileSync("src/ui/style.css", "utf8");
const consts = await import("../src/constants.ts");
for (const [name, cssVar] of [
  ["TINT_DANGER", "--tint-danger"],
  ["TINT_CAUTION", "--tint-caution"],
  ["TINT_SAFE", "--tint-safe"],
  ["TINT_NODATA", "--tint-nodata"],
]) {
  const m = new RegExp(`${cssVar}:\\s*(#[0-9a-fA-F]{6})`).exec(css);
  if (m === null) problems.push(`style.css has no ${cssVar}`);
  else if (m[1].toLowerCase() !== consts[name].toLowerCase()) {
    problems.push(
      `${name} is ${consts[name]} in constants.ts but ${m[1]} in style.css; ` +
      `the legend would not match the map`,
    );
  }
}
console.log("  legend tints match the map");

console.log(`  rendered all ${places.length} places`);
console.log(`  verdict levels seen: ${[...seen].sort().join(", ")}`);

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems.slice(0, 10)) console.error(`  ${p}`);
  process.exit(1);
}

console.log("\nScreen wiring OK.");
