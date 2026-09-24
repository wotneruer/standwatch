import test from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml, flattenYaml, reconcileYaml, redactYamlText, lineDiff } from './yaml-reconcile.mjs';

test('YAML parser preserves URL and names array items', () => {
  const value = parseYaml('clusters:\n  - name: api\n    address: http://host:8080\n');
  const rows = flattenYaml(value);
  assert.equal(rows.find(row => row.key === 'clusters[name=api].address').value, 'http://host:8080');
});

test('Envoy reconcile marks named port and dns changes important', () => {
  const result = reconcileYaml('clusters:\n- name: api\n  dns_refresh_rate: 5s\n  port_value: 80\n', 'clusters:\n- name: api\n  dns_refresh_rate: 10s\n  port_value: 8080\n');
  assert.equal(result.summary.importantChanges, 2);
  assert.equal(result.rows.find(row => row.key.endsWith('port_value')).status, 'different');
});

test('Envoy routes are matched by prefix instead of array position', () => {
  const before = 'routes:\n- match: { prefix: /a }\n  route: { cluster: a }\n- match: { prefix: /b }\n  route: { cluster: b }\n';
  const after = 'routes:\n- match: { prefix: /new }\n  route: { cluster: n }\n- match: { prefix: /a }\n  route: { cluster: a }\n- match: { prefix: /b }\n  route: { cluster: b }\n';
  const result = reconcileYaml(before, after);
  assert.equal(result.rows.filter(row => row.status === 'different').length, 0);
  assert.ok(result.rows.some(row => row.key.includes('[match.prefix=/new]') && row.status === 'installer-only'));
});

test('text diff redacts secret-like YAML values', () => {
  assert.match(redactYamlText('password: hello\naddress: host'), /password: ••••••/);
  assert.match(redactYamlText('export API_TOKEN=hello'), /API_TOKEN=••••••/);
  const diff = lineDiff('token: old', 'token: new');
  assert.doesNotMatch(JSON.stringify(diff), /old|new/);
  assert.ok(diff.lines.filter(line => line.type !== 'same').every(line => line.redacted));
});

test('structured YAML rows never expose secret-like values', () => {
  const result = reconcileYaml('api_token: old-secret', 'api_token: new-secret');
  assert.equal(result.rows[0].baseline, '••••••');
  assert.equal(result.rows[0].installer, '••••••');
  assert.equal(result.rows[0].secret, true);
});
