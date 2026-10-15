/**
 * Validators — every check maps to a rule in 《华为云基础云服务Skills和仓库管理规范》
 * (4.1 size/ext, 4.2 hard rules, 3.1-3.8 content rules, rule 14 quality injection).
 * check id scheme: <rule-area>-<slug> with level error|warning.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SPEC, SECTIONS, extOf } from './spec.mjs';
import { splitFrontmatter, parseFrontmatterLenient } from '../lib/yaml.mjs';

/** Official toolchain domains allowed as external links (creator itself relies on them). */
const ALLOWED_EXTERNAL_HOSTS = [
  'support.huaweicloud.com', 'console.huaweicloud.com', 'api-explorer.huaweicloud.com',
  'gitcode.com', 'skills.huaweicloud.com',
];
function isAllowedExternalHost(host) {
  if (ALLOWED_EXTERNAL_HOSTS.includes(host)) return true;
  // official Huawei Cloud storage/doc infra: *.myhuaweicloud.com (KooCLI install OBS etc.)
  return host.endsWith('.myhuaweicloud.com') || host === 'myhuaweicloud.com';
}
const CJK_RE = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;
const MUTATING_VERBS = /\b(create|delete|update|modify|reboot|restart|start|stop|attach|detach|resize|reset)\b/i;
const CRED_PATTERNS = [
  /AKIA[0-9A-Z]{16}/,
  /\b(?:access[_-]?key|secret[_-]?key|ak|sk)\s*[:=]\s*['"]?[A-Z0-9]{16,}['"]?/i,
  /HUAWEI_(?:ACCESS_KEY|SECRET_KEY)\s*=\s*[^<\s$][^\s]*/,
  /hcloud\s+configure\s+set\b[^\n]*(?:--access|--secret|cli-ak|cli-sk)/i,
];
const HCLOUD_CMD_RE = /\bhcloud\s+([A-Za-z0-9]+)\s+([A-Za-z0-9/]+)/g;
/** rule-14 official quality scripts keep their canonical underscore names (must stay byte-identical). */
// Filenames exempt from the kebab-case-name rule: the creator ships these verbatim.
const RULE14_SCRIPTS = new Set(['scripts/ensure_cli.sh', 'scripts/install_cli.sh']);

export function collectFiles(rootDir) {
  const files = new Map(); // relPath (posix) -> {absPath, content, bytes}
  const walk = (dir, prefix) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === '.git' || e.name === '__pycache__' || e.name === 'node_modules') continue;
        walk(abs, rel);
      } else if (e.isFile()) {
        const bytes = fs.statSync(abs).size;
        let content = '';
        if (bytes < 2 * 1024 * 1024 && /\.(md|mdx|txt|json|yml|yaml|toml|ini|cfg|conf|env|properties|sh|ps1|py|js|cjs|mjs|ts|tsx|jsx|css|scss|sass|html|xml|csv|tsv|sql|r|rb|go|rs|kt|java|cs|cpp|c|h|hpp|svg|dat)$/i.test(e.name)) {
          try { content = fs.readFileSync(abs, 'utf8'); } catch { content = ''; }
        }
        files.set(rel, { absPath: abs, content, bytes });
      }
    }
  };
  walk(rootDir, '');
  return files;
}

export function validateSkillPackage(rootDir, opts = {}) {
  const mode = opts.mode || 'huawei';
  const editMode = !!opts.editMode;
  const files = collectFiles(rootDir);
  const issues = [];
  const add = (id, level, message, file = null) => issues.push({ id, level, message, file });

  const skillMd = files.get('SKILL.md');
  const skillMdContent = skillMd ? skillMd.content : '';
  const dirBasename = path.basename(path.resolve(rootDir));
  const fm = skillMdContent ? parseFrontmatterLenient(skillMdContent) : { ok: false, data: {}, body: '', error: 'SKILL.md missing or unreadable' };
  const body = fm.ok ? fm.body : '';
  const relPathList = [...files.keys()];

  // ── structure & size (4.1) ──────────────────────────────────────────────
  if (!skillMd) {
    add('skill-md-exists', 'error', 'SKILL.md is the mandatory entry of a skill package (2.2)', 'SKILL.md');
    return { mode, issues, stats: statsOf(files, 0) };
  }
  if (skillMd.bytes > SPEC.maxFileBytes) {
    add('single-file-size', 'error', `单文件 ≤ ${SPEC.maxFileBytes / 1048576} MB — SKILL.md is ${(skillMd.bytes / 1048576).toFixed(1)} MB (4.1)`, 'SKILL.md');
  }
  for (const [rel, f] of files) {
    if (f.bytes > SPEC.maxFileBytes) {
      add('single-file-size', 'error', `single file ≤ ${SPEC.maxFileBytes / 1048576} MB (4.1)`, rel);
    }
    const ext = extOf(rel);
    if (rel.includes('.git/')) continue;
    if (!SPEC.extWhitelist.includes(ext)) {
      add('ext-whitelist', 'error', `扩展名 "${ext || '(none)'}" 不在 46 种白名单内 — 删除或改名 (4.1)`, rel);
    }
    const fn = rel.split('/').pop();
    // The auditor's kebab-case rule covers references/ only, and the creator's own
    // carrier ships underscore names (ensure_cli.sh, cli_entry.py) verbatim.
    if (rel.startsWith('references/') && !/^[a-z0-9]+(-[a-z0-9]+)*\./.test(fn)) {
      add('kebab-case', 'warning', `参考文件名应为小写 kebab-case (3.5/3.6/3.7/3.8)`, rel);
    }
  }
  if (relPathList.length > SPEC.maxFileCount) {
    add('file-count', 'error', `技能包文件数 ≤ ${SPEC.maxFileCount}，当前 ${relPathList.length} (4.1)`);
  }
  const totalBytes = [...files.values()].reduce((s, f) => s + f.bytes, 0);
  if (totalBytes > SPEC.maxPackageBytes) {
    add('package-size', 'error', `技能包总体积 ≤ ${SPEC.maxPackageBytes / 1048576} MB (4.1)`);
  }

  // ── top-level structure (2.2) ──────────────────────────────────────────
  const allowedTop = new Set(['SKILL.md', 'references', 'scripts', 'templates', 'demo']);
  for (const rel of relPathList) {
    const top = rel.split('/')[0];
    if (!allowedTop.has(top)) {
      add('top-level', 'error', `不允许的顶层条目 "${top}" — 合法: SKILL.md / references/ / scripts/ / templates/ / demo/ (2.2)`, rel);
    }
  }

  // ── frontmatter (3.2) ──────────────────────────────────────────────────
  if (!fm.ok) {
    add('yaml-parseable', 'error', `Frontmatter 无法通过 YAML 解析: ${fm.error} (3.1)`, 'SKILL.md');
  } else {
    const d = fm.data;
    if (!d.name) add('name-present', 'error', 'frontmatter 缺 name 字段 (3.2)', 'SKILL.md');
    else {
      if (d.name !== dirBasename) add('name-matches-dir', 'error', `name "${d.name}" 必须与目录名 "${dirBasename}" 一致 (3.2)`, 'SKILL.md');
      if (!SPEC.nameRe.test(d.name) || d.name.length > SPEC.nameMaxChars) {
        add('name-format', 'error', `name 1-${SPEC.nameMaxChars} 字符、仅小写字母/数字/连字符、无首尾/连续连字符: "${d.name}" (3.2)`, 'SKILL.md');
      }
      if (mode === 'huawei' && !d.name.startsWith(SPEC.huaweiNamePrefix)) {
        add('name-prefix', 'error', `华为云技能命名必须为 ${SPEC.huaweiNamePrefix}{产品缩写}-{功能描述} (1.3/2.4)`, 'SKILL.md');
      }
    }
    if (!d.description || String(d.description).trim() === '') {
      add('description-present', 'error', 'frontmatter 缺 description（触发的唯一入口）(3.2)', 'SKILL.md');
    } else {
      const desc = String(d.description);
      if (desc.length > SPEC.descriptionMaxChars) {
        add('description-length', 'error', `description ≤ ${SPEC.descriptionMaxChars} 字符，当前 ${desc.length} (3.2)`, 'SKILL.md');
      }
      const hasTrigger = /触发|trigger|use when|when the user|Triggers include:/i.test(desc);
      if (!hasTrigger) add('description-trigger', 'warning', 'description 建议含触发词/触发条件（auditor 为 WARN 级；生成器会自动合成五要素⑤）(3.2)', 'SKILL.md');
      const fiveElem = (desc.match(/\n\d\./g) || []).length;
      if (fiveElem < 2) add('description-elements', 'warning', 'description 建议含五要素（功能概要/技术基础/能力/场景/触发词）(3.2)', 'SKILL.md');
    }
    if (Array.isArray(d.tags)) {
      if (d.tags.length > SPEC.maxTags) add('tags-count', 'error', `tags ≤ ${SPEC.maxTags}，当前 ${d.tags.length} (3.2)`, 'SKILL.md');
      for (const t of d.tags) {
        if (CJK_RE.test(String(t))) add('tags-language', 'error', `name/tags 必须英文 (3.3): "${t}"`, 'SKILL.md');
        if (!/^[a-z0-9][a-z0-9-]*$/.test(String(t))) add('tags-format', 'warning', `tags 建议小写 kebab-case (3.2): "${t}"`, 'SKILL.md');
      }
    } else if (d.tags !== undefined) {
      add('tags-format', 'warning', 'tags 应为数组, 如 [huawei-cloud, ecs] (3.2)', 'SKILL.md');
    }
    if (editMode) {
      if (d.version === undefined) add('version-required', 'error', '修改已有技能必须递增 version（PR 门槛）(2.5/4.2)', 'SKILL.md');
      else if (opts.prevVersion && d.version === opts.prevVersion) {
        add('version-bump', 'error', `version 必须递增（当前仍为 ${opts.prevVersion}）(2.5)`, 'SKILL.md');
      } else if (d.version !== undefined && !/^\d+\.\d+\.\d+$/.test(String(d.version))) {
        add('version-format', 'warning', `version 建议 semver x.y.z，当前 "${d.version}"`, 'SKILL.md');
      }
    } else if (d.version !== undefined) {
      add('version-unexpected', 'warning', '新建技能可不加 version 字段（加则从 0.1.0 起）(3.2)', 'SKILL.md');
    }
  }

  // ── language (3.3) ─────────────────────────────────────────────────────
  if (mode === 'huawei') {
    const prose = stripCodeAndFences(body);
    if (CJK_RE.test(prose)) {
      const sample = prose.match(CJK_RE)[0];
      add('body-english', 'error', `SKILL.md 正文必须英文（中英混排仅限 description）（3.3）— 命中 "${sample}"`, 'SKILL.md');
    }
  }

  // ── references & links (3.4/3.5) ───────────────────────────────────────
  const usesCli = /hcloud|KooCLI|koocli/i.test(body) && (opts.usesCli !== false);
  const usesAuth = /认证|IAM|credential|configure/i.test(body) && (opts.usesAuth !== false);
  const isWrite = opts.isWrite !== undefined ? opts.isWrite : MUTATING_VERBS.test(body);
  const refMentions = [...body.matchAll(/references\/[A-Za-z0-9._-]+\.md/g)].map((m) => m[0]);
  for (const ref of refMentions) {
    if (!files.has(ref)) add('ref-exists', 'error', `正文引用了不存在的文件: ${ref} (3.5 引用一致性)`, 'SKILL.md');
  }
  if (/\.\.\/|\/[A-Za-z]:|\bhttps?:\/\//.test(body.replace(/```[\s\S]*?```/g, ''))) {
    const abs = body.match(/[^\n]*(?:\.\.\/|\/[A-Za-z]:)[^\n]*/);
    add('relative-refs', 'error', `引用必须相对路径、一级深度（绝对路径/越级 禁止）(3.1/3.4)${abs ? `: ${abs[0].trim().slice(0, 100)}` : ''}`, 'SKILL.md');
  }
  for (const [rel, f] of files) {
    if (!/\.md$/.test(rel)) continue;
    const links = [...f.content.matchAll(/https?:\/\/[^\s)\]>"']+/g)].map((m) => m[0]);
    for (const url of links) {
      try {
        const host = new URL(url).hostname;
        if (!isAllowedExternalHost(host)) {
          add('no-external-links', 'error', `参考文档禁止外链外部网站（3.4 第 10 条）: ${url}`, rel);
        }
      } catch { /* ignore malformed */ }
    }
  }
  if (mode === 'huawei' && usesCli && !files.has('references/cli-installation-guide.md')) {
    add('ref-cli-guide', 'warning', '涉及 CLI 建议提供 references/cli-installation-guide.md（auditor 为 recommended 级）', null);
  }
  if (mode === 'huawei' && !files.has('references/dataflow-diagram.md') && usesCli) {
    add('ref-dataflow', 'warning', '建议提供 references/dataflow-diagram.md（creator Phase 3：Mermaid 数据流图）', null);
  }
  if (mode === 'huawei' && usesAuth && !files.has('references/iam-policies.md')) {
    add('ref-iam-policies', 'error', '涉及认证必选 references/iam-policies.md（IAM 最小权限）(2.2/3.5)', null);
  }
  if (mode === 'huawei' && !files.has('references/verification-method.md')) add('ref-verification', 'warning', '建议提供 references/verification-method.md (2.2)', null);
  if (mode === 'huawei' && !files.has('references/acceptance-criteria.md')) add('ref-acceptance', 'warning', '建议提供 references/acceptance-criteria.md (2.2)', null);

  // ── commands & credentials (4.4/4.2) ───────────────────────────────────
  const bashBlocks = [...skillMdContent.matchAll(/```(?:bash|sh|shell|console)?\n([\s\S]*?)```/g)];
  for (const [, block] of bashBlocks) {
    for (const line of block.split('\n')) {
      const bare = line.match(/^\s*hcloud\s+(\S+)(?:\s+(\S+))?/);
      if (!bare) continue;
      const svc = bare[1];
      // `hcloud version` / `hcloud configure list` are read-only diagnostics; every
      // service call must be wrapped (rule 14d).
      if (!/^(version|configure)$/i.test(svc)) {
        add('hcloud-unwrapped', 'error', `裸 hcloud 命令未用 skill-quality-cli run -- 包裹 (rule 14d): ${line.trim()}`, 'SKILL.md');
        continue;
      }
    }
  }
  for (const [rel, f] of files) {
    if (f.bytes > 512 * 1024 || f.bytes === 0) continue;
    const content = f.content;
    if (CRED_PATTERNS.some((re) => re.test(content))) {
      if (/<your-[^>]+>/.test(content)) continue; // placeholder template
      add('no-aksk', 'error', '检测到疑似明文 AK/SK / 凭证泄漏模式 — 一律环境变量（4.2 凭证硬规则）', rel);
    }
    if (/^\s*(?:cat|echo|more|less|head|tail)\s+.*(?:\.aws\/credentials|\.hcloud|hca|config\.json|auth\.toml)/m.test(content)) {
      add('no-cred-read', 'warning', '禁止读取磁盘凭证文件 — 仅用 hcloud configure list (4.2)', rel);
    }
  }

  // ── execution patterns (4.2) ───────────────────────────────────────────
  if (isWrite) {
    if (!/(confirm|confirmation|确认|逐步|read -p)/i.test(body)) {
      add('write-confirm', 'warning', '写操作技能须逐步确认：每步用户确认后才继续 (4.2)', 'SKILL.md');
    }
    if (!/(json|JSON).*(markdown|Markdown|报告)|双输出|dual/i.test(body)) {
      add('dual-output', 'warning', '结果双输出：JSON（机器可读）+ Markdown（人类可读）(4.2)', 'SKILL.md');
    }
    if (!/(default.*read|默认只读|read.?only|只读优先)/i.test(body)) {
      add('readonly-default', 'warning', '默认只读优先，写操作需用户确认 (4.2)', 'SKILL.md');
    }
  }
  if (mode === 'huawei') {
    const otherSkills = [...body.matchAll(/huawei-cloud-[a-z0-9-]+/g)].map((m) => m[0]);
    const own = fm.ok ? fm.data.name : dirBasename;
    const foreign = [...new Set(otherSkills.filter((s) => s !== own))];
    if (foreign.length) add('no-skill-calls', 'warning', `Skill 之间禁止直接调用（协作须经 Agent 编排）(4.2): ${foreign.join(', ')}`, 'SKILL.md');

    // ── creator carrier + skeleton (huawei-cloud-skill-creator v2) ───────
    // Required section headings — the auditor FAILs when any is missing, and accepts
    // either the English or the Chinese heading.
    for (const [name, re] of [
      ['Overview', /^##[^\n]*(Overview|概述)/im],
      ['Prerequisites', /^##[^\n]*(Prerequisites|前置条件)/im],
      ['Workflow', /^##[^\n]*(Workflow|工作流)/im],
      ['Core Commands', /^##[^\n]*(Core Commands|核心命令)/im],
      ['Parameter Confirmation', /^##[^\n]*(Parameter Confirmation|参数确认)/im],
    ]) {
      if (!re.test(body)) add('section-required', 'error', `缺必备章节 “${name}”（auditor Critical 检查）`, 'SKILL.md');
    }
    if (!/^##[^\n]*(参考文档|Reference Documents|References)/im.test(body)) {
      add('ref-documents-section', 'error', '缺 “Reference Documents” 章节（auditor Critical 检查）', 'SKILL.md');
    }
    if (usesCli && !/^##[^\n]*(KooCLI[^\n]*(Command Format|命令格式)|CLI Command Format|CLI命令格式)/im.test(body)) {
      add('koolcli-format-section', 'warning', 'CLI 技能建议提供 “KooCLI Command Format Standard” 章节（auditor Medium）', 'SKILL.md');
    }
    // ── quality reporting (rule 14, as the public creator specifies) ──────
    // scripts/ensure_cli.sh + scripts/install_cli.sh + scripts/test-cli-commands.sh,
    // and every hcloud call wrapped inline with `skill-quality-cli run --skill-name`.
    if (usesCli) {
      if (!files.has('scripts/ensure_cli.sh')) add('q-ensure-cli', 'error', '缺 scripts/ensure_cli.sh（质量上报 CLI 幂等安装，rule 14a）', null);
      if (!files.has('scripts/install_cli.sh')) add('q-install-cli', 'error', '缺 scripts/install_cli.sh（rule 14a 要求，与 creator 字节一致）', null);
      if (!files.has('scripts/test-cli-commands.sh')) add('q-test-runner', 'error', '缺 scripts/test-cli-commands.sh（Phase 4 测试执行器）', null);
      if (!/skill-quality-cli/.test(body)) add('q-dependency', 'error', 'SKILL.md 缺质量上报依赖说明（“Dependency: …”于 Overview 末尾，rule 14b）', 'SKILL.md');
      if (!/skill-quality-cli\s+run\s+--skill-name/.test(body)) {
        add('q-wrapper-mandatory', 'error', 'SKILL.md 缺强制包装指令：所有 hcloud 调用须为 `skill-quality-cli run --skill-name <name> -- hcloud …`（rule 14c）', 'SKILL.md');
      }
    }
    const cliGuide = files.get('references/cli-installation-guide.md');
    if (cliGuide && !/skill-quality-cli|ensure_cli\.sh/.test(cliGuide.content)) {
      add('q-cli-guide', 'warning', 'cli-installation-guide.md 应包含 skill-quality-cli 章节（rule 14e）', 'references/cli-installation-guide.md');
    }
  }

  return { mode, issues, stats: statsOf(files, skillMdContent.split(/\r?\n/).length) };
}

function tagsHasQualityWrapped(line) {
  // a bare hcloud line is "unwrapped" if the previous token is not `-- `
  const before = line.slice(0, line.indexOf('hcloud'));
  return !/--\s*$/.test(before);
}

function stripCodeAndFences(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\[[^\]]*\]\([^)]*\)/g, ' ');
}

export function statsOf(files, skillMdLines) {
  const totalBytes = [...files.values()].reduce((s, f) => s + f.bytes, 0);
  return {
    fileCount: files.size,
    totalBytes,
    totalMB: +(totalBytes / 1048576).toFixed(2),
    skillMdLines,
    overFileCount: files.size > SPEC.maxFileCount,
    overPackage: totalBytes > SPEC.maxPackageBytes,
  };
}

export function summarize(issues) {
  return {
    errors: issues.filter((i) => i.level === 'error').length,
    warnings: issues.filter((i) => i.level === 'warning').length,
    infos: issues.filter((i) => i.level === 'info').length,
  };
}

export { SECTIONS };