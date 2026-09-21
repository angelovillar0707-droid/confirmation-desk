#!/usr/bin/env node
/**
 * Refreshes index.html's live-data blocks (Ranking, Performance, Shift schedule,
 * Day-off requests, Free Gift table) straight from the Google Sheet, and leaves
 * everything else (Redelivery reasons, Manual Callbacks, the two playbook
 * scripts, all styling/markup) untouched.
 *
 * Safety model: every value this script needs is located by searching the
 * sheet's own header text for a known label, never by a hardcoded column
 * number or row number. If a label can't be found, or a block comes back
 * empty, the script throws and exits non-zero WITHOUT touching index.html —
 * so a spreadsheet reorganization fails the GitHub Action run loudly instead
 * of silently publishing wrong data. On failure it also prints a preview of
 * the row it was looking at, so the fix is visible straight from the Action
 * log without needing to dig through the sheet by hand.
 */

import { readFileSync, writeFileSync } from "fs";

const SHEET_ID = "1NyWkYctFgVEX1q5v_v-XWqPfuw5YhylMfkA6sIfSvoA";
const FILE = "index.html";

async function fetchSheetCsv(sheetName) {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
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
// blank row, or (as it turns out for "Rules and Shift Request") a second
// table stacked well below the first one with its own header row further
// down — so scan from `from` through the whole sheet for a row that
// contains ALL of the given labels, rather than assuming row 0 is it or
// that every block shares one header row.
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

function esc(s) { return String(s == null ? "" : s).trim(); }
function jstr(s) { return JSON.stringify(esc(s)); }

// ---------- Ranking / Score ----------
async function buildRanking() {
  const rows = await fetchSheetCsv("Ranking/Score");
  const sheetLabel = "Ranking/Score";
  const headerRowIdx = locateHeaderRow(rows, ["AGENT NAME", "Weekly Score", "TOTAL SCORE", "Ranking"], sheetLabel);
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
  const rows = await fetchSheetCsv("Performance Update");
  const sheetLabel = "Performance Update";
  const headerRowIdx = locateHeaderRow(rows, ["Agent", "Current MTD", "AVERAGE CHECK", "Calls Handled"], sheetLabel);
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

// ---------- Rules and Shift Request (schedule + off-requests) ----------
async function buildScheduleAndOffRequests() {
  const rows = await fetchSheetCsv("Rules and Shift Request");
  const sheetLabel = "Rules and Shift Request";

  // The schedule table and the off-request table turn out to be stacked
  // (the off-request header is a separate row further down the sheet, not
  // side-by-side with the schedule header) — so each gets its own
  // independent header search rather than assuming they share one row.
  const scheduleHeaderIdx = locateHeaderRow(rows, ["Agent", "Mon"], sheetLabel);
  const header = rows[scheduleHeaderIdx];
  const agentCol = requireCol(header, "Agent", {}, sheetLabel);
  const monCol = requireCol(header, "Mon", {}, sheetLabel);
  const dayCols = [monCol, monCol + 1, monCol + 2, monCol + 3, monCol + 4, monCol + 5, monCol + 6];
  const rowNumCol = agentCol - 1; // sequential 1,2,3.. counter just before the Agent column

  const schedule = [];
  for (let i = scheduleHeaderIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const seq = esc(r[rowNumCol]);
    if (!/^[0-9]+$/.test(seq)) { if (schedule.length) break; else continue; }
    const agent = esc(r[agentCol]) || "—";
    const days = dayCols.map(c => esc(r[c]));
    schedule.push({ agent, days });
  }
  if (schedule.length < 5) throw new Error(`${sheetLabel}: fewer than 5 schedule rows parsed — refusing to publish.`);

  const offHeaderIdx = locateHeaderRow(rows, ["Off 1"], sheetLabel, { from: scheduleHeaderIdx + 1 });
  const offHeader = rows[offHeaderIdx];
  const off1Col = requireCol(offHeader, "Off 1", {}, sheetLabel);
  const nameCol = off1Col - 1;
  const off2Col = off1Col + 1;
  const shiftCol = off1Col + 2;
  const reasonCol = off1Col + 3;
  const offRowNumCol = nameCol - 1;

  const offRequests = [];
  for (let i = offHeaderIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const seq = esc(r[offRowNumCol]);
    if (!/^[0-9]+$/.test(seq)) continue;
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
  // Off-requests are allowed to legitimately be empty (nobody asked this week),
  // so no minimum-count guard here — unlike the other blocks, zero is valid.

  const scheduleBody = schedule
    .map(s => `  {agent:${jstr(s.agent)},days:[${s.days.map(jstr).join(",")}]}`)
    .join(",\n");
  const scheduleLiteral = `var SCHEDULE = [\n${scheduleBody}\n];`;

  const offBody = offRequests
    .map(o => `{"name":${jstr(o.name)},"off1":${jstr(o.off1)},"off2":${jstr(o.off2)},"shift":${jstr(o.shift)},"reason":${jstr(o.reason)},"added":false}`)
    .join(",");
  const stateLiteral = `var STATE = {"offRequests":[${offBody}]};`;

  return { scheduleLiteral, stateLiteral };
}

// ---------- Free Gift Table ----------
async function buildGifts() {
  const rows = await fetchSheetCsv("Free Gift Table");
  const sheetLabel = "Free Gift Table";
  const headerRowIdx = locateHeaderRow(rows, ["Product", "Male Gift", "Female Gift"], sheetLabel);
  const header = rows[headerRowIdx];
  const productCol = requireCol(header, "Product", {}, sheetLabel);
  const maleCol = requireCol(header, "Male Gift", {}, sheetLabel);
  const femaleCol = requireCol(header, "Female Gift", {}, sheetLabel);

  const entries = [];
  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const product = esc(r[productCol]);
    if (!product) continue;
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

  const [rankingLiteral, perfLiteral, giftsLiteral, scheduleAndOff] = await Promise.all([
    buildRanking(),
    buildPerf(existingAugustLiteral),
    buildGifts(),
    buildScheduleAndOffRequests(),
  ]);

  html = replaceBlock(html, "RANKING", rankingLiteral);
  html = replaceBlock(html, "PERF", perfLiteral);
  html = replaceBlock(html, "GIFTS", giftsLiteral);
  html = replaceBlock(html, "SCHEDULE", scheduleAndOff.scheduleLiteral);
  html = replaceBlock(html, "STATE", scheduleAndOff.stateLiteral);

  writeFileSync(FILE, html, "utf8");
  console.log("index.html refreshed successfully from the Google Sheet.");
}

main().catch(err => {
  console.error("Refresh aborted — index.html was NOT modified.");
  console.error(err.message || err);
  process.exit(1);
});
