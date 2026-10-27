import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { nextRecurringDue, projectRecurringItem, recurrenceType, recurrenceTypes, repeats, sameRecurrenceRule, validDateKey, withinRepeatEnd } from './schedule-intent.mjs';

const localDateKey = date => {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

export function backupDatabase(path, { now = new Date(), keep = 14 } = {}) {
  if (!existsSync(path) || statSync(path).size === 0) return null;
  const backupDir = join(dirname(path), 'backups');
  mkdirSync(backupDir, { recursive: true });
  const target = join(backupDir, `rin-${localDateKey(now)}.sqlite`);
  if (!existsSync(target)) copyFileSync(path, target);
  const backups = readdirSync(backupDir)
    .filter(name => /^rin-\d{4}-\d{2}-\d{2}\.sqlite$/.test(name))
    .sort()
    .reverse();
  for (const name of backups.slice(Math.max(1, keep))) unlinkSync(join(backupDir, name));
  return target;
}

const DEFAULT_SETTINGS = {
  name: '', teasing: 3, characterMotion: true, model: 'codex',
  notifications: true, quietModeEnabled: true, quietStart: '01:00', quietEnd: '07:00',
  gameNagging: true, gameNagMinutes: 15, dailyBriefing: true,
  casualNotifications: true, notificationVolume: 70,
  activityTracking: true, breakMinutes: 50,
  healthCheckReminder: false, healthCheckUsageMinutes: 180,
  eveningReview: true, eveningReviewUsageMinutes: 360
};

export class Store {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true });
    backupDatabase(path);
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, role TEXT NOT NULL, content TEXT NOT NULL,
        created TEXT NOT NULL, feedback TEXT NOT NULL DEFAULT '', feedback_reason TEXT NOT NULL DEFAULT '', context INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY NOT NULL, content TEXT NOT NULL, created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS class_sessions (
        id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, day INTEGER NOT NULL,
        start TEXT NOT NULL, end TEXT NOT NULL, location TEXT NOT NULL DEFAULT '', created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS academic_items (
        id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, course TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL, due TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
        completed INTEGER NOT NULL DEFAULT 0, completed_at TEXT, created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS academic_sources (
        item_id TEXT PRIMARY KEY NOT NULL REFERENCES academic_items(id) ON DELETE CASCADE,
        provider TEXT NOT NULL, external_id TEXT NOT NULL, source_url TEXT NOT NULL,
        last_seen TEXT NOT NULL, missing_since TEXT, missing_ignored INTEGER NOT NULL DEFAULT 0,
        UNIQUE(provider, external_id));
      CREATE TABLE IF NOT EXISTS academic_exceptions (
        item_id TEXT NOT NULL REFERENCES academic_items(id) ON DELETE CASCADE,
        original_due TEXT NOT NULL, due TEXT NOT NULL, cancelled INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(item_id,original_due));
      CREATE TABLE IF NOT EXISTS integrations (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notification_log (key TEXT PRIMARY KEY NOT NULL, sent TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS missed_notifications (
        id TEXT PRIMARY KEY NOT NULL, key TEXT NOT NULL, title TEXT NOT NULL,
        body TEXT NOT NULL, created TEXT NOT NULL, UNIQUE(key));
      CREATE TABLE IF NOT EXISTS routines (
        id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, category TEXT NOT NULL,
        days TEXT NOT NULL, time TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
        active INTEGER NOT NULL DEFAULT 1, created TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS routine_logs (
        routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
        date TEXT NOT NULL, completed_at TEXT NOT NULL, PRIMARY KEY(routine_id,date)
      );
      CREATE TABLE IF NOT EXISTS activity_usage (
        date TEXT NOT NULL, app TEXT NOT NULL, category TEXT NOT NULL,
        seconds INTEGER NOT NULL DEFAULT 0, updated TEXT NOT NULL,
        PRIMARY KEY(date,app,category)
      );
      CREATE TABLE IF NOT EXISTS health_entries (
        date TEXT PRIMARY KEY NOT NULL, sleep_minutes INTEGER NOT NULL,
        meals INTEGER NOT NULL, water INTEGER NOT NULL, exercise_minutes INTEGER NOT NULL,
        energy INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '', updated TEXT NOT NULL
      );
    `);
    if (!this.db.prepare('PRAGMA table_info(messages)').all().some(column => column.name === 'feedback_reason')) {
      this.db.exec("ALTER TABLE messages ADD COLUMN feedback_reason TEXT NOT NULL DEFAULT ''");
    }
    if (!this.db.prepare('PRAGMA table_info(messages)').all().some(column => column.name === 'schedule_action')) {
      this.db.exec("ALTER TABLE messages ADD COLUMN schedule_action TEXT NOT NULL DEFAULT ''");
    }
    if (!this.db.prepare('PRAGMA table_info(academic_items)').all().some(column => column.name === 'completed_at')) {
      this.db.exec('ALTER TABLE academic_items ADD COLUMN completed_at TEXT');
    }
    if (!this.db.prepare('PRAGMA table_info(memories)').all().some(column => column.name === 'source')) {
      this.db.exec("ALTER TABLE memories ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'");
    }
    const academicColumns = this.db.prepare('PRAGMA table_info(academic_items)').all();
    if (!academicColumns.some(column => column.name === 'cancelled_at')) this.db.exec('ALTER TABLE academic_items ADD COLUMN cancelled_at TEXT');
    if (!academicColumns.some(column => column.name === 'manual_override')) this.db.exec('ALTER TABLE academic_items ADD COLUMN manual_override INTEGER NOT NULL DEFAULT 0');
    if (!academicColumns.some(column => column.name === 'repeat_weekly')) this.db.exec('ALTER TABLE academic_items ADD COLUMN repeat_weekly INTEGER NOT NULL DEFAULT 0');
    if (!academicColumns.some(column => column.name === 'recurrence')) this.db.exec("ALTER TABLE academic_items ADD COLUMN recurrence TEXT NOT NULL DEFAULT 'none'; UPDATE academic_items SET recurrence='weekly' WHERE repeat_weekly=1");
    if (!academicColumns.some(column => column.name === 'monthly_day')) this.db.exec('ALTER TABLE academic_items ADD COLUMN monthly_day INTEGER NOT NULL DEFAULT 0');
    if (!academicColumns.some(column => column.name === 'repeat_until')) this.db.exec('ALTER TABLE academic_items ADD COLUMN repeat_until TEXT');
    const sourceColumns = this.db.prepare('PRAGMA table_info(academic_sources)').all();
    if (!sourceColumns.some(column => column.name === 'missing_since')) this.db.exec('ALTER TABLE academic_sources ADD COLUMN missing_since TEXT');
    if (!sourceColumns.some(column => column.name === 'missing_ignored')) this.db.exec('ALTER TABLE academic_sources ADD COLUMN missing_ignored INTEGER NOT NULL DEFAULT 0');
    this.db.exec(`
      INSERT INTO activity_usage (date,app,category,seconds,updated)
      SELECT date,app,'game',seconds,updated FROM activity_usage
      WHERE lower(app)='nikke' AND category='other'
      ON CONFLICT(date,app,category) DO UPDATE SET
        seconds=activity_usage.seconds+excluded.seconds,updated=excluded.updated;
      DELETE FROM activity_usage WHERE lower(app)='nikke' AND category='other';
    `);
    this.db.prepare('INSERT OR IGNORE INTO settings VALUES (1, ?)').run(JSON.stringify(DEFAULT_SETTINGS));
    if ((this.integration('persona_migration')?.version || 0) < 2) {
      this.db.exec('BEGIN');
      try {
        const settings = this.settings();
        this.saveSettings({ ...settings, characterMotion: typeof settings.characterMotion === 'boolean' ? settings.characterMotion : true });
        // Preserve the visible archive and memories; only retire the previous persona's model context.
        this.db.exec('UPDATE messages SET context=0');
        this.saveIntegration('persona_migration', { version: 2, character: 'ASA', persona: 'asa-fan' });
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    this.db.prepare("DELETE FROM notification_log WHERE sent < datetime('now','-90 days')").run();
    this.db.prepare("DELETE FROM missed_notifications WHERE created < datetime('now','-30 days')").run();
    this.db.prepare("DELETE FROM activity_usage WHERE date < date('now','localtime','-90 days')").run();
    for (const row of this.db.prepare('SELECT rowid FROM memories WHERE id IS NULL').all()) {
      this.db.prepare('UPDATE memories SET id=? WHERE rowid=?').run(randomUUID(), row.rowid);
    }
  }
  settings() { return { ...DEFAULT_SETTINGS, ...JSON.parse(this.db.prepare('SELECT value FROM settings WHERE id=1').get().value) }; }
  saveSettings({ tsundere, ...value }) { this.db.prepare('UPDATE settings SET value=? WHERE id=1').run(JSON.stringify(value)); }
  messages() { return this.db.prepare('SELECT * FROM messages ORDER BY rowid').all().map(row => ({ ...row, schedule_action: row.schedule_action ? JSON.parse(row.schedule_action) : null })); }
  context() { return this.db.prepare(`SELECT role,content FROM (
      SELECT m.rowid,m.role,m.content FROM messages m
      WHERE m.context=1
        AND NOT (m.role='assistant' AND m.feedback='awkward')
        AND NOT (m.role='user' AND COALESCE((
          SELECT a.feedback FROM messages a WHERE a.rowid>m.rowid ORDER BY a.rowid LIMIT 1
        ), '')='awkward')
      ORDER BY m.rowid DESC LIMIT 48
    ) ORDER BY rowid`).all(); }
  memories() { return this.db.prepare('SELECT * FROM memories ORDER BY rowid DESC').all(); }
  memory(content, id = randomUUID(), source = 'manual') {
    id ??= randomUUID();
    this.db.prepare('INSERT INTO memories (id,content,created,source) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET content=excluded.content,source=excluded.source').run(id, content, new Date().toISOString(), source);
    return id;
  }
  removeMemory(id) {
    this.db.prepare('DELETE FROM memories WHERE id=?').run(id);
    this.db.exec('UPDATE messages SET context=0');
  }
  classes() { return this.db.prepare('SELECT * FROM class_sessions ORDER BY day,start,name').all(); }
  saveClass(value, id = randomUUID()) {
    id ??= randomUUID();
    this.db.prepare(`INSERT INTO class_sessions (id,name,day,start,end,location,created) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,day=excluded.day,start=excluded.start,end=excluded.end,location=excluded.location`)
      .run(id, value.name, value.day, value.start, value.end, value.location, new Date().toISOString());
    return id;
  }
  removeClass(id) { this.db.prepare('DELETE FROM class_sessions WHERE id=?').run(id); }
  academics(now = new Date(), includeEnded = false) { return this.db.prepare(`SELECT a.*,s.provider AS source,s.external_id,s.source_url,s.missing_since,s.missing_ignored
    FROM academic_items a LEFT JOIN academic_sources s ON s.item_id=a.id
    WHERE a.cancelled_at IS NULL
    ORDER BY a.completed,a.due,a.title`).all()
      .map(item => repeats(item) && !item.completed ? projectRecurringItem(item, this.academicExceptions(item.id), now) : item)
      .filter(item => includeEnded || !item.ended)
      .sort((a, b) => a.completed - b.completed || a.due.localeCompare(b.due) || a.title.localeCompare(b.title)); }
  cancelledAcademicIds() { return this.db.prepare('SELECT id FROM academic_items WHERE cancelled_at IS NOT NULL').all().map(row => row.id); }
  cancelledAcademics() { return this.db.prepare('SELECT * FROM academic_items WHERE cancelled_at IS NOT NULL ORDER BY cancelled_at DESC,id').all(); }
  endedAcademics(now = new Date()) { return this.academics(now, true).filter(item => item.ended); }
  academicExceptions(id) { return this.db.prepare('SELECT original_due,due,cancelled FROM academic_exceptions WHERE item_id=? ORDER BY original_due').all(id); }
  saveAcademicOccurrence(id, originalDue, due, cancelled = false) {
    const item = this.db.prepare('SELECT * FROM academic_items WHERE id=?').get(id);
    if (!item || !repeats(item) || item.cancelled_at || item.completed || originalDue < item.due
        || !Number.isFinite(new Date(originalDue).getTime()) || !Number.isFinite(new Date(due).getTime())
        || !withinRepeatEnd(item, originalDue) || !withinRepeatEnd(item, due)
        || nextRecurringDue(item.due, recurrenceType(item), new Date(originalDue), item.monthly_day) !== originalDue) throw new Error('변경할 반복 회차가 아닙니다.');
    this.db.prepare(`INSERT INTO academic_exceptions (item_id,original_due,due,cancelled) VALUES (?,?,?,?)
      ON CONFLICT(item_id,original_due) DO UPDATE SET due=excluded.due,cancelled=excluded.cancelled`).run(id, originalDue, due, cancelled ? 1 : 0);
  }
  saveAcademic(value, id = randomUUID()) {
    id ??= randomUUID();
    const previous = this.db.prepare('SELECT due,repeat_weekly,recurrence,monthly_day,repeat_until FROM academic_items WHERE id=?').get(id);
    const recurrence = value.recurrence ?? (value.repeat_weekly !== undefined ? value.repeat_weekly ? 'weekly' : 'none' : recurrenceType(previous));
    const monthlyDay = recurrence === 'monthly' ? value.monthly_day || (previous?.recurrence === 'monthly' ? previous.monthly_day : 0) || new Date(value.due).getDate() : 0;
    if (!recurrenceTypes.includes(recurrence) || !Number.isInteger(monthlyDay) || monthlyDay < 0 || monthlyDay > 31) throw new Error('반복 규칙이 올바르지 않습니다.');
    const ruleChanged = previous && repeats(previous) && !sameRecurrenceRule(previous, { due: value.due, recurrence, monthly_day: monthlyDay });
    // Keep the original anchor on metadata edits and restore; future exception IDs stay valid.
    const due = previous && repeats(previous) && recurrence !== 'none' && !ruleChanged ? previous.due : value.due;
    const until = recurrence === 'none' ? null : value.repeat_until !== undefined ? value.repeat_until : previous?.repeat_until ?? null;
    if (until !== null && (!validDateKey(until) || until < due.slice(0, 10))) throw new Error('종료일이 올바르지 않거나 첫 회차보다 빠릅니다.');
    this.db.exec('SAVEPOINT save_academic');
    try {
      this.db.prepare(`INSERT INTO academic_items (id,title,course,kind,due,notes,completed,completed_at,created,repeat_weekly,recurrence,monthly_day,repeat_until) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,course=excluded.course,kind=excluded.kind,due=excluded.due,notes=excluded.notes,repeat_weekly=excluded.repeat_weekly,recurrence=excluded.recurrence,monthly_day=excluded.monthly_day,repeat_until=excluded.repeat_until,manual_override=1`)
        .run(id, value.title, value.course, value.kind, due, value.notes, value.completed ? 1 : 0, value.completed ? new Date().toISOString() : null, new Date().toISOString(), recurrence === 'weekly' ? 1 : 0, recurrence, monthlyDay, until);
      if (ruleChanged) this.db.prepare('DELETE FROM academic_exceptions WHERE item_id=?').run(id);
      this.db.exec('RELEASE save_academic');
    } catch (error) { this.db.exec('ROLLBACK TO save_academic; RELEASE save_academic'); throw error; }
    return id;
  }
  toggleAcademic(id, completed) { this.db.prepare('UPDATE academic_items SET completed=?,completed_at=? WHERE id=?').run(completed ? 1 : 0, completed ? new Date().toISOString() : null, id); }
  removeAcademic(id) { this.db.prepare('DELETE FROM academic_items WHERE id=?').run(id); }
  cancelAcademic(id) {
    this.db.prepare('UPDATE academic_items SET cancelled_at=? WHERE id=? AND completed=0').run(new Date().toISOString(), id);
    this.db.prepare('UPDATE academic_sources SET missing_since=NULL WHERE item_id=?').run(id);
  }
  restoreAcademic(id) { this.db.prepare('UPDATE academic_items SET cancelled_at=NULL WHERE id=?').run(id); }
  routines(date) {
    return this.db.prepare(`SELECT r.*,EXISTS(SELECT 1 FROM routine_logs l WHERE l.routine_id=r.id AND l.date=?) AS completedToday
      FROM routines r ORDER BY r.time,r.title`).all(date).map(row => ({ ...row, days: JSON.parse(row.days) }));
  }
  saveRoutine(value, id = randomUUID()) {
    id ??= randomUUID();
    this.db.prepare(`INSERT INTO routines (id,title,category,days,time,notes,active,created) VALUES (?,?,?,?,?,?,1,?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,category=excluded.category,days=excluded.days,time=excluded.time,notes=excluded.notes`)
      .run(id, value.title, value.category, JSON.stringify(value.days), value.time, value.notes, new Date().toISOString());
    return id;
  }
  toggleRoutine(id, date, completed) {
    if (completed) this.db.prepare('INSERT OR REPLACE INTO routine_logs (routine_id,date,completed_at) VALUES (?,?,?)').run(id, date, new Date().toISOString());
    else this.db.prepare('DELETE FROM routine_logs WHERE routine_id=? AND date=?').run(id, date);
  }
  removeRoutine(id) { this.db.prepare('DELETE FROM routines WHERE id=?').run(id); }
  addActivity(date, app, category, seconds) {
    this.db.prepare(`INSERT INTO activity_usage (date,app,category,seconds,updated) VALUES (?,?,?,?,?)
      ON CONFLICT(date,app,category) DO UPDATE SET seconds=seconds+excluded.seconds,updated=excluded.updated`)
      .run(date, app, category, seconds, new Date().toISOString());
  }
  activity(date) {
    const apps = this.db.prepare('SELECT app,category,seconds FROM activity_usage WHERE date=? ORDER BY seconds DESC,app').all(date);
    const categories = { game: 0, study: 0, video: 0, other: 0 };
    for (const item of apps) categories[item.category] = (categories[item.category] || 0) + item.seconds;
    return { date, totalSeconds: apps.reduce((sum, item) => sum + item.seconds, 0), categories, apps };
  }
  activityRange(from, to) { return this.db.prepare('SELECT date,category,SUM(seconds) AS seconds FROM activity_usage WHERE date>=? AND date<=? GROUP BY date,category ORDER BY date DESC').all(from, to); }
  health(date) { return this.db.prepare('SELECT * FROM health_entries WHERE date=?').get(date) || null; }
  healthRange(from, to) { return this.db.prepare('SELECT * FROM health_entries WHERE date>=? AND date<=? ORDER BY date DESC').all(from, to); }
  saveHealth(value) {
    this.db.prepare(`INSERT INTO health_entries (date,sleep_minutes,meals,water,exercise_minutes,energy,note,updated) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(date) DO UPDATE SET sleep_minutes=excluded.sleep_minutes,meals=excluded.meals,water=excluded.water,exercise_minutes=excluded.exercise_minutes,energy=excluded.energy,note=excluded.note,updated=excluded.updated`)
      .run(value.date, value.sleepMinutes, value.meals, value.water, value.exerciseMinutes, value.energy, value.note, new Date().toISOString());
  }
  notificationSent(key) { return Boolean(this.db.prepare('SELECT 1 FROM notification_log WHERE key=?').get(key)); }
  lastNotification() { return this.db.prepare('SELECT key,sent FROM notification_log ORDER BY sent DESC LIMIT 1').get() || null; }
  markNotificationSent(key, sent = new Date().toISOString()) {
    this.db.prepare('INSERT OR IGNORE INTO notification_log (key,sent) VALUES (?,?)').run(key, sent);
  }
  missedNotifications() { return this.db.prepare('SELECT * FROM missed_notifications ORDER BY created DESC LIMIT 50').all(); }
  recordMissedNotification(candidate) {
    if (!candidate?.key || !candidate?.title || !candidate?.body) return;
    this.db.prepare(`INSERT OR IGNORE INTO missed_notifications (id,key,title,body,created) VALUES (?,?,?,?,?)`)
      .run(randomUUID(), String(candidate.key), String(candidate.title), String(candidate.body), new Date().toISOString());
  }
  clearMissedNotifications() { this.db.exec('DELETE FROM missed_notifications'); }
  saveIntegration(key, value) {
    this.db.prepare(`INSERT INTO integrations (key,value) VALUES (?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, JSON.stringify(value));
  }
  integration(key) {
    const row = this.db.prepare('SELECT value FROM integrations WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : null;
  }
  eclassSourceIds() { return new Set(this.db.prepare("SELECT external_id FROM academic_sources WHERE provider='eclass'").all().map(row => row.external_id)); }
  resolveMissingAcademic(id, action) {
    const source = this.db.prepare("SELECT missing_since FROM academic_sources WHERE item_id=? AND provider='eclass'").get(id);
    if (!source?.missing_since) return false;
    this.db.exec('BEGIN');
    try {
      if (action === 'complete') {
        this.toggleAcademic(id, true);
        this.db.prepare('UPDATE academic_sources SET missing_since=NULL,missing_ignored=0 WHERE item_id=?').run(id);
      } else {
        this.db.prepare('UPDATE academic_sources SET missing_since=NULL,missing_ignored=1 WHERE item_id=?').run(id);
      }
      this.db.exec('COMMIT'); return true;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  syncEclass(items, detectMissing = true) {
    const find = this.db.prepare("SELECT item_id FROM academic_sources WHERE provider='eclass' AND external_id=?");
    const update = this.db.prepare('UPDATE academic_items SET title=?,course=?,kind=?,due=?,notes=?,completed=0,completed_at=NULL WHERE id=? AND cancelled_at IS NULL AND manual_override=0');
    const source = this.db.prepare(`INSERT INTO academic_sources (item_id,provider,external_id,source_url,last_seen,missing_since,missing_ignored) VALUES (?,'eclass',?,?,?,NULL,0)
      ON CONFLICT(provider,external_id) DO UPDATE SET source_url=excluded.source_url,last_seen=excluded.last_seen,missing_since=NULL,missing_ignored=0`);
    const now = new Date().toISOString();
    let added = 0, updated = 0;
    this.db.exec('BEGIN');
    try {
      for (const item of items) {
        const existing = find.get(item.externalId);
        let id = existing?.item_id;
        if (id) {
          updated += Number(update.run(item.title, item.course, item.kind, item.due, item.notes, id).changes);
        } else {
          id = this.saveAcademic({ ...item, completed: false });
          added++;
        }
        source.run(id, item.externalId, item.sourceUrl, now);
      }
      if (detectMissing) {
        const present = new Set(items.map(item => item.externalId));
        const unseen = this.db.prepare(`SELECT s.item_id,s.external_id,s.missing_since,s.missing_ignored
          FROM academic_sources s JOIN academic_items a ON a.id=s.item_id
          WHERE s.provider='eclass' AND a.completed=0 AND a.cancelled_at IS NULL AND a.manual_override=0`).all();
        const markMissing = this.db.prepare('UPDATE academic_sources SET missing_since=? WHERE item_id=?');
        for (const item of unseen) {
          if (!present.has(item.external_id) && !item.missing_since && !item.missing_ignored) markMissing.run(now, item.item_id);
        }
      }
      const missing = this.db.prepare("SELECT COUNT(*) AS count FROM academic_sources WHERE provider='eclass' AND missing_since IS NOT NULL").get().count;
      const status = { lastSync: now, received: items.length, added, updated, missing };
      this.db.prepare(`INSERT INTO integrations (key,value) VALUES ('eclass',?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify(status));
      this.db.exec('COMMIT');
      return status;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  addPair(user, assistant, action = null, memories = []) {
    this.db.exec('SAVEPOINT chat_pair');
    try {
      for (const memory of memories) this.memory(memory.content, memory.id, 'conversation');
      const insert = this.db.prepare('INSERT INTO messages (id,role,content,created,schedule_action) VALUES (?,?,?,?,?)');
      const now = new Date().toISOString();
      insert.run(randomUUID(), 'user', user, now, '');
      insert.run(randomUUID(), 'assistant', assistant, now, action ? JSON.stringify(action) : '');
      this.db.exec('RELEASE chat_pair');
    } catch (error) { this.db.exec('ROLLBACK TO chat_pair; RELEASE chat_pair'); throw error; }
  }
  feedback(id, value, reason = '') { this.db.prepare("UPDATE messages SET feedback=?,feedback_reason=? WHERE id=? AND role='assistant'").run(value, reason, id); }
  clearMessages() { this.db.exec('DELETE FROM messages; VACUUM;'); }
  close() { this.db.close(); }
}
