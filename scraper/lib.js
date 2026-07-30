// Shared, dependency-free helpers used by BOTH the scraper and the server.
// Keep candidate-color assignment and the margin scale HERE so there is exactly
// one place to change them.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..");

export function loadConfig() {
  const raw = fs.readFileSync(path.join(ROOT, "config", "config.json"), "utf8");
  return JSON.parse(raw);
}

/**
 * Assign a color to every candidate.
 *  - Dina Nina Martinez-Rutherford is LOCKED to her fixed color no matter where
 *    she appears in ballot order.
 *  - Every other candidate gets the next unused palette color, in the order the
 *    names arrive (i.e. scrape order).
 * Returns [{ name, color, fixed }] in the SAME order the names came in.
 */
export function assignCandidateColors(candidateNames, config) {
  const fixed = config.candidates.fixed || {};
  const palette = [...(config.candidates.palette || [])];
  let paletteIdx = 0;

  return candidateNames.map((name) => {
    const fixedColor = matchFixed(name, fixed);
    if (fixedColor) return { name, color: fixedColor, fixed: true };
    const color = palette[paletteIdx] ?? "#888888"; // fall back to gray if we run out
    paletteIdx += 1;
    return { name, color, fixed: false };
  });
}

// Fixed-color match is tolerant of whitespace/case so a small scrape variation
// (e.g. trailing spaces) does not silently break Dina's locked color.
function matchFixed(name, fixed) {
  const norm = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const target = norm(name);
  for (const [key, color] of Object.entries(fixed)) {
    if (norm(key) === target) return color;
  }
  return null;
}

/**
 * Shared margin -> opacity scale. Used identically for whichever candidate leads
 * a given ward. `margin` is a fraction (0..1): (leader share - runner-up share).
 */
export function marginToOpacity(margin, config) {
  const { minMargin, maxMargin, minOpacity, maxOpacity } = config.marginScale;
  if (!Number.isFinite(margin)) return minOpacity;
  if (margin <= minMargin) return minOpacity;
  if (margin >= maxMargin) return maxOpacity;
  const t = (margin - minMargin) / (maxMargin - minMargin);
  return minOpacity + t * (maxOpacity - minOpacity);
}

/**
 * Build the opening-night / empty payload. Full structure, zero invented numbers.
 * `wards` is the list of ward names we know about (from the GIS layer if present,
 * otherwise empty). Every ward starts reporting:false.
 */
export function buildEmptyResults(config, candidateNames, wards = []) {
  const colored = assignCandidateColors(candidateNames, config);
  // Accept either an array of ward-name strings or an array of ward objects
  // { name, alderDistrict, municipality }.
  const wardObjs = wards.map((w) => (typeof w === "string" ? { name: w } : w));
  return {
    generatedAt: new Date().toISOString(),
    marginScale: config.marginScale,
    neutralWardColor: config.neutralWardColor,
    election: { id: config.electionId, name: null, resultsLastUpdated: null },
    race: {
      id: config.raceId,
      name: config.raceNameMatch,
      precinctsReporting: 0,
      precinctsTotal: wardObjs.length || null,
    },
    candidates: colored, // [{name,color,fixed}]
    wards: wardObjs.map((w) => ({
      name: w.name,
      alderDistrict: w.alderDistrict ?? null,
      municipality: w.municipality ?? null,
      reporting: false,
      totalVotes: 0,
      results: colored.map((c) => ({ candidate: c.name, votes: null, share: null })),
      leader: null,
      margin: null,
    })),
    totals: {
      byCandidate: colored.map((c) => ({ candidate: c.name, votes: 0, share: 0 })),
      totalVotes: 0,
      wardsReporting: 0,
      wardsTotal: wardObjs.length || null,
      leader: null,
    },
    meta: { anyWardReporting: false, source: "empty" },
  };
}

/** Compute district totals + per-ward leader/margin from parsed ward rows. */
export function computeDerived(results, config) {
  const candNames = results.candidates.map((c) => c.name);
  const totals = Object.fromEntries(candNames.map((n) => [n, 0]));
  let grandTotal = 0;
  let wardsReporting = 0;

  for (const ward of results.wards) {
    if (!ward.reporting) {
      ward.leader = null;
      ward.margin = null;
      continue;
    }
    wardsReporting += 1;
    const votes = ward.results.map((r) => ({ candidate: r.candidate, votes: r.votes || 0 }));
    votes.forEach((v) => {
      totals[v.candidate] += v.votes;
    });
    grandTotal += votes.reduce((a, b) => a + b.votes, 0);

    const wardTotal = ward.totalVotes || votes.reduce((a, b) => a + b.votes, 0);
    ward.results.forEach((r) => {
      r.share = wardTotal > 0 ? r.votes / wardTotal : 0;
    });
    const sorted = [...ward.results].sort((a, b) => (b.votes || 0) - (a.votes || 0));
    ward.leader = sorted[0]?.candidate ?? null;
    const first = sorted[0]?.share ?? 0;
    const second = sorted[1]?.share ?? 0;
    ward.margin = first - second;
  }

  results.totals.byCandidate = candNames.map((n) => ({
    candidate: n,
    votes: totals[n],
    share: grandTotal > 0 ? totals[n] / grandTotal : 0,
  }));
  results.totals.totalVotes = grandTotal;
  results.totals.wardsReporting = wardsReporting;
  results.totals.wardsTotal = results.wards.length || results.race.precinctsTotal || null;
  const leadSorted = [...results.totals.byCandidate].sort((a, b) => b.votes - a.votes);
  results.totals.leader = grandTotal > 0 ? leadSorted[0].candidate : null;
  results.meta.anyWardReporting = wardsReporting > 0;
  return results;
}
