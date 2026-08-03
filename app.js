/* Money Ledger — vanilla JS, no framework, no build step (CLAUDE.md hard rule 2/3). */

const STORAGE_KEY = "money-ledger-v1";
const SCHEMA_VERSION = 1;

// Paste your OAuth Client ID from Google Cloud Console here (see CLAUDE.md).
// It's a public identifier, not a secret — safe to commit.
const GOOGLE_CLIENT_ID = "501903536592-43umsm4o1mm50egfhokbh3qg0d519i3n.apps.googleusercontent.com";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const DRIVE_FILE_NAME = "money-ledger-data.json";

const CURRENCIES = ["DKK", "USD", "EUR", "GBP", "SEK", "NOK", "CHF", "CAD", "AUD", "JPY"];
const CURRENCY_LOCALE = {
  DKK: "da-DK", USD: "en-US", EUR: "en-IE", GBP: "en-GB", SEK: "sv-SE",
  NOK: "nb-NO", CHF: "de-CH", CAD: "en-CA", AUD: "en-AU", JPY: "ja-JP",
};

// Same muted hue family as the hue-slider gradient in hours-ledger-reference.css,
// so a category color picked here reads as part of the same family.
const HUE_STOPS = ["#7A4A45", "#7A6A3A", "#4E7040", "#3A6E70", "#3A4F7A", "#5F3F72", "#7A4A45"];

const SEED_CATEGORIES = [
  { name: "Groceries", direction: "expense", hue: 0.33 },
  { name: "Rent", direction: "expense", hue: 0.67 },
  { name: "Transport", direction: "expense", hue: 0.5 },
  { name: "Subscriptions", direction: "expense", hue: 0.83 },
  { name: "Dining", direction: "expense", hue: 0.17 },
  { name: "Utilities", direction: "expense", hue: 0 },
  { name: "Health", direction: "expense", hue: 0.58 },
  { name: "Other", direction: "expense", hue: 0.42 },
  { name: "Salary", direction: "income", hue: 0.33 },
  { name: "Freelance", direction: "income", hue: 0.5 },
  { name: "Gift", direction: "income", hue: 0.83 },
  { name: "Other", direction: "income", hue: 0.42 },
];

// ---------- storage ----------

function defaultState() {
  return {
    version: SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    settings: { currency: null, introSeen: false, driveConnected: false, driveFileId: null },
    categories: SEED_CATEGORIES.map((c) => ({
      id: uid(), name: c.name, direction: c.direction, hue: c.hue, color: hueColor(c.hue),
    })),
    entries: [],
    subscriptions: [],
  };
}

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return defaultState();
  try {
    const parsed = JSON.parse(raw);
    // No prior schema versions exist yet — this is where a migration would
    // run before any new code reads old data (CLAUDE.md hard rule 1).
    if (!parsed.version) parsed.version = SCHEMA_VERSION;
    // Treat data saved before Drive sync existed as "very old" rather than
    // "now", so it never wins a timestamp comparison against real Drive data.
    if (!parsed.updatedAt) parsed.updatedAt = new Date(0).toISOString();
    return parsed;
  } catch (e) {
    console.error("Money Ledger: corrupt local data, starting fresh", e);
    return defaultState();
  }
}

function saveState() {
  state.updatedAt = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  if (state.settings.driveConnected && driveAccessToken) {
    clearTimeout(saveState._drivePush);
    saveState._drivePush = setTimeout(pushToDrive, 1200);
  }
}

let state = loadState();
let driveAccessToken = null;
let driveTokenClient = null;
let viewMonth = new Date().getMonth();
let viewYear = new Date().getFullYear();
let editingId = null;
let openPickerCatId = null;
let railDir = "expense";

// ---------- utils ----------

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : "id-" + Date.now() + "-" + Math.random().toString(16).slice(2);
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function rgbToHex(r, g, b) {
  return "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
}
function hueColor(t) {
  const n = HUE_STOPS.length - 1;
  const pos = Math.max(0, Math.min(1, t)) * n;
  const i = Math.min(Math.floor(pos), n - 1);
  const frac = pos - i;
  const c1 = hexToRgb(HUE_STOPS[i]), c2 = hexToRgb(HUE_STOPS[i + 1]);
  return rgbToHex(c1.r + (c2.r - c1.r) * frac, c1.g + (c2.g - c1.g) * frac, c1.b + (c2.b - c1.b) * frac);
}

function formatMoney(minor, currency) {
  const locale = CURRENCY_LOCALE[currency] || "en-US";
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(minor / 100);
}

function todayStr() {
  return isoDate(new Date());
}
function isoDate(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function parseIso(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function mondayOf(d) {
  const day = d.getDay();
  const diff = (day + 6) % 7;
  const m = new Date(d);
  m.setDate(d.getDate() - diff);
  return m;
}
function monthLabel(y, m) {
  return new Date(y, m, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" }).toUpperCase();
}

// rows are pre-sorted descending by date (see renderRegister), and already
// clipped to the current month — so the earliest/latest row IS the correct
// range even for a partial week at the start or end of a month.
function weekRangeLabel(rows) {
  const last = parseIso(rows[0].date);
  const first = parseIso(rows[rows.length - 1].date);
  const day = (d) => d.getDate();
  const mon = (d) => d.toLocaleDateString(undefined, { month: "short" }).toUpperCase();
  if (rows[0].date === rows[rows.length - 1].date) return `${day(last)} ${mon(last)}`;
  return `${day(first)}–${day(last)} ${mon(last)}`;
}

function categoriesFor(direction) {
  return state.categories.filter((c) => c.direction === direction);
}
function catById(id) {
  return state.categories.find((c) => c.id === id);
}
function entriesInMonth(y, m) {
  return state.entries.filter((e) => {
    const d = parseIso(e.date);
    return d.getFullYear() === y && d.getMonth() === m;
  });
}

function toast(msg, undoFn) {
  const el = document.getElementById("toast");
  el.querySelector(".msg").textContent = msg;
  const btn = document.getElementById("toastUndo");
  if (undoFn) {
    btn.hidden = false;
    btn.onclick = () => {
      undoFn();
      el.classList.remove("on");
      clearTimeout(toast._t);
    };
  } else {
    btn.hidden = true;
    btn.onclick = null;
  }
  el.classList.add("on");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("on"), 5000);
}

// ---------- intro ----------

function initIntro() {
  const sel = document.getElementById("introCurrency");
  CURRENCIES.forEach((c) => {
    const o = document.createElement("option");
    o.value = c; o.textContent = c;
    sel.appendChild(o);
  });
  const startBtn = document.getElementById("introStart");
  sel.addEventListener("change", () => { startBtn.disabled = !sel.value; });
  startBtn.addEventListener("click", () => {
    if (!sel.value) return;
    state.settings.currency = sel.value;
    state.settings.introSeen = true;
    saveState();
    document.getElementById("introScrim").classList.remove("on");
    renderAll();
  });
  if (!state.settings.introSeen) {
    document.getElementById("introScrim").classList.add("on");
  }
}

// ---------- quick-add ----------

let quickDir = "expense";

function populateCategorySelect(select, direction, selectedId) {
  select.innerHTML = "";
  categoriesFor(direction).forEach((c) => {
    const o = document.createElement("option");
    o.value = c.id; o.textContent = c.name;
    if (c.id === selectedId) o.selected = true;
    select.appendChild(o);
  });
}

function initQuickAdd() {
  const form = document.getElementById("quickaddForm");
  const dirBtns = form.querySelectorAll(".dirtoggle button");
  const catSelect = document.getElementById("qaCategory");
  const dateInput = document.getElementById("qaDate");
  dateInput.value = todayStr();

  function setDir(dir) {
    quickDir = dir;
    dirBtns.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.dir === dir)));
    populateCategorySelect(catSelect, dir);
  }
  dirBtns.forEach((b) => b.addEventListener("click", () => setDir(b.dataset.dir)));
  setDir("expense");

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const amountVal = parseFloat(document.getElementById("qaAmount").value);
    if (!amountVal || amountVal <= 0) return;
    const entry = {
      id: uid(),
      date: dateInput.value || todayStr(),
      amountMinor: Math.round(amountVal * 100),
      direction: quickDir,
      categoryId: catSelect.value,
      note: document.getElementById("qaNote").value.trim(),
      recurringId: null,
    };
    state.entries.push(entry);
    saveState();
    document.getElementById("qaAmount").value = "";
    document.getElementById("qaNote").value = "";
    toast((quickDir === "income" ? "Income" : "Expense") + " logged");
    renderAll();
  });
}

// ---------- edit sheet ----------

function openEditSheet(entryId) {
  editingId = entryId;
  const e = state.entries.find((x) => x.id === entryId);
  const scrim = document.getElementById("editScrim");
  const dirBtns = scrim.querySelectorAll(".dirtoggle button");
  const catSelect = document.getElementById("editCategory");

  function setDir(dir) {
    dirBtns.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.dir === dir)));
    populateCategorySelect(catSelect, dir, e.categoryId);
  }
  dirBtns.forEach((b) => { b.onclick = () => setDir(b.dataset.dir); });

  setDir(e.direction);
  document.getElementById("editAmount").value = (e.amountMinor / 100).toFixed(2);
  document.getElementById("editDate").value = e.date;
  document.getElementById("editNote").value = e.note || "";
  scrim.classList.add("on");
}

function closeEditSheet() {
  editingId = null;
  document.getElementById("editScrim").classList.remove("on");
}

function initEditSheet() {
  const scrim = document.getElementById("editScrim");
  document.getElementById("editCancel").addEventListener("click", closeEditSheet);
  scrim.addEventListener("click", (e) => { if (e.target === scrim) closeEditSheet(); });

  document.getElementById("editForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const entry = state.entries.find((x) => x.id === editingId);
    if (!entry) return;
    const dir = scrim.querySelector('.dirtoggle button[aria-pressed="true"]').dataset.dir;
    const amountVal = parseFloat(document.getElementById("editAmount").value);
    if (!amountVal || amountVal <= 0) return;
    entry.direction = dir;
    entry.amountMinor = Math.round(amountVal * 100);
    entry.categoryId = document.getElementById("editCategory").value;
    entry.date = document.getElementById("editDate").value;
    entry.note = document.getElementById("editNote").value.trim();
    saveState();
    closeEditSheet();
    toast("Entry updated");
    renderAll();
  });

  document.getElementById("editDelete").addEventListener("click", () => {
    if (!editingId) return;
    if (!confirm("Delete this entry?")) return;
    const idx = state.entries.findIndex((x) => x.id === editingId);
    const removed = state.entries[idx];
    state.entries.splice(idx, 1);
    saveState();
    closeEditSheet();
    toast("Entry deleted", () => {
      state.entries.splice(idx, 0, removed);
      saveState();
      renderAll();
    });
    renderAll();
  });
}

// ---------- month nav ----------

function initMonthNav() {
  document.getElementById("prevMonth").addEventListener("click", () => {
    viewMonth--; if (viewMonth < 0) { viewMonth = 11; viewYear--; }
    renderAll();
  });
  document.getElementById("nextMonth").addEventListener("click", () => {
    viewMonth++; if (viewMonth > 11) { viewMonth = 0; viewYear++; }
    renderAll();
  });
}

// ---------- rendering: register ----------

function renderRegister() {
  const box = document.getElementById("register");
  const entries = entriesInMonth(viewYear, viewMonth).slice().sort((a, b) => (a.date < b.date ? 1 : -1));

  if (entries.length === 0) {
    box.innerHTML = '<div class="register-empty">Nothing logged yet this month.<br>Use the form above — it takes a few seconds.</div>';
    return;
  }

  const weeks = new Map(); // mondayIso -> entries[]
  entries.forEach((e) => {
    const key = isoDate(mondayOf(parseIso(e.date)));
    if (!weeks.has(key)) weeks.set(key, []);
    weeks.get(key).push(e);
  });
  const weekKeys = Array.from(weeks.keys()).sort().reverse();

  const currency = state.settings.currency;
  let html = "";
  weekKeys.forEach((wk) => {
    const rows = weeks.get(wk);
    let inc = 0, exp = 0;
    rows.forEach((e) => (e.direction === "income" ? (inc += e.amountMinor) : (exp += e.amountMinor)));
    const label = weekRangeLabel(rows);
    html += `<div class="weekhead"><b>${label}</b><span>IN ${formatMoney(inc, currency)} · OUT ${formatMoney(exp, currency)}</span></div>`;
    rows.forEach((e) => {
      const cat = catById(e.categoryId);
      const d = parseIso(e.date);
      const dateStr = d.toLocaleDateString(undefined, { month: "2-digit", day: "2-digit" });
      const amtClass = e.direction === "income" ? "income" : "";
      const sign = e.direction === "income" ? "+" : "−";
      html += `<button type="button" class="entryrow" data-id="${e.id}">
        <span class="date">${dateStr}</span>
        <span class="dot" style="background:${cat ? cat.color : "var(--none)"}"></span>
        <span class="meta">
          <span class="cat">${cat ? escapeHtml(cat.name) : "Uncategorized"}</span>
          ${e.note ? `<span class="note">${escapeHtml(e.note)}</span>` : ""}
        </span>
        <span class="amt ${amtClass}">${sign}${formatMoney(e.amountMinor, currency)}</span>
      </button>`;
    });
  });
  box.innerHTML = html;

  box.querySelectorAll(".entryrow").forEach((row) => {
    row.addEventListener("click", () => openEditSheet(row.dataset.id));
  });
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

// ---------- rendering: summary ----------

function renderSummary() {
  const entries = entriesInMonth(viewYear, viewMonth);
  let inc = 0, exp = 0;
  entries.forEach((e) => (e.direction === "income" ? (inc += e.amountMinor) : (exp += e.amountMinor)));
  const net = inc - exp;
  const currency = state.settings.currency;
  const pct = inc > 0 ? Math.min(100, (exp / inc) * 100) : exp > 0 ? 100 : 0;
  const over = inc > 0 && exp > inc;

  document.getElementById("summaryBox").innerHTML = `
    <div class="summary-row income"><span>Income</span><b>${formatMoney(inc, currency)}</b></div>
    <div class="summary-row"><span>Expenses</span><b>${formatMoney(exp, currency)}</b></div>
    <div class="summary-row net"><span>Net</span><b class="${net < 0 ? "neg" : ""}">${formatMoney(net, currency)}</b></div>
    <div class="summary-bar"><i class="${over ? "over" : "spent"}" style="width:${pct}%"></i></div>
  `;
}

// ---------- rendering: category rail ----------

function renderCategoryRail() {
  document.querySelectorAll("#railDirToggle button").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.dir === railDir));
  });

  const entries = entriesInMonth(viewYear, viewMonth).filter((e) => e.direction === railDir);
  const totals = new Map();
  entries.forEach((e) => totals.set(e.categoryId, (totals.get(e.categoryId) || 0) + e.amountMinor));
  const cats = categoriesFor(railDir).slice().sort((a, b) => (totals.get(b.id) || 0) - (totals.get(a.id) || 0));
  const maxTotal = Math.max(1, ...cats.map((c) => totals.get(c.id) || 0));
  const currency = state.settings.currency;

  const list = document.getElementById("catList");
  list.innerHTML = "";
  cats.forEach((c) => {
    const total = totals.get(c.id) || 0;
    const pct = (total / maxTotal) * 100;
    const row = document.createElement("div");
    row.className = "cat";
    row.dataset.id = c.id;
    row.innerHTML = `
      <button type="button" class="sw" style="background:${c.color}" title="Change color"></button>
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:8px">
          <input class="nm" value="${escapeHtml(c.name)}">
          <span style="font-family:var(--mono);font-size:12px;font-weight:600;white-space:nowrap">${formatMoney(total, currency)}</span>
        </div>
        <div class="tot-bar"><i style="width:${pct}%;background:${c.color}"></i></div>
      </div>
      <button type="button" class="del" title="Delete category">×</button>
      <div class="picker" hidden>
        <div class="presets"></div>
        <input type="range" class="hue" min="0" max="1000" value="${Math.round(c.hue * 1000)}">
        <span class="pickhint">Drag to pick a color</span>
      </div>
    `;
    list.appendChild(row);

    const nmInput = row.querySelector(".nm");
    nmInput.addEventListener("change", () => {
      c.name = nmInput.value.trim() || c.name;
      saveState();
      renderAll();
    });

    row.querySelector(".del").addEventListener("click", () => {
      const inUse = state.entries.some((e) => e.categoryId === c.id);
      if (inUse && !confirm(`"${c.name}" has entries logged against it. Delete it anyway? Those entries will show as Uncategorized.`)) return;
      const idx = state.categories.findIndex((x) => x.id === c.id);
      const removed = state.categories[idx];
      if (openPickerCatId === c.id) openPickerCatId = null;
      state.categories.splice(idx, 1);
      saveState();
      toast(`"${removed.name}" deleted`, () => {
        state.categories.splice(idx, 0, removed);
        saveState();
        renderAll();
      });
      renderAll();
    });

    const picker = row.querySelector(".picker");
    const swBtn = row.querySelector(".sw");
    swBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const isOpen = openPickerCatId === c.id;
      openPickerCatId = isOpen ? null : c.id;
      renderCategoryRail();
    });
    if (openPickerCatId === c.id) {
      picker.hidden = false;
      picker.addEventListener("click", (e) => e.stopPropagation());
      const presets = row.querySelector(".presets");
      HUE_STOPS.slice(0, -1).forEach((hex, i) => {
        const b = document.createElement("button");
        b.type = "button";
        b.style.background = hex;
        b.addEventListener("click", () => {
          c.hue = i / (HUE_STOPS.length - 1);
          c.color = hex;
          saveState();
          renderAll();
        });
        presets.appendChild(b);
      });
      const hueInput = row.querySelector(".hue");
      hueInput.addEventListener("input", () => {
        c.hue = Number(hueInput.value) / 1000;
        c.color = hueColor(c.hue);
        swBtn.style.background = c.color;
      });
      hueInput.addEventListener("change", () => {
        saveState();
        renderAll();
      });
    }
  });

  document.getElementById("catCount").textContent = cats.length ? formatMoney(cats.reduce((s, c) => s + (totals.get(c.id) || 0), 0), currency) : "—";
}

function initCategoryRail() {
  document.querySelectorAll("#railDirToggle button").forEach((b) => {
    b.addEventListener("click", () => { railDir = b.dataset.dir; openPickerCatId = null; renderCategoryRail(); });
  });
  // Swatch clicks and clicks inside an open picker stop propagation (above),
  // so any click that reaches here is genuinely outside the open picker's row.
  document.addEventListener("click", (e) => {
    if (!openPickerCatId) return;
    const row = document.querySelector(`.cat[data-id="${openPickerCatId}"]`);
    if (row && !row.contains(e.target)) {
      openPickerCatId = null;
      renderCategoryRail();
    }
  });
  document.getElementById("addCatForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("newCatName");
    const name = input.value.trim();
    if (!name) return;
    const hue = Math.random();
    state.categories.push({ id: uid(), name, direction: railDir, hue, color: hueColor(hue) });
    saveState();
    input.value = "";
    renderAll();
  });
}

// ---------- settings / sync ----------

function initSettings() {
  const sel = document.getElementById("currencySelect");
  const placeholder = document.createElement("option");
  placeholder.value = ""; placeholder.textContent = "—";
  placeholder.disabled = true;
  sel.appendChild(placeholder);
  CURRENCIES.forEach((c) => {
    const o = document.createElement("option");
    o.value = c; o.textContent = c;
    sel.appendChild(o);
  });
  sel.addEventListener("change", () => {
    state.settings.currency = sel.value;
    saveState();
    renderAll();
  });

  document.getElementById("driveConnectBtn").addEventListener("click", handleDriveButtonClick);

  document.getElementById("clearDataBtn").addEventListener("click", () => {
    const label = monthLabel(viewYear, viewMonth);
    const monthEntries = entriesInMonth(viewYear, viewMonth);
    if (monthEntries.length === 0) {
      toast("Nothing logged in " + label + " yet.");
      return;
    }
    if (!confirm(`Delete all ${monthEntries.length} ${monthEntries.length === 1 ? "entry" : "entries"} logged in ${label}?`)) return;
    const removedIds = new Set(monthEntries.map((e) => e.id));
    const removed = state.entries.filter((e) => removedIds.has(e.id));
    state.entries = state.entries.filter((e) => !removedIds.has(e.id));
    saveState();
    toast(label + " cleared", () => {
      state.entries = state.entries.concat(removed);
      saveState();
      renderAll();
    });
    renderAll();
  });
}

function renderSettings() {
  document.getElementById("currencySelect").value = state.settings.currency;
  const statusEl = document.getElementById("syncStatus");
  const btn = document.getElementById("driveConnectBtn");
  if (state.settings.driveConnected && driveAccessToken) {
    statusEl.className = "status";
    statusEl.querySelector(".label").textContent = "Synced to Drive";
    btn.textContent = "Disconnect Google Drive";
  } else if (state.settings.driveConnected && !driveAccessToken) {
    statusEl.className = "status stale";
    statusEl.querySelector(".label").textContent = "Drive connected — needs reconnect";
    btn.textContent = "Reconnect Google Drive";
  } else {
    statusEl.className = "status off";
    statusEl.querySelector(".label").textContent = "Local only, this device";
    btn.textContent = "Connect Google Drive";
  }
}

// ---------- Google Drive sync (opt-in; see CLAUDE.md hard rule 4) ----------
//
// Uses drive.file scope: this app can only ever see files it created itself,
// never the rest of a user's Drive. Sync is one JSON file, found-or-created
// on first connect, pushed on every save, pulled on reconnect.

function driveIsConfigured() {
  return !!GOOGLE_CLIENT_ID && typeof google !== "undefined" && google.accounts && google.accounts.oauth2;
}

function driveTokenClientFor(callback) {
  if (!driveTokenClient) {
    driveTokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: DRIVE_SCOPE,
      callback,
    });
  } else {
    driveTokenClient.callback = callback;
  }
  return driveTokenClient;
}

async function driveFindFile() {
  const q = encodeURIComponent(`name='${DRIVE_FILE_NAME}' and trashed=false`);
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,name)`, {
    headers: { Authorization: `Bearer ${driveAccessToken}` },
  });
  if (!res.ok) throw new Error("drive-list-" + res.status);
  const data = await res.json();
  return (data.files && data.files[0]) || null;
}

async function driveCreateFile(contentStr) {
  const boundary = "money_ledger_boundary";
  const metadata = { name: DRIVE_FILE_NAME, mimeType: "application/json" };
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${contentStr}\r\n--${boundary}--`;
  const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
    method: "POST",
    headers: { Authorization: `Bearer ${driveAccessToken}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new Error("drive-create-" + res.status);
  const data = await res.json();
  return data.id;
}

async function driveUpdateFile(fileId, contentStr) {
  const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${driveAccessToken}`, "Content-Type": "application/json" },
    body: contentStr,
  });
  if (!res.ok) throw new Error("drive-update-" + res.status);
}

async function driveReadFile(fileId) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${driveAccessToken}` },
  });
  if (!res.ok) throw new Error("drive-read-" + res.status);
  return res.json();
}

async function pushToDrive() {
  if (!state.settings.driveConnected || !state.settings.driveFileId || !driveAccessToken) return;
  try {
    await driveUpdateFile(state.settings.driveFileId, JSON.stringify(state));
  } catch (err) {
    if (String(err.message).includes("401")) {
      driveTokenClientFor((resp) => {
        if (!resp.error) {
          driveAccessToken = resp.access_token;
          driveUpdateFile(state.settings.driveFileId, JSON.stringify(state)).catch((e) => console.error(e));
        } else {
          driveAccessToken = null;
          renderSettings();
        }
      }).requestAccessToken({ prompt: "" });
    } else {
      console.error(err);
    }
  }
}

async function resolveDriveFile() {
  const existing = state.settings.driveFileId ? { id: state.settings.driveFileId } : await driveFindFile();

  if (!existing) {
    const fileId = await driveCreateFile(JSON.stringify(state));
    state.settings.driveFileId = fileId;
    state.settings.driveConnected = true;
    saveState();
    toast("Connected — this device's data is now on Drive.");
    renderAll();
    return;
  }

  state.settings.driveFileId = existing.id;
  const remote = await driveReadFile(existing.id);
  const localIsUntouched = state.entries.length === 0;

  if (localIsUntouched && remote && (remote.entries || []).length > 0) {
    state = remote;
    state.settings.driveFileId = existing.id;
    state.settings.driveConnected = true;
    saveState();
    toast("Loaded your data from Drive.");
  } else if (remote && remote.updatedAt > state.updatedAt) {
    const takeRemote = confirm(
      "Drive has newer data than this device. Load it? Anything logged on this device since it last synced will be replaced."
    );
    if (takeRemote) {
      state = remote;
      state.settings.driveFileId = existing.id;
    }
    state.settings.driveConnected = true;
    saveState();
  } else {
    state.settings.driveConnected = true;
    saveState();
  }
  renderAll();
}

function connectDrive() {
  driveTokenClientFor(async (resp) => {
    if (resp.error) {
      toast("Google Drive connection was cancelled or failed.");
      return;
    }
    driveAccessToken = resp.access_token;
    try {
      await resolveDriveFile();
    } catch (err) {
      console.error(err);
      toast("Couldn't reach Google Drive. Try again in a moment.");
    }
  }).requestAccessToken({ prompt: "consent" });
}

function reconnectDrive() {
  driveTokenClientFor((resp) => {
    if (resp.error) {
      toast("Reconnect failed — try again.");
      return;
    }
    driveAccessToken = resp.access_token;
    toast("Reconnected to Drive.");
    renderAll();
  }).requestAccessToken({ prompt: "" });
}

function disconnectDrive() {
  driveAccessToken = null;
  state.settings.driveConnected = false;
  saveState();
  toast("Disconnected. Nothing was deleted — your data stays on this device and on Drive.");
  renderAll();
}

function handleDriveButtonClick() {
  if (!driveIsConfigured()) {
    toast("Google Drive sync isn't configured yet — needs a Google Cloud OAuth client ID.");
    return;
  }
  if (state.settings.driveConnected && driveAccessToken) {
    disconnectDrive();
  } else if (state.settings.driveConnected && !driveAccessToken) {
    reconnectDrive();
  } else {
    connectDrive();
  }
}

function initDriveSilentReconnect() {
  if (!driveIsConfigured() || !state.settings.driveConnected) return;
  driveTokenClientFor((resp) => {
    if (!resp.error) {
      driveAccessToken = resp.access_token;
      resolveDriveFile().catch((err) => console.error(err));
    } else {
      renderSettings();
    }
  }).requestAccessToken({ prompt: "" });
}

// ---------- fab ----------

function initFab() {
  document.getElementById("fab").addEventListener("click", () => {
    document.getElementById("quickadd").scrollIntoView({ behavior: "smooth", block: "start" });
    document.getElementById("qaAmount").focus();
  });
}

// ---------- render all ----------

function renderAll() {
  if (!state.settings.currency) return;
  document.getElementById("monthLabel").textContent = monthLabel(viewYear, viewMonth);
  renderSummary();
  renderRegister();
  renderCategoryRail();
  renderSettings();
}

// ---------- init ----------

document.addEventListener("DOMContentLoaded", () => {
  initIntro();
  initQuickAdd();
  initEditSheet();
  initMonthNav();
  initCategoryRail();
  initSettings();
  initFab();
  if (state.settings.currency) renderAll();
  initDriveSilentReconnect();
});
