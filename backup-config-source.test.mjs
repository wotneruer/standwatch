import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeBackupEntry, resolveVerifiedConfigBackup } from './backup-config-source.mjs';

test('normalizeBackupEntry accepts relative paths and rejects traversal', () => {
  assert.equal(normalizeBackupEntry('volumes\\config\\vpo-service\\appsettings.json'), 'volumes/config/vpo-service/appsettings.json');
  for (const value of ['', '../secret', 'home/../../secret', '/etc/passwd', 'C:/secret', 'x\nfile']) {
    assert.throws(() => normalizeBackupEntry(value));
  }
});

test('resolveVerifiedConfigBackup selects newest matching verified installer backup', () => {
  const root = mkdtempSync(join(tmpdir(), 'standwatch-backup-source-'));
  const plansDir = join(root, 'plans'), backupsDir = join(root, 'backups');
  mkdirSync(plansDir); mkdirSync(backupsDir);
  const add = ({ id, ref, commit, createdAt, bytes = 3, status = 'verified' }) => {
    const directory = join(backupsDir, id); mkdirSync(directory);
    writeFileSync(join(directory, 'stand-files.tar.gz'), 'abc');
    writeFileSync(join(plansDir, id + '.json'), JSON.stringify({ server: 'Poruch QA', group: 'rscore', createdAt, backup: { status } }));
    writeFileSync(join(directory, 'restore-point.json'), JSON.stringify({
      status, planId: id, server: 'Poruch QA', group: 'rscore', createdAt,
      target: { project: 'vpo/installer', ref, commit: { id: commit, shortId: commit.slice(0, 8) } },
      artifacts: [{ kind: 'stand-files', name: 'stand-files.tar.gz', bytes, verified: true }],
    }));
  };
  add({ id: 'old', ref: '1.7.3', commit: 'f7925511aaaaaaaa', createdAt: '2026-09-16T10:00:00Z' });
  add({ id: 'new', ref: '1.7.3', commit: 'f7925511bbbbbbbb', createdAt: '2026-09-16T11:00:00Z' });
  add({ id: 'other', ref: '1.7.2', commit: 'f3899ec2cccccccc', createdAt: '2026-09-16T12:00:00Z' });
  const found = resolveVerifiedConfigBackup({ plansDir, backupsDir, serverName: 'Poruch QA', group: 'rscore', binding: { project: 'vpo/installer', ref: '1.7.3' } });
  assert.equal(found.id, 'new');
});
