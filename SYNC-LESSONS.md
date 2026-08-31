# Sync lessons, from building Money Ledger's Google Drive sync

Written 2026-08-12, before starting the same work on Hours Ledger. This is
not a summary of a conversation — it's a reference for whoever (human or
Claude) is about to design and build multi-device sync for a second vanilla
JS ledger app, so they don't have to rediscover any of this the hard way.
Money Ledger's `app.js`, `money-ledger-selftest.html`, and its `CLAUDE.md`
are the primary sources; commit history (`git log`) is the secondary source
and is quoted directly in a few places because the commit messages already
say it better than a paraphrase would.

If you're reading this with the Hours Ledger codebase open: Hours Ledger
already has its own self-test pattern (`hours-ledger-selftest-reference.html`,
direct calls to pure functions like `weekTotals`/`dayGaps`). Everything
sync-specific below — `TEST_MODE`, the fake Drive layer, the device-switching
pattern — gets *layered onto* that same harness shape, not built alongside
it as something separate. Don't create a second test file for sync.

---

## Part 1 — Engineering

### The merge design that actually works

The one-sentence version: **compare records, not files.** Every sync — push
or pull, doesn't matter which — merges record-by-record before writing
anywhere. There is no code path where a whole file gets compared by a single
timestamp and the loser gets overwritten wholesale. That was the original
design (see the bug catalog below) and it silently destroyed real user data
inside 24 hours of shipping.

The shape that replaced it, straight out of `app.js`:

**Every syncable record carries four extra fields**, on top of its own
content:
```
updatedAt: string        // ISO 8601, bumped on every change to THIS record
updatedBy: string | null  // DEVICE_ID of whoever last touched it
deleted: boolean          // tombstone — never physically remove a record
deletedAt: string | null
```
A collection's *whole-file* `updatedAt` still exists for bookkeeping, but
sync decisions never look at it — only per-record timestamps matter. This
is the field CLAUDE.md's hard rule 6 exists to protect: "pushed most
recently" is not the same claim as "has seen everything the other side
has," and a whole-file comparison conflates them.

**`DEVICE_ID` lives outside synced state entirely** — its own `localStorage`
key, generated once per browser profile, never written by a pull. It exists
for exactly one purpose: telling "a stale echo of my own earlier push" apart
from "a genuine edit from another device." One device's own clock ordering
of its own actions is never ambiguous; only a real two-device comparison can
be clock-skewed. Skip the ambiguity window entirely when `remote.updatedBy
=== DEVICE_ID` — this single check is what the second root-cause bug below
was missing.

**The actual merge function** (`mergeRecords(localArr, remoteArr,
contentFields)`) walks the union of both sides' ids and, per id:
1. Present on only one side → keep it. (This alone is most of what
   satisfies "never remove a record the other side hasn't acknowledged" —
   an id absent from one side is either brand new there or a deletion the
   other side was never told about; absence is never treated as "delete
   it.")
2. Same content, ignoring bookkeeping fields → keep either, nothing to
   decide.
3. Remote's copy was last written by *this* device → trust local outright,
   no ambiguity window. It's necessarily a stale snapshot of my own earlier
   push.
4. One side deleted, the other live → newer wins, **except** if the two
   timestamps are within a 5-second ambiguity window, in which case the
   live version always wins. Never delete on a guess.
5. Both deleted → redundant tombstones, keep whichever is newer, not a real
   conflict.
6. Both live, content genuinely differs → last-write-wins on the raw
   timestamp (see "the decisions" below for why this isn't keep-both).

`contentFields` is a deliberate whitelist per record type (e.g. for an
Entry: `date, amountMinor, direction, categoryId, note, recurringId,
deleted, deletedAt` — *not* `id`, `updatedAt`, `updatedBy`). Comparing raw
JSON equality instead of a whitelist was an actual bug (see below): two
devices' otherwise-identical seed categories looked "different" purely
because they were seeded a second apart.

**Seed data uses fixed ids**, not generated ones (`"seed-groceries"`, not
`uid()`). Two freshly-installed devices need to agree that their starter
category *is the same record*, or every seed category doubles the first
time they connect to the same Drive file.

**The Drive file is found by search, every single time — never by trusting
a cached id.** `resolveDriveFileId()` queries Drive by filename
(`name='<file>' and trashed=false`) before every sync, and only creates a
new file if nothing matches. If more than one match turns up, that's logged
as a warning, not silently resolved — it means two histories may need
reconciling by hand, which is a rarer and more honest failure mode than
picking one silently and hoping.

**Sync order matters and is asymmetric on purpose:** merge, write the
merged result to `localStorage` immediately (this is safe — it can't lose
anything, only add), *then* attempt the network push. If the push fails,
the device is still safe; it retries on the next save or reload. Writing
locally before risking the network call is what keeps a flaky connection
from being a data-loss event.

### The bug catalog — two root causes, five observed symptoms

CLAUDE.md's testing section lists "a regression test for each of
2026-08-03/04's five bugs: silent push overwrite, silent pull overwrite,
undelete, edit duplication, category duplication." Worth being explicit
that **these five symptoms came from only two root-cause bugs** — that
grouping is what made the regression tests efficient (one root-cause fix,
verified from multiple angles, rather than five unrelated patches):

**Root cause 1 — whole-file timestamp comparison (fixed in `11f58ff`).**
The original sync (`9eeabdb`, shipped 2026-08-03) compared each side's
single whole-file `updatedAt` and overwrote the older side entirely.
Symptom: *a stale device's push silently erased a newer entry from another
device — twice in one evening.* Once on pull, behind a "newer data?" prompt
that Sebastian (correctly) didn't trust and declined; once on push, with no
prompt at all. The fix was the entire per-record merge design described
above, not a patch to the whole-file comparison — there is no safe way to
patch "compare one timestamp for a whole file" into correctness; the
concept itself is the bug.

**Root cause 2 — the ambiguity window applied to a device's own sequential
history (fixed in `d93d688`, the very next morning).** The 5-second
"never delete on ambiguous timestamps" rule was meant to protect *genuine
cross-device* close calls. It had no way to tell that apart from a device's
own create-then-delete or edit-then-edit happening in quick succession
(e.g. the debounced sync catching up before the previous push had actually
landed) — because at that point nothing yet distinguished "my own stale
echo" from "someone else's edit." One missing check produced three
different-looking symptoms:
- **Deletes reverting** — delete a record, sync, and it comes back.
- **Edits producing duplicates instead of updating in place** — edit a
  record, sync, and a second live copy appears alongside the first.
- **Seed categories multiplying on every fresh install** — two freshly
  seeded devices' starter categories, which should be recognized as
  identical, kept getting treated as a conflict instead.

The fix was the `updatedBy === DEVICE_ID` check described above — once a
record's own device could be identified, "stale echo of my own push" and
"real cross-device edit" stopped being indistinguishable, and all three
symptoms disappeared from one change. (This bug was traced by hand against
each reported symptom, not from a running test — the self-test suite was
written *the same day*, immediately after, specifically so this kind of
manual tracing wouldn't be the only tool available next time.)

**A third, unrelated bug worth keeping in the catalog: category
duplication via double-submit (fixed `e253059`, 2026-08-12 — over a week
later, and initially reported as "duplicate categories" which *looked*
sync-related but wasn't).** `createCategory` and the rename handler had no
duplicate-name check at all, and the add-category form had no
double-submit guard. A double-tap on "Add" (trivial on mobile, no loading
state on the button) created two distinct-id records with the same name
before the first submission's re-render even landed — JS handlers run
synchronously, so two fast taps reproduces it reliably, no sync required.
The lesson here isn't about merge logic — it's that a bug reported as
"duplicates after using it on my phone" is not automatically a sync bug
just because sync is the newest, most-suspected system. It cost real
investigation time to confirm this one had nothing to do with `mergeRecords`
at all.

### The decisions and their reasoning

**Last-write-wins, not keep-both, for genuine same-record conflicts
(`0763253`).** The very first version of the merge design kept both
conflicting copies, flagged for review. Changed after live use: editing the
same record on two devices before one has synced is rare for a personal
ledger, and when it happens both edits are usually deliberate — there's no
principled way to guess which one the user meant to keep. A conflict-review
UI for something that happens a couple of times a year isn't worth the
complexity it adds everywhere else. Discard the older edit outright and
move on. **This is a decision, not a shortcut** — it was deliberately
chosen over the more "complete-looking" keep-both design, and it should be
re-opened (not silently overridden) if the target app is ever multi-user
rather than one person's own multiple devices.

**Never delete on an ambiguous cross-device timestamp, no matter what
(baked into `mergeRecords` from `11f58ff` onward, unrelated to and not
loosened by the last-write-wins decision above).** When a live edit and a
tombstone land within the ambiguity window from two *different* devices,
the live version always wins. This is an intentional bias, not a coin
flip — an unnecessary delete is unrecoverable in a way an unnecessary
"undo, then re-decide" is not.

**Dropped the user-facing notice when last-write-wins discards an edit
(`5d94d07`, reversed the very next commit after adding it).** The first
version of last-write-wins required a toast whenever a device's own edit
got superseded, on the theory that silent was the unacceptable part.
Reconsidered after actually testing it: a notification that fires maybe
once a year is noise the user will have forgotten the meaning of by the
time it appears, and the resolution is correct either way — there's no
decision being made *for* the user that they'd need to be told about.
`mergeRecords` still counts superseded edits and the count still reaches
the console (`console.log`, not the UI) for anyone actually looking.
**The general shape of this lesson**: build the safety notice first if
you're not sure, ship it, then genuinely use the feature before deciding
whether the notice earns its place. Both of these were single-day
decisions made by testing, not by debating in the abstract.

### Test isolation has to be structural, not "tests behave politely"

The distinction that matters: it is not enough for the test suite to *not
call* the real Drive network functions. The real Drive network functions
themselves must be *structurally incapable* of reaching `googleapis.com`
while under test, regardless of what calls them. A test suite that merely
avoids the real functions by convention will eventually get bypassed by a
refactor, a copy-pasted call site, or a "just this once" shortcut — and the
first time that happens, it happens against a real user's real Drive file.

How Money Ledger actually does this, all in `app.js`:

- **A URL flag, checked once at load, gates everything downstream:**
  `const TEST_MODE = new URLSearchParams(location.search).get("mltest") === "1"`.
- **Storage keys get suffixed under `TEST_MODE`**, both the main state key
  and the device-id key (`STORAGE_KEY`, `DEVICE_ID_KEY` both get
  `-TESTMODE` appended). A test run's `localStorage` cannot collide with a
  real ledger's, ever, by key name alone.
- **The branch to a fake happens inside each network function, before any
  `fetch()` is constructed** — not at the call site, not in a wrapper.
  `driveFindFiles`, `driveCreateFile`, `driveUpdateFile`, `driveReadFile`
  each start with `if (TEST_MODE) { ...operate on FAKE_DRIVE... ; return; }`
  and only build a `fetch()` call in the branch below that. There is no
  code path under `TEST_MODE` that can construct a real network request to
  Drive — not "tests don't happen to trigger it," but "the function
  physically cannot do it in this mode."
- **`window.confirm` is stubbed to auto-accept under `TEST_MODE` only**, so
  delete/import/clear flows don't hang a headless run waiting for a dialog
  nothing will click.
- **No real OAuth ever fires under `TEST_MODE`** — the silent-reconnect
  function no-ops immediately. Tests that need a "connected" state call a
  hook function that sets the same fields a real successful connect would
  leave behind, without a live Google account.
- **The real functions are exposed to the test harness directly**
  (`window.__ML_TEST__ = { createEntry, mergeRecords, syncNow, ... }`), not
  reimplemented for testing. A test calling a copy of the merge logic could
  drift from the real one and pass while the real one is broken; calling
  the actual function makes that impossible.

One non-obvious trap this produced, worth carrying forward as a pattern to
watch for rather than a one-off: a helper that resets state for a "new"
device (`resetState()`, called the first time a test-harness device id is
seen) also reset the fake Drive store, because the very first device in a
test *should* see an empty Drive. But if device A has already pushed real
data and device B then appears for the first time, B's own reset silently
wipes A's pushed data before B ever reads it — because nothing distinguishes
"first appearance, Drive should be empty" from "first appearance, but
another device already put something there." **The general shape of this
kind of bug**: a test-simulation helper's job is to imitate device state
transitions faithfully, and "first time we've seen this id" is not the same
condition as "nothing exists yet" once more than one simulated device is
involved. If you build an equivalent multi-device simulator for Hours
Ledger, give every simulated device an explicit "born" step, done for *all*
devices in the scenario, before any of them touch the fake remote for real.

### Google Cloud OAuth setup (you'll need to redo this with a new origin)

Money Ledger uses [Google Identity Services](https://developers.google.com/identity/oauth2/web/guides/overview)'
browser-side token client, not a server-side OAuth flow — there is no
backend, on purpose (hard rule 4: nothing under a developer-controlled
server ever touches user data). The exact click-path in Google Cloud
Console shifts over time, so treat the steps below as the concepts to look
for rather than a literal menu-by-menu script; the important gotchas are
called out explicitly.

1. **Create or reuse a Google Cloud project** for the app. A brand-new
   Hours Ledger sync effort can share Money Ledger's project or get its
   own — either is fine; a shared project just means both apps' OAuth
   clients live side by side in the same console.
2. **Enable the Google Drive API** for that project (APIs & Services →
   Library → Google Drive API → Enable). Nothing works without this,
   including in `TEST_MODE` testing against a real account.
3. **Configure the OAuth consent screen** (APIs & Services → OAuth consent
   screen). User type: External, for a public tool real strangers will
   use. Add the exact scope needed — `drive.file` only, not broader Drive
   access — since the narrower the scope, the narrower the blast radius if
   a token ever leaks, and `drive.file` is also what keeps the "this app
   can only see files it created" promise true. **Expect the "unverified
   app" warning screen for real users until Google's review clears** — this
   needs a privacy policy page and can take days to weeks; Money Ledger's
   own CLAUDE.md still lists this as an open question (ship with the
   warning visible, or gate the sync button until verified). Decide this
   deliberately for Hours Ledger rather than being surprised by the warning
   screen after shipping.
4. **Create an OAuth 2.0 Client ID** (APIs & Services → Credentials →
   Create Credentials → OAuth client ID). **Application type: Web
   application.** There is no client secret to manage — a Web application
   client used purely for the browser-side GIS token flow only needs
   **Authorized JavaScript origins**, not a redirect URI. This trips people
   up because most OAuth setup instructions assume the authorization-code
   flow, which does need a redirect URI; the token-client flow
   (`google.accounts.oauth2.initTokenClient`) doesn't use one at all.
5. **Add every origin you'll actually load the app from** to Authorized
   JavaScript origins: the real GitHub Pages origin (e.g.
   `https://<username>.github.io`) *and* your local dev origin (e.g.
   `http://localhost:8000`, matching whatever port `python3 -m http.server`
   happens to use) — Google will reject the popup with an origin mismatch
   otherwise, and it fails silently/unhelpfully enough that "wrong origin
   list" should be the first thing you check if `connectDrive()` fails
   before even opening the picker. **Correction (2026-08-30):** an earlier
   version of this note said "a new project (Hours Ledger) has a new
   origin, so this step has to be redone from scratch." That's wrong about
   the origin. GitHub Pages project sites for one account all share **one
   origin** — `https://<username>.github.io` — differing only by path
   (`/Money-Ledger` vs `/Hours-Ledger`). The *client* is what's separate:
   Money Ledger and Hours Ledger each have their own OAuth Client ID
   (`501903536592-…` and `433503856869-…` respectively), and Hours Ledger's
   client still needs `https://<username>.github.io` + localhost added to
   *its* origin list from scratch — but it's the same origin string Money
   Ledger's client already uses, not a new one. Consequence of the shared
   origin: both apps share `localStorage`, `BroadcastChannel`, and the
   `storage` event on that origin. They stay isolated only by key prefixes
   (their own data) and by GIS routing OAuth results by Client ID — a
   `message` from `accounts.google.com` whose `clientId` doesn't match is
   rejected by GIS, which is the only reason two GIS token clients on the
   same origin don't cross-deliver tokens. **Do not unify the two Client
   IDs** without re-examining that — it's load-bearing.
6. **Copy the resulting Client ID** (looks like
   `NNNNNNNNNNNN-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.apps.googleusercontent.com`)
   into the app's own constant (`GOOGLE_CLIENT_ID` in Money Ledger's
   `app.js`, top of file). This value is a public identifier, not a secret
   — safe to commit directly, unlike a client secret would be.
7. **Known limitation, not a bug to chase**: a backendless static site
   cannot silently refresh a Google access token. `prompt: ""` is **not** a
   silent path — an earlier version of this note called it one; that was
   wrong (confirmed 2026-08-30 by probing the real `gsi/client`). GIS's
   token client only skips the popup for `prompt: "none"` *and* an in-page
   refresh session that a fresh page load doesn't have — every other case,
   `""` included, calls `window.open`. Money Ledger's actual workaround is
   caching the access token itself in `localStorage` (its own key, kept out
   of synced state, same pattern as `DEVICE_ID`) with its real expiry and a
   small safety margin, so a page reload within the token's ~1hr life
   reuses it with no Google round-trip at all. When the cache is empty,
   Money Ledger does **not** attempt a token request on page load
   (`resumeDriveSyncIfTokenCached` → `pageLoadSyncPlan` returns
   `"await-user-reconnect"`) — it shows the "needs reconnect" state and
   waits for a tap, because an un-activated `window.open` on load lands in
   the wrong tab on mobile (GIS freezes one popup window name for the
   page's whole lifetime) and fails silently. A real refresh token would
   fix this properly but needs the server-side flow, which needs a backend
   holding a client secret — precisely what hard rule 4 forbids. Do the
   same for Hours Ledger: cached-token-or-wait-for-a-tap, never a
   page-load popup.
8. **A mobile Safari popup-handoff issue was tracked for a while and then
   stopped reproducing** without any code change on the connect flow
   itself — most likely an upstream iOS/Safari or GIS fix, not something
   this repo fixed. Worth knowing going in: if this class of "connect
   button does nothing on mobile Safari" issue shows up again on Hours
   Ledger, it may not be yours to fix at all — verify on a real device
   before spending time on it, and check whether it's already a known,
   time-bound platform issue before assuming the integration is broken.
9. **The OAuth popup opening in the *wrong tab* on mobile (2026-08-30/31)**
   is a *different* issue from #8 and is ours to fix. Two causes:
   - (a) page-load token refresh calling `window.open` with no user
     activation — fixed, see #7.
   - (b) GIS builds one frozen popup window name
     (`g_auth_token_window_<random-fixed-at-script-eval>`) per page load
     and reuses it for every `requestAccessToken`. `window.open(url, name)`
     retargets any existing tab with that name this page opened — **even
     after that tab navigated cross-origin** (verified by direct test) —
     as long as the opener link holds. On a pinned tab that never reloads,
     the first OAuth tab it ever opened gets retargeted forever, wherever
     it now is and whatever it now shows.
   **Fix (2026-08-31):** wrap `window.open` so any `g_auth_token_window*`
   name gets a unique `.<suffix>` appended → GIS opens a fresh window every
   time, never retargets a stale one; also capture the handle and
   `close()` it when the flow settles. Safe **only** because GIS never
   reads the window name back (routing = origin + redirect_uri nonce +
   client_id) — established by reading `gsi/client` source, not a public
   contract. **Known fragility:** a future GIS change that correlates on
   the name would make this wrapper silently stop working, with no error
   and no test failure. Prefix is preserved so a prefix-based check still
   matches. Also shipped: an `error_callback` on every token request
   (without one GIS's closed-popup detection never arms and failures are
   silent) + a 120s watchdog toast. Do all of this on Hours Ledger too;
   wire `error_callback` and the `window.open` wrapper in from the first
   connect commit.

### What to do differently, starting from scratch on Hours Ledger

- **Build the per-record merge design as the *first* sync commit, not a
  retrofit.** Money Ledger shipped whole-file timestamp sync first and
  replaced it with per-record merge less than 24 hours later, after it had
  already silently destroyed real data twice. The requirements that made
  whole-file comparison wrong — multiple real devices, data too personal to
  lose, "every entry must stay editable and deletable" already a stated
  hard rule — were all known *before* the first line of sync code was
  written. There was no genuine unknown that whole-file comparison was
  discovered to violate; it was foreseeable from the requirements already
  on paper. Start with tombstones, per-record `updatedAt`/`updatedBy`, and
  merge-before-write in both directions as the definition of "sync exists,"
  not as a v2.
- **Write the self-test harness's `TEST_MODE`/fake-remote scaffolding
  alongside the first sync commit, not after the first real bug.** The
  20-hour gap between "sync ships" and "self-test suite exists" is exactly
  the window both real data-loss bugs happened in. If Hours Ledger's
  equivalent of `FAKE_DRIVE`/`TEST_MODE` exists from commit one, the first
  bug gets caught by a test before a real account ever sees it, instead of
  being caught by Sebastian using the app for real.
- **Decide `DEVICE_ID`'s existence and its exclusion from synced state up
  front**, not as a fix for a bug that already shipped. It's cheap to add
  early and expensive to retrofit once a merge algorithm already exists
  without it (as `d93d688` demonstrates).
- **Use fixed ids for any seeded/starter data from the very first commit
  that creates it.** Retrofitting fixed ids after devices already have
  divergent generated ids for "the same" starter category is a real
  migration problem; starting with fixed ids is free.
- **Add the CLAUDE.md hard rule ("no sync operation may remove an
  unacknowledged record") *before* writing the sync code, as a design
  constraint to build against — not after, as a scar.** Money Ledger's
  version of this rule was written in direct response to the bug (see
  `5629c20`, committed the same evening as the incident). For Hours
  Ledger, the constraint is now known in advance; write it into the
  project's CLAUDE.md before the first sync commit, so it's a spec the
  code has to satisfy rather than a lesson extracted afterward.

---

## Part 2 — Process

This half is about how the work happened, and it mattered as much as the
code above — most of the engineering section exists *because* this process
was eventually followed, not the other way around.

**Build a repro that fails on demand, before writing the fix.** When
`d93d688` fixed the ambiguity-window bug, the commit message says the fix
was "traced against all three reported symptoms by hand" — meaning the
actual debugging was done by reasoning through the merge logic against the
reported scenarios, not by running a failing test first. That gap was
noticed and closed the same day: `1a70fe6` explicitly went back and
"extracted the pre-fix commits into scratch copies with a fetch shim
standing in for Drive, ran the same scenarios directly against them,
confirmed each bug reproduces exactly as reported" — i.e., verified after
the fact that a real repro *would* have failed against the old code, rather
than assuming it would have. Do the repro-first step in that order next
time: get a failing case running against the current (buggy) code before
touching the fix, not as a retroactive check afterward.

**Every bug gets a test written first, watched to fail against the old
code, before the fix lands — as a standing rule, not a one-time cleanup.**
This became explicit policy (documented in Money Ledger's CLAUDE.md) only
after the sync incident, and later hardened further: hard rule 10 now
requires tests in the *same commit* as anything touching money, totals,
dates, or budgets — not written after, not as manual checks run once and
thrown away. That second hardening happened the same day it was needed:
the entire Budgets feature — including three separate rounds of on-screen
redesign — shipped on 25 manual checks that were run once by hand and
never kept, leaving zero permanent coverage behind it, until the gap was
noticed and backfilled before the day's work was called done. Set this
rule as policy for Hours Ledger's sync work from the start, and hold it
for the sync/merge code specifically even if the rest of the app hasn't
needed it as strictly — sync is exactly the kind of code where "it worked
when I tried it" and "it is actually correct" are the furthest apart.

**Don't claim something works without having run it.** Money Ledger's
CLAUDE.md states this as a hard rule in almost these words: *"This should
work" and "I ran this and it worked" are different sentences. Use the
honest one.* This is worth repeating here because it is easy to violate by
omission rather than by lying outright — describing what a fix *should* do
in confident, past-tense-sounding language, without ever having actually
executed it, reads to a reader exactly like a claim of verification even
when it wasn't meant as one. Say plainly when something hasn't been run,
and say specifically what would need to happen to verify it (which server,
which file, which button) rather than a vague "you should test this."

**Interrogate a check that passes (or fails) in a way you can't actually
distinguish from the opposite result.** A concrete instance from this
project: the self-test suite briefly asserted on `document.activeElement`
to check that a `.focus()` call landed correctly. The suite runs the real
app inside a `display:none` iframe — and a non-rendered frame cannot hold
real browser focus, structurally, regardless of whether the app's own
`.focus()` call is correct or not. That assertion could not have told you
"the app is broken" apart from "the environment can't support this check"
— a pass and a fail both meant the same amount of nothing. It was removed
and replaced by an actual on-screen screenshot, which *can* distinguish
those two cases. The general check to run on any new assertion: if you
changed the *real* behavior it's supposedly guarding, would this specific
assertion actually flip? If you can't answer that confidently, it isn't
testing what you think it's testing.

**Confirm the code under test is actually the code that's deployed — this
one bit the same project twice, in two different sessions, in two
different disguises.** First, 2026-08-10 (`ae4b2c0`'s commit message notes
"toast phase timing... confirmed via computed style checks in a clean
browser profile after an initial cache-artifact false alarm"). Second,
2026-08-12, verifying this exact document's sibling change (the Recurring
screen redesign): a browser tab kept showing the *old* row markup after
`app.js` had already been edited and the local HTTP server restarted —
`curl` against the server proved the new file was being served correctly,
while the same URL open in a regular Chrome tab, even after a hard
Cmd+Shift+R reload of the HTML page, kept executing old JavaScript. Cause:
`index.html`'s `<script src="app.js">` has no cache-busting query string
(only the *test harness's own* iframe `src` does), so a browser's disk
cache can keep serving a stale `app.js` from an earlier page load in the
same profile even once the HTML around it is demonstrably fresh. The fix
both times was running the same check in a fresh **incognito** window,
which uses its own cache separate from the regular profile's. The lesson
isn't "always use incognito" — it's that *this specific gap* (an
uncached script tag next to a cached HTML page) was hit twice, two days
apart, without the first encounter producing a habit that prevented the
second. When a fix "isn't taking effect" despite the source clearly being
correct, check whether you're actually looking at the code you think you
are before concluding the fix itself is wrong.

**Be honest about what went wrong on the Claude side specifically, not
just "bugs happened."** In order, plainly:

- The very first sync implementation (`9eeabdb`) used a design — whole-file
  timestamp comparison — that was foreseeably wrong given requirements
  that were already known at the time it was written (multiple real
  devices, data too personal to lose, entries required to stay editable
  and deletable). This wasn't an edge case discovered later; it was an
  architecture choice that didn't hold up against constraints already on
  the table. That's a design mistake, not just an undertested feature.
- Verification was reactive for the first ~24 hours of sync existing: the
  self-test suite, `TEST_MODE`, and the fake Drive layer were all built
  *after* real data loss had already happened on a real account, not
  before. The bugs were originally found by Sebastian using the app for
  real, not by any check run in advance of shipping.
- The test harness itself produced at least one bug that cost real
  debugging time before being correctly identified as a test-code problem
  rather than an app problem (the `useDevice`/fake-remote reset trap
  above). The instinct to assume "the code I just wrote is broken" over
  "the test I just wrote might be broken" isn't automatically the right
  prior — both need checking, and tracing actual logged state (see the
  next point) settled it faster than re-reading the merge logic a third
  time did.
- Screenshot-based visual verification is unreliable in at least one of
  the sandboxed environments this work has been done in — `screencapture`
  has intermittently captured the coding surface itself instead of the
  browser window under test, across multiple attempts in the same session.
  When this happens, say so plainly and fall back to a structural check
  (a DOM dump, a computed-style read) rather than quietly retrying until
  a screenshot happens to work, or — worse — reporting a visual change as
  confirmed without one.
- The most useful single debugging technique used across this whole
  project — a small scratch HTML page that drives the app's test hook and
  logs intermediate state to an on-page `<pre>` element, screenshotted or
  read back directly, instead of relying on `console.log` output that
  isn't easily readable in this tool environment — was reinvented under
  time pressure the first time a sync bug needed real tracing, rather than
  being an established habit going in. Start Hours Ledger's sync work
  already knowing this is the move when reasoning about code stops being
  enough.
