/**
 * Mini YAML frontmatter parser — subset sufficient for skill validation:
 *   - root mapping `key: value`
 *   - block scalar `key: |` with indented lines (description)
 *   - flow arrays `tags: [a, b]`
 *   - quoted scalars (single/double)
 * Throws on unparseable structure (stray colon, bad indentation, dangling quote).
 * NOTE: this is NOT a full YAML implementation; validator treats "not parseable
 * by this subset" as suspicious and falls back to strict checks it can prove.
 */

const FLOW_ARRAY_RE = /^\s*\[(.*)\]\s*$/;

export function splitFrontmatter(text) {
  if (!text.startsWith('---')) return { frontmatter: null, body: text };
  const lines = text.split(/\r?\n/);
  if (lines.length < 3) return { frontmatter: null, body: text };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { end = i; break; }
  }
  if (end === -1) return { frontmatter: null, body: text };
  const fm = lines.slice(1, end).join('\n');
  const body = lines.slice(end + 1).join('\n');
  return { frontmatter: fm, body };
}

export function parseFrontmatter(text) {
  const { frontmatter, body } = splitFrontmatter(text);
  if (frontmatter === null) {
    const err = new Error('frontmatter missing (no leading `---` or no closing `---`)');
    err.code = 'NO_FRONTMATTER';
    throw err;
  }
  const out = {};
  const lines = frontmatter.split('\n');
  let i = 0;
  let currentKey = null;
  let blockLines = null;
  const fail = (msg) => { const e = new Error(msg); e.code = 'YAML_PARSE'; throw e; };
  while (i < lines.length) {
    const line = lines[i];
    if (blockLines !== null) {
      if (/^\s*$/.test(line)) { blockLines.push(''); i++; continue; }
      if (/^[A-Za-z_][A-Za-z0-9_-]*:/.test(line) && /^[^\s]/.test(line)) {
        out[currentKey] = blockLines.join('\n').replace(/\n+$/, '');
        blockLines = null;
        continue; // reprocess as a new key
      }
      if (/^\s+/.test(line)) { blockLines.push(line.replace(/^\s{1,}/, '')); i++; continue; }
      fail(`bad indentation in block scalar for "${currentKey}" at line ${i + 1}`);
    }
    if (/^\s*#/.test(line) || /^\s*$/.test(line)) { i++; continue; }
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):(?:\s*(.*))?$/);
    if (!m) fail(`unparseable line ${i + 1}: ${JSON.stringify(line)} (stray colon? bad indent?)`);
    const [, key, rawVal] = m;
    currentKey = key;
    if (rawVal === undefined || rawVal.trim() === '') {
      blockLines = [];
      i++;
      continue;
    }
    const v = rawVal.trim();
    if (v === '|' || v === '|-' || v === '>') { blockLines = []; i++; continue; }
    if (v.startsWith('[')) {
      const fa = FLOW_ARRAY_RE.exec(v);
      if (!fa) fail(`unterminated flow array at line ${i + 1}`);
      out[key] = fa[1].split(',').map((s) => parseScalar(s.trim())).filter((x) => x !== '');
    } else {
      // plain scalars must not contain ': ' (YAML would reject it unquoted; URLs use ':' + '/' which is fine)
      if (/^\S/.test(v) && !/^['"]/.test(v) && /:\s/.test(v)) fail(`unquoted scalar cannot contain ": " at line ${i + 1}: ${JSON.stringify(v.slice(0, 40))}`);
      out[key] = parseScalar(v);
    }
    i++;
  }
  if (blockLines !== null) out[currentKey] = blockLines.join('\n').replace(/\n+$/, '');
  return { data: out, body };
}

function parseScalar(s) {
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) return s.slice(1, -1).replace(/\\"/g, '"');
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  return s;
}

export function parseFrontmatterLenient(text) {
  // returns {ok, data, body, error}
  try {
    const r = parseFrontmatter(text);
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, data: {}, body: null, error: e.message };
  }
}