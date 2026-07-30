// Offline verification harness. Feeds mock county HTML through the parsers to
// prove: (1) zero-reporting is a valid state (no invented numbers), (2) partial
// reporting keeps not-yet-reported wards as reporting:false, (3) ward matching
// bridges "City of Madison Ward 34" <-> "MADISON W34" and logs unmatched wards.
// Run: node scraper/test.js

import assert from "node:assert";
import { parseElectionPage, parsePrecinctPage } from "./scrape.js";
import { matchWards, canonicalWardKey } from "./matchWards.js";
import { buildEmptyResults, computeDerived, loadConfig, marginToOpacity } from "./lib.js";

const config = loadConfig();
let pass = 0;
function ok(name, cond) {
  assert.ok(cond, `FAIL: ${name}`);
  console.log(`  ok  ${name}`);
  pass++;
}

console.log("\n[1] Election page — race present, 0 precincts reporting");
{
  const html = `<html><body>
    <h2>Assembly District 76 (DEM)</h2>
    <div class="race">
      <p>0 of 41 precincts reporting</p>
      <p>Results Last Updated On 08/11/2026 8:02 PM</p>
      <table>
        <tr><th>Candidate</th><th>Votes</th><th>%</th></tr>
        <tr><td>Dina Nina Martinez-Rutherford</td><td>0</td><td>0%</td></tr>
        <tr><td>Jamie Rivera</td><td>0</td><td>0%</td></tr>
        <tr><td>Alex Okafor</td><td>0</td><td>0%</td></tr>
      </table>
      <a href="/Precincts-Result/999/57">Votes By Precinct</a>
    </div>
  </body></html>`;
  const parsed = parseElectionPage(html, config);
  ok("found the race", parsed.found === true);
  ok("extracted raceId from precinct link (57)", parsed.raceId === "57");
  ok("0 of 41 parsed", parsed.reporting.reporting === 0 && parsed.reporting.total === 41);
  ok("captured 'Results Last Updated On'", /08\/11\/2026/.test(parsed.resultsLastUpdated));
  ok("candidate names extracted", parsed.candidates.includes("Dina Nina Martinez-Rutherford"));
}

console.log("\n[2] Precinct page — PARTIAL reporting (some wards blank)");
{
  const html = `<html><body>
    <p>12 of 41 precincts reporting</p>
    <table>
      <tr><th>Precinct</th><th>Dina Nina Martinez-Rutherford</th><th>Jamie Rivera</th><th>Alex Okafor</th><th>Total</th></tr>
      <tr><td>City of Madison Ward 34</td><td>210</td><td>140</td><td>60</td><td>410</td></tr>
      <tr><td>City of Madison Ward 35</td><td>90</td><td>300</td><td>50</td><td>440</td></tr>
      <tr><td>Town of Blooming Grove Ward 1</td><td></td><td></td><td></td><td></td></tr>
      <tr><td>Total</td><td>300</td><td>440</td><td>110</td><td>850</td></tr>
    </table>
  </body></html>`;
  const precinct = parsePrecinctPage(html);
  ok("3 candidate columns detected (Total excluded)", precinct.candidates.length === 3);
  ok("3 ward rows (Total footer excluded)", precinct.wards.length === 3);
  const w34 = precinct.wards.find((w) => w.name === "City of Madison Ward 34");
  const blank = precinct.wards.find((w) => /Blooming Grove/.test(w.name));
  ok("reporting ward flagged reporting:true", w34.reporting === true);
  ok("reporting ward total = 410", w34.totalVotes === 410);
  ok("BLANK ward flagged reporting:false (no invented zeros-with-%)", blank.reporting === false);
  ok("blank ward totalVotes stays 0 and will render as 'not reporting'", blank.totalVotes === 0);
}

console.log("\n[3] Ward matching — 'City of Madison Ward 34' vs 'MADISON W34'");
{
  ok("canonical key madison|34 (long form)", canonicalWardKey("City of Madison Ward 34") === "madison|34");
  ok("canonical key madison|34 (short form)", canonicalWardKey("MADISON W34") === "madison|34");
  ok("canonical key madison|34 ('Wards 34')", canonicalWardKey("City of Madison Wards 34") === "madison|34");
  ok("town key blooming grove|1", canonicalWardKey("Town of Blooming Grove Ward 1") === "blooming grove|1");

  // base list from "GIS" (long form), scrape uses short form
  const empty = buildEmptyResults(config, ["Dina Nina Martinez-Rutherford", "Jamie Rivera", "Alex Okafor"],
    ["City of Madison Ward 34", "City of Madison Ward 35", "Town of Blooming Grove Ward 1"]);
  const scraped = [
    { name: "MADISON W34", reporting: true, totalVotes: 410,
      results: [{candidate:"Dina Nina Martinez-Rutherford",votes:210},{candidate:"Jamie Rivera",votes:140},{candidate:"Alex Okafor",votes:60}] },
    { name: "SUN PRAIRIE W7", reporting: true, totalVotes: 100,   // NOT in base list -> unmatched
      results: [{candidate:"Dina Nina Martinez-Rutherford",votes:50},{candidate:"Jamie Rivera",votes:30},{candidate:"Alex Okafor",votes:20}] },
  ];
  const logs = [];
  const { merged, unmatched } = matchWards(empty.wards, scraped, config, { log: { warn: (m) => logs.push(m) } });
  const w34 = merged.find((w) => w.name === "City of Madison Ward 34");
  ok("short-form scrape matched to long-form GIS ward", w34.reporting === true && w34.results[0].votes === 210);
  ok("unreported base ward stays reporting:false", merged.find((w)=>/Blooming Grove/.test(w.name)).reporting === false);
  ok("unmatched scraped ward is REPORTED, not dropped", unmatched.includes("SUN PRAIRIE W7"));
  ok("unmatched ward was logged", logs.some((m) => /SUN PRAIRIE W7/.test(m)));
}

console.log("\n[4] Derived totals + leader/margin, and empty state");
{
  const results = buildEmptyResults(config, ["Dina Nina Martinez-Rutherford", "Jamie Rivera", "Alex Okafor"],
    ["City of Madison Ward 34", "City of Madison Ward 35"]);
  // mark ward 34 reporting
  results.wards[0].reporting = true;
  results.wards[0].totalVotes = 410;
  results.wards[0].results = [
    {candidate:"Dina Nina Martinez-Rutherford",votes:210,share:null},
    {candidate:"Jamie Rivera",votes:140,share:null},
    {candidate:"Alex Okafor",votes:60,share:null},
  ];
  computeDerived(results, config);
  ok("leader is Dina in ward 34", results.wards[0].leader === "Dina Nina Martinez-Rutherford");
  ok("margin computed (~0.17)", Math.abs(results.wards[0].margin - (210-140)/410) < 1e-9);
  ok("district leader is Dina", results.totals.leader === "Dina Nina Martinez-Rutherford");
  ok("anyWardReporting true", results.meta.anyWardReporting === true);
  ok("second ward still not reporting", results.wards[1].reporting === false);

  // fully empty (opening night): no leader, no invented totals
  const emptyNight = buildEmptyResults(config, ["Dina Nina Martinez-Rutherford","Jamie Rivera"], ["City of Madison Ward 34"]);
  computeDerived(emptyNight, config);
  ok("opening night: totalVotes 0", emptyNight.totals.totalVotes === 0);
  ok("opening night: no leader", emptyNight.totals.leader === null);
  ok("opening night: anyWardReporting false", emptyNight.meta.anyWardReporting === false);
}

console.log("\n[5] Shared margin->opacity scale (same for any candidate)");
{
  ok("<=10% margin -> minOpacity", marginToOpacity(0.05, config) === config.marginScale.minOpacity);
  ok(">=50% margin -> maxOpacity", marginToOpacity(0.6, config) === config.marginScale.maxOpacity);
  const mid = marginToOpacity(0.30, config);
  ok("30% margin between min and max", mid > config.marginScale.minOpacity && mid < config.marginScale.maxOpacity);
}

console.log("\n[6] Color assignment: Dina locked, others in scrape order");
{
  const empty = buildEmptyResults(config, ["Jamie Rivera","Dina Nina Martinez-Rutherford","Alex Okafor","Sam Lee","Pat Gomez"], []);
  const byName = Object.fromEntries(empty.candidates.map((c)=>[c.name,c.color]));
  ok("Dina locked to Sky Blue regardless of ballot position", byName["Dina Nina Martinez-Rutherford"] === "#56B4E9");
  ok("first non-Dina (Jamie) gets Orange", byName["Jamie Rivera"] === "#E69F00");
  ok("Dina does not consume a palette slot", byName["Alex Okafor"] === "#009E73");
}

console.log(`\nALL ${pass} CHECKS PASSED\n`);
