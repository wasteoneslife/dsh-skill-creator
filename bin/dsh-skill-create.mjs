#!/usr/bin/env node
/**
 * dsh-skill-create — fetch the official creator and print the handoff request.
 *
 * Creation itself belongs to the creator skill (its own pipeline, run by an agent), so
 * this CLI only prepares that request. Paste the output into a Harness session.
 *
 * Usage:
 *   node bin/dsh-skill-create.mjs --mode huawei --domain computing --product ecs --name ecs-manage \
 *        --summary "Manage ECS instances via KooCLI" --tags "huawei-cloud, ecs"
 *   node bin/dsh-skill-create.mjs --mode generic --name my-skill --summary "…" --refresh
 *
 * Flags: --mode huawei|generic  --name <suffix|full>  --domain --product --summary
 *        --techBase --capabilities --scenarios --tags  --refresh  --status
 */
import { CREATORS, buildHandoff, fetchCreator, kindOfMode, status } from '../src/core/creators.mjs';

const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i++) {
  const token = argv[i];
  if (!token.startsWith('--')) continue;
  const key = token.slice(2);
  const next = argv[i + 1];
  if (next && !next.startsWith('--')) { args[key] = next; i++; } else { args[key] = true; }
}

const kind = kindOfMode(args.mode || 'huawei');

if (args.status) {
  const current = status(kind);
  console.log(JSON.stringify(current, null, 2));
  process.exit(current.present ? 0 : 1);
}

const current = await fetchCreator(kind, { ...(args.refresh ? { refresh: true } : {}), log: (m) => console.error(`· ${m}`) });
if (!current.present) {
  console.error(`creator unavailable: ${current.error || 'not fetched'}`);
  process.exit(2);
}

const suffix = String(args.name || (kind === 'huawei' ? 'ecs-manage' : 'my-skill')).replace(/^huawei-cloud-/, '');
const name = kind === 'huawei' ? `huawei-cloud-${suffix}` : suffix;
const prompt = buildHandoff(kind, {
  name,
  domain: args.domain || (kind === 'huawei' ? 'computing' : ''),
  product: args.product || (kind === 'huawei' ? 'ecs' : ''),
  summary: args.summary || '',
  techBase: args.techBase || '',
  capabilities: args.capabilities || '',
  scenarios: args.scenarios || '',
  tags: args.tags || (kind === 'huawei' ? 'huawei-cloud, ecs' : ''),
  extra: args.extra || '',
});

console.error(`· creator ${current.skill} @ ${String(current.commit).slice(0, 8)} (${current.files.length} files, ${CREATORS[kind].branch})`);
console.log(prompt);
