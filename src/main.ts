/** Wiring only. No arithmetic, no thresholds, no wording. */

import "./ui/style.css";

import { BundleError, parseBundle } from "./bundle/reader.ts";
import {
  fetchBundleBytes,
  fetchRegionIndex,
  isNewer,
  regionContaining,
  regionWithoutPosition,
  type RegionEntry,
} from "./bundle/source.ts";
import { getBundle, listBundles, putBundle } from "./bundle/store.ts";
import { loadLand, type Land } from "./geo/land.ts";
import { loadSafePlaces, type SafePlaces } from "./escape/places.ts";
import { loadTides, type Tides } from "./compute/tide.ts";
import { renderTextMode } from "./ui/textmode.ts";
import {
  closeSea,
  isSeaOpen,
  openSea,
  refreshSos,
  render as renderSea,
  setSeaData,
  setSeaPosition,
  setSeaTides,
  setSpeedKn,
  useSeaManualOrigin,
} from "./ui/sea.ts";
import {
  closeEscape,
  fillManualSelect,
  isEscapeOpen,
  openEscape,
  setEscapeData,
  setEscapeGeoStatus,
  setEscapeLand,
  setEscapePosition,
  useManualOrigin,
} from "./ui/escape.ts";
import {
  centreOnMarker,
  isMounted,
  mountMap,
  refreshMap,
  setMapLand,
  showRegion,
  updateMap,
} from "./map/view.ts";
import { inRegion, locate, nearestPlace } from "./compute/locate.ts";
import {
  clearDenied,
  previouslyDenied,
  requestPosition,
  watchPosition,
  type Position,
  type Watch,
} from "./geo/position.ts";
import type { Bundle, Place } from "./bundle/types.ts";
import {
  clearError,
  districtsOf,
  fillPlaceSelect,
  fillSelect,
  renderPlace,
  renderPosition,
  renderRegion,
  selectablePlaces,
  showError,
} from "./ui/screen.ts";

const districtSelect = document.getElementById("district") as HTMLSelectElement;
const placeSelect = document.getElementById("place") as HTMLSelectElement;
const fileInput = document.getElementById("file") as HTMLInputElement;
const pick = document.getElementById("pick") as HTMLDetailsElement;
const loadHint = document.getElementById("loadHint") as HTMLElement;
const sourceLine = document.getElementById("source") as HTMLElement;
const manual = document.getElementById("load") as HTMLDetailsElement;
const actions = document.getElementById("actions") as HTMLElement;
const centreMe = document.getElementById("centreMe") as HTMLButtonElement;
const regionLine = document.getElementById("region") as HTMLElement;
const locateButton = document.getElementById("locateButton") as HTMLButtonElement;
const placeButton = document.getElementById("placeButton") as HTMLButtonElement;
const locateLine = document.getElementById("locate") as HTMLElement;
const escapeOpenButton = document.getElementById("escapeOpen") as HTMLButtonElement;
const escapeCloseButton = document.getElementById("escapeClose") as HTMLButtonElement;
const escapeManualSelect = document.getElementById("escapeManualSelect") as HTMLSelectElement;
const escapeManualUse = document.getElementById("escapeManualUse") as HTMLButtonElement;
const changeAreaButton = document.getElementById("changeAreaButton") as HTMLButtonElement;
const textModeButton = document.getElementById("textModeButton") as HTMLButtonElement;
const chatButton = document.getElementById("chatButton") as HTMLButtonElement;
const textModeClose = document.getElementById("textModeClose") as HTMLButtonElement;
const textModePanel = document.getElementById("textMode") as HTMLElement;
const textModeBody = document.getElementById("textModeBody") as HTMLElement;
const seaOpenButton = document.getElementById("seaOpen") as HTMLButtonElement;
const seaCloseButton = document.getElementById("seaClose") as HTMLButtonElement;
const seaManualSelect = document.getElementById("seaManualSelect") as HTMLSelectElement;
const seaManualUse = document.getElementById("seaManualUse") as HTMLButtonElement;
const seaSpeedInput = document.getElementById("seaSpeed") as HTMLInputElement;

const LAST_PLACE_KEY = "orca.lastPlace";

let bundle: Bundle | null = null;
let places: Place[] = [];

/** The last fix, or null when the screen is following a chosen place. */
let position: Position | null = null;

/**
 * The land mask, and the promise that fetches it.
 *
 * Started at module load, deliberately, so the 96 KB download overlaps GPS
 * acquisition rather than queueing behind it -- a cold fix on a cheap phone
 * takes seconds of its own, and on 2G those are the seconds this needs.
 *
 * Nothing awaits it until a POSITION has to be judged. The stored bundle and
 * the place selectors do not need it, so a verdict for a chosen landing centre
 * is still on screen before the network has finished with this.
 */
const landReady = loadLand();
let land: Land | null = null;

/** Places to run to. Loaded per region once a bundle is known. */
let safePlaces: SafePlaces | null = null;

/** Harmonic constants for the tide, loaded per region. */
let tides: Tides | null = null;

/**
 * The live GPS watch.
 *
 * One watch, shared by the home screen and the escape screen, rather than one
 * each. Two high-accuracy watches cost twice the battery for the same fix, and
 * a phone that dies during an evacuation is worse than an app that never had
 * the feature.
 */
let watch: Watch | null = null;
void landReady.then((loaded) => {
  land = loaded;
  // The map shades land with it, which is what tells sea from shore.
  setMapLand(loaded);
  setEscapeLand(loaded);
  setSeaData(bundle, loaded);
  // A position already on screen was judged without the mask. Judge it again.
  if (position !== null) draw();
});

function setSource(text: string): void {
  sourceLine.textContent = text;
}

// ---------------------------------------------------------------------------
// selection and rendering
// ---------------------------------------------------------------------------

function placesInDistrict(district: string): Place[] {
  return places.filter((p) => p.district === district);
}

function selectedPlace(): Place | undefined {
  return places.find((p) => p.id === placeSelect.value);
}

/** The marker the map should draw, or null when there has been no fix. */
function currentMarker(): { lat: number; lon: number; accuracyM: number } | null {
  return position === null
    ? null
    : { lat: position.lat, lon: position.lon, accuracyM: position.accuracyM };
}

/**
 * Push the current selection and fix to the map.
 *
 * `centreOn` is only passed when the view should move. An ordinary redraw
 * leaves it alone, so a pan or a pinch survives the next render.
 */
function syncMap(centreOn?: { lat: number; lon: number } | null): void {
  if (!isMounted()) return;
  updateMap({
    selected: position === null ? selectedPlace() ?? null : null,
    marker: currentMarker(),
    centreOn,
  });
}

function draw(): void {
  if (bundle === null) return;

  // A live position wins over the selectors. The user asked about where they
  // are, and quietly answering about somewhere else would be the worst kind of
  // wrong on this screen.
  if (position !== null) {
    renderPosition(bundle, position, Date.now(), land);
    syncMap();
    return;
  }

  const place = selectedPlace();
  if (place === undefined) return;
  // Read the clock at render time rather than at load time, so a screen left
  // open across an hour boundary redraws against the right forecast hour.
  renderPlace(bundle, place, Date.now());
  // Picking an area by hand moves the map to it. The marker stays drawn, so
  // someone can see where they are and where they are asking about at once.
  syncMap({ lat: place.lat, lon: place.lon });
  try {
    localStorage.setItem(LAST_PLACE_KEY, place.id);
  } catch {
    // Private browsing or a full quota. Remembering the last place is a
    // convenience; losing it must not stop the app rendering a verdict.
  }
}

function followPlace(): void {
  position = null;
  setEscapePosition(null);
  locateLine.className = "locate";
  locateLine.hidden = true;
  placeButton.hidden = true;
  locateButton.hidden = false;
  setLive(false);
  draw();
}

/** The inverted badge in the header, and the map's centre-on-me button. */
function setLive(live: boolean): void {
  regionLine.className = live ? "head__state head__state--live" : "head__state";
  if (live) regionLine.textContent = "Your location";
  else if (bundle !== null) regionLine.textContent = bundle.meta.region_name;
  // ENABLED WHENEVER THERE IS A FIX, full stop.
  //
  // This used to also require the fix to be inside the loaded region, on the
  // reasoning that centring outside it would pan the map onto a blank
  // rectangle. That reasoning died when the land mask started shading the map:
  // there is coastline and land everywhere in India now, so a marker outside
  // the region lands on a picture rather than on nothing.
  //
  // Meanwhile the rule made the button dead for anyone testing from outside
  // Kerala or Tamil Nadu -- which is everyone at a desk -- and a control that
  // never responds is indistinguishable from a broken one.
  centreMe.disabled = position === null;
}

function onDistrictChange(): void {
  const inDistrict = placesInDistrict(districtSelect.value);
  fillPlaceSelect(placeSelect, inDistrict);
  if (inDistrict.length > 0) placeSelect.value = inDistrict[0]!.id;
  draw();
}

function activate(parsed: Bundle): void {
  bundle = parsed;
  places = selectablePlaces(parsed);

  renderRegion(parsed);
  pick.hidden = false;
  mountMap(parsed);
  loadHint.textContent =
    `${parsed.meta.region_name}: ${places.length} landing centres, ` +
    `${parsed.nCells} forecast areas, ${parsed.nHours} hours.`;

  actions.hidden = false;

  // The escape screen becomes available the moment there is ANY place list,
  // using the bundle's landing centres until the real one arrives. It must
  // never be the case that the button is there and the screen is empty.
  setEscapeData(parsed, safePlaces);
  fillManualSelect(escapeManualSelect, parsed);
  escapeOpenButton.hidden = false;

  // Sea mode needs no new data: the harbours and the boundary lines are in the
  // bundle already, and the land mask is the one the escape screen precached.
  setSeaData(parsed, land);
  fillManualSelect(seaManualSelect, parsed);
  seaOpenButton.hidden = false;
  changeAreaButton.hidden = false;
  textModeButton.hidden = false;
  // Staging only, and only once there is a bundle to answer about.
  if (import.meta.env.VITE_FLAG_CHAT === "true") chatButton.hidden = false;
  document.getElementById("seaDisclaimer")!.textContent =
    parsed.meta.boundary_disclaimer;

  if (safePlaces === null || safePlaces.regionId !== parsed.meta.region_id) {
    void loadSafePlaces(parsed.meta.region_id).then((loaded) => {
      safePlaces = loaded;
      setEscapeData(bundle, loaded);
    });
  }

  if (tides === null || tides.regionId !== parsed.meta.region_id) {
    void loadTides(parsed.meta.region_id).then((loaded) => {
      tides = loaded;
      setSeaTides(loaded);
    });
  }

  const districts = districtsOf(places);
  fillSelect(districtSelect, districts);

  let restored: Place | undefined;
  try {
    const lastId = localStorage.getItem(LAST_PLACE_KEY);
    if (lastId !== null) restored = places.find((p) => p.id === lastId);
  } catch {
    restored = undefined;
  }

  districtSelect.value = restored?.district ?? districts[0] ?? "";
  onDistrictChange();
  if (restored !== undefined) {
    placeSelect.value = restored.id;
    draw();
  }
}

// ---------------------------------------------------------------------------
// getting a bundle
// ---------------------------------------------------------------------------

async function store(parsed: Bundle, bytes: ArrayBuffer, filename: string): Promise<void> {
  await putBundle({
    regionId: parsed.meta.region_id,
    bytes,
    savedAt: Date.now(),
    filename,
    generatedAt: parsed.meta.generated_at,
  });
}

/** The stored bundle, activated if it parses. Runs first and never waits on the network. */
async function useStored(): Promise<{ regionId: string; generatedAt: string } | null> {
  let stored;
  try {
    stored = await listBundles();
  } catch {
    return null;
  }
  if (stored.length === 0) return null;

  stored.sort((a, b) => b.savedAt - a.savedAt);
  const entry = await getBundle(stored[0]!.regionId);
  if (entry === undefined) return null;

  try {
    // Parsed again on every launch, not cached as an object. This is what
    // makes the version handshake run each time, so a bundle that a newer app
    // build must refuse is refused, rather than sailing through because it
    // was accepted once.
    const parsed = parseBundle(entry.bytes);
    activate(parsed);
    setSource(`Using the bundle stored on this device: ${parsed.meta.region_name}.`);
    return { regionId: entry.regionId, generatedAt: entry.generatedAt };
  } catch (err) {
    showError(
      err instanceof BundleError
        ? `${err.message} (stored ${new Date(entry.savedAt).toLocaleDateString()})`
        : "The stored bundle could not be read.",
    );
    return null;
  }
}

/**
 * Look for a newer bundle.
 *
 * Runs after the stored one is already on screen, so the network is never
 * between a user and a verdict they already have. Every failure here is quiet
 * and leaves the stored bundle in place: being out of range is the normal
 * condition this app is built for, not an error to shout about.
 *
 * `position` is used only to choose which region to download. It is passed to
 * `regionContaining`, which is a local array scan; it never reaches a URL.
 */
async function refresh(
  have: { regionId: string; generatedAt: string } | null,
  position: { lat: number; lon: number } | null,
): Promise<void> {
  let index: RegionEntry[];
  try {
    index = await fetchRegionIndex();
  } catch {
    if (have === null) {
      setSource("No bundle on this device, and no network to fetch one.");
      manual.open = true;
    }
    return;
  }

  // A POSITION PREFERS A REGION. IT DOES NOT DECIDE WHETHER TO DOWNLOAD ONE.
  //
  // These used to be the same question, and the bug that produced was the
  // worst kind: a fix outside every box meant no download at all, so a phone
  // with a working connection sat there with an empty screen saying the user
  // was outside coverage. Being outside the covered water is a reason to
  // choose the region differently. It is never a reason to have no forecast on
  // the device, and a boat heading toward covered water is exactly the case
  // where the download matters most.
  //
  // So: the containing region if there is one, otherwise whatever we would
  // have downloaded with no position at all.
  const entry =
    (position === null
      ? null
      : regionContaining(index, position.lat, position.lon)) ??
    regionWithoutPosition(index, have?.regionId ?? null);

  if (entry === null) {
    // Nothing to choose between: no region contains the fix, none is stored,
    // and there is more than one on offer. Only now is the file picker the
    // honest next step.
    if (have === null) {
      setSource(`${index.length} regions available. Choose a bundle file below.`);
      manual.open = true;
    }
    return;
  }

  if (have !== null && have.regionId === entry.region_id &&
      !isNewer(entry, have.generatedAt)) {
    setSource(`${entry.name}: up to date.`);
    return;
  }

  try {
    const bytes = await fetchBundleBytes(entry);
    const parsed = parseBundle(bytes);
    await store(parsed, bytes, entry.file);
    activate(parsed);
    setSource(`${parsed.meta.region_name}: downloaded and stored on this device.`);
  } catch (err) {
    // A download that fails or will not parse must never replace a good stored
    // bundle. Better a forecast that is a few hours old than none at all.
    if (have === null) {
      showError(
        err instanceof BundleError ? err.message : "The bundle could not be downloaded.",
      );
      manual.open = true;
    } else {
      setSource(
        err instanceof BundleError
          ? `Kept the stored bundle: ${err.message}`
          : "Could not reach the shore system. Using the bundle stored on this device.",
      );
    }
  }
}

async function loadFile(file: File): Promise<void> {
  clearError();
  const bytes = await file.arrayBuffer();

  let parsed: Bundle;
  try {
    parsed = parseBundle(bytes);
  } catch (err) {
    // A bundle that fails the handshake is never stored. Keeping a file the
    // app has already refused would only mean refusing it again on every
    // launch, with the user unable to see why.
    showError(err instanceof BundleError ? err.message : "This file could not be read.");
    return;
  }

  await store(parsed, bytes, file.name);
  activate(parsed);
  setSource(`${parsed.meta.region_name}: loaded from ${file.name} and stored.`);
  manual.open = false;
}

// ---------------------------------------------------------------------------
// service worker
// ---------------------------------------------------------------------------

/**
 * Register the offline shell.
 *
 * Production only: a worker left registered against the dev server would go on
 * serving a stale build after every source change, which costs an afternoon
 * the first time it happens.
 *
 * On `load` rather than immediately, so installing the shell never competes
 * with first paint. On 2G that ordering is the difference between a verdict in
 * two seconds and a verdict after the whole shell has downloaded again.
 *
 * A failure here is not fatal. The app still works for this session; it simply
 * will not work offline yet, and the next visit will try again.
 */
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err: unknown) => {
      console.warn("offline shell not installed:", err);
    });
  });
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

districtSelect.addEventListener("change", () => { position = null; onDistrictChange(); });
placeSelect.addEventListener("change", () => { position = null; draw(); });
placeButton.addEventListener("click", followPlace);
locateButton.addEventListener("click", () => {
  // An explicit tap clears a remembered refusal: the user is asking now.
  clearDenied();
  void useLocation(true);
});

centreMe.addEventListener("click", centreOnMarker);

// ---------------------------------------------------------------------------
// keeping up to date
// ---------------------------------------------------------------------------

/** True while a refresh is in flight, so a burst of events does one download. */
let refreshing = false;

/**
 * The network came back.
 *
 * Until this existed the app only ever looked for a newer forecast at launch,
 * so a phone that had been at sea for three days with the screen open came
 * back into range and did nothing at all. It kept rendering the bundle it had
 * until somebody thought to close and reopen it, which is not a thing anyone
 * does while deciding whether to go out.
 *
 * `online` fires more than once on a flaky connection, hence the guard: a
 * bundle is 324 KB and downloading it four times because the radio flapped is
 * exactly the wrong behaviour on a metered link.
 */
async function onBackOnline(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    const have = bundle === null
      ? null
      : { regionId: bundle.meta.region_id, generatedAt: bundle.meta.generated_at };
    // A live fix still picks the region; it still never reaches a URL.
    await refresh(have, position === null ? null : { lat: position.lat, lon: position.lon });
    // refresh() calls activate() when a newer bundle actually lands, which
    // re-renders the verdict from the new data. This redraw is for the case
    // where it did not: the screen may still be showing a stale age or an
    // hour that has since rolled over.
    draw();
  } finally {
    refreshing = false;
  }
}

window.addEventListener("online", () => { void onBackOnline(); });

/**
 * Redraw when the forecast hour rolls over.
 *
 * draw() reads the clock at render time rather than at load time, which is the
 * right place to read it -- but nothing was ever scheduling the render, so a
 * screen left open in place-following mode showed the previous hour's verdict
 * and a frozen data age until somebody touched a control. With GPS running the
 * position watch happened to redraw every few seconds and hid the problem.
 *
 * One timer, aimed a second past the next hour boundary, rearmed each time. No
 * polling: it sleeps for the rest of the hour.
 */
function scheduleHourRedraw(): void {
  const HOUR_MS = 3600000;
  const now = Date.now();
  const wait = HOUR_MS - (now % HOUR_MS) + 1000;
  window.setTimeout(() => {
    if (bundle !== null) {
      draw();
      // The map colours cells by the same forecast hour, so it moves too.
      refreshMap();
    }
    scheduleHourRedraw();
  }, wait);
}

scheduleHourRedraw();

// openEscape must run from the tap itself: iOS only grants the compass from
// inside a user gesture, and asking later fails silently.
escapeOpenButton.addEventListener("click", () => { void openEscape(); });
escapeCloseButton.addEventListener("click", closeEscape);

// openSea from the tap itself, for the same iOS compass reason as openEscape.
seaOpenButton.addEventListener("click", () => {
  void openSea().then(refreshSos);
});
seaCloseButton.addEventListener("click", closeSea);

// "Change area" opens the disclosure below and scrolls to it. The selectors
// stay collapsed by default -- they were the biggest permanently-visible block
// on the screen -- but a button in the fixed region means nobody has to know
// to scroll to find them.
/**
 * Text only.
 *
 * Redrawn from scratch every time it opens and on every accepted fix, because
 * it is cheap -- it is a few dozen strings -- and because a stale number on the
 * one screen that exists to be trustworthy would be worse than no screen.
 */
function drawTextMode(): void {
  renderTextMode(textModeBody, {
    bundle,
    land,
    safe: safePlaces,
    tides,
    position,
    place: position === null ? selectedPlace() : undefined,
    nowMs: Date.now(),
  });
}

let textModeOpen = false;

/**
 * The chat assistant, loaded ONLY when the flag is on.
 *
 * A dynamic import rather than a static one, so Vite puts it in its own chunk
 * and a production build never downloads it. The flag alone was not enough:
 * gating the button still shipped the module, its fetch call and its strings
 * to every user on a 2G connection who could never open it. `import.meta.env`
 * is substituted at build time, so in production this branch is a constant
 * false and the chunk is never requested.
 */
if (import.meta.env.VITE_FLAG_CHAT === "true") {
  void import("./ui/chat.ts").then((chat) => {
    chat.mountChat();
    chatButton.addEventListener("click", () => {
      // The assistant answers about a place; give it the one on screen.
      chat.setChatLocation(position !== null
        ? { lat: position.lat, lon: position.lon }
        : { place: selectedPlace()?.name });
      chat.openChat();
    });
  });
}

textModeButton.addEventListener("click", () => {
  textModeOpen = true;
  textModePanel.hidden = false;
  document.body.classList.add("body--escape");
  drawTextMode();
});

textModeClose.addEventListener("click", () => {
  textModeOpen = false;
  textModePanel.hidden = true;
  document.body.classList.remove("body--escape");
});

changeAreaButton.addEventListener("click", () => {
  pick.open = true;
  pick.scrollIntoView({ behavior: "smooth", block: "start" });
});
seaManualUse.addEventListener("click", () => {
  const [lat, lon] = seaManualSelect.value.split(",").map(Number);
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    useSeaManualOrigin(lat!, lon!);
    refreshSos();
  }
});
seaSpeedInput.addEventListener("change", () => {
  setSpeedKn(Number(seaSpeedInput.value));
});
escapeManualUse.addEventListener("click", () => {
  const [lat, lon] = escapeManualSelect.value.split(",").map(Number);
  if (Number.isFinite(lat) && Number.isFinite(lon)) useManualOrigin(lat!, lon!);
});

// Escape closes the escape screen, which is what every other full-screen layer
// on a phone does and costs nothing to honour.
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (isEscapeOpen()) closeEscape();
  else if (isSeaOpen()) closeSea();
});
fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file !== undefined) void loadFile(file);
});

/**
 * Follow the position once the user has granted it.
 *
 * Started only after a first successful fix, so nothing here can trigger the
 * permission prompt on its own. It stops itself when the screen is hidden;
 * see watchPosition in src/geo/position.ts.
 */
function startWatch(): void {
  if (watch !== null) return;
  watch = watchPosition((fix) => {
    position = fix;
    setEscapePosition(fix);
    setSeaPosition(fix);
    if (isSeaOpen()) refreshSos();
    // The escape screen redraws itself from setEscapePosition. Redrawing the
    // home screen underneath it would be work nobody can see.
    if (textModeOpen) drawTextMode();
    if (!isEscapeOpen()) {
      setLive(bundle !== null && inRegion(bundle, fix.lat, fix.lon));
      draw();
    }
  }, (outcome) => {
    // A watch that starts failing must not leave the escape screen showing a
    // stale fix as though it were current.
    if (outcome.kind !== "ok") setEscapeGeoStatus(outcome.kind);
  });
}

/**
 * Ask where we are, and use it.
 *
 * GPS needs no network, so this works at sea. The position is used for three
 * things, all of them local: which cell's verdict to show, where to measure
 * the boundary and harbour from, and which region's bundle to download. Only
 * the third involves the network at all, and it picks an entry out of a list
 * that has already arrived. Nothing sends the position anywhere.
 */
async function useLocation(explicit: boolean): Promise<void> {
  locateLine.hidden = false;
  locateLine.className = "locate";
  locateLine.textContent = "Finding your location...";

  const outcome = await requestPosition();

  if (outcome.kind !== "ok") {
    // Quietly back to the selectors. No second prompt, no modal, no red box:
    // a refused permission is a choice, not a failure.
    position = null;
    placeButton.hidden = true;
    locateButton.hidden = false;
    setLive(false);
    // The escape screen has to explain the absence rather than sit blank, and
    // it opens its manual picker off the back of this.
    setEscapePosition(null);
    setEscapeGeoStatus(outcome.kind);
    if (explicit) {
      locateLine.textContent =
        outcome.kind === "denied"
          ? "Location is off for this app. Pick a place below instead."
          : outcome.kind === "timeout"
            ? "No location fix yet. Pick a place below, or try again outdoors."
            : `Location unavailable: ${outcome.reason}. Pick a place below.`;
    } else {
      locateLine.hidden = true;
    }
    return;
  }

  position = outcome.position;

  // With a position, download the region that contains it rather than whatever
  // happens to be stored.
  const have = bundle === null
    ? null
    : { regionId: bundle.meta.region_id, generatedAt: bundle.meta.generated_at };
  await refresh(have, { lat: position.lat, lon: position.lon });

  if (bundle === null) {
    locateLine.textContent =
      "Found your location, but there is no forecast bundle on this device yet.";
    return;
  }

  // Pre-fill the selectors with the nearest landing centre, so switching away
  // from the live position lands somewhere sensible rather than at the top of
  // an alphabetical list.
  const near = nearestPlace(places, position.lat, position.lon);
  if (near !== undefined && near !== null) {
    districtSelect.value = near.district;
    const inDistrict = placesInDistrict(near.district);
    fillPlaceSelect(placeSelect, inDistrict);
    placeSelect.value = near.id;
  }

  // The mask before the verdict. By now it has had the whole GPS acquisition to
  // arrive, and after the first visit it comes from the precache instantly; on
  // a cold 2G first run this waits rather than showing a sea verdict to someone
  // standing on a hill, which is the entire point of having the file.
  land = await landReady;

  const located = locate(bundle, position.lat, position.lon);
  const covered = located.cellIndex !== null;

  // ONE SENTENCE ABOUT BEING OUTSIDE COVERAGE, AND THIS IS IT.
  //
  // There used to be two, because `refresh` also wrote one into the source
  // line, and a reader met the same fact twice in different words a few
  // centimetres apart. The source line is now strictly about the bundle: what
  // was downloaded, what was kept, how old it is. Where the user is with
  // respect to that bundle is said here and nowhere else.
  //
  // The verdict block says OUTSIDE COVERED AREA independently, and that is not
  // a third copy of this message: it is the verdict, which CLAUDE.md requires
  // to read that way rather than to show a word with no number behind it.
  locateLine.className = covered ? "locate locate--live" : "locate";
  locateLine.textContent = covered
    ? `Showing your own location, accurate to about ` +
      `${Math.round(position.accuracyM)} m` +
      (near ? `, near ${near.name}.` : ".")
    : `You are outside ${bundle.meta.region_name}. The map and the areas below ` +
      `describe that coast; pick one to read its forecast.`;

  locateButton.hidden = true;
  placeButton.hidden = false;
  setLive(covered);
  setEscapePosition(position);
  setSeaPosition(position);
  startWatch();

  // Granting location centres the map on the user, once -- but only if the
  // user is somewhere the map can draw. A fix outside the region would pan the
  // canvas off its own data, so the map opens on the region instead and stays
  // useful: the coast, the cells and the landing centres are all still there
  // to be read and picked from.
  if (inRegion(bundle, position.lat, position.lon)) {
    syncMap({ lat: position.lat, lon: position.lon });
  } else {
    syncMap();
    showRegion();
  }
  draw();
}

void (async () => {
  // Stored first, network second, location third. The screen is useful before
  // anything is fetched, which is the whole point.
  const have = await useStored();
  if (have === null) setSource("Looking for a forecast bundle...");

  if (previouslyDenied()) {
    // Asked once, refused once. Do not ask again; the button is still there.
    await refresh(have, null);
    return;
  }

  await useLocation(false);
  if (position === null) await refresh(have, null);
})();
