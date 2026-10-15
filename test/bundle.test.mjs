import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const readPkg = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

describe('DSH bundle contract (cordis-plugin-development)', () => {
  test('package.json declares dsh.bundle.patch → existing cordis.patch.yml', () => {
    const pkg = readPkg();
    assert.ok(pkg.dsh.bundle.patch, 'dsh.bundle.patch missing');
    assert.ok(fs.existsSync(path.join(ROOT, pkg.dsh.bundle.patch)), 'patch file missing');
    assert.equal(pkg.name, '@cloudplugin/dsh-skill-creator');
  });

  test('dsh.client declares web platform + conversation inject (composer dock owner)', () => {
    const pkg = readPkg();
    assert.equal(pkg.dsh.client.platform, 'web');
    assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-conversation'));
  });

  test('exports ./client points at an existing client module', () => {
    const pkg = readPkg();
    assert.ok(fs.existsSync(path.join(ROOT, pkg.exports['./client'])), 'client file missing');
  });

  test('cordis.patch.yml inserts a row named after the package', () => {
    const pkg = readPkg();
    const patch = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8');
    assert.ok(patch.includes('- insert:'), 'patch has no insert block');
    assert.ok(patch.includes(`name: '${pkg.name}'`), `patch row must reference ${pkg.name}`);
    const ids = [...patch.matchAll(/id: ([a-z0-9-]+)/g)].map((m) => m[1]);
    assert.ok(ids.length >= 1, 'patch inserts at least one row');
  });

  test('host half exports apply(ctx, config) only (no export-form mixing)', async () => {
    const mod = await import(pathToFileURL(path.join(ROOT, 'src/core/plugin.mjs')).href);
    assert.equal(typeof mod.apply, 'function', 'apply must be a function');
    assert.ok(!('default' in mod), 'do not mix export forms (apply + default)');
    // The host export form may carry a hard-dependency list; both services are used.
    assert.ok(Array.isArray(mod.inject), 'declare the services the host half needs');
    assert.deepEqual([...mod.inject].sort(), ['skills', 'webServer']);
    const ctx = { on: () => {}, effect: () => () => {}, get: () => undefined, webServer: { register: () => () => {} } };
    assert.doesNotThrow(() => mod.apply(ctx, { catalog: { root: 'skills' }, run: {} }));
    // No child engine and no listening port any more: the API lives on ctx.webServer.
    const source = fs.readFileSync(path.join(ROOT, 'src/core/plugin.mjs'), 'utf8');
    assert.ok(!/child_process|spawn\(/.test(source), 'the host half must not spawn a child engine');
    assert.ok(source.includes('ctx.webServer.register('), 'the panel API must be served from the host process');
  });

  test('client factory: id == package name, inject slots, registers its own panel', () => {
    const pkg = readPkg();
    const code = fs.readFileSync(path.join(ROOT, 'src/client.js'), 'utf8');
    assert.ok(code.includes(`id: '${pkg.name}'`), `client id must equal package name ${pkg.name}`);
    assert.ok(code.includes("inject: ['slots']"), "factory must declare inject: ['slots']");
    assert.ok(code.includes("ctx.slots.inject('main'"), 'panel must register into the main keyed slot');
    assert.ok(code.includes("ctx.slots.inject('sidebar.panellist'"), 'panel must expose a sidebar entry');
    assert.ok(!code.includes("'conversation.composer.dock'"),
      'the composer dock is ambient space; a full page must not live there');
  });

  test('client.js is valid JS syntax', () => {
    execFileSync(process.execPath, ['--check', path.join(ROOT, 'src/client.js')], { stdio: 'pipe' });
  });

  test('no forbidden patterns in client.js (primitives / document.body / iframe)', () => {
    const code = fs.readFileSync(path.join(ROOT, 'src/client.js'), 'utf8');
    assert.ok(!/require\(['"]@deepseek-ai\/dsh-client-ui-primitives['"]\)/.test(code), 'must not import primitives (practices.md)');
    assert.ok(!code.includes('document.body'), 'must not append to document.body');
    assert.ok(!/iframe/i.test(code), 'no iframe (practices.md)');
  });
});