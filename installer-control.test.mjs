import test from 'node:test';
import assert from 'node:assert/strict';
import { expandComposeVariables, parseComposeImages, parseDotEnv } from './installer-control.mjs';

test('parses installer .env without exposing comments', () => {
  assert.deepEqual(parseDotEnv('TAG=1.2.3\nexport API_TAG="2.0-dev.8" # note\n# SECRET=x\n'), {
    TAG: '1.2.3', API_TAG: '2.0-dev.8',
  });
});

test('expands compose variables and defaults', () => {
  assert.deepEqual(expandComposeVariables('registry/x:${TAG:-latest}', { TAG: '1.2.3' }), {
    value: 'registry/x:1.2.3', unresolved: [],
  });
  assert.deepEqual(expandComposeVariables('registry/x:${MISSING:-latest}', {}), {
    value: 'registry/x:latest', unresolved: [],
  });
});

test('marks unresolved image variables instead of silently inventing a tag', () => {
  const [service] = parseComposeImages('services:\n  api:\n    image: registry/x:${TAG}\n', 'home/api.yml');
  assert.equal(service.image, 'x');
  assert.equal(service.tag, '${TAG}');
  assert.deepEqual(service.unresolvedVariables, ['TAG']);
});
