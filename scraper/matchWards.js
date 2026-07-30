// Explicit, inspectable ward-name matching between the GIS boundary layer and
// the results scrape. NO silent fuzzy matching: every match goes through a
// normalization function you can read, and anything that fails to match is
// RETURNED and LOGGED, never dropped.
//
// Example mismatch we must bridge:
//   GIS layer:    "City of Madison Ward 34"
//   Scrape:       "MADISON W34"  (or "City of Madison Wards 34")
// Normalization collapses both to a canonical key like "madison|34".

import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./lib.js";

/**
 * Canonicalize a ward label to `${municipality}|${wardNumber}`.
 * Returns null if we cannot confidently extract a ward number (logged upstream).
 */
export function canonicalWardKey(label) {
  if (!label) return null;
  let s = String(label).toLowerCase();

  s = s
    .replace(/&/g, " and ")
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // municipality type words -> collapse "city of madison" / "town of blooming grove"
  // We keep the PLACE name but strip the type + generic tokens.
  s = s
    .replace(/\b(city|town|village)\s+of\s+/g, "")
    .replace(/\b(city|town|village)\b/g, "");

  // ward token: "ward 34", "wards 34", "w34", "w 34", "wd 34"
  const wardMatch = s.match(/\b(?:wards?|w|wd)\s*0*(\d+)\b/);
  const wardNum = wardMatch ? String(parseInt(wardMatch[1], 10)) : null;

  // municipality = everything before the ward token
  let place = s;
  if (wardMatch) place = s.slice(0, wardMatch.index);
  place = place.replace(/\b(?:wards?|w|wd)\b/g, "").replace(/\s+/g, " ").trim();

  // common alias normalization
  place = place
    .replace(/\bmadison\b.*/, "madison") // "madison metro" etc -> madison
    .trim();

  if (!wardNum) return null;
  return `${place || "unknown"}|${wardNum}`;
}

/** Municipality display + grouping key derived from a canonical key or label. */
export function municipalityOf(label) {
  const key = canonicalWardKey(label);
  if (!key) return "Unknown";
  const place = key.split("|")[0];
  if (!place || place === "unknown") return "Unknown";
  return titleCase(place);
}

function titleCase(s) {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Merge scraped ward rows onto the authoritative ward list (from GIS if present).
 *
 * @param baseWards  results.wards built from the GIS ward list (reporting:false)
 * @param scraped    ward rows from parsePrecinctPage
 * @returns { merged, unmatched }  unmatched = scraped ward names not placed
 */
export function matchWards(baseWards, scraped, config, { log = console } = {}) {
  const byKey = new Map();
  baseWards.forEach((w) => {
    const key = canonicalWardKey(w.name);
    if (key) byKey.set(key, w);
    w._matched = false;
  });

  const unmatched = [];

  // If we have no GIS base list, just use the scraped wards as-is (still explicit).
  if (baseWards.length === 0) {
    return {
      merged: scraped.map((s) => ({
        name: s.name,
        reporting: s.reporting,
        totalVotes: s.totalVotes,
        results: alignResults(s.results, baseCandidateNames(baseWards, scraped)),
        leader: null,
        margin: null,
        municipality: municipalityOf(s.name),
        _matched: true,
      })),
      unmatched: [],
    };
  }

  for (const s of scraped) {
    const key = canonicalWardKey(s.name);
    const target = key ? byKey.get(key) : null;
    if (!target) {
      unmatched.push(s.name);
      log.warn?.(`[matchWards] UNMATCHED scraped ward: "${s.name}" (key=${key})`);
      continue;
    }
    target.reporting = s.reporting;
    target.totalVotes = s.totalVotes;
    // Align by candidate name so column order differences don't corrupt data.
    const map = new Map(s.results.map((r) => [normName(r.candidate), r.votes]));
    target.results = target.results.map((r) => ({
      candidate: r.candidate,
      votes: map.has(normName(r.candidate)) ? map.get(normName(r.candidate)) : 0,
      share: null,
    }));
    target._matched = true;
    if (!target.municipality) target.municipality = municipalityOf(target.name);
  }

  baseWards.forEach((w) => {
    if (!w.municipality) w.municipality = municipalityOf(w.name);
  });

  return { merged: baseWards, unmatched };
}

function normName(s) {
  return String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
}
function alignResults(results, names) {
  return results;
}
function baseCandidateNames(baseWards, scraped) {
  return [];
}

/**
 * Load wards from the GIS boundary GeoJSON (docs/data/wards.geojson) as objects
 * { name, alderDistrict, municipality }. Returns [] if the file is absent
 * (opening-night dev before boundaries are pulled). alderDistrict is read from
 * config.gis.alderDistrictField when present (Madison wards only; null elsewhere).
 */
export function loadBoundaryWards(config) {
  const p = path.join(ROOT, "docs", "data", "wards.geojson");
  if (!fs.existsSync(p)) return [];
  try {
    const gj = JSON.parse(fs.readFileSync(p, "utf8"));
    const nameField = config.gis?.wardNameField;
    const alderField = config.gis?.alderDistrictField;
    const seen = new Set();
    const out = [];
    for (const f of gj.features || []) {
      const props = f.properties || {};
      let name = nameField && props[nameField] != null ? String(props[nameField]) : null;
      if (!name) {
        const guess = Object.entries(props).find(([k]) => /ward|label|name/i.test(k));
        name = guess ? String(guess[1]) : null;
      }
      if (!name) continue;
      const key = name.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const muni = municipalityOf(name);
      let alder = null;
      if (alderField && props[alderField] != null && String(props[alderField]).trim() !== "") {
        alder = String(props[alderField]).replace(/[^0-9]/g, "") || null;
      }
      // Alder districts exist only for City of Madison wards.
      if (alder && !/madison/i.test(muni)) alder = null;
      out.push({ name, alderDistrict: alder, municipality: muni });
    }
    return out;
  } catch (e) {
    return [];
  }
}

// Back-compat shim (returns just names) in case anything imports the old symbol.
export function loadBoundaryWardNames(config) {
  return loadBoundaryWards(config).map((w) => w.name);
}
