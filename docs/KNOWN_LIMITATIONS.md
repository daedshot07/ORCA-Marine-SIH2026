# Known limitations

Things this system does not do, written down so they are not rediscovered as
surprises. Each entry says what the limit is, why it exists, what it would
take to lift, and where the code is.

A limitation that is recorded and labelled in the interface is a gap. A
limitation that is not is a false claim, so anything added here must also be
visible to the person relying on it.

---

## 1. Nearest boundary covers the IMBL and protected areas only

**What.** The "nearest boundary" figure answers with the India maritime
boundary line and marine protected areas. It does not answer with the
territorial sea, the contiguous zone or the EEZ, even though all three travel
in the bundle.

**Why.** Those three arrive from ORCA as `edge_geom`, the outline of a
polygon. The outline of the 12 nautical mile zone includes both the seaward
arc 12 nautical miles out and the coastal side that runs along the shore. For
a boat in coastal water the nearest part of that outline is almost always the
coast, so the figure reported places as being on top of the territorial sea
when they were merely close to land. That reads as being about to cross a
limit, which is exactly the wrong thing to tell someone.

The straight baseline is excluded for a related reason: it is not a limit at
all. It is the landward reference the territorial sea is measured from.

**What it would take.** The builder has to separate the seaward arc from the
coastal side before packing. The zones nest, so subtracting the next zone
outward removes the shared coastline. Measured on the current data this works
for the 12 nautical mile zone against the 24: its edge drops from 5,043 km to
2,727 km, and the 2,316 km removed is the coastal part. It does not yet work
for the 24 against the EEZ, which only loses 171 km, so that pairing needs a
different source for the coastal side before this can ship.

**Where.** `LIMIT_ZONE_TYPES` in `src/compute/boundary.ts` holds the list and
the reasoning. The zones themselves are packed by `fetch_zones` in
`builder/db.py`.

---

## 2. Route and transit durations are calm-water times

**What.** Every duration this app shows, including "time to harbour", is the
time a boat would take in calm water. It is a lower bound, and the interface
labels it optimistic.

**Why.** ORCA fixes vessel speed for the whole of a route search at
`backend/app/core/routing.py:351` and accumulates elapsed time at that
constant speed, so hazard changes which path is chosen but never how fast the
boat is assumed to move along it. A boat makes less way in a heavy sea, and
neither system accounts for that.

This is worth flagging upstream. Every other optimism in ORCA is stated in a
comment or a flag next to the number it affects. This one is not, and it
moves the margin in the dangerous direction: a shorter assumed transit makes
a boat look as though it has more time to reach shelter than it has.

**What it would take.** A defensible speed reduction as a function of sea
state. We will not invent one here. A number that shapes a decision to run for
shelter has to come from somewhere real, and inventing a plausible-looking
curve would be exactly the kind of manufactured precision the rest of this
project refuses.

Until then the honest move is the one already taken: report the figure as a
lower bound and say so where it is shown.

**Where.** `nearestHarbour` in `src/compute/harbour.ts`, and `DETOUR_FACTOR`
in `src/constants.ts`, which covers track length but not sea state.

---

## 3. Inland water reads as sea, not as land

**What.** The land mask answers "is this point on land", and a lagoon, lake or
wide river inside the landmass is a hole in the land polygon, so a position on
one comes back as not-land and is given the ordinary marine verdict for
whichever forecast cell covers it. Vembanad Lake at 9.61, 76.40 is the case to
know about: it reads as water, 2.2 km from the coast, and the screen will show
a sea verdict for a Kerala backwater.

**Why.** Even-odd containment over Natural Earth land is exactly the right rule
for "land or sea" and has no opinion about what kind of water it found. Nothing
in the bundle distinguishes sheltered inland water from open sea either: ORCA's
hazard field is computed over a bounding box, not over a coastline.

The verdict is not wildly wrong in the way an inland-hill verdict was -- a
backwater is water, and a boat is on it -- but the wave and wind forecast being
quoted is for open sea a few kilometres away, and a lagoon does not behave like
open sea. The number is real; it is being applied to the wrong body of water.

**What it would take.** Natural Earth also publishes `ne_10m_lakes`, and the
same clip-and-tag pass in `builder/fetch_land.py` could carry a second set of
rings meaning "inland water". A position inside one would then get its own
answer -- sheltered water, no open-sea forecast applies -- alongside ON LAND
and OUTSIDE COVERED AREA. That is a third state on the verdict block and a
second file to precache, so it is not free, and it was not part of the land
detection step.

**Where.** `onLand` in `src/geo/land.ts`, and `rings_of` in
`builder/fetch_land.py`, which keeps holes and exteriors alike on purpose.

---

## 4. The land mask is 1:10m, simplified to about 55 m

**What.** Within roughly 50 to 100 m of the waterline, land or sea is a coin
toss. A boat tied up at a quay may read as either.

**Why.** Natural Earth 1:10m is the most detailed public-domain global land
polygon set, and it was simplified a further 0.0005 degrees to keep the file at
96 KB, which the app precaches with its shell and therefore pays for on every
first load over 2G. A more detailed coastline exists -- OSM's -- at many times
the size and with per-region licensing to think about.

**What it would take.** A finer source for the coastal strip only, on the same
argument the DEM section of the bundle format makes: detail where someone
stands, not everywhere.

Until then the honest position is that this answers "am I inland" well and "am
I exactly at the waterline" badly, and nothing on the screen is derived from it
at a precision it does not have. The distance to the coast is shown to one
decimal below ten kilometres, which at 0.1 km is already at the edge of what
the mask can support.

**Where.** `SIMPLIFY_DEG` in `builder/fetch_land.py`.

---

## 5. The escape arrow is a bearing, not a route

**What.** The escape screen gives a direction and a distance to the nearest
safe places. It does not know about roads, and the straight line it draws can
cross a bay, a backwater, a river, a rail line, a wall or private land. The
walking time is a lower bound and the real walk can be several times longer.

**Why.** There is no road network on the device. A walkable graph for the
bundled region is on the order of 270,000 ways and 1-2 million nodes -- roughly
20 to 50 MB as a compact binary, against a total app precache of 1.0 MB today.
That is not a download this app can make on a 2G phone, and a routing engine is
not the part that is expensive.

Faking it would be worse than the gap. A drawn route reads as an instruction in
a way a compass bearing does not, and one that sends someone down a flooded
culvert at night is the failure that matters. "Safest path" is also not
"shortest road path" during a surge: roads flood first, at underpasses, low
bridges and embanked sections. The route that is actually safe is the one the
district administration publishes, which carries local knowledge and is not
derivable from OSM geometry at any download size.

**What it would take, in the order worth doing it.**

1. *Major water, free.* The land mask already on the device carries inland
   water as holes -- Vembanad is in there. Drawing those rings on the escape
   map, and testing whether the user-to-target line crosses one, would show a
   lagoon standing between someone and a shelter. It costs no new bytes. It
   catches Vembanad, Ashtamudi, Pulicat and Palk Bay, and it MISSES a thirty
   metre creek, which is the thing most likely to drown someone. It would have
   to be labelled "major water only" or it manufactures confidence.
2. *Real water.* OSM `waterway` and `natural=water` for the coastal strip, a
   few megabytes and a fetch script shaped like the safe-places one.
3. *Routing.* Only if the 20 to 50 MB is judged to be worth it, and probably
   as a per-district download rather than per region.

**Where.** `nearestSafePlaces` in `src/escape/places.ts`, and the line pinned
under the arrow in `index.html`: "Straight-line direction. Follow roads and
official instructions."

**What was fixed rather than recorded.** The walking time used to divide the
straight-line distance by walking speed with no detour allowance at all, which
made the figure for a person in a town more optimistic than the one for a boat
in open water. It now applies `WALK_DETOUR_FACTOR`; see the reasoning at that
constant in `src/constants.ts`.

---

## 6. There is no tide gauge near Nagapattinam

**What.** The app predicts the tide for Kochi and Visakhapatnam. It does not
predict the tide for Nagapattinam, or for anywhere else on the Tamil Nadu
coast, and it says so on the panel in inverted text whenever the nearest
tabulated port is more than 75 km away.

**Why.** UHSLC holds six stations in India and Sri Lanka. The nearest to
Nagapattinam is Cochin at 402 km, on the opposite coast; then Colombo at
425 km; then Visakhapatnam at 854 km, which is at least the same ocean. A tide
curve is a local thing -- the Bay of Bengal and the Arabian Sea run to
different ranges and different times -- so presenting Kochi's curve as
Nagapattinam's would be a fabrication, and the loud line on the panel exists to
stop the demo becoming one by accident.

**What it would take.** A gauge record for the Tamil Nadu coast. INCOIS and the
Survey of India operate stations that UHSLC does not redistribute; an
arrangement with either would fill the gap. Nothing in this repository can.

## 7. The tide is astronomical only, and its heights are not depths

**What.** Two separate limits on the same numbers.

The prediction is the astronomical tide. Storm surge, wind setup and river
flood are not in it, and during the weather this app exists to warn about the
water will be higher than the curve says.

The heights are measured about the mean sea level of the last year of each
station's record, not about chart datum. They are not depths and must not be
subtracted from a chart sounding.

**Why.** Surge is a forecast product. ORCA does not compute one and does not
ingest INCOIS's, so there is nothing to add. Chart datum is a survey
definition; the gauge record gives a mean, and converting between the two needs
the station's published datum relationship, which UHSLC does not carry.

**How good it is.** Fitted on fifteen years of hourly data with the last seven
days held out: Kochi predicts those days to **6.5 cm RMS** against an observed
range of 0.87 m, Visakhapatnam to **4.0 cm** against 1.68 m. Those are the
errors in shape and timing. The raw errors are 30.7 cm and 26.8 cm, almost
entirely a constant offset, because mean sea level itself moved that much over
the week -- which is the same fact as "these are not depths", measured.

The on-device implementation was checked against utide's own reconstruction
over 14 days of hourly predictions: **0.047 cm maximum difference**.

**Where.** `builder/fit_tides.py` for the fit, `src/compute/tide.ts` for the
prediction, `renderTide` in `src/ui/tide.ts` for the wording.

