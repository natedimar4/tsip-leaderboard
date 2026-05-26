// =============================================================================
// TSIP Leaderboard — script.js
// =============================================================================
// PASTE YOUR FIREBASE WEB CONFIG INTO FIREBASE_CONFIG BELOW.
// Set ADMIN_PASSWORD to whatever shared password you want.

const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyD2tw6FXHushbJrY9VThpK8S7da7EELSDk",
  authDomain:        "tsip-leaderboard.firebaseapp.com",
  projectId:         "tsip-leaderboard",
  storageBucket:     "tsip-leaderboard.firebasestorage.app",
  messagingSenderId: "941083332511",
  appId:             "1:941083332511:web:2531c94e08d2583cc9b7aa",
};

const ADMIN_PASSWORD = "Meridian_Admin_26";

const HISTORICAL_SHEET_ID    = "1uhSy4ISikJ9l9Jym9h5UkOV9phUknDsuxOY73dLRbns";
const HISTORICAL_WEEK_START  = "2026-05-19"; // Monday of the week being imported
const HISTORICAL_WEEK_END_DATE = "2026-05-25"; // date stamped on imported entries (Sunday)
const TIMEZONE               = "America/New_York";
const DROP_NAMES             = ["End"];
const NAME_ALIASES           = {
  "Antoniio V": "Antonio V",
  "Jacob Coran": "Jacob C",
};

// =============================================================================
// Firebase init (modular SDK via CDN)
// =============================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getFirestore, collection, doc, addDoc, updateDoc, deleteDoc, setDoc,
  serverTimestamp, onSnapshot, writeBatch, getDoc,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

let app, db;
try {
  app = initializeApp(FIREBASE_CONFIG);
  db  = getFirestore(app);
} catch (err) {
  console.error("Firebase init failed:", err);
  showToast("Firebase init failed — check FIREBASE_CONFIG in script.js", "error");
}

const entriesCol = () => collection(db, "entries");
const metaDoc    = () => doc(db, "meta", "site");

// =============================================================================
// Time helpers — Eastern-time week boundary
// =============================================================================

// Format `date` (Date object, defaults to now) in the configured TIMEZONE,
// returning the calendar YYYY-MM-DD that the clock currently reads in Eastern.
function todayIsoInTz(date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  // en-CA formats as YYYY-MM-DD already.
  return fmt.format(date);
}

// Given any YYYY-MM-DD calendar date, return the Monday of that week as YYYY-MM-DD.
// A calendar date's weekday is the same everywhere on Earth, so we use UTC math.
function weekStartFromIso(isoDate) {
  if (!isoDate) return null;
  const [y, m, d] = isoDate.split("-").map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d));
  const dow = utc.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const offset = dow === 0 ? 6 : dow - 1; // days since Monday
  const monday = new Date(Date.UTC(y, m - 1, d - offset));
  return monday.toISOString().slice(0, 10);
}

function currentWeekStart() {
  return weekStartFromIso(todayIsoInTz());
}

// Human label "5/19 – 5/25" given a weekStart "2026-05-19".
function weekRangeLabel(weekStartIso) {
  const [y, m, d] = weekStartIso.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, d));
  const end   = new Date(Date.UTC(y, m - 1, d + 6));
  const fmt   = (dt) => `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}`;
  return `${fmt(start)} – ${fmt(end)}`;
}

function shortDate(isoDate) {
  if (!isoDate) return "—";
  const [y, m, d] = isoDate.split("-").map(Number);
  return `${m}/${d}`;
}

// =============================================================================
// Name & value normalization
// =============================================================================

function normalizeNameRaw(raw) {
  if (raw === null || raw === undefined) return "";
  let s = String(raw).trim().replace(/\s+/g, " ");
  if (!s) return "";
  if (NAME_ALIASES[s]) s = NAME_ALIASES[s];
  return s;
}

// Returns null for drop / blank names.
function normalizeName(raw) {
  const s = normalizeNameRaw(raw);
  if (!s) return null;
  if (DROP_NAMES.includes(s)) return null;
  return s;
}

function nameKey(displayName) {
  return displayName ? displayName.toLowerCase() : null;
}

function parseCount(raw) {
  if (raw === null || raw === undefined) return 0;
  const s = String(raw).trim();
  if (!s) return 0;
  if (s === "-" || /^n\/a$/i.test(s)) return 0;
  const n = Number(s.replace(/[, ]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function truthyFlag(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "true" || s === "yes" || s === "1" || s === "x" || s === "✓" || s === "y" || s === "done" || s === "checked";
}

// =============================================================================
// CSV parsing (RFC4180-ish; handles quoted fields, embedded newlines, "")
// =============================================================================

function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else {
        cell += c;
      }
    } else {
      if (c === '"') inQuotes = true;
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

// =============================================================================
// State + listeners
// =============================================================================

const state = {
  entries: [],            // [{id, name, displayName, taskCount, date, weekStart, enteredBy, type, createdAt}]
  meta:    { historicalImported: false },
  loaded:  { entries: false, meta: false },
  adminName: sessionStorage.getItem("tsip_admin_name") || "",
  adminUnlocked: false,
  chart: null,
};

function startListeners() {
  if (!db) return;
  onSnapshot(entriesCol(), (snap) => {
    state.entries = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    state.loaded.entries = true;
    renderAll();
  }, (err) => {
    console.error("entries snapshot error", err);
    showToast("Couldn't load entries: " + err.message, "error");
  });

  onSnapshot(metaDoc(), (snap) => {
    state.meta = snap.exists() ? snap.data() : { historicalImported: false };
    state.loaded.meta = true;
    renderImportSectionVisibility();
  }, (err) => {
    console.error("meta snapshot error", err);
  });
}

// =============================================================================
// Derived data
// =============================================================================

// Roster = every unique person who has ever had an entry.
function fullRoster() {
  const map = new Map(); // key -> displayName (first-seen wins, but we prefer the most-recently-stored displayName)
  for (const e of state.entries) {
    const k = nameKey(e.displayName || e.name);
    if (!k) continue;
    if (!map.has(k)) map.set(k, e.displayName || e.name);
  }
  return map; // Map(key -> displayName)
}

function currentWeekTotalsByKey() {
  const week = currentWeekStart();
  const totals = new Map();
  const lastUpdatedDate = new Map();
  for (const e of state.entries) {
    if (e.weekStart !== week) continue;
    const k = nameKey(e.displayName || e.name);
    if (!k) continue;
    totals.set(k, (totals.get(k) || 0) + (Number(e.taskCount) || 0));
    const prev = lastUpdatedDate.get(k);
    if (!prev || (e.date && e.date > prev)) lastUpdatedDate.set(k, e.date);
  }
  return { totals, lastUpdatedDate };
}

function leaderboardRows() {
  const roster = fullRoster();
  const { totals, lastUpdatedDate } = currentWeekTotalsByKey();
  // Make sure every roster member has a row (totals default to 0).
  const rows = [];
  for (const [k, displayName] of roster) {
    rows.push({
      key: k,
      displayName,
      total: totals.get(k) || 0,
      lastUpdated: lastUpdatedDate.get(k) || null,
    });
  }
  rows.sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" });
  });
  rows.forEach((r, i) => { r.rank = i + 1; });
  return rows;
}

function entriesForPerson(displayName) {
  const k = nameKey(displayName);
  return state.entries.filter((e) => nameKey(e.displayName || e.name) === k);
}

// =============================================================================
// Rendering — public view
// =============================================================================

function renderAll() {
  if (!state.loaded.entries) return;
  renderHeader();
  renderTable();
  renderChart();
  renderPastWeeks();
  // Admin-side selectors / lists also use entries:
  if (state.adminUnlocked) {
    renderAdminPersonSelects();
    renderEditList();
  }
}

function renderHeader() {
  const week = currentWeekStart();
  document.getElementById("week-range").textContent = "Week of " + weekRangeLabel(week);
  // Last updated = most recent date among current-week entries
  const week_entries = state.entries.filter((e) => e.weekStart === week);
  let last = null;
  for (const e of week_entries) {
    if (!last || (e.date && e.date > last)) last = e.date;
  }
  document.getElementById("last-updated").textContent = "Last updated: " + (last ? shortDate(last) : "—");
}

function renderTable() {
  const rows = leaderboardRows();
  const tbody = document.getElementById("leaderboard-tbody");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted center">No contributors yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((r) => `
    <tr>
      <td class="col-rank">${r.rank}</td>
      <td class="col-name"><button class="name-link" data-history="${escapeAttr(r.displayName)}">${escapeHtml(r.displayName)}</button></td>
      <td class="col-count">${r.total}</td>
      <td class="col-updated">${r.lastUpdated ? shortDate(r.lastUpdated) : "—"}</td>
    </tr>
  `).join("");

  tbody.querySelectorAll("[data-history]").forEach((btn) => {
    btn.addEventListener("click", () => openHistory(btn.dataset.history));
  });
}

function renderChart() {
  const rows = leaderboardRows().slice(0, 5);
  // Chart.js horizontal bar: bigger bars at top → reverse so highest is rendered first
  const labels = rows.map((r) => r.displayName);
  const values = rows.map((r) => r.total);
  const allZero = values.every((v) => v === 0);
  const emptyMsg = document.getElementById("chart-empty");
  emptyMsg.hidden = !allZero;

  const ctx = document.getElementById("top5-chart").getContext("2d");
  if (state.chart) { state.chart.destroy(); state.chart = null; }
  if (!labels.length || allZero) return;

  state.chart = new Chart(ctx, {
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
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => `${c.parsed.x} task${c.parsed.x === 1 ? "" : "s"}` } },
        // Custom plugin (datalabels not bundled in UMD) — we draw counts via afterDatasetDraw
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
        const { ctx, data, scales } = chart;
        ctx.save();
        ctx.font = "600 12px " + getComputedStyle(document.body).fontFamily;
        ctx.fillStyle = "#1b1f2a";
        ctx.textBaseline = "middle";
        data.datasets[0].data.forEach((val, i) => {
          const meta = chart.getDatasetMeta(0);
          const bar  = meta.data[i];
          if (!bar) return;
          ctx.fillText(String(val), bar.x + 6, bar.y);
        });
        ctx.restore();
      },
    }],
  });
}

// =============================================================================
// Past weeks archive
// =============================================================================

function pastWeekStarts() {
  const current = currentWeekStart();
  const set = new Set();
  for (const e of state.entries) {
    if (e.weekStart && e.weekStart !== current) set.add(e.weekStart);
  }
  return [...set].sort().reverse(); // most recent first
}

function leaderboardForWeek(weekStartIso) {
  const totals = new Map(); // key -> { displayName, total }
  for (const e of state.entries) {
    if (e.weekStart !== weekStartIso) continue;
    const display = e.displayName || e.name;
    const k = nameKey(display);
    if (!k) continue;
    if (!totals.has(k)) totals.set(k, { displayName: display, total: 0 });
    totals.get(k).total += (Number(e.taskCount) || 0);
  }
  const rows = [...totals.values()];
  rows.sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" });
  });
  rows.forEach((r, i) => { r.rank = i + 1; });
  return rows;
}

function renderPastWeeks() {
  const card   = document.getElementById("past-weeks-card");
  const select = document.getElementById("past-week-select");
  const tbody  = document.getElementById("past-week-tbody");
  if (!card || !select || !tbody) return;

  const weeks = pastWeekStarts();
  if (!weeks.length) { card.hidden = true; return; }
  card.hidden = false;

  const prev = select.value;
  select.innerHTML = weeks.map((w) => `<option value="${w}">Week of ${weekRangeLabel(w)}</option>`).join("");
  // Keep prior selection if still valid; otherwise default to most recent.
  select.value = (prev && weeks.includes(prev)) ? prev : weeks[0];

  renderPastWeekTable(select.value);
}

function renderPastWeekTable(weekStartIso) {
  const tbody = document.getElementById("past-week-tbody");
  if (!tbody) return;
  const rows = leaderboardForWeek(weekStartIso);
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="3" class="muted center">No entries for this week.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((r) => `
    <tr>
      <td class="col-rank">${r.rank}</td>
      <td class="col-name"><button class="name-link" data-history="${escapeAttr(r.displayName)}">${escapeHtml(r.displayName)}</button></td>
      <td class="col-count">${r.total}</td>
    </tr>
  `).join("");
  tbody.querySelectorAll("[data-history]").forEach((btn) => {
    btn.addEventListener("click", () => openHistory(btn.dataset.history));
  });
}

document.addEventListener("change", (ev) => {
  if (ev.target?.id === "past-week-select") renderPastWeekTable(ev.target.value);
});

// =============================================================================
// History modal
// =============================================================================

function openHistory(displayName) {
  const entries = entriesForPerson(displayName);
  const byWeek  = new Map();
  for (const e of entries) {
    if (!e.weekStart) continue;
    if (!byWeek.has(e.weekStart)) byWeek.set(e.weekStart, []);
    byWeek.get(e.weekStart).push(e);
  }
  const weeks = [...byWeek.keys()].sort().reverse(); // most recent first
  const html = weeks.length
    ? weeks.map((ws) => {
        const list = byWeek.get(ws).slice().sort((a, b) => (a.date || "").localeCompare(b.date || ""));
        const total = list.reduce((s, e) => s + (Number(e.taskCount) || 0), 0);
        return `
          <div class="history-week">
            <div class="history-week-head">
              <span>Week of ${weekRangeLabel(ws)}</span>
              <span class="total">${total} task${total === 1 ? "" : "s"}</span>
            </div>
            <table>
              <thead><tr><th>Date</th><th>Tasks</th><th>Type</th><th>Entered by</th></tr></thead>
              <tbody>
                ${list.map((e) => `
                  <tr>
                    <td>${shortDate(e.date)}</td>
                    <td>${Number(e.taskCount) || 0}</td>
                    <td>${e.type || "manual"}</td>
                    <td>${escapeHtml(e.enteredBy || "—")}</td>
                  </tr>`).join("")}
              </tbody>
            </table>
          </div>
        `;
      }).join("")
    : `<p class="muted">No entries yet for this person.</p>`;

  document.getElementById("history-name").textContent = displayName;
  document.getElementById("history-body").innerHTML = html;
  openModal("history-modal");
}

// =============================================================================
// Modal helpers
// =============================================================================

function openModal(id)  { document.getElementById(id).hidden = false; }
function closeModal(id) { document.getElementById(id).hidden = true; }

document.addEventListener("click", (e) => {
  const closeId = e.target?.dataset?.close;
  if (closeId) closeModal(closeId);
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  ["history-modal", "password-modal", "edit-entry-modal", "admin-modal"].forEach((id) => {
    const el = document.getElementById(id);
    if (el && !el.hidden) closeModal(id);
  });
});

// =============================================================================
// Public refresh button
// =============================================================================

document.getElementById("refresh-btn").addEventListener("click", () => {
  // Listener already keeps state live; trigger a re-render and toast.
  renderAll();
  showToast("Refreshed.");
});

// =============================================================================
// Admin: password gate
// =============================================================================

document.getElementById("admin-link").addEventListener("click", () => {
  if (state.adminUnlocked) {
    openAdmin();
  } else {
    document.getElementById("password-error").hidden = true;
    document.getElementById("password-input").value = "";
    openModal("password-modal");
    setTimeout(() => document.getElementById("password-input").focus(), 60);
  }
});

document.getElementById("password-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const val = document.getElementById("password-input").value;
  if (val === ADMIN_PASSWORD) {
    state.adminUnlocked = true;
    closeModal("password-modal");
    openAdmin();
  } else {
    document.getElementById("password-error").hidden = false;
  }
});

function openAdmin() {
  ensureAdminName();
  document.getElementById("single-date").value = todayIsoInTz();
  document.getElementById("bulk-date").value   = todayIsoInTz();
  renderAdminPersonSelects();
  renderEditList();
  renderImportSectionVisibility();
  openModal("admin-modal");
}

function ensureAdminName() {
  if (!state.adminName) {
    const entered = prompt("Enter your name (used to attribute entries):", "");
    if (entered && entered.trim()) {
      state.adminName = entered.trim();
      sessionStorage.setItem("tsip_admin_name", state.adminName);
    } else {
      state.adminName = "Admin";
      sessionStorage.setItem("tsip_admin_name", state.adminName);
    }
  }
  document.getElementById("admin-name-display").textContent = state.adminName;
}

document.getElementById("change-admin-name").addEventListener("click", () => {
  const entered = prompt("Your name:", state.adminName || "");
  if (entered && entered.trim()) {
    state.adminName = entered.trim();
    sessionStorage.setItem("tsip_admin_name", state.adminName);
    document.getElementById("admin-name-display").textContent = state.adminName;
  }
});

// =============================================================================
// Admin: person select population
// =============================================================================

function renderAdminPersonSelects() {
  const roster = [...fullRoster().values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  for (const id of ["single-person-select", "rename-from", "edit-filter-person"]) {
    const sel = document.getElementById(id);
    if (!sel) continue;
    const prev = sel.value;
    sel.innerHTML = (id === "edit-filter-person"
      ? `<option value="">— all —</option>`
      : `<option value="">— pick a person —</option>`)
      + roster.map((n) => `<option value="${escapeAttr(n)}">${escapeHtml(n)}</option>`).join("");
    if (prev && roster.includes(prev)) sel.value = prev;
  }
  const weekFilter = document.getElementById("edit-filter-week");
  if (weekFilter) {
    const weeks = [...new Set(state.entries.map((e) => e.weekStart).filter(Boolean))].sort().reverse();
    const prev = weekFilter.value;
    weekFilter.innerHTML = `<option value="">— all —</option>`
      + weeks.map((w) => `<option value="${w}">Week of ${weekRangeLabel(w)}</option>`).join("");
    if (prev && weeks.includes(prev)) weekFilter.value = prev;
  }
}

// =============================================================================
// Admin: single entry
// =============================================================================

document.getElementById("single-entry-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const errEl = document.getElementById("single-error");
  errEl.hidden = true;
  const saveBtn = document.getElementById("single-save");
  saveBtn.disabled = true;

  try {
    const sel = document.getElementById("single-person-select").value.trim();
    const nu  = document.getElementById("single-new-name").value.trim();
    const displayName = normalizeName(nu || sel);
    if (!displayName) throw new Error("Pick or type a name.");
    const dateIso = document.getElementById("single-date").value;
    if (!dateIso) throw new Error("Pick a date.");
    const count = parseCount(document.getElementById("single-count").value);
    if (count < 0) throw new Error("Task count must be ≥ 0.");

    await addDoc(entriesCol(), {
      name: nameKey(displayName),
      displayName,
      taskCount: count,
      date: dateIso,
      weekStart: weekStartFromIso(dateIso),
      enteredBy: state.adminName || "Admin",
      type: "manual",
      createdAt: serverTimestamp(),
    });
    showToast(`Saved: ${displayName} +${count}`, "success");
    document.getElementById("single-new-name").value = "";
    document.getElementById("single-person-select").value = "";
    document.getElementById("single-count").value = 1;
  } catch (err) {
    console.error(err);
    errEl.textContent = err.message;
    errEl.hidden = false;
  } finally {
    saveBtn.disabled = false;
  }
});

// =============================================================================
// Admin: bulk paste
// =============================================================================

let bulkPreviewRows = null;

document.getElementById("bulk-preview-btn").addEventListener("click", () => {
  const text = document.getElementById("bulk-text").value;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const parsed = [];
  for (const line of lines) {
    // Try comma, tab, then whitespace.
    let tokens = line.split(/\t|,/).map((t) => t.trim()).filter(Boolean);
    if (tokens.length < 2) tokens = line.split(/\s+/);
    // Last token = count, rest = name.
    const last = tokens[tokens.length - 1];
    const countStr = last;
    const nameTokens = tokens.slice(0, -1);
    let name = nameTokens.join(" ").trim();
    // If user pasted "Name 12" with no separator, the regex above already handled it.
    if (!name) { parsed.push({ raw: line, name: "", count: 0, error: "No name found" }); continue; }
    const norm = normalizeName(name);
    if (!norm) { parsed.push({ raw: line, name, count: parseCount(countStr), error: `Dropped/blank name` }); continue; }
    const count = parseCount(countStr);
    if (!Number.isFinite(Number(countStr.replace(/[, ]/g, "")))) {
      parsed.push({ raw: line, name: norm, count, error: "Count isn't a number — defaulted to 0" });
    } else {
      parsed.push({ raw: line, name: norm, count, error: null });
    }
  }
  bulkPreviewRows = parsed;
  const wrap  = document.getElementById("bulk-preview-wrap");
  const tbody = wrap.querySelector("tbody");
  if (!parsed.length) {
    wrap.hidden = true;
    document.getElementById("bulk-save-btn").disabled = true;
    return;
  }
  tbody.innerHTML = parsed.map((r) => `
    <tr>
      <td>${escapeHtml(r.name || r.raw)}</td>
      <td>${r.count}</td>
      <td>${r.error ? `<span class="error">${escapeHtml(r.error)}</span>` : `<span class="success">OK</span>`}</td>
    </tr>
  `).join("");
  wrap.hidden = false;
  const anyValid = parsed.some((r) => !r.error || /defaulted/.test(r.error));
  document.getElementById("bulk-save-btn").disabled = !anyValid;
});

document.getElementById("bulk-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (!bulkPreviewRows || !bulkPreviewRows.length) { showToast("Click Preview first.", "error"); return; }
  const dateIso = document.getElementById("bulk-date").value;
  if (!dateIso) { showToast("Pick a date.", "error"); return; }
  const weekStart = weekStartFromIso(dateIso);
  const saveBtn = document.getElementById("bulk-save-btn");
  saveBtn.disabled = true;
  try {
    const batch = writeBatch(db);
    let count = 0;
    for (const r of bulkPreviewRows) {
      // Skip rows with no usable name; allow rows with a 0 count.
      const norm = normalizeName(r.name);
      if (!norm) continue;
      const ref = doc(entriesCol());
      batch.set(ref, {
        name: nameKey(norm),
        displayName: norm,
        taskCount: r.count || 0,
        date: dateIso,
        weekStart,
        enteredBy: state.adminName || "Admin",
        type: "manual",
        createdAt: serverTimestamp(),
      });
      count++;
    }
    await batch.commit();
    showToast(`Saved ${count} entries.`, "success");
    document.getElementById("bulk-text").value = "";
    document.getElementById("bulk-preview-wrap").hidden = true;
    bulkPreviewRows = null;
  } catch (err) {
    console.error(err);
    showToast("Bulk save failed: " + err.message, "error");
  } finally {
    saveBtn.disabled = false;
  }
});

// =============================================================================
// Admin: edit / delete
// =============================================================================

document.getElementById("edit-filter-person").addEventListener("change", renderEditList);
document.getElementById("edit-filter-week").addEventListener("change", renderEditList);

function renderEditList() {
  const tbody = document.querySelector("#edit-table tbody");
  if (!tbody) return;
  const personFilter = document.getElementById("edit-filter-person").value;
  const weekFilter   = document.getElementById("edit-filter-week").value;
  let rows = state.entries.slice();
  if (personFilter) rows = rows.filter((e) => nameKey(e.displayName || e.name) === nameKey(personFilter));
  if (weekFilter)   rows = rows.filter((e) => e.weekStart === weekFilter);
  rows.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted center">No matching entries.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((e) => `
    <tr>
      <td>${e.date || "—"}</td>
      <td>${escapeHtml(e.displayName || e.name || "—")}</td>
      <td>${Number(e.taskCount) || 0}</td>
      <td>${e.type || "manual"}</td>
      <td>${escapeHtml(e.enteredBy || "—")}</td>
      <td class="row-actions">
        <button class="btn btn-secondary" data-edit="${e.id}">Edit</button>
        <button class="btn btn-danger" data-delete="${e.id}">Delete</button>
      </td>
    </tr>
  `).join("");

  tbody.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => openEditEntry(b.dataset.edit)));
  tbody.querySelectorAll("[data-delete]").forEach((b) => b.addEventListener("click", () => confirmDeleteEntry(b.dataset.delete)));
}

function openEditEntry(id) {
  const e = state.entries.find((x) => x.id === id);
  if (!e) return;
  document.getElementById("edit-entry-id").value    = id;
  document.getElementById("edit-entry-name").value  = e.displayName || e.name || "";
  document.getElementById("edit-entry-date").value  = e.date || todayIsoInTz();
  document.getElementById("edit-entry-count").value = Number(e.taskCount) || 0;
  document.getElementById("edit-entry-error").hidden = true;
  openModal("edit-entry-modal");
}

document.getElementById("edit-entry-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const errEl = document.getElementById("edit-entry-error");
  errEl.hidden = true;
  try {
    const id   = document.getElementById("edit-entry-id").value;
    const name = normalizeName(document.getElementById("edit-entry-name").value);
    const date = document.getElementById("edit-entry-date").value;
    const count = parseCount(document.getElementById("edit-entry-count").value);
    if (!name) throw new Error("Name is required.");
    if (!date) throw new Error("Date is required.");
    await updateDoc(doc(db, "entries", id), {
      name: nameKey(name),
      displayName: name,
      date,
      weekStart: weekStartFromIso(date),
      taskCount: count,
    });
    closeModal("edit-entry-modal");
    showToast("Entry updated.", "success");
  } catch (err) {
    console.error(err);
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
});

async function confirmDeleteEntry(id) {
  const e = state.entries.find((x) => x.id === id);
  if (!e) return;
  if (!confirm(`Delete this entry?\n\n${e.displayName} · ${e.date} · ${e.taskCount}`)) return;
  try {
    await deleteDoc(doc(db, "entries", id));
    showToast("Entry deleted.", "success");
  } catch (err) {
    console.error(err);
    showToast("Delete failed: " + err.message, "error");
  }
}

// =============================================================================
// Admin: rename person
// =============================================================================

document.getElementById("rename-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const errEl = document.getElementById("rename-error");
  errEl.hidden = true;
  try {
    const from = document.getElementById("rename-from").value.trim();
    const toRaw = document.getElementById("rename-to").value.trim();
    const to    = normalizeName(toRaw);
    if (!from) throw new Error("Pick a person to rename.");
    if (!to)   throw new Error("Type the new display name.");
    const fromKey = nameKey(from);
    const matches = state.entries.filter((e) => nameKey(e.displayName || e.name) === fromKey);
    if (!matches.length) throw new Error("No entries found for that person.");
    if (!confirm(`Rename "${from}" → "${to}" across ${matches.length} entries?`)) return;
    const batch = writeBatch(db);
    for (const e of matches) {
      batch.update(doc(db, "entries", e.id), {
        name: nameKey(to),
        displayName: to,
      });
    }
    await batch.commit();
    showToast(`Renamed ${matches.length} entries.`, "success");
    document.getElementById("rename-to").value = "";
  } catch (err) {
    console.error(err);
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
});

// =============================================================================
// Historical import
// =============================================================================

function renderImportSectionVisibility() {
  const section = document.getElementById("import-section");
  if (!section) return;
  section.hidden = !!state.meta?.historicalImported;
}

document.getElementById("import-btn").addEventListener("click", async () => {
  if (!confirm("Pull last week's results from the Google Sheet and write entries for the week of 5/19 – 5/25? This runs once.")) return;
  const btn = document.getElementById("import-btn");
  const logEl = document.getElementById("import-log");
  logEl.hidden = false;
  logEl.textContent = "";
  const log = (...args) => {
    const line = args.map((a) => typeof a === "string" ? a : JSON.stringify(a, null, 2)).join(" ");
    logEl.textContent += line + "\n";
    console.log("[import]", ...args);
  };

  btn.disabled = true;
  try {
    // Double-check the flag right before writing.
    const fresh = await getDoc(metaDoc());
    if (fresh.exists() && fresh.data().historicalImported) {
      throw new Error("Historical import has already been run.");
    }

    log("Fetching Claim Sheet…");
    const claimText = await fetchSheetCsv(HISTORICAL_SHEET_ID, "Claim Sheet");
    log("Fetching Model Decomp Summary…");
    const decompText = await fetchSheetCsv(HISTORICAL_SHEET_ID, "Model Decomp Summary");

    const claimRows  = parseCsv(claimText);
    const decompRows = parseCsv(decompText);

    log(`Claim Sheet rows: ${claimRows.length}, Model Decomp rows: ${decompRows.length}`);

    const claimCounts = parseClaimSheet(claimRows, log);
    const decompResult = parseModelDecompSummary(decompRows, log);

    // Roster = union of names across both tabs, including 0s.
    const allKeys = new Set([
      ...claimCounts.keys(),
      ...decompResult.maxByKey.keys(),
    ]);

    log(`Combined roster size (pre-drop): ${allKeys.size}`);

    const docsToWrite = [];
    const breakdown = [];
    for (const k of allKeys) {
      const displayName =
        claimCounts.get(k)?.displayName ||
        decompResult.maxByKey.get(k)?.displayName ||
        k;
      const norm = normalizeName(displayName);
      if (!norm) { log(`Dropping name: ${displayName}`); continue; }
      const nd  = claimCounts.get(k)?.count ?? 0;
      const md  = decompResult.maxByKey.get(k)?.count ?? 0;
      const total = nd + md;
      docsToWrite.push({ displayName: norm, total });
      breakdown.push({
        name: norm,
        nonDecomp: nd,
        decompSmall: decompResult.smallByKey.get(k)?.count ?? 0,
        decompBig:   decompResult.bigByKey.get(k)?.count ?? 0,
        decompUsed:  md,
        total,
      });
    }

    // After alias merging, dedupe by normalized key (e.g., "Antoniio V" → "Antonio V")
    const merged = new Map(); // key -> { displayName, total }
    for (const d of docsToWrite) {
      const norm = normalizeName(d.displayName);
      if (!norm) continue;
      const k = nameKey(norm);
      if (!merged.has(k)) merged.set(k, { displayName: norm, total: 0 });
      merged.get(k).total += d.total;
    }

    log(`Final roster size: ${merged.size}`);
    log("Per-person breakdown:");
    breakdown.sort((a, b) => a.name.localeCompare(b.name));
    for (const r of breakdown) {
      log(`  ${r.name.padEnd(20)} non-decomp=${r.nonDecomp}  decomp(small=${r.decompSmall}, big=${r.decompBig}, used=${r.decompUsed})  total=${r.total}`);
    }

    // Sanity check: Richards C must pick up at least 3 model decomp tasks.
    const richardsK = "richards c";
    if (merged.has(richardsK)) {
      const rDecomp = decompResult.maxByKey.get(richardsK)?.count ?? 0;
      log(`Sanity: Richards C model decomp (max-of-two-tables) = ${rDecomp}`);
      if (rDecomp < 3) log(`⚠ Richards C decomp expected ≥ 3 — got ${rDecomp}. Inspect the Model Decomp Summary tab.`);
    } else {
      log(`⚠ Richards C not found in either tab. If they should be there, check spelling.`);
    }

    // Write entries
    const batch = writeBatch(db);
    let written = 0;
    for (const [, person] of merged) {
      const ref = doc(entriesCol());
      batch.set(ref, {
        name: nameKey(person.displayName),
        displayName: person.displayName,
        taskCount: person.total,
        date: HISTORICAL_WEEK_END_DATE,
        weekStart: HISTORICAL_WEEK_START,
        enteredBy: "System",
        type: "historical",
        createdAt: serverTimestamp(),
      });
      written++;
    }
    batch.set(metaDoc(), {
      historicalImported: true,
      historicalImportedAt: serverTimestamp(),
    }, { merge: true });

    await batch.commit();
    log(`Wrote ${written} historical entries. Import flag set.`);
    showToast(`Historical import done — ${written} entries.`, "success");
  } catch (err) {
    console.error(err);
    showToast("Import failed: " + err.message, "error");
    document.getElementById("import-log").textContent += "\nERROR: " + err.message + "\n";
  } finally {
    btn.disabled = false;
  }
});

async function fetchSheetCsv(sheetId, tabName) {
  const url = sheetCsvUrl(sheetId, tabName);
  const res = await fetch(url, { credentials: "omit" });
  if (!res.ok) throw new Error(`Couldn't fetch tab "${tabName}" (HTTP ${res.status}). Make sure the sheet is shared "Anyone with the link can view".`);
  return await res.text();
}

// ----- Claim Sheet parser -----
// Find the header row containing "Claimed By" and "Task Completed". For each
// subsequent row, if Task Completed is truthy, +1 for that Claimed By person.
function parseClaimSheet(rows, log) {
  let headerIdx = -1;
  let claimedCol = -1;
  let completedCol = -1;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i].map((c) => String(c || "").trim().toLowerCase());
    const ci = r.findIndex((c) => c === "claimed by" || c === "claimer" || c === "claimed_by");
    const ti = r.findIndex((c) => c === "task completed" || c === "completed" || c === "task_completed");
    if (ci >= 0 && ti >= 0) {
      headerIdx = i; claimedCol = ci; completedCol = ti; break;
    }
  }
  if (headerIdx < 0) {
    log(`⚠ Claim Sheet: couldn't find "Claimed By" / "Task Completed" header — got 0 counts.`);
    return new Map();
  }
  const counts = new Map(); // key -> { displayName, count }
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row.length) continue;
    const personRaw = row[claimedCol];
    const done = row[completedCol];
    const norm = normalizeName(personRaw);
    if (!norm) continue;
    if (!truthyFlag(done)) continue;
    const k = nameKey(norm);
    if (!counts.has(k)) counts.set(k, { displayName: norm, count: 0 });
    counts.get(k).count += 1;
  }
  // Also include people who appear in Claimed By with zero completions.
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row.length) continue;
    const norm = normalizeName(row[claimedCol]);
    if (!norm) continue;
    const k = nameKey(norm);
    if (!counts.has(k)) counts.set(k, { displayName: norm, count: 0 });
  }
  log(`Claim Sheet: ${counts.size} unique claimers, completed counts:`);
  for (const [, v] of [...counts.entries()].sort((a, b) => a[1].displayName.localeCompare(b[1].displayName))) {
    log(`  ${v.displayName}: ${v.count}`);
  }
  return counts;
}

// ----- Model Decomp Summary parser -----
// The sheet has TWO side-by-side tables both counting tasks done, plus a
// Prompts Done table (which we skip). Scan all rows for header cells that
// contain "task" + ("done"|"completed") and do NOT contain "prompt". For each
// such header, the name column is the column immediately to its left (or, if
// that column's header looks like a name/person label, use it). Read rows
// below that header until a blank-name row; collect (name, count) pairs.
// Group by normalized name and return BOTH per-table results and the max.
function parseModelDecompSummary(rows, log) {
  // Find all candidate task-count header cells.
  const headers = []; // [{rowIdx, col, nameCol, label}]
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] || [];
    for (let c = 0; c < row.length; c++) {
      const raw = String(row[c] || "").trim();
      const low = raw.toLowerCase();
      if (!low) continue;
      if (low.includes("prompt")) continue;
      const hasTask = /task/.test(low);
      const hasDone = /(done|completed|complete)/.test(low);
      if (hasTask && hasDone) {
        // Find name column near it. Walk left from c-1 looking for a non-empty header cell.
        let nameCol = -1;
        for (let cc = c - 1; cc >= Math.max(0, c - 4); cc--) {
          const v = String(row[cc] || "").trim();
          if (!v) continue;
          // Prefer cells that look like a name/person header
          if (/^(name|person|user|decomposer|model decomposer|decomp by|owner|engineer)\b/i.test(v)) {
            nameCol = cc; break;
          }
          // Fall back: any non-empty header cell to the left
          if (nameCol === -1) nameCol = cc;
        }
        if (nameCol === -1) nameCol = Math.max(0, c - 1);
        headers.push({ rowIdx: r, col: c, nameCol, label: raw });
      }
    }
  }
  log(`Model Decomp Summary: detected ${headers.length} task-done header cell(s):`);
  for (const h of headers) log(`  row ${h.rowIdx + 1}, col ${h.col}: "${h.label}" (name col = ${h.nameCol})`);

  // Read each table beneath its header.
  const tables = headers.map((h) => readTableBelow(rows, h.rowIdx, h.nameCol, h.col));

  // Group by normalized name across tables. Preserve per-table counts (for logging),
  // and compute max per person. We also separate the "small" and "big" tables by
  // total volume so the breakdown log mirrors the user's mental model.
  const byKeyPerTable = tables.map((tbl) => {
    const m = new Map();
    for (const e of tbl) {
      const norm = normalizeName(e.name);
      if (!norm) continue;
      const k = nameKey(norm);
      if (!m.has(k)) m.set(k, { displayName: norm, count: 0 });
      m.get(k).count += e.count; // sum within a single table if a name repeats
    }
    return m;
  });

  // Identify smaller vs larger table by total sum.
  const sums = byKeyPerTable.map((m) => [...m.values()].reduce((s, v) => s + v.count, 0));
  let smallIdx = 0, bigIdx = 0;
  if (byKeyPerTable.length >= 2) {
    if (sums[0] <= sums[1]) { smallIdx = 0; bigIdx = 1; } else { smallIdx = 1; bigIdx = 0; }
  } else if (byKeyPerTable.length === 1) {
    smallIdx = 0; bigIdx = 0;
  }
  const smallByKey = byKeyPerTable[smallIdx] || new Map();
  const bigByKey   = byKeyPerTable[bigIdx]   || new Map();

  // Max across all detected tables for each person.
  const maxByKey = new Map();
  const allKeys = new Set();
  byKeyPerTable.forEach((m) => m.forEach((_, k) => allKeys.add(k)));
  for (const k of allKeys) {
    let best = { displayName: null, count: -1 };
    for (const m of byKeyPerTable) {
      const v = m.get(k);
      if (v && v.count > best.count) best = { displayName: v.displayName, count: v.count };
    }
    if (best.count < 0) best = { displayName: k, count: 0 };
    maxByKey.set(k, best);
  }

  log(`Model Decomp Summary: ${allKeys.size} unique decomposers across both tables.`);
  for (const [, v] of [...maxByKey.entries()].sort((a, b) => a[1].displayName.localeCompare(b[1].displayName))) {
    log(`  ${v.displayName}: max=${v.count}`);
  }

  return { smallByKey, bigByKey, maxByKey };
}

// Read (name, count) pairs in a table whose header is at row `headerRow`, with
// the name column at `nameCol` and count column at `countCol`. Stop at the first
// row whose name column is blank for ≥ 2 consecutive rows, or at EOF.
function readTableBelow(rows, headerRow, nameCol, countCol) {
  const out = [];
  let blanks = 0;
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const rawName = (row[nameCol] || "").toString().trim();
    if (!rawName) {
      blanks++;
      if (blanks >= 2) break;
      continue;
    }
    blanks = 0;
    // Skip rows that look like sub-headers
    if (/^(name|person|user|decomposer|owner|total|grand total)$/i.test(rawName)) continue;
    const count = parseCount(row[countCol]);
    out.push({ name: rawName, count });
  }
  return out;
}

// =============================================================================
// Small UI utilities
// =============================================================================

function showToast(msg, kind = "") {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "toast" + (kind ? " " + kind : "");
  t.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { t.hidden = true; }, 3200);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

// =============================================================================
// Boot
// =============================================================================

startListeners();

// Self-tests for week boundary (console-only). Helpful for verifying rollover.
(function selfTests() {
  // NOTE: in 2026, May 18 is a Monday, May 25 is a Monday, May 31 is a Sunday.
  // (HISTORICAL_WEEK_START = "2026-05-19" is used verbatim as the entries'
  // weekStart for the import — even though in the 2026 calendar that exact
  // date falls on Tuesday. The import label "Week of 5/19 – 5/25" is rendered
  // from that literal weekStart, so the user-facing label matches the spec.)
  const cases = [
    ["2026-05-18", "2026-05-18"], // Mon
    ["2026-05-19", "2026-05-18"], // Tue → previous Mon
    ["2026-05-24", "2026-05-18"], // Sun → Mon 5/18
    ["2026-05-25", "2026-05-25"], // Mon
    ["2026-05-26", "2026-05-25"], // Tue
    ["2026-05-31", "2026-05-25"], // Sun → Mon 5/25
    ["2026-06-01", "2026-06-01"], // Mon
  ];
  let ok = true;
  for (const [d, expected] of cases) {
    const got = weekStartFromIso(d);
    if (got !== expected) { ok = false; console.warn(`week boundary FAIL ${d} → ${got}, expected ${expected}`); }
  }
  if (ok) console.log("[tsip] week-boundary self-tests OK");
  console.log("[tsip] current Eastern date:", todayIsoInTz(), "→ weekStart:", currentWeekStart());
})();
