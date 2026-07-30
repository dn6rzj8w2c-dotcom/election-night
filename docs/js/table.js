// Results table. One row per ward, grouped by Madison alder district when a ward
// has one, otherwise grouped by municipality (towns/villages/other cities have
// no alder district). Subtotal per group, grand total at the bottom. Collapsible
// groups (collapsed by default on mobile). Two-way linked to the map.

(function () {
  const S = window.AD76_SCALE;
  const wardKey = window.AD76_wardKey;

  let results = null;
  let onRowSelect = null;

  const isMobile = () => window.matchMedia("(max-width: 720px)").matches;

  // Group wards. Prefer ward.alderDistrict (Madison), fall back to municipality.
  function groupWards(wards) {
    const groups = new Map();
    wards.forEach((w) => {
      let groupName;
      if (w.alderDistrict) groupName = `Madison — Alder District ${w.alderDistrict}`;
      else if (w.municipality && w.municipality !== "Unknown") groupName = w.municipality;
      else groupName = "Unassigned wards";
      if (!groups.has(groupName)) groups.set(groupName, []);
      groups.get(groupName).push(w);
    });
    // stable sort: Madison alder districts numerically first, then others alpha
    return [...groups.entries()].sort((a, b) => {
      const am = a[0].match(/Alder District (\d+)/);
      const bm = b[0].match(/Alder District (\d+)/);
      if (am && bm) return +am[1] - +bm[1];
      if (am) return -1;
      if (bm) return 1;
      return a[0].localeCompare(b[0]);
    });
  }

  function candidateHeaderCells() {
    return results.candidates
      .map((c) => `<th class="cand-col" title="${c.name}">
        <span class="chip" style="background:${c.color}"></span>
        <span class="cand-name">${shortName(c.name)}</span>
      </th>`)
      .join("");
  }

  function shortName(name) {
    // "Dina Nina Martinez-Rutherford" -> "Martinez-Rutherford"; else last token
    const parts = name.trim().split(/\s+/);
    if (parts.length <= 1) return name;
    return parts.slice(-1)[0];
  }

  function fmtVotes(v) { return v == null ? "—" : Number(v).toLocaleString(); }
  function fmtPct(p) { return p == null ? "—" : (p * 100).toFixed(1) + "%"; }

  function wardRow(w) {
    const key = wardKey(w.name);
    if (!w.reporting) {
      const cells = results.candidates.map(() => `<td class="num muted">—</td>`).join("");
      return `<tr class="ward-row not-reporting" data-ward-key="${esc(key)}">
        <td class="ward-name">${w.name}<span class="tag">not reporting</span></td>
        ${cells}
        <td class="num total muted">—</td>
      </tr>`;
    }
    const byName = new Map(w.results.map((r) => [S.norm(r.candidate), r]));
    const cells = results.candidates.map((c) => {
      const r = byName.get(S.norm(c.name));
      const votes = r ? r.votes : 0;
      const share = r ? r.share : 0;
      const isLeader = w.leader && S.norm(c.name) === S.norm(w.leader);
      return `<td class="num ${isLeader ? "leader" : ""}">
        <span class="v">${fmtVotes(votes)}</span>
        <span class="p" style="color:${isLeader ? c.color : "var(--muted)"}">${fmtPct(share)}</span>
      </td>`;
    }).join("");
    return `<tr class="ward-row" data-ward-key="${esc(key)}">
      <td class="ward-name">${w.name}</td>
      ${cells}
      <td class="num total">${fmtVotes(w.totalVotes)}</td>
    </tr>`;
  }

  function subtotalRow(name, wards) {
    const totals = new Map(results.candidates.map((c) => [S.norm(c.name), 0]));
    let grand = 0, reporting = 0;
    wards.forEach((w) => {
      if (!w.reporting) return;
      reporting++;
      w.results.forEach((r) => {
        totals.set(S.norm(r.candidate), (totals.get(S.norm(r.candidate)) || 0) + (r.votes || 0));
      });
      grand += w.totalVotes || 0;
    });
    const cells = results.candidates.map((c) => {
      const v = totals.get(S.norm(c.name)) || 0;
      const p = grand > 0 ? v / grand : null;
      return `<td class="num"><span class="v">${fmtVotes(v)}</span><span class="p">${fmtPct(p)}</span></td>`;
    }).join("");
    return `<tr class="subtotal-row">
      <td class="ward-name">Subtotal — ${name} <span class="tag">${reporting}/${wards.length} wards</span></td>
      ${cells}
      <td class="num total">${fmtVotes(grand)}</td>
    </tr>`;
  }

  function groupBlock(name, wards, idx) {
    const collapsed = isMobile(); // collapsed by default on mobile
    const wardRows = wards.map(wardRow).join("");
    return `<tbody class="group ${collapsed ? "collapsed" : ""}" data-group="${idx}">
      <tr class="group-header" data-toggle="${idx}">
        <td colspan="${results.candidates.length + 2}">
          <button class="grp-btn" aria-expanded="${!collapsed}">
            <span class="caret">▸</span><span class="grp-name">${name}</span>
            <span class="grp-count">${wards.length} wards</span>
          </button>
        </td>
      </tr>
      ${subtotalRow(name, wards)}
      <tr class="group-body-anchor"><td colspan="${results.candidates.length + 2}" class="body-wrap"></td></tr>
      ${wardRows}
    </tbody>`;
  }

  function grandTotalRow() {
    const t = results.totals;
    const cells = results.candidates.map((c) => {
      const bc = t.byCandidate.find((x) => S.norm(x.candidate) === S.norm(c.name));
      const isLeader = t.leader && S.norm(c.name) === S.norm(t.leader);
      return `<td class="num ${isLeader ? "leader" : ""}">
        <span class="v">${fmtVotes(bc ? bc.votes : 0)}</span>
        <span class="p" style="color:${isLeader ? c.color : "var(--muted)"}">${fmtPct(bc ? bc.share : 0)}</span>
      </td>`;
    }).join("");
    const wr = t.wardsTotal ? `${t.wardsReporting}/${t.wardsTotal}` : `${t.wardsReporting}`;
    const wpct = t.wardsTotal ? ` (${((t.wardsReporting / t.wardsTotal) * 100).toFixed(0)}%)` : "";
    return `<tfoot><tr class="grand-total">
      <td class="ward-name">District total <span class="tag">${wr} wards reporting${wpct}</span></td>
      ${cells}
      <td class="num total">${fmtVotes(t.totalVotes)}</td>
    </tr></tfoot>`;
  }

  function render(res) {
    results = res;
    const el = document.getElementById("results-table-wrap");
    const groups = groupWards(results.wards);

    const head = `<thead><tr>
      <th class="ward-name-h">Ward</th>
      ${candidateHeaderCells()}
      <th class="total-h">Total</th>
    </tr></thead>`;

    const body = groups.map(([name, wards], i) => groupBlock(name, wards, i)).join("");

    el.innerHTML = `<table class="results-table ${isMobile() ? "mobile" : ""}">
      ${head}${body}${grandTotalRow()}
    </table>`;

    wireInteractions(el);
  }

  function wireInteractions(el) {
    // collapse/expand groups
    el.querySelectorAll(".group-header .grp-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tb = btn.closest("tbody.group");
        const collapsed = tb.classList.toggle("collapsed");
        btn.setAttribute("aria-expanded", String(!collapsed));
      });
    });
    // row selection (two-way link with map)
    el.querySelectorAll("tr.ward-row").forEach((tr) => {
      tr.addEventListener("click", () => {
        const key = tr.getAttribute("data-ward-key");
        if (onRowSelect) onRowSelect(key);
      });
      if (window.matchMedia("(hover: hover)").matches) {
        tr.addEventListener("mouseenter", () => tr.classList.add("row-hl"));
        tr.addEventListener("mouseleave", () => tr.classList.remove("row-hl"));
      }
    });
  }

  function esc(s) { return String(s).replace(/"/g, "&quot;"); }

  window.AD76_TABLE = {
    render,
    setOnRowSelect: (fn) => { onRowSelect = fn; },
  };
})();
