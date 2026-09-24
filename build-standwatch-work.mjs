#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const RCC = join(ROOT, '..');
const BUILD = join(ROOT, '_build');
const EXE = join(ROOT, 'standwatch-server.new.exe');
mkdirSync(BUILD, { recursive: true });

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...options });
  if (result.status !== 0) process.exit(result.status || 1);
}

const esbuild = join(RCC, 'node_modules', 'esbuild', 'bin', 'esbuild');
const postject = join(RCC, 'node_modules', 'postject', 'dist', 'cli.js');
if (!existsSync(esbuild) || !existsSync(postject)) throw new Error('Build dependencies not found');

run('node', [esbuild, 'stand-panel.work.mjs', '--bundle', '--platform=node', '--format=cjs',
  '--outfile=_build/app.cjs',
  "--banner:js=const __importMetaUrl=require('url').pathToFileURL(__filename).href;",
  '--define:import.meta.url=__importMetaUrl']);

writeFileSync(join(BUILD, 'sea-config.json'), JSON.stringify({
  main: 'app.cjs', output: 'sea-prep.blob', disableExperimentalSEAWarning: true,
}));
run('node', ['--experimental-sea-config', 'sea-config.json'], { cwd: BUILD });

copyFileSync(process.execPath, EXE);
run('node', [postject, EXE, 'NODE_SEA_BLOB', join(BUILD, 'sea-prep.blob'),
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2']);

const buffer = readFileSync(EXE);
const peOffset = buffer.readUInt32LE(0x3C);
if (buffer.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') throw new Error('Not a PE executable');
const subsystemOffset = peOffset + 4 + 20 + 68;
if (buffer.readUInt16LE(subsystemOffset) === 3) {
  buffer.writeUInt16LE(2, subsystemOffset);
  writeFileSync(EXE, buffer);
}
console.log(`Built ${EXE}`);
