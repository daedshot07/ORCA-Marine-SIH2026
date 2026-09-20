#!/usr/bin/env node
/**
 * Generate the home screen icons: a white orca dorsal fin on black.
 *
 *   node tools/make-icons.mjs            write public/icons/*.png
 *   node tools/make-icons.mjs --preview  draw it in the terminal instead
 *
 * The PNGs are written by hand with node:zlib rather than by an image
 * library, because one icon is not worth a dependency and the whole point of
 * this app is that it ships almost nothing to the device.
 *
 * Greyscale, 8 bit. The fin edges are antialiased, which is the one place
 * grey pixels are allowed: they are there to make a shape legible at 48 px,
 * not to carry meaning. Nothing in the interface itself uses a grey.
 *
 * Output is committed. It is a design asset, not a build artefact, and
 * regenerating it on every build would churn the icon a user has already
 * pinned to their home screen.
 */

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

// --- the mark ---------------------------------------------------------------

/**
 * A dorsal fin in a unit square, y measured downward.
 *
 * Tip up and to the right, base sweeping left, trailing edge scooped. That is
 * the orca silhouette rather than a generic triangle, and it still reads at
 * 48 px because it is one closed shape with no interior detail.
 */
// An orca dorsal fin, not a shark fin, not a sail and not a tent.
//
// The whale is swimming right, so the fin rakes BACK: the tip sits well to the
// left of the base, at x 0.30 against a base reaching 0.86. That asymmetry is
// the whole silhouette. A symmetric shape, however nicely curved, reads as a
// triangle standing on a line.
//
// The right edge is the long, gently convex leading sweep. The left edge is
// short and scooped. Both flare into the base, because a fin grows out of a
// body rather than balancing on it.
//
// Both edges are cubics: a quadratic cannot bow outward near the tip and also
// arrive at the base on a shallow tangent, and losing that flare is what made
// the earlier attempts look like a sail.
const TIP = [0.30, 0.12];
const BASE_LEFT = [0.22, 0.88];
const BASE_RIGHT = [0.86, 0.88];
//                    flare at the base      convex below the tip
const LEADING = [[0.66, 0.87], [0.46, 0.22]];   // base right -> tip
const TRAILING = [[0.34, 0.42], [0.30, 0.80]];  // tip -> base left

function cubic(p0, c1, c2, p1, steps) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p1[0],
      u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p1[1],
    ]);
  }
  return out;
}

function finPolygon() {
  return [
    ...cubic(TIP, TRAILING[0], TRAILING[1], BASE_LEFT, 64),
    ...cubic(BASE_RIGHT, LEADING[0], LEADING[1], TIP, 64),
  ];
}

function inside(poly, x, y) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      hit = !hit;
    }
  }
  return hit;
}

/**
 * Render to an 8-bit greyscale buffer.
 *
 * `inset` shrinks the mark toward the centre without shrinking the black
 * field, which is what a maskable icon needs: the launcher may crop to a
 * circle, so the shape has to sit inside the safe zone while the background
 * still reaches every corner.
 */
function render(size, inset = 0) {
  const poly = finPolygon();
  const px = new Uint8Array(size * size); // 0 = black field
  const SS = 4;                            // supersampling per axis
  const scale = 1 - 2 * inset;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let lit = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = ((x + (sx + 0.5) / SS) / size - inset) / scale;
          const v = ((y + (sy + 0.5) / SS) / size - inset) / scale;
          if (u >= 0 && u <= 1 && v >= 0 && v <= 1 && inside(poly, u, v)) lit++;
        }
      }
      px[y * size + x] = Math.round((lit / (SS * SS)) * 255);
    }
  }
  return px;
}

// --- PNG --------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function png(size, px) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 0;   // colour type 0, greyscale
  ihdr[10] = 0;  // deflate
  ihdr[11] = 0;  // adaptive filtering
  ihdr[12] = 0;  // no interlace

  // One filter byte per scanline, filter type 0. A flat two-tone image
  // deflates to almost nothing, so there is no reason to be cleverer.
  const raw = Buffer.alloc(size * (size + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size + 1)] = 0;
    Buffer.from(px.subarray(y * size, (y + 1) * size))
      .copy(raw, y * (size + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- output -----------------------------------------------------------------

if (process.argv.includes("--preview")) {
  const size = 24;
  for (const [label, inset] of [["icon", 0], ["maskable", 0.12]]) {
    const px = render(size, inset);
    console.log(`\n${label} (${size}x${size}, # black, . white)`);
    for (let y = 0; y < size; y++) {
      let row = "";
      for (let x = 0; x < size; x++) {
        const v = px[y * size + x];
        row += v > 190 ? "." : v > 64 ? "+" : "#";
      }
      console.log("  " + row);
    }
  }
  process.exit(0);
}

mkdirSync("public/icons", { recursive: true });

const OUTPUTS = [
  { file: "icon-192.png", size: 192, inset: 0 },
  { file: "icon-512.png", size: 512, inset: 0 },
  // Maskable: the launcher may crop to a circle, so the mark sits inside the
  // safe zone while the black field still bleeds to every corner.
  { file: "icon-512-maskable.png", size: 512, inset: 0.12 },
];

for (const { file, size, inset } of OUTPUTS) {
  const buf = png(size, render(size, inset));
  writeFileSync(`public/icons/${file}`, buf);
  console.log(`public/icons/${file}  ${size}x${size}  ${buf.length} bytes`);
}
