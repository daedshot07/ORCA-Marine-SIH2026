/**
 * THE ONE PLACE the verdict word is decided.
 *
 * Ported from ORCA's frontend/lib/verdict.ts, which says the same of itself,
 * with the same thresholds and the same two phrasings. The point of copying
 * rather than reinventing is that a boat and a control room must not be told
 * different things about the same water.
 *
 * No LLM. The words below are a deterministic threshold on a probability that
 * ORCA's core/risk.py already computed. This file adds no arithmetic to that
 * number and never invents one. It only chooses which word sits next to it.
 *
 * The bands are advisory labels for a plain-language reading, NOT a safety
 * certification. The probability is the claim; the word is a label on it,
 * which is why the number is always shown alongside.
 */

import {
  CAUTION_AT,
  DO_NOT_GO_AT,
  LOW_CONFIDENCE_AT,
  NO_DATA,
  VALUE_SCALE,
} from "../constants.ts";
import type { Bundle } from "../bundle/types.ts";
import { formatKm } from "./format.ts";

export type VerdictLevel = "safe" | "caution" | "danger" | "nodata";

export interface Verdict {
  level: VerdictLevel;
  word: string;
  /** Probability in [0,1], or null when there is no forecast. */
  p: number | null;
  uncertainty: number | null;
  lowConfidence: boolean;
  /** Word and number together. There is no accessor that returns only a word. */
  line: string;
  /** Why there is no number, when there is none. */
  note: string;
}

/** Decode one stored byte. 255 is no data, and no data is not zero. */
export function decodeValue(b: number): number | null {
  return b === NO_DATA ? null : b / VALUE_SCALE;
}

/** One decimal place, matching ORCA's fmtPct. */
export function fmtPct(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

const NO_DATA_LINE =
  "NO DATA FOR THIS AREA — no forecast for this area. This is not the same as safe.";

export function noDataVerdict(note: string): Verdict {
  return {
    level: "nodata",
    word: "NO DATA FOR THIS AREA",
    p: null,
    uncertainty: null,
    lowConfidence: false,
    line: NO_DATA_LINE,
    note,
  };
}

/**
 * A position no forecast area covers.
 *
 * Kept separate from ordinary no-data because the reason differs and so does
 * what the reader should do about it: there is nothing wrong with the bundle,
 * they are simply somewhere it does not describe. It is still rendered in the
 * no-data style, and it still carries no number, because the one thing it must
 * never be mistaken for is a verdict.
 */
export function outsideVerdict(): Verdict {
  return {
    level: "nodata",
    word: "OUTSIDE COVERED AREA",
    p: null,
    uncertainty: null,
    lowConfidence: false,
    line: "OUTSIDE COVERED AREA — no forecast covers where you are. " +
      "This is not the same as safe.",
    note: "Download the bundle for the area you are in before going out.",
  };
}

/**
 * A position that is on dry land.
 *
 * Kept apart from both ordinary no-data and "outside covered area" because it
 * is a different fact with a different remedy, and because it is the one this
 * app used to get actively wrong. An inland position resolved to whichever
 * forecast hexagon covered it and was told how likely dangerous seas were: on
 * a grid over the Kerala-TN box, 5.4 per cent of land points got a sea verdict
 * that way, the worst of them CAUTION at 18.5 per cent for somewhere 1.3 km
 * inland. See the header of src/geo/land.ts for the measurement.
 *
 * It carries a number -- the distance to the coast -- so it does not break the
 * rule that no verdict word appears bare. But the number is a distance, never
 * a probability, and there is no path from here to one.
 */
export function onLandVerdict(distanceToCoastM: number | null): Verdict {
  const where = distanceToCoastM === null
    ? "You are on land."
    : `You are on land, ${formatKm(distanceToCoastM)} from the nearest coast.`;
  return {
    level: "nodata",
    word: "ON LAND",
    p: null,
    uncertainty: null,
    lowConfidence: false,
    line: `ON LAND — ${where} Marine forecast does not apply here.`,
    note: "The sea forecast describes water. It says nothing about where you " +
      "are standing.",
  };
}

/**
 * The verdict for one cell at one hour.
 *
 * `hourIndex` out of range is no data rather than a clamp to the nearest hour.
 * Carrying the last computed hour forward would present a forecast that has
 * run out as though it were current, and a phone that has been at sea for
 * three days is exactly where that happens.
 */
export function verdictForCell(
  bundle: Bundle, cellIndex: number | null, hourIndex: number,
): Verdict {
  if (cellIndex === null) {
    return noDataVerdict("No forecast area covers this place.");
  }
  if (hourIndex < 0) {
    return noDataVerdict("This forecast starts later than the time on this device.");
  }
  if (hourIndex >= bundle.nHours) {
    return noDataVerdict(
      "This forecast has run out. Download a new bundle before going out.",
    );
  }

  const at = cellIndex * bundle.nHours + hourIndex;
  const p = decodeValue(bundle.hazard[at]!);
  const u = decodeValue(bundle.uncertainty[at]!);

  if (p === null) {
    return noDataVerdict("No hazard was computed for this area at this hour.");
  }

  const level: VerdictLevel =
    p >= DO_NOT_GO_AT ? "danger" : p >= CAUTION_AT ? "caution" : "safe";
  const word =
    level === "danger" ? "DO NOT GO OUT"
      : level === "caution" ? "CAUTION"
        : "SAFE TO GO OUT";

  // Low confidence changes the wording and nothing else. Moving the verdict on
  // our own uncertainty would either cry wolf or hide a real risk behind our
  // ignorance; saying so lets the reader apply their own judgement.
  const lowConfidence = u !== null && u >= LOW_CONFIDENCE_AT;

  // The number is never optional. A bare "SAFE TO GO OUT" is an authority's
  // promise. "SAFE TO GO OUT — highest chance of dangerous seas is 0.4%" is a
  // measurement the reader can weigh, and disagree with.
  const head =
    level === "safe"
      ? `${word} — highest chance of dangerous seas is ${fmtPct(p)}`
      : `${word} — ${fmtPct(p)} chance of dangerous seas`;

  return {
    level,
    word,
    p,
    uncertainty: u,
    lowConfidence,
    line: lowConfidence ? `${head} · low confidence` : head,
    note: "",
  };
}

/**
 * Which hour of the forecast covers `nowMs`.
 *
 * Returns -1 when the bundle starts in the future and nHours or more when it
 * has run out; both are no data rather than a nearest-hour clamp.
 */
export function hourIndexFor(bundle: Bundle, nowMs: number): number {
  return Math.floor((nowMs - bundle.forecastStartMs) / bundle.hourStepMs);
}
