# ORCA Mobile — offline-first coastal safety PWA

Companion to ORCA at ~/SIH2026/orca. Same problem statement, different
client: a low-bandwidth, offline-capable app for fishermen and coastal
residents.

## Non-negotiable constraints
- NO LLM anywhere. Not for planning, not for phrasing. Every number comes
  from a formula. This is a deliberate design choice, not a limitation.
- NO live backend. The server only publishes precomputed bundle files to
  static storage. The app downloads a file; it never calls an API.
- Must work fully offline at sea. Assume no network beyond ~15 km.
- Must work on a cheap Android phone over 2G.
- Colour is never the only channel. Danger is signalled by inverted blocks
  (black background, white text) and by pattern FIRST; colour is added on top
  as a second, redundant channel. Strip the hue and every state must still be
  tellable apart, so it stays readable in direct sunlight and is
  colourblind-safe. Hues come from ORCA's frontend/lib/color.ts, not invented
  here, so a boat and a control room are not colour-coded differently for the
  same sea.

## Two halves

### 1. Bundle builder (Python, in this repo, reads from ~/SIH2026/orca)
Runs every 6 hours. Reads the hazard field, boundaries, landing centres
and terrain elevation that ORCA already computes, and packs them into one
compact bundle per coastal region.
Size target: 2-4 MB per region before gzip. Quantise aggressively:
hazard_prob and uncertainty as one byte each per cell per hour; simplify
boundary polygons; DEM only for the coastal strip.

### 2. PWA (TypeScript)
Downloads a bundle when online, stores it, and does ALL computation
on-device:
- GPS position -> H3 cell -> hazard probability now and for the next 72 h
- First hour the probability crosses the threshold -> "safe now, danger in
  N hours"
- Distance and bearing to the nearest maritime boundary (IMBL, EEZ,
  territorial sea) - pure geometry, works offline
- Route to the nearest reachable landing centre over the cached cell graph
- Coastal mode: compare the user's terrain elevation against the forecast
  storm surge level, and guide to the nearest higher ground

## Honest framing (must hold in code and in what we claim)
We do NOT predict weather on the device. Forecasts are computed upstream
and cached. The device computes the DECISION. Never describe this as
offline prediction.

## Stack
Vanilla TypeScript + Vite. No React unless I ask - this UI is small and
must load fast on 2G.
Service Worker for offline shell. IndexedDB for the bundle.
h3-js for cells. Turf.js (only the modules needed) for geometry.
Geolocation API for GPS.

The map is Canvas 2D, drawn from the bundle. Not MapLibre, and no tile pack.
The bundle already carries everything the map shows - coastline, hexagons,
boundary lines, landing centres - so a tile pack would be a second copy of the
same geography at a far larger download, and the cells have to be filled with
patterns rather than colours anyway, which is a fight against a tile renderer
rather than something it gives us. 965 pattern-filled hexagons plus a coastline
is about 1,600 nodes as SVG; canvas treats it as geometry and drops to outlines
during a pan, which is what keeps it smooth on a cheap Android. See the header
comment in src/map/render.ts. No dependency was added for any of it.

## UI rules
One screen, one decision. In this order, top to bottom:
- slim header: ORCA, and the region name, or an inverted "your location"
  badge when a live fix is driving the screen
- if the data is over 12 hours old, a black strip saying so, above the map
- the map, 52% of the viewport height, always on screen and never behind a
  button. A large "centre on me" button sits in its bottom-right corner,
  disabled until there is a fix - and enabled by ANY fix, including one
  outside the loaded region: the land mask means the map is a picture of the
  coast everywhere in India, not a blank rectangle, and a button that never
  responds reads as broken. Panning is bounded by the region box widened to
  include the marker, so the map cannot fight the user back across the country.
- a legend strip: four pattern swatches in one row, outside the canvas, so
  nothing covers the water nearest the coast
- one large verdict line with its number always beside it
- three figures: boundary distance, time to harbour, data age
- two big inverted buttons side by side: ESCAPE (on land, safe place) and SEA
  MODE (at sea, return to harbour), then a slimmer inverted "Change area"
  button under them. All three are in the fixed region, so they are never
  scrolled away; the two emergency ones share a row so they cost one row's
  height, and "Change area" is one line because it is a deliberate act rather
  than an emergency and must not compete with ESCAPE for the eye.
- then, scrolling: which water this describes, the "change area" disclosure
  holding the district and landing centre selectors, the bundle source line,
  the bundle file fallback link last

The verdict and all three figures must be visible without scrolling on a
360x640 phone. They are laid out outside the scrolling region so nothing added
later can push them off it. The map gives up height first on a shorter screen.

Current location marker: solid black dot with a white ring, and a dashed
circle at the reported GPS accuracy. Never a bare dot - that claims a
precision consumer GPS does not have. The map centres on the user when
location is granted.
Picking an area by hand moves the map to that place, and the location marker
stays drawn if it falls inside the view.

Never show a verdict word without its number.
Grey / no data must never read as SAFE - it reads "no data for this area".
Hazard fills keep their patterns: dense hatch danger, dots caution, plain safe,
grid no data. The tint sits behind the pattern, pale enough that the black mark
stays dominant. The legend swatches and the map cells share one set of values.
NO CONTROL MAY WEAR A HAZARD PATTERN. Those four marks mean what the legend
says they mean, everywhere on the screen, so a hatched button reads as danger.
Buttons are plain white with a thick black border and invert when pressed;
unavailable is said with a dashed border, never with a fill.
A position outside every region reads "outside covered area", never a verdict.
If data is older than 12 hours, say so prominently.
Must be usable one-handed on a small screen, in sunlight, with wet hands -
large tap targets, high contrast, no thin fonts.

## Working rules for me
Plan first, wait for my approval, then write. One step at a time.
Never mock data. Comment the computation heavily.
Ask before adding any dependency.

## Build order - do not jump ahead
1 bundle format spec + a sample bundle generated from real ORCA data
2 PWA skeleton that reads a bundle and shows the verdict as text only
3 GPS + cell lookup + boundary distance
4 Offline map + route
5 Coastal evacuation mode (DEM + surge)
