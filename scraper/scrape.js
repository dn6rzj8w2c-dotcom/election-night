// Server-side scraper for elections.danecounty.gov.
//
// WHY server-side: the county site does not send CORS headers, so browser JS
// cannot fetch it directly. This runs in Node (either inside server.js on a
// polling schedule, or inside the GitHub Action) and writes structured JSON that
// the static frontend consumes.
//
// IMPORTANT — HTML SELECTORS ARE UNVERIFIED.
// The exact markup of /Election-Result/{id} and /Precincts-Result/{id}/{raceId}
// is not knowable until the Aug 11 2026 primary page exists. The parsing below
// is written defensively (it looks for the race by name, finds the candidate
// header row, and reads numeric cells) and is isolated in parseElectionPage() /
// parsePrecinctPage() so that adjusting to the real markup is a small, contained
// edit. Every place that MUST be checked against real HTML is marked: >>> VERIFY.

import * as cheerio from "cheerio";
import fs from "node:fs";
import path from "node:path";
import {
  ROOT,
  loadConfig,
  buildEmptyResults,
  computeDerived,
} from "./lib.js";
import { matchWards, loadBoundaryWards } from "./matchWards.js";

const OUT_DIR = path.join(ROOT, "docs", "data");

/** Fetch with timeout + a couple of retries (backoff handled by caller too). */
async function fetchHtml(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "AD76-Results-Map/1.0 (election-night dashboard)" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

function toInt(text) {
  if (text == null) return null;
  const cleaned = String(text).replace(/[^0-9-]/g, "");
  if (cleaned === "" || cleaned === "-") return null;
  return parseInt(cleaned, 10);
}

/** Parse "X of Y precincts reporting" style strings. Returns {reporting,total} or null. */
function parseReporting(text) {
  if (!text) return null;
  const m = text.match(/(\d+)\s*(?:of|\/)\s*(\d+)/i);
  if (!m) return null;
  return { reporting: parseInt(m[1], 10), total: parseInt(m[2], 10) };
}

/**
 * Parse the per-election results page. Locates the AD76 race by name, extracts
 * candidate names + the "Votes By Precinct" link (raceId), and any
 * "N of M precincts reporting" and "Results Last Updated" text on the page.
 *
 * Returns: { raceId, raceName, candidates:[names], reporting:{reporting,total}|null,
 *            resultsLastUpdated:string|null }
 */
export function parseElectionPage(html, config) {
  const $ = cheerio.load(html);

  // >>> VERIFY: "Results Last Updated On ..." label the county site prints.
  let resultsLastUpdated = null;
  const luMatch = $("body")
    .text()
    .match(/Results?\s+Last\s+Updated(?:\s+On)?[:\s]*([^\n\r]+)/i);
  if (luMatch) resultsLastUpdated = luMatch[1].trim();

  // Find the block/table for our race by matching the race name text.
  const needle = config.raceNameMatch.toLowerCase();
  let raceId = config.raceId || null;
  let raceName = config.raceNameMatch;
  const candidates = [];
  let reporting = null;

  // Strategy: among all elements whose text contains the race name, pick the
  // MOST SPECIFIC one (shortest text, i.e. deepest match) so we anchor on the
  // race heading itself rather than <html>/<body>. Then climb to its nearest
  // containing table/section.
  let $anchor = null;
  let anchorLen = Infinity;
  $("*").each((_, el) => {
    const tag = el.tagName && el.tagName.toLowerCase();
    if (tag === "html" || tag === "body" || tag === "script" || tag === "style") return;
    const $el = $(el);
    const txt = $el.text().replace(/\s+/g, " ").trim();
    if (txt && txt.toLowerCase().includes(needle) && txt.length < anchorLen) {
      $anchor = $el;
      anchorLen = txt.length;
    }
  });

  let $scope = null;
  if ($anchor && $anchor.length) {
    raceName = $anchor.text().replace(/\s+/g, " ").trim();
    const $tbl = $anchor.closest("table");
    if ($tbl.length) {
      $scope = $tbl;
    } else {
      // climb to the nearest ancestor that actually contains a table (the race block)
      let $cur = $anchor;
      for (let i = 0; i < 6 && $cur.length; i++) {
        const $p = $cur.parent();
        if ($p.find("table").length) { $scope = $p; break; }
        $cur = $p;
      }
      if (!$scope) $scope = $anchor.closest("section, div, article").first();
    }
  }

  if (!$scope || $scope.length === 0) {
    // Race not found on the page yet — this is a legitimate pre-results state.
    return { raceId, raceName: config.raceNameMatch, candidates: [], reporting: null, resultsLastUpdated, found: false };
  }

  // "Votes By Precinct" link -> /Precincts-Result/{electionId}/{raceId}
  if (!raceId) {
    $scope.find("a").each((_, a) => {
      const href = $(a).attr("href") || "";
      const label = $(a).text().toLowerCase();
      if (/precinct/i.test(href) || label.includes("precinct")) {
        const m = href.match(/Precincts?-Result\/\d+\/(\d+)/i) || href.match(/(\d+)\/?$/);
        if (m) raceId = m[1];
      }
    });
  }

  // reporting text within scope
  reporting = parseReporting($scope.text());

  // Candidate names: >>> VERIFY. Read rows of the race table; candidate name is
  // typically the first cell of each data row that also has a numeric vote cell.
  const $table = $scope.is("table") ? $scope : $scope.find("table").first();
  if ($table && $table.length) {
    $table.find("tr").each((_, tr) => {
      const cells = $(tr).find("td, th").toArray().map((c) => $(c).text().trim());
      if (cells.length < 2) return;
      const name = cells[0];
      const hasNumber = cells.slice(1).some((c) => /\d/.test(c));
      const looksLikeHeader = /candidate|total|votes|percent|%/i.test(name);
      if (name && hasNumber && !looksLikeHeader) candidates.push(name);
    });
  }

  return { raceId, raceName, candidates: dedupe(candidates), reporting, resultsLastUpdated, found: true };
}

/**
 * Parse the "Votes By Precinct" page into per-ward candidate vote counts.
 * Expects a table whose header row lists candidate names and whose body rows are
 * one-per-ward with the ward label in the first column.
 *
 * A ward that is present in the table but shows blank/no numbers is treated as
 * NOT reporting (reporting:false), never as zeroes-with-a-percentage.
 *
 * Returns: { wards:[{name,reporting,totalVotes,results:[{candidate,votes}]}],
 *            candidates:[names], reporting:{reporting,total}|null }
 */
export function parsePrecinctPage(html) {
  const $ = cheerio.load(html);
  const reporting = parseReporting($("body").text());

  // Choose the widest table on the page (the precinct breakdown is the big one).
  let $best = null;
  let bestCols = 0;
  $("table").each((_, t) => {
    const cols = $(t).find("tr").first().find("td, th").length;
    if (cols > bestCols) {
      bestCols = cols;
      $best = $(t);
    }
  });
  if (!$best) return { wards: [], candidates: [], reporting };

  const rows = $best.find("tr").toArray();
  if (rows.length < 2) return { wards: [], candidates: [], reporting };

  // >>> VERIFY: header row identifies candidate columns. We take the first row,
  // drop the first cell (ward label) and any trailing "Total" column.
  const header = $(rows[0]).find("th, td").toArray().map((c) => $(c).text().trim());
  const candCols = [];
  header.forEach((h, idx) => {
    if (idx === 0) return; // ward-name column
    if (/^total$/i.test(h) || /reporting/i.test(h) || h === "") return;
    candCols.push({ idx, name: h });
  });
  const candidates = candCols.map((c) => c.name);

  const wards = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = $(rows[r]).find("td, th").toArray().map((c) => $(c).text().trim());
    if (cells.length === 0) continue;
    const wardName = cells[0];
    if (!wardName || /^total/i.test(wardName)) continue; // skip totals footer

    const results = candCols.map((c) => ({ candidate: c.name, votes: toInt(cells[c.idx]) }));
    const anyNumber = results.some((x) => x.votes != null);
    const totalVotes = anyNumber ? results.reduce((a, b) => a + (b.votes || 0), 0) : 0;

    wards.push({
      name: wardName,
      reporting: anyNumber, // no numbers at all => not reporting (do NOT invent zeros)
      totalVotes,
      results: results.map((x) => ({ candidate: x.candidate, votes: x.votes == null ? 0 : x.votes, share: null })),
      _rawReported: anyNumber,
    });
  }

  return { wards, candidates: dedupe(candidates), reporting };
}

function dedupe(arr) {
  return [...new Set(arr.map((s) => s.replace(/\s+/g, " ").trim()))];
}

/**
 * Full scrape. Returns a complete results object (never throws for the "no
 * results yet" case — that is a valid state). Throws only on network/parse
 * failure so the caller's retry/backoff can handle it.
 */
export async function scrape(config = loadConfig(), { log = console } = {}) {
  const boundaryWards = loadBoundaryWards(config); // may be [] (objects: {name,alderDistrict,municipality})
  const base = config.baseUrl.replace(/\/$/, "");

  if (!config.electionId || config.electionId.startsWith("REPLACE_")) {
    log.warn?.("[scrape] electionId not set — emitting opening-night empty state.");
    const candidateNames = knownCandidatesFallback(config);
    const empty = buildEmptyResults(config, candidateNames, boundaryWards);
    empty.meta.source = "no-election-id";
    return empty;
  }

  const electionUrl = `${base}/Election-Result/${config.electionId}`;
  const electionHtml = await fetchHtml(electionUrl);
  const parsed = parseElectionPage(electionHtml, config);

  // If race/candidates not discoverable yet -> valid opening-night state.
  if (!parsed.found || parsed.candidates.length === 0) {
    const candidateNames = knownCandidatesFallback(config);
    const empty = buildEmptyResults(config, candidateNames, boundaryWards);
    empty.election.name = null;
    empty.race.name = parsed.raceName || config.raceNameMatch;
    empty.race.precinctsReporting = parsed.reporting?.reporting ?? 0;
    empty.race.precinctsTotal = parsed.reporting?.total ?? empty.race.precinctsTotal;
    empty.election.resultsLastUpdated = parsed.resultsLastUpdated || null;
    empty.meta.source = "race-not-reporting";
    return empty;
  }

  // Pull ward-level breakdown.
  let precinct = { wards: [], candidates: parsed.candidates, reporting: parsed.reporting };
  if (parsed.raceId) {
    const precinctUrl = `${base}/Precincts-Result/${config.electionId}/${parsed.raceId}`;
    try {
      const precinctHtml = await fetchHtml(precinctUrl);
      precinct = parsePrecinctPage(precinctHtml);
    } catch (e) {
      log.warn?.(`[scrape] precinct page failed (${e.message}); using race-level only.`);
    }
  }

  const candidateNames = precinct.candidates.length ? precinct.candidates : parsed.candidates;

  // Base structure on the GIS ward list if we have it, so every ward shows even
  // before it reports. Otherwise fall back to scraped ward names.
  const scrapedWardNames = precinct.wards.map((w) => w.name);
  const results = buildEmptyResults(config, candidateNames, boundaryWards.length ? boundaryWards : scrapedWardNames);

  results.election.id = config.electionId;
  results.race.id = parsed.raceId || config.raceId;
  results.race.name = parsed.raceName;
  results.election.resultsLastUpdated = parsed.resultsLastUpdated || null;
  const rep = precinct.reporting || parsed.reporting;
  results.race.precinctsReporting = rep?.reporting ?? 0;
  results.race.precinctsTotal = rep?.total ?? results.race.precinctsTotal;

  // Match scraped wards onto our ward list (explicit, inspectable step).
  const { merged, unmatched } = matchWards(results.wards, precinct.wards, config, { log });
  results.wards = merged;
  results.meta.unmatchedWards = unmatched; // names from the scrape we could not place

  computeDerived(results, config);
  results.meta.source = "live";
  return results;
}

// If we cannot read candidate names yet (opening night), fall back to the known
// declared field so the legend/table still render. Edit here or in config.
function knownCandidatesFallback(config) {
  const fixed = Object.keys(config.candidates.fixed || {});
  const placeholders = (config.candidates.knownCandidates || []).slice();
  const names = [...new Set([...fixed, ...placeholders])];
  // Pad to 5 slots so the legend/table structure matches the 5-candidate race
  // even before names are confirmed. Real names replace these once scraped.
  while (names.length < 5) names.push(`Candidate ${names.length + 1}`);
  return names.slice(0, Math.max(5, names.length));
}

// CLI entry: `npm run scrape` — one-shot scrape, write files, exit.
if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  scrape(config)
    .then((results) => {
      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.writeFileSync(path.join(OUT_DIR, "results.json"), JSON.stringify(results, null, 2));
      // Pick the client poll cadence to advertise: active once any ward reports.
      const intervalSeconds = results.meta.anyWardReporting
        ? config.polling.activeIntervalSeconds
        : config.polling.idleIntervalSeconds;
      const now = new Date();
      const status = {
        lastFetchAt: now.toISOString(),
        lastFetchSuccess: true,
        source: results.meta.source,
        // In GitHub Pages mode there is no live server clock; this advertises when
        // the frontend should next re-read the published file (best-effort — the
        // authoritative refresh is the scheduled GitHub Action). In server mode,
        // server.js overwrites this with its real shared schedule.
        nextFetchAt: new Date(now.getTime() + intervalSeconds * 1000).toISOString(),
        intervalSeconds,
        staleAfterSeconds: config.staleAfterSeconds,
        resultsLastUpdated: results.election.resultsLastUpdated || null,
        wardsReporting: results.totals.wardsReporting,
        wardsTotal: results.totals.wardsTotal,
        anyWardReporting: results.meta.anyWardReporting,
        matchedWards: results.wards.filter((w) => w.reporting || w._matched).length,
        unmatchedWards: results.meta.unmatchedWards || [],
      };
      fs.writeFileSync(path.join(OUT_DIR, "status.json"), JSON.stringify(status, null, 2));
      console.log(`[scrape] wrote results.json (${results.wards.length} wards, ${results.totals.wardsReporting} reporting, source=${results.meta.source})`);
      if ((results.meta.unmatchedWards || []).length) {
        console.warn(`[scrape] UNMATCHED wards (${results.meta.unmatchedWards.length}):`, results.meta.unmatchedWards);
      }
    })
    .catch((err) => {
      console.error("[scrape] FAILED:", err.message);
      // Write a failure status so the frontend can show a stale indicator, but
      // do NOT overwrite the last good results.json.
      try {
        fs.mkdirSync(OUT_DIR, { recursive: true });
        const statusPath = path.join(OUT_DIR, "status.json");
        let prev = {};
        try { prev = JSON.parse(fs.readFileSync(statusPath, "utf8")); } catch {}
        fs.writeFileSync(statusPath, JSON.stringify({
          ...prev,
          lastFetchAttemptAt: new Date().toISOString(),
          lastFetchSuccess: false,
          lastError: err.message,
        }, null, 2));
      } catch {}
      process.exit(1);
    });
}
