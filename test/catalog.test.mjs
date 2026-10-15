import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCatalog } from '../src/core/catalog.mjs';

/** Run `body` with `globalThis.fetch` replaced, restoring it afterwards. */
async function withFetch(stub, body) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await body(); } finally { globalThis.fetch = original; }
}

describe('live repository catalogue (gitcode contents API)', () => {
  test('refuses paths outside the configured root', async () => {
    const catalog = createCatalog({ repo: 'x/y', ref: 'master', root: 'skills' });
    await assert.rejects(() => catalog.list('other/dir'), /path outside skills/);
    await assert.rejects(() => catalog.list('skills/../etc'), /invalid path/);
    await assert.rejects(() => catalog.list('skills//x'), /invalid path/);
  });

  test('reads a level, exposes its source, and caches within the TTL', async () => {
    let calls = 0;
    const catalog = createCatalog({ repo: 'x/y', ref: 'master', root: 'skills' });
    await withFetch(async () => {
      calls++;
      return { ok: true, json: async () => [{ name: 'zebra', type: 'dir' }, { name: 'ai', type: 'dir' }, { name: 'README.md', type: 'file' }] };
    }, async () => {
      const first = await catalog.list('skills');
      assert.equal(first.source, 'gitcode');
      assert.equal(first.cached, undefined);
      // directories first (alphabetical), then files
      assert.deepEqual(first.entries.map((e) => e.name), ['ai', 'zebra', 'README.md']);
      assert.deepEqual(first.entries.map((e) => e.type), ['dir', 'dir', 'file']);
      const second = await catalog.list('skills');
      assert.equal(second.cached, true);
      assert.equal(calls, 1, 'a second read inside the TTL must not hit the API');
    });
  });

  test('falls back to a local clone when the API is unreachable', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-catalog-'));
    fs.mkdirSync(path.join(dir, 'skills', 'computing', 'ecs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'skills', 'README.md'), '# tree\n');
    try {
      const catalog = createCatalog({ repo: 'x/y', ref: 'master', root: 'skills', localDir: dir });
      const level = await withFetch(() => { throw new Error('offline'); }, () => catalog.list('skills'));
      assert.equal(level.source, 'local');
      assert.deepEqual(level.entries.map((e) => e.name), ['computing', 'README.md']);
      assert.equal(level.entries[0].type, 'dir');
      assert.match(String(level.error), /offline/);
      const leaf = await catalog.list('skills/computing');
      assert.deepEqual(leaf.entries.map((e) => e.name), ['ecs']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('serves the stale cache when a forced refresh is rate-limited', async () => {
    const catalog = createCatalog({ repo: 'x/y', ref: 'master', root: 'skills' });
    await withFetch(async () => ({ ok: true, json: async () => [{ name: 'computing', type: 'dir' }] }),
      () => catalog.list('skills'));
    const stale = await withFetch(async () => ({ ok: false, status: 429 }),
      () => catalog.list('skills', { refresh: true }));
    assert.equal(stale.stale, true);
    assert.equal(stale.cached, true);
    assert.equal(stale.source, 'gitcode');
    assert.deepEqual(stale.entries.map((e) => e.name), ['computing']);
    assert.match(stale.error, /429/);
  });

  test('reports the remote error when there is no cache and no local clone', async () => {
    const catalog = createCatalog({ repo: 'x/y', ref: 'master', root: 'skills' });
    await withFetch(async () => ({ ok: false, status: 404 }),
      async () => { await assert.rejects(() => catalog.list('skills'), /HTTP 404/); });
  });

  test('describes its configuration', () => {
    const described = createCatalog({ repo: 'a/b', ref: 'dev', root: 'skills', localDir: 'D:/clone' }).describe();
    assert.equal(described.repo, 'a/b');
    assert.equal(described.ref, 'dev');
    assert.equal(described.localDir, 'D:/clone');
  });
});
