/**
 * The tide panel: next high and low water, and a day's curve.
 *
 * SVG rather than canvas, because it is a chart with six labels on it rather
 * than a thousand hexagons, and because it stays sharp at any zoom without a
 * device-pixel-ratio dance.
 *
 * Every number here is computed on the device by src/compute/tide.ts from
 * harmonic constants fitted to observed gauge data. Nothing is a cached
 * answer, and nothing needs a network.
 */

import {
  nearestPort,
  tideCurve,
  tideExtremes,
  tideHeight,
  type TidePort,
  type Tides,
} from "../compute/tide.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K, attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

function clockUTCOffsetMinutes(): number {
  // The device's own offset. Tide times are shown in local time because that
  // is the clock a fisherman is reading, and IST is what the coast runs on.
  return -new Date().getTimezoneOffset();
}

function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Render the panel.
 *
 * `lat`/`lon` choose the port and, more importantly, decide how loudly the
 * screen has to say that the port is somewhere else. There is no gauge near
 * Nagapattinam, so for most of this coast the honest answer involves a
 * distance in hundreds of kilometres and it is not buried.
 */
export function renderTide(
  root: HTMLElement, tides: Tides | null, lat: number | null, lon: number | null,
  nowMs: number,
): void {
  root.replaceChildren();
  if (tides === null || tides.ports.length === 0) {
    root.append(text("p", "tide__note", "No tide data on this device."));
    return;
  }

  const pick = lat === null || lon === null
    ? { port: tides.ports[0]!, km: Number.NaN }
    : nearestPort(tides, lat, lon)!;
  const port = pick.port;

  const now = tideHeight(port, nowMs);
  if (now === null) {
    root.append(text("p", "tide__note",
      `The tide table on this device runs from ${new Date(port.monthStartMs[0]!)
        .toISOString().slice(0, 10)} and has run out. Download the app again ` +
      `with a connection to refresh it.`));
    return;
  }

  // --- which port, and how far away it is --------------------------------
  const where = document.createElement("p");
  where.className = "tide__where";
  where.textContent = Number.isNaN(pick.km)
    ? `${port.name} — ${port.coast}`
    : `${port.name} — ${port.coast}, ${Math.round(pick.km)} km from you`;
  root.append(where);

  if (!Number.isNaN(pick.km) && pick.km > 75) {
    // The tide is a local thing. At this distance the curve is a different
    // ocean's, and saying so is the whole reason this line exists.
    root.append(text("p", "tide__far",
      `THIS IS ${port.name.toUpperCase()}'S TIDE, NOT YOURS. The nearest gauge ` +
      `is ${Math.round(pick.km)} km away. Times and heights where you are will ` +
      `differ, and on a different coast they will differ a lot.`));
  }

  // --- now, and the next two turns ---------------------------------------
  const DAY = 86400000;
  const extremes = tideExtremes(port, nowMs, nowMs + DAY);
  const nowLine = document.createElement("p");
  nowLine.className = "tide__now";
  nowLine.textContent = `Now ${now.toFixed(2)} m`;
  root.append(nowLine);

  const list = document.createElement("ul");
  list.className = "tide__turns";
  for (const e of extremes.slice(0, 4)) {
    const li = document.createElement("li");
    li.className = "tide__turn";
    const inMin = Math.round((e.atMs - nowMs) / 60000);
    const when = inMin < 60 ? `in ${inMin} min` : `in ${Math.floor(inMin / 60)} h ${inMin % 60} min`;
    li.textContent =
      `${e.kind === "high" ? "HIGH" : "LOW"} ${hhmm(e.atMs)} · ` +
      `${e.heightM.toFixed(2)} m · ${when}`;
    list.append(li);
  }
  if (extremes.length === 0) list.append(text("li", "tide__turn", "No turn in the next 24 hours."));
  root.append(list);

  root.append(drawCurve(port, nowMs));

  // --- what this is and is not -------------------------------------------
  root.append(text("p", "tide__warn",
    "ASTRONOMICAL TIDE ONLY. Storm surge, wind and river flood add on top. " +
    "In the weather this app warns about, the water will be higher than this."));
  root.append(text("p", "tide__note", tides.datumNote));
  root.append(text("p", "tide__note",
    `Fitted from ${port.recordStart.slice(0, 10)} to ${port.recordEnd.slice(0, 10)}. ` +
    `Checked against ${port.validation.days} days held out of the fit: ` +
    `${(port.validation.rmsAfterOffsetRemovedM * 100).toFixed(0)} cm RMS on the ` +
    `shape and timing, against an observed range of ` +
    `${port.validation.observedRangeM.toFixed(2)} m. Mean sea level itself moved ` +
    `${(port.validation.meanLevelOffsetM * 100).toFixed(0)} cm over that week, ` +
    `which is why the height is not a depth.`));
  root.append(text("p", "tide__note", tides.attribution));
}

function text(tag: string, className: string, content: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = content;
  return node;
}

/** A day of tide, now in the middle, as an SVG chart. */
function drawCurve(port: TidePort, nowMs: number): SVGSVGElement {
  const W = 320;
  const H = 120;
  const PAD_L = 30;
  const PAD_R = 8;
  const PAD_T = 10;
  const PAD_B = 20;

  const from = nowMs - 6 * 3600000;
  const to = nowMs + 18 * 3600000;
  const chart = svg("svg", {
    class: "tide__svg", viewBox: `0 0 ${W} ${H}`,
    preserveAspectRatio: "none", role: "img",
    "aria-label": "Tide height over the next 18 hours",
  });

  const curve = tideCurve(port, from, to, 145);
  if (curve === null) return chart;

  let lo = Infinity;
  let hi = -Infinity;
  for (const p of curve) {
    lo = Math.min(lo, p.heightM);
    hi = Math.max(hi, p.heightM);
  }
  const span = Math.max(0.2, hi - lo);
  lo -= span * 0.12;
  hi += span * 0.12;

  const X = (ms: number) => PAD_L + ((ms - from) / (to - from)) * (W - PAD_L - PAD_R);
  const Y = (m: number) => PAD_T + (1 - (m - lo) / (hi - lo)) * (H - PAD_T - PAD_B);

  // Axis and hour ticks, every three hours.
  chart.append(svg("line", {
    x1: PAD_L, y1: H - PAD_B, x2: W - PAD_R, y2: H - PAD_B,
    stroke: "#000", "stroke-width": 1.5,
  }));
  for (let t = Math.ceil(from / 10800000) * 10800000; t <= to; t += 10800000) {
    const x = X(t);
    chart.append(svg("line", {
      x1: x, y1: H - PAD_B, x2: x, y2: H - PAD_B + 4,
      stroke: "#000", "stroke-width": 1,
    }));
    const label = svg("text", {
      x, y: H - 6, "text-anchor": "middle", "font-size": 9,
      "font-weight": 700, fill: "#000",
    });
    label.textContent = hhmm(t);
    chart.append(label);
  }

  // Height labels: just the two ends, because this is read at a glance.
  for (const m of [lo + span * 0.12, hi - span * 0.12]) {
    const label = svg("text", {
      x: PAD_L - 4, y: Y(m) + 3, "text-anchor": "end", "font-size": 9,
      "font-weight": 700, fill: "#000",
    });
    label.textContent = `${m.toFixed(1)}`;
    chart.append(label);
  }

  const d = curve.map((p, i) =>
    `${i === 0 ? "M" : "L"}${X(p.atMs).toFixed(1)} ${Y(p.heightM).toFixed(1)}`).join("");
  chart.append(svg("path", {
    d, fill: "none", stroke: "#000", "stroke-width": 2.5,
    "stroke-linejoin": "round",
  }));

  // Now: a dashed vertical with a solid dot on the curve.
  const nowH = tideHeight(port, nowMs);
  chart.append(svg("line", {
    x1: X(nowMs), y1: PAD_T, x2: X(nowMs), y2: H - PAD_B,
    stroke: "#000", "stroke-width": 1.5, "stroke-dasharray": "4 3",
  }));
  if (nowH !== null) {
    chart.append(svg("circle", {
      cx: X(nowMs), cy: Y(nowH), r: 4.5, fill: "#000",
    }));
  }

  // High and low water, ringed so they read without colour.
  for (const e of tideExtremes(port, from, to)) {
    chart.append(svg("circle", {
      cx: X(e.atMs), cy: Y(e.heightM), r: 4, fill: "#fff",
      stroke: "#000", "stroke-width": 2,
    }));
  }

  void clockUTCOffsetMinutes;
  return chart;
}
