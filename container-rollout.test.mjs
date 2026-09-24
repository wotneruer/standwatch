import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContainerRolloutPlan } from './container-rollout.mjs';

const imageId = suffix => `sha256:${suffix.repeat(64).slice(0, 64)}`;

test('one service change expands rollout to the entire compose group', () => {
  const result = buildContainerRolloutPlan({
    group: 'rscore', installRoot: '/usr/local/rscore', scopeFiles: ['home/01.yml', 'home/02.yml'],
    services: [{ image: 'vpo-service', current: '1.0', target: '1.1', status: 'change' },
      { image: 'user-service', current: '2.0', target: '2.0', status: 'same' }],
    containers: [
      { name: 'vpo-service', composeGroup: 'rscore', image: 'repo/vpo-service:1.0', imageId: imageId('a'),
        configFiles: ['/usr/local/rscore/home/02.yml'] },
      { name: 'user-service', composeGroup: 'rscore', image: 'repo/user-service:2.0', imageId: imageId('b'),
        configFiles: ['/usr/local/rscore/home/01_infrastructure.yml'] },
      { name: 'database', composeGroup: 'database', image: 'postgres:14', imageId: imageId('c') },
    ],
  });
  assert.equal(result.required, true);
  assert.equal(result.policy.scope, 'full-compose-group');
  assert.equal(result.policy.forceRecreateAll, true);
  assert.deepEqual(result.scope.containers.map(item => item.name), ['user-service', 'vpo-service']);
  assert.deepEqual(result.scope.excludedContainers, [{ name: 'database', composeGroup: 'database' }]);
  assert.deepEqual(result.composeFiles, ['home/01.yml', 'home/02.yml', '/usr/local/rscore/home/01_infrastructure.yml', '/usr/local/rscore/home/02.yml']);
  assert.equal(result.readyForExecutionImplementation, true);
});

test('runtime file change restarts every container that mounts it', () => {
  const result = buildContainerRolloutPlan({ group: 'rscore', installRoot: '/usr/local/rscore', scopeFiles: ['home/02.yml'],
    services: [{ image: 'svc', current: '1', target: '1', status: 'same' }],
    configFiles: [{ path: 'volumes/config/svc/appsettings.json', status: 'different' }],
    containers: [{ name: 'svc', composeGroup: 'rscore', imageId: imageId('d'), mounts: [
      { type: 'bind', source: '/usr/local/rscore/volumes/config/svc', destination: '/app/config' },
    ] }],
  });
  assert.equal(result.required, true);
  assert.equal(result.triggers[0].kind, 'runtime-file-change');
  assert.equal(result.scope.containerCount, 1);
  assert.equal(result.policy.scope, 'mounted-config-containers');
  assert.equal(result.policy.forceRecreateAll, false);
  assert.equal(result.phases.some(item => item.id === 'restart-config-containers'), true);
});

test('compose file change recreates the whole group even when image tags are unchanged', () => {
  const result = buildContainerRolloutPlan({ group: 'rscore', installRoot: '/usr/local/rscore', scopeFiles: ['home/02.yml'],
    services: [{ image: 'svc', current: '1', target: '1', status: 'same' }],
    configFiles: [{ path: 'home/02_platform.yml', status: 'different' }],
    containers: [
      { name: 'svc', composeGroup: 'rscore', imageId: imageId('1') },
      { name: 'gateway', composeGroup: 'rscore', imageId: imageId('2') },
    ],
  });
  assert.equal(result.policy.scope, 'full-compose-group');
  assert.equal(result.scope.containerCount, 2);
});

test('changed mounted config blocks rollout when no container mount owns it', () => {
  const result = buildContainerRolloutPlan({ group: 'rscore', installRoot: '/usr/local/rscore', scopeFiles: ['home/02.yml'],
    configFiles: [{ path: 'volumes/config/missing/appsettings.json', status: 'different' }],
    containers: [{ name: 'svc', composeGroup: 'rscore', imageId: imageId('3'), mounts: [] }],
  });
  assert.equal(result.required, false);
  assert.equal(result.gates.configMountsResolved, false);
  assert.match(result.blockers.join('\n'), /missing\/appsettings/);
});

test('rollout remains blocked when mappings or rollback image IDs are incomplete', () => {
  const result = buildContainerRolloutPlan({ group: 'rscore', installRoot: '/usr/local/rscore', scopeFiles: ['home/02.yml'],
    services: [{ image: 'missing-service', status: 'unknown' }, { image: 'svc', current: '1', target: '2', status: 'change' }],
    containers: [{ name: 'svc', composeGroup: 'rscore', image: 'repo/svc:1' }],
  });
  assert.equal(result.readyForExecutionImplementation, false);
  assert.equal(result.gates.serviceMappingResolved, false);
  assert.equal(result.gates.rollbackImageIdsCaptured, false);
  assert.match(result.blockers.join('\n'), /missing-service/);
  assert.match(result.blockers.join('\n'), /svc/);
});

test('no image or runtime file changes means no container rollout', () => {
  const result = buildContainerRolloutPlan({ group: 'rscore', installRoot: '/usr/local/rscore', scopeFiles: ['home/02.yml'],
    services: [{ image: 'svc', current: '1', target: '1', status: 'same' }],
    configFiles: [{ path: 'home/02.yml', status: 'same' }],
    containers: [{ name: 'svc', composeGroup: 'rscore', imageId: imageId('e') }],
  });
  assert.equal(result.required, false);
  assert.deepEqual(result.phases, []);
});
