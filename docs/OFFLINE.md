# Testing the offline shell

`npm run check:sw` verifies the built worker, the precache list, the manifest
and the icons. It cannot prove the app works offline. Only a browser can, and
these are the steps.

Two things to know before starting.

**Service workers need a secure context.** `http://localhost` counts. A LAN
address like `http://192.168.1.20:4173` does not, and the worker will silently
never register. Testing on a real phone therefore needs `adb reverse`, not the
machine's IP. See the last section.

**The worker is registered in production builds only.** `npm run dev` does not
register it, on purpose: a worker left over from a dev session goes on serving
a stale build after every source change. Always test against `npm run preview`.

---

## 1. Build and serve

```sh
npm run build
npm run preview            # http://localhost:4173
```

The build prints the precache list. Expect 7 files and about 29 KB.

## 2. First load, online

1. Open `http://localhost:4173` in Chrome.
2. Choose a bundle with **Load bundle file**. Use `out/kerala-tn.orcabundle`.
3. Pick a district and a landing centre. A verdict, three figures and a
   "forecast for the water N km from ..." line should appear.

Note the exact verdict text and the data age. You are checking that the same
thing comes back offline, not just that something does.

## 3. Confirm the worker installed

DevTools, **Application** tab.

- **Service Workers**: one worker, source `/sw.js`, status `activated and is
  running`, scope `http://localhost:4173/`.
- **Cache Storage**: one cache named `orca-shell-<12 hex characters>`
  containing exactly the 7 files the build listed. If there are two caches,
  the old one was not cleaned up and that is a bug.
- **IndexedDB**: database `orca-mobile`, store `bundles`, one record whose
  `regionId` is `kerala-tn`. The bundle must be here and **not** in Cache
  Storage.

## 4. Go offline and reload

1. DevTools, **Network** tab, set throttling to **Offline**. Ticking Offline
   under Application, Service Workers is not the same thing and only stops the
   worker reaching the network, so use the Network tab.
2. Reload with **Cmd-R**.

Expected:

- The app opens. No dinosaur, no blank page.
- The district and landing centre you picked are still selected.
- The same verdict word and the same percentage appear.
- The data age is the same or slightly **larger**. It must not be blank, and
  it must not have reset.
- In the Network panel every request shows a gear icon or `(ServiceWorker)` in
  the Size column.

Then close the tab, still offline, and open `http://localhost:4173` again. It
should still work. That is the case that matters: a phone rebooted at sea.

## 5. The 12 hour warning, offline

No need to touch the system clock. The sample bundle's forecast was issued at
**2026-09-10 05:16Z**, so from **17:16Z** onward it is more than 12 hours old.

At or after that time, still offline, the screen must show:

- the data age figure inverted, white on black
- a black banner reading `THIS FORECAST IS AT LEAST N H OLD. Download a new
  bundle before going out.`

The wording is "at least" because Open-Meteo publishes no model run time and
ORCA records the fetch time as a proxy. If it ever reads plainly "N h old" for
these sources, that is a bug.

## 6. Installing to the Android home screen

On the desktop first, as a smoke test: Chrome address bar shows an install
icon, or menu, Cast Save and Share, Install page as app. The icon should be
the white dorsal fin on black.

On a real phone, over USB:

```sh
adb reverse tcp:4173 tcp:4173
```

Then open `http://localhost:4173` in Chrome **on the phone**. The forwarded
port keeps it a localhost origin, which is what makes the worker register.

Expect: menu, Add to home screen offers **Install** rather than a plain
shortcut. After installing, the app opens with no browser chrome, stays in
portrait, and the launcher icon is the fin, cropped to a circle without
clipping the mark.

## 7. Updating

The worker does not call `skipWaiting`, so a new version takes effect on the
next launch rather than swapping under an open screen.

To see that:

1. With a tab open, change something visible, then `npm run build` again.
2. Reload once. DevTools, Application, Service Workers shows a second worker
   as **waiting to activate**. The page still shows the old build. This is
   correct.
3. Close every tab on the origin, then open it again. The new worker is now
   active, the old cache is gone, and the change is visible.

---

## What a failure means

| Symptom | Likely cause |
|---|---|
| No worker in Application | Not a secure context, or you are on `npm run dev` |
| Worker present, reload fails offline | A file is served but not precached. `npm run check:sw` catches this |
| Two `orca-shell-` caches | Cleanup in `activate` did not run |
| Bundle appears in Cache Storage | The `.orcabundle` bypass in `sw.js` is broken |
| Data age blank or frozen offline | Age is being read from something other than the bundle plus the device clock |
| Update visible immediately | `skipWaiting` or `clients.claim` crept in. `npm run check:sw` catches this |
