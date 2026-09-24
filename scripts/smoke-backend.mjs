#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { Script } from 'node:vm';

const exe = resolve(process.argv[2] || 'standwatch-server.new.exe');
if (!existsSync(exe)) throw new Error(`Backend executable not found: ${exe}`);

const freePort = await new Promise((resolvePort, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    probe.close(error => error ? reject(error) : resolvePort(port));
  });
});

const child = spawn(exe, ['--no-open', '--port', String(freePort)], {
  cwd: dirname(exe),
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
child.stdout.on('data', value => { stdout += value; });
child.stderr.on('data', value => { stderr += value; });

const base = `http://127.0.0.1:${freePort}`;
const deadline = Date.now() + 15_000;

async function waitUntilReady() {
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`Backend exited with ${child.exitCode}: ${stderr || stdout}`);
    try {
      const response = await fetch(`${base}/api/ping`);
      if (response.ok) {
        const ping = await response.json();
        if (ping.app !== 'standwatch') throw new Error(`Unexpected ping payload: ${JSON.stringify(ping)}`);
        return ping;
      }
    } catch (error) { lastError = error; }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error(`Backend readiness timeout: ${lastError?.message || stderr || stdout}`);
}

async function stop() {
  if (child.exitCode != null) return;
  try { await fetch(`${base}/api/quit`, { method: 'POST' }); } catch {}
  await Promise.race([
    new Promise(resolveExit => child.once('exit', resolveExit)),
    new Promise(resolveTimeout => setTimeout(resolveTimeout, 2_000)),
  ]);
  if (child.exitCode == null) child.kill();
}

try {
  const ping = await waitUntilReady();
  const response = await fetch(`${base}/`);
  if (!response.ok) throw new Error(`GET / returned HTTP ${response.status}`);
  const html = await response.text();
  if (!html.includes('StandWatch')) throw new Error('Rendered page does not contain StandWatch marker');

  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
  if (!scripts.length) throw new Error('Rendered page contains no inline browser script');
  scripts.forEach((source, index) => new Script(source, { filename: `standwatch-inline-${index + 1}.js` }));

  console.log(`Backend smoke passed: port=${freePort}, dataDir=${ping.dataDir}, inlineScripts=${scripts.length}`);
} finally {
  await stop();
}

