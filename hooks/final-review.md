# Final review axes — Ponytail edition

Use this with `final-review.mjs`. This is not a generic audit;
it is a lazy-senior-dev review: reject cleverness, reject unnecessary
abstraction, reject premature generalization.

## Axes

0. Intent trace
1. Correctness / regressions
2. Minimality / shortest working diff
3. No overengineering
4. Bug-fix discipline: root cause, not symptom
5. Boring and reversible
6. Wiring / public contract drift
7. Ship discipline

## Verdict

- ACCEPT = intent trace is clear, smallest working diff is used, no overengineering, and quality gates are green.
- REVISE = any FAIL on correctness, overengineering, or root-cause fix; output one-line diagnosis and the minimal next step.
