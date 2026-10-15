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
 * The scoring core. `checks` carries what the eval agent observed, `metrics` the run
 * counters, `baseline` the previous round's counters (null on the first round ⇒ 自基线),
 * `safety` the local rule scan. Mirrors `scorer.score()` exactly, minus platform gates.
 */
export function scoreEvaluation({ checks = {}, metrics = {}, baseline = null, safety = null, passScore = DEFAULT_PASS_SCORE } = {}) {
  const firstRun = baseline === null || baseline === undefined;
  const items = [];
  const deductions = [];
  const metricsOf = (source, key) => {
    const value = source ? Number(source[key]) : NaN;
    return Number.isFinite(value) ? value : 0;
  };
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
  const tokenDelta = firstRun ? 0 : metricsOf(metrics, 'tokenTotal') - metricsOf(baseline, 'tokenTotal');
  push({
    id: 3, category: '成本评估', dimension: 'cost', itemName: '消耗总token',
    maxScore: 1, score: firstRun ? 1 : (withinTolerance(metricsOf(metrics, 'tokenTotal'), metricsOf(baseline, 'tokenTotal')) ? 1 : 0),
    detail: firstRun
      ? `首轮即基线：${metricsOf(metrics, 'tokenTotal')} tokens`
      : `本轮 ${metricsOf(metrics, 'tokenTotal')} vs 基线 ${metricsOf(baseline, 'tokenTotal')} tokens（容差 ${(TOLERANCE * 100).toFixed(0)}%，超出 ${tokenDelta > 0 ? `+${tokenDelta}` : tokenDelta}）`,
  });

  // ── 效率 2 = 8 × 0.25 ────────────────────────────────────────────────────
  RUBRIC.filter((item) => item.dimension === 'efficiency').forEach((item, index) => {
    const key = EFFICIENCY_KEYS[index];
    const current = metricsOf(metrics, key);
    const base = firstRun ? null : metricsOf(baseline, key);
    const ok = firstRun || withinTolerance(current, base);
    push({
      id: item.id, category: item.category, dimension: 'efficiency', itemName: item.itemName,
      maxScore: item.maxScore, score: ok ? item.maxScore : 0,
      detail: firstRun
        ? `首轮即基线：${key}=${current}`
        : `${key} ${current} vs 基线 ${base}（容差 ${(TOLERANCE * 100).toFixed(0)}%）`,
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

  const total = Number(items.reduce((sum, item) => sum + item.score, 0).toFixed(2));
  const dimensions = items.reduce((acc, item) => {
    acc[item.dimension] = Number(((acc[item.dimension] || 0) + item.score).toFixed(2));
    return acc;
  }, { stability: 0, cost: 0, efficiency: 0, security: 0 });
  const pass = Number(passScore);
  return {
    total,
    maxTotal: MAX_TOTAL,
    passScore: pass,
    firstRun,
    verdict: total >= pass ? 'pass' : 'fail',
    dimensions,
    items,
    deductions,
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
// Evaluation agent: prompt, output contract, parser, fix prompt, report
// ─────────────────────────────────────────────────────────────────────────────

export const EVAL_RESULT_OPEN = '<!-- eval-result -->';
export const EVAL_RESULT_CLOSE = '<!-- /eval-result -->';

/** Prompt for the evaluation agent. Read-only by construction: write cases are excluded. */
export function buildEvaluationPrompt({ kind, skillName, skillPath, cases = [], readonlyOnly = true, creatorDir = '' } = {}) {
  const lines = [
    `你是「技能评测员」。评测对象是一个刚生成的 ${kind === 'huawei' ? '华为云' : kind === 'api' ? 'REST API' : '通用'} skill，目录：\`${skillPath}\``,
    '',
    '要求：',
    '1. 只做评测，**绝对不要修改被评测 skill 的任何文件**（发现问题只记录，不修复）。',
    `2. 读该 skill 的 \`SKILL.md\`，按它自己的说明**真实执行**下面列出的用例${readonlyOnly ? '（只跑只读/语法用例，禁止执行任何写操作）' : ''}。`,
    '3. 每条用例记录：命令、退出码、关键输出（截断到 300 字符）、结论。',
    '4. 命令不存在或环境缺失（缺 CLI / 缺凭据）时，结论记为 `skipped` 并写明原因；不要把"环境缺失"当成"功能失败"。',
    '',
  ];
  if (cases.length) {
    lines.push(`只读/语法用例（共 ${cases.length} 条）：`);
    for (const item of cases) lines.push(`- [${item.type || 'readonly'}] ${item.id || ''} ${item.command || item.name || ''}`);
  } else {
    lines.push('没有找到 `templates/test-vars.json` 的只读用例：自行从 `SKILL.md` 的「Core Commands / 真实命令区」挑选**只读**命令执行（只读：List/Show/Get/Describe/查询类，语法检查用 `bash -n`）。');
  }
  lines.push(
    '',
    '另外评估「触发词充足度」：SKILL.md 的 frontmatter description 里列出的触发词数量，按 `min(1, 触发词数/4)` 给出 0~1 的比例。',
    '',
    '完成后，输出**恰好一个** JSON 对象，放在下面的标记之间（不要有多余文字）：',
    EVAL_RESULT_OPEN,
    '{"functionalUsable":true,"triggerSufficiency":1.0,"cases":[{"id":"TC-01","command":"...","status":"pass|fail|skipped","evidence":"..."}],"notes":"..."}',
    EVAL_RESULT_CLOSE,
    '`functionalUsable` = 只读/语法用例中没有任何 fail（skipped 不算 fail）。',
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
  lines.push(
    '',
    '各维度得分：',
    `- 稳定性 ${Number(evaluation?.dimensions?.stability ?? 0).toFixed(2)}/4`,
    `- 成本 ${Number(evaluation?.dimensions?.cost ?? 0).toFixed(2)}/1`,
    `- 效率 ${Number(evaluation?.dimensions?.efficiency ?? 0).toFixed(2)}/2`,
    `- 安全 ${Number(evaluation?.dimensions?.security ?? 0).toFixed(2)}/3`,
    '',
    '修改要点（按扣分项对应处理）：',
    '- 功能可用失分：确保 SKILL.md 里的只读命令**真实可执行**（必要时修参数/区域/服务名），并保留可验证的证据。',
    '- 触发词不足：在 frontmatter description 里补足触发短语（建议 ≥4 条，中英文各覆盖）。',
    '- 成本/效率失分：减少不必要的反复探测、合并重复命令、不要重复调用同一工具。',
    '- 安全失分：移除任何硬编码凭据；写操作必须在 SKILL.md 中要求人工确认；不要直接调用其它 skill。',
  );
  return lines.join('\n');
}

/** The run's human-readable evaluation report (persisted on the run, shown in the panel). */
export function formatEvaluationReport({ run = {}, evaluations = [], passScore = DEFAULT_PASS_SCORE, maxRounds = DEFAULT_MAX_EVAL_ROUNDS } = {}) {
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

/** The only cases this evaluator is allowed to run: readonly + syntax. */
export function readReadonlyCases(dir, { readonlyOnly = true, limit = 20 } = {}) {
  for (const rel of ['templates/test-vars.json', 'templates/test-defaults.json']) {
    const file = path.join(dir || '', rel);
    if (!dir || !fs.existsSync(file)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const cases = Array.isArray(parsed.test_cases) ? parsed.test_cases : [];
      const wanted = readonlyOnly ? cases.filter((item) => ['readonly', 'syntax'].includes(String(item.type || '').toLowerCase())) : cases;
      return wanted.slice(0, limit).map((item) => ({
        id: String(item.id || ''), name: String(item.name || ''), command: String(item.command || ''),
        expected: String(item.expected || ''), type: String(item.type || 'readonly'), executor: String(item.executor || 'cli'),
      }));
    } catch { /* fall through to the next candidate */ }
  }
  return [];
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
