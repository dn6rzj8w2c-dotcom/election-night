// One-time (or occasional) puller for Dane County ward/precinct boundaries from
// the ArcGIS REST API, saved to docs/data/wards.geojson.
//
// Find the layer at https://gis-countyofdane.opendata.arcgis.com/ , open its
// "I want to use this" / API resources, copy the FeatureServer (or MapServer)
// layer URL, and set config.gis.boundaryLayerUrl to its /query endpoint, e.g.
//   https://.../FeatureServer/0/query
//
// This paginates (ArcGIS caps records per request) and requests GeoJSON directly
// (f=geojson). It also supports an optional whereClause so you can scope to AD76
// wards if the layer carries an assembly-district attribute; otherwise pull all
// Dane County wards and let the matcher place the AD76 subset.

import fs from "node:fs";
import path from "node:path";
import { ROOT, loadConfig } from "./lib.js";

const OUT = path.join(ROOT, "docs", "data", "wards.geojson");

async function fetchPage(baseUrl, offset, pageSize, where) {
  const params = new URLSearchParams({
    where: where || "1=1",
    outFields: "*",
    f: "geojson",
    outSR: "4326",
    resultOffset: String(offset),
    resultRecordCount: String(pageSize),
    returnGeometry: "true",
  });
  const url = `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}${params.toString()}`;
  const res = await fetch(url, { headers: { "User-Agent": "AD76-Results-Map/1.0" } });
  if (!res.ok) throw new Error(`ArcGIS HTTP ${res.status}: ${url}`);
  return res.json();
}

async function main() {
  const config = loadConfig();
  const base = config.gis?.boundaryLayerUrl;
  if (!base || base.startsWith("REPLACE_")) {
    console.error(
      "[fetchBoundaries] config.gis.boundaryLayerUrl is not set.\n" +
        "Set it to the ArcGIS FeatureServer/MapServer layer /query URL from\n" +
        "https://gis-countyofdane.opendata.arcgis.com/ and re-run:\n" +
        "  npm run fetch-boundaries"
    );
    process.exit(1);
  }

  const where = process.env.WARD_WHERE || config.gis?.whereClause || "1=1";
  const pageSize = 1000;
  let offset = 0;
  const features = [];

  // eslint-disable-next-line no-constant-condition
  while (true) {
    console.log(`[fetchBoundaries] fetching offset=${offset} ...`);
    const gj = await fetchPage(base, offset, pageSize, where);
    const batch = gj.features || [];
    features.push(...batch);
    if (batch.length < pageSize) break;
    offset += pageSize;
    if (offset > 200000) break; // safety
  }

  const out = { type: "FeatureCollection", features };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`[fetchBoundaries] wrote ${features.length} features -> ${OUT}`);

  // Print the property keys of the first feature so you can identify the ward
  // name field to put in config.gis.wardNameField.
  if (features[0]) {
    console.log("[fetchBoundaries] first feature property keys:", Object.keys(features[0].properties || {}));
  }
}

main().catch((e) => {
  console.error("[fetchBoundaries] FAILED:", e.message);
  process.exit(1);
});
