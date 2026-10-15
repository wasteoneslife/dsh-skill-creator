/**
 * Spec constants — extracted from 《华为云基础云服务Skills和仓库管理规范》
 * (v1.0.0 + 3 community revisions, 整理版 2026-09-29) sections 2.4 / 3.2 / 3.4 / 4.1 / 4.2 / 4.4.
 * Single source of truth for every validator, generator and UI dropdown.
 */

export const SPEC = {
  version: 'v1.0.0-3rev (2026-09-29 整理版)',
  // 4.1 size & count limits
  skillMdMaxLines: 499,            // < 500 lines
  maxFileBytes: 5 * 1024 * 1024,   // single file ≤ 5 MB
  maxPackageBytes: 50 * 1024 * 1024, // package ≤ 50 MB
  maxFileCount: 40,                // ≤ 40 files
  // 3.2 frontmatter
  nameMaxChars: 64,
  nameRe: /^[a-z0-9]+(-[a-z0-9]+)*$/,
  huaweiNamePrefix: 'huawei-cloud-',
  descriptionMaxChars: 1024,
  maxTags: 5,
  // 4.1 extension whitelist (46)
  extWhitelist: [
    '.md', '.mdx', '.txt', '.html', '.xml', '.csv', '.tsv',
    '.json', '.json5', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env', '.properties', '.dat',
    '.sh', '.ps1', '.psm1', '.psd1', '.py', '.js', '.cjs', '.mjs',
    '.ts', '.tsx', '.jsx', '.css', '.scss', '.sass', '.svg',
    '.r', '.rb', '.go', '.rs', '.swift', '.kt', '.java', '.cs', '.cpp', '.c', '.h', '.hpp',
    '.sql',
  ],
};

// 2.4 product domains → products (used by wizard dropdowns + path computation)
export const DOMAINS = {
  computing: ['ecs', 'as', 'ims', 'functiongraph'],
  network: ['vpc', 'eip', 'elb', 'nat', 'vpn', 'dns'],
  storage: ['obs', 'evs', 'sfs', 'hbr'],
  database: ['rds', 'gaussdb', 'dcs', 'dds', 'gemini'],
  security: ['iam', 'waf', 'antiddos', 'kms', 'dew'],
  monitoring: ['ces', 'aom', 'lts'],
  middleware: ['cce', 'dms', 'kafka'],
  devtools: ['koocli', 'codearts', 'skills'],
  solution: ['dtse'],
};

// 2.4 skill functional types (reflected in the name)
export const FEATURE_TYPES = [
  { suffix: '-manage', label: '资源管理', desc: 'query/configure cloud resources' },
  { suffix: '-diagnosis-workflow', label: '诊断工作流', desc: 'multi-step diagnostic workflow' },
  { suffix: '-copilot', label: '智能助手', desc: 'interactive assistant' },
  { suffix: '-workflow', label: '解决方案工作流', desc: 'solution workflow (solution domain)' },
];

// 3.4 body sections (1 required, 2-6 conditional, 7-11 recommended)
export const SECTIONS = [
  { id: 'overview', title: '1. Overview', required: true, condition: null },
  { id: 'securityBounds', title: '2. Security Hard Constraints and Scope', required: 'write', condition: 'write operations involved' },
  { id: 'prerequisites', title: '3. Prerequisites + KooCLI', required: 'cli', condition: 'CLI involved' },
  { id: 'workflow', title: '4. Workflow', required: 'write', condition: 'multi-step workflow' },
  { id: 'coreCommands', title: '5. Core Commands', required: 'cli', condition: 'CLI involved' },
  { id: 'parameterConfirmation', title: '6. Parameter Confirmation', required: 'cli', condition: 'user-configurable params' },
  { id: 'outputFormat', title: '7. Output Format', required: false, condition: null },
  { id: 'verificationMethod', title: '8. Verification Method', required: false, condition: null },
  { id: 'bestPractices', title: '9. Best Practices', required: false, condition: null },
  { id: 'referenceDocuments', title: '10. Reference Documents', required: false, condition: null },
  { id: 'notes', title: '11. Notes', required: false, condition: null },
];

export const EXTENSIONS = SPEC.extWhitelist;

export function domainProducts(domain) {
  return DOMAINS[domain] || [];
}

export function extOf(filename) {
  const base = filename.split('/').pop();
  const idx = base.lastIndexOf('.');
  if (idx <= 0) return '';
  return base.slice(idx).toLowerCase();
}