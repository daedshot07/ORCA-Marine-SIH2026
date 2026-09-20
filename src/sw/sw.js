/**
 * ORCA Mobile service worker. Plain JavaScript, no Workbox.
 *
 * Its whole job is to make the app survive with no network.
 *
 * __PRECACHE__, __DATA__ and __VERSION__ are substituted by tools/build-sw.mjs
 * after `vite build`, because Vite emits content-hashed filenames and a
 * hand-written list would be wrong the first time anyone changed a stylesheet.
 * Nothing here names a hashed file, so a rebuild can never leave this worker
 * pointing at an asset that no longer exists.
 *
 * ---------------------------------------------------------------------------
 * THE REDIRECT RULE, which is why this file was rewritten
 * ---------------------------------------------------------------------------
 * Cloudflare Workers static assets answers /index.html with a 307 to /. The
 * previous worker precached "/index.html", so the stored response had come
 * through a redirect and carried `redirected: true`. Chrome refuses to use a
 * redirected response for a navigation request, whose redirect mode is not
 * "follow", and fails the navigation outright: the INSTALLED PWA died on
 * launch with ERR_FAILED, while an ordinary tab still worked because on a
 * first visit it was not yet under this worker's control.
 *
 * So: the document is cached as "/", never as "/index.html", and NO RESPONSE
 * IS EVER STORED OR SERVED WITH `redirected` SET. `clean()` below rebuilds one
 * if it sees it. Every path that puts something in the cache goes through it.
 */

const VERSION = "__VERSION__";

// v3, and the prefix is part of the name on purpose. The activate handler
// below deletes every cache that is not this one, so a phone holding an older
// shell drops it on the first launch after this ships. v1 could not launch the
// installed app at all; v2 shipped a stylesheet in which the escape overlay
// covered the home screen on load. Both have to go, not merely be superseded.
const CACHE = `orca-shell-v3-${VERSION}`;

/** The app shell. "/" is the document; see THE REDIRECT RULE above. */
const PRECACHE = __PRECACHE__;

/** Bundles and the region index. Data, not shell. */
const DATA = __DATA__;

/**
 * How long a navigation waits for the network before falling back to cache.
 *
 * Navigations are network-first so a launch always picks up a new build, but
 * "network-first" with no bound is a trap on the connection this app is for: a
 * 2G link that accepts the connection and then stalls would hang the splash
 * screen for the full request timeout. Three seconds, then serve the shell we
 * already have. Offline the fetch fails at once and this never waits.
 */
const NAV_TIMEOUT_MS = 3000;

// ---------------------------------------------------------------------------
// redirect hygiene
// ---------------------------------------------------------------------------

/**
 * A response safe to store and to serve, with no redirect in its history.
 *
 * A redirected response cannot be handed to a navigation, and the failure is
 * total rather than graceful, so this is applied on the way IN to the cache
 * and on the way OUT to a navigation. Rebuilding costs one copy of the body,
 * which for a 5 KB document is nothing.
 */
async function clean(res) {
  if (!res.redirected) return res;
  const body = await res.blob();
  return new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

function offline(navigation) {
  return navigation
    ? new Response(
        "<!doctype html><meta charset=utf-8><title>ORCA</title>" +
        "<body style=\"font:700 16px system-ui;padding:24px\">" +
        "<h1>ORCA</h1><p>The app is not installed on this device yet, and " +
        "there is no network to fetch it. Open this page once with a " +
        "connection.</p>",
        { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } },
      )
    : new Response(
        "Offline, and this file was not part of the installed app.",
        { status: 504, headers: { "Content-Type": "text/plain; charset=utf-8" } },
      );
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      const failed = [];

      // One request at a time rather than cache.addAll, because addAll rejects
      // the WHOLE install if a single URL 404s. On a static host one stale
      // filename in the list would then take the entire offline shell down
      // with it, and the app would silently stop working offline with no
      // failure anyone could see.
      //
      // `cache: "reload"` so the browser's own HTTP cache cannot hand back a
      // stale copy of the very files being pinned.
      await Promise.all(
        [...PRECACHE, ...DATA].map(async (url) => {
          try {
            const res = await fetch(url, { cache: "reload" });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            await cache.put(url, await clean(res));
          } catch (err) {
            failed.push(`${url} (${err.message})`);
          }
        }),
      );

      if (failed.length > 0) {
        console.error("[orca sw] not precached:", failed.join(", "));
      }

      // "/" is the one file that may not be missing: it is the document every
      // navigation falls back to, so without it the installed app cannot open
      // at all. Everything else degrades; this does not.
      if ((await cache.match("/")) === undefined) {
        throw new Error("could not precache the app shell at /");
      }
    })(),
  );

  // skipWaiting, which reverses an earlier decision in this file and is worth
  // saying why. The old worker waited for every tab to close so a screen
  // someone was reading was never swapped underneath them. That is the right
  // default -- but the version being replaced is one that cannot launch the
  // installed app at all, and a worker that politely waits behind a broken
  // predecessor never gets to fix anything.
  self.skipWaiting();
});

// ---------------------------------------------------------------------------
// activate
// ---------------------------------------------------------------------------

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Every cache that is not this one, not merely the orca-shell- ones. A
      // phone in the demo may be holding a cache written by any earlier build,
      // and the point of this release is that all of them go.
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => name !== CACHE).map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(respond(event, request, url));
});

async function respond(event, request, url) {
  const cache = await caches.open(CACHE);

  if (request.mode === "navigate") return navigate(cache);

  // Bundles and the region index: serve what we have, refresh behind it.
  //
  // This used to be left alone entirely, on the reasoning that IndexedDB owns
  // the bundle and a cache-first index would hide a newly published region.
  // The first half still holds -- the app reads its bundle from IndexedDB and
  // computes offline verdicts from there -- but a phone that installs the app
  // and never opens it online has nothing to put in IndexedDB. Serving the
  // cached copy immediately and revalidating in the background keeps the
  // region index fresh when there is a network and present when there is not.
  if (url.pathname.startsWith("/bundles/")) {
    // THE INDEX IS NOT LIKE THE BUNDLES. It is the file that decides whether a
    // newer forecast exists at all, so serving it from cache first meant a new
    // bundle took TWO launches to arrive: the first read a stale index, saw
    // its own copy was current and downloaded nothing, while the fresh index
    // landed in the background for the second launch to find.
    //
    // Network first, cache only as a fallback. Offline the fetch fails at once
    // and the cached copy answers, so this costs nothing when there is no
    // network and fixes the lag when there is.
    if (url.pathname === "/bundles/index.json") return indexFirst(cache, url);
    return staleWhileRevalidate(event, cache, url);
  }

  const hit = await cache.match(url.pathname);
  if (hit !== undefined) return hit;

  try {
    return await fetch(request);
  } catch {
    return offline(false);
  }
}

/**
 * Navigations: network first, cached shell second.
 *
 * The request is not forwarded as-is. A navigation request carries redirect
 * mode "manual", so passing it to fetch can yield an opaqueredirect response
 * that is useless here; asking for "/" directly sidesteps that, and "/" is the
 * URL that does not redirect.
 */
async function navigate(cache) {
  try {
    const fresh = await Promise.race([
      fetch("/", { cache: "no-store" }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("slow network")), NAV_TIMEOUT_MS)),
    ]);
    if (fresh.ok) {
      const safe = await clean(fresh);
      await cache.put("/", safe.clone());
      return safe;
    }
  } catch {
    // Offline, stalled, or a server error. The cached shell is the answer.
  }

  const shell = await cache.match("/");
  return shell ?? offline(true);
}

/** Network first with a cache fallback, for the one file freshness matters on. */
async function indexFirst(cache, url) {
  try {
    const res = await Promise.race([
      fetch(url.pathname, { cache: "no-store" }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("slow network")), NAV_TIMEOUT_MS)),
    ]);
    if (res.ok) {
      const safe = await clean(res);
      await cache.put(url.pathname, safe.clone());
      return safe;
    }
  } catch {
    // Offline or stalled. The stored index is the answer.
  }
  const hit = await cache.match(url.pathname);
  return hit ?? offline(false);
}

async function staleWhileRevalidate(event, cache, url) {
  const refresh = (async () => {
    try {
      const res = await fetch(url.pathname, { cache: "no-store" });
      if (!res.ok) return undefined;
      const safe = await clean(res);
      await cache.put(url.pathname, safe.clone());
      return safe;
    } catch {
      return undefined;
    }
  })();

  const hit = await cache.match(url.pathname);
  if (hit !== undefined) {
    // Let the refresh finish even though the response has already gone out;
    // without this the worker can be killed mid-update and the cached copy
    // never moves on.
    event.waitUntil(refresh);
    return hit;
  }

  return (await refresh) ?? offline(false);
}
