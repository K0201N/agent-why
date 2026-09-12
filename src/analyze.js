import fs from 'node:fs';
import readline from 'node:readline';
import crypto from 'node:crypto';

const SKILL_CONTENT_KIND = 'skills.selected_skill_instructions';
const INVALIDATING_EVENT_TYPES = new Set([
  'context_compacted',
  'compacted',
  'thread_rolled_back',
]);

function normalizeType(value) {
  return typeof value === 'string'
    ? value.toLowerCase().replaceAll('-', '_')
    : '';
}

function sameName(a, b) {
  return typeof a === 'string'
    && typeof b === 'string'
    && a.toLowerCase() === b.toLowerCase();
}

function fingerprint(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function hasSkillMention(text, name) {
  if (typeof text !== 'string') return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `(^|[^A-Za-z0-9_:-])\\$${escaped}(?=$|[^A-Za-z0-9_:-])`,
    'i',
  );
  return pattern.test(text);
}

function extractSkillBlocks(text) {
  if (typeof text !== 'string' || !text.toLowerCase().includes('<skill>')) {
    return [];
  }

  const blocks = [];
  const blockPattern = /<skill>([\s\S]*?)<\/skill>/gi;
  for (const match of text.matchAll(blockPattern)) {
    const body = match[1];
    const name = body.match(/<name>([\s\S]*?)<\/name>/i)?.[1]?.trim();
    const path = body.match(/<path>([\s\S]*?)<\/path>/i)?.[1]?.trim();
    if (name) blocks.push({ name, path: path ?? null });
  }
  return blocks;
}

function userTextParts(content) {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (!part || typeof part !== 'object') return [];
    if (normalizeType(part.type) === 'text' && typeof part.text === 'string') {
      return [part.text];
    }
    return [];
  });
}

function userSkillParts(content) {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (!part || typeof part !== 'object') return [];
    if (normalizeType(part.type) !== 'skill' || typeof part.name !== 'string') {
      return [];
    }
    return [{
      name: part.name,
      path: typeof part.path === 'string' ? part.path : null,
    }];
  });
}

function contentKindValue(kind) {
  if (typeof kind === 'string') return kind;
  if (kind && typeof kind === 'object' && typeof kind['0'] === 'string') {
    return kind['0'];
  }
  return null;
}

function responseInputParts(payload) {
  if (!payload || typeof payload !== 'object') return [];
  if (normalizeType(payload.type) !== 'message') return [];
  if (normalizeType(payload.role) !== 'user') return [];
  if (!Array.isArray(payload.content)) return [];

  const kinds = payload?.internal_chat_message_metadata_passthrough?.content_item_kinds;

  return payload.content.flatMap((part, index) => {
    if (!part || typeof part !== 'object') return [];
    if (normalizeType(part.type) !== 'input_text' || typeof part.text !== 'string') {
      return [];
    }
    return [{
      text: part.text,
      kind: Array.isArray(kinds) ? contentKindValue(kinds[index]) : null,
    }];
  });
}

function parseJsonLine(raw, lineNumber) {
  try {
    return { lineNumber, value: JSON.parse(raw) };
  } catch {
    return { lineNumber, error: true };
  }
}

function sessionMeta(record) {
  if (normalizeType(record?.type) !== 'session_meta') return null;
  if (!record.payload || typeof record.payload !== 'object') return null;

  const payload = record.payload;
  const meta = payload.meta && typeof payload.meta === 'object' ? payload.meta : payload;
  return {
    historyMode: typeof meta.history_mode === 'string'
      ? normalizeType(meta.history_mode)
      : null,
    version: typeof meta.cli_version === 'string' ? meta.cli_version : null,
    source: typeof meta.source === 'string' ? meta.source : null,
    originator: typeof meta.originator === 'string' ? meta.originator : null,
  };
}

function userEvidence(record, skillName) {
  if (normalizeType(record?.type) !== 'event_msg') return null;
  const payload = record.payload;
  if (!payload || typeof payload !== 'object') return null;

  const payloadType = normalizeType(payload.type);
  if (payloadType === 'item_completed' && payload.item && typeof payload.item === 'object') {
    const item = payload.item;
    const itemType = normalizeType(item.type);
    if (itemType !== 'usermessage' && itemType !== 'user_message') return null;

    const textMention = userTextParts(item.content)
      .some((text) => hasSkillMention(text, skillName));
    const boundSkill = userSkillParts(item.content)
      .find((skill) => sameName(skill.name, skillName)) ?? null;

    return {
      isUserMessage: true,
      relevant: textMention || Boolean(boundSkill),
      textMention,
      boundSkill,
      turnId: typeof payload.turn_id === 'string' ? payload.turn_id : null,
      kind: 'structured_user_message',
    };
  }

  if (payloadType === 'user_message') {
    const text = typeof payload.message === 'string'
      ? payload.message
      : typeof payload.text === 'string'
        ? payload.text
        : '';
    return {
      isUserMessage: true,
      relevant: hasSkillMention(text, skillName),
      textMention: hasSkillMention(text, skillName),
      boundSkill: null,
      turnId: typeof payload.turn_id === 'string' ? payload.turn_id : null,
      kind: 'legacy_user_message',
    };
  }

  return null;
}

function eventEvidence(record) {
  const topType = normalizeType(record?.type);
  const payload = record?.payload;
  const payloadType = normalizeType(payload?.type);
  const turnId = typeof payload?.turn_id === 'string' ? payload.turn_id : null;

  if (topType === 'event_msg' && payloadType === 'turn_complete') {
    return { kind: 'turn_complete', turnId };
  }
  if (topType === 'event_msg' && payloadType === 'turn_aborted') {
    return { kind: 'turn_aborted', turnId };
  }
  if (INVALIDATING_EVENT_TYPES.has(topType) || INVALIDATING_EVENT_TYPES.has(payloadType)) {
    return { kind: 'scope_invalidated', turnId };
  }
  return null;
}

function injectionEvidence(record, skillName) {
  if (normalizeType(record?.type) !== 'response_item') return null;
  const payload = record.payload;
  let weakEvidence = null;

  for (const part of responseInputParts(payload)) {
    const block = extractSkillBlocks(part.text)
      .find((candidate) => sameName(candidate.name, skillName));
    if (!block) continue;

    const evidence = {
      pathFingerprint: fingerprint(block.path),
      strength: part.kind === SKILL_CONTENT_KIND
        ? 'typed_fragment'
        : 'skill_fragment',
    };

    if (evidence.strength === 'typed_fragment') return evidence;
    weakEvidence ??= evidence;
  }

  return weakEvidence;
}

function startAttempt({ lineNumber, evidence, historyMode }) {
  let bound = 'no';
  if (evidence.boundSkill) {
    bound = 'yes';
  } else if (evidence.kind === 'legacy_user_message' || historyMode === 'legacy') {
    bound = 'unknown';
  }

  return {
    requestLine: lineNumber,
    turnId: evidence.turnId,
    requested: 'yes',
    requestedBy: evidence.textMention ? 'text_mention' : 'structured_skill',
    bound,
    boundPathFingerprint: fingerprint(evidence.boundSkill?.path ?? null),
    injected: 'unknown',
    injectionLine: null,
    injectedPathFingerprint: null,
    injectionEvidence: null,
    completeScope: false,
    scopeInvalidated: false,
    diagnosis: null,
    sameRecordedPath: null,
  };
}

function finalizeAttempt(attempt) {
  if (!attempt || attempt.diagnosis) return attempt;

  if (attempt.injected === 'yes') {
    attempt.diagnosis = 'injected';
  } else if (attempt.bound === 'no') {
    attempt.diagnosis = 'not_bound';
  } else if (
    attempt.bound === 'yes'
    && attempt.completeScope
    && !attempt.scopeInvalidated
    && attempt.injectionEvidence !== 'skill_fragment'
  ) {
    attempt.injected = 'no';
    attempt.diagnosis = 'not_injected';
  } else {
    attempt.diagnosis = 'unknown';
  }

  if (attempt.injected === 'yes' && attempt.boundPathFingerprint && attempt.injectedPathFingerprint) {
    attempt.sameRecordedPath = attempt.boundPathFingerprint === attempt.injectedPathFingerprint;
  }

  return attempt;
}

function publicAttempt(attempt) {
  if (!attempt) return null;
  return {
    requestLine: attempt.requestLine,
    requested: attempt.requested,
    requestedBy: attempt.requestedBy,
    bound: attempt.bound,
    injected: attempt.injected,
    injectionLine: attempt.injectionLine,
    injectionEvidence: attempt.injectionEvidence,
    sameRecordedPath: attempt.sameRecordedPath,
    diagnosis: attempt.diagnosis,
  };
}

class Analyzer {
  constructor(skillName) {
    this.skillName = skillName;
    this.historyMode = 'unknown';
    this.session = {
      version: null,
      source: null,
      originator: null,
    };
    this.parseErrorCount = 0;
    this.attempts = [];
    this.activeAttempt = null;
  }

  finishActive() {
    if (!this.activeAttempt) return;
    this.attempts.push(finalizeAttempt(this.activeAttempt));
    this.activeAttempt = null;
  }

  consume(raw, lineNumber) {
    if (!raw.trim()) return;

    const parsed = parseJsonLine(raw, lineNumber);
    if (parsed.error) {
      this.parseErrorCount += 1;
      if (this.activeAttempt) this.activeAttempt.scopeInvalidated = true;
      return;
    }

    const record = parsed.value;
    const meta = sessionMeta(record);
    if (meta) {
      if (meta.historyMode) this.historyMode = meta.historyMode;
      this.session = {
        version: meta.version,
        source: meta.source,
        originator: meta.originator,
      };
    }

    const event = eventEvidence(record);
    if (this.activeAttempt && event) {
      if (event.kind === 'scope_invalidated') {
        this.activeAttempt.scopeInvalidated = true;
      } else if (event.kind === 'turn_aborted') {
        if (!this.activeAttempt.turnId || !event.turnId || event.turnId === this.activeAttempt.turnId) {
          this.activeAttempt.scopeInvalidated = true;
          this.finishActive();
        }
      } else if (event.kind === 'turn_complete') {
        if (this.activeAttempt.turnId && event.turnId === this.activeAttempt.turnId) {
          this.activeAttempt.completeScope = true;
          this.finishActive();
        }
      }
      return;
    }

    const evidence = userEvidence(record, this.skillName);
    if (evidence?.isUserMessage) {
      if (this.activeAttempt) {
        const sameTurn = this.activeAttempt.turnId
          && evidence.turnId
          && this.activeAttempt.turnId === evidence.turnId;
        if (!sameTurn) this.finishActive();
      }

      if (!this.activeAttempt && evidence.relevant) {
        this.activeAttempt = startAttempt({
          lineNumber,
          evidence,
          historyMode: this.historyMode,
        });
      } else if (this.activeAttempt && evidence.relevant && evidence.boundSkill) {
        this.activeAttempt.bound = 'yes';
        this.activeAttempt.boundPathFingerprint = fingerprint(evidence.boundSkill.path);
      }
      return;
    }

    if (this.activeAttempt && this.activeAttempt.injected !== 'yes') {
      const injected = injectionEvidence(record, this.skillName);
      if (injected?.strength === 'typed_fragment') {
        this.activeAttempt.injected = 'yes';
        this.activeAttempt.injectionLine = lineNumber;
        this.activeAttempt.injectedPathFingerprint = injected.pathFingerprint;
        this.activeAttempt.injectionEvidence = injected.strength;
      } else if (injected?.strength === 'skill_fragment' && !this.activeAttempt.injectionEvidence) {
        this.activeAttempt.injectionLine = lineNumber;
        this.activeAttempt.injectionEvidence = injected.strength;
      }
    }
  }

  result() {
    this.finishActive();

    const attempts = this.attempts.map(publicAttempt);
    return {
      schemaVersion: 2,
      skill: this.skillName,
      historyMode: this.historyMode,
      session: this.session,
      parseErrorCount: this.parseErrorCount,
      attempts,
      latest: attempts.at(-1) ?? null,
    };
  }
}

export function analyzeLines(lines, skillName) {
  const analyzer = new Analyzer(skillName);
  let lineNumber = 0;
  for (const line of lines) analyzer.consume(line, ++lineNumber);
  return analyzer.result();
}

export async function analyzeFile(filePath, skillName) {
  const analyzer = new Analyzer(skillName);
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    let lineNumber = 0;
    for await (const line of lines) analyzer.consume(line, ++lineNumber);
    return analyzer.result();
  } catch {
    throw new Error('could not read rollout JSONL file');
  } finally {
    lines.close();
  }
}
