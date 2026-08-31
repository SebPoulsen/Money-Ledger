/* Money Ledger — vanilla JS, no framework, no build step (CLAUDE.md hard rule 2/3). */

// money-ledger-selftest.html loads this page with ?mltest=1 in a hidden
// iframe. TEST_MODE isolates storage under a different key, replaces the
// Drive network calls with an in-memory stub so a test run structurally
// cannot reach a real Drive file, stubs confirm() so dialogs don't hang a
// headless run, and exposes window.__ML_TEST__ — see "Testing" in CLAUDE.md.
const TEST_MODE = new URLSearchParams(location.search).get("mltest") === "1";
if (TEST_MODE) {
  window.confirm = function () { return true; };
}

const STORAGE_KEY = "money-ledger-v1" + (TEST_MODE ? "-TESTMODE" : "");
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

// Fixed ids, not uid()-generated: two separate devices both freshly seed
// their own copy of this list on first launch, and if "Groceries" got a
// random id on each device, merging would see two unrelated records and
// duplicate every seed category on first connect instead of recognizing
// them as the same one.
const SEED_CATEGORIES = [
  { id: "seed-groceries", name: "Groceries", direction: "expense", hue: 0.33 },
  { id: "seed-rent", name: "Rent", direction: "expense", hue: 0.67 },
  { id: "seed-transport", name: "Transport", direction: "expense", hue: 0.5 },
  { id: "seed-subscriptions", name: "Subscriptions", direction: "expense", hue: 0.83 },
  { id: "seed-dining", name: "Dining", direction: "expense", hue: 0.17 },
  { id: "seed-utilities", name: "Utilities", direction: "expense", hue: 0 },
  { id: "seed-health", name: "Health", direction: "expense", hue: 0.58 },
  { id: "seed-other-expense", name: "Other", direction: "expense", hue: 0.42 },
  { id: "seed-salary", name: "Salary", direction: "income", hue: 0.33 },
  { id: "seed-freelance", name: "Freelance", direction: "income", hue: 0.5 },
  { id: "seed-gift", name: "Gift", direction: "income", hue: 0.83 },
  { id: "seed-other-income", name: "Other", direction: "income", hue: 0.42 },
];

// Seed categories are stamped with this fixed ancient time, NOT nowIso(),
// so a fresh re-seed (empty/reset localStorage → defaultState()) can never
// out-rank a real tombstone or a real edit from another device during a
// merge. "Now" always beats "months ago" — which is exactly how a pristine
// re-seed used to silently resurrect a category someone had deleted long
// ago, then push that resurrection back to Drive. `sameContent` ignores
// updatedAt, so two genuinely-fresh devices still merge to one copy each
// (no duplication); only a real content conflict ever consults this, and
// there a pristine seed *should* lose. Matches the "treat pre-sync data as
// very old" convention already used in loadState() below. See CLAUDE.md
// "seed category resurrection".
const SEED_UPDATED_AT = new Date(0).toISOString();

// ---------- storage ----------

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: SCHEMA_VERSION,
    updatedAt: nowIso(),
    settings: {
      currency: null, introSeen: false, driveConnected: false, driveFileId: null,
      budgetRingColors: { income: null, net: null, expenses: null },
      // Bumped only when budgetRingColors itself changes — the one
      // Settings field that's a genuine cross-device preference rather
      // than this device's own connection state (driveConnected/
      // driveFileId/introSeen never come from remote). Lets syncNow()
      // last-write-win on this one field without needing a full
      // record/tombstone shape for the rest of Settings.
      budgetRingColorsUpdatedAt: null,
    },
    categories: SEED_CATEGORIES.map((c) => ({
      id: c.id, name: c.name, direction: c.direction, hue: c.hue, color: hueColor(c.hue),
      budgetMinor: null,
      updatedAt: SEED_UPDATED_AT, updatedBy: DEVICE_ID, deleted: false, deletedAt: null,
    })),
    entries: [],
    recurring: [],
  };
}

// Every Entry/Category carries its own updatedAt + deleted/deletedAt tombstone
// fields — sync merges record-by-record using these, never by comparing or
// replacing the whole file (CLAUDE.md hard rule 6).
function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    // No stored ledger — first install, or the state key was cleared/
    // evicted while a device id survived. Either way this is effectively a
    // new device: give it a fresh identity so merge can't later mistake a
    // pristine re-seed for "my own earlier record" via the remoteIsMine
    // short-circuit (see the corrupt-data branch below and CLAUDE.md "seed
    // category resurrection"). On a genuine first install the id generated
    // moments ago has no meaning yet, so replacing it costs nothing.
    regenerateDeviceId();
    return defaultState();
  }
  try {
    const parsed = JSON.parse(raw);
    // No prior schema versions exist yet — this is where a migration would
    // run before any new code reads old data (CLAUDE.md hard rule 1).
    if (!parsed.version) parsed.version = SCHEMA_VERSION;
    // Treat data saved before Drive sync existed as "very old" rather than
    // "now", so it never wins a timestamp comparison against real Drive data.
    if (!parsed.updatedAt) parsed.updatedAt = new Date(0).toISOString();
    (parsed.entries || []).forEach((e) => backfillRecordFields(e, parsed.updatedAt));
    (parsed.categories || []).forEach((c) => {
      backfillRecordFields(c, parsed.updatedAt);
      if (c.budgetMinor === undefined) c.budgetMinor = null; // category-only field, phase 2
    });
    // Was `subscriptions` (always an unused empty array — the feature
    // hadn't shipped yet) before backlog #3 renamed it to match
    // Entry.recurringId. Real saves only ever had `subscriptions: []`, so
    // this is a plain rename, not a data-carrying migration.
    parsed.recurring = parsed.recurring || parsed.subscriptions || [];
    delete parsed.subscriptions;
    parsed.recurring.forEach((r) => backfillRecordFields(r, parsed.updatedAt));
    return parsed;
  } catch (e) {
    console.error("Money Ledger: corrupt local data, starting fresh", e);
    // A device whose stored ledger is unreadable has genuinely lost its
    // history — and with it, any basis for merge to trust "this looks like
    // my own earlier push" (the remoteIsMine short-circuit in mergeRecords).
    // Give it a new identity so a fresh re-seed can't be mistaken for a
    // deliberate un-delete of a category this same DEVICE_ID once tombstoned.
    // See CLAUDE.md "seed category resurrection".
    regenerateDeviceId();
    return defaultState();
  }
}

function backfillRecordFields(record, fallbackUpdatedAt) {
  if (!record.updatedAt) record.updatedAt = fallbackUpdatedAt;
  // Unknown authorship — treated conservatively as "not this device" by
  // mergeRecords, same as any other device's edit (ambiguity window applies).
  if (record.updatedBy === undefined) record.updatedBy = null;
  if (record.deleted === undefined) record.deleted = false;
  if (record.deletedAt === undefined) record.deletedAt = null;
}

function saveState() {
  state.updatedAt = nowIso();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  if (state.settings.driveConnected && driveAccessToken) {
    clearTimeout(saveState._drivePush);
    saveState._drivePush = setTimeout(() => syncNow(false), 1200);
  }
}

// Identifies this browser profile, not this ledger — deliberately kept out
// of `state` so it's never overwritten by a pull from Drive. Lets merge
// tell "stale copy of my own last push" (no real ambiguity, my own clock
// ordering of my own actions is never in question) apart from "another
// device's edit" (where clock skew is a genuine concern). See mergeRecords.
// Declared before loadState() runs below — defaultState()'s seed
// categories need it.
const DEVICE_ID_KEY = "money-ledger-device-id" + (TEST_MODE ? "-TESTMODE" : "");
let DEVICE_ID = localStorage.getItem(DEVICE_ID_KEY);
if (!DEVICE_ID) {
  DEVICE_ID = uid();
  localStorage.setItem(DEVICE_ID_KEY, DEVICE_ID);
}

// Called by loadState() whenever it falls back to defaultState() (missing
// or corrupt stored ledger). A device with no history has no basis to be
// recognised by merge as "me" — keeping a stale id there is what let a
// re-seed's category slip past the remoteIsMine check and undo a real
// delete. See CLAUDE.md "seed category resurrection".
function regenerateDeviceId() {
  DEVICE_ID = uid();
  localStorage.setItem(DEVICE_ID_KEY, DEVICE_ID);
}

let state = loadState();
let driveAccessToken = null;
let driveTokenClient = null;

// "Tap anywhere to reconnect": one attempt per token-expired episode. A
// capture-phase pointerdown on document (see resolveGestureReconnect) lets
// the next real tap anywhere resolve a needed Drive reconnect, without
// swallowing that tap. In-memory only — never persisted, never synced,
// cleared on reload. Stays true through a dismissed/failed/timed-out
// attempt so one dismissal doesn't reprompt on the very next tap; reset to
// false only when a token is actually obtained, so a LATER, separate expiry
// in the same session still resolves itself on a tap.
let driveReconnectAttempted = false;

// Caches the access token across page reloads, with its own expiry, so a
// reload within the same ~hour doesn't force a fresh Google sign-in.
// Google only issues refresh tokens (the usual "stay logged in" mechanism)
// through the server-side OAuth flow, which needs a backend to hold a
// client secret — building that would route Drive access through
// infrastructure I control, which is exactly what hard rule 4 forbids. This
// is the best a pure static site can do: a real bearer token sitting in
// localStorage, scoped to drive.file and expiring on its own in ~1hr — a
// real credential, not nothing, kept isolated from `state`/synced data for
// the same reason DEVICE_ID is.
const DRIVE_TOKEN_CACHE_KEY = "money-ledger-drive-token" + (TEST_MODE ? "-TESTMODE" : "");
// Treat a token as unusable a little before its real expiry, so we don't
// hand a nearly-dead token to a sync call that's about to start.
const DRIVE_TOKEN_SAFETY_MARGIN_MS = 60000;

function saveDriveTokenCache(token, expiresInSeconds) {
  const expiresAt = Date.now() + expiresInSeconds * 1000;
  localStorage.setItem(DRIVE_TOKEN_CACHE_KEY, JSON.stringify({ token, expiresAt }));
}

function loadDriveTokenCache() {
  const raw = localStorage.getItem(DRIVE_TOKEN_CACHE_KEY);
  if (!raw) return null;
  try {
    const cached = JSON.parse(raw);
    if (!cached.token || !cached.expiresAt) return null;
    if (Date.now() > cached.expiresAt - DRIVE_TOKEN_SAFETY_MARGIN_MS) return null; // expired or too close to it
    return cached;
  } catch (e) {
    return null;
  }
}

function clearDriveTokenCache() {
  localStorage.removeItem(DRIVE_TOKEN_CACHE_KEY);
}

// In-memory stand-in for Drive, used only when TEST_MODE is on — see the
// TEST_MODE branch at the top of each drive*File function below. Exposed
// directly on the test hook so a test can plant "what's already on Drive"
// before driving a device's real sync flow, or inspect what got pushed.
let FAKE_DRIVE = {};
let fakeDriveNextId = 1;
let viewMonth = new Date().getMonth();
let viewYear = new Date().getFullYear();
let editingId = null;
let editingRecurringId = null;
let openPickerCatId = null;
let openBcPickerKey = null;
// Drives both the register list and the category rail beside it — one
// toggle, moved to the Register panel-label, since the two must never show
// conflicting directions on the same screen.
let viewDir = "expense";

// Opt-in category filter for the register (see "category-filter" work).
// View-state only — a set of category ids to narrow the visible rows to;
// empty means "show everything" (baseline, unchanged). Never persisted,
// never synced, reset on reload — same discipline as viewDir/recurringDir.
// Cleared whenever the direction toggle flips, since expense and income
// categories are disjoint. recurringCatFilter is the Recurring screen's
// own independent equivalent.
const registerCatFilter = new Set();
const recurringCatFilter = new Set();

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

// Compact display for the budget circles: no decimals, no currency symbol —
// a headline figure, not a precise one. formatMoney (with currency + decimals
// where they matter) is still used everywhere else.
function formatCompact(minor, currency) {
  const locale = CURRENCY_LOCALE[currency] || "en-US";
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(Math.round(minor / 100));
}

function setRingPct(arcId, r, pct) {
  const arc = document.getElementById(arcId);
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, pct));
  arc.style.strokeDasharray = String(c);
  arc.style.strokeDashoffset = String(c * (1 - clamped / 100));
}

// Fixed circle→element-id lookup, since (unlike category rows) the three
// budget rings are static DOM, wired once in initBudgetView and only
// updated per-render, not rebuilt.
const RING_KEYS = {
  income: { sw: "bcIncomeSw", picker: "bcIncomePicker", num: "bcIncome", arc: "bcIncomeArc" },
  net: { sw: "bcNetSw", picker: "bcNetPicker", num: "bcNet", arc: "bcNetArc" },
  expenses: { sw: "bcExpensesSw", picker: "bcExpensesPicker", num: "bcExpenses", arc: "bcExpensesArc" },
};

// Applies the ring's colour: a user-chosen custom colour when set, else the
// default ink — but `isBad` (over budget / negative net) always wins and
// forces --flag, regardless of any custom colour. Red keeps meaning exactly
// one thing on this screen (Budget design decisions) even after
// customization — it's not a colour choice, it's a warning.
function applyRingColor(key, isBad) {
  const { arc } = RING_KEYS[key];
  const arcEl = document.getElementById(arc);
  arcEl.classList.toggle("flag", isBad);
  const custom = (state.settings.budgetRingColors || {})[key];
  arcEl.style.stroke = !isBad && custom ? custom.color : "";
}

// Parses a decimal amount string (from an <input type=number> field) into
// integer minor units in one place — every caller rounds through this same
// single Math.round(), so float drift can't creep in differently at three
// separate call sites. Returns null for empty/invalid/non-positive input;
// callers decide what null means for them (bail out of a submit, or "no
// budget set" for the budget field).
function parseAmountToMinor(str) {
  const val = parseFloat(str);
  if (!str || !str.trim() || isNaN(val) || val <= 0) return null;
  return Math.round(val * 100);
}

// Income/expense split + net for a set of entries — shared by the Summary
// panel and the Budget circles, which previously computed this identically
// in two places.
function monthTotals(entries) {
  let income = 0, expenses = 0;
  entries.forEach((e) => (e.direction === "income" ? (income += e.amountMinor) : (expenses += e.amountMinor)));
  return { income, expenses, net: income - expenses };
}

// Sums amountMinor per categoryId for a set of entries (caller filters by
// direction first) — shared by the category rail and the Budget category
// list, which previously built this same Map identically in two places.
function sumByCategory(entries) {
  const totals = new Map();
  entries.forEach((e) => totals.set(e.categoryId, (totals.get(e.categoryId) || 0) + e.amountMinor));
  return totals;
}

function formatMoney(minor, currency) {
  const locale = CURRENCY_LOCALE[currency] || "en-US";
  const isWhole = minor % 100 === 0;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: isWhole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(minor / 100);
}

// Pre-fills an editable amount field: no currency, no forced decimals on
// a whole number ("4000" not "4000.00") — matches formatMoney's decimal-
// hiding rule. Editable fields originally kept a fixed two-decimal string
// deliberately (a stable format to type into); reversed 2026-08-12 after
// it read as simply wrong on whole amounts, in the budget field, the
// edit-entry sheet, and the recurring amount field alike.
function amountInputValue(minor) {
  const isWhole = minor % 100 === 0;
  return isWhole ? String(minor / 100) : (minor / 100).toFixed(2);
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
  return state.categories.filter((c) => c.direction === direction && !c.deleted);
}
function catById(id) {
  return state.categories.find((c) => c.id === id && !c.deleted);
}
function entriesInMonth(y, m) {
  return state.entries.filter((e) => {
    if (e.deleted) return false;
    const d = parseIso(e.date);
    return d.getFullYear() === y && d.getMonth() === m;
  });
}

// Undoable toasts (deletes) run in two phases, same pattern as Hours
// Ledger: the full message + Undo button for UNDO_FULL_MS, then just the
// Undo button alone (message hidden, toast shrinks to fit) for an extra
// UNDO_COMPACT_MS, so the undo window outlasts the message without
// permanently claiming screen space. Plain informational toasts (no
// undoFn) stay single-phase.
const UNDO_FULL_MS = 4500;
const UNDO_COMPACT_MS = 6500;

function toast(msg, undoFn) {
  const el = document.getElementById("toast");
  el.querySelector(".msg").textContent = msg;
  el.classList.remove("compact");
  const btn = document.getElementById("toastUndo");
  clearTimeout(toast._compactTimer);
  clearTimeout(toast._dismissTimer);
  if (undoFn) {
    btn.hidden = false;
    btn.onclick = () => {
      undoFn();
      el.classList.remove("on", "compact");
      btn.hidden = true; // otherwise this stays in the DOM (just off-screen) forever after the first undo toast
      clearTimeout(toast._compactTimer);
      clearTimeout(toast._dismissTimer);
    };
    toast._compactTimer = setTimeout(() => el.classList.add("compact"), UNDO_FULL_MS);
    toast._dismissTimer = setTimeout(() => {
      el.classList.remove("on", "compact");
      btn.hidden = true;
    }, UNDO_FULL_MS + UNDO_COMPACT_MS);
  } else {
    btn.hidden = true;
    btn.onclick = null;
    toast._dismissTimer = setTimeout(() => el.classList.remove("on"), 5000);
  }
  el.classList.add("on");
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

// ---------- mutations ----------
//
// Single source of truth for creating/editing/deleting entries and
// categories — event handlers below call these rather than mutating state
// inline, so the test hook (money-ledger-selftest.html) can drive the same
// functions the real UI drives, not a reimplementation of them.

function createEntry(fields) {
  const entry = {
    id: fields.id || uid(),
    date: fields.date,
    amountMinor: fields.amountMinor,
    direction: fields.direction,
    categoryId: fields.categoryId,
    note: fields.note || "",
    recurringId: fields.recurringId || null,
    updatedAt: nowIso(),
    updatedBy: DEVICE_ID,
    deleted: false,
    deletedAt: null,
  };
  state.entries.push(entry);
  return entry;
}

function editEntry(id, fields) {
  const entry = state.entries.find((x) => x.id === id);
  if (!entry) return null;
  entry.direction = fields.direction;
  entry.amountMinor = fields.amountMinor;
  entry.categoryId = fields.categoryId;
  entry.date = fields.date;
  entry.note = fields.note;
  entry.updatedAt = nowIso();
  entry.updatedBy = DEVICE_ID;
  return entry;
}

function deleteEntry(id) {
  const entry = state.entries.find((x) => x.id === id);
  if (!entry) return null;
  entry.deleted = true;
  entry.deletedAt = nowIso();
  entry.updatedAt = nowIso();
  entry.updatedBy = DEVICE_ID;
  return entry;
}

function undeleteEntry(id) {
  const entry = state.entries.find((x) => x.id === id);
  if (!entry) return null;
  entry.deleted = false;
  entry.deletedAt = null;
  entry.updatedAt = nowIso();
  entry.updatedBy = DEVICE_ID;
  return entry;
}

function createCategory(fields) {
  const category = {
    id: uid(),
    name: fields.name,
    direction: fields.direction,
    hue: fields.hue,
    color: hueColor(fields.hue),
    budgetMinor: null, // expense categories only — see setBudget()
    updatedAt: nowIso(),
    updatedBy: DEVICE_ID,
    deleted: false,
    deletedAt: null,
  };
  state.categories.push(category);
  return category;
}

// Partial update — only fields actually present in `fields` are touched,
// matching how rename, recolor-via-preset, and recolor-via-slider each
// only ever change one or two fields at a time.
function editCategory(id, fields) {
  const category = state.categories.find((x) => x.id === id);
  if (!category) return null;
  if (fields.name !== undefined) category.name = fields.name;
  if (fields.hue !== undefined) category.hue = fields.hue;
  if (fields.color !== undefined) category.color = fields.color;
  if (fields.budgetMinor !== undefined) category.budgetMinor = fields.budgetMinor;
  category.updatedAt = nowIso();
  category.updatedBy = DEVICE_ID;
  return category;
}

function deleteCategory(id) {
  const category = state.categories.find((x) => x.id === id);
  if (!category) return null;
  category.deleted = true;
  category.deletedAt = nowIso();
  category.updatedAt = nowIso();
  category.updatedBy = DEVICE_ID;
  return category;
}

function undeleteCategory(id) {
  const category = state.categories.find((x) => x.id === id);
  if (!category) return null;
  category.deleted = false;
  category.deletedAt = null;
  category.updatedAt = nowIso();
  category.updatedBy = DEVICE_ID;
  return category;
}

// Recurring CRUD — same shape as Category CRUD above. Editing/deleting a
// Recurring record never touches entries already auto-inserted from it;
// those are independent history at that point, same principle as editing
// a Category never rewriting past entries (Recurring design decisions).
function createRecurring(fields) {
  const recurring = {
    id: uid(),
    name: fields.name,
    amountMinor: fields.amountMinor,
    direction: fields.direction,
    categoryId: fields.categoryId,
    dayOfMonth: fields.dayOfMonth,
    startMonth: fields.startMonth,
    paused: false,
    updatedAt: nowIso(),
    updatedBy: DEVICE_ID,
    deleted: false,
    deletedAt: null,
  };
  state.recurring.push(recurring);
  return recurring;
}

function editRecurring(id, fields) {
  const recurring = state.recurring.find((x) => x.id === id);
  if (!recurring) return null;
  if (fields.name !== undefined) recurring.name = fields.name;
  if (fields.amountMinor !== undefined) recurring.amountMinor = fields.amountMinor;
  if (fields.direction !== undefined) recurring.direction = fields.direction;
  if (fields.categoryId !== undefined) recurring.categoryId = fields.categoryId;
  if (fields.dayOfMonth !== undefined) recurring.dayOfMonth = fields.dayOfMonth;
  if (fields.startMonth !== undefined) recurring.startMonth = fields.startMonth;
  recurring.updatedAt = nowIso();
  recurring.updatedBy = DEVICE_ID;
  return recurring;
}

function deleteRecurring(id) {
  const recurring = state.recurring.find((x) => x.id === id);
  if (!recurring) return null;
  recurring.deleted = true;
  recurring.deletedAt = nowIso();
  recurring.updatedAt = nowIso();
  recurring.updatedBy = DEVICE_ID;
  return recurring;
}

function undeleteRecurring(id) {
  const recurring = state.recurring.find((x) => x.id === id);
  if (!recurring) return null;
  recurring.deleted = false;
  recurring.deletedAt = null;
  recurring.updatedAt = nowIso();
  recurring.updatedBy = DEVICE_ID;
  return recurring;
}

// Pausing/resuming never touches entries already auto-inserted from this
// record — same "not a live reference" principle as every other Recurring
// edit (see "Recurring design decisions"). It only changes whether FUTURE
// due-checks consider this record eligible (see dueRecurring below).
function pauseRecurring(id) {
  const recurring = state.recurring.find((x) => x.id === id);
  if (!recurring) return null;
  recurring.paused = true;
  recurring.updatedAt = nowIso();
  recurring.updatedBy = DEVICE_ID;
  return recurring;
}

function resumeRecurring(id) {
  const recurring = state.recurring.find((x) => x.id === id);
  if (!recurring) return null;
  recurring.paused = false;
  recurring.updatedAt = nowIso();
  recurring.updatedBy = DEVICE_ID;
  return recurring;
}

// ---------- recurring auto-insert ----------

function daysInMonth(y, m) {
  return new Date(y, m + 1, 0).getDate();
}
function clampDay(y, m, day) {
  return Math.min(day, daysInMonth(y, m));
}
// "YYYY-MM", zero-padded so it string-compares correctly against another
// monthKey() result — used both for the deterministic auto-insert id below
// and for gating a Recurring record's startMonth against the real calendar.
function monthKey(y, m) {
  return y + "-" + String(m + 1).padStart(2, "0");
}

// Which non-deleted, non-paused Recurring records are due for a fresh
// auto-insert right now: today's real date has reached the (clamped) day,
// today's real month is at or past the record's startMonth (a record with
// no startMonth has no restriction — every record that existed before this
// field was added reads that way, by construction, with no migration
// needed), and no entry tagged with this recurring id exists yet for
// today's real month. Pure — takes `today` as a parameter rather than
// reading the system clock itself, so it's directly testable without
// mocking Date (CLAUDE.md hard rule 10). Deliberately checks the CURRENT
// month only, not every month since the record was created or since the
// app was last opened — see "Recurring design decisions" for why
// backfilling missed months was scoped out rather than silently bulk-
// inserting old history. Pausing/startMonth only ever narrow this filter —
// they never touch recurringInsertId or the entries table, so the one-
// entry-per-recurring-per-month invariant that id relies on is untouched.
function dueRecurring(recurringList, entries, today) {
  const y = today.getFullYear(), m = today.getMonth();
  const curKey = monthKey(y, m);
  return recurringList.filter((r) => !r.deleted && !r.paused).filter((r) => {
    if (r.startMonth && r.startMonth > curKey) return false;
    const day = clampDay(y, m, r.dayOfMonth);
    if (today.getDate() < day) return false;
    const alreadyInserted = entries.some((e) => {
      if (e.deleted || e.recurringId !== r.id) return false;
      const d = parseIso(e.date);
      return d.getFullYear() === y && d.getMonth() === m;
    });
    return !alreadyInserted;
  });
}

// Whether a Recurring record currently counts as "active" for display
// purposes (the Recurring screen's summary totals and day-group totals,
// and whether a list row gets marked inactive) — distinct from dueRecurring
// above, which additionally checks the day-of-month and whether this
// month's entry already exists. A paused or not-yet-started record is
// never "due" either, so isRecurringActive(r, today) is implied by
// dueRecurring's own filters, but rendering needs the coarser check on its
// own (a record can be "active" — will auto-insert eventually this month —
// without being "due" yet today). Pure, same `today`-as-parameter pattern
// as dueRecurring, for the same testability reason.
function isRecurringActive(r, today) {
  if (r.paused) return false;
  const curKey = monthKey(today.getFullYear(), today.getMonth());
  return !r.startMonth || r.startMonth <= curKey;
}

// The auto-inserted entry's id is deterministic — derived from the
// Recurring record's own id plus the real calendar year/month, not
// uid()'s random UUID — so two devices that each independently conclude
// "not yet inserted this month" (because neither has synced the other's
// insertion yet) end up creating a record under the SAME id instead of
// two unrelated ones. mergeRecords is keyed purely by id, so this makes
// it naturally collapse the two into one instead of keeping both as
// legitimate-looking duplicates (2026-08-21 bug, see CLAUDE.md "Recurring
// design decisions"). Safe against real uid()-generated ids: every
// crypto.randomUUID() output is exactly 36 lowercase hex/hyphen
// characters, and uid()'s fallback path always starts with "id-" — this
// format's "recurring:" prefix and non-hex letters can't structurally
// collide with either. Not a new pattern either: SEED_CATEGORIES already
// uses fixed, non-uid() ids for the same reason (two devices need to
// independently agree it's "the same" record).
function recurringInsertId(recurringId, y, m) {
  return "recurring:" + recurringId + ":" + monthKey(y, m);
}

// The side-effecting wrapper: creates the actual entries, saves, toasts,
// and re-renders. Called once on load (real mode only — TEST_MODE drives
// dueRecurring/this function explicitly via the hook, never automatically,
// so it can't interfere with sync tests that don't want surprise entries
// appearing on reset).
function applyDueRecurring() {
  if (!state.settings.currency) return;
  const today = new Date();
  const y = today.getFullYear(), m = today.getMonth();
  const due = dueRecurring(state.recurring, state.entries, today);
  const inserted = [];
  due.forEach((r) => {
    const id = recurringInsertId(r.id, y, m);
    // Sticky, regardless of deleted state: a record under this exact id
    // means this month's insertion decision has already been made (by
    // this device, or by another one already merged in). In particular,
    // deleting this month's auto-inserted entry must stay deleted — not
    // silently reinserted the next time this runs the same month.
    if (state.entries.some((e) => e.id === id)) return;
    const day = clampDay(y, m, r.dayOfMonth);
    const date = isoDate(new Date(y, m, day));
    inserted.push(createEntry({ id, date, amountMinor: r.amountMinor, direction: r.direction, categoryId: r.categoryId, note: r.name, recurringId: r.id }));
  });
  if (inserted.length === 0) return;
  const currency = state.settings.currency;
  saveState();
  if (inserted.length === 1) {
    toast(`${inserted[0].note}, ${formatMoney(inserted[0].amountMinor, currency)} logged automatically`);
  } else {
    toast(`${inserted.length} recurring entries logged automatically`);
  }
  renderAll();
}

// ---------- quick-add ----------

let quickDir = "expense";
let quickAddCatSelect = null;

function refreshQuickAddCategories() {
  if (!quickAddCatSelect) return;
  populateCategorySelect(quickAddCatSelect, quickDir, quickAddCatSelect.value);
}

function populateCategorySelect(select, direction, selectedId) {
  select.innerHTML = "";
  categoriesFor(direction).forEach((c) => {
    const o = document.createElement("option");
    o.value = c.id; o.textContent = c.name;
    if (c.id === selectedId) o.selected = true;
    select.appendChild(o);
  });
}

// "1st", "2nd", "3rd", "4th"... — handles the 11th/12th/13th exception to
// the usual 1/2/3 pattern (n % 100 lands them on the "th" fallback, not
// the "st"/"nd"/"rd" they'd get from n % 10 alone).
function ordinal(n) {
  const suffixes = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (suffixes[(v - 20) % 10] || suffixes[v] || suffixes[0]);
}

function populateDaySelect(select, selectedDay) {
  select.innerHTML = "";
  for (let day = 1; day <= 31; day++) {
    const o = document.createElement("option");
    o.value = day; o.textContent = ordinal(day);
    if (day === selectedDay) o.selected = true;
    select.appendChild(o);
  }
}

// A fixed window of real calendar months (a year back, a year forward)
// around today — like populateDaySelect, this is an absolute calendar
// concept, not tied to whichever month the register happens to be
// viewing. selectedKey falling outside the window (or being null/undefined,
// which happens for a record that predates this field and has never been
// restricted) just leaves the browser default (first option) selected —
// harmless, since a record only actually gets a startMonth written to it
// if this form is submitted.
function populateMonthSelect(select, selectedKey) {
  select.innerHTML = "";
  const today = new Date();
  for (let offset = -12; offset <= 12; offset++) {
    const d = new Date(today.getFullYear(), today.getMonth() + offset, 1);
    const key = monthKey(d.getFullYear(), d.getMonth());
    const o = document.createElement("option");
    o.value = key;
    o.textContent = d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
    if (key === selectedKey) o.selected = true;
    select.appendChild(o);
  }
}

function initQuickAdd() {
  const form = document.getElementById("quickaddForm");
  const dirBtns = form.querySelectorAll(".dirtoggle button");
  const catSelect = document.getElementById("qaCategory");
  const dateInput = document.getElementById("qaDate");
  const todayBtn = document.getElementById("qaToday");
  dateInput.value = todayStr();

  // The date field is deliberately "sticky" across submissions (see
  // CLAUDE.md quick-add notes) so a batch of same-day backfilled entries
  // doesn't need the date reselected each time — this button is the
  // deliberate way back to today, shown only while the field actually
  // differs from it.
  function updateTodayBtn() {
    todayBtn.hidden = dateInput.value === todayStr();
  }
  updateTodayBtn();
  dateInput.addEventListener("change", updateTodayBtn);
  todayBtn.addEventListener("click", () => {
    dateInput.value = todayStr();
    updateTodayBtn();
    document.getElementById("qaAmount").focus();
  });

  function setDir(dir) {
    quickDir = dir;
    dirBtns.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.dir === dir)));
    populateCategorySelect(catSelect, dir);
  }
  dirBtns.forEach((b) => b.addEventListener("click", () => setDir(b.dataset.dir)));
  setDir("expense");
  quickAddCatSelect = catSelect;

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const amountMinor = parseAmountToMinor(document.getElementById("qaAmount").value);
    if (amountMinor == null) return;
    createEntry({
      date: dateInput.value || todayStr(),
      amountMinor,
      direction: quickDir,
      categoryId: catSelect.value,
      note: document.getElementById("qaNote").value.trim(),
    });
    saveState();
    document.getElementById("qaAmount").value = "";
    document.getElementById("qaNote").value = "";
    toast((quickDir === "income" ? "Income" : "Expense") + " logged");
    renderAll();
    // Enter in any quick-add field (amount, date, or note) already submits
    // the form via native implicit submission — this just sends focus back
    // to a ready-to-type amount field afterward, for logging several
    // entries in a row without reaching for the mouse.
    document.getElementById("qaAmount").focus();
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
  document.getElementById("editAmount").value = amountInputValue(e.amountMinor);
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
    if (!state.entries.some((x) => x.id === editingId)) return;
    const dir = scrim.querySelector('.dirtoggle button[aria-pressed="true"]').dataset.dir;
    const amountMinor = parseAmountToMinor(document.getElementById("editAmount").value);
    if (amountMinor == null) return;
    editEntry(editingId, {
      direction: dir,
      amountMinor,
      categoryId: document.getElementById("editCategory").value,
      date: document.getElementById("editDate").value,
      note: document.getElementById("editNote").value.trim(),
    });
    saveState();
    closeEditSheet();
    toast("Entry updated");
    renderAll();
  });

  document.getElementById("editDelete").addEventListener("click", () => {
    if (!editingId) return;
    // No confirm dialog here on purpose — the undo toast right after this
    // is the safety net for a single entry. Deleting a whole month (below)
    // is a different order of consequence and still asks first.
    const entry = deleteEntry(editingId);
    if (!entry) return;
    saveState();
    closeEditSheet();
    toast("Entry deleted", () => {
      undeleteEntry(entry.id);
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

// ---------- rendering: category filter chip row ----------

// Renders the opt-in category-filter chip row into `container` from `pool`
// (a list of records carrying categoryId + amountMinor — Entry rows for the
// register, Recurring records for the Recurring screen). One pill per
// category actually present in `pool`, ordered by total amount descending
// to match the category rail, plus a leading "All" pill that clears back to
// baseline. Toggling a pill mutates `filterSet` in place and calls
// `onChange`.
//
// The row is rebuilt on every render of its screen — so navigating to a
// different month re-derives which categories are offered from THAT month's
// records, never stale. `filterSet` itself is untouched here: a still-
// selected id whose category has nothing in the current pool simply has no
// pill, and shows up instead as the "no matches" empty state; navigating
// back restores its pill, still pressed.
function renderCatFilter(container, pool, filterSet, onChange) {
  const totals = new Map();
  pool.forEach((r) => totals.set(r.categoryId, (totals.get(r.categoryId) || 0) + r.amountMinor));
  const cats = Array.from(totals.keys())
    .map((id) => catById(id))
    .filter(Boolean)
    .sort((a, b) => (totals.get(b.id) || 0) - (totals.get(a.id) || 0));

  if (cats.length === 0) {
    container.hidden = true;
    container.innerHTML = "";
    return;
  }
  container.hidden = false;

  let html = `<button type="button" class="cf-all" data-id="" aria-pressed="${filterSet.size === 0}">All</button>`;
  cats.forEach((c) => {
    html += `<button type="button" data-id="${c.id}" aria-pressed="${filterSet.has(c.id)}">` +
      `<span class="dot" style="background:${c.color}"></span>${escapeHtml(c.name)}</button>`;
  });
  container.innerHTML = html;

  container.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      if (!id) filterSet.clear();
      else if (filterSet.has(id)) filterSet.delete(id);
      else filterSet.add(id);
      onChange();
    });
  });
}

// ---------- rendering: register ----------

function renderRegister() {
  document.querySelectorAll("#viewDirToggle button").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.dir === viewDir));
  });

  const box = document.getElementById("register");
  const currency = state.settings.currency;
  const allEntries = entriesInMonth(viewYear, viewMonth);
  const dirEntries = allEntries
    .filter((e) => e.direction === viewDir)
    .slice()
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  renderCatFilter(document.getElementById("registerFilter"), dirEntries, registerCatFilter, () => {
    renderRegister();
    renderCategoryRail();
  });

  const filterActive = registerCatFilter.size > 0;
  const entries = filterActive
    ? dirEntries.filter((e) => registerCatFilter.has(e.categoryId))
    : dirEntries;

  if (dirEntries.length === 0) {
    box.innerHTML = `<div class="register-empty">No ${viewDir === "income" ? "income" : "expenses"} logged yet this month.<br>Use the form above — it takes a few seconds.</div>`;
    return;
  }
  if (entries.length === 0) {
    box.innerHTML = `<div class="register-empty">No entries in the selected categories this month.<br><button type="button" class="linkbtn" id="registerFilterClear">Show all categories</button></div>`;
    document.getElementById("registerFilterClear").addEventListener("click", () => {
      registerCatFilter.clear();
      renderRegister();
      renderCategoryRail();
    });
    return;
  }

  // Unfiltered: week/day headers show IN/OUT summing every entry that month,
  // BOTH directions, unaffected by the direction toggle (2026-08-26). With a
  // category filter active they instead collapse to a single figure of the
  // shown rows, labelled with the existing IN/OUT vocabulary for whichever
  // side is being viewed (the filter's categories are direction-scoped, so
  // the other side of a full IN … · OUT … header would only ever be zero).
  const weekAllTotals = new Map(); // mondayIso -> {inc,exp} from ALL entries that week
  const dayAllTotals = new Map(); // date -> {inc,exp} from ALL entries that day
  if (!filterActive) {
    allEntries.forEach((e) => {
      const wk = isoDate(mondayOf(parseIso(e.date)));
      if (!weekAllTotals.has(wk)) weekAllTotals.set(wk, { inc: 0, exp: 0 });
      if (!dayAllTotals.has(e.date)) dayAllTotals.set(e.date, { inc: 0, exp: 0 });
      const wt = weekAllTotals.get(wk), dt = dayAllTotals.get(e.date);
      if (e.direction === "income") { wt.inc += e.amountMinor; dt.inc += e.amountMinor; }
      else { wt.exp += e.amountMinor; dt.exp += e.amountMinor; }
    });
  }

  const headSpan = (all, selSum) =>
    filterActive
      ? `${viewDir === "income" ? "IN" : "OUT"} ${formatMoney(selSum, currency)}`
      : `IN ${formatMoney(all.inc, currency)} · OUT ${formatMoney(all.exp, currency)}`;

  const weeks = new Map(); // mondayIso -> entries[]
  entries.forEach((e) => {
    const key = isoDate(mondayOf(parseIso(e.date)));
    if (!weeks.has(key)) weeks.set(key, []);
    weeks.get(key).push(e);
  });
  const weekKeys = Array.from(weeks.keys()).sort().reverse();

  let html = "";
  weekKeys.forEach((wk) => {
    const rows = weeks.get(wk);
    const label = weekRangeLabel(rows);
    const weekSel = rows.reduce((s, e) => s + e.amountMinor, 0);
    html += `<div class="weekhead"><b>${label}</b><span>${headSpan(weekAllTotals.get(wk), weekSel)}</span></div>`;

    const days = new Map(); // date -> entries[], for the daily sub-grouping inside each week
    rows.forEach((e) => {
      if (!days.has(e.date)) days.set(e.date, []);
      days.get(e.date).push(e);
    });
    Array.from(days.keys()).sort().reverse().forEach((dateKey) => {
      const dayRows = days.get(dateKey);
      const daySel = dayRows.reduce((s, e) => s + e.amountMinor, 0);
      const dayLabel = parseIso(dateKey).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }).toUpperCase();
      html += `<div class="dayhead"><b>${dayLabel}</b><span>${headSpan(dayAllTotals.get(dateKey), daySel)}</span></div>`;
      dayRows.forEach((e) => {
        const cat = catById(e.categoryId);
        const amtClass = e.direction === "income" ? "income" : "";
        const sign = e.direction === "income" ? "+" : "−";
        html += `<button type="button" class="entryrow" data-id="${e.id}">
          <span class="dot" style="background:${cat ? cat.color : "var(--none)"}"></span>
          <span class="meta">
            <span class="cat">${cat ? escapeHtml(cat.name) : "Uncategorized"}</span>
            ${e.note ? `<span class="note">${escapeHtml(e.note)}</span>` : ""}
          </span>
          <span class="amt ${amtClass}">${sign}${formatMoney(e.amountMinor, currency)}</span>
        </button>`;
      });
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
  const { income, expenses, net } = monthTotals(entries);
  const currency = state.settings.currency;
  const pct = income > 0 ? Math.min(100, (expenses / income) * 100) : expenses > 0 ? 100 : 0;
  const over = income > 0 && expenses > income;

  document.getElementById("summaryBox").innerHTML = `
    <div class="summary-row income"><span>Income</span><b>${formatMoney(income, currency)}</b></div>
    <div class="summary-row"><span>Expenses</span><b>${formatMoney(expenses, currency)}</b></div>
    <div class="summary-row net"><span>Net</span><b class="${net < 0 ? "neg" : ""}">${formatMoney(net, currency)}</b></div>
    <div class="summary-bar"><i class="${over ? "over" : "spent"}" style="width:${pct}%"></i></div>
  `;
}

// ---------- rendering: category rail ----------

function renderCategoryRail() {
  // The Spent/Income toggle itself lives once, on the Register panel-label
  // (#viewDirToggle) — renderRegister() owns its aria-pressed state; this
  // just reads the same viewDir it's driven by.
  const entries = entriesInMonth(viewYear, viewMonth).filter((e) => e.direction === viewDir);
  const totals = sumByCategory(entries);
  const cats = categoriesFor(viewDir).slice().sort((a, b) => (totals.get(b.id) || 0) - (totals.get(a.id) || 0));
  const maxTotal = Math.max(1, ...cats.map((c) => totals.get(c.id) || 0));
  const currency = state.settings.currency;

  const list = document.getElementById("catList");
  list.innerHTML = "";
  cats.forEach((c) => {
    const total = totals.get(c.id) || 0;
    // Fill-up visual for a budgeted expense category: empty at zero spend,
    // filling as it's spent, pins at a full red bar once the budget is
    // gone rather than overflowing past 100% (CLAUDE.md backlog #2).
    // Categories with no budget keep the plain proportional-to-max bar.
    const hasBudget = c.direction === "expense" && c.budgetMinor != null && c.budgetMinor > 0;
    const over = hasBudget && total > c.budgetMinor; // exactly at budget is still fine, not over
    const pct = hasBudget ? (over ? 100 : Math.min(100, (total / c.budgetMinor) * 100)) : (total / maxTotal) * 100;
    const barColor = over ? "var(--flag)" : c.color;
    const amountText = hasBudget
      ? `${formatMoney(total, currency)} / ${formatMoney(c.budgetMinor, currency)}`
      : formatMoney(total, currency);
    const row = document.createElement("div");
    // .selected is a passive reflection of the register's category filter —
    // the rail's own totals and bars stay computed from the full unfiltered
    // month regardless (see renderCatFilter).
    row.className = "cat" + (registerCatFilter.has(c.id) ? " selected" : "");
    row.dataset.id = c.id;
    row.innerHTML = `
      <button type="button" class="sw" style="background:${c.color}" title="Change color"></button>
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:8px">
          <input class="nm" value="${escapeHtml(c.name)}">
          <span style="font-family:var(--mono);font-size:12px;font-weight:600;white-space:nowrap;${over ? "color:var(--flag)" : ""}">${amountText}</span>
        </div>
        <div class="tot-bar"><i style="width:${pct}%;background:${barColor}"></i></div>
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
      const newName = nmInput.value.trim() || c.name;
      const dup = categoriesFor(c.direction).some((other) => other.id !== c.id && other.name.toLowerCase() === newName.toLowerCase());
      if (dup) {
        toast(`"${newName}" already exists`);
        nmInput.value = c.name;
        return;
      }
      editCategory(c.id, { name: newName });
      saveState();
      renderAll();
    });

    row.querySelector(".del").addEventListener("click", () => {
      const inUse = state.entries.some((e) => e.categoryId === c.id && !e.deleted);
      if (inUse && !confirm(`"${c.name}" has entries logged against it. Delete it anyway? Those entries will show as Uncategorized.`)) return;
      if (openPickerCatId === c.id) openPickerCatId = null;
      deleteCategory(c.id);
      saveState();
      toast(`"${c.name}" deleted`, () => {
        undeleteCategory(c.id);
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
          editCategory(c.id, { hue: i / (HUE_STOPS.length - 1), color: hex });
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
        editCategory(c.id, {});
        saveState();
        renderAll();
      });
    }
  });

  document.getElementById("catCount").textContent = cats.length ? formatMoney(cats.reduce((s, c) => s + (totals.get(c.id) || 0), 0), currency) : "—";
}

function initCategoryRail() {
  document.querySelectorAll("#viewDirToggle button").forEach((b) => {
    b.addEventListener("click", () => {
      viewDir = b.dataset.dir;
      openPickerCatId = null;
      // Expense and income categories are disjoint, so a filter carried
      // across a direction switch could only ever resolve to nothing —
      // clear it rather than leave a stale selection behind.
      registerCatFilter.clear();
      renderRegister();
      renderCategoryRail();
    });
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
    // Blocks both a deliberate duplicate and an accidental double-tap/
    // double-submit on "Add" — the second submit lands after the first
    // has already run (JS event handlers are synchronous), so by the
    // time this check runs on the second call, the first category is
    // already in state.categories and gets caught here.
    if (categoriesFor(viewDir).some((c) => c.name.toLowerCase() === name.toLowerCase())) {
      toast(`"${name}" already exists`);
      return;
    }
    createCategory({ name, direction: viewDir, hue: Math.random() });
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

  // "Tap anywhere to reconnect" — see resolveGestureReconnect. pointerdown,
  // not click: it fires earliest and always carries user-gesture weight for
  // the popup (a click can be suppressed by a preventDefault elsewhere).
  // Capture phase so it runs regardless of what other handlers do. No
  // preventDefault here — the tap still does its normal job. Not wired in
  // TEST_MODE: the suite drives resolveGestureReconnect directly, and a
  // stray real pointerdown must never reach reconnectDrive()'s real OAuth.
  if (!TEST_MODE) {
    document.addEventListener("pointerdown", (ev) => {
      if (resolveGestureReconnect(ev.target) === "reconnecting") reconnectDrive();
    }, true);
  }

  document.getElementById("exportBtn").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `money-ledger-backup-${todayStr()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast("Backup downloaded.");
  });

  const importFile = document.getElementById("importFile");
  document.getElementById("importBtn").addEventListener("click", () => importFile.click());
  importFile.addEventListener("change", () => {
    const file = importFile.files[0];
    importFile.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let parsed;
      try {
        parsed = JSON.parse(reader.result);
      } catch (e) {
        toast("That file isn't valid JSON — import cancelled.");
        return;
      }
      if (!Array.isArray(parsed.entries) || !Array.isArray(parsed.categories)) {
        toast("That doesn't look like a Money Ledger backup — import cancelled.");
        return;
      }
      if (!confirm("Import this backup? It will replace everything currently on this device.")) return;
      if (!parsed.updatedAt) parsed.updatedAt = new Date(0).toISOString();
      parsed.entries.forEach((e) => backfillRecordFields(e, parsed.updatedAt));
      parsed.categories.forEach((c) => backfillRecordFields(c, parsed.updatedAt));
      state = parsed;
      if (!state.settings) state.settings = defaultState().settings;
      saveState();
      renderAll();
      toast("Backup imported.");
    };
    reader.readAsText(file);
  });

  document.getElementById("clearDataBtn").addEventListener("click", () => {
    const label = monthLabel(viewYear, viewMonth);
    const monthEntries = entriesInMonth(viewYear, viewMonth);
    if (monthEntries.length === 0) {
      toast("Nothing logged in " + label + " yet.");
      return;
    }
    if (!confirm(`Delete all ${monthEntries.length} ${monthEntries.length === 1 ? "entry" : "entries"} logged in ${label}?`)) return;
    const ts = nowIso();
    monthEntries.forEach((e) => { e.deleted = true; e.deletedAt = ts; e.updatedAt = ts; e.updatedBy = DEVICE_ID; });
    saveState();
    toast(label + " cleared", () => {
      const undoTs = nowIso();
      monthEntries.forEach((e) => { e.deleted = false; e.deletedAt = null; e.updatedAt = undoTs; e.updatedBy = DEVICE_ID; });
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
// never the rest of a user's Drive. Every sync — push or pull, doesn't
// matter which — merges record-by-record before writing anywhere. No
// exceptions: CLAUDE.md hard rule 6 exists because a whole-file "newer"
// comparison silently destroyed real data once already.

// Two independent edits landing within this window are treated as "can't
// honestly tell which happened first" — device clocks aren't perfectly
// synced. Ambiguous cases never resolve to a deletion (see mergeRecords).
const AMBIGUOUS_WINDOW_MS = 5000;

function driveIsConfigured() {
  return !!GOOGLE_CLIENT_ID && typeof google !== "undefined" && google.accounts && google.accounts.oauth2;
}

// ---- Force GIS to open a FRESH OAuth popup window every time ------------
//
// GIS builds exactly one popup window name per page load —
// `g_auth_token_window_<random>`, the random half fixed when gsi/client is
// evaluated — and passes that same name to window.open() on every
// requestAccessToken() call. window.open(url, name) retargets any existing
// browsing context with that name that this page opened, *even after that
// tab has navigated to a completely different origin* (confirmed by direct
// test; it holds as long as the opener link isn't severed). On a
// long-lived tab that never reloads (a pinned phone tab), that means the
// very first OAuth tab this page ever opened gets retargeted forever —
// wherever it now sits in the tab strip, whatever it now shows. Closing
// "the dangling accounts.google.com tab" doesn't help: the persistent
// thing is the *tab*, bound to that name for its whole life, not its
// current contents.
//
// FRAGILITY (watch this): the fix rewrites the name GIS passes to
// window.open so every call gets a brand-new window. This is safe ONLY
// because GIS never reads the window name back — routing of the auth
// result is by origin + a per-request nonce in the redirect_uri +
// client_id, with the name used *solely* in the window.open() call. That
// was confirmed by reading the current gsi/client source (2026-08-31), NOT
// from any public API contract. If a future GIS update starts correlating
// on the window name, this wrapper would silently stop preventing the
// retarget — no error, no test failure (TEST_MODE never loads real GIS).
// The prefix is preserved (only a `.<suffix>` is appended) so a
// prefix-based GIS check would still match; only an exact-name check would
// break. See CLAUDE.md "General fixes (2026-08-31)".
const OAUTH_WINDOW_NAME_PREFIX = "g_auth_token_window";
let lastOAuthWindow = null;
let nativeWindowOpen =
  typeof window !== "undefined" && typeof window.open === "function"
    ? window.open.bind(window)
    : null;

// Pure: GIS's frozen popup name -> a unique one; every other name (and a
// non-string) is returned untouched, so this only ever affects GIS.
function freshOAuthWindowName(name) {
  if (typeof name === "string" && name.indexOf(OAUTH_WINDOW_NAME_PREFIX) === 0) {
    return name + "." + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  return name;
}

function openOAuthAwareWindow(url, name, features) {
  const rewritten = freshOAuthWindowName(name);
  const w = nativeWindowOpen ? nativeWindowOpen(url, rewritten, features) : null;
  if (rewritten !== name) lastOAuthWindow = w || null; // only track GIS's popup
  return w;
}

if (typeof window !== "undefined" && typeof window.open === "function") {
  window.open = openOAuthAwareWindow;
}

// Close the OAuth popup we last opened, if it's still open. An opener can
// always close() a window it opened, even one now showing a cross-origin
// page (unlike reading its location). Called when a flow settles so fresh
// windows don't pile up.
function closeLastOAuthWindow() {
  if (!lastOAuthWindow) return;
  try {
    if (!lastOAuthWindow.closed) lastOAuthWindow.close();
  } catch (e) {
    /* already gone, or a browser that refuses the close — nothing to do */
  }
  lastOAuthWindow = null;
}

// Every point where an auth flow stops mattering: cancel the watchdog and
// drop the popup. Called from the success callback, the error callback,
// and the watchdog itself.
function settleDriveAuth() {
  clearDriveAuthWatchdog();
  closeLastOAuthWindow();
}

// errorCallback is not optional in practice: without an error_callback set,
// GIS's own abandoned/closed-popup detection (`_.ug` in gsi/client) never
// arms, so a blocked, closed, or misrouted popup produces no callback at
// all — the flow just hangs, silently, forever. That silent-swallow was
// half of the mobile "nothing happened" bug. Every caller passes one now.
function driveTokenClientFor(callback, errorCallback) {
  if (!driveTokenClient) {
    driveTokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: DRIVE_SCOPE,
      callback,
      error_callback: errorCallback,
    });
  } else {
    driveTokenClient.callback = callback;
    driveTokenClient.error_callback = errorCallback;
  }
  return driveTokenClient;
}

// Always searches by name — never blind-trusts a previously cached file id.
// If more than one match turns up (e.g. two devices once created separate
// files before either found the other's), that's surfaced rather than
// silently picked, since it means two histories may need reconciling.
async function driveFindFiles() {
  if (TEST_MODE) {
    return Object.keys(FAKE_DRIVE)
      .filter((id) => FAKE_DRIVE[id].name === DRIVE_FILE_NAME)
      .map((id) => ({ id, name: FAKE_DRIVE[id].name }));
  }
  const q = encodeURIComponent(`name='${DRIVE_FILE_NAME}' and trashed=false`);
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,name)`, {
    headers: { Authorization: `Bearer ${driveAccessToken}` },
  });
  if (!res.ok) throw new Error("drive-list-" + res.status);
  const data = await res.json();
  return data.files || [];
}

async function driveCreateFile(contentStr) {
  if (TEST_MODE) {
    const id = "fake-" + fakeDriveNextId++;
    FAKE_DRIVE[id] = { name: DRIVE_FILE_NAME, content: contentStr };
    return id;
  }
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
  if (TEST_MODE) {
    if (!FAKE_DRIVE[fileId]) throw new Error("fake-drive-404");
    FAKE_DRIVE[fileId].content = contentStr;
    return;
  }
  const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${driveAccessToken}`, "Content-Type": "application/json" },
    body: contentStr,
  });
  if (!res.ok) throw new Error("drive-update-" + res.status);
}

async function driveReadFile(fileId) {
  if (TEST_MODE) {
    if (!FAKE_DRIVE[fileId]) throw new Error("fake-drive-404");
    return JSON.parse(FAKE_DRIVE[fileId].content);
  }
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${driveAccessToken}` },
  });
  if (!res.ok) throw new Error("drive-read-" + res.status);
  return res.json();
}

// Compares two ISO timestamps. "ambiguous" (within AMBIGUOUS_WINDOW_MS) is a
// distinct outcome from "a" or "b" — callers must not treat it as a coin
// flip, only as "don't trust this difference enough to delete over it."
// Only meaningful for comparing two DIFFERENT devices' clocks — see
// mergeRecords for why a device's own history skips this entirely.
function newerSide(aIso, bIso) {
  const diff = new Date(aIso).getTime() - new Date(bIso).getTime();
  if (Math.abs(diff) < AMBIGUOUS_WINDOW_MS) return "ambiguous";
  return diff > 0 ? "a" : "b";
}

// Fields that make two versions of a record actually different. Excludes
// id (already matched — it's how the pair was found) and updatedAt/updatedBy
// (bookkeeping, not content — two devices seeding the same starter category
// a second apart shouldn't count as a difference worth resolving).
const ENTRY_CONTENT_FIELDS = ["date", "amountMinor", "direction", "categoryId", "note", "recurringId", "deleted", "deletedAt"];
const CATEGORY_CONTENT_FIELDS = ["name", "direction", "hue", "color", "budgetMinor", "deleted", "deletedAt"];
const RECURRING_CONTENT_FIELDS = ["name", "amountMinor", "direction", "categoryId", "dayOfMonth", "startMonth", "paused", "deleted", "deletedAt"];

function sameContent(a, b, fields) {
  return fields.every((f) => a[f] === b[f]);
}

// Merges two versions of one collection (entries, or categories) id-by-id.
// Returns the merged array plus counts for the summary toast. Rules, in
// order:
//   - present on only one side -> keep it (this alone satisfies "never
//     remove a record the other side hasn't acknowledged": an id absent
//     from one side is either brand new there, or was never told about a
//     deletion — either way, absence is never treated as "delete it")
//   - same content (ignoring bookkeeping fields) -> keep either, nothing
//     to decide — this is what stops two devices' identical starter
//     categories from being "different" just because they were seeded a
//     moment apart
//   - Drive's copy was last written by THIS device -> trust local outright,
//     no ambiguity window at all. It's necessarily a stale snapshot of my
//     own earlier push, and one device's own clock ordering of its own
//     actions is never in question — only a genuine two-device comparison
//     can be clock-skewed. This is what makes a quick delete (or edit)
//     stick immediately instead of getting reverted by the next sync.
//   - one side a tombstone, the other a live edit -> newer wins, EXCEPT if
//     ambiguous, in which case the live version always wins, deliberately
//     biased against deleting on a guess (CLAUDE.md hard rule 6 / sync
//     design decisions)
//   - both live, content genuinely differs -> last-write-wins, no
//     keep-both (CLAUDE.md "Same-record conflicts" decision, 2026-08-04).
//     `superseded` counts these for the console only — deliberately not
//     surfaced to the user (CLAUDE.md "No user-facing notice on
//     last-write-wins" decision, 2026-08-04).
function mergeRecords(localArr, remoteArr, contentFields) {
  const localById = new Map(localArr.map((r) => [r.id, r]));
  const remoteById = new Map(remoteArr.map((r) => [r.id, r]));
  const ids = new Set([...localById.keys(), ...remoteById.keys()]);
  const merged = [];
  let adoptedFromRemote = 0;
  let superseded = 0;

  ids.forEach((id) => {
    const local = localById.get(id);
    const remote = remoteById.get(id);

    if (local && !remote) { merged.push(local); return; }
    if (remote && !local) { merged.push(remote); adoptedFromRemote++; return; }
    if (sameContent(local, remote, contentFields)) {
      merged.push(local.updatedAt >= remote.updatedAt ? local : remote);
      return;
    }

    const remoteIsMine = !!remote.updatedBy && remote.updatedBy === DEVICE_ID;
    const side = remoteIsMine ? "a" : newerSide(local.updatedAt, remote.updatedAt);

    if (local.deleted !== remote.deleted) {
      if (side === "ambiguous") {
        merged.push(local.deleted ? remote : local); // never delete on a genuinely cross-device close call
      } else {
        merged.push(side === "a" ? local : remote);
      }
      return;
    }

    if (local.deleted && remote.deleted) {
      // Both sides independently deleted the same record — redundant
      // tombstones, not a conflict. Nothing for the user to choose between.
      merged.push(local.updatedAt >= remote.updatedAt ? local : remote);
      return;
    }

    // Both live, content genuinely differs. Last-write-wins on the raw
    // timestamp — no ambiguity carve-out here, a definite pick is required
    // either way, so ties are broken the same way regardless of how close
    // they are.
    const localWins = local.updatedAt >= remote.updatedAt;
    merged.push(localWins ? local : remote);
    if (!localWins) superseded++; // this device's own edit just lost — must be surfaced, not silent
  });

  return { merged, adoptedFromRemote, superseded };
}

// Search-first: never blind-trusts a cached driveFileId. Warns (doesn't
// silently pick one) if more than one file exists — see CLAUDE.md open
// questions for what to do if that ever actually happens.
async function resolveDriveFileId() {
  const matches = await driveFindFiles();
  if (matches.length > 1) {
    console.warn("Money Ledger: multiple Drive files named", DRIVE_FILE_NAME, matches);
  }
  if (matches.length > 0) {
    const preferred = matches.find((f) => f.id === state.settings.driveFileId) || matches[0];
    state.settings.driveFileId = preferred.id;
    return preferred.id;
  }
  const fileId = await driveCreateFile(JSON.stringify(state));
  state.settings.driveFileId = fileId;
  return fileId;
}

// The one sync entry point, used identically whether triggered by saving,
// connecting, reconnecting, or the silent reload check — merge, save
// locally (safe, can't lose anything), only then attempt the network push.
// If the push fails, the merge is already safe on this device; it retries
// on the next save or reload rather than being lost (see CLAUDE.md hard
// rule 6 and the partial-write discussion in the commit history).
async function syncNow(showToast) {
  if (!state.settings.driveFileId || !driveAccessToken) return;

  let remote;
  try {
    remote = await driveReadFile(state.settings.driveFileId);
  } catch (err) {
    console.error("Drive read failed, will retry later", err);
    return;
  }

  const entryMerge = mergeRecords(state.entries, remote.entries || [], ENTRY_CONTENT_FIELDS);
  const catMerge = mergeRecords(state.categories, remote.categories || [], CATEGORY_CONTENT_FIELDS);
  const recMerge = mergeRecords(state.recurring, remote.recurring || [], RECURRING_CONTENT_FIELDS);
  state.entries = entryMerge.merged;
  state.categories = catMerge.merged;
  state.recurring = recMerge.merged;

  // Settings isn't a tombstoned record collection, so mergeRecords doesn't
  // apply — but budgetRingColors is still a real cross-device preference
  // (unlike driveConnected/driveFileId/introSeen, which describe THIS
  // device's own state and must never come from remote). Same last-write-
  // wins rule as same-record content conflicts elsewhere (Sync design
  // decisions), compared by its own single timestamp instead of a
  // per-record one.
  const localColorsAt = state.settings.budgetRingColorsUpdatedAt || "";
  const remoteColorsAt = (remote.settings && remote.settings.budgetRingColorsUpdatedAt) || "";
  if (remote.settings && remoteColorsAt > localColorsAt) {
    state.settings.budgetRingColors = remote.settings.budgetRingColors;
    state.settings.budgetRingColorsUpdatedAt = remoteColorsAt;
  }

  state.updatedAt = nowIso();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); // safe local write, before any network risk

  const adopted = entryMerge.adoptedFromRemote + catMerge.adoptedFromRemote + recMerge.adoptedFromRemote;
  const superseded = entryMerge.superseded + catMerge.superseded + recMerge.superseded;
  renderAll();

  try {
    await driveUpdateFile(state.settings.driveFileId, JSON.stringify(state));
    // Superseded edits are deliberately not surfaced to the user — see
    // CLAUDE.md "No user-facing notice on last-write-wins" — but logged
    // for anyone actually looking (devtools console, not the UI).
    if (superseded > 0) console.log(`Sync: ${superseded} local edit(s) superseded by a newer edit from another device.`);
    if (showToast && adopted > 0) {
      toast(`Synced — ${adopted} record(s) added from Drive.`);
    }
    // clean merge, nothing to say
  } catch (err) {
    console.error("Drive push failed, will retry on next save", err);
  }
  renderSettings();
}

// GIS reuses one popup window name for a page's whole lifetime and mobile
// Chrome often ignores GIS's window.close(), so an auth result can post
// back to a stale opener and neither callback ever fires. The watchdog is
// the floor under that: if the flow produces no success and no error
// within the window, tell the user rather than leaving them on a blank
// Google tab wondering, and drop the popup we opened.
const DRIVE_AUTH_WATCHDOG_MS = 120000;
let driveAuthWatchdog = null;

function armDriveAuthWatchdog() {
  clearTimeout(driveAuthWatchdog);
  driveAuthWatchdog = setTimeout(onDriveAuthWatchdogFired, DRIVE_AUTH_WATCHDOG_MS);
}

function onDriveAuthWatchdogFired() {
  driveAuthWatchdog = null;
  settleDriveAuth();
  toast("Google sign-in didn't come back. Close any stray Google tab, then tap Reconnect again.");
  renderSettings();
}

function clearDriveAuthWatchdog() {
  clearTimeout(driveAuthWatchdog);
  driveAuthWatchdog = null;
}

// Passed as error_callback to every token request. GIS calls this for
// popup_failed_to_open, popup_closed (once armed — see driveTokenClientFor),
// and other GIS-side errors.
function driveAuthErrorCallback(err) {
  settleDriveAuth();
  const type = err && err.type ? err.type : "";
  if (type === "popup_closed") {
    toast("Google sign-in was cancelled.");
  } else if (type === "popup_failed_to_open") {
    toast("Couldn't open the Google sign-in window — check that pop-ups aren't blocked, then try again.");
  } else {
    toast("Google sign-in failed (" + (type || "unknown") + "). Try again in a moment.");
  }
  renderSettings();
}

// Shared success/failure handler for both connect and reconnect. isFirstConnect
// distinguishes the two: only a first connect flips driveConnected + persists.
function handleDriveAuthResult(resp, isFirstConnect) {
  settleDriveAuth();
  if (resp.error) {
    toast(isFirstConnect
      ? "Google Drive connection was cancelled or failed."
      : "Reconnect failed — try again.");
    return;
  }
  driveAccessToken = resp.access_token;
  driveReconnectAttempted = false; // token obtained — re-arm for any future expiry this session
  saveDriveTokenCache(resp.access_token, resp.expires_in);
  return (async () => {
    try {
      await resolveDriveFileId();
      if (isFirstConnect) {
        state.settings.driveConnected = true;
        saveState();
      }
      await syncNow(true);
    } catch (err) {
      console.error(err);
      toast("Couldn't reach Google Drive (" + (err && err.message ? err.message : err) + "). Try again in a moment.");
    }
  })();
}

function connectDrive() {
  const client = driveTokenClientFor(
    (resp) => handleDriveAuthResult(resp, true),
    driveAuthErrorCallback
  );
  // Armed BEFORE requestAccessToken: GIS calls error_callback synchronously
  // when window.open returns null (popup blocked), so arming after would
  // leave that timer running with nothing to clear it.
  armDriveAuthWatchdog();
  client.requestAccessToken({ prompt: "consent" });
}

function reconnectDrive() {
  const client = driveTokenClientFor(
    (resp) => handleDriveAuthResult(resp, false),
    driveAuthErrorCallback
  );
  armDriveAuthWatchdog();
  client.requestAccessToken({ prompt: "" });
}

function disconnectDrive() {
  driveAccessToken = null;
  clearDriveTokenCache();
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

// "Tap anywhere to reconnect." When a Drive-connected device's ~1hr token
// has expired, the only signal is the "needs reconnect" label buried in the
// settings panel — easy to miss, and sync silently stays stopped until the
// user finds the button. A capture-phase pointerdown on document (wired in
// initSettings) lets the NEXT real tap anywhere resolve it. The tap is not
// consumed — no preventDefault — it still does its normal job; the reconnect
// rides along.
//
// This is a genuine user gesture, the same class the dedicated button uses
// — NOT the un-activated page-load popup that "General fixes (2026-08-30/31)"
// removed. requestAccessToken is still only ever reached from a click/
// pointerdown handler: here strictly via reconnectDrive(), which also means
// this path inherits the fresh-window-name wrapper (openOAuthAwareWindow),
// the watchdog, and every settle path with no new code.
//
// Extracted as its own decision so the self-test can assert the gating for
// every state without loading Google Identity Services. Returns an outcome
// string; only "reconnecting" has an effect — it claims this episode's one
// attempt (driveReconnectAttempted) so subsequent taps no-op until the
// attempt settles. The caller fires reconnectDrive() on that outcome.
//   "skip-not-configured"    GIS not ready / no client id
//   "skip-on-connect-button" tap was on #driveConnectBtn — its own handler owns it
//   "skip-not-needed"        not (connected && token gone) — the normal case
//   "skip-already-attempted" one attempt already made this episode
//   "skip-in-flight"         an interactive auth flow is currently pending
//   "reconnecting"           all clear — flag claimed; caller runs reconnectDrive()
function resolveGestureReconnect(target) {
  if (!driveIsConfigured()) return "skip-not-configured";
  if (target && target.closest && target.closest("#driveConnectBtn")) return "skip-on-connect-button";
  if (!(state.settings.driveConnected && !driveAccessToken)) return "skip-not-needed";
  if (driveReconnectAttempted) return "skip-already-attempted";
  if (driveAuthWatchdog !== null) return "skip-in-flight";
  driveReconnectAttempted = true;
  return "reconnecting";
}

// What resuming Drive sync on page load should do, given only this device's
// connection state and whether a still-valid cached access token exists.
// Its own function purely so the self-test can assert the decision without
// going near Google Identity Services (which TEST_MODE never loads):
//   "not-connected"        -> this device isn't synced; do nothing
//   "resume-from-cache"    -> a token from earlier this hour is still good
//   "await-user-reconnect" -> connected but no usable token; wait for a tap
function pageLoadSyncPlan() {
  if (!state.settings.driveConnected) return "not-connected";
  return loadDriveTokenCache() ? "resume-from-cache" : "await-user-reconnect";
}

// Called once on load (real mode only). Resumes sync ONLY from a still-valid
// cached token; it never triggers an OAuth popup.
//
// It used to (as initDriveSilentReconnect) call requestAccessToken({prompt:
// ""}) here on every load with no cached token, believing an empty prompt
// does a silent, popup-free token refresh. It does not: GIS's token client
// only skips the popup for prompt:"none" *and* an in-page refresh session a
// fresh load doesn't have — "" always calls window.open (verified against
// the real gsi/client). An un-activated window.open on page load is the bug
// this removes: on mobile it lands in the wrong tab (GIS reuses one frozen
// popup window name for the page's whole lifetime) and then dies silently.
// A backendless static site cannot refresh a Google token without a user
// gesture — hard rule 4 rules out the server-side flow that could — so the
// honest behaviour is to stop pretending: show the "needs reconnect" state
// and wait for the tap. See CLAUDE.md "General fixes (2026-08-30)".
//
// onSettled (optional) fires exactly once, after the resume attempt settles
// one way or another — success, failure, or "nothing to do here" — never
// left permanently unfired. The DOMContentLoaded handler below uses it to
// defer applyDueRecurring() until after a cache-resumed device has pulled
// whatever another device already synced, closing (for the common online
// case) the window where two devices each independently decide "not yet
// inserted" before seeing the other's insertion (2026-08-21, see CLAUDE.md
// "Recurring design decisions"). It still fires in the "await-user-
// reconnect" and failed-pull branches too — a device without a live token
// must not be stranded without its recurring entries; the deterministic
// insert id (recurringInsertId) is the backstop for whatever race survives.
function resumeDriveSyncIfTokenCached(onSettled) {
  const done = () => { if (onSettled) onSettled(); };
  if (TEST_MODE) { done(); return; } // tests drive sync explicitly via the hook, never real OAuth

  const plan = pageLoadSyncPlan();
  if (plan === "not-connected") { done(); return; }
  if (plan === "await-user-reconnect") {
    renderSettings(); // surfaces "Drive connected — needs reconnect"
    done();
    return;
  }
  // plan === "resume-from-cache": still-valid token from an earlier page
  // load this hour — use it directly, no Google round-trip, no popup.
  driveAccessToken = loadDriveTokenCache().token;
  driveReconnectAttempted = false; // usable token this load — re-arm for a later expiry
  resolveDriveFileId()
    .then(() => syncNow(false))
    .catch((err) => console.error(err))
    .then(done);
}

// ---------- fab ----------

function initFab() {
  document.getElementById("fab").addEventListener("click", () => {
    // The FAB stays visible on every screen (Budget/Recurring included) —
    // rather than hiding it where quickadd isn't currently shown, it
    // first returns to the register (same as the logo) so the one
    // thumb-reachable "log something" button always does something,
    // instead of silently failing to scroll/focus a hidden element.
    showBudgetView(false);
    showRecurringView(false);
    document.getElementById("quickadd").scrollIntoView({ behavior: "smooth", block: "start" });
    document.getElementById("qaAmount").focus();
  });
}

// The logo/wordmark doubles as a quick way back to the main register from
// Budget or Recurring — calling both is harmless even if only one (or
// neither) is currently open; each show*View(false) only touches its own
// section plus quickadd/mainCols.
function initHomeLink() {
  document.getElementById("homeLink").addEventListener("click", () => {
    showBudgetView(false);
    showRecurringView(false);
  });
}

// ---------- render all ----------

// ---------- rendering: budget ----------
//
// Design settled across a longer conversation with Sebastian (see CLAUDE.md
// backlog #2): income is a plain counter, never measured against anything —
// budgeting income isn't a thing people do, predictable income belongs to
// phase 3's recurring entries instead. Expenses and Net stay plain counters
// too until at least one expense category has a budget, at which point they
// gain a second, smaller line — no separate "budgeting mode" to turn on.
function renderBudgetView() {
  document.getElementById("budgetMonthLabel").textContent = monthLabel(viewYear, viewMonth);
  const currency = state.settings.currency;
  const entries = entriesInMonth(viewYear, viewMonth);
  const { income, expenses, net } = monthTotals(entries);

  const expenseCats = categoriesFor("expense");
  const totals = sumByCategory(entries.filter((e) => e.direction === "expense"));
  const totalBudget = expenseCats.reduce((sum, c) => sum + (c.budgetMinor || 0), 0);
  const hasAnyBudget = expenseCats.some((c) => c.budgetMinor != null && c.budgetMinor > 0);

  // Income has no target to fill against (Budget design decisions: it's a
  // plain counter, not something budgeted). The ring is a presence
  // indicator — full once anything's logged, ghosted with a dash before
  // that — not a proportional fill.
  const incomeHasData = income > 0;
  document.getElementById("bcIncomeRing").classList.toggle("ring-empty", !incomeHasData);
  document.getElementById("bcIncome").textContent = incomeHasData ? formatCompact(income, currency) : "—";
  setRingPct("bcIncomeArc", 52, incomeHasData ? 100 : 0);
  applyRingColor("income", false);

  // Same presence-indicator treatment as Income (above): a solid "0" is
  // just as ambiguous here as it is there ("deliberately spent nothing"
  // vs. "haven't opened the app"), so Expenses ghosts on its own zero the
  // same way Income does, rather than always showing a real number
  // (2026-08-11 revision — the earlier version only ghosted for "nothing
  // logged at all" on Income/Net, leaving Expenses inconsistent).
  const expensesHasData = expenses > 0;
  const expensesOver = hasAnyBudget && expenses > totalBudget;
  document.getElementById("bcExpensesRing").classList.toggle("ring-empty", !expensesHasData);
  document.getElementById("bcExpenses").textContent = expensesHasData ? formatCompact(expenses, currency) : "—";
  setRingPct("bcExpensesArc", 52, hasAnyBudget ? (expensesOver ? 100 : (expenses / totalBudget) * 100) : 0);
  applyRingColor("expenses", expensesOver);
  document.getElementById("bcExpensesCapSub").textContent = hasAnyBudget
    ? `Budget ${formatCompact(totalBudget, currency)}`
    : "";

  // Net's ring fill has no natural denominator (like income, above), so
  // it's a presence indicator too — full once there's any activity this
  // month, with colour carrying the sign. No predicted-net line anymore
  // (2026-08-11 revision, see CLAUDE.md) — it read as clutter under the
  // ring; the figure is still computed for the category-list total below,
  // just no longer surfaced here.
  const netHasData = income > 0 || expenses > 0;
  document.getElementById("bcNetRing").classList.toggle("ring-empty", !netHasData);
  document.getElementById("bcNet").textContent = netHasData ? formatCompact(net, currency) : "—";
  setRingPct("bcNetArc", 76, netHasData ? 100 : 0);
  applyRingColor("net", net < 0);

  Object.keys(RING_KEYS).forEach((key) => {
    const { sw, picker } = RING_KEYS[key];
    const custom = (state.settings.budgetRingColors || {})[key];
    const swEl = document.getElementById(sw);
    swEl.style.background = custom ? custom.color : "";
    const pickerEl = document.getElementById(picker);
    pickerEl.hidden = openBcPickerKey !== key;
    if (openBcPickerKey === key) {
      pickerEl.querySelector(".hue").value = custom ? Math.round(custom.hue * 1000) : 500;
    }
  });

  const list = document.getElementById("budgetCatList");
  list.innerHTML = expenseCats.length === 0 ? '<div class="register-empty">No expense categories yet.</div>' : "";
  expenseCats.forEach((c) => {
    const spent = totals.get(c.id) || 0;
    // Same strictly-greater-than rule as the category rail's bars and the
    // Expenses circle (Budget design decisions) — hitting the budget
    // exactly still reads as normal, not over.
    const over = c.budgetMinor != null && spent > c.budgetMinor;
    const row = document.createElement("div");
    row.className = "bcatrow";
    row.dataset.id = c.id;
    row.innerHTML = `
      <span class="dot" style="background:${c.color}"></span>
      <span class="bcat-name">${escapeHtml(c.name)}</span>
      <span class="bcat-spent${over ? " over" : ""}">${formatMoney(spent, currency)} spent</span>
      <input type="text" class="bcat-budget" inputmode="decimal" placeholder="No budget"
        value="${c.budgetMinor != null ? formatMoney(c.budgetMinor, currency) : ""}">
    `;
    list.appendChild(row);
    const budgetInput = row.querySelector(".bcat-budget");
    // Resting state shows the pretty formatted value (thousands separator
    // + currency, e.g. "3.333 kr.") — type=number can't hold that, hence
    // type=text here. Focus swaps in the plain editable number (also
    // selecting it, so tapping the field is enough to start overwriting —
    // otherwise the cursor lands wherever the tap happened to land within
    // a right-aligned value). blur restores the pretty format; it runs on
    // every blur regardless of whether "change" also fired and rebuilt
    // this row already (change fires first and replaces the row via
    // renderAll() when the value actually changed — this blur handler
    // then fires on the detached old node and is a harmless no-op; when
    // nothing changed, this is the only thing that runs, and this node is
    // still the live one, so it's the only case that needs it).
    budgetInput.addEventListener("focus", (e) => {
      if (c.budgetMinor != null) e.target.value = amountInputValue(c.budgetMinor);
      e.target.select();
    });
    budgetInput.addEventListener("blur", (e) => {
      e.target.value = c.budgetMinor != null ? formatMoney(c.budgetMinor, currency) : "";
    });
    budgetInput.addEventListener("change", (e) => {
      const budgetMinor = parseAmountToMinor(e.target.value);
      editCategory(c.id, { budgetMinor });
      saveState();
      renderAll();
    });
  });

  if (expenseCats.length > 0) {
    const totalRow = document.createElement("div");
    totalRow.className = "bcatrow bcat-totalrow";
    totalRow.innerHTML = `
      <span class="bcat-name">Total budgeted</span>
      <span class="bcat-totalamt">${formatMoney(totalBudget, currency)}</span>
    `;
    list.appendChild(totalRow);
  }
}

function showBudgetView(show) {
  document.getElementById("budgetView").hidden = !show;
  document.getElementById("quickadd").hidden = show;
  document.getElementById("mainCols").hidden = show;
  if (show) document.getElementById("recurringView").hidden = true;
}

function setBudgetRingColor(key, hue, hex) {
  const colors = Object.assign({}, state.settings.budgetRingColors);
  colors[key] = { hue, color: hex };
  state.settings.budgetRingColors = colors;
  state.settings.budgetRingColorsUpdatedAt = nowIso();
  saveState();
  openBcPickerKey = null;
  renderAll();
}

function initBudgetView() {
  document.getElementById("budgetToggle").addEventListener("click", () => showBudgetView(true));
  document.getElementById("budgetBack").addEventListener("click", () => showBudgetView(false));

  // The three ring pickers are static DOM (unlike category rows, which are
  // rebuilt per render), so they're wired once here rather than re-wired
  // on every renderBudgetView() call — that call only toggles visibility
  // and updates the swatch/hue-slider values.
  Object.keys(RING_KEYS).forEach((key) => {
    const { sw, picker } = RING_KEYS[key];
    const swEl = document.getElementById(sw);
    const pickerEl = document.getElementById(picker);
    const presets = pickerEl.querySelector(".presets");
    HUE_STOPS.slice(0, -1).forEach((hex, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.style.background = hex;
      b.addEventListener("click", () => setBudgetRingColor(key, i / (HUE_STOPS.length - 1), hex));
      presets.appendChild(b);
    });
    const hueInput = pickerEl.querySelector(".hue");
    hueInput.addEventListener("input", () => {
      swEl.style.background = hueColor(Number(hueInput.value) / 1000);
    });
    hueInput.addEventListener("change", () => {
      const hue = Number(hueInput.value) / 1000;
      setBudgetRingColor(key, hue, hueColor(hue));
    });
    pickerEl.querySelector(".bc-reset").addEventListener("click", () => {
      const colors = Object.assign({}, state.settings.budgetRingColors);
      colors[key] = null;
      state.settings.budgetRingColors = colors;
      state.settings.budgetRingColorsUpdatedAt = nowIso();
      saveState();
      openBcPickerKey = null;
      renderAll();
    });
    swEl.addEventListener("click", (e) => {
      e.stopPropagation();
      openBcPickerKey = openBcPickerKey === key ? null : key;
      renderBudgetView();
    });
    pickerEl.addEventListener("click", (e) => e.stopPropagation());
  });
  document.addEventListener("click", (e) => {
    if (!openBcPickerKey) return;
    const pickerEl = document.getElementById(RING_KEYS[openBcPickerKey].picker);
    if (pickerEl && !pickerEl.contains(e.target)) {
      openBcPickerKey = null;
      renderBudgetView();
    }
  });
}

// ---------- rendering: recurring ----------
//
// Same bones as the category rail: a Spent/Income toggle, a list of rows
// editable inline (name/amount/category/day), an add form. Editing or
// deleting a row never touches entries already auto-inserted from it —
// see createRecurring/editRecurring/deleteRecurring and "Recurring design
// decisions" in CLAUDE.md.

let recurringDir = "expense";

function renderRecurringView() {
  const currency = state.settings.currency;

  document.querySelectorAll("#recurringDirToggle button").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.dir === recurringDir));
  });

  const addCatSelect = document.getElementById("newRecCategory");
  populateCategorySelect(addCatSelect, recurringDir, addCatSelect.value);

  // Totals always show both directions regardless of which side the
  // toggle is on — a plain sum of everything declared, not scoped to the
  // currently-viewed list (Recurring design decisions). Paused and not-
  // yet-started items are excluded — the totals describe what's currently
  // actually going to auto-insert, not everything ever declared.
  const today = new Date();
  const live = state.recurring.filter((r) => !r.deleted);
  const activeLive = live.filter((r) => isRecurringActive(r, today));
  const totalIncome = activeLive.filter((r) => r.direction === "income").reduce((s, r) => s + r.amountMinor, 0);
  const totalExpenses = activeLive.filter((r) => r.direction === "expense").reduce((s, r) => s + r.amountMinor, 0);
  document.getElementById("recurringSummaryBox").innerHTML = `
    <div class="summary-row income"><span>Recurring income</span><b>${formatMoney(totalIncome, currency)}</b></div>
    <div class="summary-row"><span>Recurring expenses</span><b>${formatMoney(totalExpenses, currency)}</b></div>
  `;

  // The list itself still shows paused/future-dated items (marked inactive
  // below) — only the totals above narrow to what's currently active.
  const list = document.getElementById("recurringList");
  const dirRecs = live.filter((r) => r.direction === recurringDir);

  // Chip row offers every category used by a recurring item in this
  // direction — paused/not-yet-started ones included, since they're still
  // shown in the list and so should be filterable (matches the "still real,
  // just not currently doing anything" language elsewhere).
  renderCatFilter(document.getElementById("recurringFilter"), dirRecs, recurringCatFilter, renderRecurringView);

  const filterActive = recurringCatFilter.size > 0;
  const items = filterActive
    ? dirRecs.filter((r) => recurringCatFilter.has(r.categoryId))
    : dirRecs;

  if (dirRecs.length === 0) {
    list.innerHTML = `<div class="register-empty">No recurring ${recurringDir === "income" ? "income" : "expenses"} yet.</div>`;
    return;
  }
  if (items.length === 0) {
    list.innerHTML = `<div class="register-empty">No recurring items in the selected categories.<br><button type="button" class="linkbtn" id="recurringFilterClear">Show all categories</button></div>`;
    document.getElementById("recurringFilterClear").addEventListener("click", () => {
      recurringCatFilter.clear();
      renderRecurringView();
    });
    return;
  }
  list.innerHTML = "";

  // Grouped by day-of-month, same rhythm as the register grouping entries
  // by day — a day header (reusing .dayhead) with that day's total, then
  // the items themselves.
  const byDay = new Map();
  items.forEach((r) => {
    if (!byDay.has(r.dayOfMonth)) byDay.set(r.dayOfMonth, []);
    byDay.get(r.dayOfMonth).push(r);
  });
  Array.from(byDay.keys()).sort((a, b) => a - b).forEach((day) => {
    const rows = byDay.get(day);
    // Day-group totals exclude paused/future-dated items too, same as the
    // summary box above — a day total that disagreed with the summary
    // about what "active" means would be confusing.
    const dayTotal = rows.filter((r) => isRecurringActive(r, today)).reduce((s, r) => s + r.amountMinor, 0);
    const head = document.createElement("div");
    head.className = "dayhead";
    // IN/OUT prefix when a category filter is active, mirroring the
    // register's collapsed day/week headers (the filter is direction-scoped,
    // so one label is always right).
    const headPrefix = filterActive ? (recurringDir === "income" ? "IN " : "OUT ") : "";
    head.innerHTML = `<b>${ordinal(day).toUpperCase()}</b><span>${headPrefix}${formatMoney(dayTotal, currency)}</span>`;
    list.appendChild(head);

    rows.forEach((r) => {
      const cat = catById(r.categoryId);
      const amtClass = r.direction === "income" ? "income" : "";
      const sign = r.direction === "income" ? "+" : "−";
      const active = isRecurringActive(r, today);
      // Same row shape as the register's .entryrow (category on top, name
      // as the muted line underneath, amount right-aligned) — editing moved
      // into a popup sheet instead of inline fields, per Sebastian's request
      // (2026-08-12) that a recurring item read exactly like a logged entry
      // instead of sprawling across two lines on narrow screens. A paused
      // or not-yet-started item stays in the list (dimmed via .inactive)
      // rather than disappearing — the status is appended to the note line
      // rather than taking a second line, keeping the row one line tall.
      let statusSuffix = "";
      if (r.paused) statusSuffix = " · Paused";
      else if (r.startMonth && r.startMonth > monthKey(today.getFullYear(), today.getMonth())) {
        const [sy, sm] = r.startMonth.split("-").map(Number);
        statusSuffix = " · Starts " + new Date(sy, sm - 1, 1).toLocaleDateString(undefined, { month: "short", year: "numeric" });
      }
      const row = document.createElement("button");
      row.type = "button";
      row.className = "entryrow" + (active ? "" : " inactive");
      row.dataset.id = r.id;
      row.innerHTML = `
        <span class="dot" style="background:${cat ? cat.color : "var(--none)"}"></span>
        <span class="meta">
          <span class="cat">${cat ? escapeHtml(cat.name) : "Uncategorized"}</span>
          <span class="note">${escapeHtml(r.name)}${escapeHtml(statusSuffix)}</span>
        </span>
        <span class="amt ${amtClass}">${sign}${formatMoney(r.amountMinor, currency)}</span>
      `;
      row.addEventListener("click", () => openEditRecurringSheet(r.id));
      list.appendChild(row);
    });
  });
}

// ---------- edit recurring sheet ----------
// Mirrors openEditSheet/closeEditSheet/initEditSheet above almost exactly —
// same .scrim/.sheet/.dirtoggle/.two/.field/.sheet-actions markup and CSS,
// just Day (a select) standing in for Date and Name standing in for Note.

function openEditRecurringSheet(recurringId) {
  editingRecurringId = recurringId;
  const r = state.recurring.find((x) => x.id === recurringId);
  const scrim = document.getElementById("editRecurringScrim");
  const dirBtns = scrim.querySelectorAll(".dirtoggle button");
  const catSelect = document.getElementById("editRecCategory");

  function setDir(dir) {
    dirBtns.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.dir === dir)));
    populateCategorySelect(catSelect, dir, r.categoryId);
  }
  dirBtns.forEach((b) => { b.onclick = () => setDir(b.dataset.dir); });

  setDir(r.direction);
  document.getElementById("editRecName").value = r.name;
  document.getElementById("editRecAmount").value = amountInputValue(r.amountMinor);
  populateDaySelect(document.getElementById("editRecDay"), r.dayOfMonth);
  populateMonthSelect(document.getElementById("editRecStartMonth"), r.startMonth);
  const pauseBtn = document.getElementById("editRecPauseToggle");
  pauseBtn.textContent = r.paused ? "Resume this recurring item" : "Pause this recurring item";
  scrim.classList.add("on");
}

function closeEditRecurringSheet() {
  editingRecurringId = null;
  document.getElementById("editRecurringScrim").classList.remove("on");
}

function initEditRecurringSheet() {
  const scrim = document.getElementById("editRecurringScrim");
  document.getElementById("editRecCancel").addEventListener("click", closeEditRecurringSheet);
  scrim.addEventListener("click", (e) => { if (e.target === scrim) closeEditRecurringSheet(); });

  document.getElementById("editRecurringForm").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!state.recurring.some((x) => x.id === editingRecurringId)) return;
    const dir = scrim.querySelector('.dirtoggle button[aria-pressed="true"]').dataset.dir;
    const amountMinor = parseAmountToMinor(document.getElementById("editRecAmount").value);
    if (amountMinor == null) return;
    const name = document.getElementById("editRecName").value.trim();
    if (!name) return;
    const day = Math.round(Number(document.getElementById("editRecDay").value));
    editRecurring(editingRecurringId, {
      direction: dir,
      amountMinor,
      name,
      categoryId: document.getElementById("editRecCategory").value,
      dayOfMonth: day,
      startMonth: document.getElementById("editRecStartMonth").value,
    });
    saveState();
    closeEditRecurringSheet();
    toast("Recurring item updated");
    renderAll();
  });

  // Pausing stops future auto-insert without deleting the record; resuming
  // triggers the due-check synchronously in this same click, not deferred
  // to the next app open — deliberately diverges from how a brand-new
  // Recurring item behaves (which only gets caught up on next load), per
  // Sebastian's explicit call: a silent multi-day gap before a resumed
  // item's entry shows up has the same "did this actually work?" problem
  // the original "insert immediately" decision was about.
  document.getElementById("editRecPauseToggle").addEventListener("click", () => {
    if (!editingRecurringId) return;
    const r = state.recurring.find((x) => x.id === editingRecurringId);
    if (!r) return;
    if (r.paused) {
      resumeRecurring(editingRecurringId);
      saveState();
      applyDueRecurring();
      toast("Recurring item resumed");
    } else {
      pauseRecurring(editingRecurringId);
      saveState();
      toast("Recurring item paused");
    }
    closeEditRecurringSheet();
    renderAll();
  });

  document.getElementById("editRecDelete").addEventListener("click", () => {
    if (!editingRecurringId) return;
    const recurring = deleteRecurring(editingRecurringId);
    if (!recurring) return;
    saveState();
    closeEditRecurringSheet();
    toast(`"${recurring.name}" removed from Recurring`, () => {
      undeleteRecurring(recurring.id);
      saveState();
      renderAll();
    });
    renderAll();
  });
}

function showRecurringView(show) {
  document.getElementById("recurringView").hidden = !show;
  document.getElementById("quickadd").hidden = show;
  document.getElementById("mainCols").hidden = show;
  if (show) document.getElementById("budgetView").hidden = true;
}

function initRecurringView() {
  document.getElementById("recurringToggle").addEventListener("click", () => showRecurringView(true));
  document.getElementById("recurringBack").addEventListener("click", () => showRecurringView(false));
  // Static — 31 fixed options, never depends on state, so populated once
  // here rather than rebuilt on every render (unlike the category select,
  // whose options change with recurringDir). The start-month window is
  // likewise anchored to real today, not the viewed month, so it's also
  // safe to populate once; defaults to the current month per the agreed
  // default (a newly-declared item starts now unless pushed forward).
  populateDaySelect(document.getElementById("newRecDay"), 1);
  const today = new Date();
  populateMonthSelect(document.getElementById("newRecStartMonth"), monthKey(today.getFullYear(), today.getMonth()));
  document.querySelectorAll("#recurringDirToggle button").forEach((b) => {
    b.addEventListener("click", () => { recurringDir = b.dataset.dir; recurringCatFilter.clear(); renderAll(); });
  });
  document.getElementById("addRecurringForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = document.getElementById("newRecName").value.trim();
    const amountMinor = parseAmountToMinor(document.getElementById("newRecAmount").value);
    const categoryId = document.getElementById("newRecCategory").value;
    const day = Math.round(Number(document.getElementById("newRecDay").value));
    const startMonth = document.getElementById("newRecStartMonth").value;
    if (!name || amountMinor == null || !categoryId || !day || day < 1 || day > 31 || !startMonth) return;
    createRecurring({ name, amountMinor, direction: recurringDir, categoryId, dayOfMonth: day, startMonth });
    saveState();
    document.getElementById("newRecName").value = "";
    document.getElementById("newRecAmount").value = "";
    toast(`"${name}" added to Recurring`);
    renderAll();
  });
}

function renderAll() {
  if (!state.settings.currency) return;
  document.getElementById("monthLabel").textContent = monthLabel(viewYear, viewMonth);
  renderSummary();
  renderRegister();
  renderCategoryRail();
  renderSettings();
  renderBudgetView();
  renderRecurringView();
  refreshQuickAddCategories();
}

// ---------- init ----------

// Exposes the real functions above to money-ledger-selftest.html — not
// copies of them, the same functions the UI calls. See CLAUDE.md "Testing."
function exposeTestHook() {
  window.__ML_TEST__ = {
    getState: () => state,
    setState: (s) => { state = s; renderAll(); },
    resetState: () => {
      state = defaultState();
      localStorage.removeItem(STORAGE_KEY);
      clearDriveTokenCache();
      FAKE_DRIVE = {};
      fakeDriveNextId = 1;
      driveAccessToken = null;
      driveReconnectAttempted = false;
      clearDriveAuthWatchdog();
      lastOAuthWindow = null;
      registerCatFilter.clear();
      recurringCatFilter.clear();
      renderAll();
    },
    saveState,
    renderAll,

    createEntry, editEntry, deleteEntry, undeleteEntry,
    createCategory, editCategory, deleteCategory, undeleteCategory,

    getDeviceId: () => DEVICE_ID,
    setDeviceId: (id) => { DEVICE_ID = id; },

    // Runs the REAL loadState() against a planted STORAGE_KEY value (null =
    // key absent). Exercises the corrupt-data / missing-ledger fallbacks
    // and their DEVICE_ID regeneration exactly as a real page load would.
    SEED_UPDATED_AT,
    loadStateFrom: (raw) => {
      if (raw == null) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, raw);
      return loadState();
    },

    getFakeDrive: () => FAKE_DRIVE,
    resetFakeDrive: () => { FAKE_DRIVE = {}; fakeDriveNextId = 1; },

    // Page-load sync decision + the token cache it reads, so a test can
    // assert "connected but no usable token -> wait for a tap, never a
    // popup" without touching Google Identity Services.
    pageLoadSyncPlan, saveDriveTokenCache, clearDriveTokenCache,

    // OAuth-popup window-name wrapper + the settle paths that close it.
    // setNativeWindowOpen swaps in a spy so a test can drive
    // openOAuthAwareWindow without opening a real window.
    freshOAuthWindowName, openOAuthAwareWindow, closeLastOAuthWindow,
    driveAuthErrorCallback, onDriveAuthWatchdogFired, handleDriveAuthResult,
    getLastOAuthWindow: () => lastOAuthWindow,
    setLastOAuthWindow: (w) => { lastOAuthWindow = w; },
    setNativeWindowOpen: (fn) => { nativeWindowOpen = fn; },

    // "Tap anywhere to reconnect" gating decision + the two knobs a test
    // needs to stand in for real GIS state: the one-shot flag and the
    // in-flight watchdog. resolveGestureReconnect never reaches real OAuth.
    resolveGestureReconnect,
    getDriveReconnectAttempted: () => driveReconnectAttempted,
    setDriveReconnectAttempted: (v) => { driveReconnectAttempted = v; },
    armDriveAuthWatchdog, clearDriveAuthWatchdog,

    syncNow, resolveDriveFileId, mergeRecords, sameContent, newerSide,
    ENTRY_CONTENT_FIELDS, CATEGORY_CONTENT_FIELDS, AMBIGUOUS_WINDOW_MS, DRIVE_FILE_NAME,

    // Sets driveAccessToken/driveFileId/driveConnected directly, as a
    // successful real connect would leave them — without a live Google
    // account, since TEST_MODE never performs the real OAuth flow.
    testConnectDrive: (fileId) => {
      driveAccessToken = "fake-token";
      state.settings.driveFileId = fileId || null;
      state.settings.driveConnected = true;
    },

    uid, nowIso, todayStr, isoDate, parseIso,
    entriesInMonth, categoriesFor, catById,
    SEED_CATEGORIES,

    formatMoney, formatCompact, parseAmountToMinor, monthTotals, sumByCategory,
    getViewDir: () => viewDir,
    setViewDir: (dir) => { viewDir = dir; registerCatFilter.clear(); renderAll(); },

    // Category filter (view-state only, never persisted or synced).
    getRegisterCatFilter: () => Array.from(registerCatFilter),
    setRegisterCatFilter: (ids) => { registerCatFilter.clear(); (ids || []).forEach((id) => registerCatFilter.add(id)); renderAll(); },
    getRecurringCatFilter: () => Array.from(recurringCatFilter),
    setRecurringCatFilter: (ids) => { recurringCatFilter.clear(); (ids || []).forEach((id) => recurringCatFilter.add(id)); renderAll(); },

    // Deterministic control over "which month is currently displayed" — the
    // real app defaults this to the real today's month at load, which is
    // fine for sync tests (they never read rendered output) but wrong for
    // anything that reads the DOM: a test dated "the 1st of the month"
    // needs to control which month that IS, not depend on whenever the
    // suite happens to run.
    getViewMonth: () => viewMonth,
    getViewYear: () => viewYear,
    setView: (y, m) => { viewYear = y; viewMonth = m; renderAll(); },

    createRecurring, editRecurring, deleteRecurring, undeleteRecurring,
    pauseRecurring, resumeRecurring,
    daysInMonth, clampDay, dueRecurring, applyDueRecurring, recurringInsertId,
    monthKey, isRecurringActive,
    RECURRING_CONTENT_FIELDS,
    getRecurringDir: () => recurringDir,
    setRecurringDir: (dir) => { recurringDir = dir; renderAll(); },
  };
}

document.addEventListener("DOMContentLoaded", () => {
  initIntro();
  initQuickAdd();
  initEditSheet();
  initMonthNav();
  initCategoryRail();
  initSettings();
  initBudgetView();
  initRecurringView();
  initEditRecurringSheet();
  initFab();
  initHomeLink();
  if (state.settings.currency) renderAll();
  // Real mode only — TEST_MODE drives dueRecurring/applyDueRecurring
  // explicitly via the hook, so a sync test's resetState() never gets a
  // surprise auto-inserted entry it didn't ask for. A Drive-connected
  // device with a still-valid cached token pulls first, so it sees what
  // another device already synced before deciding what's due (see
  // resumeDriveSyncIfTokenCached above); without a cached token it can't
  // pull without a user tap, so applyDueRecurring runs immediately (the
  // deterministic recurringInsertId is the backstop). A local-only device
  // has no other side to race against, so it also decides immediately.
  if (!TEST_MODE && state.settings.driveConnected) {
    resumeDriveSyncIfTokenCached(applyDueRecurring);
  } else {
    if (!TEST_MODE) applyDueRecurring();
    resumeDriveSyncIfTokenCached();
  }
  if (TEST_MODE) exposeTestHook();
});
