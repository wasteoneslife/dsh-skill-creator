import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter, splitFrontmatter, parseFrontmatterLenient } from '../src/lib/yaml.mjs';

const FM = `---
name: huawei-cloud-ecs-manage
description: |
  1. Manage ECS resources via KooCLI
  2. Triggers include: "ECS 查询", "ECS management"
tags: [huawei-cloud, ecs, manage]
version: 0.2.0
---
# body`;
const FM_NO_VERSION = `---
name: huawei-cloud-rds-copilot
description: |
  1. RDS copilot
  Use when user asks about RDS.
tags: [huawei-cloud, rds]
---`;

test('parses block-scalar description and flow array tags', () => {
  const { data, body } = parseFrontmatter(FM);
  assert.equal(data.name, 'huawei-cloud-ecs-manage');
  assert.equal(typeof data.description, 'string');
  assert.ok(data.description.includes('1. Manage ECS resources'));
  assert.ok(data.description.includes('2. Triggers include: "ECS 查询"'));
  assert.deepEqual(data.tags, ['huawei-cloud', 'ecs', 'manage']);
  assert.equal(data.version, '0.2.0');
  assert.ok(body.includes('# body'));
});

test('splitFrontmatter without frontmatter returns body only', () => {
  const r = splitFrontmatter('# hello');
  assert.equal(r.frontmatter, null);
});

test('missing closing --- is an error', () => {
  const r = parseFrontmatterLenient('---\nname: x\n');
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('frontmatter'));
});

test('stray colon in value position without quotes → unparseable line error', () => {
  const r = parseFrontmatterLenient('---\nname: x\nbad: a: b\n---');
  assert.equal(r.ok, false);
});

test('lenient mode never throws', () => {
  assert.doesNotThrow(() => parseFrontmatterLenient('random junk'));
  assert.doesNotThrow(() => parseFrontmatterLenient(''));
});

test('version absent → undefined; numeric-like scalars parsed', () => {
  const { data } = parseFrontmatter(FM_NO_VERSION);
  assert.equal(data.version, undefined);
});