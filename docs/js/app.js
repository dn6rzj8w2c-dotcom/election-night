// Main orchestration: fetch data + status, drive the backend-owned countdown,
// wire force refresh, render legend / summary bar / stale indicator, and keep the
// map and table linked. Works in both deployment modes (see config.js).

(function () {
  const CFG = window.AD76_CONFIG;
  const S = window.AD76_SCALE;

  let results = null;
  let status = null;
  let countdownTimer = null;
  let pollTimer = null;

  const usingBackend = !!CFG.backendBaseUrl;

  // ---- URL helpers ----------------------------------------------------------
  const resultsUrl = () =>
    usingBackend ? `${CFG.backendBaseUrl}/api/results` : CFG.staticResultsPath;
  const statusUrl = () =>
    usingBackend ? `${CFG.backendBaseUrl}/api/status` : CFG.staticStatusPath;
  const forceUrl = () =>
    usingBackend ? `${CFG.backendBaseUrl}/api/force-refresh` : null;

  // ---- Fetch ----------------------------------------------------------------
  async function fetchJson(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
  }

  async function loadAll() {
    try {
      const [rData, sData] = await Promise.allSettled([
        fetchJson(resultsUrl()),
        fetchJson(statusUrl()),
      ]);

      if (rData.status === "fulfilled") {
        // backend wraps as {results,status}; static file is the raw results obj
        results = rData.value.results || rData.value;
      }
      if (sData.status === "fulfilled") {
        status = sData.value;
      } else if (rData.status === "fulfilled" && rData.value.status) {
        status = rData.value.status;
      }

      if (results) {
        window.AD76_MAP.update(results);
        window.AD76_TABLE.render(results);
        renderSummary();
        renderLegend();
      }
      renderStatus();
      scheduleClientPoll();
      restartCountdown();
    } catch (e) {
      console.error("[app] loadAll failed:", e.message);
      markStale(true, e.message);
    }
  }

  // ---- Summary bar ----------------------------------------------------------
  function renderSummary() {
    const el = document.getElementById("summary-bar");
    const t = results.totals;
    const leaderColor = t.leader ? S.colorForCandidate(t.leader, results) : CFG.neutralWardColor;
    const wr = t.wardsTotal ? `${t.wardsReporting} of ${t.wardsTotal}` : `${t.wardsReporting}`;
    const wpct = t.wardsTotal ? Math.round((t.wardsReporting / t.wardsTotal) * 100) : 0;

    const leadHtml = t.leader
      ? `<span class="lead-chip" style="background:${leaderColor}"></span>
         <span class="lead-name">${t.leader}</span>
         <span class="lead-share">${(bestShare() * 100).toFixed(1)}%</span>`
      : `<span class="lead-name muted">No wards reporting yet</span>`;

    el.innerHTML = `
      <div class="sb-block sb-lead">
        <div class="sb-label">Leading</div>
        <div class="sb-value">${leadHtml}</div>
      </div>
      <div class="sb-block">
        <div class="sb-label">Total votes</div>
        <div class="sb-value big">${(t.totalVotes || 0).toLocaleString()}</div>
      </div>
      <div class="sb-block">
        <div class="sb-label">Wards reporting</div>
        <div class="sb-value big">${wr}<span class="sb-sub"> (${wpct}%)</span></div>
      </div>`;
  }
  function bestShare() {
    const t = results.totals;
    const lead = t.byCandidate.find((x) => S.norm(x.candidate) === S.norm(t.leader));
    return lead ? lead.share : 0;
  }

  // ---- Legend (always visible) ----------------------------------------------
  function renderLegend() {
    const el = document.getElementById("legend");
    el.innerHTML = results.candidates
      .map(
        (c) => `<div class="legend-item">
          <span class="chip" style="background:${c.color}"></span>
          <span class="legend-name">${c.name}</span>
          ${c.fixed ? '<span class="legend-fixed" title="Fixed color">◆</span>' : ""}
        </div>`
      )
      .join("") +
      `<div class="legend-item legend-neutral">
        <span class="chip" style="background:${CFG.neutralWardColor}"></span>
        <span class="legend-name muted">Not yet reporting</span>
      </div>`;
  }

  // ---- Status bar: timestamps, stale indicator, countdown -------------------
  function renderStatus() {
    const s = status || {};
    const lastFetch = s.lastFetchAt ? new Date(s.lastFetchAt) : null;
    const countyUpd = (results && results.election && results.election.resultsLastUpdated) || s.resultsLastUpdated || null;

    setText("last-fetch", lastFetch ? timeAgo(lastFetch) + " (" + fmtClock(lastFetch) + ")" : "—");
    setText("county-updated", countyUpd || "—");

    // unmatched wards hint (visible mid-night sanity check)
    const unmatched = (s.unmatchedWards || (results && results.meta && results.meta.unmatchedWards)) || [];
    const um = document.getElementById("unmatched-note");
    if (um) {
      if (unmatched.length) {
        um.style.display = "";
        um.innerHTML = `⚠ ${unmatched.length} scraped ward(s) did not match the map layer: <span class="mono">${unmatched.slice(0, 8).join(", ")}${unmatched.length > 8 ? "…" : ""}</span>`;
      } else {
        um.style.display = "none";
      }
    }

    // stale?
    const stale =
      s.lastFetchSuccess === false ||
      (lastFetch && (Date.now() - lastFetch.getTime()) / 1000 > (s.staleAfterSeconds || CFG.staleAfterSeconds));
    markStale(!!stale, s.lastError);
  }

  function markStale(isStale, msg) {
    const el = document.getElementById("stale-indicator");
    if (!el) return;
    el.classList.toggle("active", isStale);
    el.title = msg || "";
    el.querySelector(".stale-text").textContent = isStale
      ? (msg ? "Stale data — last fetch failed" : "Stale data — results may be outdated")
      : "Live";
  }

  // ---- Countdown (driven by backend nextFetchAt) ----------------------------
  function restartCountdown() {
    if (countdownTimer) clearInterval(countdownTimer);
    const el = document.getElementById("countdown");
    const nextAt = status && status.nextFetchAt ? new Date(status.nextFetchAt).getTime() : null;

    if (!nextAt) {
      // No shared schedule available (e.g. static mode before Action populates it)
      el.textContent = usingBackend ? "—" : "auto";
      return;
    }
    const tick = () => {
      const secs = Math.max(0, Math.round((nextAt - Date.now()) / 1000));
      el.textContent = `${secs}s`;
      if (secs <= 0) {
        clearInterval(countdownTimer);
        // when the shared schedule elapses, refetch to pick up new data + new nextFetchAt
        loadAll();
      }
    };
    tick();
    countdownTimer = setInterval(tick, 250);
  }

  // ---- Client poll (hits OUR backend/static files, never the county) --------
  function scheduleClientPoll() {
    if (pollTimer) clearTimeout(pollTimer);
    const active = results && results.meta && results.meta.anyWardReporting;
    const secs = active ? CFG.activeIntervalSeconds : CFG.idleIntervalSeconds;
    // In backend mode the countdown already triggers reloads; this is a safety net.
    pollTimer = setTimeout(loadAll, secs * 1000);
  }

  // ---- Force refresh --------------------------------------------------------
  async function onForceRefresh() {
    const btn = document.getElementById("force-refresh");
    if (usingBackend) {
      btn.disabled = true;
      btn.classList.add("loading");
      try {
        const res = await fetch(forceUrl(), { method: "POST" });
        const body = await res.json().catch(() => ({}));
        if (res.status === 429) {
          flashMessage(`Refresh cooling down (${body.retryAfterSeconds || "a few"}s)…`);
        }
        await loadAll(); // picks up new shared nextFetchAt for everyone
      } catch (e) {
        flashMessage("Force refresh failed: " + e.message);
      } finally {
        btn.disabled = false;
        btn.classList.remove("loading");
      }
    } else {
      // Static mode: no server to trigger a scrape. Just re-pull the latest
      // committed data and tell the user why it is limited.
      flashMessage("Static hosting: re-loading latest published data (no live scrape).");
      await loadAll();
    }
  }

  function flashMessage(msg) {
    const el = document.getElementById("flash");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    setTimeout(() => el.classList.remove("show"), 3500);
  }

  // ---- helpers --------------------------------------------------------------
  function setText(id, text) { const e = document.getElementById(id); if (e) e.textContent = text; }
  function fmtClock(d) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
  function timeAgo(d) {
    const s = Math.round((Date.now() - d.getTime()) / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    return `${Math.round(m / 60)}h ago`;
  }

  // ---- boot -----------------------------------------------------------------
  async function boot() {
    window.AD76_MAP.init();

    // Load ward geometry immediately (independent of results existing).
    try {
      const gj = await fetchJson(CFG.wardsGeoJsonPath);
      window.AD76_MAP.loadGeoJson(gj);
    } catch (e) {
      console.warn("[app] wards.geojson not found yet — map will show no wards until you run fetch-boundaries.", e.message);
      const note = document.getElementById("geo-note");
      if (note) note.style.display = "";
    }

    // Link map <-> table both directions.
    window.AD76_MAP.setOnWardSelect((key) => {/* selection handled inside map */});
    window.AD76_TABLE.setOnRowSelect((key) => {
      window.AD76_MAP.selectWard(key, { fromTable: true });
    });

    document.getElementById("force-refresh").addEventListener("click", onForceRefresh);
    if (!usingBackend) {
      const b = document.getElementById("force-refresh");
      b.title = "Static hosting: reloads latest published data (see README for live mode).";
    }

    await loadAll();
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
