---
name: no-twice
description: Keeps a short, trigger-indexed log of mistakes the agent actually made on this project, and reads the relevant ones back before acting. Use when the agent repeats errors across sessions, drifts off the stated goal, or asserts things it has not checked. Also use when the user points out a mistake, so it gets recorded instead of forgotten.
---

# No Twice

An agent repeats mistakes because nothing survives between tasks. General
instructions do not help: "be rigorous" is read once and forgotten twenty tool
calls later, and it does not tell you *when* to be rigorous or *what to check*.

What survives is a file. This skill maintains `.claude/lessons.md` — a short log
of mistakes actually made on this project, each one attached to the kind of
action that should fire it — and reads the matching entries back before acting.

## The file

`.claude/lessons.md`, one entry per mistake:

```markdown
### Asserting that a tool or library does not exist
- Did: searched once with one phrasing, concluded the niche was empty.
- Was: three established libraries already did it.
- Check: search with at least three different phrasings, and one search for the
  category rather than the feature, before writing "nothing does this".
- Seen: 3
```

Four fields, in this order, and none is optional:

- **Trigger** (the heading) — the *kind of action*, not the incident. "Asserting
  that a tool does not exist", not "the backtest library thing". If you cannot
  name the action, the lesson can never fire and is worthless.
- **Did** — what you actually did or claimed. One line.
- **Was** — what turned out to be true. One line.
- **Check** — the concrete step to run next time. It must be executable: a
  command, a search, a file to read, a number to recompute. "Be more careful" is
  not a check and must be rejected.
- **Seen** — how many times this has now happened.

## Reading: before you act

At the start of a task, and again before any step that is expensive to undo,
read the headings in `.claude/lessons.md` and load only the entries whose
trigger matches what you are about to do. Headings are the index; you do not
need the bodies of entries that do not apply.

If a lesson matches, run its **Check** before the action, not after. A lesson
applied afterwards is just an apology.

## Writing: the moment a mistake surfaces

Write the entry as soon as the mistake is established — when the user points it
out, when a test contradicts you, or when you notice it yourself. Not at the end
of the task: by then the specifics are gone and you will write something vague.

**If a matching trigger already exists, do not add a second entry.** Increment
`Seen` and sharpen the **Check** so it would have caught this occurrence too. A
rising `Seen` count is the useful signal in the whole file: it means the check
is too weak or fires too late, and the fix is a better check, not a stricter
tone.

## Four rules that keep the file worth reading

1. **Every lesson comes from something that actually happened here.** No
   imported best practices, no hypotheticals. A file of generic advice is
   indistinguishable from the system prompt and will be skipped.
2. **The Check must be executable.** If it cannot be written as a command, a
   search, a file to open, or a quantity to recompute, the lesson is not ready —
   keep working on it until it can.
3. **Twenty entries, hard cap.** Past that, merge entries that share a root
   cause and delete the ones with `Seen: 1` that have not recurred in months. A
   file too long to reread is a file that does not get reread.
4. **Never rewrite history to look better.** The `Did` line records what was
   actually claimed, including the confident wording. Softening it destroys the
   only evidence of how the mistake sounded from the inside.

## Staying on the goal

Drift is the same failure in another form: acting without checking, one small
step at a time.

At the start of a task, write the goal in one sentence, in the user's own terms.
Before each non-trivial action, ask whether it serves that sentence. When the
answer is no and you do it anyway because it seemed useful, that is drift —
record it like any other mistake, with the trigger being the kind of detour it
was.

When a task legitimately changes shape, rewrite the goal sentence explicitly and
say so. An unstated change of goal is indistinguishable from drift.

## What this is not

It is not a place to log every imperfection. Entries earn their place by being
mistakes that had a cost and could plausibly recur. A near-miss you caught
yourself before it mattered does not belong here; a wrong number that reached
the user does.
