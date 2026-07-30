// Headless smoke test of the browser table/scale logic with a tiny DOM stub.
// Loads scale.js + table.js the same way the browser would, renders the real
// opening-night results.json, and asserts the grouped structure comes out right
// with no runtime errors. Run: node scraper/testFrontend.js
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert";
import { ROOT } from "./lib.js";

// --- minimal DOM/window stub ------------------------------------------------
const wrap = { innerHTML: "", querySelectorAll: () => [], addEventListener() {} };
const elements = { "results-table-wrap": wrap };
const sandbox = {
  console,
  window: {},
  document: {
    getElementById: (id) => elements[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
  },
};
sandbox.window.matchMedia = (q) => ({ matches: /max-width:\s*720px/.test(q) ? false : /hover: hover/.test(q) }); // desktop
sandbox.window.AD76_CONFIG = require_json("docs/js").config = loadConfigJs();

function loadConfigJs() {
  // config.js just assigns window.AD76_CONFIG; execute it in the sandbox.
  return null;
}
function require_json() { return {}; }

const context = vm.createContext(sandbox);
function run(file) {
  const code = fs.readFileSync(path.join(ROOT, file), "utf8");
  vm.runInContext(code, context, { filename: file });
}

run("docs/js/config.js");
run("docs/js/scale.js");
// table.js references window.AD76_wardKey (set by map.js). Provide a matching stub.
sandbox.window.AD76_wardKey = function (label) {
  if (!label) return null;
  let s = String(label).toLowerCase().replace(/&/g, " and ").replace(/[.,]/g, " ")
    .replace(/\s+/g, " ").trim().replace(/\b(city|town|village)\s+of\s+/g, "")
    .replace(/\b(city|town|village)\b/g, "");
  const wm = s.match(/\b(?:wards?|w|wd)\s*0*(\d+)\b/);
  const wardNum = wm ? String(parseInt(wm[1], 10)) : null;
  let place = wm ? s.slice(0, wm.index) : s;
  place = place.replace(/\b(?:wards?|w|wd)\b/g, "").replace(/\s+/g, " ").trim().replace(/\bmadison\b.*/, "madison").trim();
  return wardNum ? `${place || "unknown"}|${wardNum}` : null;
};
run("docs/js/table.js");

const results = JSON.parse(fs.readFileSync(path.join(ROOT, "docs/data/results.json"), "utf8"));

let pass = 0;
function ok(name, cond) { assert.ok(cond, "FAIL: " + name); console.log("  ok  " + name); pass++; }

console.log("\n[frontend] render opening-night table");
sandbox.window.AD76_TABLE.render(results);
const html = wrap.innerHTML;

ok("produced a table", /<table class="results-table/.test(html));
ok("has candidate header chips", (html.match(/class="chip"/g) || []).length >= results.candidates.length);
ok("groups Madison alder districts", /Alder District 6/.test(html) && /Alder District 15/.test(html));
ok("groups non-Madison by municipality (Blooming Grove)", /Blooming Grove/.test(html));
ok("groups non-Madison by municipality (McFarland)", /McFarland/.test(html));
ok("shows 'not reporting' on opening night", /not reporting/.test(html));
ok("has a subtotal row", /subtotal-row/.test(html));
ok("has a grand total / district total", /grand-total/.test(html) && /District total/.test(html));
ok("no invented numbers (opening night dashes present)", /class="num muted">—/.test(html));

// enrich a ward to confirm leader coloring path runs without error
results.wards[0].reporting = true;
results.wards[0].totalVotes = 410;
results.wards[0].results = results.candidates.map((c, i) => ({
  candidate: c.name, votes: i === 0 ? 210 : 50, share: i === 0 ? 0.51 : 0.12,
}));
results.wards[0].leader = results.candidates[0].name;
results.wards[0].margin = 0.39;
results.totals.leader = results.candidates[0].name;
sandbox.window.AD76_TABLE.render(results);
ok("re-render with a reporting ward works", /210/.test(wrap.innerHTML));

console.log(`\nFRONTEND: ALL ${pass} CHECKS PASSED\n`);
