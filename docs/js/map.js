// Ward choropleth. Renders full ward geometry on load regardless of results,
// recolors as wards report, and links selection to the results table.

(function () {
  const S = window.AD76_SCALE;
  const CFG = window.AD76_CONFIG;

  let map = null;
  let geoLayer = null;
  let latestResults = null;
  let onWardSelect = null; // callback(wardKey)
  const layerByKey = new Map();

  // Canonical ward key, mirrors scraper/matchWards.canonicalWardKey so the map
  // features line up with results ward rows.
  function canonicalWardKey(label) {
    if (!label) return null;
    let s = String(label).toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[.,]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\b(city|town|village)\s+of\s+/g, "")
      .replace(/\b(city|town|village)\b/g, "");
    const wm = s.match(/\b(?:wards?|w|wd)\s*0*(\d+)\b/);
    const wardNum = wm ? String(parseInt(wm[1], 10)) : null;
    let place = wm ? s.slice(0, wm.index) : s;
    place = place.replace(/\b(?:wards?|w|wd)\b/g, "").replace(/\s+/g, " ").trim()
      .replace(/\bmadison\b.*/, "madison").trim();
    if (!wardNum) return null;
    return `${place || "unknown"}|${wardNum}`;
  }
  window.AD76_wardKey = canonicalWardKey;

  function detectNameField(props) {
    if (CFG.wardNameField && props[CFG.wardNameField] != null) return CFG.wardNameField;
    const k = Object.keys(props).find((key) => /ward|label|name/i.test(key));
    return k || null;
  }

  function wardForKey(key) {
    if (!latestResults || !key) return null;
    return latestResults.wards.find((w) => canonicalWardKey(w.name) === key) || null;
  }

  function styleFor(feature) {
    const props = feature.properties || {};
    const nameField = detectNameField(props);
    const label = nameField ? props[nameField] : null;
    const key = canonicalWardKey(label);
    const ward = wardForKey(key);
    const fill = S.wardFill(ward, latestResults);
    return {
      color: "#0c0c0d",           // stroke between wards
      weight: 1,
      fillColor: fill.color,
      fillOpacity: ward && ward.reporting ? fill.opacity : 1,
      opacity: 1,
    };
  }

  function tooltipHtml(ward, label) {
    if (!ward) return `<strong>${label || "Ward"}</strong><div class="tt-sub">Not in tracked district</div>`;
    if (!ward.reporting) {
      return `<strong>${ward.name}</strong><div class="tt-sub">Not yet reporting</div>`;
    }
    const rows = [...ward.results]
      .sort((a, b) => (b.votes || 0) - (a.votes || 0))
      .map((r) => {
        const color = S.colorForCandidate(r.candidate, latestResults);
        const pct = r.share != null ? (r.share * 100).toFixed(1) + "%" : "—";
        return `<div class="tt-row"><span class="chip" style="background:${color}"></span>
          <span class="tt-name">${r.candidate}</span>
          <span class="tt-num">${(r.votes ?? 0).toLocaleString()}</span>
          <span class="tt-pct">${pct}</span></div>`;
      })
      .join("");
    return `<strong>${ward.name}</strong>
      <div class="tt-sub">${(ward.totalVotes || 0).toLocaleString()} votes</div>${rows}`;
  }

  function initMap() {
    map = L.map("map", {
      zoomControl: true,
      attributionControl: true,
      preferCanvas: true,
      scrollWheelZoom: true,
      background: "#141416",
    });
    map.setView([43.08, -89.38], 12); // Madison-ish default until geojson fits

    // Optional subtle dark basemap for orientation (free, no key). Commented out
    // by default to keep the map editorial and dependency-free; uncomment to add.
    // L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png",
    //   { subdomains: "abcd", maxZoom: 19, attribution: "© OpenStreetMap © CARTO" }).addTo(map);
  }

  function loadGeoJson(geojson) {
    if (geoLayer) geoLayer.remove();
    layerByKey.clear();

    const isTouch = window.matchMedia("(hover: none)").matches;

    geoLayer = L.geoJSON(geojson, {
      style: styleFor,
      onEachFeature: (feature, layer) => {
        const props = feature.properties || {};
        const nameField = detectNameField(props);
        const label = nameField ? props[nameField] : null;
        const key = canonicalWardKey(label);
        if (key) layerByKey.set(key, layer);

        const bind = () => {
          const ward = wardForKey(key);
          layer.bindTooltip(tooltipHtml(ward, label), {
            sticky: true,
            direction: "top",
            className: "ward-tooltip",
          });
        };
        bind();

        layer.on("click", () => {
          selectWard(key, { fromMap: true });
        });
        if (!isTouch) {
          layer.on("mouseover", () => {
            layer.setStyle({ weight: 2.5, color: "#f5f5f5" });
            layer.bringToFront();
            highlightRow(key, true);
          });
          layer.on("mouseout", () => {
            geoLayer.resetStyle(layer);
            highlightRow(key, false);
          });
        }
      },
    }).addTo(map);

    try {
      map.fitBounds(geoLayer.getBounds(), { padding: [16, 16] });
    } catch (e) { /* empty geojson */ }
  }

  function highlightRow(key, on) {
    const row = document.querySelector(`tr[data-ward-key="${cssEscape(key)}"]`);
    if (row) row.classList.toggle("row-hl", on);
  }

  let selectedKey = null;
  function selectWard(key, { fromMap = false, fromTable = false } = {}) {
    selectedKey = key;
    // update tooltips content (data may have changed) and open on selection
    const layer = layerByKey.get(key);
    if (layer) {
      const ward = wardForKey(key);
      const props = layer.feature.properties || {};
      const nameField = detectNameField(props);
      layer.setTooltipContent(tooltipHtml(ward, nameField ? props[nameField] : null));
      if (fromTable) {
        layer.openTooltip();
        map.panTo(layer.getBounds ? layer.getBounds().getCenter() : map.getCenter());
      }
    }
    // highlight table row
    document.querySelectorAll("tr.row-selected").forEach((r) => r.classList.remove("row-selected"));
    const row = document.querySelector(`tr[data-ward-key="${cssEscape(key)}"]`);
    if (row) {
      row.classList.add("row-selected");
      if (!fromTable) row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
    if (onWardSelect) onWardSelect(key, { fromMap, fromTable });
  }

  function cssEscape(s) {
    return String(s).replace(/["\\]/g, "\\$&");
  }

  function update(results) {
    latestResults = results;
    if (geoLayer) {
      geoLayer.setStyle(styleFor);
      // refresh tooltips
      geoLayer.eachLayer((layer) => {
        const props = layer.feature.properties || {};
        const nameField = detectNameField(props);
        const label = nameField ? props[nameField] : null;
        const key = canonicalWardKey(label);
        layer.setTooltipContent(tooltipHtml(wardForKey(key), label));
      });
    }
  }

  window.AD76_MAP = {
    init: initMap,
    loadGeoJson,
    update,
    selectWard,
    setOnWardSelect: (fn) => { onWardSelect = fn; },
    hasLayerFor: (key) => layerByKey.has(key),
  };
})();
