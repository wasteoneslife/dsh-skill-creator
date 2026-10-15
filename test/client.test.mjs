import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * Minimal React stand-in: elements are plain objects, hooks are inert.
 * `createElement` keeps positional children, which is the whole point — the two
 * shipped defects were helpers that dropped their positional children argument
 * (`Field(props, control)` rendered labels only; `Select(props, options)` rendered
 * empty dropdowns), and counting element types alone never caught either.
 */
const react = {
  Fragment: 'Fragment',
  createElement: (type, props, ...children) => ({
    type,
    props: props || {},
    children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
  }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (init) => ({ current: init }),
};

let definition = null;
async function loadClient() {
  if (definition) return definition;
  globalThis.window = { __ModuleLoader__: { load: (d) => { definition = d; } } };
  await import(pathToFileURL(path.join(ROOT, 'src/client.js')).href);
  return definition;
}

/** Collect the single element tree the fake React produced. */
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const child of node.children || []) walk(child, visit);
}

async function render() {
  const def = await loadClient();
  const plugin = def.factory((name) => {
    assert.equal(name, 'react', `client must only require the browser React table, got ${name}`);
    return react;
  });
  const registrations = [];
  plugin.apply({ slots: { inject: (_owner, cb) => cb(), register: (options, component) => {
    registrations.push({ options, component });
    return () => {};
  } } });
  const panel = registrations.find((r) => r.options.name === 'main');
  assert.ok(panel, 'the wizard must register a main panel');
  return { registrations, tree: panel.component({}) };
}

describe('client half (fake-React render)', () => {
  test('registers exactly one main panel and one sidebar entry under the same id', async () => {
    const { registrations } = await render();
    const main = registrations.filter((r) => r.options.name === 'main');
    const sidebar = registrations.filter((r) => r.options.name === 'sidebar.panellist');
    assert.equal(main.length, 1);
    assert.equal(sidebar.length, 1);
    assert.equal(main[0].options.key, sidebar[0].options.id, 'panel key and sidebar id must match');
    assert.equal(registrations.some((r) => r.options.name === 'conversation.composer.dock'), false,
      'a full page must not live in the composer dock (ambient entries only)');
  });

  test('every dropdown carries its options (Select must not drop positional children)', async () => {
    const { tree } = await render();
    const selects = [];
    walk(tree, (node) => { if (node.type === 'select') selects.push(node); });
    assert.equal(selects.length, 3, 'three directory levels: 一级 / 二级 / 三级');
    for (const select of selects) {
      const options = select.children.filter((c) => c && c.type === 'option');
      assert.ok(options.length >= 1, `a select rendered with ${options.length} options`);
    }
    // level 1 is the fixed repository root
    assert.equal(selects[0].children[0].children[0], 'skills');
  });

  test('every field carries its control (Field must not drop positional children)', async () => {
    const { tree } = await render();
    let controls = 0;
    let toggles = 0;
    walk(tree, (node) => {
      if (node.type !== 'input' && node.type !== 'select' && node.type !== 'textarea') return;
      if (node.props.type === 'checkbox' || node.props.type === 'radio') toggles++;
      else controls++;
    });
    // Huawei mode renders exactly: 3 taxonomy selects + the fixed-prefix name input +
    // the single 功能概括 textarea. Everything else is generator-owned.
    assert.equal(controls, 5, 'every Field call site must render its control');
    assert.equal(toggles, 3, 'the three category radios (华为云 / 通用 skills / 通用 API)');
  });

  test('the Huawei skill name keeps a fixed prefix with an editable suffix', async () => {
    const { tree } = await render();
    let prefix = null;
    let suffix = null;
    walk(tree, (node) => {
      if (node.type === 'span' && node.children[0] === 'huawei-cloud-') prefix = node;
      if (node.type === 'input' && node.props.value === 'ecs-manage') suffix = node;
    });
    assert.ok(prefix, 'the literal prefix must be rendered as its own, non-editable element');
    assert.ok(suffix, 'the suffix must stay an editable input');
    assert.equal(suffix.props.readOnly, undefined);
  });

  test('never asks for the values the generator owns', async () => {
    const { tree } = await render();
    const texts = [];
    walk(tree, (node) => { for (const c of node.children || []) if (typeof c === 'string') texts.push(c); });
    const joined = texts.join(' | ');
    for (const owned of ['触发词', 'Overview', 'CLI 命令', '写操作', '质量注入', 'IAM actions', '① 功能概要', 'tags（≤5）']) {
      assert.equal(joined.includes(owned), false, `"${owned}" must be generated, not asked (found in ${joined})`);
    }
  });

  test('each control occupies its own full-width row', async () => {
    const { tree } = await render();
    const cells = [];
    walk(tree, (node) => {
      const style = node.props.style;
      if (style && style.flexDirection === 'column' && style.width === '100%') cells.push(node);
    });
    assert.ok(cells.length >= 5, `every field must be its own full-width cell (got ${cells.length})`);

    const sideBySide = [];
    const isFieldCell = (n) => n && n.props && n.props.style
      && n.props.style.flexDirection === 'column' && n.props.style.width === '100%';
    walk(tree, (node) => {
      const style = node.props.style;
      if (!style || style.display !== 'flex' || style.flexDirection === 'column') return;
      if ((node.children || []).some(isFieldCell)) sideBySide.push(node);
    });
    assert.equal(sideBySide.length, 0, 'no two fields may share a horizontal row');
  });

  test('talks to the in-host API and never to a static list', async () => {
    const code = (await import('node:fs')).readFileSync(path.join(ROOT, 'src/client.js'), 'utf8');
    // Same-origin API served by the Host half through ctx.webServer: no port, no CORS.
    assert.match(code, /const API = '\/dsh-skill-creator\/api'/);
    assert.match(code, /\/catalog\?path=/);
    assert.match(code, /refresh \? '&refresh=1' : ''/);
    assert.doesNotMatch(code, /127\.0\.0\.1:\d+/, 'the panel must not talk to a private port any more');
    assert.doesNotMatch(code, /spec\.domains/, 'the taxonomy must not fall back to the static DOMAINS map');
  });

  test('starts a real run instead of only handing over a prompt', async () => {
    const code = (await import('node:fs')).readFileSync(path.join(ROOT, 'src/client.js'), 'utf8');
    assert.match(code, /'\/run', \{/, 'the panel must POST /run to start the creator');
    assert.match(code, /'开始创建'/);
    assert.doesNotMatch(code, /真跑流程/, 'no editorial annotation in the UI copy');
    assert.match(code, /\/run\?id=/, 'the panel must poll the live run');
    assert.match(code, /\.\.\.\(run\.phases \|\| \[\]\)\.map/, 'the stage checklist must be rendered');
    assert.match(code, /步骤日志/);
    assert.doesNotMatch(code, /只看请求文本|交接请求文本/, 'the handoff-text escape hatch is gone');
    assert.doesNotMatch(code, /PHASE_TITLES/, 'stage titles come from the run, not a hardcoded Huawei list');
    assert.match(code, /p\.title \|\|/, 'the checklist renders the run-provided stage title');
  });

  test('a long run is re-openable: BACK in the detail view, records on the form', async () => {
    const code = (await import('node:fs')).readFileSync(path.join(ROOT, 'src/client.js'), 'utf8');
    // The detail view goes back instead of restarting: the run lives on the Host anyway.
    assert.match(code, /← 返回/, 'the detail view needs a back button');
    assert.doesNotMatch(code, /'新建'/, 'the old 新建 button is gone');
    // The form lists every run so a long creation can be re-entered at any time.
    assert.match(code, /loadRuns/, 'the form must load the run list');
    assert.match(code, /创建记录（\$\{visibleRuns\.length\}）/, 'the form must render the mode-scoped creation records');
    assert.match(code, /runs\.filter\(\(r\) => \(r\.kind \|\| 'huawei'\) === mode\)/, 'records are filtered by the selected mode');
    assert.match(code, /onClick: \(\) => openRun\(r\.id\)/, 'each record opens its detail view');
  });

  test('the form renders the creation-record list', async () => {
    const { tree } = await render();
    const texts = [];
    walk(tree, (node) => { for (const child of node.children || []) if (typeof child === 'string') texts.push(child); });
    const all = texts.join(' | ');
    const literalNewlines = [];
    walk(tree, (node) => {
      if (node.type === 'textarea' && typeof node.props.placeholder === 'string' && node.props.placeholder.includes('\\n')) {
        literalNewlines.push(node.props.placeholder.slice(0, 40));
      }
    });
    assert.deepEqual(literalNewlines, [], 'placeholders must break lines for real, not display \\n');
    assert.match(all, /创建记录（/, 'the record list must be on the form page');
    // Records are scoped to the selected mode (Huawei by default), never both at once.
    assert.match(all, /创建记录（0）· 华为云 skills/);
    assert.match(all, /（暂无华为云 skills 创建记录）/);
    assert.doesNotMatch(all, /暂无通用 skills 创建记录/, 'the other kind is not listed');
  });

  test('generic mode asks for one description and nothing else', async () => {
    const code = (await import('node:fs')).readFileSync(path.join(ROOT, 'src/client.js'), 'utf8');
    assert.match(code, /mode !== 'huawei' && Field\(\{ label: mode === 'api' \? 'REST API 技能需求' : '技能功能描述' \}/, 'the description field is labelled per category');
    assert.match(code, /API_PLACEHOLDER = \[/, 'the api category teaches its requirement shape');
    assert.match(code, /GENERIC_PLACEHOLDER = \[/, 'the generic category uses the same field: example shape');
    assert.match(code, /技能名称：/, 'all three categories share the 技能名称 / 一句话描述 wording');
    assert.match(code, /适用场景：当用户说/, 'the trigger is phrased the way the creator asks for it');
    // Placeholders must contain REAL newlines: a patch once wrote `join('\\\\n')`, which
    // rendered the two characters \\n on screen instead of breaking lines.
    assert.doesNotMatch(code, /\.join\('\\\\\\\\n'\)/, 'no literal backslash-n in the placeholder join');
    assert.match(code, /API 文档：/, 'the api placeholder asks for the API document (endpoints are never guessed)');
    // Name, taxonomy, tags and the 4 summary slots are Huawei packaging: generic-only
    // rendering must be behind a mode guard, never shared with it.
    assert.match(code, /!run && mode === 'huawei' && Field\(\{ label: '技能名 name（前缀固定）' \}/);
    assert.match(code, /!run && mode === 'huawei' && Field\(\{ label: '功能概括' \}/, 'Huawei collects one 功能概括 textarea');
    assert.match(code, /description: gdesc\.trim\(\)/, 'the generic spec carries the description');
  });

  test('评测结果显示在运行卡片里，并按"活跃状态"轮询', async () => {
    const code = (await import('node:fs')).readFileSync(path.join(ROOT, 'src/client.js'), 'utf8');
    // The run now lives in evaluating/fixing for most of its life: polling on 'running'
    // would have stopped the panel dead the moment creation finished.
    assert.match(code, /const ACTIVE_STATES = \['creating', 'evaluating', 'fixing'\]/);
    assert.match(code, /!runId \|\| !ACTIVE_STATES\.includes\(runStatus\)/, 'poll while the run is active');
    assert.match(code, /ACTIVE_STATES\.includes\(run\.status\) && h\('button'/, 'cancel stays available while active');
    // Score, dimensions, deductions and the report are all on the card.
    assert.match(code, /评测 \$\{num\(run\.score\)\}\/10（第 \$\{run\.round\}\/\$\{run\.maxEvalRounds\} 轮）/, 'the score reads as 评测 X.XX/10（第 N/M 轮）');
    assert.match(code, /评测进行中（第 \$\{run\.round\}\/\$\{run\.maxEvalRounds\} 轮）/, 'a round in flight still shows its progress');
    assert.match(code, /稳定性 \$\{num\(run\.dimensions\.stability\)\}\/4 · 成本/, 'the four dimensions are shown');
    assert.match(code, /扣分 \$\{item\.item\} -\$\{item\.points\}：\$\{item\.reason\}/, 'every deduction is listed with its reason');
    assert.match(code, /查看评测报告/, 'the report has an entry point');
    assert.match(code, /readOnly: true, value: run\.report/, 'the report is rendered read-only');
    assert.match(code, /scoreVerdict\(run\)/, 'the verdict line comes from one helper');
    assert.match(code, /'below-threshold': '未达标'/, 'the give-up state has its own label');
    assert.match(code, /'below-threshold': '❌ 未达标', cancelled:/, 'the record list shows 未达标 too');
  });
});
