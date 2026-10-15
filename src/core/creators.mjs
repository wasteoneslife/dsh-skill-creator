/**
 * Creator delegation — the plugin does NOT re-implement skill generation.
 *
 * Creating a skill is the job of the two official creator skills, so the plugin only
 * (1) fetches the LATEST creator for the requested mode, (2) hands it to the agent as a
 * loadable DSH skill, and (3) turns the wizard's collected spec into a handoff request.
 * Whatever convention a creator version carries therefore always wins — no vendored
 * copy, no second implementation, no drift.
 *
 *   huawei  → gitcode.com/huaweicloud/huaweicloud-skills @ master
 *             skills/devtools/common/huawei-cloud-skill-creator
 *   generic → gitcode.com/grape-dev/grape-skills @ main
 *             skills/coding/scaffolding/common-skill-creator
 *
 * Fetch method: git sparse clone (`--depth 1 --branch --filter=blob:none --sparse`),
 * measured at 2–7 s for both repos. The repository archive route is NOT usable — it
 * answers 200 with an HTML login page — and the contents API needs ~20 requests per
 * creator and rate-limits bursts (HTTP 429), so it is only the no-git fallback.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

/** Human-readable kind label used in the handoff headline. */
export const KIND_LABEL = { huawei: 'Huawei Cloud', generic: 'generic', api: 'REST API' };

export const CREATORS = {
  huawei: {
    skill: 'huawei-cloud-skill-creator',
    repo: 'https://gitcode.com/huaweicloud/huaweicloud-skills.git',
    web: 'https://gitcode.com/huaweicloud/huaweicloud-skills/tree/master/skills/devtools/common/huawei-cloud-skill-creator',
    branch: 'master',
    path: 'skills/devtools/common/huawei-cloud-skill-creator',
    namePrefix: 'huawei-cloud-',
  },
  api: {
    skill: 'rest-api-skill-creator',
    repo: 'https://gitcode.com/grape-dev/grape-skills.git',
    web: 'https://gitcode.com/grape-dev/grape-skills/tree/main/skills/coding/scaffolding/rest-api-skill-creator',
    branch: 'main',
    path: 'skills/coding/scaffolding/rest-api-skill-creator',
    namePrefix: '',
  },
  generic: {
    skill: 'common-skill-creator',
    repo: 'https://gitcode.com/grape-dev/grape-skills.git',
    web: 'https://gitcode.com/grape-dev/grape-skills/blob/main/skills/coding/scaffolding/common-skill-creator',
    branch: 'main',
    path: 'skills/coding/scaffolding/common-skill-creator',
    namePrefix: '',
  },
};

/** `mode` in the model maps onto a creator kind; anything unknown stays Huawei-shaped. */
export function kindOfMode(mode) {
  return Object.prototype.hasOwnProperty.call(CREATORS, mode) ? mode : 'huawei';
}

const DEFAULT_TTL_MS = Number(process.env.DSH_SKILL_CREATOR_TTL_MS || 24 * 60 * 60 * 1000);

export function cacheRoot() {
  return process.env.DSH_SKILL_CREATOR_CACHE || path.join(os.tmpdir(), 'dsh-skill-creator-cache');
}
export function creatorDir(kind) {
  const spec = CREATORS[kind];
  if (!spec) throw new Error(`unknown creator kind: ${kind}`);
  return path.join(cacheRoot(), kind, spec.path);
}
function stampPath(kind) { return path.join(cacheRoot(), kind, 'stamp.json'); }

export function readStamp(kind) {
  try { return JSON.parse(fs.readFileSync(stampPath(kind), 'utf8')); } catch { return null; }
}

/** Recursive file list relative to the creator dir (for the wizard's status card). */
export function listFiles(dir) {
  const out = [];
  (function walk(current, prefix) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(current, entry.name), rel);
      else out.push({ path: rel, bytes: fs.statSync(path.join(current, entry.name)).size });
    }
  })(dir, '');
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** `true` when the creator is present and still inside its TTL. */
export function isFresh(kind, ttlMs = DEFAULT_TTL_MS) {
  const stamp = readStamp(kind);
  if (!stamp) return false;
  if (!fs.existsSync(path.join(creatorDir(kind), 'SKILL.md'))) return false;
  return Date.now() - Number(stamp.fetchedAt || 0) < ttlMs;
}

/** Clone only the creator's subtree out of the repository, then keep just that subtree. */
function sparseClone(kind, spec, log) {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-creator-${kind}-`));
  try {
    const clone = spawnSync('git', ['clone', '--depth', '1', '--branch', spec.branch, '--filter=blob:none', '--sparse', spec.repo, staging],
      { encoding: 'utf8', timeout: 180000 });
    if (clone.status !== 0) throw new Error(`git clone failed: ${(clone.stderr || clone.stdout || '').trim() || clone.status}`);
    const co = spawnSync('git', ['-C', staging, 'sparse-checkout', 'set', spec.path], { encoding: 'utf8', timeout: 120000 });
    if (co.status !== 0) throw new Error(`git sparse-checkout failed: ${(co.stderr || '').trim()}`);
    const head = spawnSync('git', ['-C', staging, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 30000 });
    const commit = (head.stdout || '').trim();
    const from = path.join(staging, spec.path);
    if (!fs.existsSync(path.join(from, 'SKILL.md'))) throw new Error(`creator not found in repository: ${spec.path}`);
    const to = creatorDir(kind);
    fs.rmSync(to, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true });
    if (log) log(`fetched ${spec.skill} @ ${commit.slice(0, 8)}`);
    return commit;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** No-git fallback: walk the repository contents API (rate-limited, ~20 requests). */
async function apiWalk(kind, spec, log) {
  const API = 'https://gitcode.com/api/v5/repos';
  const [ownerRepo] = [spec.repo.replace(/^https?:\/\/gitcode\.com\//, '').replace(/\.git$/, '')];
  const base = `${API}/${ownerRepo}/contents`;
  const walk = async (rel) => {
    const res = await fetch(`${base}/${rel.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(spec.branch)}`,
      { headers: { Accept: 'application/json', 'User-Agent': 'dsh-skill-creator' }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`gitcode ${res.status} on ${rel}`);
    const json = await res.json();
    const out = [];
    for (const entry of json) {
      if (entry.type === 'dir' || entry.type === 'tree') out.push(...await walk(entry.path));
      else if (entry.type === 'file' || entry.type === 'blob') {
        const raw = await fetch(`https://raw.gitcode.com/${ownerRepo}/raw/${encodeURIComponent(spec.branch)}/${entry.path}`,
          { signal: AbortSignal.timeout(30000) });
        if (!raw.ok) throw new Error(`raw ${raw.status} on ${entry.path}`);
        out.push({ rel: entry.path.slice(spec.path.length + 1), data: Buffer.from(await raw.arrayBuffer()) });
      }
    }
    return out;
  };
  const files = await walk(spec.path);
  const to = creatorDir(kind);
  fs.rmSync(to, { recursive: true, force: true });
  for (const file of files) {
    const dest = path.join(to, file.rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, file.data);
  }
  if (log) log(`fetched ${spec.skill} via contents API (${files.length} files)`);
  return '';
}

/**
 * Ensure the latest creator for `kind` is cached.
 * @returns `{ kind, skill, dir, commit, fetchedAt, files, fetched }`
 */
export async function fetchCreator(kind, options = {}) {
  const spec = CREATORS[kind];
  if (!spec) throw new Error(`unknown creator kind: ${kind}`);
  const { refresh = false, ttlMs = DEFAULT_TTL_MS, log } = options;
  if (!refresh && isFresh(kind, ttlMs)) return status(kind, { fetched: false });

  const gitProbe = spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 15000 });
  let commit = '';
  try {
    if (gitProbe.status === 0) commit = sparseClone(kind, spec, log);
    else commit = await apiWalk(kind, spec, log);
  } catch (error) {
    // Keep serving the previous copy rather than failing the flow.
    if (fs.existsSync(path.join(creatorDir(kind), 'SKILL.md'))) {
      return { ...status(kind, { fetched: false }), stale: true, error: error.message };
    }
    throw error;
  }
  const stamp = { kind, skill: spec.skill, repo: spec.repo, branch: spec.branch, path: spec.path, commit, fetchedAt: Date.now() };
  fs.mkdirSync(path.dirname(stampPath(kind)), { recursive: true });
  fs.writeFileSync(stampPath(kind), `${JSON.stringify(stamp, null, 2)}\n`);
  return status(kind, { fetched: true });
}

/** Cached creator status without any network access. */
export function status(kind, extra = {}) {
  const spec = CREATORS[kind];
  const dir = creatorDir(kind);
  const stamp = readStamp(kind) || {};
  const present = fs.existsSync(path.join(dir, 'SKILL.md'));
  return {
    kind,
    skill: spec.skill,
    repo: spec.repo,
    web: spec.web,
    branch: spec.branch,
    path: spec.path,
    dir,
    present,
    fresh: isFresh(kind),
    commit: stamp.commit || '',
    fetchedAt: stamp.fetchedAt || 0,
    files: present ? listFiles(dir) : [],
    ...extra,
  };
}

/**
 * The handoff request: everything the creator's Phase 1 would otherwise have to ask for,
 * phrased so the agent loads the creator skill and runs its own pipeline.
 */
export function buildHandoff(kind, spec = {}) {
  const creator = CREATORS[kind];
  if (!creator) throw new Error(`unknown creator kind: ${kind}`);
  const lines = [
    `Use the \`${creator.skill}\` skill to create a ${KIND_LABEL[kind] || kind} skill.`,
    'Follow that skill\'s own workflow end to end (do not shortcut it, and do not invent CLI commands, API paths or IAM actions).',
    '',
    'Collected requirements:',
  ];
  const push = (label, value) => { if (value !== undefined && value !== null && String(value).trim() !== '') lines.push(`- ${label}: ${value}`); };
  if (kind !== 'huawei') {
    // Generic and REST-API skills are DESCRIBED, not packaged: their creators derive the
    // name, the directory and the structure, so nothing else belongs in the handoff.
    push('技能功能描述 (description)', spec.description);
  } else {
    push('Skill name', spec.name);
    push('Repository path', spec.domain && spec.product && spec.name ? `skills/${spec.domain}/${spec.product}/${spec.name}` : '');
    push('一级目录 (domain)', spec.domain);
    push('二级目录 (product)', spec.product);
    // The panel collects one 功能概括 text: the creator derives tags, scope and packaging.
    push('功能概括 (description)', spec.description);
  }
  if (spec.name) push('Requested name', spec.name);
  if (spec.extra) lines.push('', String(spec.extra));
  lines.push('', `Creator source: ${creator.web} (branch ${creator.branch}).`);
  return lines.join('\n');
}
