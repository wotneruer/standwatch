const uniq = values => [...new Set(values.filter(Boolean))];

function normalizedContainer(value) {
  return {
    name: String(value?.name || '').trim(),
    image: String(value?.image || '').trim(),
    imageId: String(value?.imageId || '').trim(),
    composeGroup: String(value?.composeGroup || '').trim(),
    workingDir: String(value?.workingDir || '').trim(),
    configFiles: Array.isArray(value?.configFiles) ? value.configFiles.map(String).filter(Boolean) : [],
    databaseCandidate: !!value?.databaseCandidate,
    mounts: Array.isArray(value?.mounts) ? value.mounts : [],
  };
}

const posix = value => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '');
function containersForConfigPath(containers, installRoot, relativePath) {
  const target = posix(`${posix(installRoot)}/${String(relativePath || '').replace(/^\/+/, '')}`);
  return containers.filter(container => container.mounts.some(mount => {
    if (String(mount?.type || '').toLowerCase() !== 'bind') return false;
    const source = posix(mount.source);
    return source && (target === source || target.startsWith(source + '/'));
  }));
}

/**
 * Pure, read-only rollout model. It intentionally does not generate a runnable
 * shell script: execution must later consume the approved plan and re-check
 * every gate against live state.
 */
export function buildContainerRolloutPlan({ group, installRoot, services = [], containers = [], scopeFiles = [], configFiles = [] }) {
  const serviceChanges = services.filter(item => item?.status === 'change');
  const unresolvedServices = services.filter(item => item?.status === 'unknown' || item?.status === 'unmanaged');
  const runtimeFileChanges = configFiles.filter(item => item?.policy !== 'ignored' && (item?.status === 'different' || item?.status === 'missing'));
  const groupContainers = containers.map(normalizedContainer).filter(item => item.name && item.composeGroup === group)
    .sort((a, b) => a.name.localeCompare(b.name));
  const composeChanges = runtimeFileChanges.filter(item => /^home\/.*\.ya?ml$/i.test(String(item.path || '')));
  const mountedConfigChanges = runtimeFileChanges.filter(item => /^volumes\/config\//i.test(String(item.path || '')));
  const scriptChanges = runtimeFileChanges.filter(item => /^scripts\/.*\.sh$/i.test(String(item.path || '')));
  const configImpact = mountedConfigChanges.map(item => {
    const affected = containersForConfigPath(groupContainers, installRoot, item.path);
    return { path: item.path, containers: affected.map(container => container.name) };
  });
  const unmappedConfigs = configImpact.filter(item => item.containers.length === 0).map(item => item.path);
  const configRestartNames = uniq(configImpact.flatMap(item => item.containers));
  const fullGroup = serviceChanges.length > 0 || composeChanges.length > 0;
  const selectedContainers = fullGroup ? groupContainers : groupContainers.filter(item => configRestartNames.includes(item.name));
  const triggers = [];
  if (serviceChanges.length) triggers.push({ kind: 'service-image-change', count: serviceChanges.length,
    items: serviceChanges.map(item => item.image).filter(Boolean) });
  if (runtimeFileChanges.length) triggers.push({ kind: 'runtime-file-change', count: runtimeFileChanges.length,
    items: runtimeFileChanges.map(item => item.path).filter(Boolean) });
  if (configRestartNames.length) triggers.push({ kind: 'mounted-config-restart', count: configRestartNames.length, items: configRestartNames });
  const required = fullGroup || configRestartNames.length > 0;
  const composeFiles = uniq([...scopeFiles.map(String), ...groupContainers.flatMap(container => container.configFiles)]);
  const rollbackWithoutImageId = fullGroup
    ? groupContainers.filter(item => !/^sha256:[0-9a-f]{64}$/i.test(item.imageId)).map(item => item.name) : [];
  const gates = {
    serviceMappingResolved: unresolvedServices.length === 0,
    composeScopePresent: composeFiles.length > 0,
    groupInventoryPresent: groupContainers.length > 0,
    configMountsResolved: unmappedConfigs.length === 0,
    rollbackImageIdsCaptured: !fullGroup || (groupContainers.length > 0 && rollbackWithoutImageId.length === 0),
  };
  const blockers = [];
  if (!gates.serviceMappingResolved) blockers.push(`невирішені сервіси: ${unresolvedServices.map(item => item.image).filter(Boolean).join(', ')}`);
  if (!gates.composeScopePresent) blockers.push('не зафіксовано compose-файли групи');
  if (!gates.groupInventoryPresent) blockers.push(`у preflight немає контейнерів compose-групи ${group}`);
  if (!gates.configMountsResolved) blockers.push(`конфіги не прив'язано до mount: ${unmappedConfigs.join(', ')}`);
  if (!gates.rollbackImageIdsCaptured) blockers.push(`не зафіксовано image ID для rollback: ${rollbackWithoutImageId.join(', ') || 'усі контейнери групи'}`);

  return {
    version: 1,
    mode: 'dry-run',
    policy: {
      scope: fullGroup ? 'full-compose-group' : required ? 'mounted-config-containers' : 'no-container-action',
      forceRecreateAll: fullGroup,
      restartMountedConfigContainers: true,
      group,
      installRoot,
      rationale: fullGroup
        ? 'Зміна image/tag або Compose-моделі може зачепити залежності, тому rollout охоплює всю compose-групу.'
        : 'Змінені bind-mounted конфіги застосовуються без зміни image, але відповідні контейнери перезапускаються, щоб гарантовано перечитати конфіг.',
    },
    required,
    triggers,
    composeFiles,
    changedServices: serviceChanges.map(item => ({ image: item.image, current: item.current || null, target: item.target || null })),
    configImpact: configImpact.map(item => ({ ...item, provisional: true })),
    scriptChanges: scriptChanges.map(item => item.path),
    scope: {
      containerCount: selectedContainers.length,
      containers: selectedContainers,
      allGroupContainerCount: groupContainers.length,
      excludedContainers: containers.map(normalizedContainer).filter(item => item.name && item.composeGroup !== group)
        .map(item => ({ name: item.name, composeGroup: item.composeGroup || null })),
    },
    gates,
    blockers,
    readyForExecutionImplementation: required && blockers.length === 0,
    phases: required ? [
      { id: 'live-preflight', mutating: false, title: 'Повторно перевірити live inventory, compose scope, tags та image IDs' },
      { id: 'recovery-gate', mutating: false, title: 'Перевірити verified restore point і файловий T2 rollback' },
      ...(fullGroup ? [{ id: 'protect-images', mutating: true, title: 'Зафіксувати захисні rollback-теги на поточні image IDs усієї групи' }] : []),
      { id: 'apply-files', mutating: true, title: 'Застосувати погоджений файловий пакет' },
      ...(fullGroup ? [
        { id: 'pull-images', mutating: true, title: 'Завантажити всі цільові образи compose-групи' },
        { id: 'recreate-group', mutating: true, title: 'Однією Compose-моделлю force-recreate усіх контейнерів групи' },
      ] : [{ id: 'restart-config-containers', mutating: true, title: 'Перезапустити контейнери, що монтують змінені конфіги' }]),
      { id: 'health', mutating: false, title: 'Дочекатися running/healthy для кожного контейнера та виконати application checks' },
      { id: 'commit', mutating: false, title: 'Зафіксувати result, фактичні image IDs і checksum файлів' },
    ] : [],
    rollbackPhases: required ? [
      { id: 'restore-files', title: 'Повернути файловий пакет із T2' },
      ...(fullGroup ? [
        { id: 'restore-images', title: 'Повернути image refs на захищені попередні image IDs' },
        { id: 'recreate-group', title: 'Повторно force-recreate всю compose-групу' },
      ] : [{ id: 'restart-config-containers', title: 'Ще раз перезапустити контейнери після повернення конфігів' }]),
      { id: 'verify', title: 'Перевірити running/healthy, application checks і checksum' },
    ] : [],
  };
}
