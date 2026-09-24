#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WORKSPACE = dirname(ROOT);
const BUILD = join(ROOT, '_build');
const PAYLOAD_STAGE = join(BUILD, 'portable-payload');
const DESKTOP_OUT = join(BUILD, 'desktop-portable');
const LAUNCHER_OUT = join(BUILD, 'portable-launcher');
const PAYLOAD_ZIP = join(ROOT, 'PortableLauncher', 'payload.zip');
const DIST = join(WORKSPACE, 'dist');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const version = String(pkg.version || '').trim();

if (!/^[A-Za-z0-9._-]+$/.test(version)) throw new Error(`Unsafe package version: ${version}`);

function assertBuildPath(path) {
  const absolute = resolve(path);
  const buildRoot = resolve(BUILD) + '\\';
  if (!absolute.startsWith(buildRoot)) throw new Error(`Refusing to clean path outside build directory: ${absolute}`);
}

function resetDirectory(path) {
  assertBuildPath(path);
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', windowsHide: true, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const backend = join(ROOT, 'standwatch-server.new.exe');
if (!existsSync(backend)) throw new Error('Backend build missing. Run npm run build:backend first.');

resetDirectory(PAYLOAD_STAGE);
resetDirectory(DESKTOP_OUT);
resetDirectory(LAUNCHER_OUT);

run('dotnet', [
  'publish', 'DesktopHost/StandWatch.Desktop.csproj',
  '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true',
  '-p:PublishSingleFile=true', '-p:NuGetAudit=false', '-o', DESKTOP_OUT,
]);

for (const entry of readdirSync(DESKTOP_OUT, { withFileTypes: true })) {
  if (!entry.isFile() || entry.name.toLowerCase().endsWith('.pdb')) continue;
  copyFileSync(join(DESKTOP_OUT, entry.name), join(PAYLOAD_STAGE, entry.name));
}

copyFileSync(backend, join(PAYLOAD_STAGE, 'standwatch-server.exe'));
for (const name of ['standwatch-config-helper.sh', 'install-standwatch-config-helper.sh']) {
  copyFileSync(join(ROOT, name), join(PAYLOAD_STAGE, name));
}
copyFileSync(join(ROOT, 'README.md'), join(PAYLOAD_STAGE, 'README.md'));

rmSync(PAYLOAD_ZIP, { force: true });
const payloadFiles = readdirSync(PAYLOAD_STAGE).sort();
run('tar', ['-a', '-c', '-f', PAYLOAD_ZIP, ...payloadFiles], { cwd: PAYLOAD_STAGE });

run('dotnet', [
  'publish', 'PortableLauncher/StandWatch.Portable.csproj',
  '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true',
  '-p:PublishSingleFile=true', `-p:StandWatchPayloadVersion=${version}`,
  '-p:NuGetAudit=false', '-o', LAUNCHER_OUT,
]);

const launcher = join(LAUNCHER_OUT, 'StandWatch-Portable.exe');
if (!existsSync(launcher)) throw new Error(`Portable launcher missing: ${launcher}`);
mkdirSync(DIST, { recursive: true });
const artifact = join(DIST, `StandWatch-Portable-${version}.exe`);
copyFileSync(launcher, artifact);

const manifest = {
  schemaVersion: 1,
  version,
  createdAt: new Date().toISOString(),
  artifact: {
    file: artifact,
    bytes: statSync(artifact).size,
    sha256: sha256(artifact),
  },
  backend: {
    bytes: statSync(backend).size,
    sha256: sha256(backend),
  },
  payloadFiles: payloadFiles.map(name => ({ name, bytes: statSync(join(PAYLOAD_STAGE, name)).size })),
};
const manifestPath = join(DIST, `StandWatch-Portable-${version}.manifest.json`);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

console.log(`Portable artifact: ${artifact}`);
console.log(`SHA-256: ${manifest.artifact.sha256}`);
console.log(`Manifest: ${manifestPath}`);
