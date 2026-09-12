import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { locateLatestSkillAttempt, locateRollout } from '../src/locator.js';

function meta(threadSource) {
  return `${JSON.stringify({
    type: 'session_meta',
    payload: {
      history_mode: 'paginated',
      cli_version: '0.154.0',
      source: 'cli',
      ...(threadSource ? { thread_source: threadSource } : {}),
    },
  })}\n`;
}

function skillAttempt(name) {
  return `${JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      turn_id: 'turn-secret',
      item: {
        type: 'UserMessage',
        content: [
          { type: 'text', text: `use $${name}` },
          { type: 'skill', name, path: `/private/${name}/SKILL.md` },
        ],
      },
    },
  })}\n`;
}

test('locates latest top-level rollout and explicit thread id by filename', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-why-home-'));
  const day = path.join(root, 'sessions', '2026', '09', '12');
  await fs.mkdir(day, { recursive: true });
  const main = path.join(day, 'rollout-a-thread-aaa.jsonl');
  const newerSubagent = path.join(day, 'rollout-b-thread-bbb.jsonl');
  await fs.writeFile(main, meta('user'));
  await new Promise((resolve) => setTimeout(resolve, 10));
  await fs.writeFile(newerSubagent, meta('subagent'));

  assert.equal(await locateRollout({ codexHome: root, thread: 'last' }), main);
  assert.equal(await locateRollout({ codexHome: root, thread: 'thread-bbb' }), newerSubagent);
  await fs.rm(root, { recursive: true, force: true });
});

test('latest top-level discovery searches past more than 50 newer subagents', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-why-home-'));
  const day = path.join(root, 'sessions', '2026', '09', '12');
  await fs.mkdir(day, { recursive: true });
  const main = path.join(day, 'rollout-main.jsonl');
  await fs.writeFile(main, meta('user'));
  const base = Date.now() / 1000;
  await fs.utimes(main, base, base);

  for (let i = 0; i < 55; i += 1) {
    const file = path.join(day, `rollout-subagent-${String(i).padStart(2, '0')}.jsonl`);
    await fs.writeFile(file, meta('subagent'));
    await fs.utimes(file, base + i + 1, base + i + 1);
  }

  assert.equal(await locateRollout({ codexHome: root, thread: 'last' }), main);
  await fs.rm(root, { recursive: true, force: true });
});

test('falls back to newest rollout when all candidates are subagents', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-why-home-'));
  const day = path.join(root, 'sessions', '2026', '09', '12');
  await fs.mkdir(day, { recursive: true });
  const older = path.join(day, 'rollout-a.jsonl');
  const newer = path.join(day, 'rollout-b.jsonl');
  await fs.writeFile(older, meta('subagent'));
  await new Promise((resolve) => setTimeout(resolve, 10));
  await fs.writeFile(newer, meta('subagent'));

  assert.equal(await locateRollout({ codexHome: root, thread: 'last' }), newer);
  await fs.rm(root, { recursive: true, force: true });
});

test('default skill discovery skips newer unrelated sessions and finds the latest matching attempt', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-why-home-'));
  const day = path.join(root, 'sessions', '2026', '09', '12');
  await fs.mkdir(day, { recursive: true });

  const matching = path.join(day, 'rollout-old-matching.jsonl');
  const unrelated = path.join(day, 'rollout-new-unrelated.jsonl');
  await fs.writeFile(matching, `${meta('user')}${skillAttempt('review-pr')}`);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await fs.writeFile(unrelated, `${meta('user')}${skillAttempt('summarize-docs')}`);

  const found = await locateLatestSkillAttempt({ codexHome: root, skillName: 'review-pr' });
  assert.equal(found.file, matching);
  assert.equal(found.result.latest?.bound, 'yes');
  assert.equal(found.scanned, 2);
  await fs.rm(root, { recursive: true, force: true });
});

test('default skill discovery ignores newer subagent matches', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-why-home-'));
  const day = path.join(root, 'sessions', '2026', '09', '12');
  await fs.mkdir(day, { recursive: true });

  const topLevel = path.join(day, 'rollout-top-level.jsonl');
  const subagent = path.join(day, 'rollout-subagent.jsonl');
  await fs.writeFile(topLevel, `${meta('user')}${skillAttempt('review-pr')}`);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await fs.writeFile(subagent, `${meta('subagent')}${skillAttempt('review-pr')}`);

  const found = await locateLatestSkillAttempt({ codexHome: root, skillName: 'review-pr' });
  assert.equal(found.file, topLevel);
  assert.equal(found.scanned, 1);
  await fs.rm(root, { recursive: true, force: true });
});

test('missing skill discovery explains that absence is not proof of a broken skill', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-why-home-'));
  const day = path.join(root, 'sessions', '2026', '09', '12');
  await fs.mkdir(day, { recursive: true });
  await fs.writeFile(path.join(day, 'rollout-unrelated.jsonl'), `${meta('user')}${skillAttempt('other-skill')}`);

  await assert.rejects(
    locateLatestSkillAttempt({ codexHome: root, skillName: 'format-code' }),
    (error) => {
      assert.match(error.message, /No explicit "format-code" skill invocation was found across 1 saved top-level Codex session/);
      assert.match(error.message, /does not mean the skill is missing or broken/);
      assert.match(error.message, /no saved session where Codex recorded it as an explicit skill attempt/);
      return true;
    },
  );
  await fs.rm(root, { recursive: true, force: true });
});

test('no-rollout error does not expose CODEX_HOME path', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-why-secret-home-'));
  await assert.rejects(locateRollout({ codexHome: root, thread: 'last' }), (error) => {
    assert.equal(error.message, 'no Codex rollout JSONL files were found in CODEX_HOME');
    assert.equal(error.message.includes(root), false);
    return true;
  });
  await fs.rm(root, { recursive: true, force: true });
});

test('thread selector miss does not echo the supplied selector', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-why-home-'));
  const day = path.join(root, 'sessions', '2026', '09', '12');
  await fs.mkdir(day, { recursive: true });
  await fs.writeFile(path.join(day, 'rollout-a.jsonl'), meta('user'));
  const secret = 'private-thread-selector-123';

  await assert.rejects(locateRollout({ codexHome: root, thread: secret }), (error) => {
    assert.equal(error.message, 'no rollout filename matched the supplied thread selector');
    assert.equal(error.message.includes(secret), false);
    return true;
  });
  await fs.rm(root, { recursive: true, force: true });
});

test('missing --file error does not expose the supplied path', async () => {
  const secret = '/Users/alice/private/missing-rollout.jsonl';
  await assert.rejects(locateRollout({ codexHome: '/unused', file: secret }), (error) => {
    assert.equal(error.message, 'could not read the supplied --file path');
    assert.equal(error.message.includes(secret), false);
    return true;
  });
});
