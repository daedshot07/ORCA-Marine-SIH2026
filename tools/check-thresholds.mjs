#!/usr/bin/env node
/**
 * Fail if any threshold this app shares with ORCA has drifted.
 *
 * src/constants.ts records where each number came from. A comment saying
 * "ORCA frontend/lib/verdict.ts:27" is true on the day it is written and
 * silently false the day someone edits that line. This turns the comment into
 * something that breaks.
 *
 *   node tools/check-thresholds.mjs
 *
 * Set ORCA_ROOT if the checkout is not at ~/SIH2026/orca. If ORCA is not
 * present the check is skipped rather than failed, because a machine that
 * only builds the app should not need the shore system on disk.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ORCA = process.env.ORCA_ROOT ?? join(homedir(), "SIH2026", "orca");

const CHECKS = [
  {
    ours: "CAUTION_AT",
    file: "frontend/lib/verdict.ts",
    name: "CAUTION_AT",
    kind: "ts",
  },
  {
    ours: "DO_NOT_GO_AT",
    file: "frontend/lib/verdict.ts",
    name: "DO_NOT_GO_AT",
    kind: "ts",
  },
  {
    ours: "LOW_CONFIDENCE_AT",
    file: "frontend/lib/verdict.ts",
    name: "LOW_CONFIDENCE_AT",
    kind: "ts",
  },
  {
    ours: "UNKNOWN_SPEED_MS",
    file: "backend/app/adapters/aisstream.py",
    name: "UNKNOWN_SPEED_MS",
    kind: "py",
  },
  {
    ours: "MIN_ASSUMED_SPEED_MS",
    file: "backend/app/core/recall.py",
    name: "MIN_ASSUMED_SPEED_MS",
    kind: "py",
  },
  {
    ours: "DETOUR_FACTOR",
    file: "backend/app/core/recall.py",
    name: "DETOUR_FACTOR",
    kind: "py",
  },
];

function extract(source, name, kind) {
  const prefix = kind === "ts" ? "export\\s+const\\s+" : "";
  const re = new RegExp(`^${prefix}${name}\\s*(?::[^=]+)?=\\s*(-?[0-9]*\\.?[0-9]+)`, "m");
  const m = re.exec(source);
  return m === null ? null : Number(m[1]);
}

const ours = await import("../src/constants.ts");

let checked = 0;
const problems = [];

for (const check of CHECKS) {
  const path = join(ORCA, check.file);
  let source;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    console.log(`skip  ${check.ours}: ${check.file} not readable`);
    continue;
  }

  const theirs = extract(source, check.name, check.kind);
  if (theirs === null) {
    problems.push(
      `${check.ours}: could not find ${check.name} in ${check.file}. ` +
      `It may have been renamed, which is a drift this check cannot resolve for you.`,
    );
    continue;
  }

  const mine = ours[check.ours];
  checked += 1;
  if (mine !== theirs) {
    problems.push(
      `${check.ours}: this app uses ${mine}, ORCA's ${check.file} says ${theirs}. ` +
      `Two systems telling one fisherman different things about the same sea.`,
    );
  } else {
    console.log(`ok    ${check.ours} = ${mine}  (${check.file})`);
  }
}

if (problems.length > 0) {
  console.error(`\n${problems.length} threshold problem(s):\n`);
  for (const p of problems) console.error(`  ${p}`);
  console.error("");
  process.exit(1);
}

if (checked === 0) {
  console.log(`\nNothing checked. ORCA was not found at ${ORCA}; set ORCA_ROOT.`);
} else {
  console.log(`\n${checked} thresholds match ORCA.`);
}
