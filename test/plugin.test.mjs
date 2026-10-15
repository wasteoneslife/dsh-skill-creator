import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../src/core/plugin.mjs';
import { CREATORS, cacheRoot, creatorDir } from '../src/core/creators.mjs';
import { API_BASE } from '../src/core/routes.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

// Seed a fresh creator cache so the provider can list without touching the network.
process.env.DSH_SKILL_CREATOR_CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'dsc-plugin-'));
for (const [kind, spec] of Object.entries(CREATORS)) {
  const dir = creatorDir(kind);
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'),
    `---\nname: ${spec.skill}\ndescription: |\n  1. First line.\n  Triggers include: "create skill".\n---\n`);
  fs.writeFileSync(path.join(cacheRoot(), kind, 'stamp.json'), JSON.stringify({
    kind, skill: spec.skill, repo: spec.repo, branch: spec.branch, path: spec.path, commit: 'cafebabe1234', fetchedAt: Date.now(),
  }));
}

/** Host ctx stub: skills + webServer + agents + default model + event bus. */
function hostCtx() {
  const captured = { provider: null, route: null, agent: null, listeners: [] };
  const ctx = {
    // apply() now loads its core modules through cache-busted dynamic imports, so the
    // effect callback is async: its promise resolves to the disposer Cordis collects.
    effect(fn, label) {
      captured.effectLabel = label;
      captured.settled = Promise.resolve(fn()).then((dispose) => { captured.dispose = dispose; return dispose; });
      return () => {};
    },
    on(event, listener) { captured.listeners.push({ event, listener }); return () => {}; },
    // Declared dependencies are guaranteed present, so the plugin uses them directly.
    webServer: { register: (route) => { captured.route = route; return () => {}; } },
    get(name) {
      if (name === 'skills') return { registerProvider: (create) => { captured.provider = create({ invalidate() {} }); return () => {}; } };
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) };
      // The preset installs the tool set; the runner resolves and mounts it through setup.
      if (name === 'agentPresets') return { async resolve(id) { return { id: id || 'standard' }; }, async mount() {} };
      if (name === 'agents') {
        return {
          async create(options) {
            const agent = {
              id: 'sess-plugin-1', options, sent: null,
              followup(message) { agent.sent = message; },
              whenIdle: () => new Promise(() => {}),
              cancel() {},
            };
            captured.agent = agent;
            return { agent, dispose: async () => {} };
          },
        };
      }
      return undefined;
    },
  };
  return { ctx, captured };
}

function fakeReq(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  return { method, url, headers: { host: '127.0.0.1' }, async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; } };
}
function fakeRes() {
  const res = { status: 0, payload: '', writeHead(code) { res.status = code; }, end(p) { res.payload = p ?? ''; } };
  return res;
}
const call = async (route, method = 'GET', body) => {
  const res = fakeRes();
  await route.handler(fakeReq(method, `${API_BASE}${route.tmpPath}`, body), res);
  return { status: res.status, body: JSON.parse(res.payload) };
};

describe('host wiring: creator skills + panel API + real run', () => {
  test('declare the services it uses instead of hoping they are ready', async () => {
    const mod = await import('../src/core/plugin.mjs');
    // A one-shot ctx.get('webServer') silently registers nothing when this plugin
    // activates first; the declaration is what makes the loader wait (shipped host
    // plugins do the same: dsh-host-open-in-app exports `inject`).
    assert.deepEqual([...mod.inject].sort(), ['skills', 'webServer']);
    const source = (await import('node:fs')).readFileSync(path.join(ROOT, 'src/core/plugin.mjs'), 'utf8');
    assert.match(source, /ctx\.webServer\.register\(/);
    assert.doesNotMatch(source, /const webServer = ctx\.get\('webServer'\)/);
  });

  test('apply() registers the skill provider and the same-origin API route', async () => {
    const { ctx, captured } = hostCtx();
    apply(ctx, {});
    await captured.settled;
    assert.equal(captured.provider.name, 'dsh-skill-creator:creators');
    assert.equal(captured.route.kind, 'prefix');
    assert.equal(captured.route.path, API_BASE);
    assert.equal(typeof captured.route.handler, 'function');

    // the provider exposes both creators as loadable skills
    const listed = await captured.provider.list();
    assert.deepEqual(listed.candidates.map((c) => c.name).sort(), ['common-skill-creator', 'huawei-cloud-skill-creator', 'rest-api-skill-creator']);
    const first = listed.candidates[0];
    assert.equal(first.resourceBase.kind, 'directory');
    assert.ok(first.resourceBase.path.endsWith(first.locator.kind === 'huawei' ? 'huawei-cloud-skill-creator' : first.locator.kind === 'api' ? 'rest-api-skill-creator' : 'common-skill-creator'));
    const full = await captured.provider.get(first);
    assert.match(full.content, /^---/);
  });

  test('the API drives a real agent run through the same handler the panel uses', async () => {
    const { ctx, captured } = hostCtx();
    apply(ctx, {});
    await captured.settled;
    const route = captured.route;

    const status = await (async () => { route.tmpPath = '/status'; return call(route); })();
    assert.equal(status.body.ok, true);
    assert.ok(status.body.creators.huawei, 'creator status is exposed to the panel');

    route.tmpPath = '/run';
    const started = await call(route, 'POST', { spec: { mode: 'huawei', name: 'huawei-cloud-ecs-manage', domain: 'computing', product: 'ecs', summary: 'Manage ECS' } });
    assert.equal(started.status, 200);
    assert.equal(started.body.run.status, 'creating');
    // The lifecycle is data, so the panel can render the evaluation state without asking.
    assert.equal(started.body.run.round, 0);
    assert.equal(started.body.run.passScore, 8.5);
    assert.equal(started.body.run.maxEvalRounds, 3);
    assert.equal(started.body.run.creator, 'huawei-cloud-skill-creator');
    assert.equal(started.body.run.commit, 'cafebabe1234');
    assert.equal(started.body.run.phases.length, 6);
    // the agent really received the creator request, with the profile's default route
    assert.equal(captured.agent.options.agentOptions.model, 'deepseek-flash');
    assert.match(captured.agent.sent.content[0].text, /huawei-cloud-skill-creator/);

    const id = started.body.run.id;
    route.tmpPath = `/run?id=${id}`;
    const polled = await call(route);
    assert.equal(polled.body.run.id, id);
    assert.ok(polled.body.run.steps.length >= 1, 'the run log starts with a start line');

    route.tmpPath = '/cancel';
    const cancelled = await call(route, 'POST', { id });
    assert.equal(cancelled.body.ok, true);
    assert.equal(cancelled.body.run.status, 'cancelled');

    // one effect owns the whole registration, and disposal unwinds it
    assert.equal(captured.effectLabel, 'dsh-skill-creator: creator skills + panel API');
    assert.equal(typeof captured.dispose, 'function');
    captured.dispose();
  });
});
