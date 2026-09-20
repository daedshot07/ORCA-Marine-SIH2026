#!/usr/bin/env node
/**
 * Verify the built offline shell.
 *
 *   node tools/check-sw.mjs        (after `npm run build`)
 *
 * This checks the things that fail silently. A service worker with a wrong
 * precache list does not throw; it installs happily and then the app is simply
 * broken the first time someone is out of range, which is the one moment
 * nobody can debug it.
 *
 * It does NOT prove the app works offline. Only a browser can show that, and
 * the procedure for it is in docs/OFFLINE.md.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";

const DIST = "dist";
const problems = [];
const notes = [];

function check(condition, message) {
  if (!condition) problems.push(message);
  return condition;
}

if (!existsSync(join(DIST, "sw.js"))) {
  console.error("dist/sw.js is missing. Run `npm run build`.");
  process.exit(1);
}

const sw = readFileSync(join(DIST, "sw.js"), "utf8");

// --- the precache list ------------------------------------------------------

const listMatch = /const PRECACHE = (\[[\s\S]*?\]);/.exec(sw);
check(listMatch !== null, "could not find the PRECACHE list in dist/sw.js");
const precache = listMatch === null ? [] : JSON.parse(listMatch[1]);

// Anchored to the declarations, matching what build-sw.mjs substitutes. The
// worker's doc comment names both tokens on purpose, so a bare text search
// would flag a file that is perfectly correct.
const dataMatch = /const DATA = (\[[\s\S]*?\]);/.exec(sw);
check(dataMatch !== null, "could not find the DATA list in dist/sw.js");
const data = dataMatch === null ? [] : JSON.parse(dataMatch[1]);

check(
  !/^const VERSION = "__VERSION__";$/m.test(sw) &&
    !/^const PRECACHE = __PRECACHE__;$/m.test(sw) &&
    !/^const DATA = __DATA__;$/m.test(sw),
  "dist/sw.js still contains an unsubstituted placeholder declaration",
);

/**
 * THE REGRESSION GUARD FOR THE BUG THAT BROKE THE INSTALLED APP.
 *
 * Cloudflare Workers static assets answers /index.html with a 307 to /. A
 * precached "/index.html" therefore stores a response with `redirected` set,
 * and Chrome refuses a redirected response for a navigation: the installed PWA
 * failed to launch with ERR_FAILED while an ordinary tab, not yet controlled
 * by the worker, looked fine. The document is precached as "/" and must stay
 * that way.
 */
check(
  !precache.includes("/index.html"),
  "precache contains /index.html. The host redirects it to /, so the stored " +
    "response is a redirected one and Chrome will refuse it for a navigation, " +
    "breaking the installed app on launch. Precache \"/\" instead.",
);
check(
  precache.includes("/"),
  "precache does not contain \"/\", so an installed app has no document to " +
    "fall back to when it launches offline.",
);
check(
  /res\.redirected/.test(sw),
  "sw.js no longer strips redirected responses before caching or serving them.",
);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

// Everything under bundles/ is data, not shell, and the two are precached as
// separate lists so a bundle that fails to download is not mistaken for a
// broken app shell. _headers is a Cloudflare control file rather than an asset
// and belongs in neither.
const isIgnored = (f) => f === "sw.js" || f === "_headers";
const isData = (f) => f.startsWith("bundles/");

const everything = walk(DIST)
  .map((f) => relative(DIST, f).split(sep).join(posix.sep))
  .filter((f) => !isIgnored(f))
  .sort();

const onDisk = everything.filter((f) => !isData(f));
const dataOnDisk = everything.filter(isData);

/** The file behind a precached URL. "/" is served from index.html. */
const fileFor = (url) => (url === "/" ? "index.html" : url.slice(1));

for (const url of [...precache, ...data]) {
  check(url.startsWith("/"), `precache entry is not a root-relative path: ${url}`);
  check(
    !/^https?:\/\//.test(url),
    `precache entry points off-origin: ${url}. The shell must not depend on ` +
      `another host to open.`,
  );
  check(
    existsSync(join(DIST, fileFor(url))),
    `precache entry does not exist in dist/: ${url}`,
  );
}

// The direction that actually bites: a file shipped but never precached looks
// fine online and is missing the moment the network goes.
for (const file of onDisk) {
  const url = file === "index.html" ? "/" : `/${file}`;
  check(
    precache.includes(url),
    `dist/${file} is served but not precached, so it will be missing offline`,
  );
}
for (const file of dataOnDisk) {
  check(
    data.includes(`/${file}`),
    `dist/${file} is served but not precached, so it will be missing offline`,
  );
}

// --- the version ------------------------------------------------------------

const versionMatch = /const VERSION = "([^"]+)"/.exec(sw);
check(versionMatch !== null, "could not find VERSION in dist/sw.js");
check(
  sw.includes("`orca-shell-v3-${VERSION}`"),
  "the cache name does not carry the version, so old caches cannot be told apart",
);

if (versionMatch !== null) {
  // Recomputed the same way tools/build-sw.mjs does it. If these disagree the
  // worker is stale relative to the build sitting next to it, which happens
  // the first time someone runs `vite build` without the post-build step.
  const hash = createHash("sha256");
  for (const f of everything) {
    hash.update(f);
    hash.update(readFileSync(join(DIST, f)));
  }
  const expected = hash.digest("hex").slice(0, 12);
  check(
    versionMatch[1] === expected,
    `dist/sw.js is stale: its version is ${versionMatch[1]} but the files in ` +
      `dist/ hash to ${expected}. Re-run the build.`,
  );
}

// --- the update policy, as code rather than as prose ------------------------
//
// THIS POLICY WAS REVERSED, deliberately, and the checks were reversed with it
// rather than deleted. The old rule was that a new worker waits for every tab
// to close, so a screen someone is reading is never swapped underneath them --
// the right default for a boat that leaves the app open for days.
//
// It stopped being the right default the moment a shipped worker could not
// launch the installed app at all. A worker that waits politely behind a
// broken predecessor never gets to fix anything, so a phone holding the bad
// build would have stayed broken until someone uninstalled the app by hand.
check(
  /\bskipWaiting\s*\(/.test(sw),
  "sw.js does not call skipWaiting, so a phone holding a broken worker would " +
    "keep it until every tab was closed.",
);
check(
  /\bclients\s*\.\s*claim\s*\(/.test(sw),
  "sw.js does not call clients.claim, so the page that triggered the update " +
    "stays with the old worker.",
);
check(
  /caches\.delete/.test(sw),
  "sw.js never deletes an old cache, so storage grows with every release.",
);
check(
  /startsWith\("\/bundles\/"\)/.test(sw),
  "sw.js no longer handles /bundles/ separately. It must be stale-while-" +
    "revalidate: present offline, and never stale enough to hide a new region.",
);
check(
  /indexFirst/.test(sw),
  "sw.js no longer fetches /bundles/index.json network-first, so a newly " +
  "published bundle takes two launches to be discovered.",
);
check(
  /staleWhileRevalidate/.test(sw),
  "sw.js does not serve /bundles/ stale-while-revalidate, so either the app " +
    "has no bundle offline or the region index is answered from a stale cache.",
);

// --- the manifest -----------------------------------------------------------

const manifestPath = join(DIST, "manifest.webmanifest");
if (check(existsSync(manifestPath), "dist/manifest.webmanifest is missing")) {
  let manifest = null;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    problems.push(`manifest.webmanifest is not valid JSON: ${err.message}`);
  }

  if (manifest !== null) {
    check(typeof manifest.name === "string" && manifest.name.length > 0, "manifest has no name");
    check(
      typeof manifest.short_name === "string" && manifest.short_name.length <= 12,
      "manifest short_name is missing or too long for a home screen label",
    );
    check(manifest.display === "standalone", "manifest display is not standalone");
    check(manifest.orientation === "portrait", "manifest orientation is not portrait");
    check(Array.isArray(manifest.icons), "manifest has no icons array");

    const sizes = new Set((manifest.icons ?? []).map((i) => i.sizes));
    check(sizes.has("192x192"), "manifest has no 192x192 icon");
    check(sizes.has("512x512"), "manifest has no 512x512 icon");
    check(
      (manifest.icons ?? []).some((i) => i.purpose === "maskable"),
      "manifest has no maskable icon, so Android will letterbox it",
    );

    for (const icon of manifest.icons ?? []) {
      const file = join(DIST, icon.src.replace(/^\//, ""));
      if (!check(existsSync(file), `icon missing: ${icon.src}`)) continue;

      const buf = readFileSync(file);
      const isPng =
        buf.length > 24 &&
        buf.subarray(0, 8).equals(
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        );
      if (!check(isPng, `icon is not a PNG: ${icon.src}`)) continue;

      // IHDR is always the first chunk: 8 byte signature, 4 byte length,
      // 4 byte type, then width and height.
      const width = buf.readUInt32BE(16);
      const height = buf.readUInt32BE(20);
      check(
        `${width}x${height}` === icon.sizes,
        `${icon.src} is ${width}x${height} but the manifest declares ${icon.sizes}`,
      );
      notes.push(`${icon.src}  ${width}x${height}  ${buf.length.toLocaleString()} bytes`);
    }
  }
}

// --- the Cloudflare headers file --------------------------------------------
//
// sw.js and manifest.webmanifest keep their filenames forever, so without a
// no-cache rule a phone can be stuck on an old worker and never see a new
// build. Vite copies public/_headers to dist/; if that ever stops happening
// the rules silently do not ship.
const headersPath = join(DIST, "_headers");
if (check(existsSync(headersPath), "dist/_headers is missing, so sw.js and the manifest can be served stale")) {
  const headers = readFileSync(headersPath, "utf8");
  for (const target of ["/sw.js", "/manifest.webmanifest"]) {
    check(
      new RegExp(`^${target.replace("/", "\\/")}\\s*$`, "m").test(headers),
      `_headers has no rule for ${target}`,
    );
  }
  check(
    /Cache-Control:\s*no-cache/i.test(headers),
    "_headers does not set Cache-Control: no-cache",
  );
}

// --- the document links -----------------------------------------------------

const html = readFileSync(join(DIST, "index.html"), "utf8");
check(/rel="manifest"/.test(html), "index.html does not link the manifest");
check(/rel="icon"/.test(html), "index.html has no icon link");

// --- report -----------------------------------------------------------------

const sizeOf = (url) =>
  existsSync(join(DIST, fileFor(url))) ? statSync(join(DIST, fileFor(url))).size : 0;
const bytes = [...precache, ...data].reduce((t, u) => t + sizeOf(u), 0);

console.log(`cache orca-shell-v3-${versionMatch?.[1] ?? "?"}`);
for (const u of precache) console.log(`  ${u}${u === "/" ? "  (index.html)" : ""}`);
for (const u of data) console.log(`  ${u}  (data)`);
console.log(`  ${precache.length + data.length} files, ${bytes.toLocaleString()} bytes`);
for (const n of notes) console.log(`  ${n}`);

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

console.log("\nOffline shell OK. This does not prove offline works; see docs/OFFLINE.md.");
