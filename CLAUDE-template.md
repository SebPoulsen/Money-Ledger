# [PROJECT NAME]

> **Template.** Every line in square brackets needs replacing before the first
> session. Delete this block when you're done.

[One sentence: what this is and who it's for.]
[One sentence: what it deliberately is not.]

Built and maintained by Sebastian Poulsen, who is learning to work with Claude Code
through these projects. **Explain your reasoning as you go.** When there is more
than one sensible way to do something, say what the options were and why you picked
one. Teaching matters here as much as shipping. If I accept a change without
understanding it, that is a failure of the session even if the code is correct.

Push back on me. If a request is a bad idea, say so before doing it. If I ask for
something that contradicts a rule below, stop and say which rule.

---

## Hard rules — do not break these

1. **[Data integrity rule.]** Name the thing that must never be silently broken —
   a storage key, a schema, a file format, a database column. State what must
   happen if it genuinely has to change: migrate first, keep the old version until
   the new one is verified. *Real user data is the one thing you cannot apologise
   your way out of.*
2. **[Dependency rule.]** What may and may not be added. Be specific about what
   ships to the user versus what's only used in development.
3. **[Build rule.]** How it gets from repo to running. If there's no build step,
   say so and protect it.
4. **[Privacy / network rule.]** What may leave the user's machine. If the product
   makes a promise about this anywhere in its interface, quote it here and keep it
   true.
5. **[Reversibility rule.]** Which actions must be undoable, and the mechanism.
   Any new destructive feature has to use the same mechanism.
6. **Ask before restructuring.** Propose and wait. Do not refactor broadly in a
   session that was asked for a small fix. Scope creep in a diff is harder to
   catch than scope creep in a plan.
7. **Do not claim something works if you have not verified it.** "This should
   work" and "I ran this and it worked" are different sentences. Use the honest
   one.

## Testing before you claim it works

[No test suite / test command here.] Verify manually and say which of these you
actually did — not which ones apply in theory:

- [The core happy path, stated concretely.]
- [The edge case that has broken before, or that you expect to.]
- [Whatever persists — reload and confirm it survived.]
- [The other viewport / platform, if there is one.]
- [The undo or recovery path.]

If you couldn't test something, say so plainly and tell me what to click.

## Deploy

[Exactly what happens when I push, and how long until it's live. Include the cache
delay if there is one, so I don't think a change failed when it's just slow.]

---

## The data model

```
[Paste the real shape. Types and units for anything ambiguous.]
```

- [What each non-obvious field means.]
- [Which fields may legitimately be null or empty, so it isn't "fixed" as a bug.]
- [Units. Minutes vs seconds, cents vs dollars, UTC vs local.]

## How the code is organised

[Files and what lives in each. If it's one file, say what order things appear in.]

[If the current structure is a compromise, say why — and whether the constraint
still applies. Old constraints outlive their reasons and get treated as design.]

## Design constraints

[The intended feel, in a sentence. Then what it must never drift toward — that
line does more work than any positive description.]

- [Colours, with the specific role of each. Which are reserved and for what.]
- [Type. What's used for numbers, labels, headings.]
- [Shape language: corners, shadows, spacing, density.]
- [The signature element — the one thing that makes it look like itself.]
- [Anything deliberately uncomfortable or unpolished, and why. Mark it clearly:
  do not "fix" this.]

---

## Backlog, roughly in order

1. **[Task.]** [What done looks like. Why it's first.]
2. **[Task.]**
3. **[Task.]**

Do not add features that are not on this list without discussing them first.

## Out of scope

- [Things that sound like obvious next steps but have been deliberately rejected,
  with the reason. Otherwise they get re-proposed every few sessions.]

## Open questions

- [Things genuinely undecided. Flag them when they become relevant rather than
  picking silently.]
