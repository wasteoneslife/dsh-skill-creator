/**
 * Skill-creation runs — the plugin drives a real agent through the creator's pipeline.
 *
 * Why an agent and not a script: creating a skill IS the creator skill's job (six-phase
 * pipeline: Socratic requirements → CLI/SDK/API research → documents → tests → testing →
 * cleanup). Only an agent can execute it, so a run = one created agent + the creator
 * prompt, observed live through `agent/assistant-stream`.
 *
 * Verified contracts (cordis_inspect_query + the shipped factory source, 0.2.0-rc.2):
 *   ctx.agents.create({ sessionId, meta, agentOptions }) → AgentHandle { agent, dispose() }
 *     `sessionId` is REQUIRED: the factory builds the session from it and uses the same
 *     value as the agent id (`setupAndPublish(ownerCtx, options.sessionId, …)`). Omit it
 *     and the session is auto-named while the agent id stays undefined, failing later
 *     with `agent id "undefined" does not match session id "session-1"`.
 *   agent.followup({ content, source })      → queues a user-role turn and wakes the loop
 *   agent.whenIdle()                         → resolves at quiescence
 *   agent.cancel(cause)                      → aborts the active activity
 *   'agent/assistant-stream'(…, { agent, frame })  emit, agent-scope filtered
 *     frame: {type:'start',turn,step} | {type:'chunk',chunk} | {type:'end',outcome}
 *     chunk: {type:'text-delta',text} | {type:'tool-call-delta',name,argumentsDelta} |
 *            {type:'block-end',block} | {type:'finish',reason}
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { buildHandoff as defaultBuildHandoff, CREATORS, cacheRoot, fetchCreator, kindOfMode, status } from './creators.mjs';
import {
  DEFAULT_MAX_EVAL_ROUNDS, DEFAULT_PASS_SCORE, buildEvaluationPrompt, buildFixPrompt, descriptionFromFiles,
  AUTONOMY_DIRECTIVES, EFFICIENCY_DIRECTIVES, formatEvaluationReport, metricsFromEvents, parseEvaluationOutput,
  assessFunctionalEvidence, collectFixtureCases, evaluateGates, readSkillFiles, resolveEvalLimits, resolveSkillDir,
  scanSkillSafety, scoreEvaluation, triggerSufficiencyFromDescription,
} from './evaluator.mjs';
import { validateSkillPackage } from './validators.mjs';

/**
 * Each creator has its OWN pipeline, so the checklist must be per kind: rendering the
 * Huawei six-phase list for a generic run showed stages that creator never runs and never
 * updated (the generic creator speaks in Step 1-8 / phase-N-summary terms).
 */
export const PHASES_BY_KIND = {
  huawei: [
    { id: 1, title: 'Phase 1 · 需求分析（苏格拉底式问答）' },
    { id: 2, title: 'Phase 2 · 技术调研（CLI→SDK→API 三级回退）' },
    { id: 3, title: 'Phase 3 · 文档生成（SKILL.md + references + 载体）' },
    { id: 4, title: 'Phase 4 · 测试准备（templates/test-vars.json）' },
    { id: 5, title: 'Phase 5 · 详细测试（真实执行验证）' },
    { id: 6, title: 'Phase 6 · 资源清理与合规检查' },
  ],
  api: [
    { id: 1, title: 'Step 1 · 需求澄清' },
    { id: 2, title: 'Step 2 · 技术调研' },
    { id: 3, title: 'Step 3 · 骨架生成' },
    // The creator's own pipeline continues into 创建 PR → A2A 交棒 QA, but that exists only
    // inside the platform flow (it needs repository/issue_number/the grape CLI). This panel
    // runs standalone and explicitly forbids remote pushes, so the last stage is named for
    // what actually happens here: the standalone self-test and wrap-up.
    { id: 4, title: 'Step 4 · 自测与收尾（创建 PR/交棒属平台流水线，本面板不做）' },
  ],
  generic: [
    { id: 1, title: '阶段 1 · 需求分析' },
    { id: 2, title: '阶段 2 · 设计' },
    { id: 3, title: '阶段 3 · 生成（skill 包 + 模板）' },
    { id: 4, title: '阶段 4 · 验证（规范 + lint 检查点双通过）' },
    { id: 5, title: '阶段 5 · eval 迭代' },
  ],
};
/** The checklist for one kind (unknown kinds fall back to the Huawei pipeline). */
export function phasesFor(kind) { return PHASES_BY_KIND[kind] || PHASES_BY_KIND.huawei; }
/** Back-compat alias for the Huawei table. */
export const PHASES = PHASES_BY_KIND.huawei;

const MAX_LOG = 400;
const MAX_RUNS = 20;
const MAX_STEPS = 200;
/** Only these fields are written to disk (never the live handle or the text tail). */
const PERSISTED_FIELDS = [
  'id', 'sessionId', 'kind', 'creator', 'commit', 'spec', 'cwd', 'target', 'agentPreset', 'permission',
  'status', 'phase', 'phases', 'error', 'startedAt', 'updatedAt',
  // evaluation state (round / score / deductions / report) survives a reload too
  'round', 'maxEvalRounds', 'passScore', 'verdict', 'score', 'dimensions', 'itemScores', 'deductions',
  'checks', 'metrics', 'baseline', 'evaluations', 'report',
];
/** Grace period before trusting `whenIdle()`: the inbox admits a followup asynchronously. */
const WAKE_GRACE_MS = 1200;
/** Silence that means "stuck". Activity renews it, so a long healthy phase survives. */
const IDLE_TIMEOUT_MS = 8 * 60 * 1000;
/** Absolute backstop per phase, generous: a chatty-but-stuck phase still cannot run forever. */
const PHASE_TIMEOUT_MS = 120 * 60 * 1000;
const IDLE_POLL_MS = 15000;
/**
 * How long a run may wait on ONE tool call before that wait counts as stuck.
 *
 * A tool in flight emits NO assistant frame at all: `job_output job_id=… wait=true
 * timeout_ms=600000` is ten deliberately silent minutes, and the silence rule above read
 * exactly that as "stuck" and failed a healthy run at minute eight. Waiting on a tool gets
 * its own, larger ceiling; `phaseTimeoutMs` stays the absolute per-phase backstop.
 */
const TOOL_WAIT_MS = 20 * 60 * 1000;
/** Standing reply for a creator that asks a question the panel cannot show. */
const AUTONOMY_ANSWER = [
  '无人值守模式：没有人能看到或回答你的问题，所以请不要再提问。',
  '请按最保守、只读的方式自行决定并继续，直到产出完成；',
  '禁止执行任何变更类操作，这类用例跳过并在报告里标注"未执行（无人值守只读策略）"。',
].join('\n');

/**
 * What the per-phase watchdog should do on one tick.
 *
 * Split out as a pure function because the interesting cases — a machine suspend, and a run
 * waiting on a long tool — cannot be reproduced reliably with real timers, yet neither may
 * ever be mistaken for a stuck agent: a Huawei creation slept 2h33m and was failed although
 * it then finished successfully, and a run waiting on `job_output wait=true timeout_ms=600000`
 * (ten silent minutes by design) was failed at minute eight for "silence".
 *
 * Silence is only stuck when there is NEITHER a pending tool NOR a new frame:
 *   suspend   → the tick itself is hours late: the process was frozen
 *   idle      → no pending tool and no activity for idleTimeoutMs, OR a pending tool that
 *               blew its own toolWaitMs ceiling (`waitedOnTool: true`, with `toolName`)
 *   tool-wait → a tool call is in flight and inside its budget: keep waiting, never kill
 *   phase     → the absolute per-phase backstop
 *   ok        → nothing to do
 */
export function watchdogDecision({
  now, lastTick, lastActivityAt, startedAt, idleTimeoutMs, phaseTimeoutMs, idlePollMs,
  pendingToolAt = null, pendingToolName = null, toolWaitMs = TOOL_WAIT_MS,
}) {
  const late = now - lastTick;
  // A tick far later than the poll interval means the process was frozen: nothing was idle.
  // Checked FIRST, so a machine suspend outranks every other verdict — tool wait included.
  if (late > idlePollMs * 5) return { action: 'suspend', late };
  const silentMs = now - (lastActivityAt || startedAt);
  const phaseExceeded = now - startedAt > phaseTimeoutMs;
  // `pendingToolAt` is a timestamp, so an explicit null means "no tool in flight" (0 is a
  // legitimate value in tests and must not read as absent).
  if (pendingToolAt !== null) {
    const waitedMs = now - pendingToolAt;
    if (waitedMs > toolWaitMs) {
      // Only the tool's own ceiling may kill a run that is waiting on it.
      return { action: 'idle', silentMs, waitedMs, toolName: pendingToolName, waitedOnTool: true };
    }
    // The phase ceiling stays ABSOLUTE: waiting on a tool must not buy an unbounded extension.
    if (phaseExceeded) return { action: 'phase', waitedMs };
    return { action: 'tool-wait', silentMs, waitedMs, toolName: pendingToolName };
  }
  if (silentMs > idleTimeoutMs) return { action: 'idle', silentMs };
  if (phaseExceeded) return { action: 'phase' };
  return { action: 'ok' };
}
/** Hard ceiling for one creation/evaluation phase; a stuck phase must not hang the run. */
const EVAL_TIMEOUT_MS = 20 * 60 * 1000;
/** Per-session event buffer used to derive the rubric's metrics. */
const MAX_SESSION_EVENTS = 4000;

/** Where to look for bash, in order: PATH first, then the usual Git-for-Windows installs. */
const BASH_CANDIDATES = [
  'bash',
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  '/bin/bash',
  '/usr/bin/bash',
];

/**
 * E (huawei only): run the creator's OWN `scripts/validate-skill.sh -s <skill-dir>`.
 *
 * Output is redirected to a regular FILE rather than a pipe: in a confined sandbox a child
 * cannot open named pipes, so `stdio: 'pipe'` fails with EPERM. `ran: false` (no bash, EPERM,
 * timeout) is reported as a warning by `evaluateGates`, never as a gate failure — an
 * evaluation must not be decided by whether this machine happens to have bash.
 */
export function runCreatorValidator({ script, skillDir, candidates = BASH_CANDIDATES, timeoutMs = 120000 } = {}) {
  const logFile = path.join(os.tmpdir(), `dsc-validate-${randomUUID().slice(0, 8)}.log`);
  for (const bash of candidates) {
    let fd = null;
    let result;
    try {
      fd = fs.openSync(logFile, 'w');
      result = spawnSync(bash, [script, '-s', skillDir], {
        stdio: ['ignore', fd, fd], timeout: timeoutMs,
        cwd: path.dirname(path.dirname(script)),
      });
    } catch {
      continue;
    } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
    }
    if (result && result.error && result.error.code === 'ENOENT') continue;
    let output = '';
    try { output = fs.readFileSync(logFile, 'utf8'); } catch { output = `${(result && result.stdout) || ''}\n${(result && result.stderr) || ''}`; }
    try { fs.rmSync(logFile, { force: true }); } catch { /* diagnostics only */ }
    if (result && result.error && result.status === null) {
      return { ran: false, ok: true, detail: `无法执行 ${bash}：${result.error.message}` };
    }
    const summary = (output.match(/PASS:\s*(\d+)\s+FAIL:\s*(\d+)/) || [])[2];
    const failCount = summary !== undefined ? Number(summary) : (output.match(/FAIL:/g) || []).length;
    const status = result ? result.status : null;
    if (status === 0 && failCount === 0) {
      return { ran: true, ok: true, detail: `creator validate-skill.sh 通过（FAIL 0，退出码 0）` };
    }
    if (failCount === 0) {
      // Non-zero exit with no FAIL line: the script could not do its job ([FATAL] …, missing
      // python3/git, timeout). That is "cannot run" → warning, never a gate failure.
      const tail = String(output).trim().split('\n').slice(-1)[0].slice(0, 200);
      return {
        ran: false, ok: true,
        detail: `creator validate-skill.sh 未能正常完成（退出码 ${status}，无 FAIL 行）：${tail || '(无输出)'}`,
      };
    }
    const firstFails = (output.match(/FAIL:[^\n]*/g) || []).slice(0, 3).map((line) => line.trim()).join(' / ');
    return {
      ran: true, ok: false,
      detail: `creator validate-skill.sh 报 ${failCount} 个 FAIL（退出码 ${status}）${firstFails ? `：${firstFails.slice(0, 300)}` : ''}`,
    };
  }
  return { ran: false, ok: true, detail: '未找到可用的 bash（PATH 与常见 Git Bash 路径都没有）' };
}

/**
 * Run lifecycle states:
 *   creating → evaluating(round 1) → done                     (score >= passScore)
 *            → evaluating(round 1) → fixing → evaluating(2) …  (below the pass line)
 *            → below-threshold                                 (maxEvalRounds reached)
 * plus failed / cancelled from any state. `maxEvalRounds: 0` disables evaluation
 * entirely (creation-only runs still finish as `done`).
 */
export const RUN_STATES = ['creating', 'evaluating', 'fixing', 'done', 'below-threshold', 'failed', 'cancelled'];
/** States that mean work is still in flight: reap() must never evict one of these. */
export const ACTIVE_RUN_STATES = ['creating', 'evaluating', 'fixing'];

/**
 * Build a user-role message the way the host's own `createUserMessage()` does.
 *
 * A plugin cannot import `@deepseek-ai/dsh-llm` (verified: ERR_MODULE_NOT_FOUND — it lives
 * inside the Harness package tree), so the shape is replicated: `createMessage` stamps a
 * fresh `id` and `createUserMessage` adds `role: 'user'`, then both deep-freeze a detached
 * clone. Sending a bare `{ content, source }` looks accepted but is NOT a user turn: no
 * step ever runs, `whenIdle()` resolves immediately, and the run reports "done" having
 * done nothing — the exact silent failure this helper exists to prevent.
 */
export function createUserMessage(content, source = { kind: 'user' }) {
  const deepFreeze = (value) => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const item of Object.values(value)) deepFreeze(item);
    }
    return value;
  };
  return deepFreeze({ id: randomUUID(), role: 'user', content, source, time: Date.now() });
}

/**
 * Scan the run's accumulated text for the creator's own stage markers. Never returns a
 * stage lower than the current one: a closing summary re-mentions earlier stages, and
 * letting that regress the checklist ended a completed Huawei run back at Phase 1.
 */
export function detectStage(kind, text) {
  const body = String(text || '');
  const maxOf = (re, map) => {
    let best = null;
    for (const m of body.matchAll(re)) {
      const value = map ? map(Number(m[1])) : Number(m[1]);
      if (Number.isFinite(value) && (best === null || value > best)) best = value;
    }
    return best;
  };
  if (kind !== 'huawei') {
    // Both non-Huawei creators narrate in Step N terms (their docs: Step 1..N) and write
    // phase-N-summary.json; the last stage is the table's own length.
    const last = phasesFor(kind).length;
    const stages = [
      maxOf(/phase-(\d+)-summary/gi, (n) => Math.min(n, last)),
      maxOf(/Step\s*(\d+)\b/gi, (n) => Math.min(n, last)),
      maxOf(/阶段\s*([0-9]+)/gi, (n) => Math.min(n, last)),
    ].filter((v) => v !== null);
    if (!stages.length) return null;
    return Math.min(Math.max(...stages), last);
  }
  const phases = maxOf(/Phase\s*([1-6])\b/gi);
  return phases === null ? null : Math.min(phases, 6);
}
/** Huawei-shaped convenience wrapper (kept for callers and tests). */
export function detectPhase(text) { return detectStage('huawei', text); }

/** One-line summary of a tool call for the step log. */
export function summarizeToolCall(name, rawArguments) {
  let detail = String(rawArguments || '').replace(/\s+/g, ' ').trim();
  try {
    const parsed = JSON.parse(rawArguments);
    const entries = Object.entries(parsed || {});
    if (entries.length) {
      detail = entries.map(([k, v]) => {
        const value = typeof v === 'string' ? v : JSON.stringify(v);
        return `${k}=${value.length > 60 ? `${value.slice(0, 57)}…` : value}`;
      }).join(' ');
    }
  } catch { /* keep the raw text */ }
  return `${name}${detail ? ` ${detail.slice(0, 160)}` : ''}`;
}

export function createRunner(ctx, config = {}, deps = {}) {
  // The entry module loads this graph with a cache-busting query; a STATIC import here would
  // bind the stale registry copy instead (that is how a fixed buildHandoff kept producing the
  // old prompt through a bundle reload). The busted instance is injected instead.
  const buildHandoff = deps.buildHandoff || defaultBuildHandoff;
  const runs = new Map();
  const graceMs = Number.isFinite(config.wakeGraceMs) ? Number(config.wakeGraceMs) : WAKE_GRACE_MS;
  const persistDebounceMs = Number.isFinite(config.persistDebounceMs) ? Number(config.persistDebounceMs) : 1500;
  /** 10-point rubric pass line: 8.5 = the user's "85 分". */
  const passScore = Number.isFinite(config.passScore) ? Number(config.passScore) : DEFAULT_PASS_SCORE;
  /** 0 disables evaluation; the default allows up to three scored rounds. */
  const maxEvalRounds = Number.isFinite(config.maxEvalRounds) ? Math.max(0, Number(config.maxEvalRounds)) : DEFAULT_MAX_EVAL_ROUNDS;
  /** Only readonly/syntax cases are ever executed (no write operations). */
  const evalReadonlyOnly = config.evalReadonlyOnly !== false;
  const idleTimeoutMs = Number.isFinite(config.idleTimeoutMs) ? Number(config.idleTimeoutMs) : IDLE_TIMEOUT_MS;
  const phaseTimeoutMs = Number.isFinite(config.phaseTimeoutMs) ? Number(config.phaseTimeoutMs)
    : (Number.isFinite(config.evalTimeoutMs) ? Number(config.evalTimeoutMs) : PHASE_TIMEOUT_MS);
  const idlePollMs = Number.isFinite(config.idlePollMs) ? Number(config.idlePollMs) : IDLE_POLL_MS;
  /** Ceiling for ONE tool call in flight; larger than idleTimeoutMs because a tool is silent. */
  const toolWaitMs = Number.isFinite(config.toolWaitMs) ? Number(config.toolWaitMs) : TOOL_WAIT_MS;
  /** A fix round that improves less than this is not worth another ~15 minutes. 0 disables. */
  const minImprovement = Number.isFinite(config.minImprovement) ? Number(config.minImprovement) : 0.2;
  /**
   * Absolute ceilings for cost/efficiency + the local gate cap (`config.run`, see
   * DEFAULT_EVAL_LIMITS). Without them the first round handed out 3 of the 10 points for
   * free and three live runs all landed on exactly 10.00/10.
   */
  const evalLimits = resolveEvalLimits(config);
  /** Test seam: the creator's validate-skill.sh execution (E) without spawning bash. */
  const runSkillValidator = deps.runSkillValidator || runCreatorValidator;
  /** Test seam: the loop's decisions are testable without spawning an evaluation agent. */
  const runEvaluation = deps.runEvaluation || evaluateWithAgent;
  let flushTimer = null;
  const log = (run, kind, text) => {
    run.steps.push({ at: Date.now(), kind, text: String(text).slice(0, 500) });
    if (run.steps.length > MAX_LOG) run.steps.splice(0, run.steps.length - MAX_LOG);
    run.updatedAt = Date.now();
    if (ACTIVE_RUN_STATES.includes(run.status)) scheduleFlush();
    else flushNow();
  };

  function reap() {
    // Records are kept by count, not by age: a finished creation is exactly what the panel
    // is meant to re-open later, so time-based expiry would defeat the feature.
    while (runs.size > MAX_RUNS) {
      const oldest = [...runs.values()].filter((r) => !ACTIVE_RUN_STATES.includes(r.status)).sort((a, b) => a.startedAt - b.startedAt)[0];
      if (!oldest) break;
      runs.delete(oldest.id);
    }
  }

  /**
   * Persistence. The run map is in-memory inside a plugin fiber, so a bundle reload — or a
   * DSH restart — used to erase every record, including a creation that had just
   * succeeded. The panel's "creation records" would then list nothing, which is precisely
   * when you want to re-open a long run. Records live beside the creator cache instead.
   */
  const runsFile = () => path.join(cacheRoot(), 'runs.json');

  /**
   * Records from one file. A single unusable entry must cost only itself: the previous
   * version wrapped the whole loop in one try/catch, so one bad record — or a truncated
   * file — silently loaded nothing, and the next flush then overwrote the history.
   */
  function readRecords(file) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const out = [];
    for (const record of Array.isArray(raw && raw.runs) ? raw.runs : []) {
      try { if (record && record.id) out.push(record); } catch { /* skip this entry only */ }
    }
    return out;
  }

  function flush() {
    try {
      const dir = cacheRoot();
      fs.mkdirSync(dir, { recursive: true });
      const records = [...runs.values()]
        .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
        .slice(0, MAX_RUNS)
        .map((run) => {
          const record = { steps: (run.steps || []).slice(-MAX_STEPS) };
          for (const key of PERSISTED_FIELDS) if (run[key] !== undefined) record[key] = run[key];
          return record;
        });
      // Anti-shrink: a fiber that could not load the history must never overwrite it.
      // That is exactly how every record but the newest disappeared.
      let disk = [];
      try { disk = readRecords(runsFile()); } catch { /* unreadable or absent */ }
      // Unconditional union (memory ∪ disk): a write must never be able to shrink what is
      // already on disk, whatever state this fiber happens to be in.
      const known = new Set(records.map((r) => r.id));
      const merged = [...records, ...disk.filter((r) => r && r.id && !known.has(r.id))]
        .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
        .slice(0, MAX_RUNS);
      // Atomic write + a backup: a write interrupted halfway must not cost everything.
      const file = runsFile();
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, runs: merged }, null, 1)}\n`);
      try { if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`); } catch { /* best effort */ }
      fs.renameSync(tmp, file);
    } catch { /* persistence is a convenience; never break a run over it */ }
  }

  /** Settled runs are exactly what must survive: write them now, not after the debounce. */
  function flushNow() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    flush();
  }
  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => { flushTimer = null; flush(); }, persistDebounceMs);
    if (typeof flushTimer.unref === 'function') flushTimer.unref();
  }

  { // rehydrate anything a previous fiber left behind
    const file = path.join(cacheRoot(), 'runs.json');
    let records = [];
    for (const candidate of [file, `${file}.bak`]) {
      try { records = readRecords(candidate); if (records.length) break; } catch { /* try the backup */ }
    }
    for (const record of records) {
      try {
        // A record written while the run was still working can never still be working: this
        // process owns runs, so any active state left by a dead fiber means interrupted.
        const status = ['creating', 'evaluating', 'fixing', 'running'].includes(record.status) ? 'interrupted' : record.status;
        runs.set(record.id, { ...record, status, steps: record.steps || [], restored: true });
      } catch { /* one unusable record must not drop the others */ }
    }
  }

  /**
   * Advance the checklist monotonically. Shared by the text stream and the tool log,
   * because a creator announces its stage in either place; allback lets the first
   * frame mark stage 1 so the panel is never dead while the agent works.
   */
  function advanceStage(run, text, fallback = null) {
    const stage = detectStage(run.kind, text) || fallback;
    if (!stage || stage <= (run.phase || 0)) return;
    run.phase = stage;
    for (const p of run.phases) {
      // Everything before the current stage is complete, whatever it was marked before:
      // the first frame marks stage 1 active, so a later jump must still close it.
      p.state = p.id < stage ? 'done' : p.id === stage ? 'active' : 'pending';
    }
    log(run, 'phase', phasesFor(run.kind).find((p) => p.id === stage).title);
  }
  // ── agents ────────────────────────────────────────────────────────────────
  /** Activity bookkeeping per agent: the creator drives the checklist, everyone the log. */
  function activityOf(run, agentId) {
    let activity = run.activity.get(agentId);
    if (!activity) {
      activity = { sawActivity: false, tail: '', turn: null, step: null, pendingTool: null, role: 'eval' };
      run.activity.set(agentId, activity);
    }
    return activity;
  }

  /** Create one more agent for this run (the creator, then one per evaluation round). */
  async function spawnAgent(run, role, sessionId = null) {
    const agents = ctx.get('agents');
    if (!agents) throw new Error('agents 服务不可用，无法启动创建流程');
    const id = sessionId || `session-${randomUUID()}`;
    const handle = await agents.create({
      sessionId: id,
      meta: { cwd: run.cwd, agentPreset: run.agentPreset },
      ...(run.agentOptions ? { agentOptions: run.agentOptions } : {}),
      ...(run.agentSetup ? { setup: run.agentSetup } : {}),
    });
    const agent = handle.agent;
    const agentId = String(agent.id);
    run.handles.push(handle);
    run.sessionIds.add(agentId);
    run.sessionEvents.set(agentId, []);
    activityOf(run, agentId).role = role;
    // Unattended: the creator MUST run bash, and so must the evaluation agent — it executes
    // the skill's own readonly commands. Without this the run stops on an approval nobody sees.
    const permissionPresets = ctx.get('permissionPresets');
    if (permissionPresets && run.permission && run.permission.preset && run.permission.preset !== '(unset)') {
      try { permissionPresets.set(agent.session, run.permission.preset); } catch { /* keep the deployment default */ }
    }
    return { handle, agent, sessionId: id };
  }

  /**
   * Resolve when one agent has gone idle *after* doing something. `whenIdle()` also resolves
   * before the inbox admits a followup, so the grace period plus the activity check keep a
   * rejected message from being reported as success. A guard timer ends a stuck phase.
   */
  function waitForIdle(run, agent, label) {
    return new Promise((resolve) => {
      let settled = false;
      const startedAt = Date.now();
      run.lastActivityAt = startedAt;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        // This phase no longer waits on a tool, whatever the outcome: a stale flag would
        // mask genuine silence in the next phase (the tool must have returned for the agent
        // to be quiescent at all).
        run.pendingToolAt = null;
        run.pendingToolName = null;
        clearTimeout(grace);
        clearInterval(watchdog);
        run.timers.delete(grace);
        run.timers.delete(watchdog);
        resolve(result);
      };
      const grace = setTimeout(() => {
        agent.whenIdle()
          .then(() => finish({ ok: true, activity: activityOf(run, String(agent.id)) }))
          .catch((error) => finish({ ok: false, error: String((error && error.message) || error) }));
      }, graceMs);
      // A phase dies on SILENCE, not on duration. The previous fixed ceiling failed a
      // healthy generic creation that was still editing files at minute 20
      // ("等待「creator」空闲超时（20 分钟）"). Every observed frame renews the deadline;
      // the absolute ceiling stays as a backstop for a phase that talks but never ends.
      let lastTick = startedAt;
      const watchdog = setInterval(() => {
        const now = Date.now();
        const verdict = watchdogDecision({
          now, lastTick, lastActivityAt: run.lastActivityAt, startedAt, idleTimeoutMs, phaseTimeoutMs, idlePollMs,
          pendingToolAt: run.pendingToolAt ?? null, pendingToolName: run.pendingToolName ?? null, toolWaitMs,
        });
        lastTick = now;
        if (verdict.action === 'suspend') {
          // A suspend is not idleness: re-base and keep waiting. The frozen stretch must not
          // be charged to ANY deadline, the pending tool's included — otherwise a machine
          // that slept while a tool was in flight would be failed for "tool wait timeout"
          // on the first tick after waking, which is the same false positive this fix removes.
          run.lastActivityAt = now;
          if (run.pendingToolAt !== null && run.pendingToolAt !== undefined) run.pendingToolAt = now;
          log(run, 'warn', `检测到进程被挂起约 ${Math.round(verdict.late / 60000)} 分钟，重新计时（不判死）`);
          return;
        }
        if (verdict.action === 'tool-wait') {
          // The agent is blocked INSIDE a tool call, so it emits no frame until the tool
          // answers: `job_output wait=true timeout_ms=600000` is ten healthy, silent minutes.
          // Keep waiting — only the tool's own ceiling (toolWaitMs) may end this wait.
          return;
        }
        if (verdict.action === 'idle') {
          const asked = run.pendingQuestion ? `；它最后在等待用户回答：${run.pendingQuestion}` : '';
          finish({
            ok: false,
            error: verdict.waitedOnTool
              ? `等待工具 ${verdict.toolName || '(未命名)'} 返回超时：已等待 ${Math.round(verdict.waitedMs / 60000)} 分钟（上限 ${Math.round(toolWaitMs / 60000)} 分钟）${asked}`
              : `等待「${label}」超时：已静默 ${Math.round(idleTimeoutMs / 60000)} 分钟（无任何工具调用或文本）${asked}`,
          });
          return;
        }
        if (verdict.action === 'phase') {
          finish({ ok: false, error: `等待「${label}」超时：整段已超过 ${Math.round(phaseTimeoutMs / 60000)} 分钟` });
        }
      }, idlePollMs);
      if (typeof grace.unref === "function") grace.unref();
      if (typeof watchdog.unref === "function") watchdog.unref();
      run.timers.add(grace);
      run.timers.add(watchdog);
    });
  }

  /** Observe one assistant-stream frame of one of this run's agents. */
  function observe(run, frame, agentId) {
    if (!frame) return;
    // ANY frame is proof the agent moved on: a tool that was in flight has returned, so the
    // "waiting on a tool" state ends here. This is what keeps the flag from outliving the call.
    run.pendingToolAt = null;
    run.pendingToolName = null;
    const activity = activityOf(run, agentId);
    const isCreator = activity.role === 'creator';
    // Any frame proves the loop actually started a step for our message.
    activity.sawActivity = true;
    // A settled run can still be alive: a watchdog that fired during a suspend killed a
    // creator that then resumed and finished. Activity brings the record back instead of
    // leaving the panel insisting the creation failed.
    if (run.status === 'failed') {
      run.status = run.round > 0 ? 'evaluating' : 'creating';
      run.error = null;
      log(run, 'warn', '已终结的 run 重新收到活动，状态回到进行中');
    }
    run.lastActivityAt = Date.now();
    if (frame.type === 'start') {
      activity.turn = frame.turn;
      activity.step = frame.step;
      if (isCreator) {
        run.turn = frame.turn;
        run.step = frame.step;
        // The run has begun: without a marker yet, stage 1 is the honest current stage.
        advanceStage(run, '', 1);
      }
      return;
    }
    if (frame.type === 'end') return;
    const chunk = frame.chunk;
    if (!chunk) return;
    if (chunk.type === 'text-delta' && chunk.text) {
      // A wider window: the generic creator's stage markers appear in prose spread over a
      // long run, and a 4k window dropped them before detection could see them.
      activity.tail = (activity.tail + chunk.text).slice(-20000);
      if (isCreator) { run.tail = (run.tail + chunk.text).slice(-20000); advanceStage(run, run.tail); }
      return;
    }
    if (chunk.type === 'tool-call-delta' && chunk.name) activity.pendingTool = { name: chunk.name, args: '' };
    if (chunk.type === 'tool-call-delta' && activity.pendingTool) activity.pendingTool.args += chunk.argumentsDelta || '';
    if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'tool-call') {
      const summary = summarizeToolCall(chunk.block.name, chunk.block.arguments);
      // The call is DISPATCHED, not returned: the agent stays frame-silent until the tool
      // answers (`job_output wait=true timeout_ms=600000` = ten silent minutes), which the
      // silence rule used to read as "stuck" and kill a healthy run. Record WHEN it started
      // and WHICH tool it is, so the watchdog can tell "waiting on a tool" from "producing
      // nothing" — and can name the tool if its own ceiling is ever blown.
      run.pendingToolAt = Date.now();
      run.pendingToolName = chunk.block.name;
      log(run, 'tool', isCreator ? summary : `评测 · ${summary}`);
            // A creator that asks anyway must not hang the run: reply with the standing policy
            // so it carries on read-only instead of waiting for an answer nobody can give.
            if (chunk.block.name === 'ask_user_question' && activity.role === 'creator' && run.creatorAgent) {
              run.pendingQuestion = summary.slice(0, 160);
              run.autoAnswered = (run.autoAnswered || 0) + 1;
              if (run.autoAnswered <= 5) {
                log(run, 'warn', `creator 询问用户，已按无人值守策略自动答复（第 ${run.autoAnswered} 次）：禁止变更类操作，按只读方式继续，不要再次询问`);
                Promise.resolve(run.creatorAgent.followup(createUserMessage([{ type: 'text', text: AUTONOMY_ANSWER }]))).catch(() => { });
              }
            }
            // The summary above is truncated for readability; keep the real paths here: a
            // nameless generic/API run finds its skill directory for evaluation through them.
            for (const m of String(chunk.block.arguments || '').matchAll(/"(?:file_path|path|dir)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
              const abs = m[1].replace(/\\\\/g, '\\');
              if (!/^[A-Za-z]:\\|^\//.test(abs)) continue;
              run.writtenPaths = run.writtenPaths || [];
              if (run.writtenPaths.length < 200 && !run.writtenPaths.includes(abs)) run.writtenPaths.push(abs);
            }
      // Stage markers live in tool activity too — the generic creator writes
      // phase-N-summary.json and runs validate-skill.sh without narrating every stage.
      if (isCreator) advanceStage(run, summary);
      activity.pendingTool = null;
    }
    if (chunk.type === 'finish' && chunk.reason) {
      const kind = chunk.reason.kind;
      if (kind === 'error' || kind === 'aborted') log(run, 'warn', `模型返回 ${kind}${chunk.reason.failure ? `: ${chunk.reason.failure.message}` : ''}`);
    }
  }

  // One listener pair for the whole runner graph, dispatching into whichever run owns the
  // agent or session. Registering them per run would leak two listeners per creation.
  const offStream = ctx.on('agent/assistant-stream', (payload) => {
    const id = String((payload && payload.agent && payload.agent.id) || '');
    if (!id) return;
    for (const run of runs.values()) if (run.sessionIds && run.sessionIds.has(id)) observe(run, payload.frame, id);
  });
  const offSessions = ctx.on('session/event', (session, event) => {
    const id = String((session && session.id) || '');
    if (!id || !event) return;
    for (const run of runs.values()) {
      const bucket = run.sessionEvents && run.sessionEvents.get(id);
      if (!bucket) continue;
      bucket.push(event);
      if (bucket.length > MAX_SESSION_EVENTS) bucket.splice(0, bucket.length - MAX_SESSION_EVENTS);
    }
  });

  async function start(spec = {}) {
    reap();
    const kind = kindOfMode(spec.mode);
    const current = await fetchCreator(kind);
    if (!current.present) throw new Error(`creator 不可用：${current.error || status(kind).dir}`);

    const agents = ctx.get('agents');
    if (!agents) throw new Error('agents 服务不可用，无法启动创建流程');

    const selection = ctx.get('agentDefaultModel')?.currentSelection?.();
    const agentOptions = config.agentOptions
      || (selection ? { provider: selection.provider, model: selection.model, ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}) } : undefined);

    // `sessionId` is load-bearing: the factory builds the session from it AND uses the
    // same value as the agent id. Without it the session is auto-named, the agent id
    // stays undefined, and creation fails with a confusing id-mismatch error.
    //
    // The AGENT PRESET is what installs the tool set, and `meta.agentPreset` alone does
    // NOT apply it — the preset must also be *mounted* from `setup`, exactly as the
    // shipped session controller does in its `composeAgent`. Skip the mount and the agent
    // keeps only the globally registered tools: the first live run got
    // `load_workspace_dependencies` and nothing else, so it could not read a file, run a
    // command, or load the creator skill.
    const creatorSessionId = spec.sessionId || `session-${randomUUID()}`;
    const cwd = spec.cwd || config.cwd || process.cwd();
    const presets = ctx.get('agentPresets');
    if (!presets) throw new Error('agentPresets 服务不可用：无法为新 agent 安装工具集');
    const agentPreset = (await presets.resolve(spec.agentPreset || config.agentPreset)).id;
    const agentSetup = async (agentCtx) => { await presets.mount(agentCtx, agentPreset); };

    // Permission is OPT-IN. A creator and the evaluation agent must run bash
    // (ensure_cli.sh / validate-skill.sh), which cannot fork inside the deployment's
    // read-mostly sandbox (`workspace-write` + approval `ask`) — an unattended run then
    // stops on an escalation prompt nobody watches. That used to be "solved" by hardcoding
    // `danger-full-access` as the fallback, which silently ran EVERY install's creation
    // agents fully unsandboxed. Now an absent preset keeps the deployment/session default
    // and the operator opts in (`config.run.permissionPreset: 'danger-full-access'`).
    const wantedPreset = spec.permissionPreset || config.permissionPreset || null;
    const permissionPresets = ctx.get('permissionPresets');
    let permission = null;
    if (permissionPresets && wantedPreset) {
      let resolved;
      try { resolved = permissionPresets.resolve(wantedPreset); } catch (error) {
        throw new Error(`权限 preset「${wantedPreset}」不可用：${(error && error.message) || error}`);
      }
      permission = { preset: wantedPreset, sandbox: resolved.sandbox, approval: resolved.approval };
    } else {
      // `(unset)` is the record's marker for "the deployment default applies": the session
      // preset is never overwritten (see the set() guard in spawnAgent).
      const approval = ctx.get('approval');
      if (approval) permission = { preset: '(unset)', sandbox: '(deployment default)', approval: 'never' };
    }

    const run = {
      id: creatorSessionId,
      sessionId: creatorSessionId,
      cwd,
      agentPreset,
      agentOptions,
      agentSetup,
      permission,
      kind,
      creator: current.skill,
      commit: current.commit,
      spec,
      // creating → evaluating → (fixing → evaluating)* → done | below-threshold
      status: 'creating',
      round: 0,
      maxEvalRounds,
      passScore,
      evalReadonlyOnly,
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
      phase: null,
      phases: phasesFor(kind).map((p) => ({ ...p, state: 'pending' })),
      steps: [],
      tail: '',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      handles: [],
      sessionIds: new Set(),
      sessionEvents: new Map(),
      activity: new Map(),
      timers: new Set(),
    };
    runs.set(run.id, run);
    const { agent } = await spawnAgent(run, 'creator', creatorSessionId);
    /** The creator stays the fixer for every round: it already holds the whole context. */
    run.creatorAgent = agent;
    run.creatorDir = current.dir;
    const skillFile = path.join(current.dir, 'SKILL.md');
    // A generic run carries no name, so its directory is the creator's decision: the prompt
    // asks for it rather than pretending the path is already known.
    const target = kind === 'huawei' && spec.domain && spec.product && spec.name
      ? path.join(cwd, 'skills', spec.domain, spec.product, spec.name)
      : (spec.name ? path.join(cwd, 'skills', spec.name) : null);
    run.target = target;
    const prompt = [
      buildHandoff(kind, spec),
      '',
      '---',
      `Creator skill id: ${current.skill} (${CREATORS[kind].branch}@${String(current.commit).slice(0, 8)}, ${current.files.length} files)`,
      `If the skill tool is available, load it as \`${current.skill}\`. Otherwise read \`${skillFile}\` and follow it.`,
      `Its scripts live in \`${path.join(current.dir, 'scripts')}\` — run them from there or copy the whole creator directory into a scratch dir first.`,
      target
        ? `Working directory: \`${cwd}\`. Create the skill at \`${target}\` and run the creator's own validation (\`bash scripts/validate-skill.sh -s <skill-path>\`) before reporting success.`
        : `Working directory: \`${cwd}\`. Create the skill under \`${path.join(cwd, 'skills')}\`, choosing its directory name from the requirements per the creator's own naming rules, and run the creator's own validation before reporting success.`,
      '',
      'The requirements above are complete: start at the phase after requirements analysis and do not re-ask for values that are already given. Ask only when a value is genuinely required and missing, and then ask one question at a time.',
    ].join('\n');

    log(run, 'phase', `启动 ${current.skill} @ ${String(current.commit).slice(0, 8)}（session ${run.sessionId}）`);
    log(run, 'info', `工作目录 ${cwd} · preset ${agentPreset}`);
    log(run, 'info', target ? `目标目录 ${target}` : '目标目录由 creator 依据功能描述决定');
    // The message must be a real user turn (`role: 'user'` + fresh id), not a bare
    // {content, source} object, or the agent silently never runs.
    const message = createUserMessage([{ type: 'text', text: `${prompt}\n\n${EFFICIENCY_DIRECTIVES}\n\n${AUTONOMY_DIRECTIVES}` }]);
    agent.followup(message);
    log(run, 'info', `已投递用户消息 ${message.id}`);

    // The lifecycle runs detached: start() returns the live record immediately, and the
    // panel polls it through /run while creation, evaluation and fixing proceed.
    void runLifecycle(run, { agent }).catch((error) => failRun(run, String((error && error.message) || error)));

    return run;
  }

  function failRun(run, error) {
    run.status = 'failed';
    run.error = String(error);
    log(run, 'error', run.error);
  }

  /** creating → (evaluating → fixing)* → done | below-threshold. */
  async function runLifecycle(run, { agent }) {
    const creation = await waitForIdle(run, agent, 'creator');
    if (run.status === 'cancelled') return;
    if (!creation.ok) return failRun(run, creation.error);
    if (!creation.activity.sawActivity) {
      // Exactly how the first live run hid its failure: a rejected message leaves no trace.
      return failRun(run, 'agent 没有产生任何回合或工具调用（用户消息未被受理）');
    }
    run.phases = run.phases.map((p) => (p.state === 'active' || p.state === 'pending' ? { ...p, state: 'done' } : p));
    log(run, 'done', '创建阶段结束（creator 已空闲）');

    if (run.maxEvalRounds < 1) { run.status = 'done'; return; }
    // A generic/API run has no name, so the target was unknown at creation time. Discover
    // it from what the creator wrote instead of throwing the evaluation away.
    if (!run.target) {
      run.target = resolveSkillDir({
        paths: run.writtenPaths || [],
        steps: run.steps, cwd: run.cwd, startedAt: run.startedAt,
        exists: (p) => fs.existsSync(p),
        listSkills: () => listSkillDirs(path.join(run.cwd, 'skills')),
      });
      if (run.target) log(run, 'info', `评测目标目录（自动发现）${run.target}`);
    }
    if (!run.target) {
      log(run, 'warn', '目标目录未确定，跳过评测（creator 未写出 SKILL.md？）');
      run.status = 'done';
      return;
    }
    await evaluateRounds(run);
  }

  /** Every `<dir>/SKILL.md` under a root, with its mtime (bounded depth, never throws). */
  function listSkillDirs(base, depth = 0) {
    const out = [];
    let entries = [];
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { return out; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(base, entry.name);
      try { out.push({ dir, mtimeMs: fs.statSync(path.join(dir, 'SKILL.md')).mtimeMs }); } catch { /* not a skill */ }
      if (depth < 3) out.push(...listSkillDirs(dir, depth + 1));
    }
    return out;
  }

  /** Score the skill; below the pass line hand the deductions back to the same creator. */
  async function evaluateRounds(run) {
    while (true) {
      run.round += 1;
      const previousScore = run.score;
      run.status = 'evaluating';
      log(run, 'phase', `第 ${run.round}/${run.maxEvalRounds} 轮评测开始（通过线 ${run.passScore}/10）`);
      let outcome;
      try {
        outcome = await runEvaluation({ run, round: run.round });
      } catch (error) {
        return failRun(run, `评测失败：${String((error && error.message) || error)}`);
      }
      if (run.status === 'cancelled') return;

      const evaluation = outcome.evaluation;
      run.evaluations.push({
        round: run.round, total: evaluation.total, rawTotal: evaluation.rawTotal, dimensions: evaluation.dimensions,
        verdict: evaluation.verdict, deductions: evaluation.deductions, gates: evaluation.gates, at: Date.now(),
      });
      run.score = evaluation.total;
      run.dimensions = evaluation.dimensions;
      run.itemScores = evaluation.items;
      run.deductions = evaluation.deductions;
      run.checks = outcome.checks || null;
      run.metrics = outcome.metrics || null;
      if (run.baseline === null) run.baseline = outcome.metrics || null;

      log(run, evaluation.verdict === 'pass' ? 'eval-ok' : 'eval-bad',
        `第 ${run.round} 轮评测：${evaluation.total.toFixed(2)}/10 ${evaluation.verdict === 'pass' ? '✅ 达标' : '❌ 未达标'}`);
      for (const item of evaluation.deductions) log(run, 'warn', `扣分 ${item.item} -${item.points}：${item.reason}`);
      for (const gate of (evaluation.gates || []).filter((gate) => gate.ok === false)) {
        log(run, 'error', `本地门禁 ${gate.id} 未通过：${gate.detail}`);
      }
      if (evaluation.gateCapApplied) {
        log(run, 'warn', `门禁未过 → 本轮总分从 ${Number(evaluation.rawTotal).toFixed(2)} 压到 ${evaluation.total.toFixed(2)}（上限 ${evalLimits.gateScoreCap}）`);
      }

      if (evaluation.verdict === 'pass') {
        run.verdict = 'pass';
        run.status = 'done';
        run.report = formatEvaluationReport({ run, evaluations: run.evaluations, passScore: run.passScore, maxRounds: run.maxEvalRounds, gateScoreCap: evalLimits.gateScoreCap });
        log(run, 'done', `评测通过（${evaluation.total.toFixed(2)}/10，第 ${run.round} 轮）`);
        return;
      }

      // 提效：修复轮几乎没有提升（<0.2）时提前停止——再跑下去只是把 3 轮跑满。
      if (previousScore !== null && previousScore !== undefined && evaluation.total - previousScore < minImprovement) {
        run.verdict = "below-threshold";
        run.status = "below-threshold";
        run.report = formatEvaluationReport({ run, evaluations: run.evaluations, passScore: run.passScore, maxRounds: run.maxEvalRounds, gateScoreCap: evalLimits.gateScoreCap });
        log(run, "warn", `第 ${run.round} 轮从 ${Number(previousScore).toFixed(2)} 仅提升到 ${evaluation.total.toFixed(2)}（<0.2），提前停止`);
        return;
      }
      if (run.round >= run.maxEvalRounds) {
        run.verdict = 'below-threshold';
        run.status = 'below-threshold';
        run.error = `评测 ${evaluation.total.toFixed(2)}/10 低于通过线 ${run.passScore}，已达 ${run.maxEvalRounds} 轮上限`;
        run.report = formatEvaluationReport({ run, evaluations: run.evaluations, passScore: run.passScore, maxRounds: run.maxEvalRounds, gateScoreCap: evalLimits.gateScoreCap });
        log(run, 'error', run.error);
        log(run, 'info', '已生成评测报告（面板可展开查看）');
        return;
      }

      // Below the line with rounds left: send the itemised deductions back to the SAME
      // creator agent — it already holds the whole context, so a fix costs the least.
      run.status = 'fixing';
      const fixPrompt = `${EFFICIENCY_DIRECTIVES}\n\n${AUTONOMY_DIRECTIVES}\n\n${buildFixPrompt({ evaluation, round: run.round, maxRounds: run.maxEvalRounds, passScore: run.passScore })}`;
      const message = createUserMessage([{ type: 'text', text: fixPrompt }]);
      run.creatorAgent.followup(message);
      log(run, 'fix', `已把扣分明细交给 creator 就地修改（消息 ${message.id}）`);
      const fixed = await waitForIdle(run, run.creatorAgent, `creator 修改(第 ${run.round} 轮)`);
      if (run.status === 'cancelled') return;
      if (!fixed.ok) return failRun(run, fixed.error);
    }
  }

  /**
   * One evaluation round, for real: gather the local deterministic inputs, run the skill's
   * readonly/syntax cases through a dedicated evaluation agent, then score with the
   * platform rubric. Injected away in tests via `deps.runEvaluation`.
   */
  async function evaluateWithAgent({ run, round }) {
    const startedAt = Date.now();
    const skillDir = run.target;
    const files = readSkillFiles(skillDir);
    const safety = scanSkillSafety(files);
    // The skill's OWN fixture — not the evaluation agent's own test cases — is the only
    // admissible evidence for 「功能可用」 (it naturally wrote cases it knew would pass).
    const fixture = collectFixtureCases(skillDir, run.kind, { readonlyOnly: run.evalReadonlyOnly });
    const cases = fixture.cases;
    const { description } = descriptionFromFiles(files);

    let structural = null;
    try {
      structural = validateSkillPackage(skillDir, { mode: run.kind });
    } catch (error) {
      structural = { error: String((error && error.message) || error), issues: [] };
    }
    // `validateSkillPackage` publishes `level` (see validators.mjs `add(id, level, …)`); reading
    // `severity` here matched nothing, so the fallback always saw "0 errors" and handed the skill
    // the full 3 functional points whenever the evaluator produced no structured verdict.
    const structuralErrors = structural && Array.isArray(structural.issues)
      ? structural.issues.filter((issue) => issue.level === 'error').length
      : 0;
    // Local deterministic gates: any failure caps this round below the pass line (no agent).
    const gates = evaluateGates({
      kind: run.kind, files, fixture, structural, skillDir,
      creatorDir: run.creatorDir || '', strictStructure: evalLimits.strictStructureGate,
      runValidator: runSkillValidator,
    });

    const { agent, sessionId } = await spawnAgent(run, `eval-r${round}`);
    const prompt = buildEvaluationPrompt({
      kind: run.kind, skillName: descriptionFromFiles(files).name, skillPath: skillDir,
      cases, fixture, minFixtureCases: evalLimits.minFixtureCases,
      readonlyOnly: run.evalReadonlyOnly, creatorDir: run.creatorDir || '',
    });
    const message = createUserMessage([{ type: 'text', text: `${prompt}\n\n${EFFICIENCY_DIRECTIVES}\n\n${AUTONOMY_DIRECTIVES}` }]);
    agent.followup(message);
    log(run, 'info', `第 ${round} 轮评测 agent 已启动（session ${sessionId}，夹具 ${fixture.path || '(无)'} 只读用例 ${cases.length} 条）`);
    const failedGates = gates.filter((gate) => gate.ok === false);
    log(run, failedGates.length ? 'warn' : 'info',
      `本地门禁：${gates.map((gate) => `${gate.id}=${gate.ok === false ? 'FAIL' : gate.enforced === false ? 'skip' : 'ok'}`).join(' ')}`);
    const settled = await waitForIdle(run, agent, `评测 agent(第 ${round} 轮)`);

    const activity = activityOf(run, sessionId);
    const parsed = settled.ok ? parseEvaluationOutput(activity.tail) : null;
    const endedAt = Date.now();
    const metrics = metricsFromEvents(run.sessionEvents.get(sessionId) || [], { startedAt, endedAt });

    // Functional usability: the skill's fixture evidence, or nothing. There is NO fallback to
    // "the structure validator looked fine" — that is what used to hand out 3 free points.
    const assessed = assessFunctionalEvidence({
      cases: parsed ? parsed.cases : [], fixture, minFixtureCases: evalLimits.minFixtureCases,
    });
    const checks = {
      functionalUsable: assessed.usable,
      functionalEvidence: parsed
        ? assessed.evidence
        : `无评测 agent 结构化结论（${settled.ok ? '未输出结构化结果' : settled.error}）；${assessed.evidence}`
          + `；本地结构校验 error ${structuralErrors} 项（由本地门禁单独判定，不再替代功能证据）`,
      triggerSufficiency: parsed && parsed.triggerSufficiency !== null
        ? parsed.triggerSufficiency
        : triggerSufficiencyFromDescription(description),
      structuralErrors,
      fixture: { kind: fixture.kind, path: fixture.path, present: fixture.present, cases: fixture.cases.length, error: fixture.error },
      fixtureExecuted: assessed.fixtureExecuted,
      gates,
      cases: parsed ? parsed.cases : cases,
      notes: parsed ? parsed.notes : '',
    };
    const evaluation = scoreEvaluation({
      checks, metrics, baseline: run.baseline, safety, passScore: run.passScore, limits: evalLimits,
    });
    run.checks = checks;
    run.limits = evalLimits;
    return { evaluation, metrics, checks, safety, gates, cases: checks.cases, evalSessionId: sessionId };
  }

  function snapshot(run) {
    return {
      id: run.id, sessionId: run.sessionId, kind: run.kind, creator: run.creator, commit: run.commit,
      spec: run.spec,
      cwd: run.cwd, target: run.target, agentPreset: run.agentPreset, permission: run.permission,
      status: run.status, error: run.error || '', phase: run.phase, phases: run.phases,
      steps: run.steps, startedAt: run.startedAt, updatedAt: run.updatedAt,
      turn: run.turn, step: run.step, lastActivityAt: run.lastActivityAt || null,
      // evaluation state
      round: run.round, maxEvalRounds: run.maxEvalRounds, passScore: run.passScore,
      verdict: run.verdict, score: run.score, dimensions: run.dimensions, itemScores: run.itemScores,
      deductions: run.deductions || [], evaluations: run.evaluations || [], report: run.report || '',
      checks: run.checks || null, metrics: run.metrics || null, baseline: run.baseline || null,
    };
  }

  function list() {
    reap();
    return [...runs.values()].sort((a, b) => b.startedAt - a.startedAt).map((r) => ({
      id: r.id, kind: r.kind, status: r.status, phase: r.phase, startedAt: r.startedAt, spec: r.spec,
      round: r.round, score: r.score ?? null, verdict: r.verdict ?? null, maxEvalRounds: r.maxEvalRounds,
    }));
  }

  function get(id) {
    const run = runs.get(String(id));
    return run ? snapshot(run) : null;
  }

  async function cancel(id) {
    const run = runs.get(String(id));
    if (!run || !run.handles || !run.handles.length) return false;
    for (const timer of run.timers || []) clearTimeout(timer);
    if (run.timers) run.timers.clear();
    for (const handle of run.handles) {
      try { handle.agent.cancel({ kind: 'plugin', reason: 'cancelled from the panel' }); } catch { /* already stopped */ }
      try { await handle.dispose(); } catch { /* ignore */ }
    }
    run.status = 'cancelled';
    log(run, 'warn', '已取消');
    return true;
  }

  function disposeAll() {
    for (const run of runs.values()) {
      for (const timer of run.timers || []) clearTimeout(timer);
      for (const handle of run.handles || []) {
        try { handle.agent.cancel({ kind: 'plugin', reason: 'plugin unloading' }); } catch { /* ignore */ }
        try { handle.dispose?.(); } catch { /* ignore */ }
      }
    }
    // The shared listeners belong to this runner instance, not to one run.
    try { offStream(); } catch { /* ignore */ }
    try { offSessions(); } catch { /* ignore */ }
    // Persist what we have FIRST: clearing before flushing wrote an empty file on every
    // shutdown, which is how every creation record disappeared across restarts.
    clearTimeout(flushTimer);
    flush();
    runs.clear();
  }

  return { start, get, list, cancel, disposeAll, runs };
}