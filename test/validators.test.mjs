import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateSkillPackage, collectFiles, summarize } from '../src/core/validators.mjs';

export function mkPkg(files, baseName = 'huawei-cloud-ecs-manage') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsc-test-'));
  const root = path.join(dir, baseName);
  fs.mkdirSync(root, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

const GOOD_SKILL_MD = `---
name: huawei-cloud-ecs-manage
description: |
  1. Manage ECS instances through KooCLI
  2. 技术基础：KooCLI (hcloud) + Huawei Cloud OpenAPI
  3. 主要能力：list/show ECS servers
  4. 适用场景：When the user asks to inspect ECS resources
  5. 触发词：ECS 查询 / use this skill when managing ECS instances
tags: [huawei-cloud, ecs, manage]
---
# Manage ECS

## 1. Overview
Lists and shows ECS server details with KooCLI.

**Dependency**: Quality telemetry is collected automatically via \`skill-quality-cli\` (installed by \`scripts/ensure_cli.sh\` if absent).

### Typical Use Cases
1. Daily inspection.
2. Troubleshooting.

## 2. Security Hard Constraints and Scope
Read-only queries. Credentials via env vars only.

## 3. Prerequisites + KooCLI
- hcloud installed (\`hcloud configure list\` verifies).
- **\`skill-quality-cli\`** — ensured by \`bash scripts/ensure_cli.sh\` (idempotent, skips if present)
  - Upgrade: run \`skill-quality-cli upgrade\` manually (no auto-upgrade)
  - Disable telemetry report: set \`SKILL_QUALITY_REPORT=0\`

## 4. Workflow
Single read-only queries; no multi-step workflow ahead of mutating actions.

## 5. Core Commands
> **⚠️ Mandatory: every \`hcloud\` command in this skill MUST be wrapped with \`skill-quality-cli run --skill-name huawei-cloud-ecs-manage -- \` — bare \`hcloud\` calls are strictly forbidden.**

\`\`\`bash
skill-quality-cli run --skill-name huawei-cloud-ecs-manage -- hcloud ECS ListServersDetails --cli-region=cn-north-4 --limit=1
\`\`\`

## 6. Parameter Confirmation
No user-configurable parameters; commands use documented fixed defaults.

## 10. Reference Documents
- \`references/cli-installation-guide.md\` — when hcloud is missing.
- \`references/iam-policies.md\` — when permission errors occur.

## 12. KooCLI Command Format Standard
\`skill-quality-cli run --skill-name <name> -- hcloud <Service> <Operation> --cli-region=<region>\`
`;

const GOOD_REF_CLI = `# KooCLI Installation Guide
## skill-quality-cli
- Ready: bash scripts/ensure_cli.sh
- Manual: bash scripts/install_cli.sh
`;

function goodPkg() {
  return mkPkg({
    'SKILL.md': GOOD_SKILL_MD,
    'references/cli-installation-guide.md': GOOD_REF_CLI,
    'references/iam-policies.md': '# IAM Policies\n{"Version":"5.0"}',
    'references/verification-method.md': '# Verification',
    'references/acceptance-criteria.md': '# Acceptance',
    'scripts/ensure_cli.sh': '#!/bin/bash\necho ok\n',
    'scripts/install_cli.sh': '#!/bin/bash\necho ok\n',
    'scripts/test-cli-commands.sh': '#!/bin/bash\necho test\n',
    'templates/test-vars.json': '{"test_cases":[]}',
  });
}

describe('hard rules (4.2)', () => {
  test('fully compliant package → 0 errors', () => {
    const r = validateSkillPackage(goodPkg(), { mode: 'huawei' });
    const errs = r.issues.filter((i) => i.level === 'error').map((i) => i.id);
    assert.deepEqual(errs, [], r.issues.map((i) => `${i.id}:${i.level}:${i.message}`).join('\n'));
  });

  test('name-format: uppercase + consecutive hyphens rejected', () => {
    const root = mkPkg({ 'SKILL.md': GOOD_SKILL_MD.replace('huawei-cloud-ecs-manage', 'Huawei-Cloud--ECS') });
    fs.renameSync(path.join(root, 'SKILL.md'), path.join(root, 'SKILL.md')); // keep
    const r = validateSkillPackage(root, { mode: 'huawei' });
    assert.ok(r.issues.some((i) => i.id === 'name-format' && i.level === 'error'));
    assert.ok(r.issues.some((i) => i.id === 'name-prefix' && i.level === 'error'));
  });

  test('name-matches-dir: frontmatter name ≠ directory name rejected', () => {
    const root = mkPkg({ 'SKILL.md': GOOD_SKILL_MD.replace('name: huawei-cloud-ecs-manage', 'name: huawei-cloud-vpc-manage') }, 'huawei-cloud-ecs-manage');
    const r = validateSkillPackage(root, { mode: 'huawei' });
    assert.ok(r.issues.some((i) => i.id === 'name-matches-dir'));
  });

  test('yaml-parseable: broken frontmatter rejected', () => {
    const root = mkPkg({ 'SKILL.md': '---\nname: [broken: unclosed\n---\n# hi' });
    const r = validateSkillPackage(root, { mode: 'huawei' });
    assert.ok(r.issues.some((i) => i.id === 'yaml-parseable' && i.level === 'error'));
  });

  test('description-present: missing description rejected', () => {
    const root = mkPkg({ 'SKILL.md': '---\nname: huawei-cloud-ecs-manage\ntags: [a]\n---\n# hi' });
    const r = validateSkillPackage(root, { mode: 'huawei' });
    assert.ok(r.issues.some((i) => i.id === 'description-present'));
  });

  test('description-length: >1024 chars rejected', () => {
    const long = 'x'.repeat(1100);
    const root = mkPkg({ 'SKILL.md': `---\nname: huawei-cloud-ecs-manage\ndescription: |\n  ${long}\n---\n# hi` });
    const r = validateSkillPackage(root, { mode: 'huawei' });
    assert.ok(r.issues.some((i) => i.id === 'description-length'));
  });

  test('tags-count: 6 tags rejected, ≤5 ok', () => {
    const root6 = mkPkg({ 'SKILL.md': '---\nname: huawei-cloud-ecs-manage\ndescription: |\n  1. x\n  Trigger: y\ntags: [a,b,c,d,e,f]\n---\n# hi' });
    assert.ok(validateSkillPackage(root6, { mode: 'huawei' }).issues.some((i) => i.id === 'tags-count'));
  });

  test('body-english: CJK prose in body rejected (huawei mode)', () => {
    const root = mkPkg({ 'SKILL.md': '---\nname: huawei-cloud-ecs-manage\ndescription: |\n  1. x\n  Triggers: y\n---\n# 中文正文' });
    const r = validateSkillPackage(root, { mode: 'huawei' });
    assert.ok(r.issues.some((i) => i.id === 'body-english' && i.level === 'error'));
  });

  test('ext-whitelist: unknown extension rejected', () => {
    const root = mkPkg({ 'SKILL.md': GOOD_SKILL_MD, 'data.xyz': 'x' });
    const r = validateSkillPackage(root, { mode: 'huawei' });
    assert.ok(r.issues.some((i) => i.id === 'ext-whitelist'));
  });

  test('file-count: 41 files rejected', () => {
    const files = { 'SKILL.md': GOOD_SKILL_MD };
    for (let i = 0; i < 40; i++) files[`refs-extra-${i}.md`] = '# x';
    const r = validateSkillPackage(mkPkg(files), { mode: 'huawei' });
    assert.ok(r.issues.some((i) => i.id === 'file-count'));
  });

  test('no-external-links: non-allowlisted host rejected', () => {
    const root = mkPkg({ 'SKILL.md': GOOD_SKILL_MD, 'references/extra.md': 'see https://www.example.com/docs' });
    const r = validateSkillPackage(root, { mode: 'huawei' });
    assert.ok(r.issues.some((i) => i.id === 'no-external-links'));
  });

  test('allowed external hosts (official toolchain) pass', () => {
    const root = mkPkg({ 'SKILL.md': GOOD_SKILL_MD, 'references/extra.md': 'see https://support.huaweicloud.com/cli/index.html' });
    const r = validateSkillPackage(root, { mode: 'huawei' });
    assert.ok(!r.issues.some((i) => i.id === 'no-external-links'));
  });

  test('ref-cli-guide: hcloud usage without cli-installation-guide.md rejected', () => {
    const files = { 'SKILL.md': GOOD_SKILL_MD };
    for (const f of ['references/cli-installation-guide.md']) delete files[f];
    const r = validateSkillPackage(mkPkg(files), { mode: 'huawei' });
    assert.ok(r.issues.some((i) => i.id === 'ref-cli-guide'));
  });

  test('ref-exists: referenced file missing rejected', () => {
    const md = GOOD_SKILL_MD + '\nWhen X fails read `references/cli-troubleshooting.md`.\n';
    const root = mkPkg({ 'SKILL.md': md });
    const r = validateSkillPackage(root, { mode: 'huawei' });
    assert.ok(r.issues.some((i) => i.id === 'ref-exists'));
  });

  test('no-aksk: secret pattern in file rejected', () => {
    const root = mkPkg({ 'SKILL.md': GOOD_SKILL_MD, 'scripts/leak.sh': 'export HUAWEI_ACCESS_KEY=ABCDEFGHIJKLMNOP1234\n' });
    const r = validateSkillPackage(root, { mode: 'huawei' });
    assert.ok(r.issues.some((i) => i.id === 'no-aksk'));
  });

  test('hcloud-unwrapped: a bare hcloud invocation in a bash block is rejected (rule 14d)', () => {
    const md = GOOD_SKILL_MD.replace(
      'skill-quality-cli run --skill-name huawei-cloud-ecs-manage -- hcloud ECS ListServersDetails --cli-region=cn-north-4 --limit=1',
      'hcloud ECS ListServersDetails --cli-region=cn-north-4 --limit=1');
    const r = validateSkillPackage(mkPkg({ 'SKILL.md': md }), { mode: 'huawei' });
    assert.ok(r.issues.some((i) => i.id === 'hcloud-unwrapped'), JSON.stringify(r.issues.map((i) => i.id)));
  });

  test('read-only diagnostics stay allowed without the wrapper', () => {
    const md = GOOD_SKILL_MD.replace(
      'skill-quality-cli run --skill-name huawei-cloud-ecs-manage -- hcloud ECS ListServersDetails --cli-region=cn-north-4 --limit=1',
      'hcloud configure list\nhcloud version');
    const r = validateSkillPackage(mkPkg({ 'SKILL.md': md }), { mode: 'huawei' });
    assert.ok(!r.issues.some((i) => i.id === 'hcloud-unwrapped'), JSON.stringify(r.issues.map((i) => i.id)));
  });

  test('q-*: the rule-14 quality files are required for CLI skills', () => {
    for (const [id, rel] of [['q-ensure-cli', 'scripts/ensure_cli.sh'], ['q-install-cli', 'scripts/install_cli.sh'], ['q-test-runner', 'scripts/test-cli-commands.sh']]) {
      const files = { 'SKILL.md': GOOD_SKILL_MD };
      delete files[rel];
      const r = validateSkillPackage(mkPkg(files), { mode: 'huawei' });
      assert.ok(r.issues.some((i) => i.id === id), `expected ${id} when ${rel} is missing — got ${r.issues.map((i) => i.id)}`);
    }
  });

  test('q-wrapper-mandatory: the SKILL.md must state the wrapper rule (rule 14c)', () => {
    // strip every `--skill-name …` form (concrete and placeholder) so rule 14c cannot match
    const md = GOOD_SKILL_MD.split('--skill-name huawei-cloud-ecs-manage -- ').join('-- ')
      .split('--skill-name <name> -- ').join('-- ');
    const r = validateSkillPackage(mkPkg({ 'SKILL.md': md }), { mode: 'huawei' });
    assert.ok(r.issues.some((i) => i.id === 'q-wrapper-mandatory'), JSON.stringify(r.issues.map((i) => i.id)));
  });

  test('section-required: auditor-critical section headings are enforced', () => {
    const md = GOOD_SKILL_MD.replace('## 6. Parameter Confirmation', '## 6. Parameters');
    const r = validateSkillPackage(mkPkg({ 'SKILL.md': md }), { mode: 'huawei' });
    assert.ok(r.issues.some((i) => i.id === 'section-required' && /Parameter Confirmation/.test(i.message)), JSON.stringify(r.issues.map((i) => i.id)));
  });

  test('ref-documents-section: the Reference Documents heading is auditor-critical', () => {
    const md = GOOD_SKILL_MD.replace('## 10. Reference Documents', '## 10. Related Reading');
    const r = validateSkillPackage(mkPkg({ 'SKILL.md': md }), { mode: 'huawei' });
    assert.ok(r.issues.some((i) => i.id === 'ref-documents-section'), JSON.stringify(r.issues.map((i) => i.id)));
  });

  test('version rules: edit without version → error; same version → bump error', () => {
    const files = { 'SKILL.md': GOOD_SKILL_MD.replace('---\n# Manage ECS', '---\n# Manage ECS').replace('tags: [huawei-cloud, ecs, manage]\n', 'tags: [huawei-cloud, ecs, manage]\nversion: 0.1.0\n') };
    const root = mkPkg(files);
    const rNoEdit = validateSkillPackage(root, { mode: 'huawei', editMode: true, prevVersion: '0.1.0' });
    assert.ok(rNoEdit.issues.some((i) => i.id === 'version-bump'));
    // remove version → version-required
    const files2 = { 'SKILL.md': GOOD_SKILL_MD };
    const r2 = validateSkillPackage(mkPkg(files2), { mode: 'huawei', editMode: true, prevVersion: '0.1.0' });
    assert.ok(r2.issues.some((i) => i.id === 'version-required'));
  });

  test('editMode concept: validators audit existing skill packages too', () => {
    const r = validateSkillPackage(goodPkg(), { mode: 'huawei', editMode: true, prevVersion: '0.1.0' });
    // goodPkg has no version → error expected on edit path
    assert.ok(r.issues.some((i) => i.id === 'version-required'));
  });

  test('collectFiles walks nested dirs only', () => {
    const root = goodPkg();
    const files = collectFiles(root);
    assert.ok(files.has('SKILL.md'));
    assert.ok(files.has('references/cli-installation-guide.md'));
    assert.ok(files.has('scripts/ensure_cli.sh'));
  });

  test('generic mode: huawei-only checks relaxed', () => {
    const root = mkPkg({
      'SKILL.md': '---\nname: my-generic-skill\ndescription: |\n  1. 通用技能\n  Trigger: 通用\n---\n# 通用技能\n这里有中文正文没问题',
    }, 'my-generic-skill');
    const r = validateSkillPackage(root, { mode: 'generic' });
    assert.ok(!r.issues.some((i) => i.id === 'body-english' || i.id === 'name-prefix' || i.id === 'q-ensure-cli'));
  });

  test('summarize counts levels', () => {
    const s = summarize([{ level: 'error' }, { level: 'error' }, { level: 'warning' }]);
    assert.deepEqual(s, { errors: 2, warnings: 1, infos: 0 });
  });
});