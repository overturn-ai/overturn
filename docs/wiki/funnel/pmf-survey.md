# The PMF survey — written before the answer is known

**Runs on Tuesday 19 January 2027, or earlier the moment eight people qualify.** Written
16 November 2026, before there is an answer to be disappointed by.

The date is a backstop, not a judgement about when anyone onboarded — nobody has to remember
partner start dates for this to fire at the right time. The data decides:

- **Whenever `pnpm pmf` shows eight or more eligible respondents across all projects, run it then.**
  Eight is the floor for a result at all (see below), so there is no reason to wait once it is met,
  and the answer is worth more early than tidy. A check on 15 December exists to ask this question
  once before the backstop.
- **Otherwise it runs on 19 January regardless**, and if fewer than eight qualify by then, that is
  the finding. Do not slip the date to go looking for respondents.

Why 19 January as the backstop: four weeks of ordinary use is the minimum for the question to mean
anything, and the two weeks before it are the first full working weeks of the year. December is
holidays and will not tell us anything.

## Who gets asked

Only people who have personally captured a correction at least twice in the last two weeks. Not
the person who signed the contract, not the engineer who installed it and moved on. Surveying
people who never adopted the product measures onboarding, not fit, and the number it produces is
worse than no number because it looks like evidence.

`pnpm pmf` lists who that is, per project.

## The questions

1. How would you feel if you could no longer use Overturn? — *Very disappointed / Somewhat
   disappointed / Not disappointed / I no longer use it*
2. What type of person do you think would most benefit from Overturn?
3. What is the main benefit you get from it?
4. How can we improve it for you?

Question 1 is the number. Questions 2 to 4 are what we actually act on.

## First, is there a result at all

With three design partners this is likely eight to twelve respondents, and one person changing
their mind moves a twelve-person percentage by eight points. So the sample size decides which rule
applies, and that is settled here rather than in January:

- **Fewer than 8 eligible respondents** — no result. Do not compute a percentage. The survey has
  told us nothing about fit; it has told us adoption is too thin to measure, which is its own
  answer and the thing to go fix.
- **8 to 19** — the percentage is directional. It can trigger the 40% branch below, because a
  number that high on a small sample is hard to get by accident. It cannot trigger the pivot branch
  on its own: for that it needs the verbatim pattern named below.
- **20 or more** — the percentage stands on its own, in all three branches.

## The rule, committed in advance

- **40% or more very disappointed** — fit, at any n of 8 or more. Stop building adapters and
  on-ramps and put everything into distribution.
- **20% to 39%** — optimizable. Narrow to whoever answered "very disappointed", read their answers
  to question 2, and rebuild the positioning around exactly those people. Rahul Vohra's claim is
  that 20 reaches 40 by subtraction, not addition.
- **Below 20%** — pivot: keep the codebase and the correction record as the core object, but the
  buyer, the surface or the vertical is wrong. At n of 20 or more this fires on the number alone.
  Between 8 and 19 it fires when the verbatims agree — three or more respondents describing the
  main benefit as something we are not building, or describing no benefit. A low number with
  scattered answers at that n means run it again at twenty users.

That pivot branch is not the same thing as the funnel's existing fallback, which fires on a
different trigger: no design partner forwarding a Capture scorecard after three. They can fire
independently, and either one alone is enough to act on.

## What the verbatims are for

Questions 2 to 4 are not colour for the number. If four people independently describe the same
benefit in their own words, that sentence is the positioning, and it outranks anything the
percentage suggests about what to build next.

Deciding this now, in writing, is the whole exercise. Re-reading it in January and wanting to argue
with it is the expected outcome and not a reason to change it.

## Mechanics

Two scheduled tasks. One on **15 December 2026** asks whether eight people already qualify and, if
they do, runs the survey early. One on **19 January 2027** runs it regardless. Both list the
eligible respondents with `pnpm pmf`, draft the email for Shireen to send, and report against the
rules above. Neither sends anything itself.

If the tasks have been deleted, the dates still stand — run it by hand.
