# Scenes Skill Creator

**在 DeepSeek Harness 的 Web 界面里真跑官方 creator 技能——通用技能 / 标准API管理技能 / 华为云基础云服务技能——并实时展示过程、自动评测、不达标就打回修改。**

[![npm version](https://img.shields.io/npm/v/@cloudplugin/dsh-skill-creator.svg)](https://www.npmjs.com/package/@cloudplugin/dsh-skill-creator)
[![license: MIT](https://img.shields.io/npm/l/@cloudplugin/dsh-skill-creator.svg)](https://github.com/wasteoneslife/dsh-skill-creator/blob/main/LICENSE)

包名 `@cloudplugin/dsh-skill-creator`，是一个 DSH bundle（Host 半边 + Client 半边，全部在 Harness 进程内，没有子进程、没有监听端口）。

## 它是什么

官方 creator 技能（`common-skill-creator` / `rest-api-skill-creator` / `huawei-cloud-skill-creator`）是给命令行或会话里的 agent 用的：需求要自己写清、流程要自己盯、产物好不好要自己判断。本插件把这件事搬进 Web 界面：

1. **需求传递**：侧边栏选分类、填表单，插件把内容整理成 creator 能直接开工的请求（已经给全的值不再反问）。
2. **过程展示**：按下「开始创建」后，Host 侧新起一个**真 agent** 执行该 creator 自己的流水线，面板实时渲染阶段清单与步骤日志。
3. **评测闭环**：创建结束后真跑一遍 10 分制评测，不达标就把扣分明细交回**同一个** creator 就地修改，直到达标或用完轮数。

**插件自己不做内容创作**：SKILL.md 怎么写、references 怎么摆、脚本怎么跑，全部由该 creator 当前版本决定（插件不内嵌副本、不二次实现；上游改了，插件行为就跟着改）。

## ✨ 主要特性

- **分三类组织需求**：侧边栏为 通用技能 / 标准API管理技能 / 华为云基础云服务技能，创建记录按分类隔离，默认打开通用技能。
- **真跑，不止给提示词**：创建由 creator 技能在真 agent 里执行；步骤日志逐条记录它的工具调用、阶段切换与模型报错。
- **实时展示阶段与步骤**：阶段清单按 creator 自己的标记点亮（华为云 Phase 1–6 / 通用技能 阶段 1–5 / 标准API Step 1–4），运行中每 1 秒刷新。
- **自动评测并打回修改**：10 分制、通过线 8.5；不达标把扣分明细发回同一个 creator 修改，最多 3 轮，到顶输出评测报告。
- **无人值守也不提问**：提示词里禁止提问；creator 若仍然提问，插件按"只读、不执行变更类操作"的策略自动答复并继续（最多 5 次）。
- **保护长任务不被误杀**：看门狗按**静默**判死（默认静默 8 分钟、整段 120 分钟兜底），并识别进程被挂起（休眠）后重新计时。
- **回看历史并可靠落盘**：运行记录原子写入磁盘（临时文件 + 重命名 + 备份 + 与磁盘记录合并去重），bundle 重载或 DSH 重启后仍能重新打开，最多保留 20 条。
- **自动发现产物目录**：通用/标准API 模式没有名称与目录字段，评测阶段从 creator 写文件的路径、以及 `<cwd>/skills` 下新出现的 `SKILL.md` 自动定位产物。
- **按需拉取华为云三级目录**：只有切到华为云分类才访问仓库，逐级读取并缓存（默认每路径 10 分钟）；默认分类打开页面不发请求。

## 快速开始

两种安装方式。装完后**必须重启 DSH 一次**——bundle 列表与补丁层只在启动时解析（不重启的表现是侧边栏没有图标，或面板 API 404）。

**方式一 · DSH 内（任意 profile，推荐）**：在会话里让 agent 用 Harness 自带的插件管理安装这个 spec：

```text
@cloudplugin/dsh-skill-creator
```

**方式二 · 桌面端 profile（命令行）**：把**同一个包名**同时写进该 profile 的依赖与 `dsh.profile.bundles`（两处都要有）：

```sh
cd ~/.dsh/profiles/desktop
pnpm add @cloudplugin/dsh-skill-creator   # 或用 npm install
```

```powershell
cd $env:USERPROFILE\.dsh\profiles\desktop
pnpm add @cloudplugin/dsh-skill-creator   # 或用 npm install
```

> **⚠️ 装完必须重启 DSH 一次**（包与配置在启动时加载）。
>
> 另外，安装用的包名必须与 `src/client.js` 里 `window.__ModuleLoader__.load({ id })` 的 id 完全一致（本包都是 `@cloudplugin/dsh-skill-creator`），不一致时浏览器侧会直接报 `bundle … loaded without registering "…"`。

最小可用配置（写进 profile 的 `cordis.patch.yml`，`id` 与包内补丁一致）：

```yaml
- id: dsh-skill-creator
  name: '@cloudplugin/dsh-skill-creator'
  config:
    run:
      cwd: '/absolute/path/to/your/workspace'
      permissionPreset: 'danger-full-access'
      passScore: 8.5
      maxEvalRounds: 3
      evalReadonlyOnly: true
      idleTimeoutMs: 480000
      phaseTimeoutMs: 7200000
      toolWaitMs: 1200000
```

`run.cwd` 是技能落盘根，产物写在 `<cwd>/skills/…`。不设时回落到 DSH host 进程的 cwd（通常是 profile 目录），技能会被写进 profile 里而不是你的工作区。上面的 `run` 键要写全，原因见「配置」一节的坑。

### 命令行安装（等价方式）

```sh
# Web / 普通 profile
dsh plugin add @cloudplugin/dsh-skill-creator

# 桌面端：先完全退出客户端，再指定 desktop profile
dsh plugin --profile desktop add @cloudplugin/dsh-skill-creator
```

装完**重启一次 DSH**。桌面端的 `dsh` CLI 随安装包提供（`resources\runtime\cli\bin\dsh.cmd`）；若手边没有该命令，也可以在插件页里直接填包名 `@cloudplugin/dsh-skill-creator` 安装。

## ⚠️ 权限要求（必读）

> **发布包默认 `run.permissionPreset: 'danger-full-access'`**（写在包内 `cordis.patch.yml` 里，不是文档假设）。
>
> 原因：creator 流程要跑 bash 脚本（`ensure_cli.sh` / `validate-skill.sh` / `test-cli-commands.sh`）与云 CLI，这些 fork 在只读或 `workspace-write` 沙箱下会被审批拦住。无人值守时没有人点「允许」，运行就静默，随后被看门狗判死——表现为**"跑一半超时退出"**（实跑数据里确有 `permission: null` 的运行以 `等待「creator」超时：已静默 8 分钟（无任何工具调用或文本）` 结束）。
>
> **风险**：创建与评测 agent 都会以完全访问权限运行（可读写文件、执行命令）。请只在**信任的工作区**使用本插件。若改成受限 preset，请确保有人在场处理审批，否则长任务大概率静默超时。

## 三种技能类型

| 显示名（侧边栏顺序） | 内部 `mode` | 委托的官方 creator | 来源 |
| --- | --- | --- | --- |
| 通用技能 | `generic` | `common-skill-creator` | [grape-skills](https://gitcode.com/grape-dev/grape-skills) `main` → `skills/coding/scaffolding/common-skill-creator` |
| 标准API管理技能 | `api` | `rest-api-skill-creator` | [grape-skills](https://gitcode.com/grape-dev/grape-skills) `main` → `skills/coding/scaffolding/rest-api-skill-creator` |
| 华为云基础云服务技能 | `huawei` | `huawei-cloud-skill-creator` | [huaweicloud-skills](https://gitcode.com/huaweicloud/huaweicloud-skills) `master` → `skills/devtools/common/huawei-cloud-skill-creator` |

- 显示名就是侧边栏菜单文案，**数组顺序即菜单顺序（华为云固定最后）**，默认选中第一项（通用技能）。
- 每个菜单项下方还有一行**说明小字**，标明该分类对应的 creator 家族：通用技能 `common-skill-dev` · 标准API管理技能 `common-restapi-skill-dev` · 华为云基础云服务技能 `huawei-skill`。
- 内部 `mode` 键是 Host API 契约（`POST /run` 的 `spec.mode`）与记录隔离键；改显示名不动它。
- **记录按分类隔离**：创建记录卡片只列出当前分类的历史。
- **三级目录按需拉取**：只有切到华为云分类才访问仓库（逐级读取，默认每路径缓存 10 分钟）。
- 三个 creator 都会按需注册为可加载的 DSH skill，缓存 24 小时，可点「从仓库拉取最新」强制刷新。

各分类要填什么：

| 分类 | 表单字段 |
| --- | --- |
| 通用技能 | 一个「技能功能描述」文本框（≥8 字符）。没有名称、目录、tags 字段——这些是打包约定，由该 creator 自己推导。 |
| 标准API管理技能 | 一个「REST API 技能需求」文本框（≥8 字符），占位符是一份需求模板：技能名称 / 一句话描述 / 目标系统 / API 地址 / 认证方式 / **API 文档**。 |
| 华为云基础云服务技能 | 一级目录（固定 `skills`，不可改）+ 二级目录 + 三级目录（均从仓库实时读取）+ 技能名（前缀 `huawei-cloud-` 固定，后缀 1–64 字符小写字母/数字/连字符）+「功能概括」文本框（可留空）。技能名即仓库路径第四级：`skills/<二级>/<三级>/<技能名>`。 |

**标准API模式里「API 文档」最关键**：该 creator 不猜端点——它解析你给的文档，或用 curl 实测探测；两者都拿不到就不产出。请把凭据放进环境变量，不要写在这段文本里。

## 工作流程

```text
填需求（选分类 + 填表单）
  └─ POST /dsh-skill-creator/api/run
       └─ Host：ctx.agents.create() 起一个真 agent
            agent.followup(creator 请求)           把需求交给 creator 技能
            ctx.on('agent/assistant-stream', …)    把流式帧转成阶段与步骤
       └─ 面板每 1 秒 GET /run?id=…                 渲染阶段清单 + 步骤日志

创建结束（creator 空闲）
  └─ 目标目录自动发现（通用/标准API 模式表单里没有名称，路径由 creator 决定）
       └─ 评测第 1 轮（真跑只读用例，10 分制）
            ├─ 得分 ≥ 8.5 ──────────────────────► done（附评测报告）
            └─ 得分 < 8.5 → 扣分明细 followup 回同一个 creator 就地修改（fixing）
                 └─ 评测第 2 轮 … 最多 3 轮
                      ├─ 本轮提升 < 0.2 ────────► below-threshold（早停，附报告）
                      └─ 3 轮到顶仍未达标 ──────► below-threshold（附报告）
```

运行状态：`creating` → `evaluating` →（`fixing` → `evaluating`）* → `done` / `below-threshold`；任何阶段都可能 `cancelled` / `failed`，进程重启后残留的进行中记录会标为 `interrupted`。运行中可「取消」，结束后可「← 返回」再开一次。

各 creator 的阶段清单（阶段标题就是面板上显示的文案，插件按 creator 自己的标记点亮，**只前进不回退**）：

| 分类 | 阶段 |
| --- | --- |
| 华为云 | Phase 1 · 需求分析（苏格拉底式问答） |
| 华为云 | Phase 2 · 技术调研（CLI→SDK→API 三级回退） |
| 华为云 | Phase 3 · 文档生成（SKILL.md + references + 载体） |
| 华为云 | Phase 4 · 测试准备（templates/test-vars.json） |
| 华为云 | Phase 5 · 详细测试（真实执行验证） |
| 华为云 | Phase 6 · 资源清理与合规检查 |
| 通用技能 | 阶段 1 · 需求分析 |
| 通用技能 | 阶段 2 · 设计 |
| 通用技能 | 阶段 3 · 生成（skill 包 + 模板） |
| 通用技能 | 阶段 4 · 验证（规范 + lint 检查点双通过） |
| 通用技能 | 阶段 5 · eval 迭代 |
| 标准API | Step 1 · 需求澄清 |
| 标准API | Step 2 · 技术调研 |
| 标准API | Step 3 · 骨架生成 |
| 标准API | Step 4 · 自测与收尾（创建 PR/交棒属平台流水线，本面板不做） |

## 评测机制（10 分制，通过线 8.5）

创建结束后**真跑一遍评测**：由评测 agent 在被测 skill 目录里执行只读用例，再由本地评分器按平台口径打分。

| 维度 | 满分 | 明细 |
| --- | --- | --- |
| 稳定性 | 4 | 功能可用 3 + 触发词充足度 1 |
| 成本 | 1 | 消耗总 token |
| 效率 | 2 | 8 项 × 0.25：完成时间 / 工具失败次数 / 重试次数 / cli / sdk / api 调用次数 / LLM 调用次数 / 上下文是否压缩 |
| 安全 | 3 | 本地规则扫描：高危 ≥1 扣 3；告警 ≥2 扣 2；告警 1 扣 1 |

- **通过线 8.5/10**（即"85 分"）；分级参考平台：`=10` 技能满分、`[8,10)` 优质技能。
- **容差 10% 且单向**：成本与效率只罚超支、不罚更省；基线为 0 视为无参照。**但从第 2 轮起才与基线比较**——首轮不再"白送"（见下条）。
- **绝对上限始终生效**（`evalTokenBudget` / `evalDurationCapSeconds` / `evalMaxToolCalls` / `evalMaxLlmCalls` / cli·sdk·api 上限 / 工具失败与重试必须为 0）：无基线时按绝对上限判定，有基线时"≤ 基线×(1+10%)"与"≤ 绝对上限"**同时**满足才满分；更省永远不罚。默认值取自实测量级（评测轮 token 23965/28550/38999/39617、时长 42.5/58.2/65.75/394.1 s、工具调用 4-8、cli 2-6、llm 4-6、工具失败 0、重试 0），正常轮次不会误伤。
- **功能可用 = 外部证据，不是评测 agent 的自编用例**：必须真实执行**被测 skill 自带夹具**里的 ≥ `minFixtureCases`（默认 3）条只读/语法用例，每条带「执行命令 + 观测结果（退出码/输出片段）+ 与期望的对比结论」，且没有 `fail`。只有自编用例、缺证据、夹具不存在或用例数不足 → 这 3 分直接 0，理由写进 `checks.functionalEvidence`；自编用例只能作为补充。
- **本地门禁（确定性，不需要 agent）**：任一不过 → 总分压到 `gateScoreCap`（默认 7.0）并确保 `verdict !== 'pass'`，同时进扣分明细、修复提示词与报告。
  1. `SKILL.md` 存在且 frontmatter 可解析（name/description 都有）；
  2. 该 kind 的测试夹具存在且可解析；
  3. `validateSkillPackage` 结构校验 error 为 0（读 `level` 字段——曾误读 `severity`，于是"恒 0 error"）；
  4. 华为云 kind：creator 自带的 `scripts/validate-skill.sh` 执行后不得有 FAIL（跑不了 bash 只记 warning，不作门禁）。
- **只跑只读/语法用例**：按 kind 取自带夹具里的用例，最多 20 条，**写操作一律不执行**（`evalReadonlyOnly: false` 才放开，不建议）：

  | kind | 夹具路径（实测产物） | 用例形状 |
  | --- | --- | --- |
  | 华为云 | `templates/test-vars.json`（备用 `templates/test-defaults.json`） | `test_cases[]`：`type: readonly\|syntax` |
  | 标准API | `templates/test-vars.json` | `test_cases[]`：`category: readonly`；`method` 为 POST/PUT/PATCH/DELETE 的一律不跑 |
  | 通用 | `evals/evals.json` | `evals[]`：`prompt` / `expected_output` / `files` / `assertions`（评测 agent 用该夹具的输入执行 skill 自己的脚本并与期望比对） |

  找不到夹具的 kind 记录为"无夹具"：夹具门禁失败 → 总分 ≤ 7.0 且功能可用 0 分（刻意如此——没有可复验的证据就不给分）。
- **无提升早停**：本轮比上轮提升 < `minImprovement`（默认 0.2）时提前结束并出报告，不把 3 轮跑满。

指标来源（全部本地，不需要 CodeArts / Hermes / OBS）：

| 指标 | 本地来源 |
| --- | --- |
| token | 评测会话 `assistant/message.data.usage` 累加 |
| 工具失败 | `tool/result` 的 `error` / `message.isError` |
| 重试 | 连续两次完全相同的工具调用 |
| 完成时间 | 评测轮的墙钟时长 |
| cli / sdk / api 调用分类 | 工具调用文本按平台 `LOG_PATTERNS` 的本地移植分类 |

**未纳入的平台侧信号**（报告里逐条标注，不猜测、不扣分）：

- 外部门禁扣分（`skills_test` 测试结论 / `skills_bot` 审查结论）
- `pr` / `simulate` 模式的功能可用扣分上限
- CodeArts / Hermes 运行时导出（本评测用同一会话的 usage 与工具事件代替）
- 上下文压缩事件（本地不可观测，按"未压缩"计入，不扣分）

## 配置

配置写在 `cordis.patch.yml` 的 `config` 下；下表的默认值取自代码与包内补丁文件。

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `run.cwd` | 不设 → DSH host 进程 cwd（通常是 profile 目录） | 技能落盘根 `<cwd>/skills/…`。**发布环境请显式设置**，否则写进 profile |
| `run.permissionPreset` | `'danger-full-access'`（包内默认） | 创建/评测 agent 的权限 preset，见上面「权限要求」 |
| `run.passScore` | `8.5` | 通过线（10 分制） |
| `run.maxEvalRounds` | `3` | 最多评测轮数；`0` = 关闭评测，只创建 |
| `run.evalReadonlyOnly` | `true` | 只跑只读/语法用例 |
| `run.evalTokenBudget` | `50000` | 单轮评测 token 上限（input+output）。无基线时按它判定成本分，有基线时与"≤ 基线×1.1"同时满足才满分。实测评测轮 23965/28550/38999/39617 |
| `run.evalDurationCapSeconds` | `600` | 单轮评测墙钟时长上限（秒）。实测 42.5/58.2/65.75/394.1 s |
| `run.evalMaxToolCalls` | `20` | 单轮工具调用总量上限（cli/sdk/api 三个分类项共享）。实测 4-8 |
| `run.evalMaxLlmCalls` | `20` | 单轮 LLM（assistant）轮次上限。实测 4-6 |
| `run.evalMaxCliCalls` / `evalMaxSdkCalls` / `evalMaxApiCalls` | `20` | 分类调用次数上限。实测 cli 2-6、sdk/api 多为 0 |
| `run.evalMaxToolFailures` / `evalMaxRetries` | `0` | 工具失败、重试的**绝对**要求（不再是"与基线比"的容差判定） |
| `run.minFixtureCases` | `3` | 「功能可用」至少真实执行多少条 skill 自带夹具用例；不足则该项 0 分 |
| `run.gateScoreCap` | `7.0` | 任一本地门禁不过时的总分上限（确保 `verdict !== 'pass'`） |
| `run.strictStructureGate` | `false` | `true` = 把华为云仓库的结构规则逐条套到所有 kind（api 的 `requirements.txt`、generic 的 `evals/` 会被判 error）。默认按 kind 取规则 |
| `run.idleTimeoutMs` | `480000`（8 分钟） | 无任何工具调用或文本即判死；收到活动就重新计时。**有待决工具调用时不算静默**，见下一行 |
| `run.phaseTimeoutMs` | `7200000`（120 分钟） | 单个创建/评测阶段的绝对兜底（旧键 `run.evalTimeoutMs` 亦可） |
| `run.toolWaitMs` | `1200000`（20 分钟） | 等待**单个工具调用返回**的专用上限。工具在飞时 agent 不产生任何 assistant 帧（如 `job_output wait=true timeout_ms=600000` 合法静默 10 分钟），此时不按 `idleTimeoutMs` 判死；超过本上限才判死并报「等待工具 <名> 返回超时」。机器休眠的时钟跳变仍最高优先级、重新计时 |
| `run.minImprovement` | `0.2` | 修复轮提升低于此值就早停；`0` 关闭 |
| `run.agentPreset` | 不设 → 沿用部署默认 preset（常见为 `standard`） | 创建与评测 agent 使用的 preset |
| `run.agentOptions` | 不设 → profile 默认模型 | 覆盖 provider / model |
| `run.wakeGraceMs` | `1200` | `whenIdle()` 之前的宽限期（防"消息未被受理"被当成已完成） |
| `run.persistDebounceMs` | `1500` | 运行中落盘的防抖间隔 |
| `run.idlePollMs` | `15000` | 看门狗轮询间隔（超过 5 倍间隔即视为进程被挂起） |
| `catalog.repo` | `'huaweicloud/huaweicloud-skills'` | 华为云三级目录来源 |
| `catalog.ref` | `'master'` | 目录来源的引用 |
| `catalog.root` | `'skills'` | 一级目录（固定根） |
| `catalog.localDir` | `''` | 可选本地克隆，仅当目录 API 失败时兜底 |
| `catalog.ttlMs` | `600000`（10 分钟） | 每个目录路径的缓存时长 |
| `catalog.timeoutMs` | `15000` | 单次目录请求超时 |

环境变量：`DSH_SKILL_CREATOR_CACHE`（creator 缓存与运行记录目录，默认 `%TEMP%\dsh-skill-creator-cache`）、`DSH_SKILL_CREATOR_TTL_MS`（creator 缓存 TTL，默认 24 小时）。

> **坑：profile 覆盖层是逐顶层键整体替换，不是深合并。** 在 `~/.dsh/profiles/<name>/cordis.patch.yml` 里覆盖 `config` 时，该块是整体赋值：所以要覆盖 `run` 就把想保留的 run 键写全——例如少写 `permissionPreset`，等于把发布包的 `danger-full-access` 默认值丢掉，运行会退回部署默认权限（很可能卡在审批上）。
>
> 另外：包内 `cordis.patch.yml` 的 `creators:` 段当前**不被插件读取**（三个分类由 `src/core/creators.mjs` 内置），改它不会改变走哪个 creator。

## 运行环境

| 依赖 | 用途 | 备注 |
| --- | --- | --- |
| Node.js ≥ 18 | 插件本体与 `bin/` 脚本 | `package.json` 的 `engines` |
| DSH 本体 | 提供 `webServer` / `skills` / `agents` 服务 | 已在 0.2.0-rc.2 上验证 |
| git | 抓取 creator（sparse clone，只取 creator 子树） | 无 git 时回退 gitcode contents API（慢，可能 429） |
| bash | 跑 creator 自带脚本（`ensure_cli.sh` / `validate-skill.sh` / `test-cli-commands.sh`） | Windows 用 Git Bash；沙箱要允许 fork |
| python3 | creator 脚本用它做 JSON/哈希处理（如 `yaml-check-frontmatter.py`） | 没有 `python3` 时脚本回退 `python` |
| 网络可达 gitcode.com | 抓 creator 与华为云三级目录 | 失败时继续用旧副本并标 `stale` |
| 华为云 hcloud 凭据（AKSK profile） | 华为云模式：creator 的 Pre-check 与评测只读用例 | 只读巡检也需要可用的 hcloud profile |
| 目标系统可达（URL + 凭据） | 标准API模式：解析文档或用 curl 探测 | 探测不到就不产出 |

## 边界与已知限制

1. **不做内容创作**：SKILL.md、references、测试模板都由 creator 生成，插件只负责传需求、展示过程、评测产物。
2. **不做平台流水线的事**：creator 流程尾部的"创建 PR → A2A 交棒 QA"只在平台内可用；本面板独立运行、禁止远端推送，所以标准API模式最后一段只走到自测与收尾。
3. **评测是"同口径、不同源"**：权重、容差、安全扣分规则照抄 `skill-verify-leader`，但平台的分数是"相对数据库基线 + 外部门禁"，本面板既没有基线也没有外部门禁——所以成本/效率改为**绝对上限**（`eval*` 系列键），外部门禁扣分仍不参与（报告里标注"未纳入"）。本地 8.5 与平台 8.5 权重相同、输入不同。
4. **首轮不再白送**：第 1 轮没有基线，成本（1 分）与效率（2 分）按绝对上限判定；有基线时叠加相对比较。若评测 agent 没给出结构化结论，"功能可用"不再退化为本地结构校验——**没有夹具证据就是 0 分**（结构问题由本地门禁另行压分）。
5. **评测只覆盖只读/语法用例**：写操作与资源生命周期用例一律不跑，所以"能读"不等于"能改"。
6. **有单轮预算，而且会真的打回**：token/时长/调用次数超上限或任一本地门禁不过 → 总分被压到 `gateScoreCap`（7.0）以下 → `< 8.5` 就把扣分明细交回同一个 creator 修改（修复闭环）。`maxEvalRounds` 限的是轮数。
7. **一次完整流程是十几到几十分钟量级**：创建 + 每轮评测各起一个真 agent（最多 1 次创建 + 3 次评测 = 4 个会话），轮次越多越慢。
8. **本地校验器是近似实现，但现在直接影响打分**：权威裁定是 creator 自带的 `scripts/validate-skill.sh`（`node scripts/audit-skill.mjs <skill-dir>` 用的就是它），本地结构门禁直接读同一套规则的 error 数（`level` 字段）。两处已修的近似缺陷：本地 mini-YAML 曾不支持 `>-` 折叠标量（会导致整段 frontmatter 解析失败），markdown 里反引号包裹的 URL 曾被截成 `host\`` 而不在允许域名内。非华为云 kind 不套用华为云仓库专属规则（`top-level` / `no-external-links` / `relative-refs`），但顶层条目仍按各 kind 自己的布局校验（例如通用技能残留的 `phase-*.json` 仍算 error）；`strictStructureGate: true` 可关掉这层豁免。
9. **记录有上限**：最多保留最近 20 条运行，每条最多 200 步（内存日志窗口 400 步）；超出后淘汰最旧的**已结束**运行，进行中的不会被淘汰。
10. **华为云模式需要凭据**：creator 的 Pre-check 是硬门槛；没有可用凭据时前段能跑，后续步骤会停下并把原因写进日志。
11. **默认权限偏大**：发布包默认完全访问权限（见「权限要求」），这不是最小权限默认值。
12. **生效方式不同**：`src/client.js` 改动刷新页面即可；核心模块改动需要禁用/启用一次 bundle（插件每次 apply 都以查询参数重新导入核心模块）；包名 / `cordis.patch.yml` / `dsh.profile.bundles` 只在启动时解析，**必须重启 DSH**。

## 验证情况

- **单元测试**：`node --test` → **162 个用例 / 22 个套件全部通过**（0 失败）。
- **端到端实跑**（三种模式各一次，Windows + Git Bash + KooCLI 环境）：

| 模式 | 产物 | 结果 |
| --- | --- | --- |
| 华为云基础云服务技能 | `skills/bigdata/mrs/huawei-cloud-mrs-manage` | 第 1 轮 10.00/10 达标 |
| 通用技能 | `skills/text/markdown-notes-index` | 第 1 轮 10.00/10 达标 |
| 标准API管理技能 | `skills/jsonplaceholder-posts` | 第 1 轮 10.00/10 达标 |

三次运行均为**零提问、零运行错误**（自动答复 0 次、错误步骤 0 条、工具失败 0 次）。以上均为实跑数据，非估算。

## 开发

```sh
npm test                                      # node --test（162 个用例）
npm run creator:status                        # 各 creator 的缓存状态（含 commit）
npm run creator:refresh                       # 强制拉取最新 creator
```

```sh
node bin/dsh-skill-create.mjs --mode huawei --domain computing --product ecs --name ecs-manage
node bin/dsh-skill-validate.mjs <skill-dir> [--mode huawei|generic] [--edit]
```

`bin/dsh-skill-create.mjs` 只**打印**要交给 creator 的请求文本（创建本身由 creator 完成）。注意：它接收的 `--summary` / `--tags` 等参数当前不会被 `buildHandoff` 采用（只读 `name` / `domain` / `product` / `description` / `extra`），因此该命令产出的请求只含名称与目录信息。

**发布包只含 19 个文件**（`npm pack --dry-run` 核对）：`package.json`、`README.md`、`LICENSE`、`icon.svg`、`cordis.patch.yml`、`bin/`（2 个 CLI）、`locale/`（2 个）、`src/client.js`、`src/lib/yaml.mjs`、`src/core/` 下的 8 个模块（catalog / creators / evaluator / plugin / routes / runner / spec / validators）。

不随包发布：`test/`、`scripts/`（`audit-skill.mjs` / `recover-runs.mjs`）、`src/core/dsh-install.mjs`（维护者工具，不随包发布）、`docs/`、`contrib/`。包内 npm scripts 为 `test` / `creator:status` / `creator:refresh`，其中 `test` 的测试目录不在包里，只在仓库内有意义。

## 许可与链接

- **License**：MIT（见 `package.json` 的 `license` 与仓库 `LICENSE`）
- **仓库**：https://github.com/wasteoneslife/dsh-skill-creator
- **npm**：https://www.npmjs.com/package/@cloudplugin/dsh-skill-creator
- **Issues**：https://github.com/wasteoneslife/dsh-skill-creator/issues