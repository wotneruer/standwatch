const posix = value => ('/' + String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')).replace(/\/{2,}/g, '/');

// Resolve impact from Docker mounts, never from a service/image naming guess.
// Directory mounts are supported: a file below the mounted source affects that
// container and maps to the corresponding destination path.
export function findAffectedContainers(containers, absolutePath) {
  const target = posix(absolutePath);
  const found = [];
  for (const container of Array.isArray(containers) ? containers : []) {
    for (const mount of Array.isArray(container?.Mounts) ? container.Mounts : []) {
      if (String(mount.Type || '').toLowerCase() !== 'bind') continue;
      const source = posix(mount.Source);
      if (target !== source && !target.startsWith(source + '/')) continue;
      const suffix = target.slice(source.length);
      found.push({
        name: String(container.Name || '').replace(/^\//, ''),
        service: String(container.Config?.Labels?.['com.docker.compose.service'] || ''),
        state: String(container.State?.Status || ''),
        restartCount: Number(container.RestartCount || 0),
        source,
        destination: posix(String(mount.Destination || '') + suffix),
        readWrite: mount.RW === true,
      });
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}
