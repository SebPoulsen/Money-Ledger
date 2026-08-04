# Money Ledger

Money Ledger is a monthly money tracker: you log what actually happened, by
hand, and review where it went by category, week, and month.
It deliberately is not a bank-linked auto-importer — typing every entry in
yourself is the point, not a limitation, the same way Hours Ledger makes you
log the week you actually had rather than infer it.

This is the second tool in a family with [Hours Ledger](https://sebpoulsen.github.io/Hours-Ledger)
— same method (log reality, judge it after), applied to money instead of time.
It should look like it belongs next to Hours Ledger: same colours, same type,
same ledger-paper, square-cornered plainness — not a reskin, since money has
different shapes than time (no time-of-day grid, a signed ledger instead).

Built and maintained by Sebastian Poulsen, who is learning to work with Claude Code
through these projects. **Explain your reasoning as you go.** When there is more
than one sensible way to do something, say what the options were and why you picked
one. Teaching matters here as much as shipping. If I accept a change without
understanding it, that is a failure of the session even if the code is correct.

Push back on me. If a request is a bad idea, say so before doing it. If I ask for
something that contradicts a rule below, stop and say which rule.

---

## Hard rules — do not break these

1. **Entry schema and storage format must never silently change shape.** An
   `Entry` is `{id, date, amountMinor, direction, categoryId, note, recurringId}`
   (see data model below). If the schema has to change — a new field, a
   renamed key, a new storage format — write a migration that upgrades old
   data in place before any new code reads it, and keep the old reader
   working until the migration has been verified against a real exported
   ledger, not a synthetic one. This applies to both the localStorage copy
   and the Google Drive file format once sync exists. *Real user data is the
   one thing you cannot apologise your way out of.*
2. **No framework, no bundler, no npm dependency shipped to the user.**
   Vanilla HTML/CSS/JS, loaded straight by the browser, same as Hours Ledger.
   The one exception is Google's Identity Services script, loaded via a
   `<script src>` tag for Drive OAuth — not installed as a package, nothing
   to bundle. Dev-only tooling (a formatter, a linter) never ships to the
   site.
3. **No build step.** `index.html` + `style.css` + `app.js`, served directly
   by GitHub Pages. Don't introduce a transpiler or bundler to "solve" a
   problem — solve it in plain JS instead.
4. **Nothing leaves the device unless the user explicitly connects Drive
   sync.** By default, entries live only in `localStorage`. The opt-in
   "Connect Google Drive" flow syncs directly from the browser to the user's
   own Drive via the narrow `drive.file` scope (only files this app
   created) — no server under my control ever receives, stores, or can read
   a user's ledger data, because there is no server. If any future change
   would route user data through infrastructure I control, stop and flag it
   before writing the code — that promise is the whole reason sync is safe
   to offer to strangers.
5. **Every entry must stay editable and deletable after the fact.**
   Disconnecting Drive must never delete local data. Connecting Drive must
   never silently overwrite one device's data with another's — if two
   devices disagree, surface the conflict, don't auto-resolve it silently.
6. **No sync operation may remove a record the other side hasn't
   acknowledged.** Neither direction — pushing to Drive nor pulling from
   it — may cause a record present on one side to disappear unless that
   side has actually seen it. A whole-file timestamp comparison is not
   enough to satisfy this: "pushed most recently" is not the same claim
   as "has seen everything the other side has," and treating them as
   equivalent is exactly the bug this rule exists to prevent (2026-08-03:
   a stale device's push silently erased a newer entry from another
   device, twice — once on pull via a "newer data?" prompt the user
   correctly didn't trust, once on push with no prompt at all). Sync must
   merge record-by-record before writing, in both directions, with no
   exception for "just this once, it's probably fine."
   This rule governs whether a *record* (an id) survives — it does not
   require every conflicting *edit* to survive too. See "Sync design
   decisions" below: when a record survives on both sides but its content
   genuinely disagrees, the losing edit's specific field values may be
   discarded outright. That's a deliberate, narrower exception to this
   rule, not a violation of it.
7. **Ask before restructuring.** Propose and wait. Do not refactor broadly in
   a session that was asked for a small fix.
8. **Do not claim something works if you have not verified it.** "This
   should work" and "I ran this and it worked" are different sentences. Use
   the honest one.
9. **The self-test suite must run and pass before any push touching sync,
   merge, or storage.** From the repo root: `python3 -m http.server`, then
   open `money-ledger-selftest.html` and confirm "0 failing" in the summary
   line. Not optional verification — the gate itself. See "Testing before
   you claim it works" for what TEST_MODE isolates and why the suite exists
   (2026-08-03/04 — it exists specifically to catch the class of bug that
   shipped that night).

## Sync design decisions

**Same-record conflicts: last-write-wins, not keep-both (2026-08-04).**
When the same record has been edited differently on two devices, both
still live (not a delete-vs-edit case — that's the separate
never-delete-on-ambiguous bias, which stays), the later edit wins
outright and the earlier one is discarded. This was originally built as
keep-both-flagged-for-review; deliberately changed after live testing,
for a reason worth preserving so it isn't re-litigated the next time
someone eyes the "what if we lose an edit" question:

Editing the same record on two devices while one hasn't synced yet is
rare for a personal ledger, and when it happens both edits are usually
real, deliberate decisions rather than noise — there's no principled way
to guess which one the user actually meant to keep. Discarding the
older one and moving on costs one edit, occasionally; a conflict-review
UI for something that happens a couple of times a year isn't worth the
complexity it would add everywhere else.

If this ever needs revisiting — e.g. multi-user ledgers, or edits
frequent enough that losing one actually stings — reopen it as a new
decision, don't just quietly add complexity back.

**No user-facing notice when last-write-wins discards an edit
(2026-08-04).** The first version of the decision above required a
toast whenever a device's own edit got superseded, on the theory that
"silent" was the unacceptable part, not the resolution. Reconsidered
after actually testing it: this is a personal tool where the point is
to think as little as possible while using it, and a notification that
fires maybe once a year is noise Sebastian will have forgotten the
meaning of by the time it appears. The resolution is correct either
way — there's no decision here he'd need to be told about, because
last-write-wins is what he'd have chosen himself. `mergeRecords` still
counts superseded edits and `syncNow` logs the count to the console,
but nothing reaches the UI. If this changes — e.g. sync becomes
frequent enough that losing edits silently actually causes confusion —
reopen it rather than quietly adding the toast back.

## Testing before you claim it works

There is an automated self-test suite for the sync/merge logic —
`money-ledger-selftest.html`, modeled directly on Hours Ledger's own
`hours-ledger-selftest-reference.html`. It exists specifically because
`mergeRecords` behaving correctly in isolation was never the whole story —
2026-08-03/04's actual bugs were in how the app *called* merge in sequence
on one device, which only a full sync-path test could catch.

**How to run it:** serve the folder locally (`python3 -m http.server`,
same as the app itself — opening as `file://` hits a cross-origin error on
the iframe) and open `money-ledger-selftest.html` by hand. It's never
linked from the real app. It loads `index.html?mltest=1` in a hidden
iframe, drives the real functions via `window.__ML_TEST__` (not
reimplementations of them), and renders PASS/FAIL rows with a
failing/total summary.

**Isolation — a test run cannot reach real data:**
- `?mltest=1` sets `TEST_MODE`, which suffixes `STORAGE_KEY` and
  `DEVICE_ID_KEY` with `-TESTMODE`, so a test run's `localStorage` never
  overlaps the real ledger's key.
- The four Drive network functions (`driveFindFiles`, `driveCreateFile`,
  `driveUpdateFile`, `driveReadFile`) each branch on `TEST_MODE` *before*
  constructing any `fetch()` call, and operate on an in-memory `FAKE_DRIVE`
  object instead. This isn't "tests avoid calling the real network
  function" — the real function itself cannot reach `googleapis.com` in
  this mode, structurally, not by convention.
- No real OAuth popup ever fires in TEST_MODE (`initDriveSilentReconnect`
  no-ops); tests that need a connected state call `testConnectDrive()`,
  which sets the same fields a real successful connect would leave behind.
- `window.confirm` is stubbed to auto-accept in TEST_MODE only, so
  delete/import/clear-month flows don't hang a headless run waiting for a
  dialog no one will click.

**What it covers:** the `mergeRecords` algorithm directly (only-local,
only-remote, both-edited, delete-vs-edit, identical/skewed/ambiguous
timestamps, empty sides, seed-category id collisions) and full sequences
through the real `createEntry`/`editEntry`/`deleteEntry`/`syncNow` path,
simulating two devices in one iframe by snapshotting and restoring state
between them. Includes a regression test for each of 2026-08-03/04's five
bugs (silent push overwrite, silent pull overwrite, undelete, edit
duplication, category duplication) and one longer test walking the full
manual repro end to end.

**The standing rule, going forward, same as Hours Ledger: every bug gets a
test that would have caught it, written before the fix, watched to fail
against the old code first.** Verified this actually works before trusting
it (2026-08-04): extracted `9eeabdb` and `11f58ff` — the commits before
each fix — into scratch copies with a network-fetch shim standing in for
Drive, ran the same scenarios against them directly, and confirmed each
failed exactly as reported (Drive silently missing an entry; a deleted
entry reappearing; an edit producing a second live record; seed categories
exactly doubling) before confirming they pass on current code.

Beyond the self-test suite, still verify manually and say which of these
you actually did, not which apply in theory:

- Log an expense and an income entry; confirm direction, sign, and colour
  are correct (plain ink for expense, green for income, red only when a
  category or month goes over budget).
- Reload the page and confirm entries persisted from `localStorage`.
- Edit and delete an existing entry; confirm the change survives a reload.
- If Drive sync is involved: connect on one browser profile, confirm the
  file appears in the user's actual Drive, then read it from a second
  profile and confirm entries match, including after an edit on either side.
- Mobile viewport width: confirm logging an entry is still reachable
  one-thumb, matching Hours Ledger's FAB pattern.

If you couldn't test something, say so plainly and tell me what to click.

## Deploy

Push to `main` → GitHub Pages serves it directly, no build step, live within
a minute or two. Pages isn't enabled on this repo yet (checked: currently
404s) — it activates the first time `index.html` lands on `main`.

---

## The data model

```
Entry {
  id: string            // uuid
  date: "YYYY-MM-DD"
  amountMinor: integer   // cents / øre — never a float, avoids rounding drift
  direction: "expense" | "income"
  categoryId: string
  note: string           // optional, "" if empty
  recurringId: string | null   // set only if auto-inserted from a subscription (phase 3)
  updatedAt: string       // ISO 8601, bumped on every change to THIS record —
                          // what sync merges by, never the whole-file updatedAt
  updatedBy: string | null   // DEVICE_ID of whoever last touched this record;
                              // null means "unknown" (pre-sync data), treated
                              // conservatively as "not this device"
  deleted: boolean        // tombstone, not physical removal — see hard rule 6
  deletedAt: string | null
}

Category {
  id: string
  name: string
  color: string           // hex, chosen via the same hue-slider as Hours Ledger
  direction: "expense" | "income"   // separate lists per direction, not one shared pool
  budgetMinor: integer | null       // phase 2
  updatedAt: string
  updatedBy: string | null
  deleted: boolean
  deletedAt: string | null
}

Subscription {            // phase 3
  id: string
  name: string
  amountMinor: integer
  categoryId: string
  dayOfMonth: integer     // 1-31, clamped to last day of short months
}

Settings {
  currency: string         // ISO 4217, e.g. "DKK", "USD" — chosen on first launch, changeable after
  driveConnected: boolean
  driveFileId: string | null   // the Drive file this device is synced to, once connected
}

State (top-level, the whole localStorage/Drive-file blob) {
  version: integer
  updatedAt: string        // ISO 8601, bumped on every save — bookkeeping
                            // only; sync decisions are per-record now, never
                            // by comparing this field (that was the bug)
  settings: Settings
  categories: Category[]
  entries: Entry[]
  subscriptions: Subscription[]
}
```

Seed categories use fixed ids (`"seed-groceries"` etc., see `SEED_CATEGORIES` in
`app.js`), not generated ones — two freshly-installed devices need to agree
that their starter "Groceries" is the same record, or merging duplicates
every seed category on first connect.

`DEVICE_ID` is a separate `localStorage` key (`money-ledger-device-id`),
generated once per browser profile — deliberately **not** part of `State`,
so it's never overwritten by a pull from Drive. It exists purely so merge
can tell "a stale copy of my own last push" (no real ambiguity — one
device's clock ordering of its own actions is never in question) apart
from "another device's edit" (where clock skew is a genuine concern).

- Amounts are always integer minor units. Format for display using
  `Settings.currency`'s locale rules; never do arithmetic on formatted
  strings.
- `Category.direction` splits expense and income into separate pickers —
  follows from the ledger being a single signed stream that defaults to
  expense with a manual flip to income; a mixed "Salary / Groceries"
  dropdown would be confusing.
- `note` and `recurringId` may legitimately be empty/null — not a bug.
- Dates are local calendar dates (`YYYY-MM-DD`), no time-of-day component —
  money doesn't have an hour, unlike Hours Ledger's entries.

## How the code is organised

Not yet built. Expect the same shape as Hours Ledger: `index.html` +
`style.css` + `app.js`, one file per concern, no framework — update this
section once the real structure exists.

## Design constraints

Should look and feel like the same family as Hours Ledger, applied to a
different resource. It must never drift toward looking like a generic
budgeting SaaS product (soft shadows, rounded cards, upsell energy) — the
ledger-paper plainness *is* the trust signal.

- **Colours**, reused from Hours Ledger's palette (`hours-ledger-reference.css`):
  `--paper`/`--ink`/`--rule`/`--muted` for structure and text, same as
  Hours Ledger. `--flag` (red) stays reserved for warnings and destructive
  actions — here specifically for over-budget states — never for ordinary
  expense amounts. Income entries get a new green, not in the original
  palette, reserved solely for marking a row as income so direction is
  never ambiguous at a glance.
- **Type**: `--display` (Archivo) for headings and category names,
  `--mono` (Spline Sans Mono) for all amounts, dates, and uppercase labels
  — same split as Hours Ledger, where numbers and data are always mono.
- **Shape language**: square corners, 1px rules, no shadows, no border-radius
  — carried over exactly as-is from Hours Ledger.
- **The signature element**: still being decided together — the day×hour
  grid was Hours Ledger's, but money has no time-of-day. Candidate is a
  chronological register (a running list with a running balance) paired
  with a category-totals panel, echoing Hours Ledger's grid+rail layout
  without copying the grid itself. Confirm once we've actually built and
  looked at it.

---

## Backlog, roughly in order

1. **V1 — logging, review, and sync.** Frictionless entry logging (defaults
   to expense, one press flips to income), category CRUD with the
   hue-picker/dot system, seeded starter categories, first-launch
   currency-choice popup with a "Start Logging" CTA (mirrors Hours Ledger's
   intro), week and month review views, and opt-in Google Drive sync via
   `drive.file`. Sync is in v1, not deferred, because it changes the
   storage layer's shape and is easier to design in from the start than to
   retrofit. **Status:** code is written (`GOOGLE_CLIENT_ID` constant near
   the top of `app.js`, currently empty — paste in the real OAuth Client ID
   from Google Cloud Console). Sync logic itself hasn't been exercised
   against a real Google account yet — an OAuth popup can't be driven by
   Claude, so this needs a real click-through by Sebastian before it's
   "done." One implementation detail worth re-checking under real load:
   `driveTokenClientFor()` reuses a single token client and reassigns its
   `.callback` per call rather than creating a fresh client each time — this
   is a common pattern with Google Identity Services but isn't in their
   official per-call API, so watch for stale-callback bugs during testing.
2. **Budgets.** Per-category monthly budget amounts and the budget-vs-actual
   visual — this is what finally gives `--flag` red something real to
   trigger on. The category bar and the month's Net figure should read as a
   *depletion* against the budget, not a plain proportion: full/bright at
   the start of the month, draining down as spending accrues against that
   category's (or the month's) budget, turning to `--flag` red once it runs
   out. Confirmed with Sebastian on 2026-08-03.
3. **Recurring subscriptions.** Declare once (name, amount, category,
   day-of-month), auto-inserted as a real entry every month without
   retyping. Built last because it acts on entries and categories that need
   to already be solid.

Do not add features that are not on this list without discussing them first.

## Out of scope

- **Bank-linked auto-import.** Deliberately rejected — manual entry is the
  point, the same way Hours Ledger doesn't infer your week from a calendar.
- **A Sebastian-controlled backend storing user financial data.** Rejected
  because this is a public tool for real strangers' real money data — see
  hard rule 4. If sync ever needs more than Drive can offer, stop and raise
  it as a new decision, don't quietly add a database.
- **Per-category keep/compress/cut verdict**, Hours Ledger's reflective
  judgment ritual — not carried over for now. Revisit once budgets (backlog
  #2) exist, since a verdict without a budget number behind it has less to
  anchor on for money than it does for time.

## Open questions

- The main view's actual layout (register vs. grid vs. table-only) is a
  direction, not a decision — settle it once there's a working version to
  look at, not in the abstract.
- Google's OAuth app verification (required to remove the "unverified app"
  warning for the public) needs a privacy policy page and a review that can
  take days to weeks. Until approved, real strangers will see a click-through
  warning screen on "Connect Google Drive" — decide together whether that's
  acceptable for an early public v1 or whether to gate the sync button
  behind something until verification clears.
- GitHub Gist was considered and rejected as the sync target over Google
  Drive: a "secret" gist is unlisted, not access-controlled — anyone with
  the URL can read it. Worth revisiting only if a stronger case for it shows
  up later.
