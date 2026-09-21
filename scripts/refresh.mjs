#!/usr/bin/env node
/**
 * Refreshes index.html's live-data blocks (Ranking, Performance,
 * Day-off requests, Free Gift and Pricing) straight from the Google Sheet,
 * and leaves everything else (Redelivery reasons, Manual Callbacks, the two
 * playbook scripts, all styling/markup) untouched.
 *
 * Safety model: every value this script needs is located by searching the
 * sheet's own header text for a known label, never by a hardcoded column
 * number or row number. If a label can't be found, or a block comes back
 * empty, the script throws and exits non-zero WITHOUT touching index.html —
 * so a spreadsheet reorganization fails the GitHub Action run loudly instead
 * of silently publishing wrong data.
 *
 * Ranking, Performance, and Free Gift and Pricing are fetched by their tab's
 * numeric gid rather than its name, so a future rename (like the one that
 * turned "Free Gift Table" into "Free Gift and Pricing") won't break the
 * fetch. Day-off requests come from a block inside the Ranking/Score tab
 * (the old standalone "Rules and Shift Request" tab was removed), located at
 * run time by its "Off 1" header rather than a fixed position.
 *
 * Resilience: every fetch is validated against the labels it expects, and
 * retried a couple of times with a cache-busting param before giving up.
 * And instead of stopping at the FIRST problem, every block is checked and
 * every problem found is reported together in one error, so one run — and
 * one round of fixes — can surface everything that needs attention instead
 * of one thing at a time.
 */

import { readFileSync, writeFileSync } from "fs";

const SHEET_ID = "1NyWkYctFgVEX1q5v_v-XWqPfuw5YhylMfkA6sIfSvoA";
const FILE = "index.html";

// Tab gids — stable across renames, unlike a tab's name (the Free Gift tab
// has already been renamed once). Prefer these over name-based lookups.
const GID_RANKING = "945544049"; // Ranking/Score
const GID_PERF = "773896381";    // Performance update
const GID_GIFTS = "1249939057";  // Free Gift and Pricing (formerly "Free Gift Table")

function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

async function fetchSheetCsv(sheetName, bust) {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}` +
    (bust ? `&_=${bust}` : "");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed for sheet "${sheetName}": HTTP ${res.status}`);
  const text = await res.text();
  if (!text || text.length < 5) throw new Error(`Sheet "${sheetName}" came back empty`);
  return parseCsv(text);
}

// Minimal RFC4180 CSV parser (handles quoted fields, embedded commas, "" escaped quotes).
function parseCsv(text) {
  // Strip a leading UTF-8 BOM if present, so the very first cell isn't polluted.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\r") { /* skip */ }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Collapses ALL whitespace runs (including the line breaks Sheets inserts
// into wrapped header cells, e.g. "AGENT \nNAME") down to single spaces
// before comparing, so a wrapped header cell still matches its plain label.
function norm(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim().toLowerCase(); }

function previewRow(row, n = 15) {
  if (!row || !row.length) return "(empty row)";
  return row.slice(0, n).map(c => JSON.stringify(String(c == null ? "" : c))).join(", ");
}

// Find the column index of a header cell in `headerRow` matching `label`
// (case-insensitive). `mode` "exact" requires an exact match; "contains"
// matches if the cell contains the label as a substring. `exclude`, if set,
// skips cells that contain that substring (used to dodge "...whole month"
// variants of a similarly-named column).
function findCol(headerRow, label, { mode = "exact", exclude = null, from = 0 } = {}) {
  const target = norm(label);
  for (let i = from; i < headerRow.length; i++) {
    const cell = norm(headerRow[i]);
    if (exclude && cell.includes(norm(exclude))) continue;
    if (mode === "exact" ? cell === target : cell.includes(target)) return i;
  }
  return -1;
}

function requireCol(headerRow, label, opts, sheetLabel) {
  const idx = findCol(headerRow, label, opts);
  if (idx === -1) {
    throw new Error(
      `Could not find column "${label}" in "${sheetLabel}". ` +
      `Header row I searched: [${previewRow(headerRow)}]`
    );
  }
  return idx;
}

// The sheet may have a title/banner row above the real header row, a leading
// blank row, or a second table stacked well below the first one with its
// own header row further down — so scan from `from` through the whole
// sheet for a row that contains ALL of the given labels, rather than
// assuming row 0 is it or that every block shares one header row.
function locateHeaderRow(rows, labels, sheetLabel, { from = 0 } = {}) {
  for (let r = from; r < rows.length; r++) {
    const ok = labels.every(l => findCol(rows[r], l, { mode: "contains" }) !== -1);
    if (ok) return r;
  }
  throw new Error(
    `Could not find a header row containing all of [${labels.join(", ")}] ` +
    `in "${sheetLabel}" anywhere from row ${from + 1} onward (${rows.length} rows total). ` +
    `Row ${from + 1} looks like: [${previewRow(rows[from])}]` +
    (rows[from + 1] ? ` — Row ${from + 2} looks like: [${previewRow(rows[from + 1])}]` : "")
  );
}

// Fetches a sheet and confirms it actually contains the labels we expect
// before trusting it — Google's gviz endpoint has, on occasion, returned a
// different sheet's data for a name-based request. Retries with a fresh,
// cache-busted request a couple of times before giving up, since that kind
// of mismatch has so far looked transient rather than a real rename.
async function getValidatedSheet(sheetName, requiredLabels, sheetLabel, attempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const rows = await fetchSheetCsv(sheetName, attempt > 1 ? `${Date.now()}-${attempt}` : undefined);
      const headerRowIdx = locateHeaderRow(rows, requiredLabels, sheetLabel);
      return { rows, headerRowIdx };
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) await sleep(1200);
    }
  }
  throw lastErr;
}

// Fetches a tab by its numeric gid rather than its name. A gid never changes
// even when someone renames the tab (which has already happened once to the
// Free Gift table), so this is the preferred lookup for any sheet whose gid
// we know.
async function fetchSheetCsvByGid(gid, bust) {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&gid=${gid}` +
    (bust ? `&_=${bust}` : "");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed for gid ${gid}: HTTP ${res.status}`);
  const text = await res.text();
  if (!text || text.length < 5) throw new Error(`Sheet gid ${gid} came back empty`);
  return parseCsv(text);
}

async function getValidatedSheetByGid(gid, requiredLabels, sheetLabel, attempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const rows = await fetchSheetCsvByGid(gid, attempt > 1 ? `${Date.now()}-${attempt}` : undefined);
      const headerRowIdx = locateHeaderRow(rows, requiredLabels, sheetLabel);
      return { rows, headerRowIdx };
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) await sleep(1200);
    }
  }
  throw lastErr;
}

function esc(s) { return String(s == null ? "" : s).trim(); }

// JSON.stringify keeps non-ASCII characters (₱, curly quotes, an agent's
// accented name, etc.) as literal UTF-8 bytes in the output. That's fine for
// this script's own commit — Node writes the file as UTF-8 and git preserves
// it exactly — but index.html also gets hand-pasted into GitHub's web editor
// from time to time, and that copy/paste path has, in practice, mangled
// multi-byte characters into mojibake. \u-escaping every non-ASCII character
// here keeps the generated source pure ASCII, so it survives a copy/paste
// unchanged no matter what happens on the clipboard.
function jsEscapeNonAscii(s) {
  return s.replace(/[\u0080-￿]/g, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}
function jstr(s) { return jsEscapeNonAscii(JSON.stringify(esc(s))); }

// ---------- Ranking / Score ----------
async function buildRanking() {
  const sheetLabel = "Ranking/Score";
  const { rows, headerRowIdx } = await getValidatedSheetByGid(
    GID_RANKING, ["AGENT NAME", "Weekly Score", "TOTAL SCORE", "Ranking"], sheetLabel
  );
  const header = rows[headerRowIdx];
  const agentCol = requireCol(header, "AGENT NAME", {}, sheetLabel);
  const scoreCol = requireCol(header, "Weekly Score", {}, sheetLabel);
  const convCol = requireCol(header, "Conversion %", { mode: "contains" }, sheetLabel);
  const totalCol = requireCol(header, "TOTAL SCORE", {}, sheetLabel);
  const rankCol = requireCol(header, "Ranking", {}, sheetLabel);

  const entries = [];
  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const agent = esc(r[agentCol]);
    if (!agent) continue;
    const score = Number(esc(r[scoreCol]).replace(/[^0-9.\-]/g, ""));
    const total = Number(esc(r[totalCol]).replace(/[^0-9.\-]/g, ""));
    const rank = Number(esc(r[rankCol]).replace(/[^0-9.\-]/g, ""));
    if (!Number.isFinite(score) || !Number.isFinite(total) || !Number.isFinite(rank)) continue;
    entries.push({ agent, score, conv: esc(r[convCol]), total, rank });
  }
  if (entries.length < 3) throw new Error(`${sheetLabel}: fewer than 3 valid rows parsed — refusing to publish.`);

  const body = entries
    .map(e => `  {agent:${jstr(e.agent)},score:${e.score},conv:${jstr(e.conv)},total:${e.total},rank:${e.rank}}`)
    .join(",\n");
  return `var RANKING = [\n${body}\n].sort(function(a,b){return a.rank-b.rank;});`;
}

// ---------- Performance Update ----------
async function buildPerf(existingAugustLiteral) {
  const sheetLabel = "Performance Update";
  const { rows, headerRowIdx } = await getValidatedSheetByGid(
    GID_PERF, ["Agent", "Current MTD", "AVERAGE CHECK", "Calls Handled"], sheetLabel
  );
  const header = rows[headerRowIdx];
  const agentCol = requireCol(header, "Agent", {}, sheetLabel);
  const curCol = requireCol(header, "Current MTD", { mode: "contains" }, sheetLabel);
  const prevCol = requireCol(header, "Previous MTD", { mode: "contains" }, sheetLabel);
  const diffCol = requireCol(header, "Difference", { mode: "contains", exclude: "whole" }, sheetLabel);
  const pctCol = requireCol(header, "% Change", { mode: "contains", exclude: "whole" }, sheetLabel);
  const avgCol = requireCol(header, "AVERAGE CHECK", { mode: "exact" }, sheetLabel);
  const callsCol = requireCol(header, "Calls Handled", { mode: "contains", exclude: "previous" }, sheetLabel);
  const convCol = requireCol(header, "Conversion %", { mode: "contains", exclude: "previous" }, sheetLabel);

  const agentRows = [];
  let totalRow = null;
  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const agent = esc(r[agentCol]);
    if (!agent) continue;
    const rec = {
      a: agent,
      cur: Number(esc(r[curCol]).replace(/[^0-9.\-]/g, "")) || 0,
      prev: Number(esc(r[prevCol]).replace(/[^0-9.\-]/g, "")) || 0,
      diff: esc(r[diffCol]),
      pct: esc(r[pctCol]),
      avg: esc(r[avgCol]),
      calls: esc(r[callsCol]).replace(/"/g, ""),
      conv: esc(r[convCol]),
    };
    if (norm(agent).includes("total")) { totalRow = rec; totalRow.a = "Total"; continue; }
    agentRows.push(rec);
  }
  if (agentRows.length < 3) throw new Error(`${sheetLabel}: fewer than 3 valid agent rows parsed — refusing to publish.`);
  if (!totalRow) throw new Error(`${sheetLabel}: no row containing "total" found — refusing to publish.`);

  const rowsBody = agentRows
    .map(r => `    {a:${jstr(r.a)},cur:${r.cur},prev:${r.prev},diff:${jstr(r.diff)},pct:${jstr(r.pct)},avg:${jstr(r.avg)},calls:${jstr(r.calls)},conv:${jstr(r.conv)}}`)
    .join(",\n");
  const totalBody = `{cur:${totalRow.cur},prev:${totalRow.prev},diff:${jstr(totalRow.diff)},pct:${jstr(totalRow.pct)},avg:${jstr(totalRow.avg)},calls:${jstr(totalRow.calls)},conv:${jstr(totalRow.conv)}}`;

  return `var PERF = {\n  rows:[\n${rowsBody}\n  ],\n  total:${totalBody},\n  august:${existingAugustLiteral}\n};`;
}

// ---------- Day-off requests (now a block within Ranking/Score) ----------
// The old "Rules and Shift Request" tab (which used to hold the shift
// schedule and this day-off sign-up list) has been deleted from the sheet.
// The day-off sign-up list survives as a 5-column block — Name, Off 1,
// Off 2, Shift, Reason — living somewhere inside the Ranking/Score tab.
// Its exact row/column position has proven unreliable to pin down by
// inspection, so — as with the old stacked off-request table — this scans
// the whole sheet at run time for a row containing "Off 1" rather than
// trusting a hardcoded position.
async function buildDayOffRequests() {
  const sheetLabel = "Ranking/Score (day-off block)";
  const { rows, headerRowIdx } = await getValidatedSheetByGid(GID_RANKING, ["Off 1"], sheetLabel);
  const header = rows[headerRowIdx];
  const off1Col = requireCol(header, "Off 1", {}, sheetLabel);
  const nameCol = off1Col - 1;
  const off2Col = off1Col + 1;
  const shiftCol = off1Col + 2;
  const reasonCol = off1Col + 3;

  const offRequests = [];
  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const name = esc(r[nameCol]);
    if (!name) continue;
    offRequests.push({
      name,
      off1: esc(r[off1Col]),
      off2: esc(r[off2Col]),
      shift: esc(r[shiftCol]),
      reason: esc(r[reasonCol]),
    });
  }
  // Day-off requests are allowed to legitimately be empty (nobody asked this
  // week), so no minimum-count guard here — unlike the other blocks, zero is valid.

  const body = offRequests
    .map(o => `{"name":${jstr(o.name)},"off1":${jstr(o.off1)},"off2":${jstr(o.off2)},"shift":${jstr(o.shift)},"reason":${jstr(o.reason)},"added":false}`)
    .join(",");
  return `var DAYOFF_STATE = {"dayOffRequests":[${body}]};`;
}

// ---------- Free Gift and Pricing (formerly "Free Gift Table") ----------
async function buildGifts() {
  const sheetLabel = "Free Gift and Pricing";
  const { rows, headerRowIdx } = await getValidatedSheetByGid(
    GID_GIFTS, ["Product", "Male Gift", "Female Gift"], sheetLabel
  );
  // Use "contains" rather than an exact match here: this sheet's header
  // cells for this table have turned out to hold more than just the plain
  // label (e.g. "Product" arriving as "Product\nEasy Go Max", collapsed by
  // norm() to "product easy go max") — the same kind of wrapped/compound
  // header cell seen elsewhere in this sheet, just matched loosely instead
  // of assuming the exact text.
  const header = rows[headerRowIdx];
  const productCol = requireCol(header, "Product", { mode: "contains" }, sheetLabel);
  const maleCol = requireCol(header, "Male Gift", { mode: "contains" }, sheetLabel);
  const femaleCol = requireCol(header, "Female Gift", { mode: "contains" }, sheetLabel);

  const entries = [];
  const seen = new Set();
  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const product = esc(r[productCol]);
    if (!product) continue;
    // Guard against the header row's own compound text bleeding a duplicate
    // of the first product into the data range (belt-and-braces — harmless
    // if that never actually happens).
    const key = norm(product) + "|" + norm(r[maleCol]) + "|" + norm(r[femaleCol]);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push([product, esc(r[maleCol]), esc(r[femaleCol])]);
  }
  if (entries.length < 3) throw new Error(`${sheetLabel}: fewer than 3 rows parsed — refusing to publish.`);

  const body = entries.map(e => `  [${e.map(jstr).join(",")}]`).join(",\n");
  return `var GIFTS = [\n${body}\n];`;
}

function replaceBlock(html, markerName, newLiteral) {
  const start = `/*AUTO-${markerName}-START*/`;
  const end = `/*AUTO-${markerName}-END*/`;
  const startIdx = html.indexOf(start);
  const endIdx = html.indexOf(end);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(`Marker pair AUTO-${markerName} not found in ${FILE} — was it edited by hand?`);
  }
  const before = html.slice(0, startIdx + start.length);
  const after = html.slice(endIdx);
  return `${before}\n${newLiteral}\n${after}`;
}

async function main() {
  let html = readFileSync(FILE, "utf8");

  // Pull out whatever August/whole-month literal is currently in the file so
  // we can preserve it verbatim — that block isn't sourced from a reliably
  // parseable part of the sheet, so it's maintained by hand, not refreshed here.
  const augustMatch = html.match(/august:(\{[^}]*\})/);
  if (!augustMatch) throw new Error("Could not find existing 'august' block in PERF to preserve it.");
  const existingAugustLiteral = augustMatch[1];

  // Run every block and collect ALL problems in one pass (rather than
  // stopping at the first), so a single run — and a single round of fixes —
  // can surface everything that needs attention at once.
  const jobs = [
    { name: "Ranking", run: () => buildRanking() },
    { name: "Performance", run: () => buildPerf(existingAugustLiteral) },
    { name: "Free Gift table", run: () => buildGifts() },
    { name: "Day-off requests", run: () => buildDayOffRequests() },
  ];
  const results = await Promise.allSettled(jobs.map(j => j.run()));

  const failures = results
    .map((r, i) => ({ r, name: jobs[i].name }))
    .filter(x => x.r.status === "rejected");

  if (failures.length) {
    const summary = failures
      .map(f => `— ${f.name}: ${f.r.reason && f.r.reason.message ? f.r.reason.message : f.r.reason}`)
      .join("\n");
    throw new Error(`${failures.length} of ${jobs.length} block(s) failed to refresh:\n${summary}`);
  }

  const [rankingLiteral, perfLiteral, giftsLiteral, dayOffLiteral] = results.map(r => r.value);

  html = replaceBlock(html, "RANKING", rankingLiteral);
  html = replaceBlock(html, "PERF", perfLiteral);
  html = replaceBlock(html, "GIFTS", giftsLiteral);
  html = replaceBlock(html, "DAYOFF", dayOffLiteral);

  writeFileSync(FILE, html, "utf8");
  console.log("index.html refreshed successfully from the Google Sheet.");
}

main().catch(err => {
  console.error("Refresh aborted — index.html was NOT modified.");
  console.error(err.message || err);
  process.exit(1);
});
