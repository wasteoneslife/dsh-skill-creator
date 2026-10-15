/**
 * Host half of @cloudplugin/dsh-skill-creator.
 *
 * Three jobs, all in-process (no child engine, no port, no CORS):
 *  1. Publish the official creator skills (ctx.skills.registerProvider) so `skill(...)`
 *     loads the real creator, with its cache directory as resourceBase.
 *  2. Serve the panel API on ctx.webServer, same-origin as the Harness Web app.
 *  3. Run the skill-creation flow: create an agent, hand it the creator prompt, and turn
 *     `agent/assistant-stream` frames into a step-by-step run record.
 *
 * The plugin never generates a skill itself — creation is the creator's own pipeline.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROVIDER = 'dsh-skill-creator:creators';

/**
 * Hard dependencies, declared the way a shipped host plugin declares them
 * (`dsh-host-open-in-app` exports `inject` including `webServer`).
 *
 * This is load-bearing: a plugin that guards its registrations behind a one-shot
 * `ctx.get('webServer')` activates BEFORE that service exists — nothing orders it — and
 * then registers no route at all. The skill-provider half still works, so the failure
 * surfaces as "the panel API 404s" rather than as a startup error.
 */
export const inject = ['webServer', 'skills'];

/** Record a successful mount on disk: the host's own console is not visible from outside. */
function markMounted(detail) {
  try {
    const base = process.env.DSH_SKILL_CREATOR_CACHE || path.join(os.tmpdir(), 'dsh-skill-creator-cache');
    const marker = path.join(base, 'mounted.json');
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, `${JSON.stringify({ ...detail, at: new Date().toISOString(), pid: process.pid, cwd: process.cwd() }, null, 2)}\n`);
  } catch { /* diagnostics only — never fail the mount because of a marker */ }
}

/** Expose both creators as loadable skills; each carries its cache dir as resourceBase. */
function registerCreatorSkills({ ctx, CREATORS, fetchCreator, status, parseFrontmatterLenient }) {
  const skills = ctx.get('skills');
  if (!skills) return () => {};
  return skills.registerProvider(() => ({
    name: PROVIDER,
    async list() {
      // The creator contract puts remote initialization in list(): a TTL-cached fetch
      // that never throws, so being offline only hides the skill.
      await Promise.allSettled(Object.keys(CREATORS).map((kind) => fetchCreator(kind)));
      const candidates = [];
      for (const [kind, spec] of Object.entries(CREATORS)) {
        const current = status(kind);
        if (!current.present) continue;
        let description = `Create skills with the official ${spec.skill} (${spec.branch}@${String(current.commit).slice(0, 8)}).`;
        let whenToUse;
        try {
          const fm = parseFrontmatterLenient(fs.readFileSync(path.join(current.dir, 'SKILL.md'), 'utf8'));
          if (fm.ok) {
            const raw = String(fm.data.description || '').split('\n')
              .filter((line) => !/^\s*\d+\.\s/.test(line) && !/Triggers include:/i.test(line) && !/触发/.test(line))
              .join(' ').trim();
            if (raw) description = raw.slice(0, 1024);
            if (/Triggers include:/i.test(String(fm.data.description))) {
              whenToUse = String(fm.data.description).split(/Triggers include:/i).pop().trim().slice(0, 1024);
            }
          }
        } catch { /* keep the fallback description */ }
        candidates.push({
          name: spec.skill,
          description,
          ...(whenToUse ? { whenToUse } : {}),
          invocation: { modelInvocable: true, userInvocable: true },
          source: 'custom',
          provider: PROVIDER,
          rank: 0,
          locator: { kind, dir: current.dir },
          resourceBase: { kind: 'directory', path: current.dir },
        });
      }
      return { candidates, complete: true };
    },
    async get(candidate) {
      const body = fs.readFileSync(path.join(candidate.locator.dir, 'SKILL.md'), 'utf8');
      return { ...candidate, content: body };
    },
  }));
}

export function apply(ctx, config = {}) {
  // Reload semantics (verified the hard way): a bundle disable/enable only re-imports
  // THIS entry module — its static dependencies keep the code they already had in the
  // ESM registry, so a fixed runner.mjs kept behaving like the previous revision until
  // DSH was restarted. Loading them with a per-apply query makes every core edit take
  // effect on the next toggle. Cordis supports an async effect that resolves to the
  // disposer: `_execute` routes a thenable through `effect.then(safeCollect)`.
  const bust = `?v=${Date.now().toString(36)}`;

  ctx.effect(async () => {
    const [catalogMod, creatorsMod, runnerMod, routesMod, yamlMod] = await Promise.all([
      import(`./catalog.mjs${bust}`),
      import(`./creators.mjs${bust}`),
      import(`./runner.mjs${bust}`),
      import(`./routes.mjs${bust}`),
      import(`../lib/yaml.mjs${bust}`),
    ]);
    const { createCatalog } = catalogMod;
    const { CREATORS, fetchCreator, status } = creatorsMod;
    const { createRunner } = runnerMod;
    const { API_BASE, createApiHandler, API_REVISION } = routesMod;
    const { parseFrontmatterLenient } = yamlMod;

    const catalogConfig = config.catalog || {};
    const catalog = createCatalog({
      repo: catalogConfig.repo || 'huaweicloud/huaweicloud-skills',
      ref: catalogConfig.ref || 'master',
      root: catalogConfig.root || 'skills',
      localDir: catalogConfig.localDir || '',
      ttlMs: Number(catalogConfig.ttlMs) || undefined,
    });
    const runner = createRunner(ctx, config.run || {}, { buildHandoff: creatorsMod.buildHandoff });

    // `inject` above guarantees both services exist, so these are direct calls: a silent
    // `if (service)` skip is exactly the failure this plugin must not have.
    const disposers = [registerCreatorSkills({ ctx, CREATORS, fetchCreator, status, parseFrontmatterLenient })];
    disposers.push(ctx.webServer.register({
      kind: 'prefix',
      path: API_BASE,
      handler: createApiHandler({ runner, catalog, buildHandoff: creatorsMod.buildHandoff }),
    }));
    markMounted({ api: API_BASE, revision: API_REVISION, catalog: catalog.describe(), creators: Object.keys(CREATORS),
      handoffProbe: creatorsMod.buildHandoff('generic', { description: 'probe' }).includes('技能功能描述') });

    // Warm the creator cache in the background so `skill(...)` works shortly after boot.
    const warm = setTimeout(() => {
      for (const kind of Object.keys(CREATORS)) fetchCreator(kind).catch(() => { /* offline: stays absent */ });
    }, 3000);
    if (typeof warm.unref === 'function') warm.unref();

    return () => {
      clearTimeout(warm);
      runner.disposeAll();
      for (const dispose of disposers) { try { dispose(); } catch { /* already gone */ } }
    };
  }, 'dsh-skill-creator: creator skills + panel API');
}
