/**
 * Client half of @cloudplugin/dsh-skill-creator — the creator run console.
 *
 * The panel does NOT generate skills and does NOT hand you a prompt to copy: pressing
 * 「开始创建」 asks the Host half to run the official creator (huawei-cloud-skill-creator /
 * common-skill-creator) for real, and this panel renders the run's phases and steps live.
 *
 * Surface: one id addresses BOTH the sidebar icon (root-scoped `sidebar.panellist`) and
 * the central page (`main` keyed slot) it opens. `conversation.composer.dock` is
 * deliberately NOT used: that slot is "ambient entries below the composer card", so a
 * full form there squeezes the conversation out of view.
 *
 * The API is served by the Host half through ctx.webServer on the same origin, so every
 * call here is a plain relative fetch — no port, no CORS.
 */
window.__ModuleLoader__.load({
  id: '@cloudplugin/dsh-skill-creator',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useRef } = React;

    const API = '/dsh-skill-creator/api';
    const PANEL_ID = 'skill-creator';
    const NAME_PREFIX = 'huawei-cloud-';
    const CATALOG_ROOT = 'skills';
    // Three categories, in MENU ORDER — this array is both the sidebar list and the
    // display order, so 华为云基础云服务技能 is deliberately LAST. The mode KEYS are the
    // Host contract (`POST /run` body `spec.mode`) and the record-scoping key: never
    // rename them. To open the panel on a different category, change DEFAULT_MODE only.
    // `api` is a declared placeholder: it renders one description form and scopes the
    // creation records, exactly like the generic category.
    const MODES = [
      ['generic', '通用技能'],
      ['api', '标准API管理技能'],
      ['huawei', '华为云基础云服务技能'],
    ];
    const MODE_LABEL = { generic: '通用技能', api: '标准API管理技能', huawei: '华为云基础云服务技能' };
    /** The category selected on open: the first menu item (通用技能). */
    const DEFAULT_MODE = 'generic';
    /** States where the run is still doing work (creation, evaluation or a fix round). */
    const ACTIVE_STATES = ['creating', 'evaluating', 'fixing'];
    // The REST-API creator refuses to guess endpoints: it parses a document or probes with
    // curl, and stops without generating anything when neither works. Its placeholder is
    // therefore a filled-in copy of its own requirement template, teaching the required
    // shape (and keeping credentials out of the chat).
    const API_PLACEHOLDER = [
      '技能名称：blog-manager',
      '一句话描述：管理博客文章的发布、编辑、删除和查询',
      '目标系统：我的博客（Hexo）',
      'API 地址：https://blog.example.com/api',
      '认证方式：Bearer Token（凭据走环境变量 BLOG_MANAGER_TOKEN，不要写在这里）',
      'API 文档：粘贴 OpenAPI，或列出端点表，例如',
      '  GET  /api/articles        获取文章列表（支持 page/size 分页）',
      '  POST /api/articles        创建文章（title/content/tags）',
      '  PUT  /api/articles/{id}   更新文章',
    ].join('\n');
    // Same shape as the other categories: field: example lines, one per requirement.
    const GENERIC_PLACEHOLDER = [
      '技能名称：notes-indexer',
      '一句话描述：把一堆 Markdown 笔记整理成带目录和交叉引用的索引页',
      '主要能力：扫描笔记目录、按标题生成层级目录、输出索引页并回写交叉引用',
      '适用场景：当用户说“把我的笔记整理成索引”或“更新笔记目录”时触发',
      '输入输出：输入笔记目录路径，输出 index.md（含目录与双向链接）',
    ].join('\n');

    // The records card shows five creations before scrolling: a longer history would push
    // the requirements form below the fold on this page.
    const RECORDS_VISIBLE = 5;
    const RECORD_ROW_HEIGHT = 30;

    const T = {
      label: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, marginBottom: 3 },
      input: { background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
        border: '.5px solid var(--dsw-alias-border-l3)', borderRadius: 8, padding: '6px 9px',
        fontSize: 13, width: '100%', boxSizing: 'border-box', fontFamily: 'inherit' },
      page: { flex: '1 1 auto', minHeight: 0, height: '100%', overflowY: 'auto',
        boxSizing: 'border-box', color: 'var(--dsw-alias-label-primary)' },
      pageInner: { display: 'flex', flexDirection: 'column', gap: 12,
        padding: '20px 24px 48px', maxWidth: 940, margin: '0 auto' },
      head: { display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 16 },
      // Category switcher: a fixed-width LEFT column + a self-sizing content column. The
      // row wraps, so a narrow panel pushes the content below the menu instead of
      // squeezing it. Neither column sets width:100%, which keeps the "one field per row"
      // invariant measurable by the tests (a row-flex parent must not hold a field cell).
      shell: { display: 'flex', alignItems: 'flex-start', flexWrap: 'wrap', gap: 16, width: '100%' },
      menu: { display: 'flex', flexDirection: 'column', gap: 4,
        flex: '0 0 180px', minWidth: 170, maxWidth: 200 },
      menuItem: { display: 'block', boxSizing: 'border-box', textAlign: 'left', font: 'inherit',
        fontSize: 12.5, padding: '7px 10px', cursor: 'pointer', borderRadius: 8,
        background: 'transparent', border: '.5px solid transparent',
        color: 'var(--dsw-alias-label-secondary)' },
      menuItemActive: { background: 'var(--dsw-alias-bg-layer-2)',
        border: '.5px solid var(--dsw-alias-border-l3)',
        color: 'var(--dsw-alias-label-primary)', fontWeight: 600 },
      content: { display: 'flex', flexDirection: 'column', gap: 12,
        flex: '1 1 380px', minWidth: 260 },
      row: { display: 'flex', flexDirection: 'column', gap: 10 },
      cell: { display: 'flex', flexDirection: 'column', width: '100%' },
      card: { display: 'flex', flexDirection: 'column', gap: 4, padding: '10px 12px', borderRadius: 10,
        background: 'var(--dsw-alias-bg-layer-1)', border: '.5px solid var(--dsw-alias-border-l2)' },
      recordList: { display: 'flex', flexDirection: 'column', gap: 6, overflowY: 'auto', paddingRight: 4,
        maxHeight: RECORDS_VISIBLE * RECORD_ROW_HEIGHT + (RECORDS_VISIBLE - 1) * 6 },
      btn: { background: 'var(--dsw-alias-state-business-primary)', border: 'none', borderRadius: 8,
        color: 'var(--dsw-alias-bg-base)', font: 'inherit', fontWeight: 600, padding: '8px 16px', cursor: 'pointer' },
      btnGhost: { background: 'var(--dsw-alias-bg-layer-2)', border: '.5px solid var(--dsw-alias-border-l3)',
        borderRadius: 8, color: 'var(--dsw-alias-label-primary)', font: 'inherit', padding: '6px 12px', cursor: 'pointer' },
      nameRow: { display: 'flex', alignItems: 'stretch', width: '100%' },
      namePrefix: { display: 'flex', alignItems: 'center', whiteSpace: 'nowrap', fontSize: 13, padding: '0 9px',
        border: '.5px solid var(--dsw-alias-border-l3)', borderRight: 'none', borderRadius: '8px 0 0 8px',
        background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-secondary)' },
      log: { display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 300, overflowY: 'auto',
        padding: '8px 10px', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-1)',
        border: '.5px solid var(--dsw-alias-border-l2)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11.5 },
      metaRow: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      note: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 },
      link: { background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit', fontSize: 12,
        color: 'var(--dsw-alias-state-business-primary)', textDecoration: 'underline' },
      err: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12 },
      warn: { color: 'var(--dsw-alias-state-warn-primary, #e8b339)', fontSize: 12 },
      ok: { color: 'var(--dsw-alias-state-success-primary)', fontSize: 12 },
      dim: { color: 'var(--dsw-alias-label-secondary)' },
    };

    // `T.prompt` is referenced by the three description textareas but was never defined:
    // spreading undefined silently yields {}, so they rendered with a min height and no
    // border/background of their own. Defined here (after T) so it can reuse `input`.
    T.prompt = { ...T.input, minHeight: 140, resize: 'vertical', lineHeight: 1.5 };
    T.nameInput = { ...T.input, borderRadius: '0 8px 8px 0' };

    // Called as Field(props, child): the control arrives as the second positional argument.
    const Field = ({ label, style }, children) => h('div', { style: { ...T.cell, ...(style || {}) } },
      h('div', { style: T.label }, label), children);
    const Input = (p) => h('input', { style: T.input, ...p });
    // Options arrive as the SECOND positional argument (Select(props, options)).
    const Select = (p, children) => h('select', { style: { ...T.input, cursor: 'pointer' }, ...p }, children);

    async function getJson(path, init) {
      const res = await fetch(`${API}${path}`, init);
      const body = await res.json().catch(() => ({}));
      // A bare 404 (no JSON body) means the request never reached this plugin's API —
      // the Host half did not mount its route. Say that, instead of a bare "HTTP 404".
      if (!res.ok && !body.error) throw new Error(`HTTP ${res.status}（Host 侧未挂载面板 API：重启 DSH 或禁用/启用本 bundle）`);
      return body;
    }

    /** One directory level of the live repository tree; never throws. */
    async function fetchCatalog(rel, refresh) {
      try {
        const body = await getJson(`/catalog?path=${encodeURIComponent(rel)}${refresh ? '&refresh=1' : ''}`);
        if (!body.ok) throw new Error(body.error || 'catalog failed');
        return {
          entries: (body.entries || []).filter((e) => e.type === 'dir').map((e) => e.name),
          note: body.stale ? `目录为缓存副本（${body.error}）` : '',
        };
      } catch (e) {
        return { entries: [], note: `目录读取失败：${e.message}` };
      }
    }

    function SkillCreator() {
      const [status, setStatus] = useState(null);
      const [mode, setMode] = useState(DEFAULT_MODE);
      const [domains, setDomains] = useState(null);
      const [products, setProducts] = useState(null);
      const [domain, setDomain] = useState('');
      const [product, setProduct] = useState('');
      const [suffix, setSuffix] = useState('ecs-manage');
      const [catNote, setCatNote] = useState('');
      const [tick, setTick] = useState(0);
      const [creator, setCreator] = useState(null);
      const [creatorNote, setCreatorNote] = useState('');
      const [creatorBusy, setCreatorBusy] = useState(false);
      const [huaweiHint, setHuaweiHint] = useState('');
      const [gdesc, setGdesc] = useState('');
      const [run, setRun] = useState(null);
      const [runs, setRuns] = useState([]);
      const [busy, setBusy] = useState(false);
      const pollRef = useRef(null);

      const name = mode === 'huawei' ? NAME_PREFIX + suffix : suffix;
      const validName = (n) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(n || '') && (n || '').length <= 64;

      useEffect(() => {
        getJson('/status').then(setStatus).catch((e) => setCatNote(`API 不可用（${e.message}）— 确认 bundle 已启用`));
      }, []);

      // The run list is what makes a long creation survivable: leaving the detail view
      // must never lose the run, so the form page lists every run and reopens its detail.
      const loadRuns = useCallback(async () => {
        try {
          const body = await getJson('/run');
          if (body.ok) setRuns(body.runs || []);
        } catch { /* list is a convenience; keep the last snapshot */ }
      }, []);
      useEffect(() => { loadRuns(); }, [loadRuns]);

      const openRun = useCallback(async (id) => {
        try {
          const body = await getJson(`/run?id=${encodeURIComponent(id)}`);
          if (body.ok) setRun(body.run);
          else setCreatorNote(body.error || 'run not found');
        } catch (e) { setCreatorNote(`打开记录失败：${e.message}`); }
      }, []);

      const loadCreator = useCallback(async (which, refresh) => {
        setCreatorBusy(true);
        try {
          const body = await getJson(`/creator?mode=${which}${refresh ? '&refresh=1' : ''}`);
          setCreator(body);
          setCreatorNote(body.ok ? '' : `creator 读取失败：${body.error}`);
        } catch (e) { setCreator(null); setCreatorNote(`creator 读取失败：${e.message}`); }
        finally { setCreatorBusy(false); }
      }, []);
      useEffect(() => { if (!run) loadCreator(mode, false); }, [mode, loadCreator, run]);

      // The three-level taxonomy is a Huawei-Cloud packaging rule, so it is fetched LAZILY
      // — only once the panel actually shows the 华为云基础云服务技能 category (the default
      // category asks for nothing but a description, and must not hit the repo on open).
      useEffect(() => {
        if (mode !== 'huawei') return undefined;
        let cancelled = false;
        fetchCatalog(CATALOG_ROOT, tick > 0).then((r) => {
          if (cancelled) return;
          setDomains(r.entries);
          setCatNote(r.note);
        });
        return () => { cancelled = true; };
      }, [mode, tick]);

      useEffect(() => {
        if (mode !== 'huawei' || !domain) { setProducts(null); setProduct(''); return undefined; }
        let cancelled = false;
        fetchCatalog(`${CATALOG_ROOT}/${domain}`, tick > 0).then((r) => {
          if (cancelled) return;
          setProducts(r.entries);
          setProduct(r.entries[0] || '');
          setCatNote(r.note);
        });
        return () => { cancelled = true; };
      }, [mode, domain, tick]);

      useEffect(() => {
        if (domains && domains.length && !domains.includes(domain)) {
          setDomain(domains.includes('computing') ? 'computing' : domains[0]);
        }
      }, [domains]);

      // Live run polling: a cheap 1 s poll while the agent is working, plus a list refresh
      // whenever the selected run settles (so the form page shows the new status).
      const runId = run && run.id;
      const runStatus = run && run.status;
      useEffect(() => {
        if (!runId || !ACTIVE_STATES.includes(runStatus)) return undefined;
        const timer = setInterval(async () => {
          try {
            const body = await getJson(`/run?id=${encodeURIComponent(runId)}`);
            if (body.ok) setRun(body.run);
          } catch { /* keep the last good snapshot */ }
        }, 1000);
        pollRef.current = timer;
        return () => clearInterval(timer);
      }, [runId, runStatus]);
      useEffect(() => {
        if (runId && runStatus && !ACTIVE_STATES.includes(runStatus)) loadRuns();
      }, [runId, runStatus, loadRuns]);

      const genericReady = gdesc.trim().length >= 8;
      // Records are scoped to the selected mode: the form is about ONE kind of skill, so
      // showing the other kind's history there is noise.
      const visibleRuns = runs.filter((r) => (r.kind || 'huawei') === mode);
      const descriptionOnly = mode !== 'huawei';
      const spec = useCallback(() => (descriptionOnly
        // Generic creation is one free-form description: no name, no taxonomy, no tags —
        // those are Huawei-Cloud packaging rules, and the generic creator derives its own.
        ? { mode, description: gdesc.trim() }
        : {
          mode,
          name,
          domain,
          product,
          description: huaweiHint.trim(),
        }), [mode, name, domain, product, gdesc, descriptionOnly, huaweiHint]);

      const startRun = useCallback(async () => {
        if (mode === 'huawei' && !validName(name)) return setCreatorNote('技能名非法：1-64 字符、小写字母/数字/连字符，无首尾/连续连字符');
        if (mode !== 'huawei' && !genericReady) return setCreatorNote('请填写技能功能描述（至少 8 个字符）');
        setBusy(true); setCreatorNote('');
        try {
          const body = await getJson('/run', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ spec: spec() }),
          });
          if (!body.ok) throw new Error(body.error || 'run failed');
          setRun(body.run);
        } catch (e) { setCreatorNote(`启动失败：${e.message}`); }
        finally { setBusy(false); }
      }, [mode, name, spec]);

      const cancelRun = useCallback(async () => {
        if (!run) return;
        try {
          const body = await getJson('/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: run.id }) });
          if (body.run) setRun(body.run);
        } catch { /* ignore */ }
      }, [run]);

      const options = (list, empty) => (list === null
        ? h('option', null, '读取中…')
        : list.length === 0 ? h('option', null, empty) : list.map((v) => h('option', { key: v, value: v }, v)));

      const creatorLine = creator && creator.present
        ? `${creator.skill} · ${creator.branch}@${String(creator.commit || '').slice(0, 8) || '?'} · ${creator.files.length} 文件`
        : `${(creator && creator.skill) || 'creator'} 未就绪`;

      const phaseStyle = (state) => (state === 'done' ? T.ok : state === 'active' ? T.warn : T.dim);
      const runLabel = (s) => ({
        creating: '创建中',
        evaluating: '评测中',
        fixing: '修复中',
        done: '已完成',
        'below-threshold': '未达标',
        cancelled: '已取消',
        interrupted: '已中断',
        failed: '失败',
      }[s] || s || '');
      const statusBadge = (s) => ({
        creating: '⏳ 创建中', evaluating: '⏳ 评测中', fixing: '🔧 修复中',
        done: '✅ 已完成', 'below-threshold': '❌ 未达标', cancelled: '⛔ 已取消',
        interrupted: '⚠️ 已中断', failed: '❌ 失败',
      }[s] || s || '');
      const num = (value, digits = 2) => (Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '-');
      /** 阈值判定：达标 / 未达标 / 到顶未达标 */
      const scoreVerdict = (r) => (r.verdict === 'pass'
        ? `✅ 达标（通过线 ${r.passScore}）`
        : r.verdict === 'below-threshold'
          ? `❌ 未达标·已达 ${r.maxEvalRounds} 轮上限（通过线 ${r.passScore}）`
          : `❌ 未达标（通过线 ${r.passScore}）`);

      return h('div', { style: T.page }, h('div', { style: T.pageInner },
        h('div', { style: T.head }, 'Scenes Skill Creator',
          run
            // A creation can run for many minutes, so the detail view goes BACK rather
            // than starting a new one — the run keeps going on the Host either way.
            ? h('span', { style: { marginLeft: 'auto' } },
              h('button', { style: T.btnGhost, type: 'button', onClick: () => { setRun(null); setCreatorNote(''); loadRuns(); } }, '← 返回'))
            : null),

        // Category switcher: an in-page LEFT vertical menu — NOT top radios, and NOT a
        // tab strip. The menu labels are for humans only; `setMode` still writes the
        // `huawei|generic|api` keys the Host API and the record scoping use.
        h('div', { style: T.shell },
          !run && h('nav', { style: T.menu, 'aria-label': '技能类型' },
            h('div', { style: T.label }, '技能类型'),
            ...MODES.map(([value, label]) => h('button', {
              key: value, type: 'button', 'data-mode': value,
              'data-active': mode === value ? '1' : undefined,
              'aria-current': mode === value ? 'true' : undefined,
              style: { ...T.menuItem, ...(mode === value ? T.menuItemActive : {}) },
              onClick: () => setMode(value),
            }, label))),
          h('div', { style: T.content },

        // Which creator runs, and the live run state.
        h('div', { style: T.card },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
            h('strong', null, creatorLine),
            !run && h('button', { style: T.link, type: 'button', disabled: creatorBusy,
              onClick: () => loadCreator(mode, true) }, creatorBusy ? '拉取中…' : '从仓库拉取最新')),
          creator && creator.web ? h('div', { style: T.note }, creator.web) : null,
          h('div', { style: { ...T.note, fontSize: 11 } },
            '创建由该 creator 技能自己的流程完成；本面板只收集需求并展示运行步骤。'),
          !run && (creator && creator.present
            ? h('div', { style: T.ok }, `已注册为可加载 skill：${creator.skill}`)
            : h('div', { style: T.warn }, '尚未拉到 creator：点“从仓库拉取最新”')),
          run && h('div', { style: T.note },
            `session ${run.sessionId} · ${runLabel(run.status)}` + (run.turn ? ` · turn ${run.turn} step ${run.step}` : '')),
          run && run.spec && run.spec.name
            ? h('div', { style: { ...T.note, fontSize: 11 } }, `技能名 ${run.spec.name} · preset ${run.agentPreset || '?'} · 权限 ${(run.permission && run.permission.preset) || '?'}`)
            : null,
          run && h('div', { style: { ...T.note, fontSize: 11 } },
            `已用时 ${Math.max(0, Math.round(((run.lastActivityAt || Date.now()) - run.startedAt) / 60000))} 分钟`
            + (run.lastActivityAt ? ` · 最后活动 ${Math.max(0, Math.round((Date.now() - run.lastActivityAt) / 1000))} 秒前` : '')),
          run && run.target ? h('div', { style: { ...T.note, fontSize: 11 } }, `工作目录 ${run.cwd}`) : null,
          run && run.target ? h('div', { style: { ...T.note, fontSize: 11 } }, `目标目录 ${run.target}`) : null,
          run && run.error ? h('div', { style: T.err }, run.error) : null),

        // Stage checklist. Titles come from the run (per-kind): the Huawei pipeline and the
        // generic five-stage pipeline are different flows, so the label is not generic.
        run && h('div', { style: T.card },
          h('div', { style: T.label }, `创建流程（${(run.phases || []).length} 阶段）`),
          ...(run.phases || []).map((p) => h('div', { key: p.id, style: { ...phaseStyle(p.state), fontSize: 12.5 } },
            `${p.state === 'done' ? '✅' : p.state === 'active' ? '⏳' : '○'} ${p.title || `阶段 ${p.id}`}`))),

        // Evaluation card: the 10-point rubric score (8.5 = 达标), its dimensions and the
        // itemised deductions, plus the report once the run has settled.
        run && run.maxEvalRounds > 0 && (run.score !== null && run.score !== undefined || run.status === 'evaluating' || run.status === 'fixing') && h('div', { style: T.card },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            h('strong', { style: run.verdict === 'pass' ? T.ok : run.verdict ? T.err : T.dim },
              run.verdict === 'pass'
                ? '✅ 通过'
                : run.score === null || run.score === undefined
                  ? `评测进行中（第 ${run.round}/${run.maxEvalRounds} 轮）`
                  : `评测 ${num(run.score)}/10（第 ${run.round}/${run.maxEvalRounds} 轮）`),
            run.verdict && run.verdict !== 'pass'
              ? h('span', { style: T.err }, scoreVerdict(run)) : null),
          run.dimensions ? h('div', { style: { ...T.note, fontSize: 11.5 } },
            `${run.score === null || run.score === undefined ? '' : `得分 ${num(run.score)}/10 · `}`
            + `稳定性 ${num(run.dimensions.stability)}/4 · 成本 ${num(run.dimensions.cost)}/1 · 效率 ${num(run.dimensions.efficiency)}/2 · 安全 ${num(run.dimensions.security)}/3`) : null,
          ...(run.deductions || []).map((item, index) => h('div', { key: `d${index}`, style: { ...T.warn, fontSize: 11.5 } },
            `扣分 ${item.item} -${item.points}：${item.reason}`)),
          (run.evaluations || []).length > 1
            ? h('div', { style: { ...T.note, fontSize: 11 } },
              `各轮：${run.evaluations.map((e) => `第${e.round}轮 ${num(e.total)}`).join(' · ')}`)
            : null,
          run.report ? h('details', { key: 'report' },
            h('summary', { style: { ...T.link, cursor: 'pointer' } }, '查看评测报告'),
            h('textarea', {
              style: { ...T.prompt, minHeight: 200, marginTop: 6 },
              readOnly: true, value: run.report,
            })) : null),

        // Step log.
        run && h('div', { style: T.cell },
          h('div', { style: T.label }, `步骤日志（${(run.steps || []).length}）`),
          h('div', { style: T.log },
            ...((run.steps || []).length
              ? run.steps.slice(-120).map((s, i) => h('div', {
                key: i,
                style: s.kind === 'error' ? T.err : s.kind === 'warn' ? T.warn : s.kind === 'phase' ? T.ok : T.dim,
              }, `${new Date(s.at).toLocaleTimeString()} ${String(s.kind).padEnd(5)} ${s.text}`))
              : [h('div', { key: 'x', style: T.dim }, '等待第一步…')]))),

        // Creation records for the SELECTED mode only: the form is about one kind of skill,
        // so the other kind's history would just be noise here.
        !run && h('div', { style: T.card },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
            h('div', { style: T.label },
              `创建记录（${visibleRuns.length}）· ${MODE_LABEL[mode] || mode}`
              + (visibleRuns.length > RECORDS_VISIBLE ? `（可滚动查看全部）` : '')),
            h('button', { style: T.link, type: 'button', onClick: () => loadRuns() }, '刷新')),
          h('div', { style: T.recordList },
            ...(visibleRuns.length ? visibleRuns.map((r) => {
            const badge = statusBadge(r.status);
            const when = r.startedAt ? new Date(r.startedAt).toLocaleString() : '';
            return h('button', {
              key: r.id, type: 'button', onClick: () => openRun(r.id),
              style: { display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                background: 'var(--dsw-alias-bg-layer-2)', border: '.5px solid var(--dsw-alias-border-l2)',
                borderRadius: 8, padding: '6px 10px', cursor: 'pointer', color: 'var(--dsw-alias-label-primary)',
                font: 'inherit', fontSize: 12.5 },
            },
            h('span', { style: ACTIVE_STATES.includes(r.status) ? T.warn : r.status === 'done' ? T.ok : T.err }, badge),
            h('span', null, (r.spec && r.spec.name) || (r.spec && r.spec.description ? r.spec.description.slice(0, 28) : r.id.slice(0, 20))),
            h('span', { style: { ...T.dim, marginLeft: 'auto' } },
              `${r.phase ? `阶段 ${r.phase} · ` : ''}${when}`));
          }) : [h('div', { key: 'none', style: { ...T.dim, fontSize: 12 } },
            `（暂无${MODE_LABEL[mode] || mode} 创建记录）`)]))),

        // Requirements form (only while nothing is running).
        !run && mode === 'huawei' && h('div', { style: T.row },
          Field({ label: '一级目录（固定根）' },
            Select({ value: CATALOG_ROOT, disabled: true, title: '仓库根目录，固定' },
              h('option', { key: CATALOG_ROOT, value: CATALOG_ROOT }, CATALOG_ROOT))),
          Field({ label: '二级目录（一级下读取）' },
            Select({ value: domain, onChange: (e) => setDomain(e.target.value) }, options(domains, '（无子目录）'))),
          Field({ label: '三级目录（二级下读取）' },
            Select({ value: product, onChange: (e) => setProduct(e.target.value) }, options(products, '（无子目录）')))),
        // Generic/API modes have NO name field and no taxonomy: one description is the form.
        !run && mode === 'huawei' && Field({ label: '技能名 name（前缀固定）' },
          h('div', { style: T.nameRow },
            h('span', { style: T.namePrefix }, NAME_PREFIX),
            h('input', { style: T.nameInput, value: suffix, spellCheck: false, placeholder: 'ecs-manage',
              onChange: (e) => setSuffix(e.target.value) }))),
        !run && mode === 'huawei' && h('div', { style: { fontSize: 12, color: validName(name) ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)' } },
          !validName(name) ? '✗ 需 1-64 字符、小写字母/数字/连字符，无首尾/连续连字符' : `✓ ${name} → skills/${domain}/${product}/${name}/`),

        // Generic skills get exactly one input: what the skill should do. Name, taxonomy,
        // tags and the 4 description slots are Huawei-Cloud packaging concerns and would
        // only push generic creation into a shape the generic creator does not want.
        !run && mode !== 'huawei' && Field({ label: mode === 'api' ? 'REST API 技能需求' : '技能功能描述' },
          h('textarea', {
            style: { ...T.prompt, minHeight: mode === 'api' ? 200 : 140 },
            value: gdesc, spellCheck: false,
            placeholder: mode === 'api' ? API_PLACEHOLDER : GENERIC_PLACEHOLDER,
            onChange: (e) => setGdesc(e.target.value),
          })),
        !run && mode === 'huawei' && Field({ label: '功能概括' },
          h('textarea', {
            style: { ...T.prompt, minHeight: 130 },
            value: huaweiHint, spellCheck: false,
            placeholder: '功能概要：查询 ECS 云服务器列表\n主要能力：按区域、状态等条件过滤并列出实例，可查看单台实例详情\n技术基础：KooCLI（hcloud 命令）\n适用场景：当用户需要查看或巡检 ECS 实例列表时\ntags：huawei-cloud, ecs',
            onChange: (e) => setHuaweiHint(e.target.value),
          })),

        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
          !run && h('button', { style: T.btn, disabled: busy || !status || (mode !== 'huawei' && !genericReady), onClick: startRun }, busy ? '⏳ 启动中…' : '开始创建'),
          run && ACTIVE_STATES.includes(run.status) && h('button', { style: T.btnGhost, type: 'button', onClick: cancelRun }, '取消'),
          creatorNote && h('span', { style: T.err }, creatorNote))),
      )));
    }

    /** Sidebar glyph: the sidebar passes the edge and paints it with `currentColor`. */
    function SkillCreatorIcon({ size }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': true,
        style: { display: 'block' } },
      h('path', { d: 'M9.2 1.4 3.6 8.6h3.5l-.5 6 5.6-7.2H8.7z', fill: 'currentColor' }));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // The sidebar icon and the page it opens share one id; the sidebar owns the
        // button and resolves its label from the list metadata.
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: PANEL_ID,
        }, SkillCreator));
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: 'Scenes Skill Creator',
        }, SkillCreatorIcon));
      },
    };
  },
});
