import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CREATORS, buildHandoff, cacheRoot, creatorDir, kindOfMode, status } from '../src/core/creators.mjs';

// Point the cache at a scratch dir so the suite never touches a real creator cache.
process.env.DSH_SKILL_CREATOR_CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'dsc-creators-'));

describe('creator delegation (no re-implementation)', () => {
  test('each mode maps onto the official creator repository', () => {
    assert.equal(kindOfMode('huawei'), 'huawei');
    assert.equal(kindOfMode('generic'), 'generic');
    assert.equal(kindOfMode(undefined), 'huawei');

    assert.equal(CREATORS.huawei.skill, 'huawei-cloud-skill-creator');
    assert.equal(CREATORS.huawei.repo, 'https://gitcode.com/huaweicloud/huaweicloud-skills.git');
    assert.equal(CREATORS.huawei.branch, 'master');
    assert.equal(CREATORS.huawei.path, 'skills/devtools/common/huawei-cloud-skill-creator');

    assert.equal(CREATORS.generic.skill, 'common-skill-creator');
    assert.equal(CREATORS.generic.repo, 'https://gitcode.com/grape-dev/grape-skills.git');
    assert.equal(CREATORS.generic.branch, 'main');
    assert.equal(CREATORS.generic.path, 'skills/coding/scaffolding/common-skill-creator');
  });

  test('status reports absence without hitting the network', () => {
    const current = status('huawei');
    assert.equal(current.present, false);
    assert.equal(current.fresh, false);
    assert.equal(current.commit, '');
    assert.deepEqual(current.files, []);
    assert.ok(creatorDir('huawei').startsWith(cacheRoot()));
  });

  test('the handoff request names the creator and carries the collected spec', () => {
    const prompt = buildHandoff('huawei', {
      name: 'huawei-cloud-ecs-manage', domain: 'computing', product: 'ecs',
      summary: 'Manage ECS via KooCLI', tags: ['huawei-cloud', 'ecs'],
    });
    assert.match(prompt, /Use the `huawei-cloud-skill-creator` skill/);
    assert.match(prompt, /do not shortcut it/);
    assert.match(prompt, /Skill name: huawei-cloud-ecs-manage/);
    assert.match(prompt, /Repository path: skills\/computing\/ecs\/huawei-cloud-ecs-manage/);
    assert.match(prompt, /gitcode\.com\/huaweicloud\/huaweicloud-skills/);
    // empty fields are omitted rather than sent as blanks
  });

  test('generic handoff carries the description, never the Huawei packaging', () => {
    const prompt = buildHandoff('generic', { description: 'Turn my notes into an index page.' });
    assert.match(prompt, /Use the `common-skill-creator` skill/);
    assert.match(prompt, /技能功能描述 \(description\): Turn my notes into an index page\./);
    assert.doesNotMatch(prompt, /Repository path/);
    assert.doesNotMatch(prompt, /一级目录/);
    assert.doesNotMatch(prompt, /① 功能概要/);
    assert.doesNotMatch(prompt, /tags/);
    assert.match(prompt, /grape-dev\/grape-skills/);
    // A name is optional for generic: when given, it is only a request to the creator.
    assert.match(buildHandoff('generic', { name: 'my-skill', description: 'x' }), /Requested name: my-skill/);
  });

  test('an unknown kind is rejected', () => {
    assert.throws(() => buildHandoff('nope', {}), /unknown creator kind/);
    assert.throws(() => status('nope'), /unknown creator kind/);
  });
});
