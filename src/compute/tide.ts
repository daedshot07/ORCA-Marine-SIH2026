/**
 * Tide prediction on the device, with no network and no model data.
 *
 * This is a real prediction, not a cached table of answers. The device
 * evaluates the harmonic sum itself for whatever time it is asked about:
 *
 *     h(t) = Z0 + SUM  f * A * cos( w*(t - t_month) + (V0+u) - g )
 *
 * A (amplitude) and g (Greenwich phase lag) were fitted from fifteen years of
 * observed hourly sea level by builder/fit_tides.py. w is the constituent's
 * angular speed. f and (V0+u) are the nodal corrections, tabulated per month
 * at build time because they drift on an 18.6-year cycle and are effectively
 * constant across a month -- so they are genuinely applied, just not
 * recomputed here. That script's docstring is the normative description.
 *
 * ASTRONOMICAL TIDE ONLY. Storm surge, wind setup and river flood all add on
 * top of this and none of them are in here. During the weather this app exists
 * to warn about, the water will be higher than this curve says. Every screen
 * that shows a number from this module has to say so.
 *
 * HEIGHTS ARE ABOUT RECENT MEAN SEA LEVEL, NOT CHART DATUM. Use the shape and
 * the timing. Do not use the absolute number to work out depth under a keel.
 */

export interface TidePort {
  id: string;
  name: string;
  lat: number;
  lon: number;
  coast: string;
  kmFromNagapattinam: number;
  z0: number;
  constituents: string[];
  speedDegPerHour: number[];
  amplitudeM: number[];
  phaseDeg: number[];
  /** Month starts, in epoch milliseconds, ascending. */
  monthStartMs: number[];
  /** Node factor per month per constituent. */
  f: number[][];
  /** Equilibrium argument (V0+u) in degrees, per month per constituent. */
  vuDeg: number[][];
  validation: {
    days: number;
    rmsErrorM: number;
    meanLevelOffsetM: number;
    rmsAfterOffsetRemovedM: number;
    worstErrorM: number;
    observedRangeM: number;
  };
  recordStart: string;
  recordEnd: string;
}

export interface Tides {
  regionId: string;
  attribution: string;
  noGaugeNear: string;
  datumNote: string;
  ports: TidePort[];
}

const URL_FOR = (regionId: string) => `/tides/${regionId}.json`;
const DEG = Math.PI / 180;

interface RawPort {
  id: string; name: string; lat: number; lon: number; coast: string;
  km_from_nagapattinam: number; z0: number; constituents: string[];
  speed_deg_per_hour: number[]; amplitude_m: number[]; phase_deg: number[];
  record_start: string; record_end: string;
  validation: {
    days: number; rms_error_m: number; mean_level_offset_m: number;
    rms_after_offset_removed_m: number; worst_error_m: number;
    observed_range_m: number;
  };
  nodal: { month_start_iso: string[]; f: number[][]; vu_deg: number[][] };
}

export function parseTides(raw: unknown): Tides {
  const file = raw as {
    v: number; region_id: string; attribution: string; no_gauge_near: string;
    datum_note: string; ports: RawPort[];
  };
  if (file.v > 1) throw new Error(`tide file is version ${file.v}; this app reads 1`);
  return {
    regionId: file.region_id,
    attribution: file.attribution,
    noGaugeNear: file.no_gauge_near,
    datumNote: file.datum_note,
    ports: file.ports.map((p) => ({
      id: p.id,
      name: p.name,
      lat: p.lat,
      lon: p.lon,
      coast: p.coast,
      kmFromNagapattinam: p.km_from_nagapattinam,
      z0: p.z0,
      constituents: p.constituents,
      speedDegPerHour: p.speed_deg_per_hour,
      amplitudeM: p.amplitude_m,
      phaseDeg: p.phase_deg,
      monthStartMs: p.nodal.month_start_iso.map((s) => Date.parse(s)),
      f: p.nodal.f,
      vuDeg: p.nodal.vu_deg,
      validation: {
        days: p.validation.days,
        rmsErrorM: p.validation.rms_error_m,
        meanLevelOffsetM: p.validation.mean_level_offset_m,
        rmsAfterOffsetRemovedM: p.validation.rms_after_offset_removed_m,
        worstErrorM: p.validation.worst_error_m,
        observedRangeM: p.validation.observed_range_m,
      },
      recordStart: p.record_start,
      recordEnd: p.record_end,
    })),
  };
}

export async function loadTides(
  regionId: string, signal?: AbortSignal,
): Promise<Tides | null> {
  try {
    const res = await fetch(URL_FOR(regionId), { signal });
    if (!res.ok) return null;
    return parseTides(await res.json());
  } catch {
    return null;
  }
}

/**
 * The month bucket to take f and (V0+u) from.
 *
 * Returns -1 when the time is outside the tabulated range, which the caller
 * must treat as "cannot predict". Extrapolating past the table would quietly
 * drop the nodal correction and produce a curve that looks right and drifts.
 */
export function monthIndex(port: TidePort, atMs: number): number {
  const starts = port.monthStartMs;
  if (starts.length === 0 || atMs < starts[0]!) return -1;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= atMs) lo = mid;
    else hi = mid - 1;
  }
  // The last bucket is only good for the month it starts.
  const THIRTY_ONE_DAYS = 31 * 86400000;
  if (lo === starts.length - 1 && atMs - starts[lo]! > THIRTY_ONE_DAYS) return -1;
  return lo;
}

/** Height in metres above the port's datum, or null outside the table. */
export function tideHeight(port: TidePort, atMs: number): number | null {
  const m = monthIndex(port, atMs);
  if (m === -1) return null;

  const hours = (atMs - port.monthStartMs[m]!) / 3600000;
  const f = port.f[m]!;
  const vu = port.vuDeg[m]!;

  let h = port.z0;
  for (let i = 0; i < port.amplitudeM.length; i++) {
    const angle = (port.speedDegPerHour[i]! * hours + vu[i]! - port.phaseDeg[i]!) * DEG;
    h += f[i]! * port.amplitudeM[i]! * Math.cos(angle);
  }
  return h;
}

export interface TideExtreme {
  atMs: number;
  heightM: number;
  kind: "high" | "low";
}

/**
 * High and low waters in a window.
 *
 * Sampled every five minutes, then each turning point refined by fitting a
 * parabola through the three samples around it. Five minutes is far finer than
 * the fifteen-minute rounding anyone reads off a tide table, and the parabola
 * removes the sampling bias in the height, which matters because the height is
 * quoted to a centimetre.
 */
export function tideExtremes(
  port: TidePort, fromMs: number, toMs: number,
): TideExtreme[] {
  const STEP = 5 * 60000;
  const out: TideExtreme[] = [];

  let prev = tideHeight(port, fromMs - STEP);
  let cur = tideHeight(port, fromMs);
  if (prev === null || cur === null) return out;

  for (let t = fromMs; t <= toMs; t += STEP) {
    const next = tideHeight(port, t + STEP);
    if (next === null) break;
    const rising = cur > prev && cur >= next;
    const falling = cur < prev && cur <= next;
    if (rising || falling) {
      // Parabola through (-1, prev), (0, cur), (+1, next): the vertex offset
      // is half the ratio below, in units of one step.
      const denom = prev - 2 * cur + next;
      const shift = denom === 0 ? 0 : (0.5 * (prev - next)) / denom;
      const peak = cur - 0.25 * (prev - next) * shift;
      out.push({
        atMs: t + shift * STEP,
        heightM: peak,
        kind: rising ? "high" : "low",
      });
    }
    prev = cur;
    cur = next;
  }
  return out;
}

/** A curve for drawing: `samples` points evenly spaced across the window. */
export function tideCurve(
  port: TidePort, fromMs: number, toMs: number, samples = 145,
): Array<{ atMs: number; heightM: number }> | null {
  const out: Array<{ atMs: number; heightM: number }> = [];
  for (let i = 0; i < samples; i++) {
    const atMs = fromMs + ((toMs - fromMs) * i) / (samples - 1);
    const heightM = tideHeight(port, atMs);
    if (heightM === null) return null;
    out.push({ atMs, heightM });
  }
  return out;
}

/** The tabulated port nearest a position, with how far away that is. */
export function nearestPort(
  tides: Tides, lat: number, lon: number,
): { port: TidePort; km: number } | null {
  let best: { port: TidePort; km: number } | null = null;
  for (const port of tides.ports) {
    const dLat = (port.lat - lat) * 111.32;
    const dLon = (port.lon - lon) * 111.32 * Math.cos(lat * DEG);
    const km = Math.hypot(dLat, dLon);
    if (best === null || km < best.km) best = { port, km };
  }
  return best;
}
