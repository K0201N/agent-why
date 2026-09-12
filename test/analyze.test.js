import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeFile, analyzeLines } from '../src/analyze.js';
import { formatHuman } from '../src/format.js';

function json(value) { return JSON.stringify(value); }

function meta(mode = 'paginated') {
  return json({
    timestamp: '2026-09-12T00:00:00Z', ordinal: 0, type: 'session_meta',
    payload: { id: 'thread-secret-id', cli_version: '0.154.0', source: 'cli', originator: 'codex', history_mode: mode },
  });
}

function user({ text = 'use $foo please', skill = false, name = 'foo', skillPath = '/Users/alice/private/.agents/skills/foo/SKILL.md', turn = 'turn-secret-id' } = {}) {
  const content = [{ type: 'text', text, text_elements: [] }];
  if (skill) content.push({ type: 'skill', name, path: skillPath });
  return json({
    timestamp: '2026-09-12T00:00:01Z', ordinal: 1, type: 'event_msg',
    payload: { type: 'item_completed', thread_id: 'thread-secret-id', turn_id: turn, item: { type: 'UserMessage', id: 'user-secret-id', content } },
  });
}

function structuredOnly({ name = 'foo', skillPath = '/repo/.agents/skills/foo/SKILL.md', turn = 'turn-secret-id' } = {}) {
  return json({
    timestamp: '2026-09-12T00:00:01Z', ordinal: 1, type: 'event_msg',
    payload: { type: 'item_completed', thread_id: 'thread-secret-id', turn_id: turn, item: { type: 'UserMessage', id: 'user-secret-id', content: [{ type: 'skill', name, path: skillPath }] } },
  });
}

function skillText(name = 'foo', skillPath = '/Users/alice/private/.agents/skills/foo/SKILL.md') {
  return `<skill>\n<name>${name}</name>\n<path>${skillPath}</path>\nTOP SECRET SKILL BODY\n</skill>`;
}

function responseMessage(content, kinds) {
  return json({
    timestamp: '2026-09-12T00:00:02Z', ordinal: 2, type: 'response_item',
    payload: {
      type: 'message', role: 'user', content,
      ...(kinds ? { internal_chat_message_metadata_passthrough: { content_item_kinds: kinds } } : {}),
    },
  });
}

function injection(name = 'foo', skillPath = '/Users/alice/private/.agents/skills/foo/SKILL.md', typed = true, { role = 'user', contentType = 'input_text' } = {}) {
  return json({
    timestamp: '2026-09-12T00:00:02Z', ordinal: 2, type: 'response_item',
    payload: {
      type: 'message', role,
      content: [{ type: contentType, text: skillText(name, skillPath) }],
      ...(typed ? { internal_chat_message_metadata_passthrough: { content_item_kinds: ['skills.selected_skill_instructions'] } } : {}),
    },
  });
}

function turnComplete(turn = 'turn-secret-id') {
  return json({ timestamp: '2026-09-12T00:00:03Z', ordinal: 3, type: 'event_msg', payload: { type: 'turn_complete', turn_id: turn, last_agent_message: null } });
}

function turnAborted(turn = 'turn-secret-id') {
  return json({ timestamp: '2026-09-12T00:00:03Z', ordinal: 3, type: 'event_msg', payload: { type: 'turn_aborted', turn_id: turn } });
}

function compaction() {
  return json({ timestamp: '2026-09-12T00:00:02Z', ordinal: 2, type: 'event_msg', payload: { type: 'context_compacted' } });
}

test('NOT_BOUND when literal mention exists without structured Skill input', () => {
  const result = analyzeLines([meta(), user({ skill: false })], 'foo');
  assert.equal(result.latest.diagnosis, 'not_bound');
  assert.equal(result.latest.bound, 'no');
  assert.equal(result.latest.injected, 'unknown');
});

test('NOT_INJECTED only after a matching persisted TurnComplete', () => {
  const result = analyzeLines([meta(), user({ skill: true }), turnComplete()], 'foo');
  assert.equal(result.latest.diagnosis, 'not_injected');
  assert.equal(result.latest.bound, 'yes');
  assert.equal(result.latest.injected, 'no');
});

test('bound attempt ending at EOF is UNKNOWN rather than NOT_INJECTED', () => {
  const result = analyzeLines([meta(), user({ skill: true })], 'foo');
  assert.equal(result.latest.diagnosis, 'unknown');
  assert.equal(result.latest.bound, 'yes');
  assert.equal(result.latest.injected, 'unknown');
});

test('INJECTED when structured Skill and selected-skill fragment both exist', () => {
  const result = analyzeLines([meta(), user({ skill: true }), injection()], 'foo');
  assert.equal(result.latest.diagnosis, 'injected');
  assert.equal(result.latest.injectionEvidence, 'typed_fragment');
  assert.equal(result.latest.sameRecordedPath, true);
});

test('untyped matching fragment remains UNKNOWN after TurnComplete', () => {
  const result = analyzeLines([meta(), user({ skill: true }), injection('foo', undefined, false), turnComplete()], 'foo');
  assert.equal(result.latest.diagnosis, 'unknown');
  assert.equal(result.latest.injected, 'unknown');
  assert.equal(result.latest.injectionEvidence, 'skill_fragment');
});

test('user-pasted explanatory skill block cannot prove injection without binding', () => {
  const result = analyzeLines([meta(), user({ skill: false }), injection('foo', undefined, false), turnComplete()], 'foo');
  assert.equal(result.latest.diagnosis, 'not_bound');
  assert.equal(result.latest.injected, 'unknown');
  assert.equal(result.latest.injectionEvidence, 'skill_fragment');
});

test('content kind is matched to the corresponding content item by index', () => {
  const response = responseMessage([
    { type: 'input_text', text: skillText('foo') },
    { type: 'input_text', text: skillText('bar') },
  ], ['other.kind', 'skills.selected_skill_instructions']);
  const result = analyzeLines([meta(), user({ skill: true }), response, turnComplete()], 'foo');
  assert.equal(result.latest.diagnosis, 'unknown');
  assert.equal(result.latest.injectionEvidence, 'skill_fragment');
});

test('weak evidence does not stop scanning and later typed evidence upgrades to INJECTED', () => {
  const result = analyzeLines([
    meta(), user({ skill: true }), injection('foo', undefined, false), injection('foo', undefined, true), turnComplete(),
  ], 'foo');
  assert.equal(result.latest.diagnosis, 'injected');
  assert.equal(result.latest.injected, 'yes');
  assert.equal(result.latest.injectionEvidence, 'typed_fragment');
});

test('typed evidence later in the same message outranks an earlier untyped match', () => {
  const response = responseMessage([
    { type: 'input_text', text: skillText('foo', '/tmp/fake/SKILL.md') },
    { type: 'input_text', text: skillText('foo') },
  ], ['other.kind', 'skills.selected_skill_instructions']);
  const result = analyzeLines([meta(), user({ skill: true }), response], 'foo');
  assert.equal(result.latest.diagnosis, 'injected');
  assert.equal(result.latest.injectionEvidence, 'typed_fragment');
  assert.equal(result.latest.sameRecordedPath, true);
});

test('assistant output cannot masquerade as skill injection', () => {
  const result = analyzeLines([meta(), user({ skill: true }), injection('foo', undefined, true, { role: 'assistant', contentType: 'output_text' }), turnComplete()], 'foo');
  assert.equal(result.latest.diagnosis, 'not_injected');
  assert.equal(result.latest.injected, 'no');
});

test('user output_text cannot masquerade as skill injection', () => {
  const result = analyzeLines([meta(), user({ skill: true }), injection('foo', undefined, true, { role: 'user', contentType: 'output_text' }), turnComplete()], 'foo');
  assert.equal(result.latest.diagnosis, 'not_injected');
});

test('namespaced plugin skills are supported', () => {
  const name = 'example-skills:ask-expert';
  const skillPath = '/home/a/.codex/plugins/cache/example/skills/ask-expert/SKILL.md';
  const result = analyzeLines([meta(), user({ text: `use $${name}`, skill: true, name, skillPath }), injection(name, skillPath, true)], name);
  assert.equal(result.latest.diagnosis, 'injected');
});

test('legacy history never claims NOT_BOUND without structured binding evidence', () => {
  const legacy = json({ timestamp: '2026-09-12T00:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: 'use $foo please' } });
  const result = analyzeLines([meta('legacy'), legacy], 'foo');
  assert.equal(result.latest.bound, 'unknown');
  assert.equal(result.latest.diagnosis, 'unknown');
});

test('legacy history can still prove typed injection when fragment exists', () => {
  const legacy = json({ timestamp: '2026-09-12T00:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: 'use $foo please' } });
  const result = analyzeLines([meta('legacy'), legacy, injection()], 'foo');
  assert.equal(result.latest.diagnosis, 'injected');
});

test('legacy untyped matching fragment remains UNKNOWN', () => {
  const legacy = json({ timestamp: '2026-09-12T00:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: 'use $foo please' } });
  const result = analyzeLines([meta('legacy'), legacy, injection('foo', undefined, false)], 'foo');
  assert.equal(result.latest.diagnosis, 'unknown');
  assert.equal(result.latest.injectionEvidence, 'skill_fragment');
});

test('injection after a different turn user message is not misattributed', () => {
  const result = analyzeLines([meta(), user({ skill: true }), user({ text: 'different turn', skill: false, turn: 'turn-2' }), injection()], 'foo');
  assert.equal(result.latest.diagnosis, 'unknown');
  assert.equal(result.latest.injected, 'unknown');
});

test('same-turn steering does not end the observation window', () => {
  const result = analyzeLines([meta(), user({ skill: true }), user({ text: 'one more detail', skill: false, turn: 'turn-secret-id' }), injection(), turnComplete()], 'foo');
  assert.equal(result.latest.diagnosis, 'injected');
});

test('structured UI skill selection works without literal $foo text', () => {
  const result = analyzeLines([meta(), structuredOnly(), injection()], 'foo');
  assert.equal(result.latest.requestedBy, 'structured_skill');
  assert.equal(result.latest.diagnosis, 'injected');
});

test('malformed JSON before the attempt does not invalidate later positive evidence', () => {
  const result = analyzeLines([meta(), '{not json', user({ skill: true }), injection()], 'foo');
  assert.equal(result.parseErrorCount, 1);
  assert.equal(result.latest.diagnosis, 'injected');
});

test('malformed JSON during a bound attempt makes missing injection UNKNOWN', () => {
  const result = analyzeLines([meta(), user({ skill: true }), '{not json', turnComplete()], 'foo');
  assert.equal(result.parseErrorCount, 1);
  assert.equal(result.latest.diagnosis, 'unknown');
  assert.equal(result.latest.injected, 'unknown');
});

test('compaction during a bound attempt makes missing injection UNKNOWN', () => {
  const result = analyzeLines([meta(), user({ skill: true }), compaction(), turnComplete()], 'foo');
  assert.equal(result.latest.diagnosis, 'unknown');
});

test('aborted turn makes missing injection UNKNOWN', () => {
  const result = analyzeLines([meta(), user({ skill: true }), turnAborted()], 'foo');
  assert.equal(result.latest.diagnosis, 'unknown');
});

test('positive injection remains provable even if later scope becomes incomplete', () => {
  const result = analyzeLines([meta(), user({ skill: true }), injection(), '{not json'], 'foo');
  assert.equal(result.latest.diagnosis, 'injected');
});

test('redacted JSON result never includes path, transcript, body, thread id, turn id, or internal hashes', () => {
  const result = analyzeLines([meta(), user({ skill: true }), injection()], 'foo');
  const serialized = JSON.stringify(result);
  for (const secret of ['/Users/alice/private', 'TOP SECRET SKILL BODY', 'thread-secret-id', 'turn-secret-id', 'user-secret-id', 'boundPathFingerprint', 'injectedPathFingerprint', 'scopeInvalidated', 'completeScope']) {
    assert.equal(serialized.includes(secret), false, `leaked ${secret}`);
  }
});

test('human output is shareable and does not include private content', () => {
  const result = analyzeLines([meta(), user({ skill: true }), injection()], 'foo');
  const output = formatHuman(result);
  assert.match(output, /RESULT\s+INJECTED/);
  assert.equal(output.includes('/Users/alice/private'), false);
  assert.equal(output.includes('TOP SECRET SKILL BODY'), false);
  assert.equal(output.includes('thread-secret-id'), false);
});

test('UNKNOWN human output explains incomplete injection observation', () => {
  const result = analyzeLines([meta(), user({ skill: true })], 'foo');
  const output = formatHuman(result);
  assert.match(output, /RESULT\s+UNKNOWN/);
  assert.match(output, /complete observation window/);
});

test('UNKNOWN human output identifies an untyped matching fragment', () => {
  const result = analyzeLines([meta(), user({ skill: true }), injection('foo', undefined, false), turnComplete()], 'foo');
  const output = formatHuman(result);
  assert.match(output, /INJECTED\s+\? untyped matching skill fragment observed/);
  assert.match(output, /Injection cannot be proven/);
});

test('streaming parser handles a 100k-line rollout', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-why-'));
  const file = path.join(dir, 'rollout.jsonl');
  const stream = fs.createWriteStream(file);
  stream.write(`${meta()}\n`);
  for (let i = 0; i < 100_000; i += 1) stream.write(`${json({ timestamp: '2026-09-12T00:00:00Z', type: 'token_usage_record', payload: { i } })}\n`);
  stream.write(`${user({ skill: true })}\n`);
  stream.write(`${injection()}\n`);
  await new Promise((resolve, reject) => { stream.on('error', reject); stream.end(resolve); });
  const result = await analyzeFile(file, 'foo');
  assert.equal(result.latest.diagnosis, 'injected');
  assert.equal(result.parseErrorCount, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('analyzeFile read errors do not echo an absolute path', async () => {
  const secretPath = '/Users/alice/private/missing-rollout.jsonl';
  await assert.rejects(analyzeFile(secretPath, 'foo'), (error) => {
    assert.equal(error.message, 'could not read rollout JSONL file');
    assert.equal(error.message.includes(secretPath), false);
    return true;
  });
});
