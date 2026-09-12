# Roadmap

`agent-why` is intentionally narrow: explain what a coding-agent session actually observed, using persisted evidence rather than current configuration.

This roadmap describes direction, not release commitments. Scope may change as Codex rollout and trace formats evolve.

## v0.1.x — parser and evidence hardening

Focus on correctness rather than new surface area.

- absorb real rollout schema variants and edge cases,
- reduce false positives and false negatives,
- keep negative diagnoses gated on complete observation windows,
- add small, redacted regression fixtures for confirmed failures,
- preserve streaming behavior for very large rollouts.

## v0.2 — Codex Rollout Trace

Explore richer native trace evidence beyond ordinary persisted rollout history.

The main question is whether runtime evidence can reliably extend the current pipeline:

```text
REQUESTED
BOUND
INJECTED
? USED
```

Any new `USED`-level claim must be backed by explicit trace evidence. Absence of an event must not be treated as proof unless the observation scope is known to be complete.

## v0.3 — isolated replay

Explore a replay mode for reproducing suspicious skill-loading behavior in a disposable environment.

- never mutate the user's real `HOME` or `CODEX_HOME`,
- run only against isolated temporary state,
- label replay output as `REPLAY`, not historical fact,
- keep observed session evidence separate from reproduced behavior.

## v0.4 — differential forensics

Compare equivalent evidence or replay outcomes across Codex versions or controlled environments.

Example:

```text
0.154.0  INJECTED
0.155.0  NOT_BOUND
```

The goal is to make regressions attributable without turning `agent-why` into a generic config manager or agent dashboard.

## Later

Support for additional coding-agent hosts may be considered after the Codex evidence model, trace ingestion, and replay boundaries are stable.

Out of scope for the near term: config sync, skill installation, auto-fix, generic MCP diagnosis, GUI dashboards, and broad multi-agent orchestration.
