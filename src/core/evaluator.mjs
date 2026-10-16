/**
 * Skill evaluation — the 「评测打分」 half of the pipeline.
 *
 * The rubric is NOT invented here: it is `skill-verify-leader`'s, copied so a local score
 * means the same thing as a platform score.
 *   `scripts/eval/config.py`  → EVAL_ITEMS (12 items, 10 points: 稳定性 4 + 成本 1 + 效率 2 + 安全 3)
 *   `scripts/eval/scorer.py`  → `score()` / `within_tolerance()` / per-item rules
 *   `gate_signals.py`         → 外部门禁扣分 (platform-only → SKIPPED, see PLATFORM_SIGNALS_SKIPPED)
 * Grading bands: =10 技能满分, [8,10) 优质技能; this plugin passes at >= 8.5/10.
 *
 * Everything in this module is a PURE function so the scoring maths and the metrics
 * reduction are unit-testable without a Harness runtime. The only fs access lives in the
 * `read*` helpers at the bottom, which the runner calls to gather inputs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatterLenient } from '../lib/yaml.mjs';

/** Platform tolerance: cost/efficiency only punish overspend, never underspend. */
export const TOLERANCE = 0.10;
/** The platform's score is out of 10; the panel's pass line is 8.5 (the user's "85 分"). */
export const MAX_TOTAL = 10;
export const DEFAULT_PASS_SCORE = 8.5;
export const DEFAULT_MAX_EVAL_ROUNDS = 3;

/** `config.py` EVAL_ITEMS, verbatim (id / category / item_name / max_score / dimension). */
export const RUBRIC = [
  { id: 1, category: '稳定性评估', itemName: '功能可用', maxScore: 3, dimension: 'stability' },
  { id: 2, category: '稳定性评估', itemName: '触发词充足度', maxScore: 1, dimension: 'stability' },
  { id: 3, category: '成本评估', itemName: '消耗总token', maxScore: 1, dimension: 'cost' },
  { id: 4, category: '效率评估', itemName: '完成时间', maxScore: 0.25, dimension: 'efficiency' },
  { id: 5, category: '效率评估', itemName: '工具失败次数', maxScore: 0.25, dimension: 'efficiency' },
  { id: 6, category: '效率评估', itemName: '重试次数', maxScore: 0.25, dimension: 'efficiency' },
  { id: 7, category: '效率评估', itemName: 'cli调用次数', maxScore: 0.25, dimension: 'efficiency' },
  { id: 8, category: '效率评估', itemName: 'sdk调用次数', maxScore: 0.25, dimension: 'efficiency' },
  { id: 9, category: '效率评估', itemName: 'api调用次数', maxScore: 0.25, dimension: 'efficiency' },
  { id: 10, category: '效率评估', itemName: 'LLM调用次数', maxScore: 0.25, dimension: 'efficiency' },
  { id: 11, category: '效率评估', itemName: '上下文上限是否压缩', maxScore: 0.25, dimension: 'efficiency' },
  { id: 12, category: '安全评估', itemName: '安全性', maxScore: 3, dimension: 'security' },
];

/** Item 4..11 are scored by comparing these keys against the baseline. */
export const EFFICIENCY_KEYS = [
  'durationSeconds', 'toolFailCount', 'retryCount',
  'cliCallCount', 'sdkCallCount', 'apiCallCount', 'llmCallCount', 'contextCompressed',
];

/** Dimensions must add up to 10 — asserted by the tests, mirrored in the panel. */
export const DIMENSION_MAX = { stability: 4, cost: 1, efficiency: 2, security: 3 };

/**
 * Absolute ceilings for the cost/efficiency dimensions (`config.run` keys).
 *
 * Why they exist: the platform's cost/efficiency items are graded against a DATABASE BASELINE
 * plus outer gates we do not have. Copying the formula without the baseline made every
 * first-round cost/efficiency item an unconditional full mark, so three real runs scored the
 * same 10.00/10 and the "below 8.5 → send it back" loop never fired once. Absolute ceilings
 * give every round a falsifiable bound; the relative (baseline) comparison is kept on top of
 * them, so round 2+ still only punishes overspending against round 1.
 *
 * Defaults are grounded in the observed magnitudes of three real evaluation rounds
 * (token 23965 / 28550 / 38999 / 39617; duration 42.5 / 58.2 / 65.75 / 394.1 s;
 * tool calls 4-8; cli 2-6; llm 4-6; tool failures 0; retries 0): every ceiling sits well
 * above a healthy round, so they fire on runaway rounds only.
 */
export const DEFAULT_EVAL_LIMITS = {
  /** One evaluation round: total (input+output) tokens. */
  evalTokenBudget: 50000,
  /** One evaluation round: wall-clock seconds. */
  evalDurationCapSeconds: 600,
  /** One evaluation round: tool calls of any kind. */
  evalMaxToolCalls: 20,
  /** One evaluation round: LLM (assistant) turns. */
  evalMaxLlmCalls: 20,
  /** Per-category call counts (cli / sdk / api). */
  evalMaxCliCalls: 20,
  evalMaxSdkCalls: 20,
  evalMaxApiCalls: 20,
  /** Absolute: a round with a failed tool call or a retry loses that item outright. */
  evalMaxToolFailures: 0,
  evalMaxRetries: 0,
  /** Functional evidence: how many fixture cases must actually be executed. */
  minFixtureCases: 3,
  /** Any failing local gate caps the total here (below any sane pass line). */
  gateScoreCap: 7.0,
  /** `true` = apply the Huawei repo's structure rules to every kind, verbatim. */
  strictStructureGate: false,
};

/** Merge `config.run` over the defaults (unknown/garbage values are ignored, never throw). */
export function resolveEvalLimits(config = {}) {
  const out = { ...DEFAULT_EVAL_LIMITS };
  for (const key of Object.keys(DEFAULT_EVAL_LIMITS)) {
    const raw = config ? config[key] : undefined;
    if (raw === undefined || raw === null || raw === '') continue;
    if (key === 'strictStructureGate') { if (typeof raw === 'boolean') out[key] = raw; continue; }
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 0) out[key] = value;
  }
  return out;
}

/** Which absolute ceiling belongs to which efficiency item (`null` = boolean item). */
export const EFFICIENCY_LIMITS = {
  durationSeconds: 'evalDurationCapSeconds',
  toolFailCount: 'evalMaxToolFailures',
  retryCount: 'evalMaxRetries',
  cliCallCount: 'evalMaxCliCalls',
  sdkCallCount: 'evalMaxSdkCalls',
  apiCallCount: 'evalMaxApiCalls',
  llmCallCount: 'evalMaxLlmCalls',
  contextCompressed: null,
};

/** The per-category call items that also inherit the TOTAL tool-call ceiling. */
const TOOL_COUNT_KEYS = new Set(['cliCallCount', 'sdkCallCount', 'apiCallCount']);

/**
 * The test fixtures each creator actually writes into the skill it generates (checked against
 * the products under `<cwd>/skills`, not guessed):
 *   huawei  → templates/test-vars.json   (`test_cases[]`, `type: readonly|syntax|write`)
 *             templates/test-defaults.json (fallback; request defaults, usually no cases)
 *   api     → templates/test-vars.json   (`test_cases[]`, `category: readonly`, `method`)
 *   generic → evals/evals.json           (`evals[]`, prompt/expected_output/files/assertions)
 * A kind whose creator wrote none of these is recorded as "无夹具" and fails the gate —
 * that is the point: no fixture, no functional evidence.
 */
export const FIXTURE_PATHS = {
  huawei: ['templates/test-vars.json', 'templates/test-defaults.json'],
  api: ['templates/test-vars.json'],
  generic: ['evals/evals.json'],
};

/**
 * Top-level entries each creator legitimately writes. The Huawei repo's rule ("2.2") only
 * knows SKILL.md/references/scripts/templates/demo, so the other creators' own layout
 * (api: requirements.txt; generic: evals/, assets/) is allowed here instead of being
 * reported as a structure error. Anything else — e.g. generic leftovers `phase-N-summary.json`,
 * which the creator's own Step 6 is supposed to delete — stays a gate failure.
 */
export const KIND_ALLOWED_TOP = {
  huawei: ['SKILL.md', 'references', 'scripts', 'templates', 'demo'],
  api: ['SKILL.md', 'references', 'scripts', 'templates', 'requirements.txt'],
  generic: ['SKILL.md', 'references', 'scripts', 'templates', 'assets', 'evals'],
};

/** Error-level check ids whose rules are Huawei-repo-only (still reported, not gating). */
export const NON_HUAWEI_EXEMPT_ERROR_IDS = ['top-level', 'no-external-links', 'relative-refs'];

/**
 * Signals this local evaluator cannot see. They are reported, never guessed, and their
 * deductions are NOT applied (the platform's `gate_signals.py` owns them).
 */
export const PLATFORM_SIGNALS_SKIPPED = [
  '外部门禁扣分（skills_test 测试结论 / skills_bot 审查结论）',
  'pr / simulate 模式的功能可用扣分上限',
  'CodeArts / Hermes 运行时导出（本评测用同一会话的 usage 与工具事件代替）',
  '上下文压缩事件（本地不可观测，按"未压缩"计入，不扣分）',
];

/** `scorer.py within_tolerance`: 只罚超支，不罚更省；baseline 0 表示无参照，恒通过。 */
export function withinTolerance(current, baseline, tolerance = TOLERANCE) {
  const base = Number(baseline);
  if (!Number.isFinite(base) || base === 0) return true;
  const value = Number(current);
  if (!Number.isFinite(value)) return false;
  return value <= base * (1 + tolerance);
}

/** `scorer.py _score_item_2` (满分 1.0): >1 视为命中次数语义，0..1 视为比例语义。 */
export function scoreTriggerSufficiency(value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return 0;
  if (v > 1) {
    if (v >= 4) return 1;
    if (v >= 1) return 0.5;
    return 0;
  }
  if (v >= 0.8) return 1;
  if (v >= 0.4) return 0.5;
  return 0;
}

/** `gate_signals.py` security rules: 高危 ≥1 → -3.0；告警 ≥2 → -2.0；告警 =1 → -1.0。 */
export function securityDeduction({ high = 0, warnings = 0 } = {}) {
  if (high >= 1) return 3;
  if (warnings >= 2) return 2;
  if (warnings === 1) return 1;
  return 0;
}

/** How many trigger phrases a description advertises → the 0..1 ratio semantics. */
export function triggerSufficiencyFromDescription(description) {
  const body = String(description || '');
  if (!body.trim()) return 0;
  // Both creators list triggers after "Triggers include:" as quoted phrases; a description
  // without that block still counts its bullet/quote-like fragments.
  const tail = body.split(/Triggers include:/i).pop() || body;
  const quoted = tail.match(/["“”'']([^"“”'']{2,40})["“”'']/g) || [];
  const candidates = quoted.length ? quoted : (tail.match(/[\u4e00-\u9fa5A-Za-z][^,，、\n]{3,30}/g) || []);
  const count = new Set(candidates.map((s) => s.replace(/["“”'']/g, '').trim())).size;
  return Math.min(1, count / 4);
}

/**
 * The scoring core. `checks` carries what the eval agent observed (`functionalUsable` +
 * `checks.gates`, both decided outside: see `assessFunctionalEvidence` / `evaluateGates`),
 * `metrics` the run counters, `baseline` the previous round's counters (null on the first
 * round), `safety` the local rule scan, `limits` the absolute ceilings. Weights are the
 * platform's, unchanged; what differs from the platform is the INPUT (absolute ceilings
 * instead of a database baseline) and the local gates.
 */
export function scoreEvaluation({
  checks = {}, metrics = {}, baseline = null, safety = null,
  passScore = DEFAULT_PASS_SCORE, limits = null,
} = {}) {
  const caps = resolveEvalLimits(limits || {});
  const firstRun = baseline === null || baseline === undefined;
  const items = [];
  const deductions = [];
  const metricsOf = (source, key) => {
    const value = source ? Number(source[key]) : NaN;
    return Number.isFinite(value) ? value : 0;
  };
  const capOf = (key) => Number(caps[EFFICIENCY_LIMITS[key]]);
  /** Absolute ceiling: true when the value is within it (a ceiling of 0 means "must be 0"). */
  const withinCap = (value, cap) => Number.isFinite(cap) && value <= cap;
  const push = (entry) => {
    items.push(entry);
    const gap = Number((entry.maxScore - entry.score).toFixed(2));
    if (gap > 0) deductions.push({ item: entry.itemName, dimensions: entry.dimension, points: gap, reason: entry.detail });
  };

  // ── 稳定性 4 = 功能可用 3 + 触发词充足度 1 ────────────────────────────────
  const usable = checks.functionalUsable === true;
  push({
    id: 1, category: '稳定性评估', dimension: 'stability', itemName: '功能可用',
    maxScore: 3, score: usable ? 3 : 0,
    detail: usable
      ? (checks.functionalEvidence || '只读/语法用例全部通过')
      : (checks.functionalEvidence || '功能未验证通过（只读/语法用例存在失败或缺少证据）'),
  });
  const triggerScore = scoreTriggerSufficiency(checks.triggerSufficiency ?? 0);
  push({
    id: 2, category: '稳定性评估', dimension: 'stability', itemName: '触发词充足度',
    maxScore: 1, score: triggerScore,
    detail: `触发词比例 ${Number(checks.triggerSufficiency ?? 0).toFixed(2)}（≥0.8 满分 / ≥0.4 半分）`,
  });

  // ── 成本 1 ────────────────────────────────────────────────────────────────
  // Absolute ceiling ALWAYS applies; the relative (baseline) rule is added from round 2.
  const tokens = metricsOf(metrics, 'tokenTotal');
  const tokenCap = Number(caps.evalTokenBudget);
  const tokenAbsOk = withinCap(tokens, tokenCap);
  const tokenRelOk = firstRun || withinTolerance(tokens, metricsOf(baseline, 'tokenTotal'));
  const tokenDelta = firstRun ? 0 : tokens - metricsOf(baseline, 'tokenTotal');
  push({
    id: 3, category: '成本评估', dimension: 'cost', itemName: '消耗总token',
    maxScore: 1, score: tokenAbsOk && tokenRelOk ? 1 : 0,
    detail: firstRun
      ? `${tokens} tokens / 绝对上限 ${tokenCap}${tokenAbsOk ? '（未超预算）' : ' → 超预算，首轮不再白送'}`
      : `本轮 ${tokens} vs 基线 ${metricsOf(baseline, 'tokenTotal')} tokens（容差 ${(TOLERANCE * 100).toFixed(0)}%，超出 ${tokenDelta > 0 ? `+${tokenDelta}` : tokenDelta}）`
        + `；绝对上限 ${tokenCap}（本轮 ${tokenAbsOk ? '未超' : '超出'}）`,
  });

  // ── 效率 2 = 8 × 0.25 ────────────────────────────────────────────────────
  // Same shape as cost: absolute ceiling first, baseline comparison on top (never punishes
  // spending less). The tool-call items additionally inherit the TOTAL tool-call ceiling:
  // a round that fans out past `evalMaxToolCalls` has no claim to "调用次数" points.
  const totalToolCalls = metricsOf(metrics, 'toolCalls');
  const toolVolumeOk = withinCap(totalToolCalls, Number(caps.evalMaxToolCalls));
  RUBRIC.filter((item) => item.dimension === 'efficiency').forEach((item, index) => {
    const key = EFFICIENCY_KEYS[index];
    const current = metricsOf(metrics, key);
    const base = firstRun ? null : metricsOf(baseline, key);
    const relOk = firstRun || withinTolerance(current, base);
    let absOk;
    let absDetail;
    if (EFFICIENCY_LIMITS[key] === null) {
      absOk = Number(current) === 0;
      absDetail = `未压缩 ${absOk ? '✅' : '❌'}（本地不可观测，按事件推断）`;
    } else {
      const cap = capOf(key);
      absOk = withinCap(current, cap) && (TOOL_COUNT_KEYS.has(key) ? toolVolumeOk : true);
      absDetail = `${key}=${current} / 上限 ${cap}`;
      if (Number(current) > cap) absDetail += ' → 超上限';
      if (!toolVolumeOk && TOOL_COUNT_KEYS.has(key)) absDetail += `；工具调用总量 ${totalToolCalls} 超上限 ${caps.evalMaxToolCalls}`;
    }
    push({
      id: item.id, category: item.category, dimension: 'efficiency', itemName: item.itemName,
      maxScore: item.maxScore, score: absOk && relOk ? item.maxScore : 0,
      detail: firstRun
        ? `首轮无基线，按绝对上限判定：${absDetail}`
        : `${absDetail}；基线 ${base}（容差 ${(TOLERANCE * 100).toFixed(0)}%，${relOk ? '未超支' : '超支'}）`,
    });
  });

  // ── 安全 3 = 3 − 本地规则扣分（平台侧安全扫描为 0，见 PLATFORM_SIGNALS_SKIPPED）──
  const secDeduct = securityDeduction(safety || {});
  const findings = (safety && safety.findings) || [];
  push({
    id: 12, category: '安全评估', dimension: 'security', itemName: '安全性',
    maxScore: 3, score: Number(Math.max(0, 3 - secDeduct).toFixed(2)),
    detail: findings.length
      ? `本地规则扫描：高危 ${(safety && safety.high) || 0} 项、告警 ${(safety && safety.warnings) || 0} 项 → 扣 ${secDeduct}；${findings.slice(0, 3).map((f) => f.rule).join('；')}`
      : '本地规则扫描未发现问题（硬编码凭据 / 写操作确认 / 跨 skill 直连）',
  });

  // ── 本地门禁：任一不过 → 总分压到 gateScoreCap，确保 verdict !== 'pass' ──────
  // These are deterministic, agent-free checks (SKILL.md/frontmatter, the kind's own test
  // fixture, the local structure validator, the Huawei creator's validate-skill.sh).
  const gates = Array.isArray(checks.gates) ? checks.gates.filter((gate) => gate && typeof gate === 'object') : [];
  const failedGates = gates.filter((gate) => gate.ok === false);
  const rawTotal = Number(items.reduce((sum, item) => sum + item.score, 0).toFixed(2));
  let total = rawTotal;
  if (failedGates.length) {
    const cap = Number.isFinite(Number(caps.gateScoreCap)) ? Number(caps.gateScoreCap) : DEFAULT_EVAL_LIMITS.gateScoreCap;
    if (total > cap) total = cap;
    // The deduction row only appears when the cap actually bit; otherwise the gate failures are
    // already listed in `gates` (report + fix prompt) and a 0-point row would just be noise.
    if (rawTotal > total) {
      deductions.push({
        item: '本地门禁', dimensions: 'gates', points: Number((rawTotal - total).toFixed(2)),
        reason: `未通过：${failedGates.map((gate) => `${gate.id}（${gate.detail || '无明细'}）`).join('；')}`
          + `；总分上限 ${cap}`,
      });
    }
  }
  total = Number(total.toFixed(2));
  const dimensions = items.reduce((acc, item) => {
    acc[item.dimension] = Number(((acc[item.dimension] || 0) + item.score).toFixed(2));
    return acc;
  }, { stability: 0, cost: 0, efficiency: 0, security: 0 });
  const pass = Number(passScore);
  return {
    total,
    rawTotal,
    maxTotal: MAX_TOTAL,
    passScore: pass,
    firstRun,
    verdict: total >= pass ? 'pass' : 'fail',
    dimensions,
    items,
    deductions,
    gates,
    gateCapApplied: failedGates.length > 0 && total < rawTotal,
    limits: caps,
    safety: safety || { high: 0, warnings: 0, findings: [] },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Metrics: reduce the session event feed into the counters the rubric consumes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Local classification of one tool call, ported from `config.py` LOG_PATTERNS
 * (`sdk_call` / `api_call` / `cli_call`). Order matters: the first match wins, so an SDK
 * import that also mentions hcloud is counted as SDK, not CLI.
 */
export function classifyToolCall(text) {
  const body = String(text || '');
  if (/huaweicloudsdk|hwcloudsdk|\[SDK\]/i.test(body)) return 'sdk';
  if (/\[API\]|https?:\/\/[a-z0-9.-]*huaweicloud\.com|curl\s+[^\n]*https?:\/\//i.test(body)) return 'api';
  if (/\bhcloud\s+[A-Za-z]|skill-quality-cli|\bgit\s+\w|\bpwsh\b|\bbash\b/i.test(body)) return 'cli';
  return null;
}

/** Retries are consecutive identical tool invocations (what the repeat-reminder catches). */
export function countConsecutiveRetries(signatures = []) {
  let retries = 0;
  for (let i = 1; i < signatures.length; i++) if (signatures[i] === signatures[i - 1]) retries++;
  return retries;
}

/**
 * Reduce `session/event` entries into the metric shape the rubric consumes.
 * Local substitutions for platform-only signals are documented in the returned `sources`.
 */
export function metricsFromEvents(events = [], { startedAt, endedAt } = {}) {
  let inputTokens = 0;
  let outputTokens = 0;
  let llmCallCount = 0;
  let toolCalls = 0;
  let toolFailCount = 0;
  let errorCount = 0;
  let contextCompressed = false;
  const signatures = [];
  let cliCallCount = 0;
  let sdkCallCount = 0;
  let apiCallCount = 0;

  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== 'object') continue;
    const data = event.data || {};
    switch (event.type) {
      case 'assistant/message': {
        llmCallCount += 1;
        const usage = data.usage || {};
        inputTokens += Number(usage.inputTokens) || 0;
        outputTokens += Number(usage.outputTokens) || 0;
        break;
      }
      case 'tool/call': {
        toolCalls += 1;
        const signature = `${data.name || ''}|${data.arguments || ''}`;
        signatures.push(signature);
        const kind = classifyToolCall(`${data.name || ''} ${data.arguments || ''}`);
        if (kind === 'cli') cliCallCount += 1;
        else if (kind === 'sdk') sdkCallCount += 1;
        else if (kind === 'api') apiCallCount += 1;
        break;
      }
      case 'tool/result': {
        if (data.error || (data.message && data.message.isError)) toolFailCount += 1;
        break;
      }
      case 'agent/error':
      case 'turn/error': {
        errorCount += 1;
        break;
      }
      default: {
        if (/compact/i.test(String(event.type))) contextCompressed = true;
      }
    }
  }

  const started = Number(startedAt);
  const ended = Number(endedAt);
  const durationSeconds = Number.isFinite(started) && Number.isFinite(ended) && ended >= started
    ? Number(((ended - started) / 1000).toFixed(2))
    : 0;

  return {
    tokenTotal: inputTokens + outputTokens,
    inputTokens,
    outputTokens,
    durationSeconds,
    toolCalls,
    toolFailCount,
    retryCount: countConsecutiveRetries(signatures),
    cliCallCount,
    sdkCallCount,
    apiCallCount,
    llmCallCount,
    errorCount,
    contextCompressed,
    sources: ['token=assistant/message.usage', 'tool失败=tool/result.error', '重试=连续重复工具调用', '调用分类=本地 LOG_PATTERNS 移植'],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Local rule scan: the security dimension without the platform's PR audit
// ─────────────────────────────────────────────────────────────────────────────

const SECRET_ASSIGNMENT = /(access[-_ ]?key|secret[-_ ]?key|ak|sk|password|passwd|token|api[-_ ]?key)\s*[:=]\s*(['"])([^'"\n]{8,})\2/gi;
const SAFE_VALUE = /\$\{|\$env:|process\.env|os\.environ|getenv|<[^>]+>|xxx|your[-_ ]|placeholder|example|\*{3,}/i;
const WORK_OP = /\bhcloud\s+\w+\s+(?:Create|Delete|Update|Put|Post|Modify|Batch)\w*|curl\s+[^\n]*-X\s*(?:POST|PUT|PATCH|DELETE)/i;
const CONFIRM = /(确认|人工确认|等待确认|confirm|ask the user|二次确认)/i;
const CROSS_SKILL = /(?:skill\s*\(\s*['"`]?|--skill-name\s+['"`]?|loads?\s+the\s+['"`]?)([a-z0-9-]{6,})/gi;

/** Scan a skill package's text files. `files` is `{ relPath: text }` — no fs here. */
export function scanSkillSafety(files = {}) {
  const findings = [];
  const entries = Object.entries(files);
  const skillName = entries.find(([rel]) => /(^|\/)SKILL\.md$/.test(rel));
  const selfName = skillName ? (String(skillName[1]).match(/^---[\s\S]*?\bname:\s*([^\n]+)/) || [])[1]?.trim() : undefined;

  for (const [rel, raw] of entries) {
    const text = String(raw || '');
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) {
      findings.push({ severity: 'high', rule: 'private-key-material', path: rel, detail: '包含私钥材料' });
    }
    for (const match of text.matchAll(SECRET_ASSIGNMENT)) {
      if (SAFE_VALUE.test(match[3])) continue;
      findings.push({ severity: 'high', rule: 'hardcoded-credential', path: rel, detail: `疑似硬编码凭据：${match[1]}=***` });
      break; // one finding per file is enough to trigger the platform's rule
    }
    if (/--cli-(access|secret)-key=/.test(text)) {
      findings.push({ severity: 'high', rule: 'credential-on-command-line', path: rel, detail: '命令行内联凭据' });
    }
    if (/(^|\/)SKILL\.md$/.test(rel) && WORK_OP.test(text) && !CONFIRM.test(text)) {
      findings.push({ severity: 'warning', rule: 'write-op-without-confirmation', path: rel, detail: '存在写操作命令但未要求确认' });
    }
    for (const match of text.matchAll(CROSS_SKILL)) {
      const target = match[1];
      if (selfName && target === selfName) continue;
      if (!/^(huawei-cloud|common|rest-api|skill)-/.test(target)) continue;
      findings.push({ severity: 'warning', rule: 'cross-skill-direct-call', path: rel, detail: `直接调用其它 skill：${target}` });
      break;
    }
  }
  const high = findings.filter((f) => f.severity === 'high').length;
  const warnings = findings.filter((f) => f.severity === 'warning').length;
  return { high, warnings, findings };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures (per kind) · functional evidence · local gates
// ─────────────────────────────────────────────────────────────────────────────

/** Parse one fixture file into the case shape this evaluator consumes. */
function fixtureCasesFrom(parsed, rel, { readonlyOnly = true, limit = 20 } = {}) {
  const isEvalList = Array.isArray(parsed && parsed.evals);
  const list = isEvalList ? parsed.evals : (Array.isArray(parsed && parsed.test_cases) ? parsed.test_cases : []);
  const cases = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    if (cases.length >= limit) break;
    const declared = String(item.type || item.category || '').toLowerCase();
    // Write / mutating cases never reach the evaluator at all. The REST-API creator labels a
    // case's HTTP verb in `method` (NONE/GET/…/POST/DELETE) while `category` may still say
    // "readonly", so BOTH signals are honoured.
    const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(item.method || '').toUpperCase());
    if (readonlyOnly && declared && !['readonly', 'syntax'].includes(declared)) continue;
    if (readonlyOnly && mutating) continue;
    cases.push({
      id: String(item.id ?? `TC-${cases.length + 1}`),
      name: String(item.name || ''),
      type: declared || (isEvalList ? 'eval' : 'readonly'),
      // `command` cases carry an executable command (huawei/api test-vars.json);
      // `prompt` cases carry a task + expected_output (generic evals/evals.json).
      shape: isEvalList ? 'prompt' : 'command',
      command: String(item.command || ''),
      prompt: String(item.prompt || ''),
      expected: String(item.expected || item.expected_output || ''),
      files: Array.isArray(item.files) ? item.files.map(String) : [],
      assertions: Array.isArray(item.assertions) ? item.assertions.map(String) : [],
      executor: String(item.executor || ''),
      source: rel,
      fixture: true,
    });
  }
  return cases;
}

/**
 * The evaluated skill's OWN test fixture, per kind (see FIXTURE_PATHS). Returns
 * `{kind, paths, path, present, error, cases}` — never throws, and an absent/unparseable
 * fixture is reported as `present: false` (which fails gate `fixtures` and, on its own,
 * forbids the functional points).
 */
export function collectFixtureCases(dir, kind, { readonlyOnly = true, limit = 20 } = {}) {
  const paths = FIXTURE_PATHS[kind] || FIXTURE_PATHS.huawei;
  const out = { kind, paths, path: null, present: false, error: '', cases: [] };
  for (const rel of paths) {
    const file = path.join(dir || '', rel);
    if (!dir || !fs.existsSync(file)) continue;
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { out.error = `${rel} 无法解析：${(error && error.message) || error}`; continue; }
    const cases = fixtureCasesFrom(parsed, rel, { readonlyOnly, limit });
    if (!cases.length) { out.error = out.error || `${rel} 中没有可用用例`; continue; }
    out.path = rel;
    out.present = true;
    out.cases = cases;
    out.error = '';
    break;
  }
  return out;
}

/**
 * B: the 3 「功能可用」 points are decided by EXTERNAL evidence, not by the evaluation
 * agent's own test cases (it writes them after seeing the skill work, so they passed by
 * construction — 12/13, 13/13, 17/17 in three live runs). All of the following must hold:
 *   1. ≥ `minFixtureCases` cases **from the skill's own fixture** were actually EXECUTED
 *      (status pass|fail — `skipped` is not execution; the callers mark self-written cases
 *      with `fixture: false`, and they can never supply these points);
 *   2. every executed fixture case carries evidence (command/prompt + observed result +
 *      comparison against the expectation, which the prompt demands per case);
 *   3. nothing failed — a `fail` anywhere (fixture or supplementary) is a functional failure.
 */
export function assessFunctionalEvidence({ cases = [], fixture = null, minFixtureCases = DEFAULT_EVAL_LIMITS.minFixtureCases } = {}) {
  const all = (Array.isArray(cases) ? cases : []).filter((item) => item && typeof item === 'object');
  const fromFixture = all.filter((item) => item.fixture === true);
  const executed = fromFixture.filter((item) => item.status === 'pass' || item.status === 'fail');
  const hasEvidence = (item) => Boolean(String(item.command || item.prompt || '').trim()) && Boolean(String(item.evidence || '').trim());
  const withoutEvidence = executed.filter((item) => !hasEvidence(item));
  const failed = all.filter((item) => item.status === 'fail');
  const min = Math.max(1, Number(minFixtureCases) || DEFAULT_EVAL_LIMITS.minFixtureCases);
  const selfAuthored = all.length - fromFixture.length;
  const fixtureList = (fixture && Array.isArray(fixture.paths) ? fixture.paths : []).join(' / ') || '（无清单）';

  let usable = false;
  let evidence = '';
  if (!fixture || fixture.present !== true) {
    evidence = `仅自编用例，无 skill 夹具证据：未找到可解析的 ${(fixture && fixture.kind) || ''} 夹具 ${fixtureList}`
      + `${fixture && fixture.error ? `（${fixture.error}）` : ''} → 功能可用 = 0；自编用例只能作为补充，不能单独支撑这 3 分`;
  } else if (executed.length < min) {
    const total = Array.isArray(fixture.cases) ? fixture.cases.length : 0;
    evidence = `夹具 ${fixture.path} 中的用例实际执行 ${executed.length} 条 < 下限 ${min} 条`
      + `（夹具共 ${total} 条，评测 agent 报告 fixture 用例 ${fromFixture.length} 条；skipped 不计入"已执行"）`
      + `→ 功能性证据不足，功能可用 = 0`;
  } else if (withoutEvidence.length) {
    evidence = `夹具用例 ${withoutEvidence.map((item) => item.id).join('、')} 缺少证据（需执行命令 + 观测结果 + 与期望的对比结论）→ 功能可用 = 0`;
  } else if (failed.length) {
    evidence = `存在 fail 用例：${failed.map((item) => item.id).join('、')}（夹具证据 ${executed.length}/${fromFixture.length} 条已执行）→ 功能可用 = 0`;
  } else {
    usable = true;
    evidence = `skill 夹具 ${fixture.path}：${executed.length}/${fromFixture.length} 条用例已执行且带证据，无 fail`
      + (selfAuthored > 0 ? `（另有 ${selfAuthored} 条评测 agent 自编补充用例，不作为达标依据）` : '');
  }
  return {
    usable, evidence,
    fixturePath: (fixture && fixture.path) || null,
    fixtureCases: fromFixture.length,
    fixtureExecuted: executed.length,
    selfAuthored,
  };
}

/**
 * E: local, deterministic gates — no agent involved, either they pass or the score is capped.
 *
 *   skill-md         SKILL.md exists and its frontmatter parses with name + description
 *   fixtures         the kind's own test fixture exists and parses with ≥1 case
 *   structure        `validateSkillPackage` reports 0 error-level issues (the field is
 *                    `level`, NOT `severity`), scoped to the rules that apply to the kind
 *   creator-validate huawei only: the creator's `scripts/validate-skill.sh` runs with no FAIL
 *                    (unrunnable → recorded as a warning, not a gate)
 *
 * `runValidator` is injected so the script execution stays out of the pure logic (and out of
 * the unit tests): it receives `{ script, skillDir, creatorDir }` and returns
 * `{ ran, ok, detail }`; `ran: false` means "could not execute" → warning.
 */
export function evaluateGates({
  kind = 'huawei', files = {}, fixture = null, structural = null, skillDir = '',
  creatorDir = '', strictStructure = false, runValidator = null,
} = {}) {
  const gates = [];

  // 1 · SKILL.md + frontmatter
  const skillEntry = Object.entries(files).find(([rel]) => /(^|\/)SKILL\.md$/.test(rel));
  const fm = skillEntry ? parseFrontmatterLenient(String(skillEntry[1] || '')) : { ok: false, data: {}, error: 'SKILL.md 不存在' };
  const name = String(((fm.data || {}).name) || '').trim();
  const description = String(((fm.data || {}).description) || '').trim();
  const skillOk = Boolean(skillEntry) && fm.ok === true && Boolean(name) && Boolean(description);
  gates.push({
    id: 'skill-md', ok: skillOk,
    detail: skillOk
      ? `SKILL.md frontmatter 可解析（name=${name}，description ${description.length} 字符）`
      : `SKILL.md / frontmatter 不合规：${!skillEntry ? 'SKILL.md 缺失' : fm.ok !== true ? `YAML 无法解析（${fm.error}）` : !name ? 'frontmatter 缺 name' : 'frontmatter 缺 description'}`,
  });

  // 2 · the kind's own test fixture
  const fixtureOk = Boolean(fixture && fixture.present === true && Array.isArray(fixture.cases) && fixture.cases.length);
  gates.push({
    id: 'fixtures', ok: fixtureOk,
    detail: fixtureOk
      ? `${kind} 夹具 ${fixture.path} 可解析（${fixture.cases.length} 条只读用例）`
      : `未找到可解析的 ${kind} 夹具：${(fixture && Array.isArray(fixture.paths) ? fixture.paths : (FIXTURE_PATHS[kind] || [])).join(' / ')}`
        + `${fixture && fixture.error ? `（${fixture.error}）` : ''}`,
  });

  // 3 · structure: error-level issues only (`level`, not `severity`), scoped per kind
  const issues = structural && Array.isArray(structural.issues) ? structural.issues : [];
  const errors = issues.filter((issue) => issue && issue.level === 'error');
  const exempt = new Set(strictStructure || kind === 'huawei' ? [] : NON_HUAWEI_EXEMPT_ERROR_IDS);
  const counted = errors.filter((issue) => !exempt.has(issue.id));
  // Top-level entries are re-checked against what THIS kind's creator may write: the Huawei
  // rule set does not know `requirements.txt` (api) or `evals/` (generic), and flagging them
  // would fail every non-Huawei skill forever.
  const allowedTop = new Set(KIND_ALLOWED_TOP[kind] || KIND_ALLOWED_TOP.huawei);
  const badTop = [...new Set(Object.keys(files || {}).map((rel) => String(rel).split('/')[0]))]
    .filter((top) => !allowedTop.has(top));
  const structureOk = !(structural && structural.error) && counted.length === 0 && badTop.length === 0;
  const structureParts = [];
  if (counted.length) structureParts.push(`validateSkillPackage error ${counted.length} 项：${counted.slice(0, 4).map((issue) => issue.id).join('、')}`);
  if (badTop.length) structureParts.push(`不允许的顶层条目 ${badTop.join('、')}（${kind} 允许 ${[...allowedTop].join(' / ')}）`);
  if (structural && structural.error) structureParts.push(`结构校验异常：${structural.error}`);
  gates.push({
    id: 'structure', ok: structureOk,
    detail: structureOk
      ? `validateSkillPackage error 0 项${errors.length - counted.length > 0 ? `（另 ${errors.length - counted.length} 项为其它 kind 不适用规则，仅记录）` : ''}`
      : structureParts.join('；') || '结构校验未通过',
  });

  // 4 · huawei only: the creator's own validate-skill.sh must not report FAIL
  if (kind === 'huawei') {
    const script = path.join(creatorDir || '', 'scripts', 'validate-skill.sh');
    const present = Boolean(creatorDir) && fs.existsSync(script);
    if (!present) {
      gates.push({ id: 'creator-validate', ok: true, enforced: false, detail: 'warning: creator 未提供 scripts/validate-skill.sh，跳过（不作为门禁）' });
    } else if (typeof runValidator !== 'function') {
      gates.push({ id: 'creator-validate', ok: true, enforced: false, detail: 'warning: 本次运行没有可用的 bash 执行通道（或未注入），跳过 creator validate-skill.sh（不作为门禁）' });
    } else {
      let verdict = { ran: false, detail: '未返回结果' };
      try { verdict = runValidator({ script, skillDir, creatorDir }) || verdict; }
      catch (error) { verdict = { ran: false, detail: `执行失败：${(error && error.message) || error}` }; }
      if (verdict.ran !== true) {
        gates.push({ id: 'creator-validate', ok: true, enforced: false, detail: `warning: ${verdict.detail || 'creator 校验脚本无法执行'}（不作为门禁）` });
      } else {
        gates.push({
          id: 'creator-validate', ok: verdict.ok !== false, enforced: true,
          detail: verdict.detail || (verdict.ok === false ? 'creator validate-skill.sh 报 FAIL' : 'creator validate-skill.sh 无 FAIL'),
        });
      }
    }
  }

  return gates;
}

// ─────────────────────────────────────────────────────────────────────────────
// Evaluation agent: prompt, output contract, parser, fix prompt, report
// ─────────────────────────────────────────────────────────────────────────────

export const EVAL_RESULT_OPEN = '<!-- eval-result -->';
export const EVAL_RESULT_CLOSE = '<!-- /eval-result -->';

/**
 * Prompt for the evaluation agent. Read-only by construction, and — since the agent's own
 * cases always passed (it writes them after seeing the skill work) — it must lead with the
 * skill's OWN fixture: those cases are the only admissible evidence for the 3 functional
 * points (see `assessFunctionalEvidence`).
 */
export function buildEvaluationPrompt({
  kind, skillName, skillPath, cases = [], readonlyOnly = true, creatorDir = '',
  fixture = null, minFixtureCases = DEFAULT_EVAL_LIMITS.minFixtureCases,
} = {}) {
  const list = fixture && Array.isArray(fixture.cases) && fixture.cases.length ? fixture.cases : (Array.isArray(cases) ? cases : []);
  const fixturePath = (fixture && fixture.path) || (list.length ? (list[0].source || '') : '');
  const min = Math.max(1, Number(minFixtureCases) || DEFAULT_EVAL_LIMITS.minFixtureCases);
  const lines = [
    `你是「技能评测员」。评测对象是一个刚生成的 ${kind === 'huawei' ? '华为云' : kind === 'api' ? 'REST API' : '通用'} skill，目录：\`${skillPath}\``,
    '',
    '要求：',
    '1. 只做评测，**绝对不要修改被评测 skill 的任何文件**（发现问题只记录，不修复）。',
    '2. **必须优先执行该 skill 自带的测试夹具**——这是「功能可用」的唯一达标依据：',
  ];
  if (list.length) {
    lines.push(`   夹具文件：\`${fixturePath || '(skill 自带夹具)'}\`，共 ${list.length} 条可用用例（只读/语法；写操作已剔除）：`);
    for (const item of list) {
      const id = item.id || '';
      const source = item.shape === 'prompt' ? 'prompt' : (item.type || 'readonly');
      if (item.shape === 'prompt') {
        lines.push(`   - [${source}] ${id} 任务：${String(item.prompt || item.name || '').slice(0, 300)}`);
        if (item.expected) lines.push(`     期望：${String(item.expected).slice(0, 300)}`);
        if (item.files && item.files.length) lines.push(`     输入文件：${item.files.join('、')}`);
        if (item.assertions && item.assertions.length) lines.push(`     断言：${item.assertions.join('；').slice(0, 300)}`);
      } else {
        lines.push(`   - [${source}] ${id} ${item.command || item.name || ''}`);
        if (item.expected) lines.push(`     期望：${String(item.expected).slice(0, 300)}`);
      }
    }
    lines.push(`   至少真实执行其中 ${min} 条（skipped 不算已执行）；夹具用例不足 ${min} 条或缺少证据 → \`functionalUsable\` 必须为 false。`);
  } else {
    lines.push(`   **没有找到该 skill 自带的夹具**（按 kind 的清单查找${fixture && Array.isArray(fixture.paths) ? `：${fixture.paths.join(' / ')}` : ''}${fixture && fixture.error ? `，原因：${fixture.error}` : ''}）：`,
      '   请如实把 `functionalUsable` 记为 false，并在 `notes` 里写明"无 skill 夹具证据"。');
  }
  lines.push(
    '3. 每条夹具用例记录证据：**执行命令** + **观测结果**（退出码 / 关键输出片段，截断到 300 字符）+ **与期望的对比结论**。',
    `4. ${readonlyOnly ? '只跑只读/语法用例，禁止执行任何写操作' : '按需执行用例'}（只读：List/Show/Get/Describe/查询类；语法检查用 \`bash -n\`）。`,
    '5. 命令不存在或环境缺失（缺 CLI / 缺凭据）时，结论记为 `skipped` 并写明原因；**skipped 不计入"已执行"**，也不要把"环境缺失"当成"功能失败"。',
    `6. 夹具用例存在 \`fail\` → \`functionalUsable\` = false（没有例外）。`,
    '7. 你**自己补充**的用例只能作为补充：标记 `"fixture": false`，**不能单独支撑「功能可用」这 3 分**；没有夹具证据时请如实记 false，不要用自编用例凑达标。',
    '',
    '另外评估「触发词充足度」：SKILL.md 的 frontmatter description 里列出的触发词数量，按 `min(1, 触发词数/4)` 给出 0~1 的比例。',
    '',
    '完成后，输出**恰好一个** JSON 对象，放在下面的标记之间（不要有多余文字）：',
    EVAL_RESULT_OPEN,
    '{"functionalUsable":true,"triggerSufficiency":1.0,"cases":[{"id":"TC-01","fixture":true,"command":"...","status":"pass|fail|skipped","evidence":"命令 + 退出码/输出片段 + 与期望的对比结论"}],"notes":"..."}',
    EVAL_RESULT_CLOSE,
    '`fixture` = 该用例是否来自 skill 自带夹具（自编用例写 false）；`functionalUsable` = 夹具用例实际执行 ≥' + `${min} 条、每条都有证据、且没有任何 fail。`,
  );
  if (creatorDir) lines.push('', `（参考：该 skill 的生成者是 \`${creatorDir}\`，评测时不需要它。）`);
  return lines.join('\n');
}

/** Extract the structured result from an evaluation agent's accumulated text. */
export function parseEvaluationOutput(text) {
  const body = String(text || '');
  const candidates = [];
  const marked = body.match(new RegExp(`${EVAL_RESULT_OPEN}([\\s\\S]*?)${EVAL_RESULT_CLOSE}`));
  if (marked) candidates.push(marked[1]);
  const fenced = [...body.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  candidates.push(...fenced.reverse());
  const trailing = body.lastIndexOf('{');
  if (trailing >= 0) candidates.push(body.slice(trailing));

  for (const candidate of candidates) {
    const trimmed = String(candidate).trim().replace(/^json\s*/i, '');
    const start = trimmed.indexOf('{');
    if (start < 0) continue;
    try {
      const parsed = JSON.parse(trimmed.slice(start));
      if (!parsed || typeof parsed !== 'object') continue;
      const cases = Array.isArray(parsed.cases) ? parsed.cases.map((item) => ({
        id: String(item?.id ?? ''),
        command: String(item?.command ?? ''),
        // The prompt asks for `fixture: true` on cases taken from the skill's own fixture;
        // only those can carry the 3 functional points (see assessFunctionalEvidence).
        fixture: item?.fixture === true || item?.source === 'fixture',
        status: ['pass', 'fail', 'skipped'].includes(item?.status) ? item.status : 'skipped',
        evidence: String(item?.evidence ?? '').slice(0, 400),
      })) : [];
      const ratio = Number(parsed.triggerSufficiency);
      return {
        functionalUsable: parsed.functionalUsable !== false && !cases.some((item) => item.status === 'fail'),
        triggerSufficiency: Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : null,
        cases,
        notes: String(parsed.notes ?? '').slice(0, 600),
      };
    } catch { /* try the next candidate */ }
  }
  return null;
}

/** Followup message that sends the creator back to work, with the exact deductions. */
export function buildFixPrompt({ evaluation, round = 1, maxRounds = DEFAULT_MAX_EVAL_ROUNDS, passScore = DEFAULT_PASS_SCORE } = {}) {
  const lines = [
    `评测结果：**${Number(evaluation?.total ?? 0).toFixed(2)}/10**，低于通过线 ${passScore}（这是第 ${round}/${maxRounds} 轮评测）。`,
    '请**就地修改**你刚生成的 skill（同一个目录，不要换目录、不要重新问需求），只针对下面的扣分项改进，改完即停止。',
    '',
    '扣分明细：',
  ];
  for (const item of evaluation?.deductions || []) lines.push(`- ${item.item}（-${item.points}）：${item.reason}`);
  if (!(evaluation?.deductions || []).length) lines.push('- （无明细）请对照评分口径自查：功能可用 / 触发词充足度 / 成本 / 效率 / 安全');
  const failedGates = (evaluation?.gates || []).filter((gate) => gate && gate.ok === false);
  if (failedGates.length) {
    lines.push('', `**本地门禁未通过（总分已被压到 ${evaluation?.limits ? evaluation.limits.gateScoreCap : DEFAULT_EVAL_LIMITS.gateScoreCap} 上限，必须先修）**：`);
    for (const gate of failedGates) lines.push(`- ${gate.id}：${gate.detail}`);
    lines.push('门禁是本地确定性检查（不依赖评测 agent）：SKILL.md 与 frontmatter、该 kind 自带的测试夹具、结构校验 error、华为云 creator 的 validate-skill.sh。');
  }
  lines.push(
    '',
    '各维度得分：',
    `- 稳定性 ${Number(evaluation?.dimensions?.stability ?? 0).toFixed(2)}/4`,
    `- 成本 ${Number(evaluation?.dimensions?.cost ?? 0).toFixed(2)}/1`,
    `- 效率 ${Number(evaluation?.dimensions?.efficiency ?? 0).toFixed(2)}/2`,
    `- 安全 ${Number(evaluation?.dimensions?.security ?? 0).toFixed(2)}/3`,
    '',
    '修改要点（按扣分项对应处理）：',
    '- 功能可用失分：**补齐并保留该 kind 自带的测试夹具**（华为云/标准API：`templates/test-vars.json` 的 `test_cases`；通用：`evals/evals.json` 的 `evals`），确保其中 ≥3 条只读/语法用例真实可执行、每条都能给出命令与观测结果。缺少夹具、夹具用例不足或没有证据都会直接 0 分。',
    '- 触发词不足：在 frontmatter description 里补足触发短语（建议 ≥4 条，中英文各覆盖）。',
    '- 成本/效率失分：对照绝对上限（token/时长/工具与 LLM 调用次数）与首轮基线，减少不必要的反复探测、合并重复命令、不要重复调用同一工具；工具失败与重试必须为 0。',
    '- 安全失分：移除任何硬编码凭据；写操作必须在 SKILL.md 中要求人工确认；不要直接调用其它 skill。',
    '- 门禁失分：按上面每条 gate 的说明修（frontmatter 补 name/description、补齐夹具文件、修结构校验 error、清理不该留在技能包里的临时文件）。',
  );
  return lines.join('\n');
}

/** The run's human-readable evaluation report (persisted on the run, shown in the panel). */
export function formatEvaluationReport({ run = {}, evaluations = [], passScore = DEFAULT_PASS_SCORE, maxRounds = DEFAULT_MAX_EVAL_ROUNDS, gateScoreCap = null } = {}) {
  const last = evaluations[evaluations.length - 1];
  const lines = [
    `# 技能评测报告`,
    '',
    `- 技能：${(run.spec && (run.spec.name || run.spec.description)) || run.id}`,
    `- 路径：${run.target || '(未确定)'}`,
    `- 类型：${run.kind}　创建者：${run.creator}@${String(run.commit || '').slice(0, 8)}`,
    `- 结论：${last && last.verdict === 'pass' ? '✅ 达标' : '❌ 未达标'}　最终得分：${last ? last.total.toFixed(2) : '-'}/10　通过线：${passScore}`,
    `- 轮次：${evaluations.length}/${maxRounds}`,
    '',
    '## 各轮得分',
    '| 轮次 | 总分 | 稳定性/4 | 成本/1 | 效率/2 | 安全/3 | 结论 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const item of evaluations) {
    lines.push(`| ${item.round} | ${item.total.toFixed(2)} | ${item.dimensions.stability.toFixed(2)} | ${item.dimensions.cost.toFixed(2)} | ${item.dimensions.efficiency.toFixed(2)} | ${item.dimensions.security.toFixed(2)} | ${item.verdict === 'pass' ? '达标' : '未达标'} |`);
  }
  if (last) {
    lines.push('', '## 末轮明细', '| # | 指标 | 满分 | 得分 | 说明 |', '| --- | --- | --- | --- | --- |');
    for (const item of last.items || []) lines.push(`| ${item.id} | ${item.itemName} | ${item.maxScore} | ${item.score} | ${String(item.detail || '').replace(/\|/g, '/')} |`);
    if ((last.deductions || []).length) {
      lines.push('', '## 扣分明细');
      for (const item of last.deductions) lines.push(`- ${item.item}（-${item.points}）：${item.reason}`);
    }
  }
  // The local gates are what make a below-8.5 verdict deterministic: list them every round.
  const lastGates = (last && Array.isArray(last.gates)) ? last.gates : [];
  if (lastGates.length) {
    const gateCap = Number.isFinite(Number(gateScoreCap)) ? Number(gateScoreCap) : DEFAULT_EVAL_LIMITS.gateScoreCap;
    lines.push('', `## 本地门禁（任一不过 → 总分上限 ${gateCap}）`, '| 门禁 | 结论 | 明细 |', '| --- | --- | --- |');
    for (const gate of lastGates) {
      lines.push(`| ${gate.id} | ${gate.ok === false ? '❌ 未通过' : gate.enforced === false ? '⚠️ 跳过（warning）' : '✅ 通过'} | ${String(gate.detail || '').replace(/\|/g, '/')} |`);
    }
  }
  lines.push('', '## 未纳入（平台侧信号缺失）');
  for (const item of PLATFORM_SIGNALS_SKIPPED) lines.push(`- ${item}`);
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// fs helpers (the only impure part; the runner calls them)
// ─────────────────────────────────────────────────────────────────────────────

const TEXT_EXT = /\.(md|markdown|txt|json|json5|ya?ml|toml|js|cjs|mjs|ts|tsx|jsx|py|sh|ps1|cfg|conf|ini|env|properties|html|css|xml|sql|csv)$/i;
const MAX_FILES = 200;
const MAX_BYTES = 256 * 1024;

/** Read a skill package's text files as `{ relPath: text }` (bounded, never throws). */
export function readSkillFiles(dir, { maxFiles = MAX_FILES, maxBytes = MAX_BYTES } = {}) {
  const out = {};
  const walk = (current, prefix) => {
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (Object.keys(out).length >= maxFiles) return;
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) { walk(abs, rel); continue; }
      if (!TEXT_EXT.test(entry.name)) continue;
      try {
        if (fs.statSync(abs).size > maxBytes) continue;
        out[rel] = fs.readFileSync(abs, 'utf8');
      } catch { /* unreadable file: skip */ }
    }
  };
  if (dir && fs.existsSync(dir)) walk(dir, '');
  return out;
}

/**
 * The only cases this evaluator is allowed to run: readonly + syntax.
 *
 * Thin wrapper over `collectFixtureCases` (kind `huawei`, whose path list covers both
 * `templates/test-vars.json` and `templates/test-defaults.json`) kept for callers/tests that
 * only want the executable command cases.
 */
export function readReadonlyCases(dir, { readonlyOnly = true, limit = 20 } = {}) {
  const fixture = collectFixtureCases(dir, 'huawei', { readonlyOnly, limit });
  return fixture.cases
    .filter((item) => item.shape === 'command')
    .map((item) => ({
      id: item.id, name: item.name, command: item.command, expected: item.expected,
      type: item.type, executor: item.executor,
    }));
}

/** Frontmatter description of a `{ relPath: text }` map (for the local trigger fallback). */
export function descriptionFromFiles(files = {}) {
  const skill = Object.entries(files).find(([rel]) => /(^|\/)SKILL\.md$/.test(rel));
  if (!skill) return { name: '', description: '' };
  const body = String(skill[1] || '');
  const front = body.startsWith('---') ? body.slice(3, body.indexOf('\n---', 3)) : '';
  const name = (front.match(/^\s*name:\s*(.+)$/m) || [])[1];
  let description = (front.match(/^\s*description:\s*(.*)$/m) || [])[1] || '';
  if (/^[|>]/.test(description.trim())) {
    // YAML block scalar (`description: |`): the value is the indented block that follows.
    const start = front.indexOf(description) + description.length;
    const block = [];
    for (const line of front.slice(start).split('\n').slice(1)) {
      if (!line.trim()) { block.push(''); continue; }
      if (!/^\s+\S/.test(line)) break;
      block.push(line.trim());
    }
    description = block.join('\n').trim();
  } else {
    description = description.trim().replace(/^['"]|['"]$/g, '');
  }
  return { name: name ? name.trim().replace(/^['"]|['"]$/g, '') : '', description };
}

/**
 * Discover where a creator actually wrote its skill.
 *
 * Generic and REST-API runs carry no name, so the target cannot be known up front — the
 * creator picks the directory. Evaluation needs that path, and skipping because it is
 * "undetermined" throws the whole evaluation stage away (a live generic run finished
 * `status=done`, `round=0`, no score, for exactly this reason). The path is recoverable
 * from evidence the run already holds:
 *   1. absolute paths the creator wrote (its tool calls are in `run.steps`) → the deepest
 *      ancestor that holds a SKILL.md;
 *   2. otherwise a scan under `<cwd>/skills` for a SKILL.md newer than the run started.
 * `exists`/`listSkills` are injected so the rule is testable without touching the disk.
 */
export function resolveSkillDir({ paths = [], steps = [], cwd = '', startedAt = 0, exists = () => false, listSkills = () => [] } = {}) {
  const root = path.resolve(cwd || '.');
  const inside = (p) => {
    const rel = path.relative(root, p);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  const candidates = new Set();
  // Recorded verbatim by the runner when a tool call carried one: untruncated, unlike the log.
  for (const p of paths) {
    const abs = path.resolve(String(p || ''));
    if (inside(abs)) candidates.add(abs);
  }
  for (const step of steps) {
    const text = typeof step === 'string' ? step : step && step.text;
    if (!text) continue;
    for (const m of String(text).matchAll(/[A-Za-z]:\\[^\s"',;)]+|\/(?:[\w.@-]+\/)+[\w.@-]+/g)) candidates.add(path.resolve(m[0]));
  }
  for (const candidate of [...candidates].sort((a, b) => b.length - a.length)) {
    let dir = path.dirname(candidate);
    while (inside(dir)) {
      if (exists(path.join(dir, 'SKILL.md'))) return dir;
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  const scanned = listSkills()
    .filter((entry) => !startedAt || (entry.mtimeMs || 0) >= startedAt - 1000)
    .sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
  return scanned.length ? path.resolve(scanned[0].dir) : null;
}

/**
 * Efficiency contract injected into the creation and fix prompts.
 *
 * Measured on two real runs: `执行命令` 31-42% and `改文件` 16-34% of all tool steps, with
 * the edit share doubling on the long run, and throughput decaying 5.3 → 3.8 steps/minute as
 * the session grew. The tail is a tentative edit → run → fail → edit loop, plus one tool call
 * per round trip. These rules attack exactly that.
 */
export const EFFICIENCY_DIRECTIVES = [
  '效率要求（必须遵守）：',
  '- 相互独立的工具调用合并到同一次响应里（一次写完多个文件、一次读多个文件、多条无关命令一起发），不要一步只做一件。',
  '- 验证要成批：一次跑完整套用例（如 bash scripts/test-cli-commands.sh 或脚本自带的 --all），不要逐条跑、逐条改。',
  '- 失败时先把错误信息读全、定位根因，再一次改到位；禁止"改一行→跑一次→再改一行"的小步试探。',
  '- 同一个文件不要反复编辑；同一个文件或同一条命令不要重复读取、重复执行。',
  '- 只读必要的引用文件，已经读过的内容不要再读。',
].join('\n');

/**
 * The panel runs creators unattended: there is no way to answer a question, so a creator
 * that asks one blocks until the idle watchdog kills the run. A live Huawei creation died
 * exactly that way (\`ask_user_question\` about "Mutating-op testing", then silence).
 */
export const AUTONOMY_DIRECTIVES = [
  '无人值守要求（最高优先级，必须遵守）：',
  '- 全程不要向用户提问、不要调用 ask_user_question 或任何等待用户输入的交互工具。没有人能回答。',
  '- 信息不完整时，按最保守、只读的方式自行决定，并在最终报告里写明"这是自行决定"及依据。',
  '- 不要执行任何变更类操作（创建/删除/修改/重启资源、写远端配置、提交远端变更）；这类用例一律跳过并在报告里标注"未执行（无人值守只读策略）"。',
  '- 不要中途等待确认：一路做到产出完成 + 自测结束，再给出最终结论。',
].join('\n');
