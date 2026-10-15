/**
 * dsh-install — convenience installer equivalent to the in-app
 * `plugin_manager install_bundle` (DeepSeek Harness cordis-plugin-development
 * contract): copies this bundle as a REAL package dir into the profile's
 * node_modules (profile-installed bundles live there) and selects it in the
 * profile's dsh.profile.bundles. Idempotent.
 *
 * PREFERRED PATH: inside the running Harness, ask the agent to
 * `plugin_manager install_bundle` with target = this package directory
 * (D:\dsh-skill-creator) — the app performs the same steps in its own
 * approval flow. This script is the CLI shortcut for the same operation.
 *
 * Usage: node src/core/dsh-install.mjs [--dsh-home <path>] [--no-copy]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF_NAME = '@cloudplugin/dsh-skill-creator';
const SELF_DIR = fileURLToPath(new URL('../..', import.meta.url)); // package root

function findDshHome(cli) {
  if (cli) return cli;
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  const cand = path.join(os.homedir(), '.dsh');
  return fs.existsSync(cand) ? cand : null;
}

/** Discover real profile dirs (this build of DSH uses e.g. "desktop"). */
function discoverProfiles(dshHome) {
  const profilesDir = path.join(dshHome, 'profiles');
  if (!fs.existsSync(profilesDir)) return [];
  const out = [];
  for (const e of fs.readdirSync(profilesDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const mf = path.join(profilesDir, e.name, 'package.json');
    try {
      const pkg = JSON.parse(fs.readFileSync(mf, 'utf8'));
      if (pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles)) {
        out.push({ name: e.name, dir: path.join(profilesDir, e.name), packageJson: mf, pkg });
      }
    } catch { /* not a dsh profile */ }
  }
  return out;
}

function copyBundle(target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(SELF_DIR, target, {
    recursive: true,
    filter: (src) => {
      const rel = src.replace(SELF_DIR, '').replace(/\\/g, '/');
      if (!rel || rel === '/') return true;
      if (/^\/(node_modules|\.git|test|tmp)\//.test(rel)) return false;
      if (/\/(node_modules|\.git)\//.test(rel)) return false;
      return true;
    },
  });
}

export function installBundles(dshHome, { copy = true } = {}) {
  if (!dshHome) return { installed: false, reason: 'DeepSeek Harness not found (no $DSH_HOME / ~/.dsh)' };
  const profiles = discoverProfiles(dshHome);
  if (!profiles.length) return { installed: false, dshHome, reason: `no dsh profiles under ${dshHome}/profiles` };
  const results = [];
  for (const prof of profiles) {
    const target = path.join(prof.dir, 'node_modules', '@cloudplugin', 'dsh-skill-creator');
    let status = 'ok';
    if (copy) {
      try { if (fs.lstatSync(target).isSymbolicLink()) fs.rmSync(target, { force: true }); } catch { /* absent */ }
      copyBundle(target);
    } else {
      status = fs.existsSync(target) ? 'ok (exists)' : 'missing';
    }
    const bundles = prof.pkg.dsh.profile.bundles;
    if (!bundles.includes(SELF_NAME)) {
      bundles.push(SELF_NAME);
      fs.writeFileSync(prof.packageJson, `${JSON.stringify(prof.pkg, null, 2)}\n`, 'utf8');
    }
    results.push({ profile: prof.name, status, bundle: SELF_NAME, nodeModules: target });
  }
  return { installed: true, dshHome, results };
}

// CLI entry (self-run only)
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const idx = process.argv.indexOf('--dsh-home');
  const noCopy = process.argv.includes('--no-copy');
  const r = installBundles(findDshHome(idx >= 0 ? process.argv[idx + 1] : null), { copy: !noCopy });
  console.log(JSON.stringify(r, null, 2));
  if (!r.installed) console.log(`ℹ 未找到可安装的 DSH profile。工厂路径：让 Harness 里的 agent 执行 plugin_manager install_bundle（target=${SELF_DIR}）。`);
}