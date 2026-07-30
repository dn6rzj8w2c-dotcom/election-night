# AD76 Election Night Results Map

Live ward-level choropleth map + results table for the **Wisconsin Assembly District 76 Democratic primary** (Dane County, WI — **August 11, 2026**).

The map renders every ward on page load in neutral gray and recolors each ward to its leading candidate as results report; the table below breaks every ward down by candidate, grouped by Madison alder district (with municipality groups for non‑Madison wards). Map and table are linked in both directions. A backend scrapes `elections.danecounty.gov`, parses it to JSON, and the frontend polls that cached JSON.

---

## ⚠️ Read this first: GitHub Pages vs. the live-backend requirements

You said to assume **GitHub Pages**. GitHub Pages serves **static files only** — it cannot run a server, cannot poll every 15/60 seconds, cannot hold a shared server‑side countdown, and cannot expose a live force‑refresh endpoint. Several requirements in the spec (sub‑minute polling; a countdown and force‑refresh that are *shared across all viewers* and owned by the backend) **cannot be satisfied by GitHub Pages alone.** I did not fake this. Instead the project ships in **two modes that share the exact same frontend and the exact same scraper**:

| Capability | **Mode B — GitHub Pages only** | **Mode A — GitHub Pages + Node backend** |
|---|---|---|
| Hosting | GitHub Pages (`docs/`) | Frontend on Pages *or* served by the Node app |
| "Backend" | Scheduled **GitHub Action** runs the scraper, commits `docs/data/*.json` | `server/server.js` scrapes on a live loop |
| Min refresh cadence | **~5 min** (GitHub cron floor) | **15 s / 60 s** as specified |
| Shared countdown across viewers | Best‑effort (from `status.json`) | **True shared state** |
| Live force‑refresh for everyone | ❌ (button re‑reads published data) | ✅ debounced `/api/force-refresh` |
| Health endpoint | `docs/data/status.json` | `/health`, `/api/status` |

**Recommendation:** deploy the static frontend to GitHub Pages *and* deploy `server/server.js` to any free Node host (Render, Railway, Fly.io), then set `backendBaseUrl` in `docs/js/config.js` to that server. You get the polished Pages URL to share **and** the real sub‑minute shared schedule + live force refresh. If you truly only want Pages, Mode B works and degrades honestly (the UI tells the user when it is re‑reading published data rather than triggering a live scrape).

---

## Stack, and why

- **No frontend framework — vanilla ES modules.** The app is a single page: one map + one table + a status bar. React/Vue/Svelte would add a build step, a toolchain, and hydration for zero benefit here, and would make the static‑hosting story worse. Plain modules keep the whole thing debuggable at 9pm on election night with nothing but the browser devtools.
- **Leaflet** for mapping. It renders GeoJSON polygons directly, has first‑class touch support (needed for the mobile tap requirement), needs no API key, and is trivial to theme dark. `deck.gl`/Mapbox are overkill for a few dozen polygons and Mapbox needs a token.
- **Node + Cheerio** for the scraper. The county posts server‑rendered HTML tables; Cheerio is a tiny, fast, jQuery‑like parser. No headless browser needed.
- **Express** for the live backend (Mode A). Minimal, well‑understood, easy to deploy anywhere.
- **GitHub Actions** as the "serverless" scraper for Mode B — it *is* the backend when there is no server.
- **Config in one JSON file** (`config/config.json`) so election ID, intervals, colors, and thresholds change without touching code.

---

## Data sources — and what you must verify yourself

The spec (correctly) says *do not assume*. Here is the honest status of each source and exactly what to confirm before election night. **Placeholders are intentional** — nothing critical is hardcoded and assumed correct.

1. **Results — `https://elections.danecounty.gov`.** The deprecated `api.danecounty.gov` is **not** used. The scraper hits `/Election-Result/{electionId}`, finds the AD76 race by name, follows the *Votes By Precinct* link to `/Precincts-Result/{electionId}/{raceId}`, and parses both tables.
   - **You must set `electionId`** in `config/config.json`. The Aug 11 2026 election page does not exist until close to the date; find its numeric id at `https://elections.danecounty.gov/election-dates` and paste it in. Until you do, the app runs in a valid **opening‑night empty state** (real structure, no invented numbers).
   - **HTML selectors are unverified against the real 2026 page** (it doesn't exist yet). Parsing is written defensively and isolated in `parseElectionPage()` / `parsePrecinctPage()` in `scraper/scrape.js`, with every spot to double‑check marked `>>> VERIFY`. Adjusting to the real markup is a contained edit, and `scraper/test.js` shows the exact table shapes the parsers expect.
2. **"Precinct" == "ward".** Dane County labels the base unit **precinct**; in Dane County these correspond to what voters call **wards**. The UI says "ward" throughout. Confirm this equivalence still holds for the 2026 layer before the election (note surfaced in the UI's fine print).
3. **Ward boundaries — Dane County ArcGIS.** Set `config.gis.boundaryLayerUrl` to the ward/precinct layer's `.../query` endpoint from `https://gis-countyofdane.opendata.arcgis.com/`, then run `npm run fetch-boundaries`. Name matching between the GIS layer and the scrape is **explicit and inspectable** (`scraper/matchWards.js`): both sides collapse to a canonical `municipality|wardNumber` key, and **any ward that fails to match is logged and surfaced in the UI**, never silently dropped.
4. **AD76 county lines & municipal makeup.** **Confirm before the night** whether AD76 sits entirely inside Dane County and which municipalities it covers. The table does **not** assume Madison‑only: wards with no alder district are grouped by municipality. If AD76 crosses a county line, say so — the Dane County source will not carry the out‑of‑county wards, and those must not be silently truncated. (A sample boundary file ships so the UI renders before you pull the real layer; replace it.)

---


## GitHub Actions deployment

The repository now includes two workflows:

- `.github/workflows/pages.yml` runs on pushes to `main`, manual dispatch, and every five minutes. It installs dependencies, runs tests, applies repository variables, scrapes the latest results, uploads `docs/` as a Pages artifact, and deploys with GitHub's official Pages actions.
- `.github/workflows/validate.yml` runs the test suite on pull requests.

In **Settings → Pages**, set the source to **GitHub Actions**. In **Settings → Secrets and variables → Actions → Variables**, add `ELECTION_ID` when Dane County publishes it and optionally `RACE_ID`. The workflow never exposes those values to browser JavaScript.

GitHub Pages remains static hosting. The scheduled workflow can publish at GitHub's five-minute schedule floor, but it cannot provide the original 15-second server-owned refresh loop or an unauthenticated force-refresh API. The on-page Refresh button reloads the most recently deployed JSON.

## Visual direction

The interface is now light mode and uses a compact election-data-newsroom aesthetic: white background, black rules, condensed display type, restrained red editorial accent, direct numerical hierarchy, and a map-first layout. It is inspired by the clarity of modern election coverage without copying FiveThirtyEight branding or an exact proprietary layout.

## Project layout

```
config/config.json          Single source of truth (election id, intervals, colors, GIS)
scraper/
  scrape.js                 Server-side scraper + parsers (>>> VERIFY marks)
  matchWards.js             Explicit ward-name matching + boundary loader
  lib.js                    Shared color assignment + margin scale + derived totals
  fetchBoundaries.js        One-time ArcGIS -> docs/data/wards.geojson
  makeSampleBoundaries.js   Generates SAMPLE wards.geojson for preview
  test.js                   Offline verification (33 checks)
  serveStatic.js            Local static preview server
server/server.js            Live backend: shared schedule, force-refresh, /health
.github/workflows/scrape.yml  Mode B "backend": scheduled scrape + commit
docs/                       ← GitHub Pages root (static site)
  index.html, css/, js/
  data/                     results.json, status.json, wards.geojson
```

---

## Run it locally

```bash
npm install

# 1) Ward geometry: real or sample
npm run fetch-boundaries      # after setting config.gis.boundaryLayerUrl
#   or, for immediate preview with schematic wards:
npm run sample-boundaries

# 2) Produce data once (safe with no electionId -> opening-night empty state)
npm run scrape

# 3a) Preview the static site exactly as GitHub Pages serves it
npm run serve-static          # http://localhost:8080

# 3b) OR run the full live backend (Mode A: real 15/60s loop + force refresh)
npm run server                # http://localhost:3000  (also serves docs/)
#     then set backendBaseUrl in docs/js/config.js to http://localhost:3000

# Verify the parsers/matching/colors without the network:
npm test
```

---

## Deploy

### Mode B — GitHub Pages only
1. Push the repo to GitHub.
2. **Settings → Pages →** Source: *Deploy from a branch*, Branch: `main`, Folder: **`/docs`**.
3. The included **Actions workflow** (`.github/workflows/scrape.yml`) runs the scraper every ~5 min and commits refreshed `docs/data/*.json`. Enable Actions and give it write permission (**Settings → Actions → General → Workflow permissions → Read and write**).
4. Leave `backendBaseUrl: null` in `docs/js/config.js`.

### Mode A — add the live backend (recommended)
1. Deploy `server/server.js` to a Node host (Render/Railway/Fly). Start command: `npm run server`. Set `PORT` if the host requires it.
2. In `docs/js/config.js`, set `backendBaseUrl` to that server's URL and redeploy Pages (or just serve the site from the Node app itself).
3. Now the countdown and **Refresh now** are backend‑owned and shared across every visitor, with the specified 15s/60s cadence and force‑refresh debounce.

---

## Configuration reference (`config/config.json`)

| Key | Meaning |
|---|---|
| `electionId` | Numeric id of the Aug 11 2026 primary. **Set this.** |
| `raceNameMatch` | Substring used to find the AD76 race (default `"Assembly District 76"`). |
| `raceId` | Optional; auto-discovered from the *Votes By Precinct* link if null. |
| `polling.idleIntervalSeconds` / `activeIntervalSeconds` | 60 while no ward reports; 15 once any ward reports. Hot‑editable. |
| `forceRefreshCooldownSeconds` | Debounce window for force refresh (default 12s). |
| `staleAfterSeconds` | UI shows "stale" if the last good fetch is older than this. |
| `scrapeRetry` | Retry count + backoff for a failed scrape. |
| `candidates.fixed` | Dina → `#56B4E9`, locked regardless of ballot order. |
| `candidates.palette` | Okabe‑Ito colors for the other candidates, assigned in scrape order. |
| `candidates.knownCandidates` | Real ballot names to show pre‑results (optional). |
| `marginScale` | Shared margin→opacity scale (same for every candidate). |
| `neutralWardColor` | Fill for not‑yet‑reporting wards (`#3A3A3A`). |
| `gis.boundaryLayerUrl` / `wardNameField` / `alderDistrictField` | ArcGIS layer + attributes. |

**Changing the candidate list is a one‑line edit** in `candidates` — colors, legend, map, and table all read from there.

---

## Election-night runbook

1. **Set `electionId`** (from `/election-dates`) and confirm `raceNameMatch` finds AD76.
2. **Pull real boundaries:** set `gis.boundaryLayerUrl` + fields, `npm run fetch-boundaries`. Check the printed property keys to confirm `wardNameField` / `alderDistrictField`.
3. **Watch for unmatched wards.** They are logged by the scraper, shown in `status.json` → `unmatchedWards`, and surfaced in the UI's "Reporting status" card. Fix the canonicalizer in `matchWards.js` if a real ward label doesn't reduce to `municipality|number`.
4. **Health check:** Mode A → `GET /health`; Mode B → open `docs/data/status.json`. Both report last fetch time, success/failure, and matched‑vs‑unmatched counts.
5. **If the county site is slow/down:** the scraper retries with backoff and never crashes the loop or overwrites the last good `results.json`; the UI flips to a "stale data" state.
6. **Tune on the fly:** edit intervals / cooldown in `config/config.json` (restart the server, or the next Action run picks it up).

---

## "Before calling this done" — verification results

Run `npm test` to reproduce (33 checks). Summary:

- ✅ **Zero‑ and partial‑result states never invent data.** A ward present in the table but blank is `reporting:false`, not zero‑with‑a‑percentage. Opening night: `totalVotes:0`, `leader:null`, `anyWardReporting:false`.
- ✅ **Ward matching is explicit and logged.** `"City of Madison Ward 34"`, `"MADISON W34"`, and `"City of Madison Wards 34"` all reduce to `madison|34`; an unmatched scraped ward (`SUN PRAIRIE W7`) is **reported and logged**, not dropped.
- ✅ **Opening‑night render.** Map draws all wards in neutral gray from `wards.geojson` independent of results; table shows real ward names + "not reporting"; legend shows candidate names. (`npm run scrape` with no `electionId` produces exactly this.)
- ✅ **Locked + shared colors.** Dina is `#56B4E9` regardless of ballot position and does not consume a palette slot; others get Okabe‑Ito in scrape order; one shared margin→opacity scale for every candidate.
- ✅ **Countdown/force‑refresh sharing** — Mode A: countdown is derived from the server's single `nextFetchAt`, and force refresh resets it for all clients (debounced). Mode B degrades honestly (documented above).
- ✅ **Map ↔ table linking** — hover/tap a ward highlights the matching table row (by canonical key), and clicking a row highlights + pans to the ward.
- ✅ **Mobile table** — sticky ward column + horizontal scroll for candidates (no shrinking text), alder groups collapsed by default on mobile, tap (not hover) on touch.

**Known limitations (stated, not hidden):** county HTML selectors are unverified against the not‑yet‑existent 2026 page (marked `>>> VERIFY`, covered by mock tests); GitHub Pages cannot meet the sub‑minute shared‑schedule requirements without the Mode A backend; the shipped `wards.geojson` is schematic sample geometry until you run `fetch-boundaries`; AD76's exact county‑line/municipal makeup must be confirmed against the real layer.

## License
MIT
