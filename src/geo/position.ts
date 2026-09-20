/**
 * Asking the device where it is.
 *
 * THE POSITION NEVER LEAVES THE DEVICE. Nothing in this module sends it
 * anywhere, and the only consumer that touches the network at all uses it to
 * pick an entry out of a list that has already been downloaded. See
 * `staticUrl` in src/bundle/source.ts, which makes that structural rather than
 * a promise.
 *
 * GPS needs no network, so everything here works at sea. That is the whole
 * point: the network is for downloading a forecast, not for knowing where you
 * are.
 */

export interface Position {
  lat: number;
  lon: number;
  /** Reported accuracy in metres. Always shown; never rounded away. */
  accuracyM: number;
  at: number;
}

export type PositionOutcome =
  | { kind: "ok"; position: Position }
  | { kind: "denied" }
  | { kind: "unavailable"; reason: string }
  | { kind: "timeout" };

const DENIED_KEY = "orca.locationDenied";

/**
 * Has the user already refused?
 *
 * Remembered so the app does not ask again on every launch. A permission
 * prompt that reappears each time is how a user learns to dismiss prompts
 * without reading them, and this app has exactly one thing it ever wants to
 * ask for.
 */
export function previouslyDenied(): boolean {
  try {
    return localStorage.getItem(DENIED_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberDenied(): void {
  try {
    localStorage.setItem(DENIED_KEY, "1");
  } catch {
    // Nothing to do. Worst case the prompt appears again next launch.
  }
}

/** Forget the refusal, so the "use my location" button can ask again. */
export function clearDenied(): void {
  try {
    localStorage.removeItem(DENIED_KEY);
  } catch {
    // As above.
  }
}

/**
 * Ask the browser for a position.
 *
 * `enableHighAccuracy` is on because the decisions downstream are about which
 * side of a line a boat is on, and a network-derived fix can be kilometres
 * out. The timeout is generous: a real GPS fix on a cheap phone under an open
 * sky can take twenty seconds from cold, and giving up early would send the
 * user to the manual selectors while the receiver was still working.
 */
export function requestPosition(timeoutMs = 20000): Promise<PositionOutcome> {
  if (!("geolocation" in navigator)) {
    return Promise.resolve({
      kind: "unavailable",
      reason: "this browser has no location support",
    });
  }

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) => {
        resolve({
          kind: "ok",
          position: {
            lat: p.coords.latitude,
            lon: p.coords.longitude,
            accuracyM: p.coords.accuracy,
            at: p.timestamp,
          },
        });
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          rememberDenied();
          resolve({ kind: "denied" });
        } else if (err.code === err.TIMEOUT) {
          resolve({ kind: "timeout" });
        } else {
          resolve({ kind: "unavailable", reason: err.message });
        }
      },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30000 },
    );
  });
}

// ---------------------------------------------------------------------------
// watching
// ---------------------------------------------------------------------------

/**
 * Follow the position instead of asking once.
 *
 * GPS NEEDS NO NETWORK. This is the whole reason the escape screen works in a
 * disaster: the towers can be down, the data can be out, and the satellites do
 * not care. Nothing here transmits anything.
 *
 * BATTERY. A high-accuracy watch left running is the fastest way to flatten a
 * phone, and a flat phone during an evacuation is worse than no app at all. So
 * it stops the moment the screen is hidden and restarts when it comes back,
 * and it only wakes the caller when the fix has actually moved or aged.
 */
export interface Watch {
  stop: () => void;
}

/** Report a new fix at most this often, unless the user has moved further. */
const MIN_INTERVAL_MS = 3000;
/** ...or as soon as they have moved this far, whichever comes first. */
const MIN_MOVE_M = 10;

function metresBetween(a: Position, b: Position): number {
  // Small-angle planar estimate. Only used to decide whether to redraw, so it
  // does not need to be the great-circle distance the screen reports.
  const mPerDegLat = 111132.95;
  const dLat = (b.lat - a.lat) * mPerDegLat;
  const dLon = (b.lon - a.lon) * mPerDegLat * Math.cos(a.lat * Math.PI / 180);
  return Math.hypot(dLat, dLon);
}

export function watchPosition(
  onFix: (position: Position) => void,
  onProblem?: (outcome: PositionOutcome) => void,
): Watch {
  if (!("geolocation" in navigator)) {
    onProblem?.({ kind: "unavailable", reason: "this browser has no location support" });
    return { stop: () => {} };
  }

  let id: number | null = null;
  let last: Position | null = null;
  let stopped = false;

  const accept = (p: GeolocationPosition): void => {
    const next: Position = {
      lat: p.coords.latitude,
      lon: p.coords.longitude,
      accuracyM: p.coords.accuracy,
      at: p.timestamp,
    };
    if (last !== null &&
        next.at - last.at < MIN_INTERVAL_MS &&
        metresBetween(last, next) < MIN_MOVE_M) {
      return;
    }
    last = next;
    onFix(next);
  };

  const fail = (err: GeolocationPositionError): void => {
    if (err.code === err.PERMISSION_DENIED) {
      rememberDenied();
      onProblem?.({ kind: "denied" });
    } else if (err.code === err.TIMEOUT) {
      onProblem?.({ kind: "timeout" });
    } else {
      onProblem?.({ kind: "unavailable", reason: err.message });
    }
  };

  const start = (): void => {
    if (id !== null || stopped) return;
    id = navigator.geolocation.watchPosition(accept, fail, {
      enableHighAccuracy: true,
      timeout: 20000,
      maximumAge: 5000,
    });
  };

  const pause = (): void => {
    if (id === null) return;
    navigator.geolocation.clearWatch(id);
    id = null;
  };

  const onVisibility = (): void => {
    if (document.hidden) pause();
    else start();
  };

  document.addEventListener("visibilitychange", onVisibility);
  start();

  return {
    stop: () => {
      stopped = true;
      pause();
      document.removeEventListener("visibilitychange", onVisibility);
    },
  };
}

