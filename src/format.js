const MARK = {
  yes: '✓',
  no: '✗',
  unknown: '?',
};

function valueMark(value) {
  return MARK[value] ?? '·';
}

function resultMessage(diagnosis, attempt) {
  switch (diagnosis) {
    case 'injected':
      return 'The skill reached model-visible context. Skill discovery/binding was not the failure for this attempt.';
    case 'not_injected':
      return 'Codex bound the skill, the turn completed, and no matching skill-instruction injection was persisted.';
    case 'not_bound':
      return 'Codex received the $skill mention as user text, but did not persist it as a structured Skill input.';
    case 'unknown':
      if (attempt?.injectionEvidence === 'skill_fragment') {
        return 'A matching <skill> fragment was persisted, but it was not identified as selected skill instructions. Injection cannot be proven from this evidence alone.';
      }
      if (attempt?.bound === 'yes') {
        return 'Codex bound the skill, but this rollout does not contain a complete observation window to determine whether matching skill instructions were injected.';
      }
      return 'This session does not contain enough binding evidence to determine where the skill stopped.';
    default:
      return 'No matching explicit skill attempt was found in this rollout.';
  }
}

export function formatHuman(result) {
  const lines = [];
  lines.push(result.skill);
  lines.push('');

  const sessionBits = [];
  if (result.session.version) sessionBits.push(`Codex ${result.session.version}`);
  if (result.session.source) sessionBits.push(result.session.source);
  if (result.historyMode !== 'unknown') sessionBits.push(result.historyMode);
  if (sessionBits.length) lines.push(sessionBits.join(' · '));

  const attempt = result.latest;
  if (!attempt) {
    lines.push('');
    lines.push('REQUESTED   ✗');
    lines.push('BOUND       ·');
    lines.push('INJECTED    ·');
    lines.push('USED        ? not observable from ordinary rollout');
    lines.push('');
    lines.push('RESULT      NOT_REQUESTED');
    lines.push('');
    lines.push(resultMessage(null, null));
    if (result.parseErrorCount) lines.push(`\nWarning: skipped ${result.parseErrorCount} malformed JSONL line(s).`);
    return lines.join('\n');
  }

  lines.push('');
  lines.push(`REQUESTED   ${valueMark(attempt.requested)}`);
  lines.push(`BOUND       ${valueMark(attempt.bound)}`);
  if (attempt.injected === 'unknown' && attempt.injectionEvidence === 'skill_fragment') {
    lines.push('INJECTED    ? untyped matching skill fragment observed');
  } else {
    lines.push(`INJECTED    ${valueMark(attempt.injected)}`);
  }
  lines.push('USED        ? not observable from ordinary rollout');
  lines.push('');
  lines.push(`RESULT      ${attempt.diagnosis.toUpperCase()}`);
  lines.push('');
  lines.push(resultMessage(attempt.diagnosis, attempt));

  if (attempt.sameRecordedPath === false) {
    lines.push('Warning: the recorded bound skill path and injected skill path do not match.');
  }
  if (result.parseErrorCount) {
    lines.push(`Warning: skipped ${result.parseErrorCount} malformed JSONL line(s).`);
  }
  return lines.join('\n');
}
