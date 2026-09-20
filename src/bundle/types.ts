/** Shapes the reader produces. See docs/BUNDLE_FORMAT.md for the byte layout. */

export interface SourceMeta {
  index: number;
  source_id: string;
  name: string;
  role: "hazard" | "boundary" | "landing_centre" | string;
  issued_at?: string;
  fetched_at?: string;
  issued_time_kind?: "model_run" | "fetch_proxy" | "mixed" | null;
  /** True when the recorded time is a fetch proxy, so the real age is older. */
  age_is_lower_bound: boolean;
  snapshot_date?: string;
  is_snapshot?: boolean;
  age_basis?: string;
  reliability?: number | null;
}

export interface BundleMeta {
  region_id: string;
  region_name: string;
  bbox: [number, number, number, number];
  generated_at: string;
  forecast_start: string;
  forecast_end: string;
  hour_count: number;
  hour_step_seconds: number;
  h3_resolution: number;
  encoding: { value_scale: number; no_data: number; coord_scale: number };
  boundary_simplify: { tolerance_deg: number; tolerance_m_approx: number };
  geofence_budget_nm: {
    data_uncertainty: Record<string, number>;
    default_data_uncertainty: number;
    position_uncertainty: number;
    default_buffer: number;
  };
  simulated_excluded: boolean;
  contains_simulated: boolean;
  advisory_only: boolean;
  boundaries_advisory_only: boolean;
  boundary_disclaimer: string;
  zone_types: Record<string, string>;
  harbour_types: Record<string, string>;
  sources: SourceMeta[];
  dem: null;
  dem_reason: string;
  coastline?: {
    parts: number;
    points: number;
    attribution: string | null;
    source_url: string | null;
  } | null;
  simulation_check?: {
    active_scenarios: string[];
    simulated_risk_rows: number;
    simulated_observations: number;
    masked_observations: number;
    checked: string[];
  };
}

export interface Zone {
  zoneType: string;
  /** 0 open data advisory, 1 official. Every boundary here is 0. */
  authority: number;
  closed: boolean;
  name: string;
  attribution: string;
  sourceUrl: string;
  /** Each part is a flat run of [lon, lat, lon, lat, ...] in degrees. */
  parts: Float64Array[];
}

export interface Place {
  id: string;
  name: string;
  district: string;
  type: string;
  sourceIndex: number;
  lat: number;
  lon: number;
  /** Index into the cell arrays, or null when nothing was close enough. */
  cellIndex: number | null;
  /** Metres from this place to the centre of that forecast cell. */
  offsetM: number;
}

export interface Bundle {
  formatVersion: number;
  nCells: number;
  nHours: number;
  h3Resolution: number;
  containsSimulated: boolean;
  meta: BundleMeta;
  /** H3 indices, ascending. Kept for provenance and for step 3's GPS lookup. */
  cells: BigUint64Array;
  /** Cell centre longitude and latitude in degrees, parallel to `cells`. */
  cellLon: Float64Array;
  cellLat: Float64Array;
  /** One byte per cell per hour, cell-major with stride nHours. */
  hazard: Uint8Array;
  uncertainty: Uint8Array;
  zones: Zone[];
  places: Place[];
  /**
   * Hexagon outlines, flat [lon, lat, ...], six vertices per cell, cell-major.
   * Null when the bundle predates them, which disables the map rather than the
   * whole app.
   */
  cellRings: Float64Array | null;
  /** Coastline polylines, or null when the bundle carries none. */
  coastline: { parts: Float64Array[]; attribution: string } | null;
  /** Start of hour 0, as milliseconds since the epoch. */
  forecastStartMs: number;
  hourStepMs: number;
}
