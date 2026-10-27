const { DatabaseSync } = require('node:sqlite');
const { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } = require('node:fs');
const { basename, dirname, join } = require('node:path');

const backupName = /^rin-\d{4}-\d{2}-\d{2}\.sqlite$/;
const backupDir = dataPath => join(dirname(dataPath), 'backups');

function checkDatabase(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare('PRAGMA quick_check').get().quick_check === 'ok'; }
  finally { db.close(); }
}

exports.listBackups = dataPath => {
  const directory = backupDir(dataPath);
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter(name => backupName.test(name)).sort().reverse().map(name => {
    const path = join(directory, name);
    let valid = false;
    try { valid = checkDatabase(path); } catch {}
    return { name, date: name.slice(4, 14), size: statSync(path).size, valid };
  });
};

exports.restoreBackup = (dataPath, name, now = new Date()) => {
  if (!backupName.test(name) || basename(name) !== name) throw new Error('올바른 아사 백업 파일이 아닙니다.');
  const source = join(backupDir(dataPath), name);
  let sourceValid = false;
  try { sourceValid = existsSync(source) && checkDatabase(source); } catch {}
  if (!sourceValid) throw new Error('백업 파일이 손상되었거나 읽을 수 없습니다.');
  mkdirSync(backupDir(dataPath), { recursive: true });
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const safety = join(backupDir(dataPath), `rin-before-restore-${stamp}.sqlite`);
  if (existsSync(dataPath)) copyFileSync(dataPath, safety);
  try {
    copyFileSync(source, dataPath);
    if (!checkDatabase(dataPath)) throw new Error('복원한 데이터의 무결성 검사에 실패했습니다.');
  } catch (error) {
    if (existsSync(safety)) copyFileSync(safety, dataPath);
    throw error;
  }
  return { restored: name, safety: basename(safety) };
};

exports.rollbackRestore = (dataPath, name) => {
  if (!/^rin-before-restore-\d{8}T\d{6}Z\.sqlite$/.test(name) || basename(name) !== name) throw new Error('올바른 복원 안전 백업이 아닙니다.');
  const source = join(backupDir(dataPath), name);
  if (!existsSync(source) || !checkDatabase(source)) throw new Error('복원 전 안전 백업을 읽을 수 없습니다.');
  copyFileSync(source, dataPath);
  return checkDatabase(dataPath);
};
