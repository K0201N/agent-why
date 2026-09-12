# agent-why

[![CI](https://github.com/K0201N/agent-why/actions/workflows/ci.yml/badge.svg)](https://github.com/K0201N/agent-why/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Forensics for coding agents.**

You selected a Codex skill. It didn't behave like it loaded.

`agent-why` reads the persisted Codex session and shows where the explicit skill pipeline actually stopped:

```text
$ agent-why skill review-pr

review-pr

Codex 0.153.4 · cli · paginated

REQUESTED   ✓
BOUND       ✗
INJECTED    ?
USED        ? not observable from ordinary rollout

RESULT      NOT_BOUND

Codex received the $skill mention as user text, but did not persist it as a structured Skill input.
```

Use it when a Codex skill appears to be ignored, behaves differently between sessions, or you need evidence from the affected session instead of inspecting what the current configuration says should happen.

A successful diagnosis can also show that discovery and binding were not the failure point:

```text
$ agent-why skill review-pr

review-pr

Codex 0.154.0 · cli · paginated

REQUESTED   ✓
BOUND       ✓
INJECTED    ✓
USED        ? not observable from ordinary rollout

RESULT      INJECTED

The skill reached model-visible context. Skill discovery/binding was not the failure for this attempt.
```

`agent-why` is local-only and read-only. Its default reports are designed to be paste-safe for bug reports.

## What it checks

```text
$review-pr
    │
    ▼
REQUESTED   user selected or typed the skill
    │
    ▼
BOUND       Codex persisted a structured Skill input
    │
    ▼
INJECTED    typed selected-skill instructions reached model-visible context
```

`agent-why` deliberately stops there. It does **not** claim that the model actually followed the skill, because ordinary Codex rollout history does not reliably prove that today.

## Install / run locally

Requires Node.js 22 or newer.

```bash
npm install
npm link
agent-why skill review-pr
```

By default it searches top-level rollouts under `CODEX_HOME` or `~/.codex` newest-first and analyzes the most recent session that contains an explicit attempt for that skill.

```bash
agent-why skill review-pr               # find the latest session that attempted this skill
agent-why skill review-pr --thread last # force the latest session even if it did not use the skill
agent-why skill review-pr --thread 01abc...
agent-why skill review-pr --file ~/.codex/sessions/.../rollout-....jsonl
agent-why skill review-pr --json
```

## Results

`NOT_BOUND` means the `$skill` mention reached the persisted user message, but Codex did not persist a matching structured Skill input.

`NOT_INJECTED` means Codex bound the skill, the matching turn reached a persisted `TurnComplete`, and no matching typed or untyped skill fragment was observed in that complete window.

`INJECTED` means matching user `input_text` was persisted with the corresponding content kind `skills.selected_skill_instructions`. If behavior was still wrong, discovery/binding was not the failure point.

`UNKNOWN` means the persisted evidence cannot prove the next step. This includes legacy histories, incomplete observation windows, and matching `<skill>` text that was persisted without the selected-skill content kind. Untyped matching text is reported as weak evidence rather than treated as injection.

## Privacy

The default text and `--json` reports are designed to be shareable in bug reports. They never print conversation text, skill contents, absolute skill paths, thread IDs, or turn IDs. File-system and selector errors are also phrased without echoing private paths or thread selectors.

`agent-why` is local-only and read-only:

- no network requests,
- no config changes,
- no Codex process spawned,
- no telemetry.

## Scope of v0.1

Only **explicit Codex skill invocation** is in scope. There is no config sync, skill installation, auto-fix, MCP diagnosis, Claude support, GUI, or generic agent dashboard.

See [`docs/evidence-model.md`](docs/evidence-model.md) for the exact evidence contract and [`ROADMAP.md`](ROADMAP.md) for the current product direction.

## Development

```bash
npm test
npm run smoke
npm run pack:check
```

The test suite covers `NOT_BOUND`, `NOT_INJECTED`, typed `INJECTED`, weak-fragment `UNKNOWN`, content-kind attribution, namespaced plugin skills, turn correlation, compaction/abort handling, malformed JSONL, redaction, automatic rollout discovery, and a 100k-line streaming fixture.

## Status

This is an early v0.1 implementation. The parser has been validated against current Codex source contracts and public rollout shapes; real-world format variants should be reported with a **redacted** minimal fixture.
