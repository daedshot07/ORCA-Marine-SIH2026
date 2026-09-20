/**
 * The four hazard fills, as canvas patterns.
 *
 * Each state differs in PATTERN, not only in density, so none of them can be
 * confused with a lighter version of another when the screen is dim. Colour
 * sits behind the pattern as a second, redundant channel: strip the hue and
 * every state is still tellable apart, which is what keeps this readable on a
 * washed-out screen in sunlight and to a colourblind reader.
 *
 * The same four marks appear in the verdict block and in the legend, so nobody
 * has to learn two visual languages between them.
 */

import {
  TINT_CAUTION,
  TINT_DANGER,
  TINT_NODATA,
  TINT_SAFE,
} from "../constants.ts";

export type FillKind = "danger" | "caution" | "safe" | "nodata";

const INK = "#000";

function tile(
  size: number, dpr: number, ground: string,
  paint: (c: CanvasRenderingContext2D) => void,
): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.round(size * dpr);
  c.height = Math.round(size * dpr);
  const ctx = c.getContext("2d")!;
  ctx.scale(dpr, dpr);
  // The tint is the ground; the black pattern is printed over it and stays the
  // mark that carries the meaning.
  ctx.fillStyle = ground;
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = INK;
  ctx.fillStyle = INK;
  paint(ctx);
  return c;
}

export interface Patterns {
  danger: CanvasPattern;
  caution: CanvasPattern;
  nodata: CanvasPattern;
  /** Safe has no pattern, only its tint. The one quiet state, and it earns it. */
  safe: null;
}

/**
 * Built once per device pixel ratio. Rebuilding a pattern per frame is the
 * usual reason a canvas map stutters on a cheap phone.
 */
export function makePatterns(ctx: CanvasRenderingContext2D, dpr: number): Patterns {
  // DANGER: dense diagonal hatch. Heaviest mark on the map, matching the
  // inverted verdict block, and it reads as dark at a glance from arm's length.
  const danger = tile(8, dpr, TINT_DANGER, (c) => {
    c.lineWidth = 2.2;
    for (let i = -8; i <= 16; i += 4) {
      c.beginPath();
      c.moveTo(i, 0);
      c.lineTo(i + 8, 8);
      c.stroke();
    }
  });

  // CAUTION: light dots. Clearly present, clearly lighter than danger, and a
  // different shape rather than the same hatch spaced further apart.
  const caution = tile(8, dpr, TINT_CAUTION, (c) => {
    c.beginPath();
    c.arc(2, 2, 1.15, 0, Math.PI * 2);
    c.fill();
    c.beginPath();
    c.arc(6, 6, 1.15, 0, Math.PI * 2);
    c.fill();
  });

  // NO DATA: a square grid, which is neither the diagonal of danger nor the
  // dots of caution. Deliberately NOT blank: an empty cell next to calm water
  // reads as calm, and this is the state most easily mistaken for good news.
  const nodata = tile(9, dpr, TINT_NODATA, (c) => {
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(0, 0.5); c.lineTo(9, 0.5);
    c.moveTo(0.5, 0); c.lineTo(0.5, 9);
    c.stroke();
  });

  const make = (t: HTMLCanvasElement): CanvasPattern => {
    const p = ctx.createPattern(t, "repeat")!;
    // The tile is drawn at device resolution, so it has to be scaled back down
    // into CSS pixels or it renders at a fraction of its intended size.
    p.setTransform(new DOMMatrix([1 / dpr, 0, 0, 1 / dpr, 0, 0]));
    return p;
  };

  return {
    danger: make(danger),
    caution: make(caution),
    nodata: make(nodata),
    safe: null,
  };
}

export function fillFor(patterns: Patterns, kind: FillKind): CanvasPattern | string {
  switch (kind) {
    case "danger": return patterns.danger;
    case "caution": return patterns.caution;
    case "nodata": return patterns.nodata;
    case "safe": return TINT_SAFE;
  }
}
