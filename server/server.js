// Full live backend for election night.
//
// This is the option that satisfies the parts of the spec a pure static host
// (GitHub Pages) physically cannot: sub-minute polling, SHARED countdown state
// owned by the server (not per browser tab), a live force-refresh endpoint with
// debounce, and a health endpoint. Deploy this to any Node host (Render,
// Railway, Fly.io, a VM) and point the frontend at it via docs/js/config.js
// (backendBaseUrl). If you only deploy to GitHub Pages, the frontend falls back
// to reading the static data/*.json committed by the GitHub Action instead, and
// the countdown becomes best-effort (see README "Two deployment modes").
//
// Design guarantees:
//  - The SERVER owns lastFetchAt + nextFetchAt as shared state, so every client
//    sees the same countdown regardless of when they connected.
//  - A failed scrape uses retry/backoff and NEVER crashes the loop or blocks the
//    next scheduled attempt; the last good results are retained.
//  - Poll cadence starts at idleIntervalSeconds and switches to
//    activeIntervalSeconds as soon as ANY ward reports.
//  - Force refresh is debounced by forceRefreshCooldownSeconds.

import express from "express";
import path from "node:path";
import fs from "node:fs";
import { ROOT, loadConfig } from "../scraper/lib.js";
import { scrape } from "../scraper/scrape.js";

const config = loadConfig();
const app = express();
const port = process.env.PORT || 3000;
const DATA_DIR = path.join(ROOT, "docs", "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---- Shared server state (single source of truth for all clients) ----------
const state = {
  results: null,           // last good results payload
  lastFetchAt: null,       // ISO — last SUCCESSFUL fetch
  lastFetchAttemptAt: null,
  lastFetchSuccess: false,
  lastError: null,
  nextFetchAt: null,       // ISO — when the next scheduled fetch will run
  intervalSeconds: config.polling.idleIntervalSeconds,
  lastForceAt: 0,          // epoch ms — for debounce
  consecutiveFailures: 0,
};

let loopTimer = null;

function currentInterval() {
  const anyReporting = state.results?.meta?.anyWardReporting;
  return anyReporting
    ? config.polling.activeIntervalSeconds
    : config.polling.idleIntervalSeconds;
}

async function scrapeWithBackoff() {
  const { maxAttempts, baseDelayMs } = config.scrapeRetry;
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const results = await scrape(config, { log: console });
      return results;
    } catch (err) {
      lastErr = err;
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      console.warn(`[server] scrape attempt ${attempt}/${maxAttempts} failed: ${err.message}. retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

async function doFetch(reason = "scheduled") {
  state.lastFetchAttemptAt = new Date().toISOString();
  try {
    const results = await scrapeWithBackoff();
    state.results = results;
    state.lastFetchAt = new Date().toISOString();
    state.lastFetchSuccess = true;
    state.lastError = null;
    state.consecutiveFailures = 0;

    // Persist so the GitHub Pages fallback / a restart has fresh data too.
    writeSafe(path.join(DATA_DIR, "results.json"), JSON.stringify(results, null, 2));
    writeSafe(path.join(DATA_DIR, "status.json"), JSON.stringify(statusPayload(), null, 2));

    const unmatched = results.meta?.unmatchedWards || [];
    console.log(`[server] fetch ok (${reason}); wards reporting ${results.totals.wardsReporting}/${results.totals.wardsTotal}; unmatched=${unmatched.length}`);
    if (unmatched.length) console.warn("[server] UNMATCHED wards:", unmatched);
  } catch (err) {
    state.lastFetchSuccess = false;
    state.lastError = err.message;
    state.consecutiveFailures += 1;
    console.error(`[server] fetch FAILED (${reason}) after retries: ${err.message}. Keeping last good results.`);
    writeSafe(path.join(DATA_DIR, "status.json"), JSON.stringify(statusPayload(), null, 2));
    // Do NOT rethrow — the loop must keep going.
  }
}

function scheduleNext() {
  if (loopTimer) clearTimeout(loopTimer);
  const secs = currentInterval();
  state.intervalSeconds = secs;
  state.nextFetchAt = new Date(Date.now() + secs * 1000).toISOString();
  loopTimer = setTimeout(runLoopTick, secs * 1000);
}

async function runLoopTick() {
  await doFetch("scheduled");
  scheduleNext();
}

function statusPayload() {
  const results = state.results;
  return {
    lastFetchAt: state.lastFetchAt,
    lastFetchAttemptAt: state.lastFetchAttemptAt,
    lastFetchSuccess: state.lastFetchSuccess,
    lastError: state.lastError,
    nextFetchAt: state.nextFetchAt,
    intervalSeconds: state.intervalSeconds,
    consecutiveFailures: state.consecutiveFailures,
    resultsLastUpdated: results?.election?.resultsLastUpdated || null,
    wardsReporting: results?.totals?.wardsReporting ?? 0,
    wardsTotal: results?.totals?.wardsTotal ?? null,
    matchedWards: results ? results.wards.filter((w) => w._matched || w.reporting).length : 0,
    unmatchedWards: results?.meta?.unmatchedWards || [],
    anyWardReporting: results?.meta?.anyWardReporting ?? false,
    source: results?.meta?.source || null,
  };
}

// ---- HTTP API ---------------------------------------------------------------
app.use((req, res, next) => {
  // The frontend may be served from GitHub Pages (different origin) so allow CORS
  // for the read endpoints. This backend only serves our own cached JSON.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});

// Cached results the frontend polls (never the county site directly).
app.get("/api/results", (req, res) => {
  if (!state.results) return res.status(503).json({ error: "no results yet", status: statusPayload() });
  res.json({ results: state.results, status: statusPayload() });
});

// Shared schedule + health. This drives the client countdown for EVERYONE.
app.get("/api/status", (req, res) => res.json(statusPayload()));

// Minimal health/status endpoint for quick sanity checks under time pressure.
app.get("/health", (req, res) => {
  const ok = state.lastFetchSuccess && !!state.results;
  res.status(ok ? 200 : 503).json({
    ok,
    lastFetchAt: state.lastFetchAt,
    lastFetchSuccess: state.lastFetchSuccess,
    consecutiveFailures: state.consecutiveFailures,
    wardsReporting: statusPayload().wardsReporting,
    wardsTotal: statusPayload().wardsTotal,
    matchedWards: statusPayload().matchedWards,
    unmatchedWards: statusPayload().unmatchedWards,
  });
});

// Force refresh — debounced, resets the SHARED countdown for all viewers.
app.post("/api/force-refresh", async (req, res) => {
  const now = Date.now();
  const cooldownMs = config.forceRefreshCooldownSeconds * 1000;
  const since = now - state.lastForceAt;
  if (since < cooldownMs) {
    return res.status(429).json({
      ok: false,
      debounced: true,
      retryAfterSeconds: Math.ceil((cooldownMs - since) / 1000),
      nextFetchAt: state.nextFetchAt,
      message: "Force refresh ignored (cooldown active).",
    });
  }
  state.lastForceAt = now;
  await doFetch("force");
  scheduleNext(); // resets nextFetchAt for ALL clients
  res.json({ ok: true, status: statusPayload() });
});

// Serve the static frontend too, so a single deploy can host everything.
app.use(express.static(path.join(ROOT, "docs")));

function writeSafe(file, contents) {
  try { fs.writeFileSync(file, contents); } catch (e) { console.warn(`[server] write ${file} failed: ${e.message}`); }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

app.listen(port, async () => {
  console.log(`[server] listening on :${port}`);
  console.log(`[server] idle=${config.polling.idleIntervalSeconds}s active=${config.polling.activeIntervalSeconds}s forceCooldown=${config.forceRefreshCooldownSeconds}s`);
  await doFetch("startup");
  scheduleNext();
});
