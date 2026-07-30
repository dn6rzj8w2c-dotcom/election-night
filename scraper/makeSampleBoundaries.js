// Generates a SAMPLE docs/data/wards.geojson so the site renders on GitHub Pages
// before the real GIS layer is pulled. These are schematic rectangles, NOT real
// ward geometry. Replace by running `npm run fetch-boundaries` once you have set
// config.gis.boundaryLayerUrl. Property names mirror a typical Dane County layer
// (WARD_LABEL, ALDER, MUNI) so the pipeline picks them up unchanged.
//
// Includes both City of Madison wards (with ALDER district numbers) and a couple
// of non-Madison wards (Town of Blooming Grove, Village of McFarland) so the
// alder-vs-municipality grouping is visible in the opening-night state.

import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./lib.js";

function cell(row, col, w = 0.012, h = 0.008) {
  const lng0 = -89.44 + col * w;
  const lat0 = 43.05 + row * h;
  return [[
    [lng0, lat0],
    [lng0 + w, lat0],
    [lng0 + w, lat0 + h],
    [lng0, lat0 + h],
    [lng0, lat0],
  ]];
}

const defs = [
  // Madison wards with alder districts (sample AD76-ish subset)
  ["City of Madison Ward 34", "6", "City of Madison"],
  ["City of Madison Ward 35", "6", "City of Madison"],
  ["City of Madison Ward 36", "6", "City of Madison"],
  ["City of Madison Ward 47", "15", "City of Madison"],
  ["City of Madison Ward 48", "15", "City of Madison"],
  ["City of Madison Ward 49", "15", "City of Madison"],
  ["City of Madison Ward 88", "16", "City of Madison"],
  ["City of Madison Ward 89", "16", "City of Madison"],
  // Non-Madison wards (NO alder district -> grouped by municipality)
  ["Town of Blooming Grove Ward 1", "", "Town of Blooming Grove"],
  ["Village of McFarland Ward 3", "", "Village of McFarland"],
];

const features = defs.map((d, i) => ({
  type: "Feature",
  properties: { WARD_LABEL: d[0], ALDER: d[1], MUNI: d[2], _sample: true },
  geometry: { type: "Polygon", coordinates: cell(Math.floor(i / 4), i % 4) },
}));

const gj = {
  type: "FeatureCollection",
  _note: "SAMPLE schematic geometry — replace with real Dane County GIS via `npm run fetch-boundaries`.",
  features,
};

const out = path.join(ROOT, "docs", "data", "wards.geojson");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(gj));
console.log(`[makeSampleBoundaries] wrote ${features.length} SAMPLE wards -> ${out}`);
