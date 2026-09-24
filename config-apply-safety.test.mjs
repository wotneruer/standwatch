import test from 'node:test';
import assert from 'node:assert/strict';
import { findAffectedContainers } from './config-apply-safety.mjs';

test('findAffectedContainers resolves exact file bind by mount, not name', () => {
  const containers = [{ Name: '/odd-name', RestartCount: 2, State: { Status: 'running' }, Config: { Labels: { 'com.docker.compose.service': 'vpo-service' } },
    Mounts: [{ Type: 'bind', Source: '/usr/local/rscore/volumes/config/vpo-service/appsettings.json', Destination: '/app/appsettings.json', RW: true }] }];
  assert.deepEqual(findAffectedContainers(containers, '/usr/local/rscore/volumes/config/vpo-service/appsettings.json'), [{
    name: 'odd-name', service: 'vpo-service', state: 'running', restartCount: 2,
    source: '/usr/local/rscore/volumes/config/vpo-service/appsettings.json', destination: '/app/appsettings.json', readWrite: true,
  }]);
});

test('findAffectedContainers maps files below a directory bind and ignores volumes', () => {
  const containers = [{ Name: '/svc', State: { Status: 'running' }, Config: { Labels: {} }, Mounts: [
    { Type: 'bind', Source: '/usr/local/rscore/volumes/config', Destination: '/app/config', RW: false },
    { Type: 'volume', Source: '/var/lib/docker/volumes/x', Destination: '/data', RW: true },
  ] }];
  const result = findAffectedContainers(containers, '/usr/local/rscore/volumes/config/a/settings.json');
  assert.equal(result[0].destination, '/app/config/a/settings.json');
  assert.equal(result[0].readWrite, false);
});
