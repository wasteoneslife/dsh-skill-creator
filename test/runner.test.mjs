import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CREATORS, cacheRoot, creatorDir } from '../src/core/creators.mjs';
import { scoreEvaluation } from '../src/core/evaluator.mjs';
import { createRunner, createUserMessage, detectPhase, detectStage, phasesFor, summarizeToolCall, PHASES } from '../src/core/runner.mjs';

// Seed a fresh creator cache so start() never needs the network.
process.env.DSH_SKILL_CREATOR_CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'dsc-runner-'));
for (const [kind, spec] of Object.entries(CREATORS)) {
  const dir = creatorDir(kind);
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${spec.skill}\ndescription: x\n---\n`);
  fs.writeFileSync(path.join(cacheRoot(), kind, 'stamp.json'), JSON.stringify({
    kind, skill: spec.skill, repo: spec.repo, branch: spec.branch, path: spec.path, commit: 'deadbeefcafe', fetchedAt: Date.now(),
  }));
}
assert.ok(fs.existsSync(path.join(creatorDir('huawei'), 'SKILL.md')), `seeded at ${cacheRoot()}`);

/** Minimal Host ctx: one creatable agent plus the assistant-stream bus. */
function fakeCtx() {
  const listeners = [];
  const agents = [];
  const mounted = [];
  const permissionSets = [];
  let idleResolve = null;
  const ctx = {
    on(event, listener) { listeners.push({ event, listener }); return () => { listeners.length = 0; }; },
    get(name) {
      if (name === 'agents') {
        return {
          async create(options) {
            // The idle promise exists from construction: `whenIdle()` is called only after
            // the settle grace period, so a lazily-created promise would never resolve.
            let resolveIdle;
            const idlePromise = new Promise((resolve) => { resolveIdle = resolve; idleResolve = resolve; });
            const agent = {
              // Faithful to the shipped factory: the agent id IS options.sessionId.
              id: options.sessionId, options, sent: null, messages: [], cancelled: false, disposed: false,
              followup(message) { agent.sent = message; agent.messages.push(message); },
              whenIdle: () => idlePromise,
              cancel(cause) { agent.cancelled = cause; },
            };
            void resolveIdle;
            agents.push(agent);
            return { agent, dispose: async () => { agent.disposed = true; } };
          },
        };
      }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' }) };
      if (name === 'permissionPresets') return {
        resolve(name) { return { sandbox: name, approval: 'never' }; },
        set(session, name) { permissionSets.push([session, name]); },
      };
      if (name === 'agentPresets') return {
        async resolve(id) { return { id: id || 'standard' }; },
        async mount(agentCtx, id) { mounted.push([agentCtx, id]); },
      };
      return undefined;
    },
  };
  const frames = [];
  return {
    ctx, agents, frames, mounted, permissionSets,
    emit: (agent, frame) => { for (const l of listeners) if (l.event === 'agent/assistant-stream') l.listener({ agent, frame }); },
    emitSession: (sessionId, event) => { for (const l of listeners) if (l.event === 'session/event') l.listener({ id: sessionId }, event); },
    idle: () => idleResolve && idleResolve(),
  };
}

describe('creation run: an agent is driven through the creator', () => {
  test('detectPhase only reports real markers', () => {
    assert.equal(detectPhase('starting Phase 3 now'), 3);
    assert.equal(detectPhase('Phase 1 … Phase 2 … Phase 6'), 6);
    assert.equal(detectPhase('phase  4 (chinese 阶段)'), 4);
    assert.equal(detectPhase('no marker here'), null);
    assert.equal(detectPhase('Phase 9 out of range'), null);
  });

  test('detectStage follows the creator that actually runs', () => {
    // Huawei speaks in Phase 1..6
    assert.equal(detectStage('huawei', 'Phase 3 now'), 3);
    assert.equal(detectStage('huawei', 'Step 4 of the generic flow'), null);
    // The generic creator speaks in Step 1..8 and phase-N-summary.json (5 stages)
    assert.equal(detectStage('generic', 'Step 2: design'), 2);
    assert.equal(detectStage('generic', 'writing phase-4-summary.json'), 4);
    assert.equal(detectStage('generic', 'Step 7 创建 PR'), 5, 'steps past the 5 stages clamp to the last');
    assert.equal(detectStage('generic', 'Phase 3 documented'), null, 'the Huawei wording is not a generic marker');
    assert.equal(detectStage('generic', 'nothing yet'), null);
  });

  test('summarizeToolCall renders name + compact arguments', () => {
    assert.match(summarizeToolCall('read_file', '{"path":"/tmp/x","limit":20}'), /read_file path=\/tmp\/x limit=20/);
    assert.match(summarizeToolCall('bash', 'not json'), /bash not json/);
  });

  test('start() creates an agent, sends the creator request, and tracks phases live', async () => {
    const { ctx, agents, emit, idle, mounted, permissionSets } = fakeCtx();
    // maxEvalRounds 0 = evaluation disabled: this test covers the creation phase alone.
    const runner = createRunner(ctx, { wakeGraceMs: 0, maxEvalRounds: 0, permissionPreset: 'danger-full-access' });
    const run = await runner.start({ mode: 'huawei', name: 'huawei-cloud-ecs-manage', domain: 'computing', product: 'ecs', summary: 'Manage ECS', tags: ['huawei-cloud'] });

    assert.match(run.id, /^session-/);
    assert.equal(run.status, 'creating');
    assert.equal(run.kind, 'huawei');
    assert.equal(run.commit, 'deadbeefcafe');
    // the profile default model is used, and the prompt names the creator
    const agent = agents[0];
    // A real user turn: `role` + fresh id. A bare {content, source} object never runs a
    // step, so the run reported "done" while doing nothing — the first live failure.
    assert.equal(agent.sent.role, 'user');
    assert.ok(agent.sent.id, 'the message needs an identity');
    assert.equal(agent.sent.source.kind, 'user');
    assert.ok(Object.isFrozen(agent.sent), 'the host freezes messages before publication');
    assert.equal(agent.options.agentOptions.provider, 'deepseek-account');
    assert.equal(agent.options.agentOptions.model, 'deepseek-flash');
    assert.match(agent.sent.content[0].text, /huawei-cloud-skill-creator/);
    assert.match(agent.sent.content[0].text, /Skill name: huawei-cloud-ecs-manage/);
    assert.match(agent.sent.content[0].text, /SKILL\.md/);
    // `sessionId` is REQUIRED by the shipped factory (it also becomes the agent id):
    // omitting it fails with `agent id "undefined" does not match session id "session-1"`.
    assert.match(agent.options.sessionId, /^session-/);
    // Without a preset the agent gets almost no tools (the first live run had exactly one).
    assert.equal(agent.options.meta.agentPreset, 'standard');
    // the tool set only exists if the preset was actually mounted in setup
    assert.equal(typeof agent.options.setup, 'function');
    await agent.options.setup({}, agent);
    assert.deepEqual(mounted.at(-1)[1], 'standard');
    // unattended: an EXPLICITLY configured preset is recorded before the first turn
    assert.equal(permissionSets.length, 1);
    assert.equal(permissionSets[0][1], 'danger-full-access');
    assert.deepEqual(run.permission, { preset: 'danger-full-access', sandbox: 'danger-full-access', approval: 'never' });
    assert.ok(agent.options.meta && agent.options.meta.cwd, 'the run must carry a working directory');
    assert.equal(run.cwd, agent.options.meta.cwd);
    assert.match(run.target, /skills[\\/]computing[\\/]ecs[\\/]huawei-cloud-ecs-manage$/);
    assert.match(agent.sent.content[0].text, /Create the skill at/);

    // streaming assistant text drives the phase checklist
    emit(agent, { type: 'start', turn: 1, step: 1 });
    emit(agent, { type: 'chunk', chunk: { type: 'text-delta', text: 'Reading the creator. ' } });
    emit(agent, { type: 'chunk', chunk: { type: 'text-delta', text: 'Now Phase 2: research.' } });
    let snap = runner.get(run.id);
    assert.equal(snap.phase, 2);
    assert.equal(snap.phases[0].state, 'done');
    assert.equal(snap.phases[1].state, 'active');
    assert.equal(snap.phases[2].state, 'pending');
    assert.equal(snap.turn, 1);
    // the detail view must carry the spec (the panel shows the skill name from it)
    assert.equal(snap.spec.name, 'huawei-cloud-ecs-manage');
    assert.equal(snap.spec.domain, 'computing');
    assert.ok(snap.steps.some((s) => s.kind === 'phase' && /Phase 2/.test(s.text)));

    // a committed tool call becomes one step-log line
    emit(agent, { type: 'chunk', chunk: { type: 'block-end', block: { type: 'tool-call', name: 'bash', arguments: '{"command":"bash validate-skill.sh -s x"}' } } });
    snap = runner.get(run.id);
    assert.ok(snap.steps.some((s) => s.kind === 'tool' && /bash command=/.test(s.text)), JSON.stringify(snap.steps));

    // an error finish is surfaced
    emit(agent, { type: 'chunk', chunk: { type: 'finish', reason: { kind: 'error', failure: { message: 'rate limited', code: 'x' } } } });
    assert.ok(runner.get(run.id).steps.some((s) => s.kind === 'warn' && /rate limited/.test(s.text)));

    // quiescence closes the run and completes the checklist
    idle();
    await new Promise((r) => setTimeout(r, 10));
    snap = runner.get(run.id);
    assert.equal(snap.status, 'done');
    assert.ok(snap.phases.every((p) => p.state === 'done'), JSON.stringify(snap.phases));
    assert.equal(PHASES.length, 6);
    assert.equal(phasesFor('generic').length, 5, 'the generic creator runs its own five stages');
    assert.match(phasesFor('generic')[0].title, /需求分析/);
    assert.equal(phasesFor('nope').length, 6, 'unknown kinds fall back to the Huawei pipeline');
  });

  test('an ABSENT permissionPreset keeps the deployment default (no forced danger-full-access)', async () => {
    // Publishing contract: someone else's machine must not silently run creation agents
    // fully unsandboxed. With nothing configured the session preset is left alone, and an
    // explicit config/run value still wins.
    const bare = fakeCtx();
    // The shipped runtimes have an approval service; add it so the record carries the
    // "(unset) → deployment default" marker instead of staying null.
    const lookup = bare.ctx.get.bind(bare.ctx);
    bare.ctx.get = (name) => (name === 'approval' ? {} : lookup(name));
    const runner = createRunner(bare.ctx, { wakeGraceMs: 0, maxEvalRounds: 0 });
    const run = await runner.start({ mode: 'huawei', name: 'huawei-cloud-neutral' });
    assert.equal(bare.permissionSets.length, 0, 'the session preset must not be overwritten');
    assert.equal(run.permission.preset, '(unset)', 'the deployment default applies, not a hardcoded preset');
    assert.equal(run.cwd, process.cwd(), 'no configured cwd → host process cwd, never a baked-in machine path');

    const explicit = fakeCtx();
    const runner2 = createRunner(explicit.ctx, { wakeGraceMs: 0, maxEvalRounds: 0, permissionPreset: 'workspace-write' });
    const run2 = await runner2.start({ mode: 'huawei', name: 'huawei-cloud-explicit',
      permissionPreset: 'read-only' });
    // spec > config, exactly like cwd
    assert.equal(explicit.permissionSets.length, 1);
    assert.equal(explicit.permissionSets[0][1], 'read-only');
    assert.equal(run2.permission.preset, 'read-only');
  });

  test('a message that starts no turn is FAILED, never reported as done', async () => {
    const { ctx, idle } = fakeCtx();
    const runner = createRunner(ctx, { wakeGraceMs: 0, maxEvalRounds: 0 });
    const run = await runner.start({ mode: 'huawei', name: 'huawei-cloud-silent' });
    // no assistant-stream frame ever arrives: the agent sat idle without admitting it
    idle();
    await new Promise((r) => setTimeout(r, 20));
    const snap = runner.get(run.id);
    assert.equal(snap.status, 'failed', 'silence must not look like success');
    assert.match(snap.error, /没有产生任何回合|未被受理/);
    assert.equal(snap.phase, null);
  });

  test('createUserMessage matches the host shape', () => {
    const message = createUserMessage([{ type: 'text', text: 'hi' }]);
    assert.equal(message.role, 'user');
    assert.equal(message.source.kind, 'user');
    assert.match(String(message.id), /^[0-9a-f-]{36}$/);
    assert.ok(Object.isFrozen(message) && Object.isFrozen(message.content[0]));
  });

  test('cancel() aborts the agent and disposes the handle', async () => {
    const { ctx, agents } = fakeCtx();
    const runner = createRunner(ctx, { wakeGraceMs: 0, maxEvalRounds: 0 });
    const run = await runner.start({ mode: 'generic', name: 'my-skill', summary: 'x' });
    assert.equal(run.kind, 'generic');
    assert.equal(await runner.cancel(run.id), true);
    assert.equal(agents[0].cancelled.kind, 'plugin');
    assert.equal(agents[0].disposed, true);
    assert.equal(runner.get(run.id).status, 'cancelled');
    assert.equal(await runner.cancel('nope'), false);
  });

  test('a missing agents service fails loudly instead of hanging', async () => {
    const runner = createRunner({ on: () => () => {}, get: () => undefined }, { wakeGraceMs: 0, maxEvalRounds: 0 });
    await assert.rejects(() => runner.start({ mode: 'huawei', name: 'huawei-cloud-x' }), /agents 服务不可用/);
  });

  test('records survive a fiber reload (that is what re-opening a long run needs)', async () => {
    const first = fakeCtx();
    const runnerA = createRunner(first.ctx, { wakeGraceMs: 0, persistDebounceMs: 0, maxEvalRounds: 0 });
    const run = await runnerA.start({ mode: 'huawei', name: 'huawei-cloud-persist-me', domain: 'computing', product: 'ecs', summary: 'x' });
    runnerA.get(run.id);
    await new Promise((r) => setTimeout(r, 30));   // let the debounced flush land
    // A new fiber (bundle reload / DSH restart) must still see the record.
    const restored = createRunner(fakeCtx().ctx, { wakeGraceMs: 0, persistDebounceMs: 0, maxEvalRounds: 0 });
    const found = restored.get(run.id);
    assert.ok(found, 'the run must be restored from disk');
    assert.equal(found.spec.name, 'huawei-cloud-persist-me');
    assert.equal(found.spec.domain, 'computing');
    assert.ok(found.phases.length === 6);
    assert.equal(found.status, 'interrupted', 'a record left running by a dead fiber is not still running');
    assert.ok(restored.list().some((r) => r.id === run.id));
    assert.equal(await restored.cancel(run.id), false, 'a restored record has no live handle to cancel');
  });

  test('disposeAll unwinds every live run', async () => {
    const { ctx, agents } = fakeCtx();
    const runner = createRunner(ctx, { wakeGraceMs: 0, maxEvalRounds: 0 });
    await runner.start({ mode: 'huawei', name: 'huawei-cloud-a' });
    runner.disposeAll();
    assert.equal(agents[0].disposed, true);
    assert.deepEqual(runner.list(), []);
  });
});

/**
 * The evaluation loop. `deps.runEvaluation` is the seam: the loop's decisions (threshold,
 * rounds, fix hand-off, give-up) are what is tested here, while the evaluation round itself
 * (prompt + metrics + scoring maths) is covered by test/evaluator.test.mjs and the last case.
 */
describe('runner · 评测与修复循环', () => {
  /** Give the loop's timers a chance to run (each waitForIdle is a setTimeout(0) hop). */
  const settle = async (rounds = 8) => { for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 10)); };

  const METRICS = { tokenTotal: 1000, durationSeconds: 10, toolFailCount: 0, retryCount: 0, cliCallCount: 1, sdkCallCount: 0, apiCallCount: 0, llmCallCount: 2, contextCompressed: false };

  /** Score through the REAL scorer, so the loop sees genuine rubric results. */
  const stubEvaluator = (verdicts) => {
    let index = 0;
    return async ({ run }) => {
      const want = verdicts[Math.min(index, verdicts.length - 1)];
      const round = index + 1;
      index += 1;
      const checks = want === 'pass'
        ? { functionalUsable: true, triggerSufficiency: 1 }
        : { functionalUsable: false, triggerSufficiency: 0, functionalEvidence: `stub round ${round}: TC-01 fail` };
      const evaluation = scoreEvaluation({
        checks, metrics: METRICS, baseline: run.baseline, safety: { high: 0, warnings: 0, findings: [] }, passScore: run.passScore,
      });
      return { evaluation, metrics: METRICS, checks };
    };
  };
  const SPEC = { mode: 'huawei', name: 'huawei-cloud-ecs-manage', domain: 'computing', product: 'ecs', summary: 'Manage ECS' };

  test('达标即结束：第 1 轮就通过则只评测一次，没有修复消息', async () => {
    const { ctx, agents, idle, emit } = fakeCtx();
    const runner = createRunner(ctx, { wakeGraceMs: 0 }, { runEvaluation: stubEvaluator(['pass']) });
    const run = await runner.start(SPEC);
    emit(agents[0], { type: 'start', turn: 1, step: 1 });
    idle();
    await settle();
    const snap = runner.get(run.id);
    assert.equal(snap.status, 'done');
    assert.equal(snap.verdict, 'pass');
    assert.equal(snap.score, 10);
    assert.equal(snap.round, 1);
    assert.equal(snap.maxEvalRounds, 3, 'default is three rounds');
    assert.equal(snap.passScore, 8.5, 'the pass line is 8.5/10 (「85 分」)');
    assert.equal(snap.evaluations.length, 1);
    assert.deepEqual(snap.deductions, []);
    assert.match(snap.report, /最终得分：10\.00\/10/);
    assert.match(snap.report, /未纳入（平台侧信号缺失）/);
    assert.equal(agents.length, 1, 'a passing round never needs a second agent');
    assert.equal(agents[0].messages.length, 1, 'no fix prompt when the first round passes');
    assert.ok(snap.steps.some((s) => s.kind === 'eval-ok' && /10\.00\/10/.test(s.text)));
  });

  test('不达标 → 扣分明细交回同一个 creator → 第 2 轮达标即停', async () => {
    const { ctx, agents, idle, emit } = fakeCtx();
    const runner = createRunner(ctx, { wakeGraceMs: 0 }, { runEvaluation: stubEvaluator(['fail', 'pass']) });
    const run = await runner.start(SPEC);
    emit(agents[0], { type: 'start', turn: 1, step: 1 });
    idle();
    await settle(12);
    const snap = runner.get(run.id);
    assert.equal(snap.status, 'done');
    assert.equal(snap.round, 2);
    assert.equal(snap.evaluations.length, 2);
    assert.equal(snap.evaluations[0].verdict, 'fail');
    assert.equal(snap.evaluations[1].verdict, 'pass');
    // the SAME creator agent does the fixing: cheapest, it already holds the context
    assert.equal(agents.length, 1);
    assert.equal(agents[0].messages.length, 2, 'one creation + one fix');
    const fix = agents[0].messages[1];
    assert.equal(fix.role, 'user');
    assert.match(fix.content[0].text, /6\.00\/10/);
    assert.match(fix.content[0].text, /扣分明细/);
    assert.match(fix.content[0].text, /功能可用（-3）/);
    assert.match(fix.content[0].text, /不要重新问需求/);
    assert.ok(snap.steps.some((s) => s.kind === 'fix'));
    assert.ok(snap.steps.some((s) => s.kind === 'eval-bad'));
  });

  test('3 轮到顶仍未达标 → below-threshold + 报告，不再硬跑', async () => {
    const { ctx, agents, idle, emit } = fakeCtx();
    const runner = createRunner(ctx, { wakeGraceMs: 0, passScore: 8.5, maxEvalRounds: 3, minImprovement: 0 }, { runEvaluation: stubEvaluator(['fail']) });
    const run = await runner.start(SPEC);
    emit(agents[0], { type: 'start', turn: 1, step: 1 });
    idle();
    await settle(20);
    const snap = runner.get(run.id);
    assert.equal(snap.status, 'below-threshold');
    assert.equal(snap.verdict, 'below-threshold');
    assert.equal(snap.round, 3);
    assert.equal(snap.evaluations.length, 3, 'exactly three scored rounds');
    assert.equal(snap.score, 6);
    assert.match(snap.error, /低于通过线 8\.5/);
    assert.match(snap.error, /已达 3 轮上限/);
    // two fix rounds (after round 1 and 2); round 3 ends the loop instead of fixing again
    assert.equal(agents[0].messages.length, 3);
    assert.equal(agents.length, 1);
    assert.match(snap.report, /❌ 未达标/);
    assert.match(snap.report, /\| 3 \| 6\.00 \|/, 'the report carries every round');
    assert.deepEqual(snap.deductions.map((d) => d.item), ['功能可用', '触发词充足度']);
    assert.ok(snap.steps.some((s) => s.kind === 'error' && /已达 3 轮上限/.test(s.text)));
    // it must not keep working after giving up
    await settle(6);
    assert.equal(runner.get(run.id).evaluations.length, 3);
    assert.equal(agents[0].messages.length, 3);
  });
  test('看门狗判定：时钟跳变=挂起 / 静默=卡死 / 整段超时=超出 / 正常=继续等', () => {
    const base = { startedAt: 0, idlePollMs: 15000, idleTimeoutMs: 480000, phaseTimeoutMs: 7200000 };
    // 机器休眠：这一跳（2.5 小时）远超轮询间隔 —— 绝不能被当成卡死
    assert.equal(watchdogDecision({ ...base, now: 9000000, lastTick: 0, lastActivityAt: 0 }).action, 'suspend');
    // 轮询正常，但活动已过去 9 分钟 —— 这才是真的静默
    assert.equal(watchdogDecision({ ...base, now: 540000, lastTick: 525000, lastActivityAt: 0 }).action, 'idle');
    // 一直在动，但整段超过了 120 分钟的绝对兜底
    assert.equal(watchdogDecision({ ...base, now: 7300000, lastTick: 7290000, lastActivityAt: 7290000 }).action, 'phase');
    // 刚活动过 —— 继续等
    assert.equal(watchdogDecision({ ...base, now: 30000, lastTick: 15000, lastActivityAt: 20000 }).action, 'ok');
  });

  test('失败记录重新收到活动就复活（不再永久显示 failed）', async () => {
    const { ctx, agents, emit } = fakeCtx();
    const runner = createRunner(ctx, { wakeGraceMs: 0, persistDebounceMs: 0, idleTimeoutMs: 80, idlePollMs: 20, phaseTimeoutMs: 60000 });
    const run = await runner.start(SPEC);
    await settle(200);
    assert.equal(runner.get(run.id).status, 'failed', 'silence still fails the run');
    emit(agents[0], { type: 'start', turn: 1, step: 2 });
    assert.equal(runner.get(run.id).status, 'creating', 'a live creator must bring the record back');
  });
  test('creator 提问不再干等：立即自动代答，run 保持进行中', async () => {
    const { ctx, agents, emit } = fakeCtx();
    const runner = createRunner(ctx, { wakeGraceMs: 0, persistDebounceMs: 0, idleTimeoutMs: 5000, idlePollMs: 100 });
    const run = await runner.start(SPEC);
    emit(agents[0], { type: 'start', turn: 1, step: 1 });
    const before = agents[0].messages.length;
    emit(agents[0], { type: 'chunk', chunk: { type: 'block-end', block: { type: 'tool-call', name: 'ask_user_question', arguments: '{"questions":[{"header":"Mutating-op testing"}]}' } } });
    await settle(20);
    const snap = runner.get(run.id);
    assert.ok(snap.steps.some((s) => /自动答复/.test(s.text)), JSON.stringify(snap.steps.map((s) => s.text).slice(-3)));
    assert.equal(agents[0].messages.length, before + 1, 'the standing policy reply must be delivered');
    assert.notEqual(snap.status, 'failed', 'asking must not kill the run');
  });


  // ── 持久化加固、记录上限与真实评测轮（每条针对一个真实缺陷）────────────────
  /** Run a case against a private cache root: the real runs.json is never touched. */
  const withPrivateCache = async (fn) => {
    const previous = process.env.DSH_SKILL_CREATOR_CACHE;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsc-cache-'));
    process.env.DSH_SKILL_CREATOR_CACHE = root;
    for (const [kind, spec] of Object.entries(CREATORS)) {
      const dir = creatorDir(kind);
      fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${spec.skill}\ndescription: x\n---\n`);
      fs.writeFileSync(path.join(root, kind, 'stamp.json'), JSON.stringify({
        kind, skill: spec.skill, repo: spec.repo, branch: spec.branch, path: spec.path, commit: 'deadbeefcafe', fetchedAt: Date.now(),
      }));
    }
    try { return await fn(root); } finally { process.env.DSH_SKILL_CREATOR_CACHE = previous; }
  };
  const readRuns = (root) => JSON.parse(fs.readFileSync(path.join(root, 'runs.json'), 'utf8')).runs;

  test('持久化：原子落盘并保留上一版 runs.json.bak', async () => {
    await withPrivateCache(async (root) => {
      const runner = createRunner(fakeCtx().ctx, { wakeGraceMs: 0, persistDebounceMs: 0, maxEvalRounds: 0 });
      const run = await runner.start(SPEC);
      await settle(3);
      assert.ok(fs.existsSync(path.join(root, 'runs.json')), 'the record file must be written');
      assert.ok(!fs.existsSync(path.join(root, 'runs.json.tmp')), 'the temp file is renamed away, not left behind');
      await runner.cancel(run.id);          // a second write: the previous revision becomes the backup
      await settle(3);
      const bak = path.join(root, 'runs.json.bak');
      assert.ok(fs.existsSync(bak), 'the previous revision must be kept as .bak');
      assert.ok(JSON.parse(fs.readFileSync(bak, 'utf8')).runs.some((r) => r.id === run.id));
    });
  });

  test('持久化：runs.json 损坏时从 .bak 恢复记录', async () => {
    await withPrivateCache(async (root) => {
      const runnerA = createRunner(fakeCtx().ctx, { wakeGraceMs: 0, persistDebounceMs: 0, maxEvalRounds: 0 });
      const run = await runnerA.start(SPEC);
      await settle(3);
      await runnerA.cancel(run.id);
      await settle(3);
      assert.ok(fs.existsSync(path.join(root, 'runs.json.bak')), 'precondition: a backup exists');
      // exactly what an interrupted (non-atomic) write leaves behind
      fs.writeFileSync(path.join(root, 'runs.json'), '{"version":1,"runs":[{"id":"session-trunc');
      const runnerB = createRunner(fakeCtx().ctx, { wakeGraceMs: 0, persistDebounceMs: 0, maxEvalRounds: 0 });
      const found = runnerB.get(run.id);
      assert.ok(found, 'the backup must be used when the main file cannot be parsed');
      assert.equal(found.spec.name, SPEC.name);
    });
  });

  test('持久化：磁盘记录多于内存时取并集，绝不缩水', async () => {
    await withPrivateCache(async (root) => {
      const past = Date.now() - 100000;
      const record = (id, at) => ({ id, kind: 'huawei', status: 'done', startedAt: at, updatedAt: at, steps: [], spec: { name: id } });
      const two = [record('session-mine', past + 1000), record('session-foreign', past)];
      fs.writeFileSync(path.join(root, 'runs.json'), JSON.stringify({ version: 1, runs: two }));
      const runner = createRunner(fakeCtx().ctx, { wakeGraceMs: 0, persistDebounceMs: 0, maxEvalRounds: 0 });
      assert.equal(runner.list().length, 2, 'both records load');
      // a concurrent fiber (or an older build) wrote a record this instance never saw
      fs.writeFileSync(path.join(root, 'runs.json'), JSON.stringify({ version: 1, runs: [record('session-third', past + 2000), ...two] }));
      await runner.start(SPEC);              // flushes the 2-record in-memory map
      await settle(3);
      const ids = readRuns(root).map((r) => r.id);
      assert.ok(ids.includes('session-third'), 'a write must not drop a record it never loaded: ' + ids.join(', '));
      assert.ok(ids.includes('session-mine') && ids.includes('session-foreign'));
    });
  });

  test('持久化：disposeAll() 先存后清，关闭不再清空记录', async () => {
    await withPrivateCache(async (root) => {
      const runner = createRunner(fakeCtx().ctx, { wakeGraceMs: 0, persistDebounceMs: 0, maxEvalRounds: 0 });
      const run = await runner.start(SPEC);
      runner.disposeAll();                   // this used to clear the map and THEN write it out
      assert.ok(readRuns(root).some((r) => r.id === run.id), 'shutdown must persist before releasing memory');
      assert.deepEqual(runner.list(), [], 'the in-memory map is released afterwards');
    });
  });

  test('reap() 不淘汰活跃 run：上限只淘汰已结束的记录', async () => {
    await withPrivateCache(async (root) => {
      // MAX_RUNS is 20. Future-dated finished records make the LIVE run the oldest record, which
      // is exactly what a naive `status !== "running"` filter would evict first.
      const base = Date.now() + 100000;
      const records = [];
      for (let i = 0; i < 25; i++) {
        records.push({ id: 'session-old-' + i, kind: 'huawei', status: 'done', startedAt: base + i * 1000, updatedAt: base + i * 1000, steps: [], spec: { name: 'old-' + i } });
      }
      fs.writeFileSync(path.join(root, 'runs.json'), JSON.stringify({ version: 1, runs: records }));
      const runner = createRunner(fakeCtx().ctx, { wakeGraceMs: 0, persistDebounceMs: 0, maxEvalRounds: 0 });
      const run = await runner.start(SPEC);  // live + active, and the oldest by startedAt
      const list = runner.list();            // list() runs reap()
      assert.ok(list.some((r) => r.id === run.id), 'an ACTIVE run must never be reaped');
      assert.equal(runner.get(run.id).status, 'creating');
      assert.equal(list.length, 20, 'the cap still holds: finished records are evicted instead');
    });
  });

  test('maxEvalRounds: 0 → 创建完直接 done，不起评测 agent', async () => {
    const { ctx, agents, emit, idle } = fakeCtx();
    const runner = createRunner(ctx, { wakeGraceMs: 0, persistDebounceMs: 0, maxEvalRounds: 0 });
    const run = await runner.start(SPEC);
    emit(agents[0], { type: 'start', turn: 1, step: 1 });
    idle();
    await settle();
    const snap = runner.get(run.id);
    assert.equal(snap.status, 'done');
    assert.equal(snap.round, 0);
    assert.deepEqual(snap.evaluations, []);
    assert.equal(agents.length, 1, 'evaluation disabled: no evaluation agent may be spawned');
  });

  test('早停：连续两轮提升 < 0.2 就停在第 2 轮，不把 3 轮跑满', async () => {
    const { ctx, agents, idle, emit } = fakeCtx();
    const runner = createRunner(ctx, { wakeGraceMs: 0 }, { runEvaluation: stubEvaluator(['fail']) });
    const run = await runner.start(SPEC);
    emit(agents[0], { type: 'start', turn: 1, step: 1 });
    idle();
    await settle(20);
    const snap = runner.get(run.id);
    assert.equal(snap.status, 'below-threshold');
    assert.equal(snap.round, 2, 'a round that did not move the score must not buy a third');
    assert.equal(snap.evaluations.length, 2);
    assert.equal(snap.evaluations[0].total, snap.evaluations[1].total, 'precondition: the score did not move');
    assert.ok(snap.steps.some((s) => s.kind === 'warn' && /提前停止/.test(s.text)), JSON.stringify(snap.steps.slice(-4)));
    assert.equal(agents[0].messages.length, 2, 'one creation + one fix, and no second fix');
    assert.match(snap.report, /❌ 未达标/);
  });

  test('真实评测轮：起第二个 agent、提示词只读且带 eval-result 标记；无结构化输出时不默认满分', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsc-eval-'));
    const skillDir = path.join(dir, 'skills', 'computing', 'ecs', 'huawei-cloud-ecs-manage');
    fs.mkdirSync(path.join(skillDir, 'templates'), { recursive: true });
    // deliberately broken: name ≠ directory basename, and no description at all
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: wrong-name\n---\n\n# Body\n');
    fs.writeFileSync(path.join(skillDir, 'templates', 'test-vars.json'), JSON.stringify({
      test_cases: [
        { id: 'TC-01', name: 'list servers', command: 'hcloud ECS ListServersDetails', type: 'readonly' },
        { id: 'TC-02', name: 'delete server', command: 'hcloud ECS DeleteServers', type: 'write' },
      ],
    }));

    const { ctx, agents, emit, idle } = fakeCtx();
    const runner = createRunner(ctx, { wakeGraceMs: 0, persistDebounceMs: 0, maxEvalRounds: 1 });
    const run = await runner.start({ ...SPEC, cwd: dir });
    emit(agents[0], { type: 'start', turn: 1, step: 1 });
    emit(agents[0], { type: 'chunk', chunk: { type: 'text-delta', text: 'Phase 1 … Phase 6 done' } });
    idle();
    await settle(12);

    assert.equal(agents.length, 2, 'a REAL evaluation round spawns a dedicated evaluation agent');
    const evalPrompt = agents[1].messages[0].content.map((b) => b.text).join('\n');
    assert.match(evalPrompt, /绝对不要修改/, 'the evaluator is told not to touch the skill');
    assert.match(evalPrompt, /禁止执行任何写操作/, 'readonlyOnly is on by default');
    assert.match(evalPrompt, /<!-- eval-result -->/);
    assert.match(evalPrompt, /TC-01/);
    assert.ok(!/TC-02/.test(evalPrompt), 'a write case must never be handed to the evaluator');

    // the evaluator answers in prose, i.e. without the structured block
    emit(agents[1], { type: 'start', turn: 1, step: 1 });
    emit(agents[1], { type: 'chunk', chunk: { type: 'text-delta', text: '用例执行完毕，没有结构化结论。' } });
    idle();
    await settle(12);

    const snap = runner.get(run.id);
    assert.equal(snap.status, 'below-threshold', 'a broken package cannot pass on a prose-only verdict');
    assert.ok(snap.checks.structuralErrors >= 1, 'the validator reports level:"error" issues');
    assert.equal(snap.checks.functionalUsable, false, 'no verdict must NOT default to full marks');
    assert.match(snap.checks.functionalEvidence, /改用本地结构校验/);
    assert.equal(snap.itemScores.find((i) => i.itemName === '功能可用').score, 0);
    assert.ok(snap.score < snap.passScore, 'score ' + snap.score + ' must stay below ' + snap.passScore);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

import { watchdogDecision } from '../src/core/runner.mjs';
