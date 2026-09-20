/**
 * How a number is written down. One copy, because two would drift.
 *
 * These lived in src/ui/screen.ts until the verdict needed to state a distance
 * too. A screen module cannot be imported into src/compute -- it writes to the
 * DOM -- so rather than let a second kilometre formatter grow up next to the
 * first and slowly disagree with it about when to show a decimal, both moved
 * here. screen.ts re-exports them, so nothing outside had to change.
 */

/**
 * Metres as kilometres.
 *
 * A decimal below ten and none above it. Under ten kilometres the tenth is a
 * real difference to someone deciding whether to run for shelter; above it,
 * printing 47.3 km claims a precision that a simplified coastline and a
 * consumer GPS between them do not have.
 */
export function formatKm(m: number): string {
  const km = m / 1000;
  if (km < 10) return `${km.toFixed(1)} km`;
  return `${Math.round(km)} km`;
}

export function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min`;
  const hours = seconds / 3600;
  if (hours < 24) return `${hours.toFixed(1)} h`;
  return `${Math.round(hours / 24)} days`;
}
