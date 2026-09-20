/**
 * How old is this forecast, and how do we say so without overclaiming.
 *
 * Two rules from ORCA that the wording has to carry:
 *
 *   - `issued_time_kind: "fetch_proxy"` means ORCA recorded when it fetched,
 *     not when the model ran, because the upstream publishes no run time. The
 *     real forecast is AT LEAST this old and may be older. So the phrasing is
 *     "at least N hours old", never "N hours old".
 *   - a snapshot layer carries two different ages. The INCOIS landing centres
 *     were fetched today from a layer frozen in April 2024. Showing the fetch
 *     time alone would present positions that are years old as fresh.
 */

import { STALE_HOURS } from "../constants.ts";
import type { Bundle, SourceMeta } from "../bundle/types.ts";

export interface DataAge {
  /** Milliseconds since the forecast was issued, or null if unknowable. */
  ageMs: number | null;
  /** True when the underlying time is a fetch proxy, so this is a floor. */
  isLowerBound: boolean;
  /** Past the 12 hour rule in this project's CLAUDE.md. */
  stale: boolean;
  /** "at least 7 h old", "3 h old", "unknown". */
  text: string;
  /** The sources this was taken from, for the provenance line. */
  sources: SourceMeta[];
}

function hazardSources(bundle: Bundle): SourceMeta[] {
  return bundle.meta.sources.filter((s) => s.role === "hazard");
}

/**
 * Age of the hazard field.
 *
 * Taken from the OLDEST hazard source, not the newest. The verdict combines
 * every hazard variable, so it is only as current as the stalest input that
 * went into it; quoting the freshest would flatter the number.
 *
 * And taken from the forecast's issue time, NOT from the bundle's
 * `generated_at`. This gets proposed as a simplification often enough to be
 * worth writing down: `generated_at` is when the file was packed, which can be
 * many hours after the weather in it was fetched. On the first real bundle the
 * gap was 11.3 hours, because ORCA fetched at 05:16Z and the builder ran at
 * 16:36Z. Reporting that bundle as 0.4 hours old would have been true of the
 * file and false of the forecast, and it would have kept the 12 hour warning
 * from firing on half-day-old weather.
 *
 * The issue time is always the larger of the two, so it is also the safer one.
 *
 * Nothing here reads the network, so the age keeps counting while the device
 * is offline: it is the gap between a timestamp in the bundle and the device
 * clock. A wrong device clock therefore gives a wrong age, in either
 * direction, and there is no way to detect that offline.
 */
export function hazardAge(bundle: Bundle, nowMs: number): DataAge {
  const sources = hazardSources(bundle);
  let oldest: number | null = null;
  let isLowerBound = false;

  for (const s of sources) {
    const iso = s.issued_at ?? s.fetched_at;
    if (iso === undefined) continue;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) continue;
    if (oldest === null || t < oldest) oldest = t;
    if (s.age_is_lower_bound) isLowerBound = true;
  }

  if (oldest === null) {
    return {
      ageMs: null,
      isLowerBound: false,
      // Not knowing how old a forecast is is itself a reason not to lean on it.
      stale: true,
      text: "age unknown",
      sources,
    };
  }

  const ageMs = Math.max(0, nowMs - oldest);
  const hours = ageMs / 3_600_000;
  return {
    ageMs,
    isLowerBound,
    stale: hours >= STALE_HOURS,
    text: `${isLowerBound ? "at least " : ""}${formatAge(ageMs)} old`,
    sources,
  };
}

/** Whole units, because a forecast age to the minute implies a precision we lack. */
export function formatAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} days`;
}

/** Short absolute stamp, UTC, so two people reading it agree on when. */
function stamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}Z`;
}

/**
 * One line per source: what it is, when it was fetched, and how old that makes
 * it. Every source the bundle used appears here, including the ones that only
 * contributed boundaries or landing centres, because "where did this number
 * come from" should not need a second screen.
 *
 * Each carries its own kind of age rather than being averaged into one
 * reassuring figure: a fetch proxy is stated as a lower bound, and a frozen
 * snapshot is dated from the snapshot rather than from the download.
 */
export function sourceLines(bundle: Bundle, nowMs: number): string[] {
  return bundle.meta.sources.map((s) => {
    if (s.is_snapshot === true && s.snapshot_date !== undefined) {
      // The date that matters is the snapshot, not the fetch.
      const t = Date.parse(`${s.snapshot_date}T00:00:00Z`);
      const age = Number.isNaN(t) ? "unknown age" : `${formatAge(nowMs - t)} old`;
      const got = s.fetched_at === undefined ? "" :
        `, downloaded ${stamp(Date.parse(s.fetched_at))}`;
      return `${s.name}: frozen snapshot of ${s.snapshot_date}, ${age}${got}`;
    }

    const iso = s.fetched_at ?? s.issued_at;
    if (iso === undefined || iso === null) return `${s.name}: no date recorded`;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return `${s.name}: no date recorded`;

    const prefix = s.age_is_lower_bound ? "at least " : "";
    const kind = s.issued_time_kind === "fetch_proxy"
      ? " (fetch time; this source publishes no model run time)"
      : "";
    return `${s.name}: fetched ${stamp(t)}, ${prefix}${formatAge(nowMs - t)} old${kind}`;
  });
}
