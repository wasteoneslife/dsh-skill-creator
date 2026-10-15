/**
 * In-host HTTP API for the handoff panel.
 *
 * Registered on `ctx.webServer` (verified: `register({kind, path, handler})`, handler is
 * `(req, res) => void | Promise<void>`), so the API runs INSIDE the Harness host process
 * and can drive agents, skills and the live catalog directly. Consequences:
 *   - same-origin requests from the panel: no port, no CORS, no auth juggling
 *   - no long-lived child process holding stale JavaScript
 */
import { CREATORS, buildHandoff as defaultBuildHandoff, fetchCreator, kindOfMode, status } from './creators.mjs';
import { validateSkillPackage, summarize } from './validators.mjs';

export const API_BASE = '/dsh-skill-creator/api';

/**
 * Bumped whenever this module's behaviour changes; reported by `GET /status`. That turns
 * "did the reload actually pick up my edit?" into a one-request check instead of a guess —
 * a stale dependency module is otherwise completely silent.
 */
export const API_REVISION = 'r6';

function send(res, code, body, type = 'application/json; charset=utf-8') {
  const payload = type.startsWith('application/json') ? JSON.stringify(body) : body;
  res.writeHead(code, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Build the handler for one prefix route. */
export function createApiHandler({ runner, catalog, buildHandoff = defaultBuildHandoff }) {
  return async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const route = url.pathname.slice(API_BASE.length) || '/';
    try {
      if (route === '/status') {
        return send(res, 200, {
          ok: true,
          revision: API_REVISION,
          catalog: catalog.describe(),
          creators: Object.fromEntries(Object.keys(CREATORS).map((kind) => [kind, status(kind)])),
        });
      }
      if (route === '/catalog') {
        const rel = url.searchParams.get('path') || undefined;
        const refresh = url.searchParams.get('refresh') === '1';
        try {
          return send(res, 200, { ok: true, ...(await catalog.list(rel, { refresh })) });
        } catch (error) {
          return send(res, 503, { ok: false, error: error.message, catalog: catalog.describe() });
        }
      }
      if (route === '/creator') {
        const kind = kindOfMode(url.searchParams.get('mode') || 'huawei');
        const refresh = url.searchParams.get('refresh') === '1';
        try {
          const current = refresh || !status(kind).present ? await fetchCreator(kind, { refresh }) : status(kind, { fetched: false });
          return send(res, 200, { ok: true, ...current });
        } catch (error) {
          return send(res, 503, { ok: false, error: error.message, ...status(kind) });
        }
      }
      if (route === '/handoff' && req.method === 'POST') {
        const { spec } = await readJson(req);
        const kind = kindOfMode(spec && spec.mode);
        return send(res, 200, { ok: true, kind, creator: status(kind), prompt: buildHandoff(kind, spec || {}) });
      }
      if (route === '/run' && req.method === 'POST') {
        const { spec } = await readJson(req);
        const run = await runner.start(spec || {});
        return send(res, 200, { ok: true, run: runner.get(run.id) });
      }
      if (route === '/run' && req.method === 'GET') {
        const id = url.searchParams.get('id');
        if (id) {
          const run = runner.get(id);
          return run ? send(res, 200, { ok: true, run }) : send(res, 404, { ok: false, error: `unknown run: ${id}` });
        }
        return send(res, 200, { ok: true, runs: runner.list() });
      }
      if (route === '/cancel' && req.method === 'POST') {
        const { id } = await readJson(req);
        const cancelled = await runner.cancel(id);
        return send(res, cancelled ? 200 : 404, { ok: cancelled, run: runner.get(id) });
      }
      if (route === '/validate' && req.method === 'POST') {
        const { path: pkgPath, mode = 'huawei', editMode = false } = await readJson(req);
        const result = validateSkillPackage(pkgPath, { mode, editMode });
        return send(res, 200, { ok: true, issues: result.issues, summary: summarize(result.issues), stats: result.stats });
      }
      return send(res, 404, { ok: false, error: `unknown route: ${route}` });
    } catch (error) {
      return send(res, 500, { ok: false, error: String((error && error.message) || error) });
    }
  };
}
