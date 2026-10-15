import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { API_BASE, createApiHandler } from '../src/core/routes.mjs';

/** Minimal IncomingMessage: just enough for the handler (URL, method, async body). */
function fakeReq(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  return {
    method,
    url,
    headers: { host: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk; },
  };
}

/** Minimal ServerResponse capturing the reply. */
function fakeRes() {
  const res = {
    status: 0,
    headers: null,
    payload: '',
    writeHead(code, headers) { res.status = code; res.headers = headers; },
    end(payload) { res.payload = payload ?? ''; },
  };
  return res;
}

const json = (res) => JSON.parse(res.payload);

describe('panel API (in-host routes)', () => {
  const calls = [];
  const runner = {
    async start(spec) { calls.push(['start', spec]); return { id: 'run-1' }; },
    get(id) { return id === 'run-1' ? { id: 'run-1', status: 'running', phases: [], steps: [] } : null; },
    list() { return [{ id: 'run-1', status: 'running' }]; },
    async cancel(id) { calls.push(['cancel', id]); return id === 'run-1'; },
  };
  const catalog = {
    describe: () => ({ repo: 'huaweicloud/huaweicloud-skills', ref: 'master', root: 'skills' }),
    async list(rel) { return { path: rel || 'skills', entries: [{ name: 'computing', type: 'dir' }], source: 'gitcode' }; },
  };
  const handler = createApiHandler({ runner, catalog });

  const call = async (method, route, body) => {
    const res = fakeRes();
    await handler(fakeReq(method, `${API_BASE}${route}`, body), res);
    return res;
  };

  test('GET /status reports the catalog and the creators', async () => {
    const res = await call('GET', '/status');
    assert.equal(res.status, 200);
    const body = json(res);
    assert.equal(body.ok, true);
    assert.equal(body.catalog.root, 'skills');
    assert.ok(body.creators && body.creators.huawei, 'creator status must be included');
    assert.equal(res.headers['Cache-Control'], 'no-store');
  });

  test('GET /catalog reads one live level', async () => {
    const res = await call('GET', '/catalog?path=skills');
    assert.equal(res.status, 200);
    assert.deepEqual(json(res).entries, [{ name: 'computing', type: 'dir' }]);
  });

  test('POST /run starts a run with the collected spec', async () => {
    const spec = { mode: 'huawei', name: 'huawei-cloud-ecs-manage' };
    const res = await call('POST', '/run', { spec });
    assert.equal(res.status, 200);
    assert.equal(json(res).run.id, 'run-1');
    assert.deepEqual(calls.at(-1), ['start', spec]);
  });

  test('GET /run returns one run or the list', async () => {
    assert.equal(json(await call('GET', '/run?id=run-1')).run.id, 'run-1');
    assert.equal(json(await call('GET', '/run')).runs.length, 1);
    const missing = await call('GET', '/run?id=nope');
    assert.equal(missing.status, 404);
    assert.match(json(missing).error, /unknown run/);
  });

  test('POST /cancel reports whether the run existed', async () => {
    assert.equal((await call('POST', '/cancel', { id: 'run-1' })).status, 200);
    assert.equal((await call('POST', '/cancel', { id: 'nope' })).status, 404);
  });

  test('unknown routes and thrown handlers stay JSON, never a stack trace', async () => {
    const unknown = await call('GET', '/nope');
    assert.equal(unknown.status, 404);
    assert.match(json(unknown).error, /unknown route/);

    const boom = createApiHandler({ runner: { async start() { throw new Error('agent create failed'); } }, catalog });
    const res = fakeRes();
    await boom(fakeReq('POST', `${API_BASE}/run`, { spec: {} }), res);
    assert.equal(res.status, 500);
    assert.match(json(res).error, /agent create failed/);
  });
});
