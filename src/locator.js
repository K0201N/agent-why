import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { analyzeFile } from './analyze.js';

export function resolveCodexHome(explicitHome) {
  if (explicitHome) return path.resolve(explicitHome);
  if (process.env.CODEX_HOME) return path.resolve(process.env.CODEX_HOME);
  return path.join(os.homedir(), '.codex');
}

async function* walkJsonl(root) {
  let dir;
  try {
    dir = await fs.opendir(root);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return;
    throw new Error('could not read Codex session directory');
  }

  try {
    for await (const entry of dir) {
      const full = path.join(root, entry.name);
      if (entry.isDirectory()) {
        yield* walkJsonl(full);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        yield full;
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'could not read Codex session directory') {
      throw error;
    }
    throw new Error('could not read Codex session directory');
  }
}

export async function listRollouts(codexHome) {
  const roots = [
    path.join(codexHome, 'sessions'),
    path.join(codexHome, 'archived_sessions'),
  ];

  const found = [];
  for (const root of roots) {
    for await (const file of walkJsonl(root)) found.push(file);
  }
  return found;
}

async function firstRecord(file) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead === 0) return null;
    const firstLine = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/, 1)[0];
    if (!firstLine.trim()) return null;
    return JSON.parse(firstLine);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function isSubagentRollout(file) {
  const record = await firstRecord(file);
  if (!record || record.type !== 'session_meta' || !record.payload) return false;
  const meta = record.payload.meta && typeof record.payload.meta === 'object'
    ? record.payload.meta
    : record.payload;
  const source = meta.thread_source;
  if (typeof source === 'string') return source.toLowerCase() === 'subagent';
  if (source && typeof source === 'object') {
    return JSON.stringify(source).toLowerCase().includes('subagent');
  }
  return false;
}

async function withMtime(files) {
  try {
    return await Promise.all(files.map(async (candidate) => ({
      candidate,
      stat: await fs.stat(candidate),
    })));
  } catch {
    throw new Error('could not inspect Codex rollout files');
  }
}

async function rolloutsByRecency(codexHome) {
  const rollouts = await listRollouts(codexHome);
  if (rollouts.length === 0) {
    throw new Error('no Codex rollout JSONL files were found in CODEX_HOME');
  }
  const candidates = await withMtime(rollouts);
  candidates.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  return candidates;
}

export async function locateRollout({ codexHome, thread = 'last', file }) {
  if (file) {
    const resolved = path.resolve(file);
    let stat;
    try {
      stat = await fs.stat(resolved);
    } catch {
      throw new Error('could not read the supplied --file path');
    }
    if (!stat.isFile()) throw new Error('the supplied --file path is not a file');
    return resolved;
  }

  const candidates = await rolloutsByRecency(codexHome);

  if (thread !== 'last') {
    const byName = candidates.filter(({ candidate }) => path.basename(candidate).includes(thread));
    if (byName.length === 0) throw new Error('no rollout filename matched the supplied thread selector');
    return byName[0].candidate;
  }

  for (const entry of candidates) {
    if (!(await isSubagentRollout(entry.candidate))) return entry.candidate;
  }
  return candidates[0].candidate;
}

export async function locateLatestSkillAttempt({ codexHome, skillName }) {
  const candidates = await rolloutsByRecency(codexHome);
  let scanned = 0;

  for (const entry of candidates) {
    if (await isSubagentRollout(entry.candidate)) continue;
    scanned += 1;
    const result = await analyzeFile(entry.candidate, skillName);
    if (result.latest) {
      return {
        file: entry.candidate,
        result,
        scanned,
      };
    }
  }

  throw new Error(
    `No explicit "${skillName}" skill invocation was found across ${scanned} saved top-level Codex session(s).\n\n`
      + 'This does not mean the skill is missing or broken. It only means agent-why found no saved session where Codex recorded it as an explicit skill attempt.',
  );
}
