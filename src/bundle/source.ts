/**
 * Where a bundle comes from.
 *
 * The app downloads a small region index, decides on the device which region
 * covers the user, and then downloads that one bundle. Nothing else.
 *
 * THE POSITION NEVER LEAVES THE DEVICE. That is why the region lookup is a
 * static file rather than an endpoint: asking a server "which region am I in"
 * would be less code and would transmit the one thing this app has no business
 * transmitting. `staticUrl` below enforces it structurally, so a coordinate
 * cannot end up in a URL even by accident.
 */

const BUNDLE_DIR = "/bundles/";
const INDEX_FILE = "index.json";

/** A bundle filename is a region id and an extension. Nothing else. */
const SAFE_FILE = /^[a-z0-9][a-z0-9-]{0,62}\.orcabundle$/;

export interface RegionEntry {
  region_id: string;
  name: string;
  /** lon_min, lat_min, lon_max, lat_max */
  bbox: [number, number, number, number];
  file: string;
  bytes: number;
  generated_at: string;
  format_version: number;
}

/**
 * Build a URL for a static bundle asset, refusing anything else.
 *
 * The guard is the point. Every fetch this app makes goes through here, and
 * the pattern admits no query string, no path traversal and no interpolated
 * number, so there is no shape of bug that turns into a position on the wire.
 */
export function staticUrl(file: string): string {
  if (file !== INDEX_FILE && !SAFE_FILE.test(file)) {
    throw new Error(`refusing to fetch ${file}: not a static bundle asset`);
  }
  return BUNDLE_DIR + file;
}

export async function fetchRegionIndex(signal?: AbortSignal): Promise<RegionEntry[]> {
  const res = await fetch(staticUrl(INDEX_FILE), { cache: "no-store", signal });
  if (!res.ok) throw new Error(`region index: HTTP ${res.status}`);
  const body: unknown = await res.json();
  const regions = (body as { regions?: unknown }).regions;
  if (!Array.isArray(regions)) throw new Error("region index has no regions");
  return regions as RegionEntry[];
}

export async function fetchBundleBytes(
  entry: RegionEntry, signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const res = await fetch(staticUrl(entry.file), { cache: "no-store", signal });
  if (!res.ok) throw new Error(`${entry.file}: HTTP ${res.status}`);
  return await res.arrayBuffer();
}

/**
 * The region whose box contains this position, or null.
 *
 * Null is a real answer, not a failure to be papered over. A user outside
 * every region gets told so; they do not get the nearest region's forecast for
 * water they are nowhere near.
 */
export function regionContaining(
  entries: readonly RegionEntry[], lat: number, lon: number,
): RegionEntry | null {
  for (const entry of entries) {
    const [w, s, e, n] = entry.bbox;
    if (lon >= w && lon <= e && lat >= s && lat <= n) return entry;
  }
  return null;
}

/**
 * Which region to download when there is no position to go on.
 *
 * Prefers the one already stored, so an update refreshes what the user has
 * rather than swapping their region underneath them. Falls back to the only
 * region when there is exactly one, and otherwise declines to guess.
 */
export function regionWithoutPosition(
  entries: readonly RegionEntry[], storedRegionId: string | null,
): RegionEntry | null {
  if (storedRegionId !== null) {
    const stored = entries.find((e) => e.region_id === storedRegionId);
    if (stored !== undefined) return stored;
  }
  return entries.length === 1 ? entries[0]! : null;
}

/** True when the published bundle is newer than what is already stored. */
export function isNewer(entry: RegionEntry, storedGeneratedAt: string | null): boolean {
  if (storedGeneratedAt === null) return true;
  const a = Date.parse(entry.generated_at);
  const b = Date.parse(storedGeneratedAt);
  if (Number.isNaN(a) || Number.isNaN(b)) return true;
  return a > b;
}
