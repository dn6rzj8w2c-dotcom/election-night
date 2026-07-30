// Client-side config. The candidate colors + margin scale are ALSO baked into
// data/results.json by the scraper (single source of truth in config/config.json),
// and the app prefers those. The values here are only a fallback so the map/legend
// can render instantly on first paint before the first fetch resolves.

window.AD76_CONFIG = {
  // ---- Where the frontend gets data ----------------------------------------
  // MODE A (full live backend): set backendBaseUrl to your deployed server,
  //   e.g. "https://ad76.onrender.com". The app then uses:
  //     GET  {backendBaseUrl}/api/results
  //     GET  {backendBaseUrl}/api/status
  //     POST {backendBaseUrl}/api/force-refresh
  //   and the countdown + force refresh are truly shared across all viewers.
  //
  // MODE B (GitHub Pages only): leave backendBaseUrl null. The app reads the
  //   static files committed by the GitHub Action:
  //     data/results.json, data/status.json
  //   Force refresh is disabled (no server to trigger it) and the countdown is
  //   derived from status.json's nextFetchAt (best-effort). See README.
  backendBaseUrl: null,

  staticResultsPath: "data/results.json",
  staticStatusPath: "data/status.json",
  wardsGeoJsonPath: "data/wards.geojson",

  // Client poll cadence for hitting OUR backend/static files (not the county).
  // Mirrors the server thresholds; the server's status.json can override these.
  idleIntervalSeconds: 60,
  activeIntervalSeconds: 15,
  staleAfterSeconds: 120,

  // Fallback color plan (authoritative copy lives in config/config.json and is
  // echoed into results.json). Keep in sync if you change the server config.
  fixedCandidateColors: {
    "Dina Nina Martinez-Rutherford": "#56B4E9",
  },
  palette: ["#E69F00", "#009E73", "#CC79A7", "#D55E00"],
  neutralWardColor: "#E3E3E3",
  marginScale: { minMargin: 0.10, maxMargin: 0.50, minOpacity: 0.38, maxOpacity: 1.0 },

  // GIS field holding the ward label in wards.geojson (used to key features).
  // Leave null to auto-detect a property matching /ward|label|name/i.
  wardNameField: null,
};
