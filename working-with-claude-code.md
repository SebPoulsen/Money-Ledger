# Working with Claude Code — what actually works

Extracted 2026-08-14, after building Google Drive sync twice: once badly
on Money Ledger (two real data-loss incidents), once well on Hours
Ledger (169 tests, nothing lost). The difference wasn't the model. It
was the instructions.

This is the transferable part. `SYNC-LESSONS.md` covers the engineering;
this covers how to run the collaboration.

---

## The core loop

**1. Design before code.** Never let it start building from a one-line
request. Ask for the design, the alternatives it considered, and what
it would do differently. On a sync feature this surfaced the whole
data-model divergence between two projects before a line was written.

Say plainly: *"Don't write code yet. Answer this first."* It will
otherwise start scaffolding after your first vague sentence, and you'll
be locked into decisions you didn't know you were making.

**2. Make it ask, don't make it guess.** A blank template full of
brackets gets filled with plausible invention. An instruction to
interview you first gets you a real spec. Batch the questions three or
four at a time so your answers steer the next ones.

**3. Approve the plan explicitly, including the order.** It produces
todo lists that quietly reorder things — tests batched at the end,
checkpoints dropped. Read the list, not just the first item.

**4. Checkpoint before the risky half.** Engine first, UI and
integrations second. Test the engine yourself before anything gets
wired to a real account or a real user's data.

**5. Verify, then push.** Nothing goes to main until you've run it on
real devices with real data.

---

## The five questions that find the most

**"What did you actually run, versus what did you only reason
through?"**
Ask this at every handover. On Money Ledger, both data-loss bugs
shipped inside work described as done that had never been executed.
Asked directly, it will tell you honestly — and the honest answer is
usually more useful than the confident one.

**"Show me the test failing first."**
A test written after a fix passes on its first run and you learn
nothing about whether it detects anything. Insist the test is written
before the fix and watched to fail against the old code. It can do this
by checking out the pre-fix commit — ask for the actual output of both
runs, not a description.

**"Would this assertion flip if the real behaviour broke?"**
The single most valuable question. A check that can't distinguish a
pass from a failure is worth nothing. Real examples caught this way: an
assertion on `document.activeElement` inside a hidden iframe that
structurally could never hold focus; a test hardcoding which device
"wins" a merge, which only passed because synthetic timestamps tied to
the millisecond.

**"Is there anywhere else this could fail silently?"**
Ask for the full enumeration rather than waiting to find them one at a
time. Asked once on Hours Ledger sync, it produced three
not-syncing-silently states — two of which nobody had noticed and one
of which it found without being asked.

**"Why didn't this grow / why didn't the tests catch it?"**
Better than "please fix it." Money Ledger's test suite sat at 23 tests
for weeks. Asking *why* it hadn't grown surfaced two structural causes —
an unused parameter in the harness and money math trapped inside render
functions — and fixing those was worth more than adding tests would
have been.

---

## Things it does that need catching

**Claiming without running.** Confident past-tense descriptions of what
a fix does read exactly like verification. Ask.

**Asking the same question twice.** It loses track. Answer once, and
say so if it repeats.

**Not pushing.** "Committed locally" is not "live." Check before
testing, or you'll test old code and draw a wrong conclusion. This cost
an hour on Hours Ledger.

**Reordering the plan quietly.** Tests drift to the end, checkpoints
vanish. Re-read the list.

**Reasoning past the point where it should look.** When it can't
reproduce something after several attempts, stop asking for a fourth
synthetic variation. Get the real data out and look at it. The hardest
bug in this project — duplicated categories — was solved by downloading
the actual Drive file and diffing the hex colour values, after three
failed reproductions and a wrong hypothesis.

---

## Things it does well, worth reinforcing

- Finds adjacent bugs while working on something else, and says so
- Flags when a change reverses an earlier decision instead of quietly
  flipping it
- Names its own limits ("I can't drive a real OAuth session")
- Catches bugs in its own tests and reports them rather than hiding them
- Refuses to guess when a rejection or an ambiguous instruction arrives

When it does these, say so. It costs one sentence and it's the behaviour
you want more of.

---

## What goes in files versus in the chat

**The chat is disposable. The files are not.** Anything that matters
after a `/clear` belongs on disk.

- `CLAUDE.md` — hard rules, data model, design decisions *with their
  reasoning*, backlog, out-of-scope, open questions
- A lessons file per hard-won area — what went wrong, why, what to do
  differently
- Handover notes at phase boundaries — done, in progress, next, open

Writing decisions down is what makes clearing free. Ask for a design
decision to be recorded **with the reasoning**, not just the outcome —
otherwise it gets re-litigated in three months by someone who can't
remember why.

Context management: `/clear` at phase and project boundaries, `/compact
focus on X, drop Y` mid-task. Instruct it to tell you when it's *safe*
to clear — it knows what's still load-bearing in its own context and
you don't.

---

## Decisions are yours, not its

It will make a recommendation and defend it well. Several of the best
calls on these projects went against its advice:

- Rejecting the colour-swatch popout for budgets (a swatch says
  "colour"; nobody clicks it looking for money)
- Insisting duplicates never appear even briefly, rather than being
  resolvable
- Requiring the category-merge repair tool in the same commit rather
  than as a follow-up
- Requiring fixed seed ids, which it flagged and then didn't implement

And one that went the other way, deliberately: dropping keep-both
conflict resolution for last-write-wins, after reconsidering the
trade-off — not because a test appeared to pass.

**That distinction matters.** Changing your mind on reasoning is fine.
Changing it because a check looked green is not.

---

## The one-line version

Ask for the design first, demand the test fails before the fix, ask
what was run versus reasoned, and when reasoning stops working, go and
look at the real data.
