/**
 * Live catalogue of the official Huawei Cloud skills repository.
 *
 * Source of truth: https://gitcode.com/huaweicloud/huaweicloud-skills/tree/master/skills
 * Read through the Gitee-style contents API (the GitLab-style /api/v4 tree route
 * returns 404 on this host):
 *   GET https://gitcode.com/api/v5/repos/<repo>/contents/<path>?ref=<ref>
 *
 * The taxonomy is three directory levels — domain / product / skill — and the skill
 * names are NOT always `huawei-cloud-<product>-…` (computing/flexus-x holds
 * `huawei-cloud-ecs-dsh-deploy`), so the caller must treat level 3 as free-form.
 *
 * The public API rate-limits bursts (HTTP 429), therefore:
 *   - every path is cached in memory for `ttlMs` (default 10 min),
 *   - the UI walks one level at a time instead of pre-fetching the whole tree,
 *   - a failed refresh serves the stale cache, then an optional local clone.
 */
import fs from 'node:fs';
import path from 'node:path';

const API = 'https://gitcode.com/api/v5/repos';

/** Normalise a response entry to `{ name, type: 'dir' | 'file' }`. */
function entryOf(name, type) {
  return { name, type: type === 'dir' || type === 'tree' ? 'dir' : 'file' };
}

/** Directories first, then files; each alphabetically (stable UI order). */
function sorted(entries) {
  return entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
}

export function createCatalog(config = {}) {
  const repo = config.repo || 'huaweicloud/huaweicloud-skills';
  const ref = config.ref || 'master';
  const root = (config.root || 'skills').replace(/\/+$/, '');
  const localDir = config.localDir || '';
  const ttlMs = Number(config.ttlMs) || 10 * 60 * 1000;
  const timeoutMs = Number(config.timeoutMs) || 15000;
  const cache = new Map();

  /** Reject anything that is not inside `root` (no traversal, no absolute paths). */
  function checkPath(rel) {
    const clean = String(rel || root).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (clean !== root && !clean.startsWith(`${root}/`)) throw new Error(`path outside ${root}: ${clean}`);
    if (clean.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) throw new Error(`invalid path: ${clean}`);
    return clean;
  }

  async function fromRemote(rel) {
    const url = `${API}/${repo}/contents/${rel.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'dsh-skill-creator' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const hint = res.status === 429 ? 'gitcode 限流（HTTP 429），请稍后重试' : `gitcode HTTP ${res.status}`;
      throw new Error(hint);
    }
    const json = await res.json();
    if (!Array.isArray(json)) throw new Error('gitcode: unexpected payload');
    return sorted(json.map((e) => entryOf(e.name, e.type)));
  }

  function fromLocal(rel) {
    const dir = path.join(localDir, rel);
    return sorted(fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.'))
      .map((e) => entryOf(e.name, e.isDirectory() ? 'dir' : 'file')));
  }

  /**
   * List one directory level.
   * @param rel - repository-relative path, e.g. `skills` or `skills/computing`.
   * @param options.refresh - bypass the TTL and ask the remote again.
   * @returns `{ path, entries, source, fetchedAt, cached, stale?, error? }`.
   */
  async function list(rel = root, options = {}) {
    const clean = checkPath(rel);
    const hit = cache.get(clean);
    if (!options.refresh && hit && Date.now() - hit.fetchedAt < ttlMs) return { ...hit, cached: true };
    try {
      const record = { path: clean, entries: await fromRemote(clean), source: 'gitcode', fetchedAt: Date.now() };
      cache.set(clean, record);
      return record;
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      if (hit) return { ...hit, cached: true, stale: true, error: message };
      if (localDir) {
        try {
          const record = { path: clean, entries: fromLocal(clean), source: 'local', fetchedAt: Date.now(), error: message };
          cache.set(clean, record);
          return record;
        } catch { /* fall through to the remote error */ }
      }
      throw new Error(message);
    }
  }

  return {
    list,
    describe: () => ({ repo, ref, root, localDir: localDir || null, ttlMs, cachedPaths: [...cache.keys()] }),
  };
}
