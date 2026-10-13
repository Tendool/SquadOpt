# Model audit: backup policy, solver status, tests

Scope: correctness only. The interface, styling, animations, dataset, API and optimisation model are unchanged
except for the items below.

## 1. One reserve covering many positions (the Joelinton case)

**Finding.** `D = Σ_t n_t · e(b_t, t)` counts the designated backup `b_t` as available whenever a starter at position
`t` is missing. This is a first-order (one absence at a time) approximation. In the original model the only constraint
on a backup was `z_it ≤ x_i − Σ_t y_it`, so one reserve could be the backup for every position. With one reserve covering
10 starters at p = 0.1, two or more of those starters are out together in 1 − 0.9¹⁰ − 10·0.1·0.9⁹ ≈ 26% of matches.
The reserve can only replace one of them, but `D` counts them all. The objective therefore overstates depth, and the
optimiser is rewarded for exactly that overstatement.

**Change.** `distinct_backups=True` (website default) uses the aggregated constraint `Σ_t z_it ≤ k·(x_i − Σ_t y_it)`.
- With `k = 1`, a reserve backs at most one position. The model stays linear and the variables are unchanged.
- Dominance pruning stays exact, because each player still has a single role that a dominating player can take over.
  This is tested against the unpruned model and against CBC.

**Feasibility.** A formation has T ≤ 9 positions with sides (9 for 4-2-3-1, 4-1-4-1 and 4-3-3 DM). There are N − 11
reserves.
- With N ≥ 20, k = 1 is always possible.
- For N = 18 or 19 in a 9-position shape it is impossible, so the cap becomes the smallest feasible value,
  `k = ⌈T/(N − 11)⌉` = 2. The UI says so.
- No case in the experiments became infeasible, down to €40M.

**Effect.** Synthetic 12,010-player fixture, sided positions, p = 0.10, 2,000 simulations. The real FC26 CSV is not on
this machine.

| Scenario | Shared XI / D / EQ / sim. E[Q] / P5 | Distinct XI / D / EQ / sim. E[Q] / P5 | Max cover, shared → distinct |
|---|---|---|---|
| 4-4-2 diamond, €475M, age ≤ 30 | 939 / 871 / 932.2 / 930.6 / 912 | 937 / 858 / 929.1 / 928.9 / 914 | 3 → 1 |
| 4-3-3, €300M | 927 / 860 / 920.3 / 917.2 / 892 | 926 / 844 / 917.8 / 917.4 / 899 | 3 → 1 |
| 3-5-2, €150M | 893 / 853 / 889.0 / 885.9 / 864 | 893 / 844 / 888.1 / 887.0 / 872 | 3 → 1 |
| 4-2-3-1, €100M | 877 / 819 / 871.2 / 867.1 / 840 | 877 / 782 / 867.5 / 867.7 / 850 | 4 → 1 |
| 5-3-2, €60M | 846 / 799 / 841.3 / 838.3 / 818 | 846 / 789 / 840.3 / 839.1 / 823 | 3 → 1 |
| 4-4-2, €40M | 836 / 769 / 829.3 / 826.2 / 802 | 834 / 751 / 825.7 / 825.3 / 808 | 5 → 1 |

**Trade-offs.**
- **Model objective.** The model EQ falls by 0.9–3.7. This is expected: the value removed was the overstatement.
- **Simulated quality.** The simulated expected quality, which re-picks the best XI with the Hungarian algorithm,
  changes by −1.7 to +1.1. It is higher in 4 of 6 cases.
- **Accuracy of the objective.** The gap between the objective and the simulation falls from 1.6–4.1 to −0.2–1.2.
- **Bad matches.** The worst-5% quality improves in all 6 cases, by 2 to 10.
- **XI quality.** XI quality drops by at most 2.
- **Solve time.** Solve time was lower in 5 of 6 cases.

The notebook model is still available with `distinct_backups=False`.

## 2. Backup eligibility

**Rule.** A backup needs a rating of at least 65 at the position it covers. Cover at an unlisted position is allowed
and counted at rating − 3. Goalkeepers only cover GK.

This is the same rule as for starters, and the same one the Monte Carlo evaluation uses when it re-picks lineups. A
stricter rule for backups alone would make the objective and the simulation disagree.

`backup_listed_only=True` restricts backups to listed positions. In all six cases above it gave the same squad as the
penalised rule.

**UI.** Each backup card shows the rating counted in D. A "−3" marker appears when the player is not listed there, and
a one-line note states the rule.

## 3. Solver status

**Status mapping.** PuLP maps HiGHS `kTimeLimit`, `kInterrupt`, `kIterationLimit` and similar stops to status
`Optimal` with solution status `IntegerFeasible`. `_is_optimal` now requires `sol_status == LpSolutionOptimal`.
Other stops are reported as "Not proven optimal (time limit)".

**Stage 1.** If stage 1 is not proven optimal, no squad is returned. The API answers 504 "stopped at its time limit",
and it says "No valid squad" only when the status is Infeasible.

**Stage 2.** If the tie-break fails for any reason, the stage-1 optimum is restored and `tiebreak_done=False`. Before
the change, an Infeasible tie-break returned None. The model view colours a non-optimal stage as a warning.

**Checks.** `validate()` now also checks:
- backup eligibility;
- the distinctness cap;
- the objective recomputed from raw ratings against the solver's value.

## 4. Tests

`tests/test_audit.py` adds 42 tests. Coverage:
- **Distinct backups:** valid in 5 formations × 3 budgets; pruned = unpruned = CBC; never better than shared.
- **Small squads:** the cap for N = 18–23.
- **Validator:** catches a shared backup and a goalkeeper covering ST.
- **Out-of-position cover:** counted at −3.
- **Listed-only rule:** behaves as documented.
- **Status mapping:** on fake PuLP models, plus a real 0.05 s time limit.
- **Failures:** stage 1 fails → None and 504; stage 2 fails (time limit, not solved, infeasible) → stage-1 optimum kept.
- **API payload:** the policy fields and backup detail.
- **Pinned regression:** numbers for a fixed synthetic scenario.
- **Real FC26 scenario:** the 4-4-2 diamond / €475M / 23 / age-30 test. It runs only when the real CSV is available,
  and is skipped otherwise.
