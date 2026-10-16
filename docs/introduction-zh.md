# Scenes Skill Creator 使用说明

> 版本：`@cloudplugin/dsh-skill-creator` 0.0.3
> 适用平台：DeepSeek Harness（DSH）Cordis bundle 插件（Host + Client 两半）
> 文档语言：简体中文

## 1. 这是什么

Scenes Skill Creator 是一个 DSH 插件：你在面板里用表单描述需求，插件驱动**官方 creator** 在一个真实会话中把 Skill 创建出来，并对产出的目录做独立评测。

它的定位需要先说清楚，避免误解：

- 它**不自己编写 Skill 内容**。内容一律由官方 creator 产出；插件负责收集需求、调度会话、实时展示进度、评测产物、持久化记录。
- 它**不承担平台流水线的工作**：不建 PR、不做交棒。
- 它的评测与平台**同口径不同源**：评分项与口径照搬平台，但信号来自本地会话；平台侧专有的那部分信号本地拿不到，会在报告中明确标注。

一句话流程：

```
填需求 → 点「开始创建」 → 官方 creator 在真实会话中执行
→ 自动发现产物目录 → 第 1 轮评测
→ ≥ 8.5 通过；< 8.5 把逐项扣分回传给同一个 creator 就地修改 → 最多 3 轮
```

## 2. 插件身份与安装

| 项目 | 值 |
| --- | --- |
| 包名 | `@cloudplugin/dsh-skill-creator` |
| 版本 | `0.0.3`（已发布到 npm） |
| 显示标题 | **Scenes Skill Creator** |
| 仓库 | https://github.com/wasteoneslife/dsh-skill-creator |
| 形态 | DSH Cordis bundle，Host + Client 两半 |
| bundle 声明 | `dsh.bundle.patch` → `cordis.patch.yml` |

几点容易混淆的地方先说明：

- **显示标题来自 `locale/{zh,en}.json` 的 `meta.title`**，不是 `package.json` 顶层的 `meta` 字段。要改标题就改 locale 文件。
- **仓库名仍是 `dsh-skill-creator`**，没有随包名一起改。
- Host 侧 HTTP 前缀是 `/dsh-skill-creator/api`，**刻意未随包名改**，属于对外契约的一部分。
- Client 侧通过 `window.__ModuleLoader__.load({ id })` 注册，**`id` 必须等于包名**，否则客户端不会挂载。

### 安装

```
dsh plugin add @cloudplugin/dsh-skill-creator
```

桌面端需要先**完全退出** DSH，并指定 desktop profile：

```
dsh plugin --profile desktop add @cloudplugin/dsh-skill-creator
```

**安装完成后必须重启一次 DSH。**

> 命名沿革：包名一度改为 `@cloudplugin/scenes-skill-creator`（发布过 0.0.2），随后回退为 `@cloudplugin/dsh-skill-creator`（当前，自 0.0.3 起）；**显示标题始终是 Scenes Skill Creator**。`@cloudplugin/scenes-skill-creator` 已在 npm 标记弃用并指向本包名。

### 代码结构

Host 侧（`src/core/`）：

| 文件 | 职责 |
| --- | --- |
| `plugin.mjs` | 插件入口，`inject = ['webServer','skills']` |
| `routes.mjs` | HTTP 路由，前缀 `/dsh-skill-creator/api`（未随包名改） |
| `creators.mjs` | 拉取官方 creator 并缓存 |
| `runner.mjs` | 会话与流程调度、状态机、评测循环、记录持久化 |
| `evaluator.mjs` | 10 分制评分、指标归约、安全扫描、提示词与报告生成 |

Client 侧：`src/client.js`，通过 `window.__ModuleLoader__.load({ id })` 注册，`id` 等于包名。

## 3. 三种模式

模式选择在**侧边栏菜单**里（不是顶部 radio 按钮）。**菜单顺序即列表顺序，华为云在最后**；默认选中**通用技能**。
每一项下方有一行说明小字，标明该分类对应的 creator 家族：**通用技能** `common-skill-dev` / **标准API管理技能** `common-restapi-skill-dev` / **华为云基础云服务技能** `huawei-skill`。

| 内部 mode 键（API 契约，未变） | 显示名 | 委托的官方 creator | 来源仓库 |
| --- | --- | --- | --- |
| `generic` | 通用技能 | `common-skill-creator` | `grape-dev/grape-skills`（main） |
| `api` | 标准API管理技能 | `rest-api-skill-creator` | `grape-dev/grape-skills`（main） |
| `huawei` | 华为云基础云服务技能 | `huawei-cloud-skill-creator` | `huaweicloud/huaweicloud-skills`（master） |

注意：**显示名与顺序是新的，但内部 `mode` 键没有变**。`mode` 属于 API 契约，因此已有的记录与调用方式继续有效。

各模式的差异：

- **通用技能（`generic`）**：默认选中。表单只有一个描述文本域。
- **标准API管理技能（`api`）**：表单是需求模板文本域，**其中「API 文档」最关键**。该 creator 的硬规矩是：端点只认文档解析或 `curl` 实测，**严禁猜测**。
- **华为云基础云服务技能（`huawei`）**：三级目录**只在切到华为云时才按需拉取**；表单包含三级目录选择、固定前缀 `huawei-cloud-` 的技能名，以及一个「功能概括」大文本域；该模式需要真实只读调用华为云，因此要有 hcloud 凭据。

另有两条约束：

- **创建记录严格按分类隔离**，不同模式的记录不会混在一起。
- 每个分类的**表单与占位符不同**，占位符是按分类结构化注入的，不是简单的字符串替换。

## 4. 创建流程

1. 在对应模式的表单里填需求。
2. 点「开始创建」。
3. **创建阶段**：官方 creator 在真实会话里跑它自己的完整流程；面板实时显示当前阶段、工具步与心跳。
4. **自动发现产物目录**：对没有预设名字的模式，由 `resolveSkillDir` 从 creator 写过的真实路径反推**包含 `SKILL.md` 的最近目录**。
5. **评测第 1 轮**：独立评测 agent 只跑只读 / 语法用例。
6. 得分 **≥ 8.5 即完成**；**< 8.5** 则把逐项扣分发回**同一个 creator** 就地修改，**最多 3 轮**。
7. 3 轮仍未达标：标记「**未达标**」并产出报告。

### 阶段清单

阶段清单跟随各 creator 自己的流程，插件不做统一改写。

**华为云：6 个 Phase**

1. 需求分析
2. 技术调研（CLI → SDK → API 三级回退）
3. 文档生成
4. 测试准备
5. 详细测试
6. 资源清理与合规检查

**通用技能：5 个阶段**

1. 需求分析
2. 设计
3. 生成
4. 验证
5. eval 迭代

**标准API：4 个 Step**

1. 需求澄清
2. 技术调研
3. 骨架生成
4. 自测与收尾

> PR 与交棒属于平台流水线，本面板不做，因此标准API模式只到「自测与收尾」。

## 5. 评测机制

总分 **10 分**，通过线 **8.5**。

| 维度 | 分值 | 构成 |
| --- | --- | --- |
| 稳定性 | 4 | 功能可用 3 + 触发词充足度 1 |
| 成本 | 1 | 绝对上限 + （第 2 轮起）与基线比较 |
| 效率 | 2 | 8 个子项 × 0.25（时间、工具失败、重试、cli/sdk/api/LLM 调用等） |
| 安全 | 3 | 安全扫描 |

有几条计分规则会显著影响你看到的分数，需要提前知道：

- **容差 10%，且是单向的**：只对超支扣分；比基线更省永远是满分。但从**第 2 轮起**才与基线比较。
- **绝对上限始终生效**：`evalTokenBudget`(50000) / `evalDurationCapSeconds`(600) / `evalMaxToolCalls`(20) / `evalMaxLlmCalls`(20) / cli·sdk·api(20) / 工具失败与重试必须为 0。首轮没有基线时按绝对上限判定——**首轮不再自动满分**；有基线时"≤ 基线×1.1"与"≤ 绝对上限"同时满足才满分。
- **功能可用靠 skill 自带夹具的证据**：必须真实执行 ≥ `minFixtureCases`(3) 条自带夹具用例，每条带命令 + 观测结果 + 与期望的对比结论，且无 fail；只有评测 agent 自编用例（或夹具不存在）→ 这 3 分为 0。
- **本地门禁**：SKILL.md/frontmatter、该 kind 的夹具存在且可解析、结构校验 error 为 0、华为云 creator 的 `validate-skill.sh` 无 FAIL；任一不过 → 总分 ≤ `gateScoreCap`(7.0)，必然低于 8.5 并回传修改。
- **只跑只读用例**：按 kind 取自带夹具（华为云/标准API：`templates/test-vars.json`；通用：`evals/evals.json`）里的只读/语法用例；写操作、创建 / 删除资源的用例一律不跑。
- **口径照搬平台**：评分项、权重与容差沿用 `skill-verify-leader` 的 `EVAL_ITEMS` / `scorer`；差别在**输入**（平台用数据库基线 + 外部门禁，本地面板用绝对上限 + 本地门禁）与**来源**。
- **未纳入项**：平台特有的外部门禁扣分、CodeArts / Hermes 运行时导出**未纳入**评测；报告里会明确标注「未纳入（平台侧信号缺失）」。这是有意的标注，不是功能缺失。
- **无提升早停**：修复轮的提升 < 0.2 即停止（阈值可由 `minImprovement` 配置）。
- **通过后界面只显示「✅ 通过」**，不再显示轮次。

## 6. 无人值守与健壮性

创建与评测全程**无人值守**，插件为此做了一组约束：

- **禁止向用户提问**：面板没有作答通道。若 creator 仍然发出 `ask_user_question`，插件会**自动代答**——代答内容为「禁止变更类操作、按只读继续」。
- **禁止变更类操作**：不改远端、不提交变更。
- **静默看门狗**：默认 **8 分钟**无活动判定为死；期间任何活动都会续期。
- **整段绝对兜底 120 分钟**，避免长跑会话无限占用资源。
- **识别系统休眠**：休眠不会被当作「无活动」，而是重新计时、不判死。
- **判死后收到活动会复活记录**，不会因一次误判丢掉整段进展。
- **心跳文案**：面板显示 `已用时 X 分钟 · 最后活动 Y 秒前`。这是判断「真的卡住」还是「只是慢」的主要依据。

## 7. 配置项

### 必填

- **`run.cwd`**：creator 的工作目录，必填。

### 权限（请务必读这一节）

**`run.permissionPreset` 的发布包默认值是 `'danger-full-access'`。**

原因不是图省事：creator 的流程要跑 bash 脚本与云 CLI，权限不开就会被审批拦住；被拦住后会话静默，看门狗随后判定为死，用户看到的现象就是「**跑一半超时退出**」。

**风险必须写明**：在此默认值下，agent 会以**完全访问权限**运行。请只在**你信任的工作区**使用本插件；不要在包含敏感凭据、生产配置或不可回滚数据的目录里随意运行。

### 其他键

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `passScore` | `8.5` | 通过线 |
| `maxEvalRounds` | `3` | 最大评测轮数 |
| `evalReadonlyOnly` | `true` | 只跑只读 / 语法用例 |
| `evalTokenBudget` | `50000` | 单轮 token 上限（无基线时按它判定成本分） |
| `evalDurationCapSeconds` | `600` | 单轮时长上限（秒） |
| `evalMaxToolCalls` | `20` | 单轮工具调用总量上限 |
| `evalMaxLlmCalls` | `20` | 单轮 LLM 轮次上限 |
| `evalMaxCliCalls`/`evalMaxSdkCalls`/`evalMaxApiCalls` | `20` | 分类调用次数上限 |
| `evalMaxToolFailures`/`evalMaxRetries` | `0` | 工具失败、重试的绝对要求 |
| `minFixtureCases` | `3` | 功能可用至少执行的夹具用例数 |
| `gateScoreCap` | `7.0` | 门禁不过时的总分上限 |
| `strictStructureGate` | `false` | 是否把华为云结构规则套到所有 kind |
| `idleTimeoutMs` | `480000` | 静默看门狗（8 分钟无活动判死） |
| `phaseTimeoutMs` | `7200000` | 整段绝对兜底（120 分钟） |
| `minImprovement` | — | 无提升早停阈值；修复轮提升低于该值即停止 |
| `catalog{repo,ref,root,localDir,ttlMs}` | — | 官方 creator 目录的拉取与缓存参数 |

## 8. 运行环境

| 依赖 | 用途 |
| --- | --- |
| Node（Host） | 插件宿主运行 |
| `git` | 拉取官方 creator |
| `bash` + `python3` | 部分 creator 的脚本 |
| 华为云 `hcloud` 凭据 | 华为云模式需要真实只读调用 |
| 目标系统可达 | 标准API模式需要 `curl` 验证 |

## 9. 边界（不做什么）

- **不创造 Skill 内容**：内容由官方 creator 产出。
- **不做平台流水线的事**：不建 PR、不交棒。
- **评测是同口径不同源**，不等价于平台门禁结论。
- **评分输入与平台不同**：平台相对于数据库基线并叠加外部门禁；本面板没有基线，改用绝对上限（`eval*` 键）+ 本地确定性门禁。
- **有单轮预算**：token / 时长 / 调用次数超上限，或任一本地门禁不过 → 总分被压到 7.0 以下，一定低于通过线并回传修改。

## 10. 质量数据

- 测试 **162 项全绿**。
- **三种模式端到端实跑通过，均首轮 10/10 达标、零提问、零错误**（数据取自改造前：当时首轮成本/效率白送、且没有本地门禁；改造后同样的产物会按绝对上限 + 夹具证据 + 门禁重新判定）：

| 模式 | Skill |
| --- | --- |
| 华为云 | `huawei-cloud-mrs-manage` |
| 通用技能 | `markdown-notes-index` |
| 标准API | `jsonplaceholder-posts` |

- 创建记录**穿越多次重启仍保留**；并有一次从会话日志重建 **18 条**历史记录的恢复。

## 11. 快速开始

```
# 桌面端：先完全退出 DSH
dsh plugin --profile desktop add @cloudplugin/dsh-skill-creator
# 然后重启一次 DSH
```

重启后：打开面板 → 在侧边栏选模式（默认「通用技能」）→ 填需求 → 点「开始创建」→ 观察阶段与心跳 → 查看评测结论。

## 12. 常见现象与排查

| 现象 | 常见原因 |
| --- | --- |
| 跑一半超时退出 | 权限不足被审批拦停 → 会话静默 → 看门狗判死。检查 `run.permissionPreset` |
| 面板长时间没有新输出 | 先看心跳的「最后活动 Y 秒前」；仍有活动说明只是慢，不是卡住 |
| 记录消失后又回来 | 看门狗误判后收到活动会复活记录；记录也可从会话日志重建 |
| 报告里出现「未纳入」 | 平台侧专有信号本地不可得，属预期标注，不代表功能缺失 |
| 通过后看不到轮次 | 通过后界面只显示「✅ 通过」，属预期行为 |
| 华为云模式目录为空 | 三级目录仅在切到华为云时按需拉取，首次需等待拉取完成 |

## 13. 相关文档

| 文档 | 路径 |
| --- | --- |
| 使用说明（本文档） | `docs/introduction-zh.md` |
| 开发历程与经验 | `docs/development-zh.md` |

> 说明：历史文件 `docs/INTRODUCTION.zh-CN.md` 因权限损坏已不可读——内容读不出、ACL 查询被拒绝，且在非提权进程下无法删除。本文档为其替代版本，文件名随之改为 `introduction-zh.md`。


---

## 版本沿革与命名说明

- 包名：`@cloudplugin/dsh-skill-creator`（当前，npm 上最新为 `0.0.3`）
- 显示标题：**Scenes Skill Creator**（来自 `locale/{zh,en}.json` 的 `meta.title`，与包名解耦）
- 历史上曾一度把包名改为 `@cloudplugin/scenes-skill-creator` 并发布过 `0.0.2`；随后**包名回退**为 `@cloudplugin/dsh-skill-creator`（新版本从 `0.0.3` 起），**显示标题始终是 Scenes Skill Creator**。`@cloudplugin/scenes-skill-creator` 已在 npm 上标记为弃用并指向本包名。
