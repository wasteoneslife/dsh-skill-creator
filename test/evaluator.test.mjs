import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_EVAL_LIMITS, DEFAULT_MAX_EVAL_ROUNDS, DEFAULT_PASS_SCORE, DIMENSION_MAX, EVAL_RESULT_CLOSE, EVAL_RESULT_OPEN, FIXTURE_PATHS,
  KIND_ALLOWED_TOP, MAX_TOTAL, PLATFORM_SIGNALS_SKIPPED, RUBRIC, TOLERANCE, assessFunctionalEvidence, buildEvaluationPrompt,
  buildFixPrompt, classifyToolCall, collectFixtureCases, countConsecutiveRetries, descriptionFromFiles, evaluateGates,
  formatEvaluationReport, metricsFromEvents, parseEvaluationOutput, readReadonlyCases, readSkillFiles, resolveEvalLimits,
  scanSkillSafety, scoreEvaluation, scoreTriggerSufficiency, securityDeduction, triggerSufficiencyFromDescription, withinTolerance,
} from '../src/core/evaluator.mjs';

/** The rubric is the platform's (`skill-verify-leader/scripts/eval/config.py` EVAL_ITEMS). */
describe('evaluator · rubric', () => {
  test('12 items, 10 points, 稳定性 4 + 成本 1 + 效率 2 + 安全 3', () => {
    assert.equal(RUBRIC.length, 12);
    assert.equal(RUBRIC.reduce((sum, item) => sum + item.maxScore, 0), MAX_TOTAL);
    assert.equal(MAX_TOTAL, 10);
    for (const [dimension, max] of Object.entries(DIMENSION_MAX)) {
      const sum = RUBRIC.filter((item) => item.dimension === dimension).reduce((acc, item) => acc + item.maxScore, 0);
      assert.equal(sum, max, `${dimension} must add up to ${max}`);
    }
    assert.deepEqual(RUBRIC.slice(0, 3).map((item) => [item.itemName, item.maxScore]), [['功能可用', 3], ['触发词充足度', 1], ['消耗总token', 1]]);
    assert.equal(RUBRIC[11].itemName, '安全性');
    assert.equal(DEFAULT_PASS_SCORE, 8.5);
    assert.equal(DEFAULT_MAX_EVAL_ROUNDS, 3);
    assert.equal(TOLERANCE, 0.10);
  });
});

describe('evaluator · 平台口径移植', () => {
  test('within_tolerance 只罚超支，不罚更省；基线 0 恒通过', () => {
    assert.equal(withinTolerance(100, 100), true);
    assert.equal(withinTolerance(110, 100), true, 'exactly +10% is still inside the tolerance');
    assert.equal(withinTolerance(111, 100), false);
    assert.equal(withinTolerance(50, 100), true, '更省永远通过');
    assert.equal(withinTolerance(999, 0), true, 'baseline 0 = 无参照，恒通过');
    assert.equal(withinTolerance(1, null), true);
  });

  test('触发词充足度按比例语义（0.8/0.4 两档），>1 时按命中次数语义', () => {
    assert.equal(scoreTriggerSufficiency(1), 1);
    assert.equal(scoreTriggerSufficiency(0.8), 1);
    assert.equal(scoreTriggerSufficiency(0.79), 0.5);
    assert.equal(scoreTriggerSufficiency(0.4), 0.5);
    assert.equal(scoreTriggerSufficiency(0.39), 0);
    // >1 = 命中次数语义（旧口径，仍需兼容）
    assert.equal(scoreTriggerSufficiency(4), 1);
    assert.equal(scoreTriggerSufficiency(2), 0.5);
    assert.equal(scoreTriggerSufficiency(0.5), 0.5);
  });

  test('安全扣分：高危 ≥1 → -3；告警 ≥2 → -2；告警 1 → -1', () => {
    assert.equal(securityDeduction({ high: 1, warnings: 0 }), 3);
    assert.equal(securityDeduction({ high: 0, warnings: 2 }), 2);
    assert.equal(securityDeduction({ high: 0, warnings: 1 }), 1);
    assert.equal(securityDeduction({}), 0);
  });

  test('触发词比例由 description 的触发短语数量推导', () => {
    assert.equal(triggerSufficiencyFromDescription(''), 0);
    const four = 'Skill. Triggers include: "list ecs", "query ecs", "show ecs", "检查 ecs 状态"';
    assert.equal(triggerSufficiencyFromDescription(four), 1);
    const two = 'Skill. Triggers include: "list ecs", "query ecs"';
    assert.equal(triggerSufficiencyFromDescription(two), 0.5);
  });
});

describe('evaluator · 打分', () => {
  const perfectMetrics = { tokenTotal: 1000, durationSeconds: 60, toolFailCount: 0, retryCount: 0, cliCallCount: 2, sdkCallCount: 0, apiCallCount: 0, llmCallCount: 5, contextCompressed: false };
  const cleanSafety = { high: 0, warnings: 0, findings: [] };

  test('首轮满分：功能可用 + 触发词 + 成本/效率（首轮即基线）+ 安全', () => {
    const result = scoreEvaluation({
      checks: { functionalUsable: true, triggerSufficiency: 1 },
      metrics: perfectMetrics, baseline: null, safety: cleanSafety,
    });
    assert.equal(result.total, 10);
    assert.equal(result.verdict, 'pass');
    assert.equal(result.firstRun, true);
    assert.deepEqual(result.dimensions, { stability: 4, cost: 1, efficiency: 2, security: 3 });
    assert.deepEqual(result.deductions, []);
    assert.equal(result.items.length, 12);
  });

  test('功能不可用 + 无触发词：稳定性归零，首轮的其它维度仍给分', () => {
    const result = scoreEvaluation({
      checks: { functionalUsable: false, triggerSufficiency: 0, functionalEvidence: 'TC-01 fail' },
      metrics: perfectMetrics, baseline: null, safety: cleanSafety,
    });
    assert.equal(result.total, 6);
    assert.equal(result.verdict, 'fail');
    assert.equal(result.dimensions.stability, 0);
    assert.deepEqual(result.deductions.map((d) => d.item), ['功能可用', '触发词充足度']);
    assert.equal(result.deductions[0].points, 3);
    assert.equal(result.deductions[1].points, 1);
    assert.match(result.items[0].detail, /TC-01 fail/);
  });

  test('第二轮与自基线比较：超支的项归零，省下来的项不罚', () => {
    const baseline = { ...perfectMetrics };
    const over = scoreEvaluation({
      checks: { functionalUsable: true, triggerSufficiency: 1 },
      metrics: { ...perfectMetrics, tokenTotal: 2000, durationSeconds: 120 }, baseline, safety: cleanSafety,
    });
    assert.equal(over.firstRun, false);
    assert.equal(over.dimensions.cost, 0, 'token 超基线 10% 以上 → 成本 0');
    assert.equal(over.items.find((i) => i.itemName === '完成时间').score, 0);
    assert.equal(over.items.find((i) => i.itemName === '工具失败次数').score, 0.25, '与基线相同 → 满分');
    assert.equal(over.total, 8.75);

    const under = scoreEvaluation({
      checks: { functionalUsable: true, triggerSufficiency: 1 },
      metrics: { ...perfectMetrics, tokenTotal: 500, durationSeconds: 30 }, baseline, safety: cleanSafety,
    });
    assert.equal(under.dimensions.cost, 1, '更省 → 满分');
    assert.equal(under.total, 10);
  });

  test('阈值判定发生在通过线本身（8.5 = 「85 分」）', () => {
    // token 超基线 + 与基线相同的其它项 → 9.00/10；判定只与通过线比较
    const nine = { checks: { functionalUsable: true, triggerSufficiency: 1 }, metrics: { ...perfectMetrics, tokenTotal: 2000 }, baseline: perfectMetrics, safety: cleanSafety };
    const atNine = scoreEvaluation(nine);
    assert.equal(atNine.total, 9);
    assert.equal(scoreEvaluation({ ...nine, passScore: 9 }).verdict, 'pass', '正好达到通过线即达标');
    assert.equal(scoreEvaluation({ ...nine, passScore: 9.01 }).verdict, 'fail');
    assert.equal(scoreEvaluation({ ...nine, passScore: DEFAULT_PASS_SCORE }).verdict, 'pass');
  });

  test('安全维度按本地规则扣分，高危直接归零', () => {
    const oneWarn = scoreEvaluation({
      checks: { functionalUsable: true, triggerSufficiency: 1 }, metrics: perfectMetrics, baseline: null,
      safety: { high: 0, warnings: 1, findings: [{ rule: 'write-op-without-confirmation' }] },
    });
    assert.equal(oneWarn.dimensions.security, 2);
    assert.equal(oneWarn.total, 9);
    const high = scoreEvaluation({
      checks: { functionalUsable: true, triggerSufficiency: 1 }, metrics: perfectMetrics, baseline: null,
      safety: { high: 1, warnings: 0, findings: [{ rule: 'hardcoded-credential' }] },
    });
    assert.equal(high.dimensions.security, 0);
    assert.equal(high.total, 7);
    assert.match(high.items[11].detail, /hardcoded-credential/);
  });
});

describe('evaluator · 绝对阈值（首轮不再白送成本/效率）', () => {
  const cleanSafety = { high: 0, warnings: 0, findings: [] };
  const ok = { functionalUsable: true, triggerSufficiency: 1 };
  const base = {
    tokenTotal: 1000, durationSeconds: 60, toolFailCount: 0, retryCount: 0,
    cliCallCount: 2, sdkCallCount: 0, apiCallCount: 0, llmCallCount: 5, toolCalls: 3, contextCompressed: false,
  };
  const item = (result, name) => result.items.find((entry) => entry.itemName === name);

  test('默认阈值有据可依：实测 token/时长/调用量都远低于上限', () => {
    assert.equal(DEFAULT_EVAL_LIMITS.evalTokenBudget, 50000);
    assert.equal(DEFAULT_EVAL_LIMITS.evalDurationCapSeconds, 600);
    assert.equal(DEFAULT_EVAL_LIMITS.evalMaxToolFailures, 0);
    assert.equal(DEFAULT_EVAL_LIMITS.evalMaxRetries, 0);
    assert.equal(DEFAULT_EVAL_LIMITS.minFixtureCases, 3);
    assert.ok(DEFAULT_EVAL_LIMITS.evalMaxToolCalls >= 8, '实测工具调用 4-8 次，上限必须高于该量级');
    assert.ok(DEFAULT_EVAL_LIMITS.evalTokenBudget > 39617, '实测最大 39617 tokens');
    assert.ok(DEFAULT_EVAL_LIMITS.evalDurationCapSeconds > 394.1, '实测最长 394.1 s');
  });

  test('无基线 + token 超预算 → 成本 0 分；预算内仍满分', () => {
    const over = scoreEvaluation({ checks: ok, metrics: { ...base, tokenTotal: 60000 }, baseline: null, safety: cleanSafety });
    assert.equal(over.firstRun, true, '这一轮确实没有基线');
    assert.equal(item(over, '消耗总token').score, 0, '首轮也要受绝对上限约束');
    assert.match(item(over, '消耗总token').detail, /超预算/);
    assert.equal(over.total, 9);
    const inside = scoreEvaluation({ checks: ok, metrics: { ...base, tokenTotal: 40000 }, baseline: null, safety: cleanSafety });
    assert.equal(inside.dimensions.cost, 1, '未超预算是满分，不是一律扣分');
  });

  test('无基线 + 时长超上限 / 工具失败 1 次 / 重试 1 次 → 对应项 0 分', () => {
    const over = scoreEvaluation({
      checks: ok, metrics: { ...base, durationSeconds: 601, toolFailCount: 1, retryCount: 1 }, baseline: null, safety: cleanSafety,
    });
    assert.equal(item(over, '完成时间').score, 0);
    assert.equal(item(over, '工具失败次数').score, 0);
    assert.equal(item(over, '重试次数').score, 0);
    assert.equal(over.dimensions.efficiency, 1.25, '8 项里 3 项归零');
    assert.equal(over.total, 9.25);
    // 与基线完全相同的失败/重试也不受容差保护：绝对要求是 0
    const same = scoreEvaluation({
      checks: ok, metrics: { ...base, toolFailCount: 1, retryCount: 1 },
      baseline: { ...base, toolFailCount: 1, retryCount: 1 }, safety: cleanSafety,
    });
    assert.equal(same.firstRun, false);
    assert.equal(item(same, '工具失败次数').score, 0, '相对基线没超支，但绝对要求是 0');
    assert.equal(item(same, '重试次数').score, 0);
  });

  test('有基线：更省满分 / 超基线超容差 0 分 / 超绝对上限也 0 分', () => {
    const baseline = { ...base, tokenTotal: 40000, durationSeconds: 300 };
    const cheaper = scoreEvaluation({
      checks: ok, metrics: { ...base, tokenTotal: 20000, durationSeconds: 150 }, baseline, safety: cleanSafety,
    });
    assert.equal(cheaper.total, 10, '更省不罚');
    const overBaseline = scoreEvaluation({
      checks: ok, metrics: { ...base, tokenTotal: 45000, durationSeconds: 400 }, baseline, safety: cleanSafety,
    });
    assert.equal(overBaseline.dimensions.cost, 0, '40000×1.1=44000 < 45000');
    assert.equal(item(overBaseline, '完成时间').score, 0, '300×1.1=330 < 400');
    assert.equal(overBaseline.dimensions.efficiency, 1.75, '只有完成时间一项归零');
    assert.equal(overBaseline.total, 8.75);
    // 相对基线没超支（59000×1.1=64900 > 60000），但超过绝对上限 → 仍然 0
    const overCap = scoreEvaluation({
      checks: ok, metrics: { ...base, tokenTotal: 60000 }, baseline: { ...baseline, tokenTotal: 59000 }, safety: cleanSafety,
    });
    assert.equal(withinTolerance(60000, 59000), true, '前提：相对基线在容差内');
    assert.equal(overCap.dimensions.cost, 0, '绝对上限独立生效');
    const durationCap = scoreEvaluation({
      checks: ok, metrics: { ...base, durationSeconds: 601 }, baseline: { ...baseline, durationSeconds: 600 }, safety: cleanSafety,
    });
    assert.equal(item(durationCap, '完成时间').score, 0);
  });

  test('cli/sdk/api/llm 与工具调用总量都有绝对上限', () => {
    const over = scoreEvaluation({
      checks: ok, metrics: { ...base, cliCallCount: 21, llmCallCount: 21, toolCalls: 25 }, baseline: null, safety: cleanSafety,
    });
    assert.equal(item(over, 'cli调用次数').score, 0);
    assert.equal(item(over, 'LLM调用次数').score, 0);
    assert.equal(item(over, 'sdk调用次数').score, 0, 'sdk 本身 0 次，但工具调用总量 25 超上限');
    assert.match(item(over, 'sdk调用次数').detail, /工具调用总量 25 超上限 20/);
    assert.equal(item(over, 'api调用次数').score, 0, '工具调用类项目一起受总量上限约束');
    assert.equal(over.dimensions.efficiency, 1, '8 项里 4 项归零');
    // 上限可调：把 cli 上限放宽后同样的轮次恢复满分项
    const relaxed = scoreEvaluation({
      checks: ok, metrics: { ...base, cliCallCount: 21 }, baseline: null, safety: cleanSafety, limits: { evalMaxCliCalls: 30 },
    });
    assert.equal(item(relaxed, 'cli调用次数').score, 0.25);
  });

  test('阈值来自 config.run：resolveEvalLimits 合并 + 垃圾值回落默认', () => {
    assert.deepEqual(resolveEvalLimits({}), DEFAULT_EVAL_LIMITS);
    assert.equal(resolveEvalLimits({ evalTokenBudget: 1000 }).evalTokenBudget, 1000);
    assert.equal(resolveEvalLimits({ evalTokenBudget: '50000' }).evalTokenBudget, 50000, '数字字符串可用');
    assert.equal(resolveEvalLimits({ evalTokenBudget: 'abc' }).evalTokenBudget, 50000, '垃圾值不覆盖默认');
    assert.equal(resolveEvalLimits({ evalTokenBudget: -5 }).evalTokenBudget, 50000, '负值不覆盖默认');
    assert.equal(resolveEvalLimits({ strictStructureGate: true }).strictStructureGate, true);
    const total = scoreEvaluation({
      checks: ok, metrics: { ...base, tokenTotal: 800 }, baseline: null, safety: cleanSafety, limits: { evalTokenBudget: 500 },
    });
    assert.equal(total.dimensions.cost, 0, '传入 limits 立即生效');
  });
});

describe('evaluator · 夹具证据决定「功能可用」（B）', () => {
  const cleanSafety = { high: 0, warnings: 0, findings: [] };
  const metrics = {
    tokenTotal: 1000, durationSeconds: 60, toolFailCount: 0, retryCount: 0,
    cliCallCount: 1, sdkCallCount: 0, apiCallCount: 0, llmCallCount: 2, toolCalls: 2, contextCompressed: false,
  };
  const fixtureOf = (cases) => ({
    kind: 'huawei', paths: FIXTURE_PATHS.huawei, path: 'templates/test-vars.json', present: true, error: '', cases,
  });
  const fixtureCases = [{ id: 'TC-01' }, { id: 'TC-02' }, { id: 'TC-03' }, { id: 'TC-04' }];
  const executed = (id) => ({
    id, fixture: true, status: 'pass',
    command: `hcloud ECS ShowServer --cli-region=cn-north-4 --server_id=${id}`,
    evidence: `exit 0 | {"server":{"id":"${id}"}} — 与期望的 server 详情一致`,
  });
  const scored = (assessment) => scoreEvaluation({
    checks: { functionalUsable: assessment.usable, triggerSufficiency: 1, functionalEvidence: assessment.evidence },
    metrics, baseline: null, safety: cleanSafety,
  });

  test('仅有自编用例（无夹具）→ false / 0 分，证据写明「仅自编用例，无 skill 夹具证据」', () => {
    const selfAuthored = [
      { id: 'S-1', fixture: false, status: 'pass', command: 'hcloud ECS ListServersDetails', evidence: 'exit 0' },
      { id: 'S-2', fixture: false, status: 'pass', command: 'bash -n scripts/ensure_cli.sh', evidence: 'exit 0' },
      { id: 'S-3', fixture: false, status: 'pass', command: 'hcloud ECS ShowServer --help', evidence: 'exit 0' },
    ];
    const assessment = assessFunctionalEvidence({
      cases: selfAuthored, fixture: { kind: 'huawei', paths: FIXTURE_PATHS.huawei, present: false, error: '', cases: [] },
    });
    assert.equal(assessment.usable, false);
    assert.equal(assessment.selfAuthored, 3);
    assert.match(assessment.evidence, /仅自编用例，无 skill 夹具证据/);
    assert.match(assessment.evidence, /不能单独支撑这 3 分/);
    const result = scored(assessment);
    assert.equal(result.items[0].score, 0);
    assert.equal(result.dimensions.stability, 1, '只剩触发词那 1 分');
    assert.match(result.items[0].detail, /无 skill 夹具证据/);
  });

  test('夹具用例 ≥3 条、每条带证据、无 fail → true / 3 分（自编用例只作补充）', () => {
    const assessment = assessFunctionalEvidence({
      cases: [executed('TC-01'), executed('TC-02'), executed('TC-03'), { id: 'S-9', fixture: false, status: 'pass', command: 'x', evidence: 'y' }],
      fixture: fixtureOf(fixtureCases),
    });
    assert.equal(assessment.usable, true);
    assert.equal(assessment.fixtureExecuted, 3);
    assert.equal(assessment.selfAuthored, 1);
    assert.match(assessment.evidence, /skill 夹具 templates\/test-vars\.json/);
    assert.match(assessment.evidence, /3\/3 条用例已执行且带证据/);
    assert.match(assessment.evidence, /自编补充用例，不作为达标依据/);
    assert.equal(scored(assessment).items[0].score, 3);
  });

  test('夹具用例不足 minFixtureCases → false（skipped 不算「已执行」）', () => {
    const assessment = assessFunctionalEvidence({
      cases: [executed('TC-01'), executed('TC-02'), { ...executed('TC-03'), status: 'skipped' }, { ...executed('TC-04'), status: 'skipped' }],
      fixture: fixtureOf(fixtureCases), minFixtureCases: 3,
    });
    assert.equal(assessment.fixtureExecuted, 2);
    assert.equal(assessment.usable, false);
    assert.match(assessment.evidence, /实际执行 2 条 < 下限 3 条/);
    assert.equal(scored(assessment).items[0].score, 0);
    // 下限可调：minFixtureCases=2 时同样的证据达标
    assert.equal(assessFunctionalEvidence({
      cases: [executed('TC-01'), executed('TC-02')], fixture: fixtureOf(fixtureCases), minFixtureCases: 2,
    }).usable, true);
  });

  test('夹具用例缺证据 → false；夹具用例 fail → false', () => {
    const noEvidence = assessFunctionalEvidence({
      cases: [executed('TC-01'), executed('TC-02'), { ...executed('TC-03'), command: '', evidence: '' }],
      fixture: fixtureOf(fixtureCases),
    });
    assert.equal(noEvidence.usable, false);
    assert.match(noEvidence.evidence, /TC-03 缺少证据/);
    const failed = assessFunctionalEvidence({
      cases: [executed('TC-01'), executed('TC-02'), { ...executed('TC-03'), status: 'fail' }, executed('TC-04')],
      fixture: fixtureOf(fixtureCases),
    });
    assert.equal(failed.usable, false);
    assert.match(failed.evidence, /存在 fail 用例：TC-03/);
    // 自编补充用例里的 fail 同样一票否决
    const selfFail = assessFunctionalEvidence({
      cases: [executed('TC-01'), executed('TC-02'), executed('TC-03'), { id: 'S-1', fixture: false, status: 'fail' }],
      fixture: fixtureOf(fixtureCases),
    });
    assert.equal(selfFail.usable, false);
    assert.match(selfFail.evidence, /S-1/);
  });
});

describe('evaluator · 本地门禁（E）', () => {
  const cleanSafety = { high: 0, warnings: 0, findings: [] };
  const metrics = {
    tokenTotal: 1000, durationSeconds: 60, toolFailCount: 0, retryCount: 0,
    cliCallCount: 1, sdkCallCount: 0, apiCallCount: 0, llmCallCount: 2, toolCalls: 2, contextCompressed: false,
  };
  const gateOf = (gates, id) => gates.find((gate) => gate.id === id);
  const files = { 'SKILL.md': '---\nname: huawei-cloud-x\ndescription: "Demo. Triggers include: \'a\', \'b\', \'c\', \'d\'"\n---\n# X\n' };
  const fixtureOk = {
    kind: 'huawei', paths: FIXTURE_PATHS.huawei, path: 'templates/test-vars.json', present: true, error: '',
    cases: [{ id: 'TC-01' }, { id: 'TC-02' }, { id: 'TC-03' }],
  };
  const cleanStructural = { mode: 'huawei', issues: [], stats: {} };
  const baseArgs = { kind: 'huawei', files, fixture: fixtureOk, structural: cleanStructural };

  test('SKILL.md / frontmatter 门禁：缺文件、YAML 不可解析、缺 name/description 全部 FAIL', () => {
    assert.equal(gateOf(evaluateGates(baseArgs), 'skill-md').ok, true);
    const missing = evaluateGates({ ...baseArgs, files: {} });
    assert.equal(gateOf(missing, 'skill-md').ok, false);
    assert.match(gateOf(missing, 'skill-md').detail, /SKILL.md 缺失/);
    const noFrontmatter = evaluateGates({ ...baseArgs, files: { 'SKILL.md': '# no frontmatter\n' } });
    assert.equal(gateOf(noFrontmatter, 'skill-md').ok, false);
    assert.match(gateOf(noFrontmatter, 'skill-md').detail, /YAML 无法解析/);
    const noDescription = evaluateGates({ ...baseArgs, files: { 'SKILL.md': '---\nname: huawei-cloud-x\n---\n# X\n' } });
    assert.equal(gateOf(noDescription, 'skill-md').ok, false);
    assert.match(gateOf(noDescription, 'skill-md').detail, /缺 description/);
  });

  test('夹具门禁：缺失 / 空夹具 → FAIL；可解析夹具 → 通过', () => {
    const missing = evaluateGates({
      ...baseArgs, fixture: { kind: 'huawei', paths: FIXTURE_PATHS.huawei, present: false, error: '', cases: [] },
    });
    assert.equal(gateOf(missing, 'fixtures').ok, false);
    assert.match(gateOf(missing, 'fixtures').detail, /templates\/test-vars\.json/);
    const unparseable = evaluateGates({
      ...baseArgs, fixture: { kind: 'huawei', paths: FIXTURE_PATHS.huawei, present: false, error: 'templates/test-vars.json 无法解析：Unexpected token', cases: [] },
    });
    assert.equal(gateOf(unparseable, 'fixtures').ok, false);
    assert.match(gateOf(unparseable, 'fixtures').detail, /无法解析/);
    assert.equal(gateOf(evaluateGates({ ...baseArgs, fixture: { present: true, path: 'templates/test-vars.json', cases: [], paths: [] } }), 'fixtures').ok, false);
  });

  test('结构门禁：level=error ≥1 → FAIL；只有 warning → 通过；severity 字段不算（曾踩的坑）', () => {
    const withError = evaluateGates({
      ...baseArgs, structural: { mode: 'huawei', issues: [{ id: 'x', level: 'warning' }, { id: 'no-aksk', level: 'error' }] },
    });
    assert.equal(gateOf(withError, 'structure').ok, false);
    assert.match(gateOf(withError, 'structure').detail, /no-aksk/);
    const warnOnly = evaluateGates({ ...baseArgs, structural: { mode: 'huawei', issues: [{ id: 'x', level: 'warning' }] } });
    assert.equal(gateOf(warnOnly, 'structure').ok, true);
    const severityOnly = evaluateGates({ ...baseArgs, structural: { mode: 'huawei', issues: [{ id: 'x', severity: 'error' }] } });
    assert.equal(gateOf(severityOnly, 'structure').ok, true, '校验器发的是 level，不是 severity');
    const broken = evaluateGates({ ...baseArgs, structural: { error: 'validators 崩了', issues: [] } });
    assert.equal(gateOf(broken, 'structure').ok, false);
  });

  test('结构门禁按 kind 取规则：api 的 requirements.txt、generic 的 evals/ 不算错，phase-* 残留仍算', () => {
    const apiFiles = { 'SKILL.md': files['SKILL.md'], 'requirements.txt': 'requests\n' };
    const api = evaluateGates({
      kind: 'api', files: apiFiles, structural: { mode: 'api', issues: [{ id: 'top-level', level: 'error' }, { id: 'no-external-links', level: 'error' }] },
      fixture: { kind: 'api', paths: FIXTURE_PATHS.api, path: 'templates/test-vars.json', present: true, cases: [{ id: 'TC-01' }] },
    });
    assert.equal(gateOf(api, 'structure').ok, true);
    assert.match(gateOf(api, 'structure').detail, /不适用规则/);
    const genericFiles = { 'SKILL.md': files['SKILL.md'], 'evals/evals.json': '{"evals":[]}', 'phase-1-summary.json': '{}' };
    const generic = evaluateGates({
      kind: 'generic', files: genericFiles, structural: { mode: 'generic', issues: [{ id: 'top-level', level: 'error' }] },
      fixture: { kind: 'generic', paths: FIXTURE_PATHS.generic, path: 'evals/evals.json', present: true, cases: [{ id: '1' }] },
    });
    assert.equal(gateOf(generic, 'structure').ok, false);
    assert.match(gateOf(generic, 'structure').detail, /phase-1-summary\.json/);
    // huawei 不做 kind 豁免：同一个 top-level error 会算数
    const huawei = evaluateGates({ ...baseArgs, structural: { mode: 'huawei', issues: [{ id: 'top-level', level: 'error' }] } });
    assert.equal(gateOf(huawei, 'structure').ok, false);
    // strictStructureGate 打开后，非 huawei 也不再豁免
    const strict = evaluateGates({
      kind: 'api', files: apiFiles, structural: { mode: 'api', issues: [{ id: 'no-external-links', level: 'error' }] },
      fixture: { present: true, path: 'templates/test-vars.json', cases: [{ id: 'TC-01' }] }, strictStructure: true,
    });
    assert.equal(gateOf(strict, 'structure').ok, false);
    assert.ok(KIND_ALLOWED_TOP.generic.includes('evals'));
  });

  test('华为云 creator 校验门禁：脚本报 FAIL → FAIL；跑不了 → warning 不计门禁；非 huawei 不做', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsc-gate-'));
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'scripts', 'validate-skill.sh'), '#!/usr/bin/env bash\nexit 0\n');
    const failed = evaluateGates({ ...baseArgs, creatorDir: dir, runValidator: () => ({ ran: true, ok: false, detail: 'FAIL: Reference Documents section missing' }) });
    assert.equal(gateOf(failed, 'creator-validate').ok, false);
    assert.equal(gateOf(failed, 'creator-validate').enforced, true);
    assert.match(gateOf(failed, 'creator-validate').detail, /Reference Documents/);
    const passed = evaluateGates({ ...baseArgs, creatorDir: dir, runValidator: () => ({ ran: true, ok: true, detail: 'FAIL 0' }) });
    assert.equal(gateOf(passed, 'creator-validate').ok, true);
    const unrunnable = evaluateGates({ ...baseArgs, creatorDir: dir, runValidator: () => ({ ran: false, detail: '未找到可用的 bash' }) });
    assert.equal(gateOf(unrunnable, 'creator-validate').ok, true, '跑不了只记 warning');
    assert.equal(gateOf(unrunnable, 'creator-validate').enforced, false);
    const noScript = evaluateGates({ ...baseArgs, creatorDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dsc-gate-')) });
    assert.equal(gateOf(noScript, 'creator-validate').ok, true);
    assert.match(gateOf(noScript, 'creator-validate').detail, /warning/);
    const api = evaluateGates({
      kind: 'api', files, structural: cleanStructural,
      fixture: { kind: 'api', paths: FIXTURE_PATHS.api, path: 'templates/test-vars.json', present: true, cases: [{ id: 'TC-01' }] },
    });
    assert.equal(api.some((gate) => gate.id === 'creator-validate'), false, 'creator validate-skill.sh 是华为云专有门禁');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('门禁失败 → 总分被压到上限且 verdict 非 pass；不抬高本来就低的分数；全过不影响满分', () => {
    const checks = (gates) => ({ functionalUsable: true, triggerSufficiency: 1, gates });
    const capped = scoreEvaluation({ checks: checks([{ id: 'fixtures', ok: false, detail: '缺 templates/test-vars.json' }]), metrics, baseline: null, safety: cleanSafety });
    assert.equal(capped.rawTotal, 10);
    assert.equal(capped.total, 7, '压到 7.0（低于 8.5）');
    assert.equal(capped.verdict, 'fail');
    assert.equal(capped.gateCapApplied, true);
    assert.ok(capped.deductions.some((row) => row.item === '本地门禁' && /fixtures/.test(row.reason)), JSON.stringify(capped.deductions));
    const allOk = scoreEvaluation({ checks: checks([{ id: 'fixtures', ok: true, detail: '' }, { id: 'structure', ok: true, detail: '' }]), metrics, baseline: null, safety: cleanSafety });
    assert.equal(allOk.total, 10);
    assert.equal(allOk.verdict, 'pass');
    assert.equal(allOk.gateCapApplied, false);
    // 本来就只有 6 分：门禁失败不会把它"抬高"到 7，也不会重复扣
    const low = scoreEvaluation({
      checks: { functionalUsable: false, triggerSufficiency: 0, gates: [{ id: 'structure', ok: false, detail: 'error 3 项' }] },
      metrics, baseline: null, safety: cleanSafety,
    });
    assert.equal(low.total, 6);
    assert.equal(low.gateCapApplied, false);
    // 上限可配置
    const custom = scoreEvaluation({
      checks: checks([{ id: 'fixtures', ok: false, detail: 'x' }]), metrics, baseline: null, safety: cleanSafety, limits: { gateScoreCap: 5 },
    });
    assert.equal(custom.total, 5);
    assert.equal(custom.verdict, 'fail');
  });

  test('修复提示词与报告都列出门禁明细（不然打回修改时看不到原因）', () => {
    const evaluation = scoreEvaluation({
      checks: { functionalUsable: false, triggerSufficiency: 1, functionalEvidence: '仅自编用例，无 skill 夹具证据', gates: [{ id: 'fixtures', ok: false, detail: '未找到可解析的 huawei 夹具：templates/test-vars.json' }] },
      metrics, baseline: null, safety: cleanSafety,
    });
    const prompt = buildFixPrompt({ evaluation, round: 1, maxRounds: 3, passScore: 8.5 });
    assert.match(prompt, /本地门禁未通过/);
    assert.match(prompt, /fixtures：未找到可解析的 huawei 夹具/);
    const report = formatEvaluationReport({
      run: { id: 'session-1', target: 'C:/ws/skills/x', kind: 'huawei', creator: 'huawei-cloud-skill-creator', commit: 'deadbeef', spec: { name: 'huawei-cloud-x' } },
      evaluations: [{ round: 1, total: evaluation.total, dimensions: evaluation.dimensions, verdict: 'fail', deductions: evaluation.deductions, gates: evaluation.gates }],
      passScore: 8.5, maxRounds: 3, gateScoreCap: 7,
    });
    assert.match(report, /## 本地门禁（任一不过 → 总分上限 7）/);
    assert.match(report, /未找到可解析的 huawei 夹具/);
    assert.match(report, /未纳入（平台侧信号缺失）/);
  });
});

describe('evaluator · 指标归约（本地替代 CodeArts/Hermes）', () => {
  test('从 session 事件累积 token / LLM / 工具 / 失败 / 重试 / 分类', () => {
    const events = [
      { type: 'assistant/message', data: { usage: { inputTokens: 100, outputTokens: 20 } } },
      { type: 'tool/call', data: { name: 'bash', arguments: '{"command":"hcloud ECS ListServersDetails"}' } },
      { type: 'tool/result', data: { name: 'bash', error: { message: 'boom' } } },
      { type: 'tool/call', data: { name: 'bash', arguments: '{"command":"hcloud ECS ListServersDetails"}' } },
      { type: 'assistant/message', data: { usage: { inputTokens: 50, outputTokens: 5 } } },
      { type: 'tool/call', data: { name: 'bash', arguments: '{"command":"python3 -c \\"import huaweicloudsdkcore\\""}' } },
      { type: 'tool/call', data: { name: 'bash', arguments: '{"command":"curl https://ecs.cn-north-4.myhuaweicloud.com/v2/x"}' } },
      { type: 'tool/result', data: { message: { isError: true } } },
      { type: 'agent/error', data: {} },
    ];
    const metrics = metricsFromEvents(events, { startedAt: 1000, endedAt: 61_000 });
    assert.equal(metrics.tokenTotal, 175);
    assert.equal(metrics.inputTokens, 150);
    assert.equal(metrics.outputTokens, 25);
    assert.equal(metrics.llmCallCount, 2);
    assert.equal(metrics.toolCalls, 4);
    assert.equal(metrics.toolFailCount, 2, 'tool/result 的 error 与 isError 都算失败');
    assert.equal(metrics.retryCount, 1, '连续两次完全相同的工具调用算一次重试');
    assert.equal(metrics.cliCallCount, 2, '两次 hcloud 调用（其中一次是重试）都计入 cli');
    assert.equal(metrics.sdkCallCount, 1);
    assert.equal(metrics.apiCallCount, 1);
    assert.equal(metrics.durationSeconds, 60);
    assert.equal(metrics.contextCompressed, false);
  });

  test('classifyToolCall 与 countConsecutiveRetries', () => {
    assert.equal(classifyToolCall('bash hcloud ECS ListServersDetails'), 'cli');
    assert.equal(classifyToolCall('import huaweicloudsdkcore'), 'sdk');
    assert.equal(classifyToolCall('curl https://obs.cn-north-4.myhuaweicloud.com/x'), 'api');
    assert.equal(classifyToolCall('read_file path=/tmp/x'), null);
    assert.equal(countConsecutiveRetries(['a', 'a', 'b', 'b', 'b', 'c']), 3);
    assert.equal(countConsecutiveRetries([]), 0);
  });

  test('压缩类事件被记录（本地不可观测时恒为 false，不扣分）', () => {
    assert.equal(metricsFromEvents([{ type: 'context/compacted', data: {} }]).contextCompressed, true);
  });
});

describe('evaluator · 安全规则扫描', () => {
  test('硬编码凭据 / 私钥 / 命令行凭据 → 高危', () => {
    const scan = scanSkillSafety({
      'SKILL.md': '---\nname: huawei-cloud-x\ndescription: d\n---\n',
      'scripts/run.sh': 'api_key = "supersecretvalue"\n',
      'scripts/key.pem': '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n',
      'scripts/inline.sh': 'hcloud ECS ListServersDetails --cli-access-key=ABC\n',
    });
    assert.ok(scan.high >= 3, JSON.stringify(scan.findings));
    assert.ok(scan.findings.some((f) => f.rule === 'hardcoded-credential'));
    assert.ok(scan.findings.some((f) => f.rule === 'private-key-material'));
    assert.ok(scan.findings.some((f) => f.rule === 'credential-on-command-line'));
  });

  test('环境变量/占位符不算硬编码', () => {
    const scan = scanSkillSafety({
      'SKILL.md': '---\nname: huawei-cloud-x\ndescription: d\n---\n',
      'scripts/ok.py': 'api_key = os.environ["HUAWEI_CLOUD_API_KEY"]\ntoken = "${TOKEN}"\nsecret_key: your-secret-key\n',
    });
    assert.equal(scan.high, 0, JSON.stringify(scan.findings));
  });

  test('写操作未要求确认 / 直接调用其它 skill → 告警', () => {
    const scan = scanSkillSafety({
      'SKILL.md': '---\nname: huawei-cloud-x\ndescription: d\n---\n```bash\nhcloud ECS CreateServers --x 1\n```\nskill(\'huawei-cloud-other-one\')\n',
    });
    assert.equal(scan.high, 0);
    assert.ok(scan.findings.some((f) => f.rule === 'write-op-without-confirmation'));
    assert.ok(scan.findings.some((f) => f.rule === 'cross-skill-direct-call'));
    // 要求确认后不再告警；调用自己的 skill 也不算
    const ok = scanSkillSafety({
      'SKILL.md': '---\nname: huawei-cloud-x\ndescription: d\n---\n写操作前必须人工确认。\n```bash\nhcloud ECS CreateServers\n```\nskill(\'huawei-cloud-x\')\n',
    });
    assert.equal(ok.warnings, 0, JSON.stringify(ok.findings));
  });
});

describe('evaluator · 评测 agent 契约', () => {
  test('提示词：只读、结构化 JSON、包含用例', () => {
    const prompt = buildEvaluationPrompt({
      kind: 'huawei', skillName: 'huawei-cloud-ecs-manage', skillPath: 'C:/ws/skills/computing/ecs/x',
      cases: [{ id: 'TC-01', type: 'readonly', command: 'hcloud ECS ListServersDetails --cli-region=cn-north-4' }],
    });
    assert.match(prompt, /绝对不要修改被评测 skill/);
    assert.match(prompt, /禁止执行任何写操作/);
    assert.match(prompt, /TC-01/);
    assert.match(prompt, /hcloud ECS ListServersDetails/);
    assert.ok(prompt.includes(EVAL_RESULT_OPEN) && prompt.includes(EVAL_RESULT_CLOSE));
    assert.match(prompt, /"functionalUsable":true/);
    assert.match(prompt, /min\(1, 触发词数\/4\)/);
  });

  test('解析：标记块优先，也兼容裸 JSON / 代码块，垃圾输入返回 null', () => {
    const good = `我先跑用例。\n${EVAL_RESULT_OPEN}\n{"functionalUsable":true,"triggerSufficiency":0.75,"cases":[{"id":"TC-01","command":"x","status":"pass","evidence":"ok"},{"id":"TC-02","status":"skipped"}],"notes":"n"}\n${EVAL_RESULT_CLOSE}\n完成。`;
    const parsed = parseEvaluationOutput(good);
    assert.equal(parsed.functionalUsable, true);
    assert.equal(parsed.triggerSufficiency, 0.75);
    assert.equal(parsed.cases.length, 2);
    assert.equal(parsed.cases[1].status, 'skipped');

    const failing = parseEvaluationOutput('```json\n{"functionalUsable":true,"cases":[{"id":"a","status":"fail"}]}\n```');
    assert.equal(failing.functionalUsable, false, '有 fail 用例就不能算功能可用');
    assert.equal(failing.triggerSufficiency, null);

    assert.equal(parseEvaluationOutput('no json here'), null);
    assert.equal(parseEvaluationOutput(''), null);
  });

  test('修复提示词：列出扣分明细与通过线，并要求就地修改', () => {
    const evaluation = scoreEvaluation({
      checks: { functionalUsable: false, triggerSufficiency: 0 }, metrics: {}, baseline: null,
      safety: { high: 0, warnings: 0, findings: [] },
    });
    const prompt = buildFixPrompt({ evaluation, round: 1, maxRounds: 3, passScore: 8.5 });
    assert.match(prompt, /6\.00\/10/);
    assert.match(prompt, /低于通过线 8\.5/);
    assert.match(prompt, /功能可用（-3）/);
    assert.match(prompt, /触发词充足度（-1）/);
    assert.match(prompt, /不要换目录、不要重新问需求/);
    assert.match(prompt, /稳定性 0\.00\/4/);
  });

  test('报告：轮次表 + 末轮明细 + 明确标注未纳入的平台信号', () => {
    const evaluation = scoreEvaluation({
      checks: { functionalUsable: true, triggerSufficiency: 1 }, metrics: {}, baseline: null,
      safety: { high: 0, warnings: 0, findings: [] },
    });
    const report = formatEvaluationReport({
      run: { id: 'session-1', target: 'C:/ws/skills/x', kind: 'huawei', creator: 'huawei-cloud-skill-creator', commit: 'deadbeef', spec: { name: 'huawei-cloud-x' } },
      evaluations: [{ round: 1, total: 10, dimensions: evaluation.dimensions, verdict: 'pass', deductions: [] }],
      passScore: 8.5, maxRounds: 3,
    });
    assert.match(report, /# 技能评测报告/);
    assert.match(report, /最终得分：10\.00\/10/);
    assert.match(report, /\| 1 \| 10\.00 \|/);
    assert.match(report, /未纳入（平台侧信号缺失）/);
    for (const signal of PLATFORM_SIGNALS_SKIPPED) assert.ok(report.includes(signal), signal);
  });
});

describe('evaluator · 只读用例与文件读取', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsc-eval-'));
  fs.mkdirSync(path.join(dir, 'templates'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: huawei-cloud-x\ndescription: |\n  Skill. Triggers include: "list ecs", "query ecs", "show ecs", "检查 ecs"\n---\n# X\n');
  fs.writeFileSync(path.join(dir, 'scripts.sh'), 'echo hi\n');
  fs.writeFileSync(path.join(dir, 'templates', 'test-vars.json'), JSON.stringify({
    test_cases: [
      { id: 'TC-01', command: 'hcloud ECS ListServersDetails', type: 'readonly', executor: 'cli' },
      { id: 'TC-02', command: 'bash -n scripts.sh', type: 'syntax', executor: 'shell' },
      { id: 'TC-03', command: 'hcloud ECS CreateServers --x 1', type: 'write', executor: 'cli' },
    ],
  }));

  test('只保留 readonly / syntax 用例（写操作永不进入评测）', () => {
    const cases = readReadonlyCases(dir, { readonlyOnly: true });
    assert.deepEqual(cases.map((c) => c.id), ['TC-01', 'TC-02']);
    assert.equal(readReadonlyCases(dir, { readonlyOnly: false }).length, 3);
    assert.deepEqual(readReadonlyCases(path.join(dir, 'nope')), []);
  });

  test('readSkillFiles 收集文本文件并跳过 .git', () => {
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'config'), '[core]\n');
    const files = readSkillFiles(dir);
    assert.ok(files['SKILL.md']);
    assert.ok(files['templates/test-vars.json']);
    assert.equal(files['.git/config'], undefined);
    const parsed = descriptionFromFiles(files);
    assert.equal(parsed.name, 'huawei-cloud-x');
    assert.match(parsed.description, /Triggers include/);
    assert.equal(triggerSufficiencyFromDescription(parsed.description), 1);
  });
});

describe('evaluator · 各 kind 的夹具清单与解析（按真实产物核实）', () => {
  // Mirrors what each creator actually writes into the generated skill (checked against
  // <workspace>/skills, not guessed).
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsc-fixture-'));
  const huaweiDir = path.join(root, 'huawei');
  const apiDir = path.join(root, 'api');
  const genericDir = path.join(root, 'generic');
  const emptyDir = path.join(root, 'empty');
  fs.mkdirSync(path.join(huaweiDir, 'templates'), { recursive: true });
  fs.mkdirSync(path.join(apiDir, 'templates'), { recursive: true });
  fs.mkdirSync(path.join(genericDir, 'evals'), { recursive: true });
  fs.mkdirSync(emptyDir, { recursive: true });
  // huawei-cloud-skill-creator: test_cases[] + type
  fs.writeFileSync(path.join(huaweiDir, 'templates', 'test-vars.json'), JSON.stringify({
    skill_name: 'huawei-cloud-ecs-manage', region: 'cn-north-4',
    test_cases: [
      { id: 'TC-01', name: 'list', command: 'hcloud ECS ListServersDetails --cli-region={region}', expected: 'servers[]', type: 'readonly', executor: 'cli' },
      { id: 'TC-02', name: 'syntax', command: 'bash -n scripts/ensure_cli.sh', expected: 'exit 0', type: 'syntax', executor: 'cli' },
      { id: 'TC-03', name: 'delete', command: 'hcloud ECS DeleteServers --server_id=x', expected: 'deleted', type: 'write', executor: 'cli' },
    ],
  }));
  // rest-api-skill-creator: test_cases[] + category + method
  fs.writeFileSync(path.join(apiDir, 'templates', 'test-vars.json'), JSON.stringify({
    skill_name: 'jsonplaceholder-posts', entry_file: 'scripts/jsonplaceholder-posts.py',
    test_cases: [
      { id: 'TC-01', name: 'capability-list', command: 'python3 scripts/jsonplaceholder-posts.py capability-list', expected: '{"capability":...}', method: 'NONE', category: 'readonly' },
      { id: 'TC-02', name: 'list-posts', command: 'python3 scripts/jsonplaceholder-posts.py list-posts', expected: '[...]', method: 'GET', category: 'readonly' },
      { id: 'TC-03', name: 'create-post', command: 'python3 x.py create-post', expected: '201', method: 'POST', category: 'readonly' },
      { id: 'TC-04', name: 'purge', command: 'python3 x.py purge', expected: 'ok', category: 'mutable' },
    ],
  }));
  // common-skill-creator: evals[] + prompt/expected_output/files/assertions
  fs.writeFileSync(path.join(genericDir, 'evals', 'evals.json'), JSON.stringify({
    skill_name: 'git-list',
    evals: [
      { id: 1, prompt: '帮我列出全部 git 命令', expected_output: '按类别分组的命令清单', files: [], assertions: ['按组输出'] },
      { id: 2, prompt: 'git commit -n 是什么', expected_output: '-n = --no-verify', files: [] },
      { id: 3, prompt: 'git clean -fd 能直接跑吗', expected_output: '警告不可恢复 + 建议 git clean -n', files: [] },
    ],
  }));

  test('FIXTURE_PATHS 就是三个 creator 的实际产物路径', () => {
    assert.deepEqual(FIXTURE_PATHS.huawei, ['templates/test-vars.json', 'templates/test-defaults.json']);
    assert.deepEqual(FIXTURE_PATHS.api, ['templates/test-vars.json']);
    assert.deepEqual(FIXTURE_PATHS.generic, ['evals/evals.json']);
  });

  test('huawei：解析 test_cases（type），写操作用例被剔除', () => {
    const fixture = collectFixtureCases(huaweiDir, 'huawei');
    assert.equal(fixture.present, true);
    assert.equal(fixture.path, 'templates/test-vars.json');
    assert.deepEqual(fixture.cases.map((item) => item.id), ['TC-01', 'TC-02']);
    assert.deepEqual(fixture.cases.map((item) => item.type), ['readonly', 'syntax']);
    assert.equal(fixture.cases[0].shape, 'command');
    assert.equal(fixture.cases[0].fixture, true, '夹具来源必须自带 fixture 标记');
    assert.match(fixture.cases[0].command, /hcloud ECS ListServersDetails/);
  });

  test('api：解析 category=readonly；method 为写动词或 category=mutable 的一律不执行', () => {
    const fixture = collectFixtureCases(apiDir, 'api');
    assert.equal(fixture.present, true);
    assert.deepEqual(fixture.cases.map((item) => item.id), ['TC-01', 'TC-02'],
      'POST/DELETE 与 category=mutable 都不能进入只读评测');
  });

  test('generic：解析 evals[]（prompt/expected_output/files/assertions）', () => {
    const fixture = collectFixtureCases(genericDir, 'generic');
    assert.equal(fixture.present, true);
    assert.equal(fixture.path, 'evals/evals.json');
    assert.equal(fixture.cases.length, 3);
    assert.equal(fixture.cases[0].shape, 'prompt');
    assert.match(fixture.cases[0].prompt, /git 命令/);
    assert.match(fixture.cases[0].expected, /按类别分组/);
    assert.deepEqual(fixture.cases[0].assertions, ['按组输出']);
    assert.equal(fixture.cases[1].type, 'eval');
  });

  test('没有夹具 / 夹具无法解析 → present=false，且不抛异常', () => {
    const missing = collectFixtureCases(emptyDir, 'generic');
    assert.equal(missing.present, false);
    assert.deepEqual(missing.cases, []);
    assert.deepEqual(missing.paths, FIXTURE_PATHS.generic, '找不到时按 kind 记录清单');
    assert.equal(collectFixtureCases(path.join(root, 'nope'), 'huawei').present, false);
    assert.equal(collectFixtureCases(emptyDir, 'unknown-kind').present, false, '未知 kind 按 huawei 清单兜底');
    const broken = path.join(root, 'broken');
    fs.mkdirSync(path.join(broken, 'templates'), { recursive: true });
    fs.writeFileSync(path.join(broken, 'templates', 'test-vars.json'), '{ not json');
    const parsed = collectFixtureCases(broken, 'huawei');
    assert.equal(parsed.present, false);
    assert.match(parsed.error, /无法解析/);
    // 主夹具缺失时回落到清单里的第二路径（test-defaults.json）
    fs.writeFileSync(path.join(broken, 'templates', 'test-defaults.json'), JSON.stringify({
      request_defaults: {}, test_cases: [{ id: 'D-01', command: 'hcloud ECS ShowServer --help', type: 'syntax' }],
    }));
    const fallback = collectFixtureCases(broken, 'huawei');
    assert.equal(fallback.present, true);
    assert.equal(fallback.path, 'templates/test-defaults.json');
    assert.deepEqual(fallback.cases.map((item) => item.id), ['D-01']);
  });
});

import { resolveSkillDir } from '../src/core/evaluator.mjs';

describe('resolveSkillDir: find what the creator wrote without a known target', () => {
  const cwd = 'C:\\ws';
  const steps = [{ kind: 'tool', text: 'write file_path=C:\\ws\\skills\\file-list\\SKILL.md content=...' }];

  test('walks up from a written file to the directory holding SKILL.md', () => {
    const found = resolveSkillDir({ steps, cwd, exists: (p) => p === 'C:\\ws\\skills\\file-list\\SKILL.md' });
    assert.equal(found, 'C:\\ws\\skills\\file-list');
  });

  test('ignores paths outside the workspace and copes with no evidence', () => {
    assert.equal(resolveSkillDir({ steps: [{ text: 'read C:\\other\\x\\SKILL.md' }], cwd, exists: () => true }), null);
    assert.equal(resolveSkillDir({ steps: [], cwd }), null);
  });

  test('falls back to the newest freshly written SKILL.md under cwd/skills', () => {
    const found = resolveSkillDir({
      steps: [], cwd, startedAt: 1000,
      listSkills: () => [{ dir: 'C:\\ws\\skills\\old', mtimeMs: 500 }, { dir: 'C:\\ws\\skills\\file-list', mtimeMs: 2000 }],
    });
    assert.equal(found, 'C:\\ws\\skills\\file-list');
  });

  test('a skill written before the run started is not adopted', () => {
    const found = resolveSkillDir({ steps: [], cwd, startedAt: 5000, listSkills: () => [{ dir: 'C:\\ws\\skills\\stale', mtimeMs: 100 }] });
    assert.equal(found, null);
  });
});

describe('resolveSkillDir prefers what the run actually wrote', () => {
  test('recorded paths beat a newer unrelated skill in the scan', () => {
    const found = resolveSkillDir({
      paths: ['C:\\ws\\skills\\coding\\file-list\\SKILL.md'],
      cwd: 'C:\\ws', startedAt: 1000,
      exists: (p) => p === 'C:\\ws\\skills\\coding\\file-list\\SKILL.md',
      listSkills: () => [{ dir: 'C:\\ws\\skills\\coding\\git-list', mtimeMs: 999999 }],
    });
    assert.equal(found, 'C:\\ws\\skills\\coding\\file-list');
  });

  test('paths outside the workspace are ignored', () => {
    assert.equal(resolveSkillDir({ paths: ['D:\\elsewhere\\SKILL.md'], cwd: 'C:\\ws', exists: () => true }), null);
  });
});
