import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/agent-why.js', import.meta.url));
const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('--version matches package.json', () => {
  const output = execFileSync(process.execPath, [bin, '--version'], { encoding: 'utf8' }).trim();
  assert.equal(output, packageJson.version);
});

test('npm package preserves the agent-why CLI bin entry', () => {
  assert.equal(packageJson.bin?.['agent-why'], 'bin/agent-why.js');
});
