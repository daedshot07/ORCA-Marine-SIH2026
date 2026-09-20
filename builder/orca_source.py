"""Constants lifted from the ORCA source at build time.

These values are safety-critical and are already decided in ORCA. Retyping
them here would create two copies that drift, and the copy in a fisherman's
pocket is the one that would be wrong. So the builder reads them out of
ORCA's own source with the stdlib ast module -- exact, no regex guessing, no
importing ORCA's package and dragging in its dependency tree.

If ORCA is not on this machine the embedded fallback is used and the bundle
metadata records that fact, so a bundle never silently claims a provenance it
does not have.

Set ORCA_ROOT to override the location.
"""

from __future__ import annotations

import ast
import os
from pathlib import Path
from typing import Any

DEFAULT_ORCA_ROOT = Path.home() / "SIH2026" / "orca"

GEOFENCE_PY = Path("backend/app/core/geofence.py")
GEOFENCE_ROUTER_PY = Path("backend/app/api/routers/geofence.py")
RISK_PY = Path("backend/app/core/risk.py")
CONFIG_PY = Path("backend/app/config.py")

# Verbatim fallbacks, used only when the ORCA source is not present. Each is
# annotated with where it came from so a drift can be found by hand.
EMBEDDED: dict[str, Any] = {
    # core/geofence.py
    "data_uncertainty_nm": {
        "imbl": 0.5, "eez": 0.5, "territorial_sea": 0.5,
        "contiguous_zone": 0.5, "baseline": 0.5, "mpa": 1.0,
    },
    "default_data_uncertainty_nm": 1.0,
    "position_uncertainty_nm": 0.1,
    "default_buffer_nm": 2.0,
    # api/routers/geofence.py
    "boundary_disclaimer": (
        "Boundaries shown are from open datasets (MarineRegions/VLIZ, OpenStreetMap) "
        "and are ADVISORY ONLY. They are not Survey of India definitions and carry no "
        "legal authority. Do not rely on them for navigation, enforcement, or any "
        "determination of maritime jurisdiction."
    ),
    # core/risk.py
    "hazard_thresholds": [
        {"variable": "wave_height", "threshold": 2.5, "unit": "m"},
        {"variable": "wind_speed", "threshold": 12.5, "unit": "m/s"},
    ],
    # config.py
    "h3_resolution": 5,
}


def orca_root() -> Path:
    return Path(os.environ.get("ORCA_ROOT", DEFAULT_ORCA_ROOT)).expanduser()


def _module(path: Path) -> ast.Module | None:
    try:
        return ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    except (OSError, SyntaxError):
        return None


def _assigned(tree: ast.Module, name: str) -> Any:
    """Module-level literal assigned to `name`, or KeyError.

    Adjacent string literals inside parentheses are joined by the parser into
    a single constant, so ORCA's multi-line disclaimer comes back as one
    string without any special handling here.
    """
    for node in tree.body:
        targets = []
        if isinstance(node, ast.Assign):
            targets = node.targets
            value = node.value
        elif isinstance(node, ast.AnnAssign) and node.value is not None:
            targets = [node.target]
            value = node.value
        else:
            continue
        for t in targets:
            if isinstance(t, ast.Name) and t.id == name:
                return ast.literal_eval(value)
    raise KeyError(name)


def _hazard_specs(tree: ast.Module) -> list[dict[str, Any]]:
    """Pull variable / threshold / unit out of ORCA's HAZARDS tuple.

    HAZARDS is a tuple of HazardSpec(...) calls, not a plain literal, so this
    walks the keyword arguments rather than using literal_eval.
    """
    for node in tree.body:
        if not isinstance(node, ast.Assign) and not isinstance(node, ast.AnnAssign):
            continue
        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
        if not any(isinstance(t, ast.Name) and t.id == "HAZARDS" for t in targets):
            continue
        value = node.value
        if not isinstance(value, ast.Tuple):
            break
        out = []
        for element in value.elts:
            if not isinstance(element, ast.Call):
                continue
            spec: dict[str, Any] = {}
            for kw in element.keywords:
                if kw.arg == "threshold":
                    spec["threshold"] = ast.literal_eval(kw.value)
                elif kw.arg == "unit":
                    spec["unit"] = ast.literal_eval(kw.value)
                elif kw.arg == "variable":
                    # Variable.WAVE_HEIGHT -> "wave_height"
                    if isinstance(kw.value, ast.Attribute):
                        spec["variable"] = kw.value.attr.lower()
                    else:
                        spec["variable"] = ast.literal_eval(kw.value)
            if spec:
                out.append(spec)
        if out:
            return out
        break
    raise KeyError("HAZARDS")


def load() -> tuple[dict[str, Any], str]:
    """Return (constants, provenance). Falls back field by field, so a
    partial ORCA checkout still contributes what it has."""
    root = orca_root()
    values = dict(EMBEDDED)
    values["data_uncertainty_nm"] = dict(EMBEDDED["data_uncertainty_nm"])
    read_from_source = False
    missing: list[str] = []

    gf = _module(root / GEOFENCE_PY)
    if gf is not None:
        for key, name in (
            ("data_uncertainty_nm", "DATA_UNCERTAINTY_NM"),
            ("default_data_uncertainty_nm", "DEFAULT_DATA_UNCERTAINTY_NM"),
            ("position_uncertainty_nm", "POSITION_UNCERTAINTY_NM"),
            ("default_buffer_nm", "DEFAULT_BUFFER_NM"),
        ):
            try:
                values[key] = _assigned(gf, name)
                read_from_source = True
            except KeyError:
                missing.append(name)
    else:
        missing.append(str(GEOFENCE_PY))

    router = _module(root / GEOFENCE_ROUTER_PY)
    if router is not None:
        try:
            values["boundary_disclaimer"] = _assigned(router, "BOUNDARY_DISCLAIMER")
            read_from_source = True
        except KeyError:
            missing.append("BOUNDARY_DISCLAIMER")
    else:
        missing.append(str(GEOFENCE_ROUTER_PY))

    risk = _module(root / RISK_PY)
    if risk is not None:
        try:
            values["hazard_thresholds"] = _hazard_specs(risk)
            read_from_source = True
        except KeyError:
            missing.append("HAZARDS")
    else:
        missing.append(str(RISK_PY))

    cfg = _module(root / CONFIG_PY)
    if cfg is not None:
        try:
            values["h3_resolution"] = _assigned(cfg, "H3_RESOLUTION")
            read_from_source = True
        except KeyError:
            missing.append("H3_RESOLUTION")
    else:
        missing.append(str(CONFIG_PY))

    if read_from_source and not missing:
        provenance = f"read from ORCA source at {root}"
    elif read_from_source:
        provenance = (
            f"partly read from ORCA source at {root}; "
            f"embedded copies used for: {', '.join(missing)}"
        )
    else:
        provenance = (
            f"embedded copies; ORCA source not readable at {root}. "
            "Verify against ORCA before publishing this bundle."
        )
    return values, provenance
