# Evidence model

`agent-why` distinguishes observed evidence from things it cannot prove.

For an explicit skill attempt, v0.1 looks for three persisted checkpoints:

1. **REQUESTED** — the user message contains `$skill`, or a structured skill selection is present.
2. **BOUND** — Codex persisted `UserInput::Skill { name, path }` for the user message.
3. **INJECTED** — a matching `<skill>...</skill>` fragment was persisted as model-visible user `input_text` and the corresponding content item is typed as `skills.selected_skill_instructions`.

`USED` is intentionally not claimed. Ordinary Codex rollout history does not currently provide a reliable, first-class local event proving that the model actually followed or used the injected skill.

## Positive vs. negative evidence

Positive evidence can stand on its own: a persisted structured Skill proves binding, and a typed matching selected-skill instruction fragment proves injection.

An untyped matching `<skill>` fragment is weaker evidence. It may be explanatory text supplied by the user, so `agent-why` records it but does not promote it to `INJECTED`.

Negative evidence requires a complete observation scope. `agent-why` therefore does **not** infer `NOT_INJECTED` merely because it reached EOF or encountered another user message.

A bound attempt is eligible for `NOT_INJECTED` only when all of the following are true:

- the persisted user message contains the matching structured Skill,
- a matching persisted `TurnComplete` for that turn is observed,
- no malformed JSONL line was encountered while the attempt was active,
- no compaction, rollback, or turn abort invalidated that observation window,
- no matching typed injection was observed,
- no untyped matching `<skill>` fragment was observed.

Otherwise the injection state remains `unknown` and the diagnosis is `UNKNOWN`.

## Diagnoses

- `not_bound`: explicit `$skill` text was persisted in a structured user message, but that same message contains no matching Skill input.
- `not_injected`: matching structured Skill input was persisted, the matching turn completed with a complete observation window, and no matching typed or untyped skill fragment was observed.
- `injected`: matching selected-skill instructions were persisted as user `input_text` whose corresponding content kind is `skills.selected_skill_instructions`.
- `unknown`: persisted evidence is insufficient to make the missing step definitive. This includes cases where only an untyped matching `<skill>` fragment is observed.

## Injection attribution

Codex persists `content` and `content_item_kinds` in matching order for contextual fragments. `agent-why` therefore attributes the kind by content index: `content[i]` is paired with `content_item_kinds[i]`.

A matching user `input_text` proves injection only when that exact content item is typed as `skills.selected_skill_instructions`. A matching fragment in another content item does not inherit the kind from the message as a whole.

Assistant messages and `output_text` are never treated as injection evidence.

If an untyped matching fragment appears first, `agent-why` keeps scanning. A later correctly typed matching fragment upgrades the attempt to `INJECTED`.

## Legacy history

Legacy Codex history can retain the user text while dropping the structured `UserInput::Skill` evidence. In that case `agent-why` reports `unknown` instead of fabricating a `not_bound` result. A matching typed selected-skill instruction fragment can still prove injection; an untyped fragment alone cannot.

## Privacy boundary

The report is designed to be pasted into an issue. It never emits:

- user or assistant message bodies,
- skill instruction bodies,
- absolute skill paths,
- thread IDs,
- turn IDs.

File-system and thread-selector errors are also sanitized so private paths and selectors are not echoed.

The parser may compare path fingerprints internally to detect whether binding and injection refer to the same serialized path. The public field is `sameRecordedPath`; fingerprints themselves are never returned.
