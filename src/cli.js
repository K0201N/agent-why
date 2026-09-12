import fs from 'node:fs/promises';
import { analyzeFile } from './analyze.js';
import { formatHuman } from './format.js';
import { locateLatestSkillAttempt, locateRollout, resolveCodexHome } from './locator.js';

const HELP = `agent-why — explain what happened to an explicitly selected Codex skill

Usage:
  agent-why skill <name> [--json]
  agent-why skill <name> --thread last|<id> [--json]
  agent-why skill <name> --file <rollout.jsonl> [--json]

Options:
  --thread <value>      Analyze the latest top-level rollout, or one whose filename contains <id>
  --file <path>         Analyze an explicit rollout JSONL file
  --codex-home <path>   Override CODEX_HOME / ~/.codex
  --json                Emit redacted JSON instead of human output
  -h, --help            Show this help
  -v, --version         Show the package version

Default discovery:
  Without --thread or --file, search top-level Codex rollouts newest-first and
  analyze the most recent session that contains an explicit attempt for <name>.

Privacy:
  Output never includes conversation text, skill contents, absolute skill paths,
  thread IDs, or turn IDs.
`;

function parseArgs(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true };
  if (argv.includes('-v') || argv.includes('--version')) return { version: true };

  const [command, skillName, ...rest] = argv;
  if (command !== 'skill' || !skillName || skillName.startsWith('-')) {
    throw new Error('usage: agent-why skill <name> [--thread last|<id>] [--json]');
  }

  const options = {
    skillName,
    thread: null,
    file: null,
    codexHome: null,
    json: false,
  };

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--thread' || arg === '--file' || arg === '--codex-home') {
      const value = rest[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--thread') options.thread = value;
      if (arg === '--file') options.file = value;
      if (arg === '--codex-home') options.codexHome = value;
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }

  if (options.thread && options.file) {
    throw new Error('--thread and --file cannot be used together');
  }

  return options;
}

async function packageVersion() {
  const raw = await fs.readFile(new URL('../package.json', import.meta.url), 'utf8');
  return JSON.parse(raw).version;
}

export async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(HELP.trimEnd());
    return;
  }
  if (args.version) {
    console.log(await packageVersion());
    return;
  }

  const codexHome = resolveCodexHome(args.codexHome);
  let result;

  if (!args.thread && !args.file) {
    ({ result } = await locateLatestSkillAttempt({
      codexHome,
      skillName: args.skillName,
    }));
  } else {
    const rollout = await locateRollout({
      codexHome,
      thread: args.thread ?? 'last',
      file: args.file,
    });
    result = await analyzeFile(rollout, args.skillName);
  }

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatHuman(result));
  }
}
