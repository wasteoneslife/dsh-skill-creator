# @cloudplugin/dsh-skill-creator

DeepSeek Harness 插件：**在面板里一键真跑官方 creator 的流程创建 Skill**，并实时展示每一步。

插件自己**不生成技能**——创建技能是官方 creator 技能的职责（六阶段流水线）。插件负责：

1. **按模式抓取最新的官方 creator**（缓存 + 记录 commit + 可刷新）
2. **把它注册成 agent 可直接加载的 DSH skill**（`ctx.skills.registerProvider`）
3. **起一个真 agent 执行 creator，并把运行过程变成可视步骤**（`ctx.agents.create` + `agent.followup` + `agent/assistant-stream`）

| 模式 | creator | 来源 |
| --- | --- | --- |
| 华为云 | `huawei-cloud-skill-creator` | `gitcode.com/huaweicloud/huaweicloud-skills` @ `master` → `skills/devtools/common/huawei-cloud-skill-creator` |
| 通用 | `common-skill-creator` | `gitcode.com/grape-dev/grape-skills` @ `main` → `skills/coding/scaffolding/common-skill-creator` |

**为什么这样设计**：creator 是「技能」而不是库，六阶段流程（苏格拉底式需求 → CLI/SDK/API 三级回退调研 → 文档生成 → 测试准备 → 详细测试 → 清理与合规）是 agent 干的活。填模板式的复刻只会得到功能不全的产物；委派之后上游怎么改、插件就跟着怎么改。

## 从 npm 安装

```bash
# DSH 内：让 agent 执行 plugin_manager install_bundle，target = 下面这个 spec（推荐，走 app 自己的审批流）
@cloudplugin/dsh-skill-creator@0.0.1
```

或等价的 CLI 路径（把包装进某个 profile 并把它的包名加进该 profile 的 `dsh.profile.bundles`）：

```bash
dsh plugin --profile desktop add @cloudplugin/dsh-skill-creator
```

装完 **重启 DSH**：profile 的 `dsh.profile.bundles` / `node_modules` 解析只发生在启动时。

- 本包是 **bundle**：`package.json` 里 `dsh.bundle.patch` → `cordis.patch.yml` 往 Cordis 插件树插一行；`dsh.client.platform = web` + `exports["./client"]` 提供浏览器半部。
- **包名必须与 `src/client.js` 里 `window.__ModuleLoader__.load({ id })` 完全一致**（两者一个是 install 名、一个是浏览器模块名；不一致时浏览器侧直接报 `bundle … loaded without registering "…"`）。
- 本地开发可以用 `link:` 装（例如 profile 的 dependencies 写 `"@cloudplugin/dsh-skill-creator": "link:D:/path/to/repo"`）；`link:` 只在包名与依赖键一致时才能被解析到。
- **装完必须配置 `config.run.cwd`**（默认回落到 DSH host 进程的 cwd，实测就是 profile 目录），否则技能会写进 profile 目录而不是你的工作区。见下面「运行配置」。

## 工作方式

```
面板（填需求）
   └─ POST /dsh-skill-creator/api/run
        └─ Host：ctx.agents.create()              新建一个真 agent（用 profile 默认模型）
             agent.followup(creator 请求)         把需求交给 creator 技能
             ctx.on('agent/assistant-stream', …)  把流式帧转成步骤
   └─ 面板每 1 秒 GET /run?id=…                    渲染阶段清单 + 步骤日志
```

- **阶段清单**：扫描 creator 自己的 `Phase 1..6` 标记，实时把六阶段点亮
- **步骤日志**：工具调用（`read_file`/`bash`/`skill` …）与阶段切换逐条记录，含模型报错
- **可控**：运行中可「取消」（`agent.cancel` + 释放句柄）；运行结束可「新建」再跑一次
- **产物位置**：技能落在 creator Phase 3 规定的 `<root>/<domain>/<product>/<name>`，面板日志里能看到它写的每一步

## API（全部跑在 Host 进程内）

`ctx.webServer.register({kind:'prefix', path:'/dsh-skill-creator/api', handler})` —— **同源**，所以面板里都是相对路径 fetch，没有端口、没有 CORS、没有跨进程：

| 路由 | 作用 |
| --- | --- |
| `GET /status` | 目录源描述 + 两个 creator 的状态 |
| `GET /catalog?path=…&refresh=1` | 逐级读仓库目录（一级/二级/三级下拉） |
| `GET /creator?mode=…&refresh=1` | creator 状态，`refresh=1` 时从仓库拉最新 |
| `POST /run` | **启动一次真创建**（起 agent、发请求、开始记录） |
| `GET /run?id=…` / `GET /run` | 单次运行快照 / 运行列表 |
| `POST /cancel` | 取消一次运行 |
| `POST /handoff` | 只产出请求文本（备用：想自己在对话里发时用） |
| `POST /validate` | 本地校验器审一个技能包 |

## DSH 集成（实测契约，DeepSeek Harness 0.0.1-rc.2）

- 结构：`package.json` 声明 `dsh.bundle.patch`（→ `cordis.patch.yml` 插入一行）+ `dsh.client`（platform=web）＋ `exports ./client`
- **Host 半部** `src/core/plugin.mjs`（一个 `ctx.effect` 拥有全部注册与回收）：
  - `ctx.skills.registerProvider(...)`：两个 creator 作为 skill 暴露（`resourceBase: {kind:'directory', path}`，脚本路径可用；`get()` 返回 SKILL.md 全文）
  - `ctx.webServer.register(...)`：面板 API
  - `ctx.agents.create({agentOptions})` → `AgentHandle{agent, dispose}`；`agent.followup({content, source})` 唤醒；`agent.whenIdle()` 收尾；`agent.cancel(cause)` 中止
  - `'agent/assistant-stream'(…, {agent, frame})`：`frame.type = start|chunk|end`，`chunk.type = text-delta|tool-call-delta|block-end|finish`
  - 本运行时 Cordis 只派发 `internal/*` 事件，**`ctx.on('ready')`/`ctx.on('dispose')` 永不触发** → 一律用 `ctx.effect`
- **Client 半部** `src/client.js`：`window.__ModuleLoader__.load({id: 包名, factory(require){…}})` 官方格式；面板注册为**独立主面板**（同一 id 同时注册 `sidebar.panellist` 与 `main` keyed slot，与官方 Plugins 页同构），**刻意不用 `conversation.composer.dock`**（那是"composer 下方的环境条目"，放整页表单会挤掉对话区）
- 生效方式：
  - 客户端 `src/client.js`：刷新页面
  - Host 入口 `src/core/plugin.mjs`：设置 → 插件里禁用/启用本 bundle（实测有效）
  - **Host 其他 core 模块**（`runner.mjs` / `routes.mjs` / `creators.mjs`…）：**必须重启 DSH**——bundle 重载只重新导入入口模块，其静态依赖命中 Node 的 ESM 模块缓存，改动不会生效（已踩坑）
- 依赖声明是硬要求：本插件 `export const inject = ['webServer', 'skills']`。若把注册藏在一次性的 `ctx.get('webServer')` 后面，插件会比该服务先激活并**静默不注册任何路由**——表现为"面板 API 404"，而 skill provider 却正常，极具误导性

## 抓取方式

- **git sparse clone**：`git clone --depth 1 --branch <branch> --filter=blob:none --sparse` + `sparse-checkout set <path>` —— 实测 **2.1 s / 2.4 s**，只取 creator 子树
- 仓库 archive 路由**不可用**（返回 200 但 `Content-Type: text/html` 登录页）；无 git 时回退 contents API（每 creator 14–17 请求，会限流，仅兜底）
- 缓存：`$DSH_SKILL_CREATOR_CACHE`（默认 `%TEMP%/dsh-skill-creator-cache`），每模式 `stamp.json` 记录 repo/branch/path/**commit**/fetchedAt，TTL 24h（`DSH_SKILL_CREATOR_TTL_MS`）；拉取失败继续用旧副本并标 `stale`

## 实时目录（一级 / 二级 / 三级）

| 下拉 | 目录 | 取值 |
| --- | --- | --- |
| 一级目录（固定根） | `skills` | 恒为 `skills` |
| 二级目录 | `skills/<二级>` | `computing`、`network`、`ai`…（16 个） |
| 三级目录 | `skills/<二级>/<三级>` | `computing` → `ecs`、`flexus-l`、`flexus-x`… |

走 Gitee 风格 contents API（GitLab 风格的 `/api/v4/.../repository/tree` 在该站 404）；每路径 10 分钟缓存（`catalog.ttlMs`）；限流/断网先给过期缓存、再退到可选本地克隆（`catalog.localDir`）。技能名是**第四级**：`huawei-cloud-` 前缀写死 + 用户填后缀。

## 命令

```bash
npm test                       # node --test（125 个用例）
npm run creator:status         # 两个 creator 的缓存状态（含 commit）
npm run creator:refresh        # 强制拉最新
npm run audit -- <skill-dir>   # 用 creator 自带的 validate-skill.sh 审一个技能包
node bin/dsh-skill-create.mjs --mode huawei --domain computing --product ecs \
     --name ecs-manage --summary "Manage ECS via KooCLI"   # 只打印请求文本（不开面板时用）
```

## 技能评测（10 分制，通过线 8.5）

创建完成的 skill 会被**真跑一遍评测**，不达标就把扣分明细交回同一个 creator 就地修改，直到达标或用完轮数。

```
creating → evaluating(第 1 轮) → done                       得分 ≥ 8.5
         → evaluating(第 1 轮) → fixing → evaluating(第 2 轮) …
         → below-threshold                                  3 轮到顶仍未达标
```

**口径照抄 `skill-verify-leader`**（不自己发明），10 分制 12 项：

| 维度 | 满分 | 明细 |
| --- | --- | --- |
| 稳定性 | 4 | 功能可用 3 + 触发词充足度 1 |
| 成本 | 1 | 消耗总 token 1 |
| 效率 | 2 | 完成时间 / 工具失败次数 / 重试次数 / cli·sdk·api 调用次数 / LLM 调用次数 / 上下文压缩，8 × 0.25 |
| 安全 | 3 | 本地规则扫描：高危 ≥1 → −3；告警 ≥2 → −2；告警 1 → −1 |

- **成本/效率是相对基线、单向容差 10%**（只罚超支，不罚更省）：本地没有平台 DB，**首轮即基线**，后续轮次与首轮比
- 分级参考平台：`=10 技能满分`、`[8,10) 优质技能`；本插件**通过线 8.5/10**（即"85 分"）

**指标来源（不需要 CodeArts / Hermes / OBS）**：

| 指标 | 本地来源 |
| --- | --- |
| token | 评测会话 `assistant/message.data.usage` 逐条累加 |
| 工具失败 | `tool/result` 的 `error` / `message.isError` |
| 重试 | 连续两次完全相同的工具调用 |
| 完成时间 | 评测轮的墙钟时长 |
| cli / sdk / api 调用 | 工具调用文本按 `config.py` 的 `LOG_PATTERNS` 移植分类 |

**只跑只读用例**：评测只取 `templates/test-vars.json` 里 `type=readonly|syntax` 的用例，**写操作一律不跑**（`evalReadonlyOnly: false` 才放开，不建议）。没有用例文件时，评测 agent 从 `SKILL.md` 的命令区自行挑只读命令。

**未纳入（平台侧信号缺失）**——报告里会明确标注，不猜测、不扣分：

- 外部门禁扣分（`skills_test` 测试结论 / `skills_bot` 审查结论、`pr`/`simulate` 模式上限）
- CodeArts / Hermes 运行时导出（用同一会话的 usage 与工具事件代替）
- 上下文压缩事件（本地不可观测，按"未压缩"计入，不扣分）

**配置**（`cordis.patch.yml` → `config.run`）：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `cwd` | 不设 → DSH host 进程 cwd（= profile 目录） | 技能落盘根：`<cwd>/skills/<domain>/<product>/<name>`。**发布版请显式设置** |
| `permissionPreset` | 不设 → 沿用部署/session 默认 | 创建 agent 的权限 preset。creator 要跑 bash，只读沙箱下会卡在审批；确定要无人值守再显式设 `danger-full-access` |
| `passScore` | `8.5` | 通过线（10 分制） |
| `maxEvalRounds` | `3` | 最多评测轮数；`0` = 关闭评测，只创建 |
| `evalReadonlyOnly` | `true` | 只跑只读/语法用例 |

> **本机（作者）覆盖**：本机用 `C:\Users\<你>\.dsh\profiles\desktop\cordis.patch.yml` 这个「profile 补丁层」把 `run.cwd` + `run.permissionPreset: danger-full-access` 覆盖回来——它在本 bundle 层**之后**应用，所以本机行为不变，而发布出去的文件里不含任何机器专属取值。
> 注意 patch 语义是**整键替换**（不是深合并）：profile 里给 `config` 就必须给完整的 `config`，否则会丢掉 `creators` / `catalog`。

到顶仍未达标时 `status='below-threshold'`，run 上带 `report`（各轮得分表 + 末轮明细 + 扣分项）与 `error` 说明，**不会继续硬跑**。面板运行卡片显示 `评测 8.70/10（第 2 轮）`、四个维度得分、扣分明细与报告。

## 测试覆盖

- `test/evaluator.test.mjs` — 评分数学：12 项权重/满分=10、10% 单向容差、自基线、触发词两档、安全扣分档位、阈值判定、指标归约（token/失败/重试/调用分类）、只读用例过滤、安全规则扫描、评测提示词与 JSON 解析、修复提示词、报告
- `test/runner.test.mjs` — 执行器与**评测循环**：默认模型选择、提示词内容、`assistant-stream` 帧 → 阶段点亮/工具入日志/错误上报、`whenIdle` 收尾、取消释放、缺 `agents` 服务时报错、达标早停、fail→pass 第 2 轮达标、3 轮到顶 → `below-threshold`、`maxEvalRounds=0` 关闭、真实评测轮起独立评测 agent
- `test/routes.test.mjs` — 面板 API 全部路由 + 未知路由/异常都返回 JSON
- `test/creators.test.mjs` — 模式↔仓库映射、无网状态、两种模式的请求文案
- `test/client.test.mjs` — 假 React 渲染真实组件树：每个 `select` 必带 `option`、每个 `Field` 必带控件、一行一个控件、必须 POST `/run` 且不再连私有端口
- `test/catalog.test.mjs` — 路径穿越、TTL 缓存、断网走本地克隆、限流走过期缓存
- `test/validators.test.mjs` — 本地校验器逐条用例（rule 14 四件、必备章节、`hcloud-unwrapped`）
- `test/yaml.test.mjs`、`test/bundle.test.mjs` — mini YAML 解析器；DSH bundle 契约

## 已知边界（诚实声明）

1. **真实创建需要华为云凭据**：creator 的 Pre-check 是硬门槛，Phase 2/4/5 会真的跑 `hcloud`。没凭据时前段能跑，实测阶段会停在 ⛔ 并把原因写进日志——这是 creator 自己的设计。
2. **抓取需要 git**：没有 git 时回退 contents API，慢且可能被限流（HTTP 429）。
3. **本地 `validators.mjs` 是近似实现**：权威裁定者是 creator 自带的 `scripts/validate-skill.sh`（`npm run audit` 用的就是它），规则变更时本地版本可能滞后。
4. **并发**：每次点「开始创建」起一个新 agent 会话；面板按运行 id 分别记录，最多保留 20 条。
5. **评测的代价**：一轮评测 = 再起一个 agent 并真跑一遍只读用例。3 轮循环意味着最多 1 次创建 + 3 次评测、4 个 agent 会话；到顶仍未达标会停在 `below-threshold` 并给报告，不会无限重试。
6. **评测口径是"平台口径的本地实现"**：评分公式与权重逐条照抄 `skill-verify-leader`，但指标采集用本地会话事件替代 CodeArts/Hermes 导出，外部门禁扣分不参与（报告中标注「未纳入（平台侧信号缺失）」）。因此本地 8.5 与平台 8.5 **同口径但非同源**。
7. **修复由 creator 自己完成**：扣分明细通过 `followup` 发回同一个 creator agent（它已掌握上下文）。若 creator 反复改不动，会被 3 轮上限兜住——这属于设计预期，不是失败。
8. **生效边界**：`src/client.js` 改动刷新页面即可；`src/core/runner.mjs`（含新模块 `evaluator.mjs`）靠禁用/启用 bundle 重新加载；`cordis.patch.yml` 的 `config.run` 需要一次 DSH 重启才应用。


## 开发/维护命令（不在发布包内）

这些脚本被 `package.json` 的 `files` 白名单排除，**只在仓库内可用**，因此不再作为 npm script 暴露给安装者：

```bash
node scripts/audit-skill.mjs     # 仓库内审计自己
node src/core/dsh-install.mjs    # 仅作者：把本仓库装进 DSH profile（绕过 pnpm，会改 profile 的 package.json）
node scripts/recover-runs.mjs    # 从 session 日志重建创建记录（幂等）
```

发布包内保留的 npm script 只有那些**在 tarball 里真能跑**的（当前无），避免安装者执行到 `Cannot find module`。
