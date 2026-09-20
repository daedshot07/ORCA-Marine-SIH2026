#!/usr/bin/env python3
"""Fit tidal harmonic constants from open tide-gauge data.

    .venv/bin/python builder/fit_tides.py

Run this once. It needs network; ordinary builds do not, because the result is
committed at public/tides/<region>.json.

SOURCE
------
University of Hawaii Sea Level Center (UHSLC) Fast Delivery hourly sea level,
https://uhslc.soest.hawaii.edu/. Research-quality where available, fast
delivery otherwise. Hourly heights in millimetres relative to the station
datum. Freely available for research and education; the attribution travels in
the output file and is shown on screen.

NO LICENSED MODEL DATA IS SHIPPED. Every number in the output is fitted here
from that observed record. Nothing comes from FES, TPXO, or any other
restricted global tide model.

THERE IS NO GAUGE NEAR NAGAPATTINAM
-----------------------------------
UHSLC holds six stations in India and Sri Lanka. The nearest to Nagapattinam
is Cochin at 402 km -- on the OTHER COAST -- then Colombo at 425 km. The
nearest gauge on the same coast is Vishakhapatnam at 854 km.

So this does not ship a tide for Nagapattinam, and the app must never claim
one. It ships the ports that have data, each labelled with where it actually
is and how far that is from anywhere else. A tide curve is a local thing: the
Bay of Bengal and the Arabian Sea run to different ranges and different times,
and presenting Cochin's curve as Nagapattinam's would be a fabrication.

THE NODAL CORRECTIONS ARE COMPUTED HERE, NOT ON THE DEVICE
----------------------------------------------------------
The device needs f (node factor) and V0+u (equilibrium argument) for every
constituent at prediction time. Both come from Schureman's formulas, which are
long, easy to get subtly wrong, and would have to be reimplemented in
TypeScript to no benefit.

They also vary on an 18.6-year cycle, which means they are effectively
constant across a month. So this script samples them at the start of every
month for the next few years using utide's own FUV, and ships the table. The
device picks its month and evaluates

    h(t) = Z0 + sum over constituents of  f * A * cos(w*(t - t_month) + (V0+u) - g)

which is the same equation with the astronomy already done. The corrections
are genuinely applied; they are just not recomputed on a phone.
"""

from __future__ import annotations

import argparse
import io
import json
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import utide
from utide.harmonics import FUV

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "public" / "tides"
CACHE_DIR = ROOT / ".tide-cache"

ATTRIBUTION = (
    "Tide gauge data: University of Hawaii Sea Level Center (UHSLC) Fast "
    "Delivery, uhslc.soest.hawaii.edu. Harmonic constants fitted from the "
    "observed record; no licensed tide model is used."
)

#: The constituents the brief asks for, plus the shallow-water pair that
#: matters in these estuaries. utide drops any it cannot resolve.
CONSTITUENTS = ["M2", "S2", "N2", "K2", "K1", "O1", "P1", "Q1", "M4", "MS4"]

#: Stations to fit. Nagapattinam is 10.76 N, 79.85 E; the distances are to it.
STATIONS = [
    {"id": 174, "name": "Kochi (Cochin)", "lat": 9.97, "lon": 76.27,
     "coast": "Arabian Sea, west coast", "km_from_nagapattinam": 402},
    {"id": 157, "name": "Visakhapatnam", "lat": 17.68, "lon": 83.28,
     "coast": "Bay of Bengal, east coast", "km_from_nagapattinam": 854},
]

CSV_URL = "https://uhslc.soest.hawaii.edu/data/csv/fast/hourly/h{id}.csv"

#: Held back from the fit and used to score it.
VALIDATION_DAYS = 7

#: How many months of nodal factors to ship.
MONTHS_AHEAD = 36

#: UHSLC uses this for a missing hourly value.
MISSING = -32767


def fetch(station_id: int, refetch: bool) -> str:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cached = CACHE_DIR / f"h{station_id}.csv"
    if cached.exists() and not refetch:
        print(f"  (cached) {cached.name}")
        return cached.read_text()
    url = CSV_URL.format(id=station_id)
    print(f"  downloading {url}")
    req = urllib.request.Request(
        url, headers={"User-Agent": "orca-marina-bundle-builder/1.0"})
    with urllib.request.urlopen(req, timeout=300) as resp:
        text = resp.read().decode("utf-8", "replace")
    cached.write_text(text)
    return text


def parse(text: str) -> tuple[np.ndarray, np.ndarray]:
    """year,month,day,hour,value(mm) -> (datetime64 array, metres array)."""
    times: list[np.datetime64] = []
    values: list[float] = []
    for line in io.StringIO(text):
        parts = line.strip().split(",")
        if len(parts) < 5:
            continue
        try:
            y, mo, d, hh = (int(parts[i]) for i in range(4))
            v = int(parts[4])
        except ValueError:
            continue
        if v == MISSING:
            continue
        # UHSLC hours run 1..24; hour 24 is midnight of the following day.
        base = datetime(y, mo, d, tzinfo=timezone.utc) + timedelta(hours=hh - 1)
        times.append(np.datetime64(base.replace(tzinfo=None), "s"))
        values.append(v / 1000.0)
    return np.array(times, dtype="datetime64[s]"), np.array(values, dtype=float)


def to_datenum(t: np.ndarray) -> np.ndarray:
    """Matplotlib datenum, which is what utide's FUV expects."""
    epoch = np.datetime64("1970-01-01T00:00:00", "s")
    days = (t - epoch).astype("float64") / 86400.0
    return days + 719163.0  # datenum of 1970-01-01


def solve(t: np.ndarray, h: np.ndarray, lat: float):
    return utide.solve(
        t, h, lat=lat, constit=CONSTITUENTS, method="ols",
        conf_int="none", trend=False, verbose=False,
    )


def nodal_table(coef, lat: float, months: list[datetime]) -> dict:
    """f and V0+u for every fitted constituent at the start of each month."""
    names = list(coef["name"])
    lind = np.array([np.where(utide.ut_constants.const.name == n)[0][0]
                     for n in names])
    tref = to_datenum(np.array([np.datetime64(months[0].replace(tzinfo=None), "s")]))[0]

    out_f: list[list[float]] = []
    out_vu: list[list[float]] = []
    for when in months:
        tt = to_datenum(np.array([np.datetime64(when.replace(tzinfo=None), "s")]))
        # ngflgs: [NodsatLint, NodsatNone, GwchLint, GwchNone]. All zero means
        # full nodal/satellite corrections and a real Greenwich argument.
        F, U, V = FUV(tt, np.array([tref]), lind, lat, [0, 0, 0, 0])
        # U and V come back in CYCLES. Degrees is what the phase g is in.
        vu = ((U[0] + V[0]) * 360.0) % 360.0
        out_f.append([float(x) for x in F[0]])
        out_vu.append([float(x) for x in vu])
    return {"f": out_f, "vu": out_vu}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--region", default="kerala-tn")
    ap.add_argument("--refetch", action="store_true")
    args = ap.parse_args()

    ports = []
    for station in STATIONS:
        print(f"\n{station['name']}  (UHSLC {station['id']})")
        t, h = parse(fetch(station["id"], args.refetch))
        if len(t) < 24 * 365:
            print(f"  only {len(t)} hourly values; skipping", file=sys.stderr)
            continue
        print(f"  {len(t):,} hourly values, {t[0]} .. {t[-1]}")

        # --- hold out the last week, fit on the rest --------------------
        cut = t[-1] - np.timedelta64(VALIDATION_DAYS, "D")
        train = t <= cut
        coef_train = solve(t[train], h[train], station["lat"])
        pred = utide.reconstruct(t[~train], coef_train, verbose=False)
        resid = h[~train] - pred.h
        rms = float(np.sqrt(np.mean(resid ** 2)))
        bias = float(np.mean(resid))
        # THE TWO NUMBERS MEAN DIFFERENT THINGS AND BOTH MATTER.
        #
        # The raw RMS is dominated by a near-constant offset: mean sea level
        # moves with the season and between years, so the average level during
        # any one week is not the average of a fifteen-year record. Removing
        # that offset leaves the error in the SHAPE and TIMING of the tide,
        # which is what this prediction is actually for and what the screen
        # says it is for.
        detrended = float(np.sqrt(np.mean((resid - bias) ** 2)))
        mae = float(np.mean(np.abs(resid)))
        worst = float(np.max(np.abs(resid)))
        obs_range = float(np.percentile(h[~train], 99) - np.percentile(h[~train], 1))
        print(f"  validation on the last {VALIDATION_DAYS} days "
              f"({int((~train).sum())} hours held out):")
        print(f"    RMS {rms:.3f} m, of which a {bias:+.3f} m mean-level offset")
        print(f"    RMS after removing that offset: {detrended:.3f} m  <- tidal accuracy")
        print(f"    worst {worst:.3f} m, observed 1-99% range {obs_range:.3f} m")

        # --- the shipped fit uses the whole record ----------------------
        coef = solve(t, h, station["lat"])
        explained = float(coef["diagn"]["PE"][0]) if "diagn" in coef else float("nan")

        start = datetime.now(timezone.utc).replace(
            day=1, hour=0, minute=0, second=0, microsecond=0)
        months = []
        cur = start
        for _ in range(MONTHS_AHEAD):
            months.append(cur)
            cur = (cur.replace(day=28) + timedelta(days=8)).replace(day=1)
        nodal = nodal_table(coef, station["lat"], months)

        names = [str(n) for n in coef["name"]]
        print(f"  constituents: " + ", ".join(
            f"{n} {a:.3f}m" for n, a in zip(names, coef["A"])))

        ports.append({
            "id": f"uhslc-{station['id']}",
            "name": station["name"],
            "lat": station["lat"],
            "lon": station["lon"],
            "coast": station["coast"],
            "km_from_nagapattinam": station["km_from_nagapattinam"],
            "record_start": str(t[0]),
            "record_end": str(t[-1]),
            "hours_used": int(len(t)),
            # RECENT mean, not the whole record's. Mean sea level drifts, and
            # a datum taken from a fifteen-year average sits 30 cm below where
            # the water actually is this season. The last year is close enough
            # to now to be useful and long enough to average the seasons out.
            "z0": float(np.mean(h[t >= t[-1] - np.timedelta64(365, "D")])),
            "z0_note": "mean sea level over the last year of the record",
            "constituents": names,
            # Angular speeds in degrees per hour, from utide's own table.
            "speed_deg_per_hour": [
                float(utide.ut_constants.const.freq[
                    np.where(utide.ut_constants.const.name == n)[0][0]] * 360.0)
                for n in names
            ],
            "amplitude_m": [float(a) for a in coef["A"]],
            "phase_deg": [float(g) for g in coef["g"]],
            "validation": {
                "days": VALIDATION_DAYS,
                "hours": int((~train).sum()),
                "rms_error_m": round(rms, 4),
                "mean_level_offset_m": round(bias, 4),
                "rms_after_offset_removed_m": round(detrended, 4),
                "mean_abs_error_m": round(mae, 4),
                "worst_error_m": round(worst, 4),
                "observed_range_m": round(obs_range, 4),
            },
            "percent_energy_explained": None if np.isnan(explained) else round(explained, 2),
            "nodal": {
                "month_start_iso": [m.strftime("%Y-%m-%dT00:00:00Z") for m in months],
                "f": [[round(v, 6) for v in row] for row in nodal["f"]],
                "vu_deg": [[round(v, 4) for v in row] for row in nodal["vu"]],
            },
        })

    if not ports:
        print("no ports fitted", file=sys.stderr)
        return 1

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUT_DIR / f"{args.region}.json"
    path.write_text(json.dumps({
        "v": 1,
        "region_id": args.region,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "attribution": ATTRIBUTION,
        "source_url": "https://uhslc.soest.hawaii.edu/",
        "no_gauge_near": (
            "UHSLC has no tide gauge near Nagapattinam. The nearest is Kochi at "
            "402 km on the opposite coast. These are the ports that have data, "
            "not a tide for anywhere else."
        ),
        "datum_note": (
            "Heights are about the mean of each station's own record, not chart "
            "datum. Use them for the SHAPE and TIMING of the tide, not for "
            "absolute depth."
        ),
        "ports": ports,
    }, separators=(",", ":")))

    size = path.stat().st_size
    print(f"\nwrote {path}  {size:,} bytes ({size/1024:.1f} KB)")
    print(f"  {ATTRIBUTION}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
