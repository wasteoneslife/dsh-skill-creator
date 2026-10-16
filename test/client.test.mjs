import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * Minimal React stand-in: elements are plain objects, hooks are inert — EXCEPT
 * `useState`, which keeps real per-mount state so `render(mode)` can click the sidebar
 * menu exactly like a user and re-render (the panel is now a left menu, and the
 * category-specific form must stay reachable in tests).
 *
 * `createElement` keeps positional children, which is the whole point — the two
 * shipped defects were helpers that dropped their positional children argument
 * (`Field(props, control)` rendered labels only; `Select(props, options)` rendered
 * empty dropdowns), and counting element types alone never caught either.
 */
let hooks = [];
let cursor = 0;
const react = {
  Fragment: 'Fragment',
  createElement: (type, props, ...children) => ({
    type,
    props: props || {},
    children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
  }),
  useState: (init) => {
    const i = cursor++;
    if (i >= hooks.length) hooks[i] = typeof init === 'function' ? init() : init;
    return [hooks[i], (next) => { hooks[i] = typeof next === 'function' ? next(hooks[i]) : next; }];
  },
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

/**
 * Render the panel, optionally after clicking the sidebar menu item for `mode` — the
 * panel is a left menu, so a category's form is reached by clicking, not by props.
 */
async function render(mode) {
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

  const mount = () => { cursor = 0; return panel.component({}); };
  hooks = []; // fresh mount: no state leaks between tests
  let tree = mount();
  if (mode) {
    const item = menuItem(tree, mode);
    item.props.onClick();
    tree = mount();
  }
  return { registrations, tree };
}

/** The sidebar menu entry for a category key (the menu is data-mode addressed). */
function menuItem(tree, mode) {
  let found = null;
  walk(tree, (node) => { if (node.type === 'button' && node.props['data-mode'] === mode) found = node; });
  return found;
}

/** Menu entries in rendered order: [[modeKey, label], …]. */
function menu(tree) {
  const items = [];
  walk(tree, (node) => {
    if (node.type === 'button' && node.props['data-mode']) items.push([node.props['data-mode'], node.children.join('')]);
  });
  return items;
}

/** Plain text of every string child in the tree, joined for regex assertions. */
function text(tree) {
  const out = [];
  walk(tree, (node) => { for (const c of node.children || []) if (typeof c === 'string') out.push(c); });
  return out;
}

/** How many elements of a given type the tree contains. */
function countType(tree, type) {
  let n = 0;
  walk(tree, (node) => { if (node.type === type) n++; });
  return n;
}

describe('client half (fake-React render)', () => {
  test('registers exactly one main panel and one sidebar entry under the same id', async () => {
    const { registrations } = await render();
    const main = registrations.filter((r) => r.options.name === 'main');
    const sidebar = registrations.filter((r) => r.options.name === 'sidebar.panellist');
    assert.equal(main.length, 1);
    assert.equal(sidebar.length, 1);
    assert.equal(main[0].options.key, sidebar[0].options.id, 'panel key and sidebar id must match');
    assert.equal(sidebar[0].options.label, 'Scenes Skill Creator', 'the sidebar entry is titled Scenes Skill Creator');
    assert.equal(registrations.some((r) => r.options.name === 'conversation.composer.dock'), false,
      'a full page must not live in the composer dock (ambient entries only)');
  });

  test('every dropdown carries its options (Select must not drop positional children)', async () => {
    const { tree } = await render('huawei');
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
    const { tree } = await render('huawei');
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
    assert.equal(toggles, 0, 'category switching is a sidebar menu now, not radios/checkboxes');

    // The other two categories render exactly one control: the description textarea.
    for (const mode of ['generic', 'api']) {
      const other = await render(mode);
      let count = 0;
      walk(other.tree, (node) => {
        if (node.type !== 'input' && node.type !== 'select' && node.type !== 'textarea') return;
        if (node.props.type === 'checkbox' || node.props.type === 'radio') return;
        count++;
      });
      assert.equal(count, 1, `${mode} mode must render only its description field`);
    }
  });

  test('the Huawei skill name keeps a fixed prefix with an editable suffix', async () => {
    const { tree } = await render('huawei');
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
    const { tree } = await render('huawei');
    const texts = [];
    walk(tree, (node) => { for (const c of node.children || []) if (typeof c === 'string') texts.push(c); });
    const joined = texts.join(' | ');
    for (const owned of ['触发词', 'Overview', 'CLI 命令', '写操作', '质量注入', 'IAM actions', '① 功能概要', 'tags（≤5）']) {
      assert.equal(joined.includes(owned), false, `"${owned}" must be generated, not asked (found in ${joined})`);
    }
  });

  test('each control occupies its own full-width row', async () => {
    const { tree } = await render('huawei');
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
    // The sidebar shell is a row-flex container TOO: it must hold the menu + the content
    // column, never a field cell directly, or the invariant above would be violated.
    let shell = null;
    walk(tree, (node) => {
      const style = node.props.style;
      if (!style || style.display !== 'flex') return;
      if ((node.children || []).some((c) => c && c.type === 'nav')) shell = node;
    });
    assert.ok(shell, 'the menu and the content share one row container');
    assert.equal(shell.props.style.flexWrap, 'wrap', 'a narrow panel wraps the content below the menu');
    assert.equal(shell.children.length, 2, 'the row holds the menu and the content column');
    assert.equal(shell.children[0].type, 'nav', 'the menu comes FIRST (left column)');
    assert.equal(shell.children[1].props.style.flexDirection, 'column', 'the content is a column');
    assert.equal(shell.children[1].props.style.width, undefined, 'the content sizes itself (no width:100%)');
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
    const { tree } = await render('huawei');
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
    // Records are scoped to the selected category, never several at once.
    assert.match(all, /创建记录（0）· 华为云基础云服务技能/);
    assert.match(all, /（暂无华为云基础云服务技能 创建记录）/);
    assert.doesNotMatch(all, /暂无通用技能 创建记录/, 'the other kind is not listed');
  });

  test('the three categories are an in-page LEFT menu, not top radios', async () => {
    const { tree } = await render();
    const code = (await import('node:fs')).readFileSync(path.join(ROOT, 'src/client.js'), 'utf8');

    // The horizontal radio strip is gone — from the render AND from the source.
    const radios = [];
    walk(tree, (node) => { if (node.props && node.props.type === 'radio') radios.push(node); });
    assert.deepEqual(radios, [], 'no radio input may be rendered any more');
    assert.doesNotMatch(code, /type: 'radio'/, 'the top radio switcher is gone');
    assert.doesNotMatch(code, /name: 'smode'/, 'the old radio group is gone');

    // …replaced by a vertical menu on the left of the content.
    let nav = null;
    walk(tree, (node) => { if (node.type === 'nav') nav = node; });
    assert.ok(nav, 'the category switcher must be a nav element');
    assert.equal(nav.props.style.flexDirection, 'column', 'the menu is a vertical list, not a row');
    assert.equal(nav.props.style.display, 'flex');
    // ~170-200px fixed column, so the content can size itself and a narrow panel wraps
    // instead of squeezing the form.
    assert.equal(nav.props.style.flex, '0 0 180px', 'fixed-width left column');
    assert.ok(nav.props.style.minWidth >= 170 && nav.props.style.maxWidth <= 200,
      `menu width stays in 170-200px (got ${nav.props.style.minWidth}-${nav.props.style.maxWidth})`);

    const items = menu(tree);
    assert.equal(items.length, 3, 'exactly three category entries');
    for (const [key, label] of items) {
      assert.ok(label.length > 0, `the ${key} entry has a label`);
      assert.ok(menuItem(tree, key).props.onClick, `the ${key} entry must be clickable`);
    }
  });

  test('menu labels are exact, and 华为云 is the LAST entry', async () => {
    const { tree } = await render();
    const items = menu(tree);
    assert.deepEqual(items.map(([, label]) => label),
      ['通用技能', '标准API管理技能', '华为云基础云服务技能'],
      'the three display names, in order');
    assert.deepEqual(items.map(([key]) => key), ['generic', 'api', 'huawei'],
      'the menu order is generic → api → huawei (the bounds of the click targets)');
    // The order itself is asserted, not just membership: 华为云 belongs at the END.
    assert.equal(items[items.length - 1][1], '华为云基础云服务技能', '华为云 must be the LAST menu item');
    assert.equal(items[0][1], '通用技能', '通用技能 must be the FIRST menu item');
    assert.notEqual(items[0][1], '华为云基础云服务技能');
  });

  test('the old category labels are gone', async () => {
    const code = (await import('node:fs')).readFileSync(path.join(ROOT, 'src/client.js'), 'utf8');
    for (const old of ["' 华为云 skills '", "' 通用 skills '", "' 通用 API '", '华为云 skills', '通用 skills', '通用 API']) {
      assert.equal(code.includes(old), false, `stale label ${JSON.stringify(old)} is still in the client`);
    }
  });

  test('clicking a menu entry switches the form and the records of THAT category', async () => {
    const generic = await render('generic');
    assert.match(text(generic.tree).join(' | '), /创建记录（0）· 通用技能/);
    assert.doesNotMatch(text(generic.tree).join(' | '), /暂无标准API管理技能 创建记录/);
    assert.equal(countType(generic.tree, 'select'), 0, 'generic mode has no taxonomy dropdowns');

    const api = await render('api');
    const apiText = text(api.tree);
    assert.match(apiText.join(' | '), /创建记录（0）· 标准API管理技能/);
    assert.ok(apiText.includes('REST API 技能需求'), 'api mode asks for its requirement document');
    assert.equal(apiText.includes('技能功能描述'), false, 'the generic label is not used by api mode');
    assert.equal(countType(api.tree, 'select'), 0, 'api mode has no taxonomy dropdowns');

    const huawei = await render('huawei');
    const huaweiText = text(huawei.tree);
    assert.match(huaweiText.join(' | '), /创建记录（0）· 华为云基础云服务技能/);
    assert.ok(huaweiText.includes('功能概括'), 'Huawei mode keeps its 功能概括 textarea');
    assert.ok(huaweiText.includes('技能名 name（前缀固定）'), 'Huawei mode keeps the fixed-prefix name field');
    assert.equal(countType(huawei.tree, 'select'), 3, 'Huawei mode reads the three-level taxonomy');
  });

  test('the default category is the first menu item', async () => {
    const { tree } = await render();
    const items = menu(tree);
    const active = items.filter(([key]) => menuItem(tree, key).props['data-active'] === '1');
    assert.deepEqual(active.map(([key]) => key), ['generic'], 'exactly one entry is highlighted, on open');
    assert.equal(items[0][0], 'generic', 'the highlighted entry is the first menu item');
    const code = (await import('node:fs')).readFileSync(path.join(ROOT, 'src/client.js'), 'utf8');
    assert.match(code, /const DEFAULT_MODE = 'generic';/, 'the default is one named constant');
    assert.match(code, /const \[mode, setMode\] = useState\(DEFAULT_MODE\)/);
  });

  test('the Huawei taxonomy is fetched only when 华为云 is selected', async () => {
    const code = (await import('node:fs')).readFileSync(path.join(ROOT, 'src/client.js'), 'utf8');
    // The default category must not hit the repository on open.
    assert.match(code, /if \(mode !== 'huawei'\) return undefined;/);
    assert.match(code, /if \(mode !== 'huawei' \|\| !domain\)/);
    assert.match(code, /\}, \[mode, tick\]\);/, 'the level-1 fetch re-runs when the category changes');
    assert.match(code, /\}, \[mode, domain, tick\]\);/, 'the level-2/3 fetch is category-aware');
  });

  test('the page and the sidebar entry are titled Scenes Skill Creator', async () => {
    const fs = await import('node:fs');
    for (const lang of ['zh', 'en']) {
      const locale = JSON.parse(fs.readFileSync(path.join(ROOT, `locale/${lang}.json`), 'utf8'));
      assert.equal(locale.meta.title, 'Scenes Skill Creator', `${lang}.json meta.title`);
      assert.ok(locale.meta.description.length > 0);
    }
    const code = fs.readFileSync(path.join(ROOT, 'src/client.js'), 'utf8');
    assert.match(code, /'Scenes Skill Creator'/, 'the client renders the same title');
    assert.doesNotMatch(code, /⚡ Skill Creator/, 'the old header copy is gone');
    const { tree } = await render();
    assert.ok(text(tree).includes('Scenes Skill Creator'), 'the header text must be connected');
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
