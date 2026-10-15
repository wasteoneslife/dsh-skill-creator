#!/usr/bin/env node
/**
 * dsh-skill-validate — validate an existing skill package against the spec.
 * Usage: node bin/dsh-skill-validate.mjs <skill-dir> [--mode huawei|generic] [--edit]
 * Exit code 1 when errors exist (auditor gate).
 */
import path from 'node:path';
import { validateSkillPackage, summarize } from '../src/core/validators.mjs';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
const modeIdx = args.indexOf('--mode');
const mode = modeIdx >= 0 ? args[modeIdx + 1] : 'huawei';
const editMode = args.includes('--edit');
if (!dir) { console.error('usage: node bin/dsh-skill-validate.mjs <skill-dir> [--mode huawei|generic] [--edit]'); process.exit(2); }
const root = path.resolve(dir);
const result = validateSkillPackage(root, { mode, editMode });
const s = summarize(result.issues);
console.log(`校验 ${root}`);
console.log(`  mode=${mode} editMode=${editMode} | files=${result.stats.fileCount} (≤${result.stats.fileCount > 40 ? '40' : '40'}) pkgMB=${result.stats.totalMB}/50 skillMdLines=${result.stats.skillMdLines}/499`);
console.log(`  结果: ${s.errors} error / ${s.warnings} warning`);
for (const i of result.issues) {
  console.log(`  ${i.level === 'error' ? '✗' : i.level === 'warning' ? '⚠' : 'ℹ'} [${i.id}] ${i.message}${i.file ? ` (${i.file})` : ''}`);
}
process.exit(s.errors ? 1 : 0);