#!/usr/bin/env node
/**
 * Write dist/sw.js with a precache list generated from the real build.
 *
 *   node tools/build-sw.mjs        (runs automatically after `vite build`)
 *
 * Vite emits content-hashed filenames, so the list cannot be a literal in the
 * worker. This walks dist/, substitutes the list and a version string into
 * src/sw/sw.js, and writes the result.
 *
 * The version is a hash of the file CONTENTS, not a timestamp. A rebuild that
 * changes nothing therefore produces the same cache name, and nobody is made
 * to re-download a shell byte-identical to the one they already have. On a 2G
 * connection that distinction is the difference between an update costing
 * nothing and costing a minute.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";

const DIST = "dist";
const TEMPLATE = "src/sw/sw.js";
const OUT = join(DIST, "sw.js");

/** Everything under dist/, as root-relative URL paths. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const files = walk(DIST)
  .map((f) => relative(DIST, f).split(sep).join(posix.sep))
  .filter((f) => f !== "sw.js")     // the worker never caches itself
  .filter((f) => f !== "_headers")  // a Cloudflare control file, not an asset
  .sort();

if (files.length === 0) {
  console.error("dist/ is empty. Run `vite build` first.");
  process.exit(1);
}

/**
 * The shell, and the URL each file is actually served at.
 *
 * index.html is the one that cannot be listed by its filename. Cloudflare
 * Workers static assets answers /index.html with a 307 to /, so precaching
 * "/index.html" stores a response with `redirected` set, and Chrome refuses a
 * redirected response for a navigation request: the installed PWA dies on
 * launch with ERR_FAILED while an ordinary tab, which is often not yet under
 * the worker's control, looks fine. The document is precached as "/", which is
 * what it is served at and what the manifest's start_url points to.
 */
const shell = files
  .filter((f) => !f.startsWith("bundles/"))
  .map((f) => [f === "index.html" ? "/" : `/${f}`, f]);

// Data rather than shell, and precached separately so a bundle that fails to
// download cannot be mistaken for a broken app shell.
const data = files
  .filter((f) => f.startsWith("bundles/"))
  .map((f) => [`/${f}`, f]);

// The version covers names AND contents, so an edit to a file whose name did
// not change still produces a new cache.
const hash = createHash("sha256");
for (const f of files) {
  hash.update(f);
  hash.update(readFileSync(join(DIST, f)));
}
const version = hash.digest("hex").slice(0, 12);

const precache = shell.map(([url]) => url);
const dataUrls = data.map(([url]) => url);

const template = readFileSync(TEMPLATE, "utf8");

// Anchored to the declarations, not to the bare tokens. String.replace hits
// the FIRST match, and the tokens are also named in the template's own doc
// comment, so a loose replace quietly rewrites the comment and ships a worker
// with its placeholders still in place. Each pattern must match exactly once.
function substitute(source, pattern, replacement, label) {
  const hits = source.match(pattern);
  if (hits === null || hits.length !== 1) {
    console.error(
      `${TEMPLATE}: expected exactly one ${label} declaration, found ` +
      `${hits === null ? 0 : hits.length}.`,
    );
    process.exit(1);
  }
  return source.replace(pattern, replacement);
}

let sw = substitute(
  template,
  /^const VERSION = "__VERSION__";$/m,
  `const VERSION = "${version}";`,
  "VERSION",
);
sw = substitute(
  sw,
  /^const PRECACHE = __PRECACHE__;$/m,
  `const PRECACHE = ${JSON.stringify(precache, null, 2)};`,
  "PRECACHE",
);
sw = substitute(
  sw,
  /^const DATA = __DATA__;$/m,
  `const DATA = ${JSON.stringify(dataUrls, null, 2)};`,
  "DATA",
);

writeFileSync(OUT, sw);

const size = (file) => statSync(join(DIST, file)).size;
const total = (list) => list.reduce((sum, [, file]) => sum + size(file), 0);

console.log(`dist/sw.js  cache orca-shell-v3-${version}`);
for (const [url, file] of shell) {
  console.log(`  ${url}  ${size(file).toLocaleString()} bytes` +
              (url === "/" ? `  (${file}, served at /)` : ""));
}
console.log(`  shell: ${shell.length} files, ${total(shell).toLocaleString()} bytes`);
for (const [url, file] of data) {
  console.log(`  ${url}  ${size(file).toLocaleString()} bytes`);
}
console.log(`  data: ${data.length} files, ${total(data).toLocaleString()} bytes`);
console.log(`  ${shell.length + data.length} files, ` +
            `${(total(shell) + total(data)).toLocaleString()} bytes precached`);
