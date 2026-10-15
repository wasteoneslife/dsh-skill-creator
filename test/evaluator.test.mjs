import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_MAX_EVAL_ROUNDS, DEFAULT_PASS_SCORE, DIMENSION_MAX, EVAL_RESULT_CLOSE, EVAL_RESULT_OPEN, MAX_TOTAL,
  PLATFORM_SIGNALS_SKIPPED, RUBRIC, TOLERANCE, buildEvaluationPrompt, buildFixPrompt, classifyToolCall,
  countConsecutiveRetries, descriptionFromFiles, formatEvaluationReport, metricsFromEvents, parseEvaluationOutput,
  readReadonlyCases, readSkillFiles, scanSkillSafety, scoreEvaluation, scoreTriggerSufficiency, securityDeduction,
  triggerSufficiencyFromDescription, withinTolerance,
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
