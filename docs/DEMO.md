# Demo checklist and manual tests

Automated checks cover the data and the wiring. They cannot show that the map
looks right or that GPS works, so those are here.

```sh
.venv/bin/python builder/build_bundle.py --region kerala-tn
.venv/bin/python builder/verify_bundle.py public/bundles/kerala-tn.orcabundle
npm run build
npm run preview            # http://localhost:4173
```

**Do this first, on the morning of the demo.** ORCA refreshes every 12 hours.
If its last fetch is older than that, every screen opens with the black
"THIS FORECAST IS ... OLD" banner, which is correct behaviour and a poor first
impression. Run ORCA's ingest, then rebuild the bundle:

```sh
cd ~/SIH2026/orca/backend
python -m jobs.ingest_forecast --bbox 7.0 74.0 13.6 81.0 --max-cells 2500 --sea-only --forecast-days 3
python -m jobs.compute_risk --hours 72
```

Service workers and geolocation both need a secure context. `http://localhost`
counts; a LAN address does not. On a phone use `adb reverse tcp:4173 tcp:4173`
and open `http://localhost:4173` there.

---

## Part 1: the bundle loads itself

1. Open `http://localhost:4173` in a fresh profile or after clearing site data.
2. Expect: no file picker. Within a second or two the region name appears and
   the line under the figures reads "Kerala and Tamil Nadu coast: downloaded
   and stored on this device."
3. DevTools, Application, IndexedDB, `orca-mobile`, `bundles`: one record,
   `regionId` `kerala-tn`.
4. DevTools, Network: confirm two requests, `/bundles/index.json` then
   `/bundles/kerala-tn.orcabundle`. Confirm **neither carries a coordinate**
   in its URL. Nothing else should go out.
5. Reload. The line now reads "up to date" and the bundle is not downloaded
   again.
6. Set Network to Offline and reload. It still opens, and the line reads
   "Using the bundle stored on this device".
7. Open the collapsed "Load a bundle file instead" at the bottom and confirm
   the manual picker still works with `public/bundles/kerala-tn.orcabundle`.

## Part 2: the map, and the layout

The map is on the main screen now. There is no Map button.

### The layout rule

1. DevTools, toggle device emulation, choose **Responsive** and set **360 x 640**.
2. Scroll to the top.
3. Confirm all of this is visible at once, without scrolling: the header, the
   map, the legend strip, the verdict line **with its number**, and all three
   figures.
4. Scroll down. Below the fold you should find the reference line, the
   "Change area" selectors, the source line and the bundle fallback link.
5. Now force the stale strip. The simplest way is to leave the bundle
   unrefreshed until its forecast is over 12 hours old, which it is unless you
   have just re-run ORCA. Confirm the black strip appears **above** the map and
   that the verdict and all three figures are still visible without scrolling.
6. Shrink the emulated height to 560. The map should shrink; the verdict and
   figures should stay put.

### The map itself

1. Expect: coastline as a heavy line, hexagons over the water, a scale bar in
   the bottom right, and a "Centre on me" button in the bottom right, disabled
   until there is a fix.
2. The legend is the strip **under** the map, not drawn on it. Check the four
   swatches are distinguishable by pattern and not just by darkness: dense
   diagonal hatch, dots, blank, square grid. Squint; they should still differ.
3. Drag with one finger to pan. Pinch to zoom. On a desktop use the scroll
   wheel. Panning stays smooth because the pattern fills drop out during a
   gesture and return when you let go.
4. Confirm the scale bar label changes as you zoom, and that at region zoom one
   hexagon measures roughly 8.5 km against it.
5. Change the landing centre in "Change area". The map should move to that
   place, and the selected place is drawn as a filled square inside a ring.

## Part 3: location

The important test is the one that must NOT produce a verdict, so do both.

### Faking a position in Chrome DevTools

1. Open DevTools.
2. Press **Cmd-Shift-P** (Ctrl-Shift-P on Windows) and run **Show Sensors**.
3. In the Sensors panel, **Location**, choose **Other...** and enter latitude
   and longitude.
4. Reload the page after changing it. Geolocation is read at startup.

### A position inside the region

Latitude `9.92`, longitude `76.10`. That is open water off Kochi.

Expect:

- the browser asks for location permission on first open; allow it
- the header's right-hand label inverts and reads **YOUR LOCATION**
- the map centres on you, and draws a solid black dot in a white ring with a
  dashed accuracy circle around it
- **Centre on me** becomes enabled. Pan away, then tap it and the map returns.
- a verdict **with a number**, for your own cell rather than a chosen place
- the reference line reads "Your position, accurate to about N m ... Distances
  are measured from you"
- the district and place selectors have jumped to the nearest landing centre
- picking a different landing centre moves the map there while your own dot
  stays drawn, so both are visible at once
- tapping **Use this place** hands the screen back to the selectors and the
  header stops showing YOUR LOCATION

Verified from the command line already: that coordinate resolves to cell 186,
whose centre is 5.7 km away, and reads "SAFE TO GO OUT, highest chance of
dangerous seas is 2.0%".

### A position outside every region

Latitude `28.6139`, longitude `77.2090`. That is Delhi, far inland.

Expect **"OUTSIDE COVERED AREA — no forecast covers where you are. This is not
the same as safe."** and no percentage anywhere on the verdict line. This is
the case worth showing a judge: the app declines to answer rather than
answering about the wrong water.

### Refusing permission

1. Clear site data, reload, and press **Block** on the permission prompt.
2. Expect: the selectors appear and work, and there is no error box and no
   second prompt.
3. Reload again. Expect **no prompt at all**. The refusal is remembered.
4. Tap **Use my location**. That is an explicit request, so it asks again.

---

## What is not built

- **Route.** The button is in the "Change area" section, disabled and hatched,
  so the screen does not look finished when it is not.
- **Coastal evacuation.** ORCA holds no elevation data of any kind. See
  `docs/KNOWN_LIMITATIONS.md`.
- Two accepted limitations that will come up if a judge is sharp: the nearest
  boundary figure covers the maritime boundary and protected areas only, and
  all durations are calm-water times. Both are written up in
  `docs/KNOWN_LIMITATIONS.md` with the reasoning and the fix.
