// Client mirror of the shared color assignment + margin->opacity scale.
// Prefers colors baked into results.json; falls back to window.AD76_CONFIG.

(function () {
  const CFG = window.AD76_CONFIG;

  function norm(s) {
    return String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  // Build a name->color map from the candidates array in results.json.
  function colorMapFromResults(results) {
    const map = new Map();
    if (results && Array.isArray(results.candidates)) {
      results.candidates.forEach((c) => map.set(norm(c.name), c.color));
    }
    return map;
  }

  // Fallback assignment mirroring lib.js when results lack colors.
  function fallbackColor(name, usedPaletteIdxRef) {
    for (const [k, v] of Object.entries(CFG.fixedCandidateColors)) {
      if (norm(k) === norm(name)) return v;
    }
    const c = CFG.palette[usedPaletteIdxRef.i] || "#888888";
    usedPaletteIdxRef.i += 1;
    return c;
  }

  function colorForCandidate(name, results) {
    const map = colorMapFromResults(results);
    if (map.has(norm(name))) return map.get(norm(name));
    return "#888888";
  }

  // Shared margin -> opacity (identical for every candidate).
  function marginToOpacity(margin, results) {
    const ms = (results && results.marginScale) || CFG.marginScale;
    const { minMargin, maxMargin, minOpacity, maxOpacity } = ms;
    if (!isFinite(margin)) return minOpacity;
    if (margin <= minMargin) return minOpacity;
    if (margin >= maxMargin) return maxOpacity;
    const t = (margin - minMargin) / (maxMargin - minMargin);
    return minOpacity + t * (maxOpacity - minOpacity);
  }

  // Fill for a ward: neutral gray if not reporting, else leader color at an
  // opacity encoding margin of victory.
  function wardFill(ward, results) {
    if (!ward || !ward.reporting || !ward.leader) {
      return { color: CFG.neutralWardColor, opacity: 1 };
    }
    const base = colorForCandidate(ward.leader, results);
    return { color: base, opacity: marginToOpacity(ward.margin, results) };
  }

  // Convert hex + opacity into an rgba string over the dark base.
  function hexToRgba(hex, alpha) {
    const h = hex.replace("#", "");
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  window.AD76_SCALE = {
    norm,
    colorForCandidate,
    marginToOpacity,
    wardFill,
    hexToRgba,
  };
})();
