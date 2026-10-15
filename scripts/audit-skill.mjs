#!/usr/bin/env node
/**
 * audit-skill — run the creator's own auditor against a generated skill package.
 *
 * This is the ground truth for "consistent with huawei-cloud-skill-creator": the
 * creator ships `scripts/validate-skill.sh`, so instead of trusting our validator we
 * execute theirs. Windows needs Git Bash (no `bash` on PATH by default).
 *
 * Usage: node scripts/audit-skill.mjs <skill-dir> [--creator <creator-skill-dir>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { creatorDir } from '../src/core/creators.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
// The auditor ships with the fetched creator, so auditing always uses the same revision
// the creator itself uses. `--creator <dir>` still accepts an explicit checkout.
const CREATOR_CANDIDATES = [
  process.env.DSH_CREATOR_SRC,
  creatorDir('huawei'),
].filter(Boolean);
const BASH_CANDIDATES = [
  'C:/Program Files/Git/bin/bash.exe',
  'C:/Program Files/Git/usr/bin/bash.exe',
  'bash',
];

const args = process.argv.slice(2);
const creatorIndex = args.indexOf('--creator');
const creatorValueIndex = creatorIndex >= 0 ? creatorIndex + 1 : -1;
const creator = creatorValueIndex >= 0 ? args[creatorValueIndex] : CREATOR_CANDIDATES.find((p) => fs.existsSync(p));
const target = args.find((a, i) => i !== creatorIndex && i !== creatorValueIndex && !a.startsWith('--'));

if (!target) {
  console.error('usage: node scripts/audit-skill.mjs <skill-dir> [--creator <creator-skill-dir>]');
  process.exit(2);
}
if (!creator || !fs.existsSync(path.join(creator, 'scripts', 'validate-skill.sh'))) {
  console.error(`creator auditor not found; pass --creator <dir>. Tried:\n  ${CREATOR_CANDIDATES.join('\n  ')}`);
  process.exit(2);
}
const bash = BASH_CANDIDATES.find((b) => b === 'bash' || fs.existsSync(b));
if (!bash) {
  console.error('no bash found — install Git for Windows or run this on a POSIX host');
  process.exit(2);
}

const script = path.join(creator, 'scripts', 'validate-skill.sh').replace(/\\/g, '/');
const skillDir = path.resolve(target).replace(/\\/g, '/');
console.log(`auditing ${skillDir}\n   with ${script}\n`);
const result = spawnSync(bash, [script, '-s', skillDir], { stdio: 'inherit' });
console.log(`\n(creator path: ${creator.replace(/\\/g, '/')})\n(repo root: ${ROOT})`);
process.exit(result.status ?? 1);
