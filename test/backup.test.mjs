import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../app/store.mjs';
const { listBackups, restoreBackup, rollbackRestore } = createRequire(import.meta.url)('../desktop/backup.cjs');

test('backs up an existing database before reopening it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rin-backup-'));
  const path = join(dir, 'rin.sqlite');
  try {
    const first = new Store(path);
    first.saveClass({ name: '백업 확인 수업', day: 1, start: '09:00', end: '10:00', location: '' });
    first.close();

    const second = new Store(path);
    second.close();
    const backups = readdirSync(join(dir, 'backups')).filter(name => name.endsWith('.sqlite'));
    assert.equal(backups.length, 1);
    const backupPath = join(dir, 'backups', backups[0]);
    assert.equal(existsSync(backupPath), true);
    const backup = new DatabaseSync(backupPath, { readOnly: true });
    assert.equal(backup.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    assert.equal(backup.prepare('SELECT name FROM class_sessions').get().name, '백업 확인 수업');
    backup.close();
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('lists valid backups and restores with a safety copy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rin-restore-'));
  const path = join(dir, 'rin.sqlite');
  try {
    const original = new Store(path);
    original.saveClass({ name: '복원할 수업', day: 1, start: '09:00', end: '10:00', location: '' });
    original.close();
    const backedUp = new Store(path); backedUp.close();
    const changed = new Store(path);
    changed.saveClass({ name: '복원 뒤 사라질 수업', day: 2, start: '11:00', end: '12:00', location: '' });
    changed.close();
    const backup = listBackups(path)[0];
    assert.equal(backup.valid, true);
    const result = restoreBackup(path, backup.name, new Date('2026-09-19T01:02:03Z'));
    assert.match(result.safety, /^rin-before-restore-/);
    const restored = new DatabaseSync(path, { readOnly: true });
    assert.deepEqual(restored.prepare('SELECT name FROM class_sessions ORDER BY name').all().map(row => row.name), ['복원할 수업']);
    restored.close();
    assert.equal(readdirSync(join(dir, 'backups')).includes(result.safety), true);
    assert.equal(rollbackRestore(path, result.safety), true);
    const rolledBack = new DatabaseSync(path, { readOnly: true });
    assert.deepEqual(rolledBack.prepare('SELECT name FROM class_sessions ORDER BY name').all().map(row => row.name), ['복원 뒤 사라질 수업', '복원할 수업']);
    rolledBack.close();
  } finally { rmSync(dir, { recursive: true }); }
});

test('rejects a corrupted backup before replacing current data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rin-corrupt-'));
  const path = join(dir, 'rin.sqlite');
  try {
    const store = new Store(path); store.close();
    const reopened = new Store(path); reopened.close();
    const corrupt = join(dir, 'backups', 'rin-2026-09-18.sqlite');
    writeFileSync(corrupt, 'not a sqlite database');
    assert.equal(listBackups(path).find(item => item.name === 'rin-2026-09-18.sqlite').valid, false);
    assert.throws(() => restoreBackup(path, 'rin-2026-09-18.sqlite'), /손상/);
  } finally { rmSync(dir, { recursive: true }); }
});
