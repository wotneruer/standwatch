import yaml from 'js-yaml';

const IMPORTANT_KEYS = new Set([
  'address', 'port', 'port_value', 'dns_refresh_rate', 'connect_timeout',
  'cluster', 'cluster_name', 'service_name', 'stat_prefix', 'lb_policy', 'type',
  'ports', 'volumes', 'environment', 'env_file', 'depends_on',
]);
const SECRET_KEY = /(?:password|passwd|token|secret|api[_-]?key|connectionstring|private[_-]?key)/i;
export const isSecretYamlPath = path => String(path || '').split('.').some(part => SECRET_KEY.test(part));

export function parseYaml(text) {
  const value = yaml.load(String(text || ''), { schema: yaml.JSON_SCHEMA, json: false });
  return value == null ? {} : value;
}

function itemLabel(value, index) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of ['name', 'cluster_name', 'service_name']) {
      if (typeof value[key] === 'string' && value[key]) return `[${key}=${value[key]}]`;
    }
    // Envoy route arrays are semantically keyed by their match, not position.
    // This prevents one inserted route from making every following route look changed.
    if (value.match && typeof value.match === 'object') {
      for (const key of ['path', 'prefix']) if (typeof value.match[key] === 'string') return `[match.${key}=${value.match[key]}]`;
      const regex = value.match.safe_regex?.regex;
      if (typeof regex === 'string') return `[match.safe_regex=${regex}]`;
    }
  }
  return `[${index}]`;
}

export function flattenYaml(value) {
  const rows = [];
  const walk = (node, path, inheritedImportant = false) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, path + itemLabel(item, index), inheritedImportant));
      if (!node.length) rows.push({ key: path, value: [], important: inheritedImportant });
      return;
    }
    if (node && typeof node === 'object') {
      const entries = Object.entries(node);
      if (!entries.length) rows.push({ key: path, value: {}, important: inheritedImportant });
      for (const [key, child] of entries) {
        const childPath = path ? `${path}.${key}` : key;
        walk(child, childPath, inheritedImportant || IMPORTANT_KEYS.has(key.toLowerCase()));
      }
      return;
    }
    const leaf = path.split('.').pop()?.replace(/\[[^\]]+\]$/, '') || '';
    rows.push({ key: path, value: node, important: inheritedImportant || IMPORTANT_KEYS.has(leaf.toLowerCase()) });
  };
  walk(value, '');
  return rows.filter(row => row.key);
}

const stable = value => JSON.stringify(value);
export function reconcileYaml(baselineText, installerText) {
  const baselineRows = flattenYaml(parseYaml(baselineText));
  const installerRows = flattenYaml(parseYaml(installerText));
  const baseline = new Map(baselineRows.map(row => [row.key, row]));
  const installer = new Map(installerRows.map(row => [row.key, row]));
  const keys = [...new Set([...baseline.keys(), ...installer.keys()])].sort();
  const rows = keys.map(key => {
    const left = baseline.get(key), right = installer.get(key);
    const status = !left ? 'installer-only' : !right ? 'baseline-only' : stable(left.value) === stable(right.value) ? 'same' : 'different';
    const secret = isSecretYamlPath(key);
    return { key, baseline: secret && left ? '••••••' : left?.value, installer: secret && right ? '••••••' : right?.value,
      status, important: !!(left?.important || right?.important), secret };
  });
  return {
    rows,
    summary: {
      same: rows.filter(row => row.status === 'same').length,
      different: rows.filter(row => row.status === 'different').length,
      baselineOnly: rows.filter(row => row.status === 'baseline-only').length,
      installerOnly: rows.filter(row => row.status === 'installer-only').length,
      importantChanges: rows.filter(row => row.important && row.status !== 'same').length,
    },
  };
}

export function redactYamlText(text) {
  return String(text || '').split(/\r?\n/).map(line => {
    const match = /^(\s*)([^#:\s][^:]*):(\s*)(.*)$/.exec(line);
    if (match && SECRET_KEY.test(match[2])) return `${match[1]}${match[2]}:${match[3]}••••••`;
    const assignment = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/.exec(line);
    if (assignment && SECRET_KEY.test(assignment[2])) return `${assignment[1]}${assignment[2]}${assignment[3]}••••••`;
    return line;
  }).join('\n');
}

// Line diff is intentionally bounded: Envoy files are moderate, but UI must never
// allocate an unbounded quadratic matrix for an accidental generated YAML.
function buildLineDiff(leftText, rightText, maxLines = 1200, maxOutput = 2400, redact = true) {
  const left = String(leftText || '').split(/\r?\n/).slice(0, maxLines);
  const right = String(rightText || '').split(/\r?\n/).slice(0, maxLines);
  const width = right.length + 1;
  const dp = new Uint16Array((left.length + 1) * width);
  for (let i = left.length - 1; i >= 0; i--) for (let j = right.length - 1; j >= 0; j--)
    dp[i * width + j] = left[i] === right[j] ? dp[(i + 1) * width + j + 1] + 1 : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
  const out = []; let i = 0, j = 0;
  while ((i < left.length || j < right.length) && out.length < maxOutput) {
    if (i < left.length && j < right.length && left[i] === right[j]) { out.push({ type: 'same', text: left[i] }); i++; j++; }
    else if (j < right.length && (i >= left.length || dp[i * width + j + 1] >= dp[(i + 1) * width + j])) { out.push({ type: 'add', text: right[j++] }); }
    else { out.push({ type: 'remove', text: left[i++] }); }
  }
  const lines = redact ? out.map(line => {
    const text = redactYamlText(line.text);
    return { ...line, text, redacted: text !== line.text };
  }) : out;
  return { lines, truncated: i < left.length || j < right.length || left.length >= maxLines || right.length >= maxLines };
}

export function lineDiff(leftText, rightText, maxLines = 1200, maxOutput = 2400) {
  return buildLineDiff(leftText, rightText, maxLines, maxOutput, true);
}

export function rawLineDiff(leftText, rightText, maxLines = 1200, maxOutput = 2400) {
  return buildLineDiff(leftText, rightText, maxLines, maxOutput, false);
}
