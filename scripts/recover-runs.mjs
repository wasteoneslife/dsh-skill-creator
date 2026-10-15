#!/usr/bin/env node
/**
 * Rebuild creation records from the surviving session logs.
 *
 * Why this exists: `disposeAll()` used to clear the in-memory map and *then* flush, so every clean
 * shutdown wrote `{"version":1,"runs":[]}`. The panel's index was wiped repeatedly while the skills
 * themselves (and every session log) stayed on disk. This script reconstructs an index entry per
 * creation session — id, kind, status, timings, stage and a few step samples.
 *
 * What it CANNOT rebuild: the evaluation score, the itemised deductions and the run report. Those
 * lived only in memory and never reached the session log. Recovered records say so in their steps.
 *
 * Usage:  node scripts/recover-runs.mjs [--dry-run]
 * Safe by construction: reads logs, writes ONE data file (`runs.json`) using the same
 * temp+rename+backup+union discipline as the runner. Never touches plugin source, never starts a
 * run, never toggles a bundle. Idempotent: re-running adds nothing and never shrinks the file.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Windows absolute paths must go through pathToFileURL: the ESM loader rejects a bare `D:\…`.
const load = (rel) => import(pathToFileURL(path.join(HERE, '..', 'src', 'core', rel)).href);
const { cacheRoot, CREATORS } = await load('creators.mjs');
const { phasesFor, detectStage } = await load('runner.mjs');

const DRY_RUN = process.argv.includes('--dry-run');
const MAX_RUNS = 20;
const RESTORED_NOTE = '从会话日志恢复（评测得分与报告不可重建）';

const cacheDir = cacheRoot();
const runsFile = path.join(cacheDir, 'runs.json');
const backupFile = path.join(cacheDir, 'runs.manual-before-restart.json');
/**
 * Our own snapshot of everything recovered. The plugin process that is *currently* running may
 * still carry the old `disposeAll()` (clear-then-flush), so the next DSH shutdown can empty
 * `runs.json` one more time. This file is never touched by the plugin, so re-running this script
 * after such a shutdown restores the whole index from here.
 */
const snapshotFile = path.join(cacheDir, 'runs.recovered.json');

/** The log is several concatenated zstd frames; the sync decoder returns only the first. */
function decodeEvents(file) {
  const buf = fs.readFileSync(file);
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const offsets = [];
  let cursor = 0;
  while (true) {
    const found = buf.indexOf(magic, cursor);
    if (found < 0) break;
    offsets.push(found);
    cursor = found + 4;
  }
  let text = '';
  for (let i = 0; i < offsets.length; i++) {
    const slice = buf.subarray(offsets[i], i + 1 < offsets.length ? offsets[i + 1] : buf.length);
    try { text += zlib.zstdDecompressSync(slice).toString('utf8'); } catch { /* skip a damaged frame */ }
  }
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* a partially written last line */ }
  }
  return events;
}

function readRecords(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed && parsed.runs) ? parsed.runs.filter((r) => r && r.id) : [];
  } catch { return []; }
}

const textOf = (value) => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).join('\n');
  if (value && typeof value === 'object') return textOf(value.text ?? value.content ?? '');
  return '';
};
/** A user message is logged with its fields spread onto `data` (so `data.content`, not `data.message.content`). */
const userText = (event) => textOf(event && event.data && (event.data.content ?? (event.data.message && event.data.message.content)));

const sessionsRoot = path.join(os.homedir(), '.dsh', 'sessions');
const sessionDirs = [];
const walk = (dir, depth) => {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    const log = path.join(full, 'session.v4.jsonl.zstd');
    if (fs.existsSync(log)) sessionDirs.push({ id: entry.name, log, mtime: fs.statSync(log).mtimeMs });
    else if (depth < 2) walk(full, depth + 1);
  }
};
walk(sessionsRoot, 0);

/** Kind of a creation run. The handoff is the most precise source: it names the creator skill. */
function kindOf(blob) {
  const creator = blob.match(/Creator skill id:\s*([a-z0-9-]+)/i);
  if (creator) {
    for (const [kind, spec] of Object.entries(CREATORS)) if (spec.skill === creator[1]) return kind;
  }
  const byDir = blob.match(/dsh-skill-creator-cache[\\/](huawei|generic|api)[\\/]/i);
  if (byDir) return byDir[1].toLowerCase();
  for (const [kind, spec] of Object.entries(CREATORS)) if (blob.includes(spec.skill)) return kind;
  return null;
}

const recovered = [];
const skipped = [];
for (const dir of sessionDirs) {
  let events;
  try { events = decodeEvents(dir.log); } catch (error) { skipped.push([dir.id, 'unreadable: ' + error.message]); continue; }
  if (!events.length) { skipped.push([dir.id, 'empty log']); continue; }
  const header = events.find((e) => e.type === 'session') || {};
  if ((header.delegationDepth || 0) > 0) { skipped.push([dir.id, 'subagent session']); continue; }
  const title = textOf((events.find((e) => e.type === 'session/title') || {}).data?.title);
  const users = events.filter((e) => e.type === 'user/message');
  const firstUser = users.length ? userText(users[0]) : '';
  const handoff = `${title}\n${users.map(userText).join('\n')}`;
  if (/技能评测员/.test(handoff)) { skipped.push([dir.id, 'evaluation session']); continue; }
  // Our creation prompt is the signature: nothing else in this profile carries all three.
  if (!/Creator skill id:/.test(handoff) || !/Create the skill at|under `/.test(handoff)) {
    skipped.push([dir.id, 'not a creation run']);
    continue;
  }
  const kind = kindOf(handoff) || kindOf(textOf(events.find((e) => e.type === 'request/header')?.data));
  if (!kind) { skipped.push([dir.id, 'kind undetermined']); continue; }

  const times = events.map((e) => Number(e.time || e.createdAt || 0)).filter((t) => t > 0);
  const startedAt = Number(header.createdAt || times[0] || dir.mtime);
  const updatedAt = times.length ? Math.max(...times) : dir.mtime;
  const lastTurnEnd = [...events].reverse().find((e) => e.type === 'turn/end');
  const reason = lastTurnEnd && lastTurnEnd.data && lastTurnEnd.data.reason ? lastTurnEnd.data.reason.kind : null;
  const status = reason === 'completed' ? 'done' : reason === 'error' || reason === 'aborted' ? 'failed' : 'interrupted';

  const blob = (title + '\n' + firstUser + '\n' + events.filter((e) => e.type === 'assistant/message').map((e) => textOf(e.data && e.data.message && e.data.message.content)).join('\n')).slice(-200000);
  const phase = status === 'done' ? phasesFor(kind).length : (detectStage(kind, blob) || null);
  // The handoff carries the collected requirements; recover whatever it actually stated.
  const field = (label) => {
    const found = handoff.match(new RegExp(`(?:^|\\n)[-*\\s]*${label}\\s*[:：]\\s*([^\\n]+)`));
    return found ? found[1].trim() : '';
  };
  const targetMatch = firstUser.match(/Create the skill at `([^`]+)`/);
  const repoPath = field('Repository path');
  const target = targetMatch ? targetMatch[1] : (repoPath && header.cwd ? path.join(header.cwd, repoPath) : null);
  // A generic/API run declares no name: the directory is the creator's own choice. Recover it the
  // way the runner does — from the paths the agent wrote, then the deepest ancestor with a
  // SKILL.md on disk. Without this the `Create the skill under …\skills` wording yields "skills".
  const writtenPaths = [];
  const workspace = String(header.cwd || '').toLowerCase();
  for (const event of events) {
    const raw = JSON.stringify(event);
    for (const match of raw.matchAll(/"(?:file_path|path|dir)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
      const abs = match[1].replace(/\\\\/g, '\\');
      if (!/^[A-Za-z]:\\|^\//.test(abs)) continue;
      // Only the workspace counts: the creator's own SKILL.md lives in the cache under %TEMP%,
      // and it would otherwise be mistaken for the skill this run created.
      if (workspace && !abs.toLowerCase().startsWith(workspace)) continue;
      if (!writtenPaths.includes(abs)) writtenPaths.push(abs);
    }
  }
  const findSkillDir = (candidates) => {
    for (const candidate of [...new Set(candidates)].sort((a, b) => b.length - a.length)) {
      let dir = path.dirname(candidate);
      for (let hop = 0; hop < 8 && dir && dir.length > 3; hop++) {
        try { if (fs.existsSync(path.join(dir, 'SKILL.md'))) return dir; } catch { /* keep walking */ }
        const up = path.dirname(dir);
        if (up === dir) break;
        dir = up;
      }
    }
    return null;
  };
  const discovered = findSkillDir(writtenPaths);
  const domain = field('一级目录 \\(domain\\)');
  const product = field('二级目录 \\(product\\)');
  const description = field('(?:技能功能描述|功能概括) \\(description\\)').slice(0, 300);
  const declared = field('Skill name');
  const fromTarget = target && path.basename(target) !== 'skills' ? path.basename(target) : '';
  const skillName = declared
    || (discovered ? path.basename(discovered) : '')
    || fromTarget
    || (description ? description.split('\n')[0].slice(0, 40) : '')
    || '(未命名)';
  const finalTarget = fromTarget ? target : (discovered || target);
  const creatorLine = handoff.match(/Creator skill id:\s*([a-z0-9-]+)\s*\(([^@)]*)@([0-9a-f]{6,})/i);

  const sample = (event) => ({
    at: Number(event.time || startedAt),
    kind: 'info',
    text: `[${event.type}] ${JSON.stringify(event.data === undefined ? {} : event.data).replace(/\s+/g, ' ').slice(0, 140)}`,
  });
  const steps = [
    { at: startedAt, kind: 'info', text: RESTORED_NOTE },
    { at: startedAt, kind: 'info', text: `会话 ${dir.id} · 事件 ${events.length} 条 · 最后事件 ${new Date(updatedAt).toLocaleString()}` },
    ...events.slice(0, 3).map(sample),
    ...events.slice(-3).map(sample),
  ];

  recovered.push({
    steps,
    id: dir.id,
    sessionId: dir.id,
    kind,
    creator: creatorLine ? creatorLine[1] : (CREATORS[kind] ? CREATORS[kind].skill : null),
    commit: creatorLine ? creatorLine[3] : null,
    spec: { mode: kind, name: String(skillName).trim(), description, ...(domain ? { domain } : {}), ...(product ? { product } : {}) },
    cwd: header.cwd || '',
    target: finalTarget,
    agentPreset: header.agentPreset || 'standard',
    permission: { preset: '(恢复)', sandbox: '(未知)', approval: 'never' },
    status,
    phase,
    phases: phasesFor(kind).map((p) => ({
      ...p,
      state: status === 'done' || (phase !== null && p.id < phase) ? 'done' : p.id === phase ? 'active' : 'pending',
    })),
    startedAt,
    updatedAt,
    round: 0,
    maxEvalRounds: 3,
    passScore: 8.5,
    verdict: null,
    score: null,
    dimensions: null,
    itemScores: null,
    deductions: [],
    checks: null,
    metrics: null,
    baseline: null,
    evaluations: [],
    report: null,
    restored: true,
  });
}

// ── union: existing records win (they carry the real score/report/steps) ────────────────
const existing = [...readRecords(runsFile), ...readRecords(backupFile), ...readRecords(snapshotFile)];
const byId = new Map();
for (const record of existing) if (!byId.has(record.id)) byId.set(record.id, record);
const added = [];
for (const record of recovered) {
  if (byId.has(record.id)) continue;
  byId.set(record.id, record);
  added.push(record);
}

const runs = [...byId.values()]
  .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
const dropped = runs.length > MAX_RUNS ? runs.slice(MAX_RUNS) : [];
const kept = runs.slice(0, MAX_RUNS);

if (!DRY_RUN && kept.length) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const payload = `${JSON.stringify({ version: 1, runs: kept }, null, 1)}\n`;
  const writeAtomic = (file) => {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, payload);
    try { if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`); } catch { /* best effort */ }
    fs.renameSync(tmp, file);
  };
  writeAtomic(runsFile);
  // Never touched by the plugin: the recovery survives one more clear-then-flush shutdown.
  fs.writeFileSync(snapshotFile, payload);
}

console.log(`\n扫描 ${sessionDirs.length} 个会话目录，识别出 ${recovered.length} 个创建 run`);
const existingIds = new Set(existing.map((r) => r.id));
console.log(`已有记录 ${existingIds.size} 条（runs.json / 备份 / 快照去重后），本次新增 ${added.length} 条${DRY_RUN ? '（--dry-run：未写盘）' : ''}`);
console.log('\n新增：');
if (!added.length) console.log('  （无）');
for (const r of added.sort((a, b) => b.startedAt - a.startedAt)) {
  console.log(`  + ${r.id}  [${r.kind}] ${r.status}  ${new Date(r.startedAt).toLocaleString()}  phase=${r.phase ?? '-'}  ${r.spec.name}`);
}
console.log('\n已在记录中，跳过：');
const have = recovered.filter((r) => !added.includes(r));
if (!have.length) console.log('  （无）');
for (const r of have) console.log(`  = ${r.id}  [${r.kind}] ${r.status}  ${r.spec.name}`);
if (skipped.length) {
  console.log('\n未识别为创建 run 的会话：');
  for (const [id, why] of skipped) console.log(`  - ${id}  ${why}`);
}
if (dropped.length) {
  console.log(`\n⚠ 超过上限 ${MAX_RUNS}，以下最旧的记录未写入：${dropped.map((r) => r.id).join(', ')}`);
}
console.log(`\n写入 ${kept.length} 条 -> ${runsFile}`);
