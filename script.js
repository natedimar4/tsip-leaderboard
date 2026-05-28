// =============================================================================
// TSIP Leaderboard — script.js
// =============================================================================
// Reads task scores live from a Google Sheet, computes three leaderboards
// (Full Task, Rubric-Only, Combined), and lets admins overlay corrections and
// snapshot weekly archives via Firestore.

// -----------------------------------------------------------------------------
// CONSTANTS — paste your Firebase config below; everything else is set per spec.
// -----------------------------------------------------------------------------

// PASTE YOUR FIREBASE CONFIG INSIDE THIS OBJECT. The values below are pre-
// filled with the existing TSIP Leaderboard project; replace them only if you
// create a different Firebase project.
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyD2tw6FXHushbJrY9VThpK8S7da7EELSDk",
  authDomain:        "tsip-leaderboard.firebaseapp.com",
  projectId:         "tsip-leaderboard",
  storageBucket:     "tsip-leaderboard.firebasestorage.app",
  messagingSenderId: "941083332511",
  appId:             "1:941083332511:web:2531c94e08d2583cc9b7aa",
};

// Casual gate visible in page source — accept the tradeoff for an internal tool.
const ADMIN_PASSWORD = "Meridian_Admin_26";

// Starter sheet for first run. After that, meta.currentSheetId in Firestore wins.
const DEFAULT_SHEET_ID = "1QZMysinEzuYnZ9x9owNtbSTE840eanBBfeExy4JKo0A";

// Tab names (URL-encoded in the fetch URL — square brackets and spaces survive).
const FULL_TASK_TAB = "Full Task";
const RUBRIC_TAB    = "[RTF] Rubric-Only";

// Column indices. 0-indexed (so B=1, C=2, G=6, H=7, K=10, M=12, U=20, W=22).
const FULL = {
  name: 1, redo: 2, done: 10, dateDone: 12, redoDone: 20, secondRedoDone: 22,
};
const RUBRIC = {
  name: 1, redo: 2, done: 6,  dateDone: 7,  redoDone: 12,
};

const DROP_NAMES   = ["DO NOT CLAIM"];
const NAME_ALIASES = {};  // built-in static aliases; runtime aliases come from Firestore
const ASSUME_YEAR  = 2026;

// -----------------------------------------------------------------------------
// Firebase modular SDK v12.11.0 — ES module imports from official CDN.
// -----------------------------------------------------------------------------

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.11.0/firebase-app.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, deleteDoc,
  onSnapshot, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js";

// -----------------------------------------------------------------------------
// State.
// -----------------------------------------------------------------------------

const state = {
  fb: {
    app: null,
    db: null,
    status: "connecting", // "connecting" | "connected" | "error"
    error:  null,
  },
  sheet: {
    id: null,
    raw: null,             // { fullRows: [...rows], rubricRows: [...rows] }
    base: null,            // { fullTask: Map<key,stats>, rubric: Map<key,stats> }
    fetching: false,
    error: null,
    lastFetched: null,
  },
  meta:     null,
  overlays: {},   // { [personKey]: { displayName, fullTask: {completed?, redoCounter?}, rubric: {...}, addedByOverlayOnly, adjustments, updatedAt } }
  aliases:  {},   // { [sheetNameKey_lower]: { canonical, by, at } }
  archives: [],   // [{ id, rangeLabel, archivedAt, sourceSheetId }] (metadata only)
  archiveCache: {}, // { weekLabel: <full archive doc> }
  ui: {
    tab:  "combined",       // "combined" | "fullTask" | "rubric"
    view: "live",           // "live" | <archive doc id>
  },
  admin: {
    unlocked: false,
    name: sessionStorage.getItem("tsip_admin_name") || "",
  },
  charts: { board: null },
};

// -----------------------------------------------------------------------------
// Small helpers.
// -----------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

function showToast(msg, kind = "") {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "toast" + (kind ? " " + kind : "");
  t.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { t.hidden = true; }, 3200);
}

function openModal(id)  { const el = document.getElementById(id); if (el) el.hidden = false; }
function closeModal(id) { const el = document.getElementById(id); if (el) el.hidden = true;  }

document.addEventListener("click", (e) => {
  const closeId = e.target?.dataset?.close;
  if (closeId) closeModal(closeId);
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  ["overlay-edit-modal", "swap-modal", "history-modal", "password-modal", "admin-modal"].forEach((id) => {
    const el = document.getElementById(id);
    if (el && !el.hidden) closeModal(id);
  });
});

// -----------------------------------------------------------------------------
// CSV parser (handles quoted fields, embedded newlines, escaped quotes).
// -----------------------------------------------------------------------------

function parseCsv(text) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else q = false;
      } else cell += c;
    } else {
      if (c === '"') q = true;
      else if (c === ",") { row.push(cell); cell = ""; }
      else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
      else if (c === "\r") { /* skip */ }
      else cell += c;
    }
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function sheetCsvUrl(sheetId, tabName) {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tabName)}`;
}

// -----------------------------------------------------------------------------
// Name normalization, date parsing, truthy.
// -----------------------------------------------------------------------------

function normalizeNameRaw(raw) {
  if (raw === null || raw === undefined) return "";
  return String(raw).trim().replace(/\s+/g, " ");
}

function applyAlias(displayName) {
  if (!displayName) return null;
  const k = displayName.toLowerCase();
  // Runtime aliases (Firestore) win over built-in static aliases.
  if (state.aliases[k]?.canonical) return state.aliases[k].canonical;
  if (NAME_ALIASES[displayName])   return NAME_ALIASES[displayName];
  return displayName;
}

function nameKey(displayName) { return displayName ? displayName.toLowerCase() : null; }

function truthyFlag(v) {
  return String(v ?? "").trim().toUpperCase() === "TRUE";
}

// Parse "M/D", "M/D/YY", or "M/D/YYYY" → ISO "YYYY-MM-DD". Returns null if blank.
function normalizeDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (!m) return null;
  const month = parseInt(m[1], 10);
  const day   = parseInt(m[2], 10);
  let year;
  if (m[3]) {
    const y = parseInt(m[3], 10);
    year = y < 100 ? 2000 + y : y;
  } else {
    year = ASSUME_YEAR;
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// -----------------------------------------------------------------------------
// Firebase init + status pill.
// -----------------------------------------------------------------------------

function setStatus(status, err) {
  state.fb.status = status;
  state.fb.error  = err?.message || null;
  renderStatus();
}

function renderStatus() {
  const pill = document.getElementById("fb-status");
  if (!pill) return;
  pill.className = "status-pill status-" + state.fb.status;
  pill.textContent = ({
    connecting: "Firebase: connecting…",
    connected:  "Firebase: connected",
    error:      "Firebase: not connected",
  })[state.fb.status];
  pill.title = state.fb.status === "error"
    ? "Click to see the error" + (state.fb.error ? "\n\n" + state.fb.error : "")
    : "";

  // Gate the Admin link when Firebase is down.
  const adminLink = document.getElementById("admin-link");
  if (adminLink) {
    if (state.fb.status === "error") {
      adminLink.disabled = true;
      adminLink.textContent = "Admin (unavailable)";
      adminLink.title = "Admin features unavailable — Firebase not connected";
    } else {
      adminLink.disabled = false;
      adminLink.textContent = "Admin";
      adminLink.title = "";
    }
  }
}

document.addEventListener("click", (e) => {
  if (e.target?.id === "fb-status" && state.fb.status === "error") {
    alert("Firebase didn't connect:\n\n" + (state.fb.error || "(no error message)"));
  }
});

function initFirebase() {
  try {
    state.fb.app = initializeApp(FIREBASE_CONFIG);
    state.fb.db  = getFirestore(state.fb.app);
    setStatus("connecting");
  } catch (err) {
    console.error("[Firebase] init threw:", err);
    setStatus("error", err);
  }
}

async function probeFirebase() {
  if (!state.fb.db) return;
  try {
    const snap = await getDoc(doc(state.fb.db, "meta", "site"));
    if (snap.exists()) {
      state.meta = snap.data();
      console.log("[Firebase] connected, meta doc found");
    } else {
      console.log("[Firebase] connected, no meta doc yet (first run)");
      const seed = { currentSheetId: DEFAULT_SHEET_ID, schemaVersion: 1, updatedAt: serverTimestamp() };
      await setDoc(doc(state.fb.db, "meta", "site"), seed);
      state.meta = { currentSheetId: DEFAULT_SHEET_ID, schemaVersion: 1 };
    }
    setStatus("connected");
  } catch (err) {
    console.error("[Firebase] CONNECTION FAILED:", err);
    setStatus("error", err);
  }
}

// -----------------------------------------------------------------------------
// Sheet fetch.
// -----------------------------------------------------------------------------

async function fetchTab(sheetId, tabName) {
  const res = await fetch(sheetCsvUrl(sheetId, tabName));
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching tab "${tabName}". Make sure the sheet is shared "Anyone with the link can view".`);
  }
  return await res.text();
}

async function loadSheet(sheetId) {
  if (!sheetId) return;
  state.sheet.id = sheetId;
  state.sheet.fetching = true;
  state.sheet.error = null;
  renderFetchState();
  try {
    const [fullCsv, rubricCsv] = await Promise.all([
      fetchTab(sheetId, FULL_TASK_TAB),
      fetchTab(sheetId, RUBRIC_TAB),
    ]);
    const fullRows   = parseCsv(fullCsv).slice(1);   // drop header row
    const rubricRows = parseCsv(rubricCsv).slice(1);
    state.sheet.raw  = { fullRows, rubricRows };
    state.sheet.base = {
      fullTask: scoreRows(fullRows,   FULL,   "fullTask"),
      rubric:   scoreRows(rubricRows, RUBRIC, "rubric"),
    };
    state.sheet.lastFetched = new Date();
    state.sheet.error = null;
    logScores(state.sheet.base);
  } catch (err) {
    console.error("[sheet] fetch failed:", err);
    state.sheet.error = err.message;
  } finally {
    state.sheet.fetching = false;
    renderAll();
  }
}

// -----------------------------------------------------------------------------
// Scoring — one row = one task, per spec.
//   completed       = # rows where Done? is TRUE
//   outstandingRedo = # rows where C=REDO AND redoDone != TRUE
//   redoCounter     = # rows where C=REDO (+ second-redo bumps for Full Task)
//   netScore        = max(0, completed - outstandingRedo)
// -----------------------------------------------------------------------------

function scoreRows(rows, cfg, tabKey) {
  const buckets = new Map();
  for (const row of rows) {
    if (!row || !row.length) continue;
    const rawName = (row[cfg.name] || "").trim();
    if (!rawName) continue;
    const aliased = applyAlias(normalizeNameRaw(rawName));
    if (!aliased) continue;
    if (DROP_NAMES.some((d) => d.toLowerCase() === aliased.toLowerCase())) continue;

    const k = nameKey(aliased);
    let b = buckets.get(k);
    if (!b) {
      b = {
        displayName: aliased,
        completed: 0, outstandingRedo: 0, redoCounter: 0,
        rows: [],
      };
      buckets.set(k, b);
    }
    const done       = truthyFlag(row[cfg.done]);
    const isRedo     = (row[cfg.redo] || "").trim().toUpperCase() === "REDO";
    const redoDone   = truthyFlag(row[cfg.redoDone]);
    const secondDone = cfg.secondRedoDone !== undefined && truthyFlag(row[cfg.secondRedoDone]);

    if (done) b.completed++;
    if (isRedo && !redoDone) b.outstandingRedo++;
    if (isRedo) b.redoCounter++;
    if (secondDone) b.redoCounter++;

    b.rows.push({
      taskId: (row[0] || "").trim().slice(0, 8),
      date:   normalizeDate(row[cfg.dateDone]) || (row[cfg.dateDone] || "").trim() || null,
      done, isRedo, redoDone, secondRedoDone: secondDone,
    });
  }
  return buckets;
}

function logScores(base) {
  console.groupCollapsed("[scoring] Full Task");
  for (const [, v] of base.fullTask) {
    console.log(`  ${v.displayName}: completed=${v.completed}, outstanding=${v.outstandingRedo}, net=${Math.max(0, v.completed - v.outstandingRedo)}, redoCounter=${v.redoCounter}`);
  }
  console.groupEnd();
  console.groupCollapsed("[scoring] Rubric-Only");
  for (const [, v] of base.rubric) {
    console.log(`  ${v.displayName}: completed=${v.completed}, outstanding=${v.outstandingRedo}, net=${Math.max(0, v.completed - v.outstandingRedo)}, redoCounter=${v.redoCounter}`);
  }
  console.groupEnd();
}

// Rescore (used when aliases change).
function rescore() {
  if (!state.sheet.raw) return;
  state.sheet.base = {
    fullTask: scoreRows(state.sheet.raw.fullRows,   FULL,   "fullTask"),
    rubric:   scoreRows(state.sheet.raw.rubricRows, RUBRIC, "rubric"),
  };
}

// -----------------------------------------------------------------------------
// Apply overlays.
// -----------------------------------------------------------------------------

function applyOverlaysToBoard(baseMap, tabKey) {
  const final = new Map();
  // Pass 1: every person in the base map, optionally overlaid.
  for (const [k, b] of baseMap) {
    const ov = state.overlays[k] || null;
    const ovTab = ov?.[tabKey] || {};
    const displayName = ov?.displayName || b.displayName;
    const completed   = (ovTab.completed   !== undefined && ovTab.completed   !== null) ? ovTab.completed   : b.completed;
    const redoCounter = (ovTab.redoCounter !== undefined && ovTab.redoCounter !== null) ? ovTab.redoCounter : b.redoCounter;
    final.set(k, {
      displayName, completed, redoCounter,
      outstandingRedo: b.outstandingRedo,
      baseCompleted: b.completed, baseRedoCounter: b.redoCounter,
      hasCompletedOverlay: ovTab.completed   !== undefined && ovTab.completed   !== null,
      hasRedoOverlay:      ovTab.redoCounter !== undefined && ovTab.redoCounter !== null,
      netScore: Math.max(0, completed - b.outstandingRedo),
      rows: b.rows,
      adjustments: ov?.adjustments || [],
    });
  }
  // Pass 2: overlay-only people not in the base sheet.
  for (const [k, ov] of Object.entries(state.overlays)) {
    if (final.has(k)) continue;
    if (!ov.addedByOverlayOnly) continue;
    const ovTab = ov[tabKey] || {};
    const completed   = ovTab.completed   ?? 0;
    const redoCounter = ovTab.redoCounter ?? 0;
    final.set(k, {
      displayName: ov.displayName,
      completed, redoCounter,
      outstandingRedo: 0,
      baseCompleted: 0, baseRedoCounter: 0,
      hasCompletedOverlay: ovTab.completed   !== undefined,
      hasRedoOverlay:      ovTab.redoCounter !== undefined,
      netScore: Math.max(0, completed),
      rows: [],
      adjustments: ov.adjustments || [],
    });
  }
  return final;
}

function combineBoards(fullMap, rubricMap) {
  const keys = new Set([...fullMap.keys(), ...rubricMap.keys()]);
  const out = new Map();
  for (const k of keys) {
    const f = fullMap.get(k);
    const r = rubricMap.get(k);
    out.set(k, {
      displayName: f?.displayName || r?.displayName || k,
      fullTaskNet:    f?.netScore    || 0,
      rubricNet:      r?.netScore    || 0,
      fullTaskRedos:  f?.redoCounter || 0,
      rubricRedos:    r?.redoCounter || 0,
      totalRedos:    (f?.redoCounter || 0) + (r?.redoCounter || 0),
      score:         (f?.netScore || 0) + (r?.netScore || 0),
    });
  }
  return out;
}

function deriveFinalBoards() {
  if (!state.sheet.base) return { fullTask: new Map(), rubric: new Map(), combined: new Map() };
  const fullFinal   = applyOverlaysToBoard(state.sheet.base.fullTask, "fullTask");
  const rubricFinal = applyOverlaysToBoard(state.sheet.base.rubric,   "rubric");
  const combined    = combineBoards(fullFinal, rubricFinal);
  return { fullTask: fullFinal, rubric: rubricFinal, combined };
}

// -----------------------------------------------------------------------------
// Render — top-level.
// -----------------------------------------------------------------------------

function renderAll() {
  renderStatus();
  renderFetchState();
  renderWeekSelector();
  renderTabHeaders();
  renderBoardAndChart();
  if (state.admin.unlocked) {
    renderAdminPanel();
  }
}

function renderFetchState() {
  const banner = document.getElementById("loading-banner");
  if (!banner) return;
  if (state.sheet.fetching) {
    banner.textContent = "Fetching claim sheet…";
    banner.className = "banner banner-info";
    banner.hidden = false;
  } else if (state.sheet.error) {
    banner.textContent = "Couldn't load the claim sheet — " + state.sheet.error;
    banner.className = "banner banner-error";
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
  const lu = document.getElementById("last-updated");
  if (lu) {
    lu.textContent = state.sheet.lastFetched
      ? "Updated " + state.sheet.lastFetched.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : "";
  }
}

function renderWeekSelector() {
  const sel = document.getElementById("week-select");
  if (!sel) return;
  const opts = [`<option value="live">Current (live)</option>`];
  for (const a of state.archives) {
    opts.push(`<option value="${escapeAttr(a.id)}">${escapeHtml(a.rangeLabel || a.id)}</option>`);
  }
  const desired = state.ui.view;
  sel.innerHTML = opts.join("");
  sel.value = desired === "live" ? "live" : (state.archives.some((a) => a.id === desired) ? desired : "live");
  if (sel.value !== desired) state.ui.view = sel.value;
}

function renderTabHeaders() {
  for (const t of ["combined", "fullTask", "rubric"]) {
    const btn = document.getElementById("tab-" + t);
    if (btn) {
      const active = state.ui.tab === t;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    }
  }
  const label = ({ combined: "Combined", fullTask: "Full Task", rubric: "Rubric-Only" })[state.ui.tab];
  document.getElementById("chart-title").textContent = "Top 5 — " + label;
  document.getElementById("board-title").textContent = "Full leaderboard — " + label;
  document.getElementById("th-score").textContent = state.ui.tab === "combined" ? "Score" : "Net score";
  document.getElementById("th-redos").textContent = "Redos";
}

// -----------------------------------------------------------------------------
// Render board + chart for the active tab + view.
// -----------------------------------------------------------------------------

function renderBoardAndChart() {
  if (state.ui.view === "live") {
    const boards = deriveFinalBoards();
    const rows = rowsForBoard(state.ui.tab, boards);
    renderLeaderboardRows(rows, false);
    renderChart(rows);
  } else {
    const archive = state.archiveCache[state.ui.view];
    if (!archive) {
      // Trigger load
      loadArchive(state.ui.view);
      const tbody = document.getElementById("leaderboard-tbody");
      tbody.innerHTML = `<tr><td colspan="4" class="muted center">Loading archive…</td></tr>`;
      destroyChart();
      return;
    }
    const archived = archive.boards?.[state.ui.tab] || [];
    renderArchiveRows(archived);
    renderArchiveChart(archived);
  }
}

function rowsForBoard(tab, boards) {
  let rows;
  if (tab === "combined") {
    rows = [...boards.combined.values()];
    rows.sort((a, b) => (b.score - a.score) || a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }));
  } else {
    rows = [...boards[tab].values()];
    rows.sort((a, b) => (b.netScore - a.netScore) || a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }));
  }
  rows.forEach((r, i) => { r.rank = i + 1; });
  return rows;
}

function renderLeaderboardRows(rows, archived) {
  const tbody = document.getElementById("leaderboard-tbody");
  const overlayLegend = document.getElementById("overlay-legend");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted center">No contributors yet.</td></tr>`;
    if (overlayLegend) overlayLegend.hidden = true;
    return;
  }
  let anyOverlay = false;
  if (state.ui.tab === "combined") {
    tbody.innerHTML = rows.map((r) => `
      <tr>
        <td class="col-rank">${r.rank}</td>
        <td class="col-name"><button class="name-link" data-history="${escapeAttr(r.displayName)}">${escapeHtml(r.displayName)}</button></td>
        <td class="col-count">${r.score}</td>
        <td class="col-redo">${r.totalRedos}</td>
      </tr>
    `).join("");
  } else {
    tbody.innerHTML = rows.map((r) => {
      if (r.hasCompletedOverlay || r.hasRedoOverlay) anyOverlay = true;
      const ovScore = r.hasCompletedOverlay ? ' <span class="overlay-mark" title="Overlay applied">&bull;</span>' : "";
      const ovRedo  = r.hasRedoOverlay      ? ' <span class="overlay-mark" title="Overlay applied">&bull;</span>' : "";
      return `
        <tr>
          <td class="col-rank">${r.rank}</td>
          <td class="col-name"><button class="name-link" data-history="${escapeAttr(r.displayName)}">${escapeHtml(r.displayName)}</button></td>
          <td class="col-count">${r.netScore}${ovScore}</td>
          <td class="col-redo">${r.redoCounter}${ovRedo}</td>
        </tr>
      `;
    }).join("");
  }
  if (overlayLegend) overlayLegend.hidden = !anyOverlay;

  tbody.querySelectorAll("[data-history]").forEach((btn) => {
    btn.addEventListener("click", () => openHistory(btn.dataset.history));
  });
}

function renderArchiveRows(archivedRows) {
  const tbody = document.getElementById("leaderboard-tbody");
  if (!archivedRows.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted center">No contributors in this archive.</td></tr>`;
    return;
  }
  if (state.ui.tab === "combined") {
    tbody.innerHTML = archivedRows.map((r) => `
      <tr>
        <td class="col-rank">${r.rank}</td>
        <td class="col-name"><button class="name-link" data-archived-name="${escapeAttr(r.name)}">${escapeHtml(r.name)}</button></td>
        <td class="col-count">${r.score}</td>
        <td class="col-redo">${r.totalRedos}</td>
      </tr>
    `).join("");
  } else {
    tbody.innerHTML = archivedRows.map((r) => `
      <tr>
        <td class="col-rank">${r.rank}</td>
        <td class="col-name"><button class="name-link" data-archived-name="${escapeAttr(r.name)}">${escapeHtml(r.name)}</button></td>
        <td class="col-count">${r.netScore}</td>
        <td class="col-redo">${r.redoCounter}</td>
      </tr>
    `).join("");
  }
  tbody.querySelectorAll("[data-archived-name]").forEach((btn) => {
    btn.addEventListener("click", () => openArchiveHistory(btn.dataset.archivedName));
  });
}

// -----------------------------------------------------------------------------
// Chart.
// -----------------------------------------------------------------------------

function destroyChart() {
  if (state.charts.board) { state.charts.board.destroy(); state.charts.board = null; }
}

function renderChart(rows) {
  const top = rows.slice(0, 5);
  const labels = top.map((r) => r.displayName);
  const values = top.map((r) => state.ui.tab === "combined" ? r.score : r.netScore);
  drawBarChart(labels, values);
}

function renderArchiveChart(archivedRows) {
  const top = archivedRows.slice(0, 5);
  const labels = top.map((r) => r.name);
  const values = top.map((r) => state.ui.tab === "combined" ? r.score : r.netScore);
  drawBarChart(labels, values);
}

function drawBarChart(labels, values) {
  const empty = !labels.length || values.every((v) => v === 0);
  const emptyEl = document.getElementById("chart-empty");
  emptyEl.hidden = !empty;
  const ctx = document.getElementById("board-chart").getContext("2d");
  destroyChart();
  if (empty) return;
  state.charts.board = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: getComputedStyle(document.documentElement).getPropertyValue("--bar").trim() || "#4a6cf7",
        borderRadius: 4,
        maxBarThickness: 30,
      }],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend:  { display: false },
        tooltip: { callbacks: { label: (c) => String(c.parsed.x) } },
      },
      scales: {
        x: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: "rgba(0,0,0,0.05)" } },
        y: { grid: { display: false }, ticks: { font: { size: 13 } } },
      },
      animation: { duration: 220 },
    },
    plugins: [{
      id: "barLabels",
      afterDatasetsDraw(chart) {
        const { ctx, data } = chart;
        ctx.save();
        ctx.font = "600 12px " + getComputedStyle(document.body).fontFamily;
        ctx.fillStyle = "#1b1f2a";
        ctx.textBaseline = "middle";
        data.datasets[0].data.forEach((val, i) => {
          const bar = chart.getDatasetMeta(0).data[i];
          if (!bar) return;
          ctx.fillText(String(val), bar.x + 6, bar.y);
        });
        ctx.restore();
      },
    }],
  });
}

// -----------------------------------------------------------------------------
// History modal — live and archived flavours.
// -----------------------------------------------------------------------------

function openHistory(displayName) {
  const k = nameKey(displayName);
  const boards = deriveFinalBoards();
  const f = boards.fullTask.get(k);
  const r = boards.rubric.get(k);
  const c = boards.combined.get(k);

  const ovInfo = state.overlays[k] || null;
  const adjustments = ovInfo?.adjustments || [];

  const sectionFor = (label, stats, isFull) => {
    if (!stats) return "";
    const ovStar = (b) => b ? ' <span class="overlay-mark" title="Overlay applied">&bull;</span>' : "";
    const sampleRows = (stats.rows || []).slice(0, 12);
    return `
      <div class="history-section">
        <div class="history-section-head">
          <span>${escapeHtml(label)}</span>
          <span class="total">Net ${stats.netScore} · Redos ${stats.redoCounter}</span>
        </div>
        <table>
          <thead>
            <tr><th>Field</th><th>Live</th><th>After overlay</th></tr>
          </thead>
          <tbody>
            <tr><td>Completed</td><td>${stats.baseCompleted}</td><td>${stats.completed}${ovStar(stats.hasCompletedOverlay)}</td></tr>
            <tr><td>Outstanding redos</td><td>${stats.outstandingRedo}</td><td>${stats.outstandingRedo}</td></tr>
            <tr><td>Net score</td><td>${Math.max(0, stats.baseCompleted - stats.outstandingRedo)}</td><td>${stats.netScore}</td></tr>
            <tr><td>Redo counter</td><td>${stats.baseRedoCounter}</td><td>${stats.redoCounter}${ovStar(stats.hasRedoOverlay)}</td></tr>
          </tbody>
        </table>
        ${sampleRows.length ? `
          <table>
            <thead>
              <tr><th>Task</th><th>Date</th><th>Done</th><th>Redo</th><th>Re-Do done</th>${isFull ? "<th>2nd redo done</th>" : ""}</tr>
            </thead>
            <tbody>
              ${sampleRows.map((row) => `
                <tr>
                  <td>${escapeHtml(row.taskId || "—")}</td>
                  <td>${escapeHtml(row.date || "—")}</td>
                  <td>${row.done ? "✓" : "·"}</td>
                  <td>${row.isRedo ? "REDO" : ""}</td>
                  <td>${row.redoDone ? "✓" : (row.isRedo ? "·" : "")}</td>
                  ${isFull ? `<td>${row.secondRedoDone ? "✓" : ""}</td>` : ""}
                </tr>
              `).join("")}
            </tbody>
          </table>
          ${stats.rows.length > sampleRows.length ? `<p class="muted small" style="margin:6px 12px">…and ${stats.rows.length - sampleRows.length} more rows.</p>` : ""}
        ` : ""}
      </div>
    `;
  };

  const combinedHtml = c ? `
    <div class="history-section">
      <div class="history-section-head">
        <span>Combined</span>
        <span class="total">Score ${c.score} · Redos ${c.totalRedos}</span>
      </div>
      <table>
        <thead><tr><th>Source</th><th>Net</th><th>Redos</th></tr></thead>
        <tbody>
          <tr><td>Full Task</td><td>${c.fullTaskNet}</td><td>${c.fullTaskRedos}</td></tr>
          <tr><td>Rubric-Only</td><td>${c.rubricNet}</td><td>${c.rubricRedos}</td></tr>
        </tbody>
      </table>
    </div>
  ` : "";

  const adjHtml = adjustments.length ? `
    <div class="history-section">
      <div class="history-section-head"><span>Admin adjustments</span><span class="total muted">${adjustments.length}</span></div>
      <ul class="adj-list" style="margin:8px 12px">
        ${adjustments.slice().reverse().map((a) => `
          <li>
            ${escapeHtml(a.board)}.${escapeHtml(a.field)}:
            ${escapeHtml(String(a.from ?? "—"))} → ${escapeHtml(String(a.to ?? "—"))}
            <span class="muted">by ${escapeHtml(a.by || "—")}${a.at?.seconds ? " on " + new Date(a.at.seconds * 1000).toLocaleString() : ""}</span>
          </li>
        `).join("")}
      </ul>
    </div>
  ` : "";

  const body = combinedHtml
    + sectionFor("Full Task",   f, true)
    + sectionFor("Rubric-Only", r, false)
    + adjHtml;

  document.getElementById("history-name").textContent = displayName;
  document.getElementById("history-body").innerHTML = body || `<p class="muted">No data for this person.</p>`;
  openModal("history-modal");
}

function openArchiveHistory(name) {
  const archive = state.archiveCache[state.ui.view];
  if (!archive) return;
  const ph = (archive.perPersonHistory || {})[nameKey(name)];
  const html = ph
    ? `
      <p class="muted small">From archived snapshot — read only.</p>
      <pre class="log">${escapeHtml(JSON.stringify(ph, null, 2))}</pre>
    `
    : `<p class="muted">No detailed history stored for this person in this archive.</p>`;
  document.getElementById("history-name").textContent = name;
  document.getElementById("history-body").innerHTML = html;
  openModal("history-modal");
}

// -----------------------------------------------------------------------------
// Listeners — Firestore real-time subscriptions.
// -----------------------------------------------------------------------------

function startListeners() {
  if (state.fb.status === "error" || !state.fb.db) return;
  const db = state.fb.db;

  onSnapshot(doc(db, "meta", "site"), (snap) => {
    if (!snap.exists()) return;
    const m = snap.data();
    const sheetChanged = state.meta?.currentSheetId !== m.currentSheetId;
    state.meta = m;
    const sheetIdEl = document.getElementById("current-sheet-id");
    if (sheetIdEl) sheetIdEl.textContent = m.currentSheetId || "—";
    if (sheetChanged && m.currentSheetId) loadSheet(m.currentSheetId);
  }, (err) => console.error("[meta listener]", err));

  onSnapshot(collection(db, "overlays"), (snap) => {
    const next = {};
    snap.forEach((d) => { next[d.id] = d.data(); });
    state.overlays = next;
    renderAll();
  }, (err) => console.error("[overlays listener]", err));

  onSnapshot(collection(db, "aliases"), (snap) => {
    const next = {};
    snap.forEach((d) => { next[d.id] = d.data(); });
    state.aliases = next;
    rescore();
    renderAll();
  }, (err) => console.error("[aliases listener]", err));

  onSnapshot(collection(db, "archives"), (snap) => {
    const arr = [];
    snap.forEach((d) => { arr.push({ id: d.id, ...d.data() }); });
    arr.sort((a, b) => (b.archivedAt?.seconds || 0) - (a.archivedAt?.seconds || 0));
    state.archives = arr;
    renderWeekSelector();
  }, (err) => console.error("[archives listener]", err));
}

async function loadArchive(weekLabel) {
  if (state.archiveCache[weekLabel]) return state.archiveCache[weekLabel];
  if (!state.fb.db) return null;
  try {
    const snap = await getDoc(doc(state.fb.db, "archives", weekLabel));
    if (snap.exists()) {
      state.archiveCache[weekLabel] = snap.data();
      renderBoardAndChart();
      return state.archiveCache[weekLabel];
    }
  } catch (err) {
    console.error("[archive load]", err);
    showToast("Couldn't load that archive.", "error");
  }
  return null;
}

// -----------------------------------------------------------------------------
// Event wiring.
// -----------------------------------------------------------------------------

function attachEvents() {
  // Tabs
  for (const t of ["combined", "fullTask", "rubric"]) {
    document.getElementById("tab-" + t).addEventListener("click", () => {
      state.ui.tab = t;
      renderTabHeaders();
      renderBoardAndChart();
    });
  }
  // Week selector
  document.getElementById("week-select").addEventListener("change", (e) => {
    state.ui.view = e.target.value;
    renderBoardAndChart();
  });
  // Refresh
  document.getElementById("refresh-btn").addEventListener("click", () => {
    const sheetId = state.meta?.currentSheetId || DEFAULT_SHEET_ID;
    loadSheet(sheetId);
  });
  // Admin link
  document.getElementById("admin-link").addEventListener("click", openAdminGate);
  // Admin name change
  document.getElementById("change-admin-name").addEventListener("click", changeAdminName);
  // Password form
  document.getElementById("password-form").addEventListener("submit", onPasswordSubmit);
  // Add-person form
  document.getElementById("add-person-form").addEventListener("submit", onAddPersonSubmit);
  // Alias form
  document.getElementById("alias-form").addEventListener("submit", onAliasSubmit);
  // Overlay edit
  document.getElementById("overlay-edit-form").addEventListener("submit", onOverlayEditSubmit);
  document.getElementById("overlay-clear-all").addEventListener("click", onOverlayClearAll);
  // Swap week
  document.getElementById("swap-week-btn").addEventListener("click", () => {
    document.getElementById("swap-error").hidden = true;
    document.getElementById("swap-url").value = "";
    document.getElementById("swap-label").value = guessRangeLabel();
    openModal("swap-modal");
  });
  document.getElementById("swap-form").addEventListener("submit", onSwapSubmit);
}

// -----------------------------------------------------------------------------
// Admin: gate + name.
// -----------------------------------------------------------------------------

function openAdminGate() {
  if (state.fb.status === "error") {
    showToast("Firebase not connected — admin unavailable.", "error");
    return;
  }
  if (state.admin.unlocked) { openAdmin(); return; }
  document.getElementById("password-error").hidden = true;
  document.getElementById("password-input").value = "";
  openModal("password-modal");
  setTimeout(() => document.getElementById("password-input").focus(), 60);
}

function onPasswordSubmit(ev) {
  ev.preventDefault();
  const val = document.getElementById("password-input").value;
  if (val === ADMIN_PASSWORD) {
    state.admin.unlocked = true;
    closeModal("password-modal");
    openAdmin();
  } else {
    document.getElementById("password-error").hidden = false;
  }
}

function openAdmin() {
  ensureAdminName();
  renderAdminPanel();
  openModal("admin-modal");
}

function ensureAdminName() {
  if (!state.admin.name) {
    const v = prompt("Enter your name (used to attribute adjustments):", "");
    state.admin.name = (v && v.trim()) || "Admin";
    sessionStorage.setItem("tsip_admin_name", state.admin.name);
  }
  document.getElementById("admin-name-display").textContent = state.admin.name;
}

function changeAdminName() {
  const v = prompt("Your name:", state.admin.name || "");
  if (v && v.trim()) {
    state.admin.name = v.trim();
    sessionStorage.setItem("tsip_admin_name", state.admin.name);
    document.getElementById("admin-name-display").textContent = state.admin.name;
  }
}

// -----------------------------------------------------------------------------
// Admin panel rendering.
// -----------------------------------------------------------------------------

function renderAdminPanel() {
  document.getElementById("current-sheet-id").textContent = state.meta?.currentSheetId || "—";
  renderOverridesTable();
  renderAliasesTable();
}

function renderOverridesTable() {
  const tbody = document.getElementById("overrides-tbody");
  if (!tbody) return;
  const boards = deriveFinalBoards();
  const keys = new Set([...boards.fullTask.keys(), ...boards.rubric.keys()]);
  const rows = [...keys].map((k) => {
    const f = boards.fullTask.get(k);
    const r = boards.rubric.get(k);
    return {
      key: k,
      displayName: f?.displayName || r?.displayName || k,
      ftNet:   f?.netScore    ?? 0,
      ftRedo:  f?.redoCounter ?? 0,
      rbNet:   r?.netScore    ?? 0,
      rbRedo:  r?.redoCounter ?? 0,
      anyOverlay: !!state.overlays[k],
    };
  });
  rows.sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }));
  tbody.innerHTML = rows.length ? rows.map((r) => `
    <tr>
      <td>${escapeHtml(r.displayName)}${r.anyOverlay ? ' <span class="overlay-mark">&bull;</span>' : ''}</td>
      <td>${r.ftNet}</td>
      <td>${r.ftRedo}</td>
      <td>${r.rbNet}</td>
      <td>${r.rbRedo}</td>
      <td class="row-actions"><button class="btn btn-secondary" data-edit-overlay="${escapeAttr(r.key)}">Edit overlay</button></td>
    </tr>
  `).join("") : `<tr><td colspan="6" class="muted center">No contributors yet — fetch the sheet first.</td></tr>`;

  tbody.querySelectorAll("[data-edit-overlay]").forEach((btn) => {
    btn.addEventListener("click", () => openOverlayEditor(btn.dataset.editOverlay));
  });
}

function renderAliasesTable() {
  const tbody = document.getElementById("aliases-tbody");
  if (!tbody) return;
  const entries = Object.entries(state.aliases);
  if (!entries.length) {
    tbody.innerHTML = `<tr><td colspan="3" class="muted center">No aliases yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = entries.map(([k, v]) => `
    <tr>
      <td>${escapeHtml(k)}</td>
      <td>${escapeHtml(v.canonical || "—")}</td>
      <td class="row-actions"><button class="btn btn-danger" data-del-alias="${escapeAttr(k)}">Delete</button></td>
    </tr>
  `).join("");
  tbody.querySelectorAll("[data-del-alias]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm(`Delete alias "${btn.dataset.delAlias}"?`)) return;
      try {
        await deleteDoc(doc(state.fb.db, "aliases", btn.dataset.delAlias));
        showToast("Alias removed.", "success");
      } catch (err) { showToast("Couldn't delete alias: " + err.message, "error"); }
    });
  });
}

// -----------------------------------------------------------------------------
// Admin: add overlay-only person.
// -----------------------------------------------------------------------------

async function onAddPersonSubmit(ev) {
  ev.preventDefault();
  const errEl = document.getElementById("add-person-error");
  errEl.hidden = true;
  try {
    const name = normalizeNameRaw(document.getElementById("add-person-name").value);
    if (!name) throw new Error("Name is required.");
    const ftC = readNumOrNull("add-person-ft-completed");
    const ftR = readNumOrNull("add-person-ft-redo");
    const rbC = readNumOrNull("add-person-rb-completed");
    const rbR = readNumOrNull("add-person-rb-redo");
    const k = nameKey(name);
    const adjustments = [];
    const now = Date.now();
    function adj(board, field, to) {
      adjustments.push({ board, field, from: null, to, by: state.admin.name || "Admin", at: { seconds: Math.floor(now/1000) } });
    }
    if (ftC !== null) adj("fullTask", "completed", ftC);
    if (ftR !== null) adj("fullTask", "redoCounter", ftR);
    if (rbC !== null) adj("rubric",   "completed", rbC);
    if (rbR !== null) adj("rubric",   "redoCounter", rbR);
    const payload = {
      displayName: name,
      addedByOverlayOnly: true,
      fullTask: { ...(ftC !== null ? { completed: ftC } : {}), ...(ftR !== null ? { redoCounter: ftR } : {}) },
      rubric:   { ...(rbC !== null ? { completed: rbC } : {}), ...(rbR !== null ? { redoCounter: rbR } : {}) },
      adjustments,
      updatedAt: serverTimestamp(),
    };
    await setDoc(doc(state.fb.db, "overlays", k), payload, { merge: true });
    showToast(`Added overlay-only person: ${name}`, "success");
    ["add-person-name","add-person-ft-completed","add-person-ft-redo","add-person-rb-completed","add-person-rb-redo"]
      .forEach((id) => document.getElementById(id).value = "");
  } catch (err) {
    console.error(err);
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
}

function readNumOrNull(id) {
  const v = document.getElementById(id).value.trim();
  if (v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid number in field: ${id}`);
  return Math.floor(n);
}

// -----------------------------------------------------------------------------
// Admin: aliases.
// -----------------------------------------------------------------------------

async function onAliasSubmit(ev) {
  ev.preventDefault();
  const errEl = document.getElementById("alias-error");
  errEl.hidden = true;
  try {
    const from = normalizeNameRaw(document.getElementById("alias-from").value);
    const to   = normalizeNameRaw(document.getElementById("alias-to").value);
    if (!from || !to) throw new Error("Both fields are required.");
    const k = from.toLowerCase();
    await setDoc(doc(state.fb.db, "aliases", k), {
      canonical: to,
      by: state.admin.name || "Admin",
      at: serverTimestamp(),
    });
    showToast(`Alias saved: ${from} → ${to}`, "success");
    document.getElementById("alias-from").value = "";
    document.getElementById("alias-to").value = "";
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
}

// -----------------------------------------------------------------------------
// Admin: overlay editor.
// -----------------------------------------------------------------------------

function openOverlayEditor(personKey) {
  const boards = deriveFinalBoards();
  const f = boards.fullTask.get(personKey);
  const r = boards.rubric.get(personKey);
  const displayName = state.overlays[personKey]?.displayName || f?.displayName || r?.displayName || personKey;
  document.getElementById("overlay-edit-title").textContent = "Edit overlay — " + displayName;
  document.getElementById("overlay-edit-key").value = personKey;
  document.getElementById("overlay-edit-error").hidden = true;

  function setField(id, ovValue, liveValue) {
    const el = document.getElementById(id);
    el.value = (ovValue !== undefined && ovValue !== null) ? ovValue : "";
    el.placeholder = "Live: " + liveValue;
  }
  const ov = state.overlays[personKey] || {};
  setField("ovl-ft-completed", ov.fullTask?.completed,   f?.baseCompleted   ?? 0);
  setField("ovl-ft-redo",      ov.fullTask?.redoCounter, f?.baseRedoCounter ?? 0);
  setField("ovl-rb-completed", ov.rubric?.completed,     r?.baseCompleted   ?? 0);
  setField("ovl-rb-redo",      ov.rubric?.redoCounter,   r?.baseRedoCounter ?? 0);

  openModal("overlay-edit-modal");
}

async function onOverlayEditSubmit(ev) {
  ev.preventDefault();
  const errEl = document.getElementById("overlay-edit-error");
  errEl.hidden = true;
  try {
    const k = document.getElementById("overlay-edit-key").value;
    if (!k) throw new Error("No person key.");
    const ftC = readBlankOrNum("ovl-ft-completed");
    const ftR = readBlankOrNum("ovl-ft-redo");
    const rbC = readBlankOrNum("ovl-rb-completed");
    const rbR = readBlankOrNum("ovl-rb-redo");

    const existing = state.overlays[k] || { adjustments: [] };
    const boards = deriveFinalBoards();
    const f = boards.fullTask.get(k);
    const r = boards.rubric.get(k);
    const adj = (existing.adjustments || []).slice();
    const now = { seconds: Math.floor(Date.now() / 1000) };
    function logChange(board, field, fromLive, fromOverlay, to) {
      const before = (fromOverlay !== undefined && fromOverlay !== null) ? fromOverlay : fromLive;
      if (before === to) return;
      adj.push({ board, field, from: before, to, by: state.admin.name || "Admin", at: now });
    }
    logChange("fullTask", "completed",   f?.baseCompleted   ?? 0, existing.fullTask?.completed,   ftC);
    logChange("fullTask", "redoCounter", f?.baseRedoCounter ?? 0, existing.fullTask?.redoCounter, ftR);
    logChange("rubric",   "completed",   r?.baseCompleted   ?? 0, existing.rubric?.completed,     rbC);
    logChange("rubric",   "redoCounter", r?.baseRedoCounter ?? 0, existing.rubric?.redoCounter,   rbR);

    const displayName = existing.displayName || f?.displayName || r?.displayName || k;
    const docPayload = {
      displayName,
      addedByOverlayOnly: !!existing.addedByOverlayOnly,
      fullTask: {
        ...(ftC !== null ? { completed: ftC } : {}),
        ...(ftR !== null ? { redoCounter: ftR } : {}),
      },
      rubric: {
        ...(rbC !== null ? { completed: rbC } : {}),
        ...(rbR !== null ? { redoCounter: rbR } : {}),
      },
      adjustments: adj,
      updatedAt: serverTimestamp(),
    };
    const hasAny = ftC !== null || ftR !== null || rbC !== null || rbR !== null;
    if (!hasAny && !existing.addedByOverlayOnly) {
      // Pure clear → delete overlay doc entirely.
      await deleteDoc(doc(state.fb.db, "overlays", k));
      showToast("Overlays cleared.", "success");
    } else {
      await setDoc(doc(state.fb.db, "overlays", k), docPayload);
      showToast("Overlay saved.", "success");
    }
    closeModal("overlay-edit-modal");
  } catch (err) {
    console.error(err);
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
}

function readBlankOrNum(id) {
  const v = document.getElementById(id).value.trim();
  if (v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error("Numbers must be ≥ 0.");
  return Math.floor(n);
}

async function onOverlayClearAll() {
  const k = document.getElementById("overlay-edit-key").value;
  if (!k) return;
  if (!confirm("Remove all overlays for this person? Everything reverts to live values.")) return;
  try {
    await deleteDoc(doc(state.fb.db, "overlays", k));
    showToast("Overlays removed.", "success");
    closeModal("overlay-edit-modal");
  } catch (err) {
    showToast("Couldn't remove overlay: " + err.message, "error");
  }
}

// -----------------------------------------------------------------------------
// Admin: start new week / swap sheet.
// -----------------------------------------------------------------------------

function extractSheetId(input) {
  if (!input) return null;
  const s = input.trim();
  const m = s.match(/\/d\/([a-zA-Z0-9-_]+)/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9-_]{20,}$/.test(s)) return s;
  return null;
}

function guessRangeLabel() {
  if (!state.sheet.raw) return "";
  const all = [];
  const collect = (rows, cfg) => {
    for (const row of rows) {
      const d = normalizeDate(row[cfg.dateDone]);
      if (d) all.push(d);
    }
  };
  collect(state.sheet.raw.fullRows,   FULL);
  collect(state.sheet.raw.rubricRows, RUBRIC);
  if (!all.length) return "";
  all.sort();
  const fmt = (iso) => { const [, m, d] = iso.split("-").map(Number); return `${m}/${d}`; };
  return all[0] === all[all.length - 1] ? fmt(all[0]) : `${fmt(all[0])} – ${fmt(all[all.length - 1])}`;
}

function isoDateRangeForLabel() {
  if (!state.sheet.raw) return null;
  const all = [];
  for (const row of state.sheet.raw.fullRows)   { const d = normalizeDate(row[FULL.dateDone]);   if (d) all.push(d); }
  for (const row of state.sheet.raw.rubricRows) { const d = normalizeDate(row[RUBRIC.dateDone]); if (d) all.push(d); }
  if (!all.length) return null;
  all.sort();
  return { min: all[0], max: all[all.length - 1] };
}

async function onSwapSubmit(ev) {
  ev.preventDefault();
  const errEl = document.getElementById("swap-error");
  errEl.hidden = true;
  const btn = document.getElementById("swap-confirm");
  btn.disabled = true;
  try {
    const newId = extractSheetId(document.getElementById("swap-url").value);
    if (!newId) throw new Error("Couldn't find a sheet ID in that URL.");
    const label = (document.getElementById("swap-label").value || "").trim();
    if (!label) throw new Error("Label is required.");

    // Build snapshot from current overlaid boards.
    const boards = deriveFinalBoards();
    const ftRows = rowsForBoard("fullTask", boards).map((r) => ({
      rank: r.rank, name: r.displayName,
      completed: r.completed, outstandingRedo: r.outstandingRedo,
      redoCounter: r.redoCounter, netScore: r.netScore,
    }));
    const rbRows = rowsForBoard("rubric", boards).map((r) => ({
      rank: r.rank, name: r.displayName,
      completed: r.completed, outstandingRedo: r.outstandingRedo,
      redoCounter: r.redoCounter, netScore: r.netScore,
    }));
    const cmRows = rowsForBoard("combined", boards).map((r) => ({
      rank: r.rank, name: r.displayName,
      fullTaskNet: r.fullTaskNet, rubricNet: r.rubricNet,
      totalRedos: r.totalRedos, score: r.score,
    }));

    // Per-person history (raw rows + base/overlay) for the modal in archive view.
    const perPersonHistory = {};
    for (const [k, f] of boards.fullTask) {
      const r = boards.rubric.get(k);
      perPersonHistory[k] = {
        displayName: f.displayName || r?.displayName || k,
        fullTask: f ? snapshotPerson(f) : null,
        rubric:   r ? snapshotPerson(r) : null,
        adjustments: (state.overlays[k]?.adjustments) || [],
      };
    }
    for (const [k, r] of boards.rubric) {
      if (perPersonHistory[k]) continue;
      perPersonHistory[k] = {
        displayName: r.displayName,
        fullTask: null,
        rubric: snapshotPerson(r),
        adjustments: (state.overlays[k]?.adjustments) || [],
      };
    }

    // Doc id — slugify the iso range, fall back to a timestamp.
    const range = isoDateRangeForLabel();
    const docId = range ? `${range.min}_to_${range.max}` : `week_${Date.now()}`;
    const archive = {
      weekLabel: docId,
      rangeLabel: label,
      sourceSheetId: state.meta?.currentSheetId || state.sheet.id || "",
      archivedBy: state.admin.name || "Admin",
      archivedAt: serverTimestamp(),
      boards: { fullTask: ftRows, rubric: rbRows, combined: cmRows },
      perPersonHistory,
    };
    await setDoc(doc(state.fb.db, "archives", docId), archive);

    // Wipe overlays.
    const overlaySnap = await getDocs(collection(state.fb.db, "overlays"));
    for (const d of overlaySnap.docs) {
      await deleteDoc(doc(state.fb.db, "overlays", d.id));
    }
    // Point meta to the new sheet.
    await setDoc(doc(state.fb.db, "meta", "site"), {
      currentSheetId: newId,
      schemaVersion: 1,
      updatedAt: serverTimestamp(),
    }, { merge: true });

    showToast(`Archived "${label}" — now reading from new sheet.`, "success");
    closeModal("swap-modal");
    closeModal("admin-modal");
  } catch (err) {
    console.error(err);
    errEl.textContent = err.message;
    errEl.hidden = false;
  } finally {
    btn.disabled = false;
  }
}

function snapshotPerson(stats) {
  return {
    baseCompleted: stats.baseCompleted, baseRedoCounter: stats.baseRedoCounter,
    completed: stats.completed, redoCounter: stats.redoCounter,
    outstandingRedo: stats.outstandingRedo, netScore: stats.netScore,
    hasCompletedOverlay: stats.hasCompletedOverlay, hasRedoOverlay: stats.hasRedoOverlay,
    rows: (stats.rows || []).map((r) => ({
      taskId: r.taskId, date: r.date,
      done: r.done, isRedo: r.isRedo, redoDone: r.redoDone, secondRedoDone: r.secondRedoDone,
    })),
  };
}

// -----------------------------------------------------------------------------
// Boot.
// -----------------------------------------------------------------------------

async function boot() {
  initFirebase();
  attachEvents();
  renderStatus();
  // Probe Firebase (best-effort). If it fails the sheet still loads.
  await probeFirebase();
  if (state.fb.status === "connected") startListeners();
  const sheetId = state.meta?.currentSheetId || DEFAULT_SHEET_ID;
  await loadSheet(sheetId);
}

boot();
