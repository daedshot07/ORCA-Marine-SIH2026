/**
 * Bundle parser. Plain DataView, TextDecoder and JSON.parse. No library.
 *
 * The byte layout is specified in docs/BUNDLE_FORMAT.md, which is normative.
 * If this file and that document disagree, this file is the bug.
 */

import {
  COORD_SCALE,
  MAGIC,
  MIN_SUPPORTED_FORMAT,
  NO_CELL,
  NO_DATA,
  READER_VERSION,
  VALUE_SCALE,
} from "../constants.ts";
import type { Bundle, BundleMeta, Place, Zone } from "./types.ts";

const SECTION_META = 1;
const SECTION_CELLS = 2;
const SECTION_HAZARD = 3;
const SECTION_UNCERTAINTY = 4;
const SECTION_ZONES = 5;
const SECTION_PLACES = 6;
const SECTION_STRINGS = 7;
const SECTION_CELL_CENTROIDS = 10;
const SECTION_CELL_RINGS = 11;
const SECTION_COASTLINE = 12;

/** 1e-5 degrees, the scale hexagon vertex offsets are stored at. */
const RING_SCALE = 100000;
const RING_VERTICES = 6;

const REQUIRED: Array<[number, string]> = [
  [SECTION_META, "metadata"],
  [SECTION_CELLS, "cell index"],
  [SECTION_HAZARD, "hazard"],
  [SECTION_UNCERTAINTY, "uncertainty"],
  [SECTION_ZONES, "boundaries"],
  [SECTION_PLACES, "landing centres"],
  [SECTION_STRINGS, "string table"],
  [SECTION_CELL_CENTROIDS, "cell centroids"],
];

/**
 * A bundle this app must not use, with a sentence fit to show a user.
 *
 * Every rejection is a hard stop. A safety app that half-reads an
 * incompatible file is worse than one that refuses it, because the half it
 * read still renders a verdict.
 */
export class BundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleError";
  }
}

interface Section {
  offset: number;
  length: number;
  count: number;
}

const td = new TextDecoder();

export function parseBundle(buf: ArrayBuffer): Bundle {
  if (buf.byteLength < 32) {
    throw new BundleError("This file is not an ORCA bundle.");
  }
  const dv = new DataView(buf);

  const magic = td.decode(new Uint8Array(buf, 0, 8));
  if (magic !== MAGIC) {
    throw new BundleError("This file is not an ORCA bundle.");
  }

  const formatVersion = dv.getUint16(8, true);
  const minReaderVersion = dv.getUint16(10, true);
  const headerBytes = dv.getUint16(12, true);
  const sectionCount = dv.getUint16(14, true);
  const nCells = dv.getUint32(16, true);
  const nHours = dv.getUint32(20, true);
  const h3Resolution = dv.getUint8(24);
  const flags = dv.getUint8(25);
  const fileBytes = dv.getUint32(28, true);

  if (fileBytes !== buf.byteLength) {
    throw new BundleError(
      "This bundle is incomplete or corrupted. Download it again.",
    );
  }
  if (minReaderVersion > READER_VERSION) {
    throw new BundleError(
      `This bundle needs app version ${minReaderVersion} or newer. ` +
        `This app reads version ${READER_VERSION}. Update the app.`,
    );
  }
  if (formatVersion < MIN_SUPPORTED_FORMAT) {
    // The mirror of the check above, and the one that is easy to forget. An
    // older bundle parses without error and lies, because record strides
    // changed underneath the same field names.
    throw new BundleError(
      `This bundle is an old format (version ${formatVersion}). ` +
        `This app reads version ${MIN_SUPPORTED_FORMAT} and newer. ` +
        `Download a current bundle.`,
    );
  }

  const sections = new Map<number, Section>();
  for (let i = 0; i < sectionCount; i++) {
    const p = headerBytes + i * 16;
    const typeId = dv.getUint16(p, true);
    const offset = dv.getUint32(p + 4, true);
    const length = dv.getUint32(p + 8, true);
    const count = dv.getUint32(p + 12, true);
    if (offset + length > fileBytes) {
      throw new BundleError("This bundle is corrupted. Download it again.");
    }
    // Unknown type ids are skipped on purpose: that is what lets a newer
    // bundle add a section without breaking this app.
    sections.set(typeId, { offset, length, count });
  }

  for (const [id, label] of REQUIRED) {
    if (!sections.has(id)) {
      throw new BundleError(`This bundle is missing its ${label}.`);
    }
  }

  const meta = readMeta(buf, sections.get(SECTION_META)!);

  if (meta.encoding.no_data !== NO_DATA || meta.encoding.value_scale !== VALUE_SCALE) {
    // The encoding is the one thing this app cannot adapt to at runtime: it is
    // baked into how a byte becomes a probability.
    throw new BundleError(
      "This bundle uses a hazard encoding this app does not understand.",
    );
  }

  const strings = readStrings(buf, sections.get(SECTION_STRINGS)!);

  const cellSec = sections.get(SECTION_CELLS)!;
  const cells = new BigUint64Array(buf.slice(cellSec.offset, cellSec.offset + cellSec.length));

  const hazard = readGrid(buf, sections.get(SECTION_HAZARD)!, nCells, nHours, "hazard");
  const uncertainty = readGrid(
    buf, sections.get(SECTION_UNCERTAINTY)!, nCells, nHours, "uncertainty",
  );

  const { lon: cellLon, lat: cellLat } = readCentroids(
    buf, sections.get(SECTION_CELL_CENTROIDS)!, nCells,
  );

  // Sections 11 and 12 are optional. A version 2 bundle has neither, and the
  // right response is a verdict screen with no map, not a refusal.
  const ringsSection = sections.get(SECTION_CELL_RINGS);
  const cellRings = ringsSection === undefined
    ? null
    : readRings(buf, ringsSection, nCells, cellLon, cellLat);

  const coastSection = sections.get(SECTION_COASTLINE);
  const coastline = coastSection === undefined
    ? null
    : readCoastline(buf, coastSection, strings);

  const zones = readZones(buf, sections.get(SECTION_ZONES)!, strings, meta);
  const places = readPlaces(buf, sections.get(SECTION_PLACES)!, strings, meta, nCells);

  const forecastStartMs = Date.parse(meta.forecast_start);
  if (Number.isNaN(forecastStartMs)) {
    throw new BundleError("This bundle has an unreadable forecast start time.");
  }

  return {
    formatVersion,
    nCells,
    nHours,
    h3Resolution,
    containsSimulated: (flags & 0x01) !== 0,
    meta,
    cells,
    cellLon,
    cellLat,
    hazard,
    uncertainty,
    zones,
    places,
    cellRings,
    coastline,
    forecastStartMs,
    hourStepMs: meta.hour_step_seconds * 1000,
  };
}

function readMeta(buf: ArrayBuffer, s: Section): BundleMeta {
  try {
    return JSON.parse(td.decode(new Uint8Array(buf, s.offset, s.length))) as BundleMeta;
  } catch {
    throw new BundleError("This bundle's description could not be read.");
  }
}

function readGrid(
  buf: ArrayBuffer, s: Section, nCells: number, nHours: number, label: string,
): Uint8Array {
  if (s.length !== nCells * nHours) {
    throw new BundleError(
      `This bundle's ${label} field is the wrong size for ${nCells} areas ` +
        `and ${nHours} hours.`,
    );
  }
  return new Uint8Array(buf, s.offset, s.length);
}

function readCentroids(
  buf: ArrayBuffer, s: Section, nCells: number,
): { lon: Float64Array; lat: Float64Array } {
  if (s.count !== nCells || s.length !== nCells * 8) {
    throw new BundleError("This bundle's area centres do not match its areas.");
  }
  const dv = new DataView(buf, s.offset, s.length);
  const lon = new Float64Array(nCells);
  const lat = new Float64Array(nCells);
  for (let i = 0; i < nCells; i++) {
    lon[i] = dv.getInt32(i * 8, true) / COORD_SCALE;
    lat[i] = dv.getInt32(i * 8 + 4, true) / COORD_SCALE;
  }
  return { lon, lat };
}

function readStrings(buf: ArrayBuffer, s: Section): string[] {
  const dv = new DataView(buf, s.offset, s.length);
  const n = dv.getUint32(0, true);
  const bytesOffset = dv.getUint32(4, true);
  const offsets = new Uint32Array(n + 1);
  for (let i = 0; i <= n; i++) offsets[i] = dv.getUint32(8 + i * 4, true);

  const out: string[] = new Array(n);
  const base = s.offset + bytesOffset;
  for (let i = 0; i < n; i++) {
    const a = offsets[i]!;
    const b = offsets[i + 1]!;
    out[i] = b > a ? td.decode(new Uint8Array(buf, base + a, b - a)) : "";
  }
  return out;
}

/** Index 0 is always the empty string, so 0 means absent. */
function str(strings: string[], i: number): string {
  return strings[i] ?? "";
}

function readZones(
  buf: ArrayBuffer, s: Section, strings: string[], meta: BundleMeta,
): Zone[] {
  const dv = new DataView(buf, s.offset, s.length);
  const nZones = dv.getUint32(0, true);
  const nParts = dv.getUint32(4, true);
  const nPoints = dv.getUint32(8, true);
  const pointsOffset = dv.getUint32(12, true);

  const partBase = 16 + nZones * 24;
  const partOffsets = new Uint32Array(nParts + 1);
  for (let i = 0; i <= nParts; i++) partOffsets[i] = dv.getUint32(partBase + i * 4, true);
  if (partOffsets[nParts] !== nPoints) {
    throw new BundleError("This bundle's boundary geometry is inconsistent.");
  }

  const zones: Zone[] = [];
  for (let z = 0; z < nZones; z++) {
    const p = 16 + z * 24;
    const typeId = dv.getUint16(p, true);
    const authority = dv.getUint8(p + 2);
    const geomKind = dv.getUint8(p + 3);
    const nameStr = dv.getUint32(p + 4, true);
    const attributionStr = dv.getUint32(p + 8, true);
    const sourceUrlStr = dv.getUint32(p + 12, true);
    const firstPart = dv.getUint32(p + 16, true);
    const partCount = dv.getUint32(p + 20, true);

    const attribution = str(strings, attributionStr);
    if (!attribution) {
      // ORCA makes this NOT NULL so it cannot be lost in transit, and the app
      // has to hold up its end: a boundary with no attribution is not shown.
      throw new BundleError("A boundary in this bundle has lost its attribution.");
    }

    const parts: Float64Array[] = [];
    for (let i = firstPart; i < firstPart + partCount; i++) {
      const a = partOffsets[i]!;
      const b = partOffsets[i + 1]!;
      const run = new Float64Array((b - a) * 2);
      for (let k = 0; k < b - a; k++) {
        const q = pointsOffset + (a + k) * 8;
        run[k * 2] = dv.getInt32(q, true) / COORD_SCALE;
        run[k * 2 + 1] = dv.getInt32(q + 4, true) / COORD_SCALE;
      }
      parts.push(run);
    }

    zones.push({
      zoneType: meta.zone_types[String(typeId)] ?? `type ${typeId}`,
      authority,
      closed: geomKind === 1,
      name: str(strings, nameStr),
      attribution,
      sourceUrl: str(strings, sourceUrlStr),
      parts,
    });
  }
  return zones;
}

function readPlaces(
  buf: ArrayBuffer, s: Section, strings: string[], meta: BundleMeta, nCells: number,
): Place[] {
  if (s.length !== s.count * 32) {
    throw new BundleError("This bundle's landing centres are the wrong size.");
  }
  const dv = new DataView(buf, s.offset, s.length);
  const out: Place[] = [];
  for (let i = 0; i < s.count; i++) {
    const p = i * 32;
    const rawCell = dv.getUint32(p + 8, true);
    let cellIndex: number | null = rawCell === NO_CELL ? null : rawCell;
    if (cellIndex !== null && cellIndex >= nCells) {
      // Out of range points at nothing real. Treating it as no data is the
      // only safe reading; treating it as cell 0 would answer confidently
      // about entirely the wrong stretch of water.
      cellIndex = null;
    }
    out.push({
      lat: dv.getInt32(p, true) / COORD_SCALE,
      lon: dv.getInt32(p + 4, true) / COORD_SCALE,
      cellIndex,
      offsetM: dv.getUint32(p + 12, true),
      id: str(strings, dv.getUint32(p + 16, true)),
      name: str(strings, dv.getUint32(p + 20, true)),
      district: str(strings, dv.getUint32(p + 24, true)),
      type: meta.harbour_types[String(dv.getUint8(p + 28))] ?? "unknown",
      sourceIndex: dv.getUint8(p + 29),
    });
  }
  return out;
}


/**
 * Hexagon vertices, restored to absolute degrees.
 *
 * Stored as int16 offsets from each cell's own centre, so the addition happens
 * here once at load rather than on every frame of a pan.
 */
function readRings(
  buf: ArrayBuffer, s: Section, nCells: number,
  cellLon: Float64Array, cellLat: Float64Array,
): Float64Array {
  const stride = RING_VERTICES * 4;
  if (s.length !== nCells * stride) {
    throw new BundleError("This bundle's area outlines do not match its areas.");
  }
  const dv = new DataView(buf, s.offset, s.length);
  // Flat [lon, lat, lon, lat, ...], six vertices per cell, cell-major.
  const out = new Float64Array(nCells * RING_VERTICES * 2);
  for (let c = 0; c < nCells; c++) {
    const clon = cellLon[c]!;
    const clat = cellLat[c]!;
    for (let v = 0; v < RING_VERTICES; v++) {
      const at = c * stride + v * 4;
      const o = (c * RING_VERTICES + v) * 2;
      out[o] = clon + dv.getInt16(at, true) / RING_SCALE;
      out[o + 1] = clat + dv.getInt16(at + 2, true) / RING_SCALE;
    }
  }
  return out;
}

function readCoastline(
  buf: ArrayBuffer, s: Section, strings: string[],
): { parts: Float64Array[]; attribution: string } {
  const dv = new DataView(buf, s.offset, s.length);
  const nParts = dv.getUint32(0, true);
  const nPoints = dv.getUint32(4, true);
  const pointsOffset = dv.getUint32(8, true);
  const attributionStr = dv.getUint32(12, true);

  const offsets = new Uint32Array(nParts + 1);
  for (let i = 0; i <= nParts; i++) offsets[i] = dv.getUint32(16 + i * 4, true);
  if (offsets[nParts] !== nPoints) {
    throw new BundleError("This bundle's coastline is inconsistent.");
  }

  const parts: Float64Array[] = [];
  for (let i = 0; i < nParts; i++) {
    const a = offsets[i]!;
    const b = offsets[i + 1]!;
    const run = new Float64Array((b - a) * 2);
    for (let k = 0; k < b - a; k++) {
      const q = pointsOffset + (a + k) * 8;
      run[k * 2] = dv.getInt32(q, true) / COORD_SCALE;
      run[k * 2 + 1] = dv.getInt32(q + 4, true) / COORD_SCALE;
    }
    parts.push(run);
  }
  return { parts, attribution: str(strings, attributionStr) };
}
