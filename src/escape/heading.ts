/**
 * Which way the phone is pointing.
 *
 * This turns a bearing into an arrow you can follow while walking, instead of
 * a number you have to reason about. It is a convenience, never a dependency:
 * every screen that uses it also prints the bearing in degrees and its compass
 * name, so a phone with no magnetometer, a denied permission, or a compass
 * confused by a steel boat still gives a usable instruction.
 *
 * THE ARROW IS NOT A ROUTE. It points along the straight line to the target.
 * See the note the escape screen shows under it.
 */

export type HeadingOutcome =
  | { kind: "ok" }
  | { kind: "denied" }
  | { kind: "unavailable" };

type Listener = (headingDeg: number | null) => void;

interface OrientationEventWithCompass extends DeviceOrientationEvent {
  /** iOS only: degrees clockwise from magnetic north, already screen-relative. */
  webkitCompassHeading?: number;
  webkitCompassAccuracy?: number;
}

interface PermissionCapable {
  requestPermission?: () => Promise<"granted" | "denied" | "default">;
}

let listener: Listener | null = null;
let attached: string | null = null;

function handle(event: Event): void {
  if (listener === null) return;
  const e = event as OrientationEventWithCompass;

  // iOS reports a true compass heading directly and is the easy case.
  if (typeof e.webkitCompassHeading === "number" && !Number.isNaN(e.webkitCompassHeading)) {
    listener(e.webkitCompassHeading);
    return;
  }

  // Everywhere else, alpha is degrees ANTICLOCKWISE from north, so a compass
  // heading is 360 - alpha. Getting this backwards is the classic bug here and
  // it fails quietly: the arrow moves correctly, just mirrored.
  if (typeof e.alpha === "number" && !Number.isNaN(e.alpha)) {
    // absolute === false means the reading is relative to wherever the device
    // happened to be when it started, which is not a compass and must not be
    // presented as one.
    if (e.absolute === false && attached === "deviceorientation") {
      listener(null);
      return;
    }
    listener((360 - e.alpha) % 360);
    return;
  }

  listener(null);
}

/**
 * Start reporting heading.
 *
 * MUST be called from a user gesture on iOS, where requestPermission only
 * resolves if it was triggered by a tap. The escape screen calls it from the
 * button that opens it for exactly that reason.
 */
export async function startHeading(onHeading: Listener): Promise<HeadingOutcome> {
  if (typeof DeviceOrientationEvent === "undefined") return { kind: "unavailable" };

  const capable = DeviceOrientationEvent as unknown as PermissionCapable;
  if (typeof capable.requestPermission === "function") {
    try {
      const state = await capable.requestPermission();
      if (state !== "granted") return { kind: "denied" };
    } catch {
      // Thrown when the call did not come from a gesture. Treated as absent
      // rather than retried: a second prompt the user did not ask for is worse
      // than a bearing in degrees.
      return { kind: "unavailable" };
    }
  }

  stopHeading();
  listener = onHeading;

  // deviceorientationabsolute is the one that means true north on Android.
  // Plain deviceorientation is the fallback, and `absolute` is checked above
  // before any of its readings are believed.
  attached = "ondeviceorientationabsolute" in window
    ? "deviceorientationabsolute"
    : "deviceorientation";
  window.addEventListener(attached, handle);
  return { kind: "ok" };
}

export function stopHeading(): void {
  if (attached !== null) {
    window.removeEventListener(attached, handle);
    attached = null;
  }
  listener = null;
}

/**
 * Where to draw the arrow: the target's bearing relative to the phone's nose.
 *
 * With no heading the arrow points to true bearing and the screen labels it as
 * a map bearing rather than a "hold the phone flat and follow this" arrow,
 * because those are different instructions and confusing them sends people the
 * wrong way.
 */
export function arrowRotation(bearing: number, heading: number | null): number {
  return heading === null ? bearing : (bearing - heading + 360) % 360;
}
