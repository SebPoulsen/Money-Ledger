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
10. **Anything touching money, totals, dates, or budgets ships with tests
    in the same commit — not after, not as manual checks run once and
    thrown away.** This is automatic; Sebastian does not need to ask for
    "with tests" — a feature request in one of these areas already implies
    it, the same way "no build step" doesn't need to be repeated per
    request. Applies to both kinds of correctness: the *math* (does the
    number come out right — extract a pure function and assert on it
    directly, the way `mergeRecords` already is) and *rendering* (does the
    right value/state actually reach the DOM — read `d`, the iframe's
    contentDocument, already threaded through `money-ledger-selftest.html`
    but unused for years; see "Testing before you claim it works" for why
    that gap existed and how it's closed now). A scratch/disposable
    verification page is fine for figuring out *whether* something works
    during a session, exactly as before — but once it works, the assertion
    that proved it belongs in the permanent suite before the commit, not
    deleted with the scratch file (2026-08-11 — the Budgets feature's own
    25 checks and three rounds of circle-redesign screenshots shipped this
    way and left zero permanent coverage behind; see "Testing before you
    claim it works" for the full diagnosis).

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

## Budget design decisions

**Income is a plain counter, never measured against anything (2026-08-11).**
The three circles on the Budget screen (income, net, expenses) don't share
one "measure everything against the total budget" rule, even though that
was the first design on the table. Income specifically doesn't get a
budget field, doesn't get a predicted/actual split, doesn't turn red — it
just shows what's been logged. Reasoning, reconstructed from the actual
conversation: budgeting is optional everywhere else in the app (a category
with no budget just shows a plain total), and forcing income through the
same "predicted vs actual" frame would mean either inventing a new
"income target" setting nobody asked for, or making the circle empty and
alarming-looking early in the month before payday, for no good reason.
Expenses and Net *do* gain a second "predicted" line, but only once at
least one expense category has a budget set — the same graceful
degradation as the category bars, not a separate mode to turn on.

**Predicted net = actual income so far − total expense budget, not
predicted income − predicted expenses (2026-08-11).** A real alternative
was on the table: give income categories budgets too, and define predicted
net as planned income minus planned expenses — a pure, static plan number.
Rejected in favor of a live number grounded in what's actually been
logged, because that's this app's whole ethos (log reality, don't just
plan) — and because it was resolved by a *better* idea that came up in the
same conversation: predictable income (a monthly paycheck) isn't a
budgeting problem at all, it's a "don't make me retype this" problem,
which is exactly what recurring subscriptions (backlog #3) already exists
to solve. Income will get *automated*, not *budgeted* — see that backlog
item. Once recurring income ships, this formula doesn't need to change;
the income circle already just reads whatever's been logged, automatically
or by hand.

**Category bars fill up as you spend, not drain down (2026-08-11, revised
same day).** Originally built as a depleting gauge — full/bright at zero
spend, draining down as spend accrues, pinning back to a full red bar once
over budget rather than shrinking to invisible. Reconsidered after seeing
it on screen: the fill-up direction is the more familiar "progress toward
a limit" pattern (it's what the Summary panel's spent-vs-income bar and
the budget circles' rings both already do), and running two opposite
metaphors for the same underlying concept — spent vs. a limit — on one
screen read as inconsistent rather than deliberate. Now: empty at zero
spend, filling as you spend, pinning at 100% width in `--flag` red once
spend exceeds budget (strictly `>`, not `>=` — hitting the budget exactly
still reads as normal, not over). The number stays honest and uncapped
(`2,340 / 2,000`), so the bar never has to encode *how far* over — the
text already says that precisely.

**Budgets live on their own screen, not inline in the category rail
(2026-08-11).** First idea was reusing the existing colour-picker popout
in the rail to also hold a budget field. Rejected by Sebastian: a swatch
button reads as "colour," and budgeting is too central to the feature to
hide behind an affordance advertising something else. Setting a budget is
described as "a monthly sit-down, not something I do mid-logging" — it
earns a dedicated screen. The main register only *reads* budgets (the
depletion bars); it never lets you set one, and the Budget screen never
lets you rename/recolour/delete a category — that stays on the register's
Categories panel, one job per surface.

**Budget circles are SVG progress rings, not text-in-a-circle
(2026-08-11).** The original build put a full sentence ("of 9,100.00 kr.
planned") inside a plain bordered circle — a circle is a bad container for
text, the words crowd the INCOME/NET/EXPENSES label out once a number
appears, and the border was too thin to read as a deliberate shape.
Rewritten so the ring itself carries the data: an 8–12px arc on a pale
track, filling clockwise from the top. Inside the ring: one compact number
only, no currency symbol, no decimals (`2,704`, via a dedicated
`formatCompact`, distinct from the app-wide `formatMoney` rule below — a
headline figure is allowed to be less precise than a ledger figure). The
context moved to an uppercase mono caption *below* the ring, not fighting
for space inside it.
- **Colour, corrected same day.** First pass coloured income green and
  expenses red-when-under-budget-too, matching entry-row conventions.
  Sebastian's own reaction: seeing the expenses circle in warning-adjacent
  red while comfortably under budget read as "I've overspent" even when he
  hadn't. Changed to: all three circles neutral ink by default; Expenses
  turns `--flag` red only once spend exceeds its total budget; Net turns
  `--flag` red only when negative; Income never turns red and is no longer
  green either — colour on this screen now means exactly one thing
  (over/under, or positive/negative), not "which direction is this money."
- **Income and Net rings have no natural fill percentage.** Income isn't
  measured against anything (see above), and Net's only spec was "reads
  from its sign" — neither has a real denominator to fill proportionally
  against. Both rings are therefore a presence indicator, not a
  proportional gauge: full ring once there's any relevant activity this
  month, ghosted (dimmed, dashed "—" instead of a number) before that.
  Income ghosts on its own zero; Net ghosts when there's been no income
  *and* no expenses at all. This is an interpretation of "fills as income
  lands" from the original request, not a literal spec — worth re-raising
  if it stops feeling right in daily use.
- **Expenses ghosts on its own zero too, same as Income (2026-08-11,
  corrected same day).** Originally built as "never ghost Expenses — a
  known spent amount is real data, and 'no budget set' shouldn't look the
  same as 'nothing logged.'" That reasoning is still right for the case it
  was written for (spend something, no budget → show the real number,
  don't ghost) — but it accidentally also covered the *other* case, spend
  *nothing* at all, where a solid "0" is exactly as ambiguous
  ("deliberately zero" vs. "haven't opened the app") as it would be for
  Income, and Income already ghosts for exactly that reason. Caught
  because it left the three circles visibly inconsistent — Income and Net
  faded with a dash, Expenses solid with a "0" — when nothing had been
  logged. Fixed to mirror Income exactly: Expenses ghosts when
  `expenses === 0`, full/unghosted the moment anything's been spent,
  independent of whether a budget is set. The "no budget ≠ nothing
  logged" distinction still holds — it just now only matters once
  `expenses > 0` is already true.
- The empty-state CSS class was almost named `.ghost`, which collides with
  the app's existing `.ghost` button utility class (`border:1px solid
  var(--rule)`, used on "Budget," "Connect Google Drive," etc.) — caught
  by screenshotting the empty state and seeing a stray box around the
  ring. Named `.ring-empty` instead. Worth remembering if a future class
  name reuses a common word like "ghost," "active," or "empty" — check
  for an existing global utility of the same name before reusing it.
- **Phone-width layout is a triangle, not a shrunk copy of the desktop row
  (2026-08-12).** Below 700px, Net (the larger, derived circle) moves
  above Income and Expenses rather than staying in a horizontal line with
  them — `.budgetcircles` switches from flex to a two-row CSS grid
  (`"net net" / "income expenses"`) purely inside that one media query.
  Desktop's flex row is untouched — the grid rules only exist below the
  breakpoint, so there's no risk of the phone layout's structure leaking
  upward. Verified by rendering the iframe at both a 390px and a 1000px
  width and screenshotting each, rather than trusting the media query
  alone — OS-level window resizing in this dev environment doesn't
  reliably reflect in a screenshot, but an iframe's own width always
  drives its internal viewport correctly, which is why that's the
  technique to reach for first when a real device isn't at hand.

**Net's predicted line was removed entirely (2026-08-11, revised same
day).** The circle rebuild above shipped with "NET · PREDICTED 2,700" as a
caption, mirroring Expenses' "· OF 9,100." After using it on screen,
Sebastian asked for it gone — it read as clutter under the ring, not
useful context. The formula and reasoning documented above ("Predicted net
= actual income so far...") still holds and the number is still computed
(it feeds the category-list total, and could resurface elsewhere later),
it's just no longer shown on the Net circle. Net's caption is now always
just "Net," full stop — no conditional, no second line.

**Expenses caption is two lines, "Expenses" then "Budget 9,100," not one
line with "· of" (2026-08-11).** Small wording/layout change after seeing
the single-line "EXPENSES · OF 9,100" on screen — splitting the label from
its context onto two lines reads more clearly than one long uppercase
mono line, and "Budget" is more explicit than "of." Implemented as a
`.bcircle-caption` (main label) plus a separate `.bcircle-capsub` (second
line, only populated when a budget exists) — Income and Net don't get a
sub-line at all.

**Category-budget list gets a "Total budgeted" footer row
(2026-08-11).** A plain sum of every expense category's `budgetMinor`
(categories with no budget contribute 0), shown once at least one expense
category exists — same `totalBudget` figure the Expenses circle already
computes, just surfaced as its own row so it doesn't require mental
addition down the list. Bold, top-bordered, styled as the list's natural
last row rather than a separate panel.

**Budget circles' arc colour is user-customizable, same hue-picker as
categories (2026-08-11).** Originally scoped out same-session ("skip it
for now") on the reasoning that the neutral colour scheme removed most of
the motivation — reopened minutes later once Sebastian saw the neutral
version on screen and wanted to try it anyway. Each of the three circles
gets its own swatch button (next to its caption) opening the exact same
picker component the category rail uses (`.picker`/`.presets`/`.hue`,
literally the same CSS, wired once in `initBudgetView()` since the three
circles are static DOM rather than per-category rebuilt rows). Stored as
`Settings.budgetRingColors: {income, net, expenses}`, each either `null`
(default) or `{hue, color}`, mirroring how `Category.hue`/`color` are
stored together. **The one hard rule a custom colour can't override:**
Expenses still forces `--flag` red when over budget, and Net still forces
it when negative, regardless of any custom colour set — red keeps meaning
exactly one thing on this screen (the neutral-colour decision above), even
after letting the base colour be customized. A custom colour replaces the
default *ink*, not the warning state. **Colour lives on the arc only, never
the number (revised same day).** The first version also recoloured the
number text inside the ring — Sebastian asked for the number to always
stay plain ink, with colour (custom or flag-red) carried by the arc alone.
`applyRingColor()` no longer touches the `.bcircle-num` element at all,
only `.bcring-arc`; the now-unused `.bcircle-num.flag` CSS rule was
removed. This field is additive/optional on
`Settings`, read defensively (`state.settings.budgetRingColors || {}`)
rather than via a formal migration script — same lighter-weight approach
already used for `Category.budgetMinor` when that field was added to
already-live category records, since `undefined` and `null` are handled
identically by the `!= null` checks throughout.

**Amounts hide decimals when they're whole, everywhere, including editable
fields (2026-08-11, revised 2026-08-12).** `formatMoney` passes
`minimumFractionDigits: 0` when the amount has no minor-unit remainder, so
`4,250 kr.` displays instead of `4,250.00 kr.` — applies to the register,
the summary panel, the category rail, and the budget screen. Editable
input fields (the edit-entry amount field, the per-category budget input,
the recurring amount field) originally kept a fixed two-decimal string via
`.toFixed(2)` on purpose, reasoning that a field you're about to type into
benefits from a stable, predictable format more than a display-only
figure does. Reversed the next day after direct feedback: showing `.00`
on an amount that's never had decimals just reads as wrong, not stable —
the "predictability" argument didn't hold up against actually looking at
it. Now uses a shared `amountInputValue(minor)` helper (hide decimals
when whole, keep them when genuinely fractional — e.g. `4000` but
`1.99`), used by all three editable amount fields instead of each calling
`.toFixed(2)` separately.

**Budget input selects its whole value on focus (2026-08-12).** Tapping
into the per-category budget field used to drop the cursor wherever the
tap landed within the (right-aligned) value, so clearing it to type a new
number meant first manually navigating to the far side. Now the field's
`focus` handler calls `.select()`, so any tap/click selects the entire
value — typing immediately overwrites it, and Backspace/Delete clears it
in one press, no manual cursor navigation needed. Scoped to the budget
field specifically, since that's the one this was reported against — the
edit-entry and recurring amount fields weren't asked for and weren't
changed; revisit if the same friction shows up there too.

## Recurring design decisions

**Covers income as well as expenses, on one screen, split by the same
Spent/Income toggle used everywhere else (2026-08-11).** The backlog
originally described this as "recurring subscriptions" — expense-only by
implication. Scoped wider before building anything: "Budget design
decisions" had already committed to recurring entries being the answer to
predictable income (a paycheck), specifically as the alternative to
budgeting income categories (rejected — see "Out of scope"), so building
expense-only now would have meant reopening this feature almost
immediately. One screen, not two competing header buttons, because it's
one underlying record type either way — but never one mixed list: every
other direction-aware surface in this app (quick-add, the category rail,
`Category.direction` itself) splits expense/income into two separate
views because a mixed list reads as confusing, and "Netflix −89 kr." next
to "Paycheck +28,500 kr." in one list would be exactly that. Named
"Recurring," not "Subscriptions" — the latter doesn't linguistically cover
a paycheck, and "Recurring" already matched `Entry.recurringId`, a field
name that (in hindsight) had the right instinct before the screen's scope
was even discussed out loud.

**Auto-insert is silent plus a toast, not a manual confirm step
(2026-08-11).** A real alternative was on the table: surface "Rent, 6,250
kr., due today — log it?" and wait for a tap, closer to the app's "log
reality, don't infer it" ethos (see the bank-auto-import rejection in "Out
of scope"). Rejected because it reintroduces the retyping-adjacent
friction this feature exists to remove — if every recurring entry still
needs a tap, declaring it once saved nothing. The distinction from
bank-linked auto-import: a bank feed pulls from an external, untrusted
source that might not reflect what you actually intended; a Recurring
record is something *you* explicitly declared once ("yes, Spotify is 89
kr. on the 5th, every month") — auto-inserting from your own prior
declaration isn't inference, it's not making you retype something you
already told the app was going to happen. The toast keeps it from being a
silent surprise without requiring a tap either.

**Auto-insert only ever checks the current real-world month — it does not
backfill months missed while the app was closed (2026-08-11).** If you
don't open the app for two months, you get the most recent month
backfilled next time you open it, not both. Considered checking every
month between "last opened" and "now" instead, but rejected: silently
bulk-inserting several months of history the first time a long-standing
subscription gets declared felt like more surprise than this feature
should introduce, not less. Revisit if missed months turn out to be a
real annoyance in practice — the pure `dueRecurring(recurringList,
entries, today)` function only checks one month by design, so extending
it would mean changing that function's contract, not just its caller.

**Editing or deleting a Recurring record never touches entries already
auto-inserted from it.** Same principle as editing a Category never
rewriting an existing Entry's stored fields — once an entry exists, it's
independent history reflecting what was true at the time it was created,
not a live reference to the Recurring record's current values. Deleting a
Recurring record is a tombstone (same as Entry/Category), stops future
auto-insertion, and leaves every entry it already produced untouched — no
exception carved into hard rule 6 for this record type, it just already
satisfies it by construction.

**Recurring records sync via the same per-record merge as Entry/Category,
not local-only.** Consistent with the phone-to-log/laptop-to-review
workflow this whole app is built around — a subscription declared on one
device should apply on the other without re-declaring it. Uses the same
tombstone shape (`updatedAt`/`updatedBy`/`deleted`/`deletedAt`) and the
same `mergeRecords` algorithm, keyed by `RECURRING_CONTENT_FIELDS`
(`name`, `amountMinor`, `direction`, `categoryId`, `dayOfMonth`, `deleted`,
`deletedAt`) — no new merge logic needed, `mergeRecords` was already
generic over "a collection of tombstoned records," proven by Entry and
Category both already using it.

**The Recurring screen reuses the register's actual components, not just
its "feel" (2026-08-11, revised same day).** First build was a standalone
layout: toggle above a flat list, "Add recurring" form below the list in
a bespoke `.addrecurring` box. Reworked after Sebastian asked for it to
read as the same screen family as the front page specifically: the add
form now literally reuses `.quickadd`/`.qa-field` — the same striped
green box, the same labeled-field layout, direction toggle included as a
`.qa-type` field exactly like quick-add's own — moved *above* the list to
match quick-add sitting above the register. The list reuses `.register`
and `.dayhead` directly: recurring items group by day-of-month under a
day header showing that day's total, the same rhythm as the register
grouping entries by day. A `.summary`-styled box (reusing that component
too) shows total recurring income and total recurring expenses — both
figures always, regardless of which side the Spent/Income toggle is on,
since the ask was "a total of recurring income and expenses somewhere,"
not a per-view number. Deliberately did **not** merge the Spent/Income
toggle away even though the register itself doesn't split by direction —
that's a separate, already-settled decision (see the "one screen, split
by toggle" entry above); borrowing the register's visual/interaction
patterns doesn't mean re-litigating what those patterns are applied to.

## Testing before you claim it works

There is an automated self-test suite — `money-ledger-selftest.html`,
modeled directly on Hours Ledger's own `hours-ledger-selftest-reference.html`.
It started as sync/merge-only (built 2026-08-03/04, see below) and stayed
that way for its first ~23 tests even as the app grew well past sync —
Budgets shipped entirely on 25 manual checks run once by hand, never kept,
and the three rounds of circle-redesign work that followed shipped the
same way. Backfilled 2026-08-11 to close that gap; see "Why the suite
didn't grow" below before assuming the old framing (sync-only) still
describes it.

**Why the suite didn't grow, diagnosed 2026-08-11 — two compounding
causes, not one:**
1. **The harness had a real hole, not just an unused habit.** `runTests`
   was passed `d` (the iframe's `contentDocument`) from the very first
   commit — `this.contentDocument` was threaded into the call specifically
   so a test could read what the app actually rendered — and then never
   used it, not once, across all 23 original tests. There was no
   established pattern for "assert on the DOM," and no pure functions for
   the hook to expose for the money math either (`formatMoney`,
   `monthTotals`-equivalent logic, `sumByCategory`-equivalent logic all
   lived inline inside render functions, unreachable except by reading
   rendered output — which nothing did). Writing a money or rendering test
   meant inventing the pattern from scratch every time, so nobody did.
2. **The file's own framing discouraged it.** It was named, scoped, and
   described (including in this very doc) as "the sync/merge self-test
   suite" — a title and self-description that made a five-line arithmetic
   assertion feel like it belonged somewhere else, even though nowhere
   else existed. Combined with cause 1, the path of least resistance for
   verifying a new feature was always a disposable scratch HTML page
   driving the hook once, not a permanent addition to a file that
   described itself as being about something else.

**The fix, not just more tests:** `parseAmountToMinor`, `monthTotals`, and
`sumByCategory` were extracted from the render functions they were
duplicated inside (`renderSummary`/`renderBudgetView` both computed
month totals identically; `renderCategoryRail`/`renderBudgetView` both
built the same per-category totals Map; amount-string-to-minor-units
parsing was duplicated three ways across quick-add, edit, and the budget
field) into named, hook-exposed, directly-testable functions — the same
status `mergeRecords` already had. `d` finally gets used: rendering tests
read real DOM (`.tot-bar i` width/colour, the circles' text and
`ring-empty` class, the summary panel's figures, the edit sheet's
pre-filled fields) after driving state through the hook and calling
`H.renderAll()`. `setView(y, m)` was added to the hook so date-boundary
tests don't depend on which month the suite happens to run in.

`mergeRecords` behaving correctly in isolation was never the whole
story for sync, either — 2026-08-03/04's actual bugs were in how the app
*called* merge in sequence on one device, which only a full sync-path
test could catch.

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

**What it covers (134 tests as of 2026-08-12, up from 23):**
- **Sync/merge** (the original 23): the `mergeRecords` algorithm directly
  (only-local, only-remote, both-edited, delete-vs-edit,
  identical/skewed/ambiguous timestamps, empty sides, seed-category id
  collisions) and full sequences through the real
  `createEntry`/`editEntry`/`deleteEntry`/`syncNow` path, simulating two
  devices in one iframe by snapshotting and restoring state between them.
  Includes a regression test for each of 2026-08-03/04's five bugs (silent
  push overwrite, silent pull overwrite, undelete, edit duplication,
  category duplication) and one longer test walking the full manual repro
  end to end.
- **Money math:** `parseAmountToMinor` (rounding, rejection of
  zero/negative/blank/non-numeric input, no float drift across repeated
  parses), `formatMoney`/`formatCompact` (decimal-hiding on whole amounts,
  no currency symbol on the compact form, rounds rather than truncates),
  the currency setting itself, `monthTotals` (income/expense split, net,
  a negative-net month, an all-zero month), `sumByCategory`, income-vs-
  expense classification, and month/year boundaries — an entry dated the
  1st, the 31st, the day before, and the day after, plus the Dec 31→Jan 1
  year rollover, plus a direct test of `parseIso`'s local-Y-M-D
  construction (the actual mechanism that prevents a timezone-driven
  off-by-one-day bug — see "Why the suite didn't grow" above for why this
  wasn't simulated across real system timezones instead: not practical to
  do honestly without mocking `Date`/`Intl` internals, and the mechanism
  test covers the real risk directly).
- **Budgets:** depletion percentage, overspend rendering the real number
  uncapped while the bar pins at 100%, a regression test for the exact-
  budget off-by-one (2026-08-11), a category with no budget rendering
  exactly as it did before budgets existed, the Total budgeted footer row
  (including the all-zero case), the three circles' values, editing and
  clearing a budget through the real input field (folding in the original
  25 manual checks as permanent assertions), and regressions for the
  ring-colour work (colour lives on the arc only, never the number; a
  custom colour applies when not flagged but never overrides the
  over-budget/negative flag).
- **Rendering, generally:** the Summary panel's actual figures and
  positive/negative styling, register rows' sign and colour, the edit
  sheet opening pre-filled (amount, date, note, category — the Money
  Ledger equivalent of Hours Ledger's "does a field open pre-filled"
  coverage), the week header's IN/OUT totals, and the quick-add category
  dropdown refreshing live on category create/delete without a reload
  (2026-08-11 regression). Empty states are asserted as empty (a dash,
  `ring-empty`) rather than as a rendered zero, for every circle that has
  an empty state.
- **Recurring:** day-of-month clamping (`clampDay`/`daysInMonth`, incl.
  leap-year February), `dueRecurring`'s pure due-detection logic (not yet
  due, due with nothing inserted, already inserted this month, an entry
  from a previous month not counting, a deleted auto-inserted entry not
  counting, a different recurring id not counting, a deleted recurring
  record never due), `applyDueRecurring` creating a real entry with the
  right fields and not double-inserting on a second call the same month,
  editing/deleting a Recurring record never touching entries already
  produced from it, sync merge via `RECURRING_CONTENT_FIELDS`, and
  rendering (the screen split by direction, adding one through the real
  DOM form, editing a name inline, deleting through the DOM).

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
  category or month goes over budget). Now also covered by the self-test
  suite (register rows, the budget circles' colour rules) — this manual
  pass is about how it actually looks, not just whether the right class
  landed on the right element.
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
  recurringId: string | null   // set only if auto-inserted from a Recurring record
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
  budgetMinor: integer | null       // recurring monthly amount, expense
                                     // categories only — set from the Budget
                                     // screen, never from the main register
  updatedAt: string
  updatedBy: string | null
  deleted: boolean
  deletedAt: string | null
}

Recurring {                // backlog #3, named to match Entry.recurringId
                           // below — covers both subscriptions (expense)
                           // and predictable income (e.g. a paycheck), not
                           // expense-only, see "Recurring design decisions"
  id: string
  name: string
  amountMinor: integer
  direction: "expense" | "income"   // same split as Category/Entry — a
                                     // Recurring screen mixing "Netflix"
                                     // and "Paycheck" in one list would be
                                     // exactly the confusion the app avoids
                                     // everywhere else
  categoryId: string
  dayOfMonth: integer     // 1-31, clamped to the real last day of short months
  updatedAt: string        // syncs like Entry/Category — same tombstone shape
  updatedBy: string | null
  deleted: boolean
  deletedAt: string | null
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
  recurring: Recurring[]
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

Same shape as Hours Ledger, as planned: `index.html` (markup for every
screen — register, Budget, Recurring, edit sheet, intro — toggled via
`hidden`, not separate pages), `style.css`, and `app.js` (one file,
organized in commented sections: storage/schema, utils, mutations
[create/edit/delete for Entry/Category/Recurring], quick-add, edit sheet,
month nav, rendering per screen, Drive sync, the `__ML_TEST__` hook, init).
No framework, no bundler, no build step — all three files loaded directly
by the browser, same as Hours Ledger.

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
  — carried over exactly as-is from Hours Ledger. **One deliberate
  exception**: the three circles on the Budget screen (income/net/expenses).
  Requested explicitly and repeatedly by Sebastian as that screen's
  signature element (2026-08-10/11) — not an oversight. Everything else
  about them stays in the family's material language (1px ink border, no
  shadow, mono numbers) even though the shape doesn't.
- **The signature element**: the chronological register (running list
  grouped by week, then by day) paired with a category-totals panel is
  what shipped for the main screen — built and confirmed. The Budget
  screen's three circles are its own, separate signature element; see the
  shape-language exception above.

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
   from Google Cloud Console). Sync has now been exercised extensively
   against a real Google account across multiple real devices/browser
   profiles (2026-08-03/04) — connect, reconnect, disconnect, concurrent
   edits, deletes, and conflicts all verified live, not just via the
   self-test suite. `driveTokenClientFor()`'s reused-token-client pattern
   held up fine under that real load, no stale-callback issues observed.
   **Status: v1 is fully done (confirmed 2026-08-12).** The mobile Safari
   OAuth popup issue tracked here — Safari's ITP was believed to break the
   popup-to-main-window handoff after "Connect Google Drive," leaving a
   white/blank screen instead of a completed connection — no longer
   reproduces. Sebastian confirmed it works on a real phone, both Safari
   and Chrome. Nothing in the code changed the connect flow itself between
   when this was first flagged and now (only token caching and error
   messaging were touched, not `connectDrive()`'s popup mechanics), so
   this was most likely fixed upstream (an iOS/Safari or Google Identity
   Services update) rather than by anything in this repo — worth knowing
   if it ever resurfaces, since there's no local fix to point back to.
2. **Budgets.** Per-category monthly budget amounts and the budget-vs-actual
   visual — this is what finally gives `--flag` red something real to
   trigger on. The category bar and the month's Net figure should read as a
   *depletion* against the budget, not a plain proportion: full/bright at
   the start of the month, draining down as spending accrues against that
   category's (or the month's) budget, turning to `--flag` red once it runs
   out. Confirmed with Sebastian on 2026-08-03. **Status: built (2026-08-11)**
   — see "Budget design decisions" below for the shape it actually took,
   which moved a fair way from the one-line description above over a longer
   design conversation. Verified via on-screen screenshots (the circles,
   the fill-up bars, the ring colour picker) and the permanent self-test
   suite, which now covers this area directly rather than via disposable
   manual checks — see "Testing before you claim it works." Not yet
   real-device-verified by Sebastian.
3. **Recurring.** Declare once (name, amount, direction, category,
   day-of-month), auto-inserted as a real entry every month without
   retyping — covers both expense subscriptions and predictable income (a
   paycheck), not expense-only; see "Recurring design decisions."
   **Status: built (2026-08-11).** Own screen (button next to "Budget" in
   the header), split by a Spent/Income toggle like everywhere else
   direction-aware in this app. Syncs via the same per-record merge as
   Entry/Category. Auto-insert only ever checks the current real-world
   month — deliberately does not backfill months missed while the app
   wasn't opened; see "Recurring design decisions" for why. Verified via
   the self-test suite (clamping, due-detection, auto-insert, sync merge,
   rendering) and an on-screen screenshot showing the actual auto-insert
   split correctly across due/not-yet-due items in the register. Not yet
   real-device-verified by Sebastian.

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
  anchor on for money than it does for time. (Budgets now exist as of
  2026-08-11 — this is worth actually revisiting, not just noting.)
- **Budgeting income categories.** Considered and rejected in favor of
  Recurring (backlog #3, built 2026-08-11) covering predictable income
  instead — see "Budget design decisions" and "Recurring design
  decisions." Income stays a plain logged counter, no budget field, no
  target.

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
