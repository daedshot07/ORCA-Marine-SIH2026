/**
 * Every threshold this app applies, and where each one came from.
 *
 * Only one of these numbers was decided in this repository. The rest are
 * ORCA's, copied so that the phone in a fisherman's pocket and the screen in
 * the control room say the same word about the same sea. `npm run check`
 * re-reads ORCA's source and fails if any shared value has drifted, because a
 * provenance comment rots quietly and a check does not.
 */

// ---------------------------------------------------------------------------
// Verdict bands
// ---------------------------------------------------------------------------

/**
 * ORCA frontend/lib/verdict.ts:27
 *
 * At or above a 10% chance that significant wave height passes 2.5 m or wind
 * passes 12.5 m/s, the word becomes CAUTION.
 */
export const CAUTION_AT = 0.1;

/**
 * ORCA frontend/lib/verdict.ts:28
 *
 * At or above an even chance, DO NOT GO OUT.
 */
export const DO_NOT_GO_AT = 0.5;

/**
 * ORCA frontend/lib/verdict.ts:36. Applies to `uncertainty`, never to hazard.
 *
 * Above this the spread is wide enough that the point estimate should not be
 * read as precise. It changes the WORDING only and never the verdict. ORCA's
 * reasoning, which this app inherits: nudging a verdict up on low confidence
 * cries wolf, and nudging it down hides a real risk behind our own ignorance.
 * Saying so plainly lets the reader apply their own judgement.
 */
export const LOW_CONFIDENCE_AT = 0.6;

// ---------------------------------------------------------------------------
// Time to shelter
// ---------------------------------------------------------------------------

/**
 * ORCA backend/app/adapters/aisstream.py:99 (`UNKNOWN_SPEED_MS`), and again as
 * the last-resort fallback at backend/app/core/recall.py:235.
 *
 * About 6 knots. Deliberately at the slow end of plausible: a slower assumed
 * speed means a longer time to harbour, a smaller margin, and an earlier call
 * to come in. If the guess is wrong it is wrong toward safety.
 */
export const UNKNOWN_SPEED_MS = 3.1;

/** ORCA backend/app/core/recall.py:80 (`MIN_ASSUMED_SPEED_MS`). */
export const MIN_ASSUMED_SPEED_MS = 1.0;

/**
 * ORCA backend/app/core/recall.py:63 (`DETOUR_FACTOR`).
 *
 * Multiplier on great-circle distance, a conservative coastal-passage rule of
 * thumb. A real track goes around headlands and shoals, so a straight line is
 * optimistic, and optimism here inflates the margin and makes a boat look
 * safer than it is. Raising this makes every estimate more cautious.
 *
 * Note what this does NOT cover: ORCA fixes vessel speed for a whole route
 * (core/routing.py:351) and never slows a boat in a heavy sea, so its
 * durations are calm-water transit times. We do not invent a sea-state penalty
 * here, because that would be a number nobody computed. We label the figure
 * optimistic instead.
 */
export const DETOUR_FACTOR = 1.25;

// ---------------------------------------------------------------------------
// Data age
// ---------------------------------------------------------------------------

/**
 * THIS ONE IS OURS. It is not from ORCA.
 *
 * Set by this project's CLAUDE.md: "If data is older than 12 hours, say so
 * prominently." ORCA refreshes every 12 hours, so a bundle past this age has
 * missed at least one refresh, which is the point at which a user should know
 * they are looking at something the shore has already replaced.
 */
export const STALE_HOURS = 12;

// ---------------------------------------------------------------------------
// Escaping on foot
// ---------------------------------------------------------------------------

/**
 * THIS ONE IS OURS. Walking pace, 4 km/h in metres per second.
 *
 * An unobstructed adult on flat ground. Already optimistic for an evacuation
 * -- crowds, darkness, water underfoot, carrying a child or helping someone
 * older -- and left alone anyway, because the brief asked for walking time at
 * 4 km/h and a speed nobody can check is worse than one everybody can.
 */
export const WALK_SPEED_MS = 4000 / 3600;

/**
 * THIS ONE IS OURS TOO, and it exists because its absence was a bug.
 *
 * The escape screen used to divide the straight-line distance by the walking
 * speed and print the result. That is a claim that you can walk through
 * buildings. The home screen's time-to-harbour has never made that claim: it
 * multiplies by ORCA's DETOUR_FACTOR of 1.25 first. So the figure for a person
 * on foot, in a town, was MORE optimistic than the one for a boat in open
 * water, which is backwards -- streets bend more than sea lanes do.
 *
 * WHY A NUMBER AT ALL, when docs/KNOWN_LIMITATIONS.md refuses to invent a
 * sea-state penalty for the same kind of estimate. Because the two cases are
 * not alike. There, the honest default was to leave the figure unadjusted and
 * label it a lower bound; the missing number was a CURVE, a function of sea
 * state that nobody had computed. Here the alternative to picking a factor is
 * not "no factor", it is a factor of exactly 1.0 -- an assertion that the
 * walking route is a straight line, which is known to be false everywhere.
 * 1.0 is the invented number. Something above it is the honest one.
 *
 * 1.3 is a planning rule of thumb for pedestrian route circuity in built-up
 * areas, where the measured ratio of walked distance to straight-line distance
 * typically falls between about 1.2 and 1.5. It is a rule of thumb and not a
 * measurement of this coast, and the screen still calls the result a lower
 * bound, because a backwater or a rail line can make the real walk several
 * times longer than this and no road data on this device would say so.
 *
 * It errs toward caution: a larger factor means a longer stated walk, which
 * means leaving earlier. Understating time-to-shelter during an evacuation is
 * the one direction this must never be wrong in.
 */
export const WALK_DETOUR_FACTOR = 1.3;

// ---------------------------------------------------------------------------
// Bundle encoding. Mirrors docs/BUNDLE_FORMAT.md; the bundle carries these in
// its metadata too, and the reader checks the file against these values.
// ---------------------------------------------------------------------------

export const MAGIC = "ORCABND\0";

/** The highest format version this reader fully understands. */
export const READER_VERSION = 2;

/**
 * The lowest it will touch. A reader must refuse a bundle that is too OLD as
 * firmly as one that is too new: version 2 changed the landing centre record
 * from 20 to 32 bytes, so a version 2 reader let loose on a version 1 file
 * would stride through it wrongly and produce positions that look entirely
 * plausible and are wrong.
 */
export const MIN_SUPPORTED_FORMAT = 2;

export const VALUE_SCALE = 254;

/** Reserved byte meaning no data. It is not zero and it is never SAFE. */
export const NO_DATA = 255;

export const COORD_SCALE = 1e7;

/** Written in a landing centre record when no forecast cell is close enough. */
export const NO_CELL = 0xffffffff;

/** IUGG mean Earth radius, in metres. The same figure ORCA uses. */
export const EARTH_RADIUS_M = 6371008.8;

export const METRES_PER_NM = 1852;

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

/**
 * Hazard tints. Hues taken from ORCA's frontend/lib/color.ts so a boat and a
 * control room are not colour-coded differently for the same sea.
 *
 * COLOUR IS A SECOND CHANNEL HERE, NEVER THE ONLY ONE. Every state keeps the
 * pattern and the inversion it had when this interface was strictly black and
 * white: dense hatch for danger, dots for caution, plain for safe, grid for no
 * data. Colour is added on top. That is what keeps the screen readable on a
 * washed-out phone in direct sunlight, and readable to a colourblind reader,
 * which is why the constraint existed in the first place.
 *
 * The tints are deliberately pale. The black pattern printed over them has to
 * stay the dominant mark, so these are backgrounds rather than fills.
 *
 * src/ui/style.css repeats these four values for the legend swatches. The
 * screen check compares the two, because a legend that disagrees with the map
 * is worse than no legend.
 */
/**
 * Land. NOT a hazard state, and deliberately unlike the four below.
 *
 * The map used to draw the coastline as a line and leave both sides white, so
 * there was no way to tell sea from shore except by guessing which side the
 * hexagons were on. A flat sand tint with NO PATTERN fixes that and cannot be
 * confused with a hazard cell, because every hazard state carries a black
 * pattern and this carries none. Strip the hue and land is still the only
 * large area with no mark on it at all.
 */
export const TINT_LAND = "#e8e2d6";

export const TINT_DANGER = "#f7d7d5";
export const TINT_CAUTION = "#fbeecb";
export const TINT_SAFE = "#eef6f1";
export const TINT_NODATA = "#eceef0";

/**
 * Accent bars on the verdict block, one per state.
 *
 * Same device ORCA uses in its globals.css, where each verdict class sets only
 * `border-left-color`. The black frame stays; the colour is an extra edge.
 */
export const ACCENT_DANGER = "#d9534f";
export const ACCENT_CAUTION = "#e0a458";
export const ACCENT_SAFE = "#58b08a";
export const ACCENT_NODATA = "#9aa0a6";
