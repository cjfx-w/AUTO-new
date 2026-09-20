const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AccountScheduler } = require('../src/scheduler/account-scheduler');
const dbStore = require('../src/storage/database');

function storage() {
  const leases = new Set();
  return {
    leases,
    acquireSchedulerLeases({ accountId, bitWindowId }) { if (leases.has(`a:${accountId}`) || leases.has(`w:${bitWindowId}`)) return { acquired: false }; leases.add(`a:${accountId}`); leases.add(`w:${bitWindowId}`); return { acquired: true }; },
    releaseSchedulerLeases({ accountId, bitWindowId }) { leases.delete(`a:${accountId}`); leases.delete(`w:${bitWindowId}`); },
    updateScheduledTask() {}
  };
}

test('serializes tasks for one account and limits different accounts', async () => {
  const active = new Set(); let maxActive = 0; const events = []; const store = storage();
  const scheduler = new AccountScheduler({ storage: store, maxConcurrent: 2, worker: async (task) => { active.add(task.account_id); maxActive = Math.max(maxActive, active.size); events.push(`start:${task.task_id}`); await new Promise((resolve) => setTimeout(resolve, 10)); active.delete(task.account_id); events.push(`end:${task.task_id}`); } });
  scheduler.start([{ task_id: 'a1', account_id: 'a', bit_window_id: 'wa', created_at: '1' }, { task_id: 'a2', account_id: 'a', bit_window_id: 'wa', created_at: '2' }, { task_id: 'b1', account_id: 'b', bit_window_id: 'wb', created_at: '1' }]);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(maxActive <= 2, true);
  assert.equal(events.indexOf('end:a1') < events.indexOf('start:a2'), true);
});

test('does not start a task when its account or window lease is occupied', () => {
  const store = storage();
  assert.equal(store.acquireSchedulerLeases({ accountId: 'a', bitWindowId: 'wa' }).acquired, true);
  assert.equal(store.acquireSchedulerLeases({ accountId: 'a', bitWindowId: 'wa2' }).acquired, false);
});

test('uses SQLite global slots and reclaims expired leases', () => {
  const filename = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'auto-scheduler-')), 'test.db');
  const db = dbStore.initDatabase(filename);
  const first = dbStore.acquireSchedulerLeases(db, { ownerRunId: 'run-1', accountId: 'a', bitWindowId: 'wa', maxConcurrent: 1, now: '2026-01-01T00:00:00.000Z' });
  assert.equal(first.acquired, true);
  assert.equal(dbStore.acquireSchedulerLeases(db, { ownerRunId: 'run-2', accountId: 'b', bitWindowId: 'wb', maxConcurrent: 1, now: '2026-01-01T00:01:00.000Z' }).acquired, false);
  db.prepare("UPDATE scheduler_leases SET expires_at = '2025-12-31T23:00:00.000Z'").run();
  assert.equal(dbStore.acquireSchedulerLeases(db, { ownerRunId: 'run-2', accountId: 'b', bitWindowId: 'wb', maxConcurrent: 1, now: '2026-01-01T00:02:00.000Z' }).acquired, true);
  dbStore.releaseSchedulerLeases(db, { ownerRunId: 'run-2', accountId: 'b', bitWindowId: 'wb' });
  db.close();
});

test('a task failure is isolated and account failures are blocked', async () => {
  const store = storage();
  const states = [];
  store.updateScheduledTask = (taskId, status) => states.push([taskId, status]);
  const scheduler = new AccountScheduler({ storage: store, maxConcurrent: 2, worker: async (task) => {
    if (task.task_id === 'bad') { const error = new Error('login required'); error.code = 'NOT_LOGGED_IN'; throw error; }
  } });
  scheduler.start([
    { task_id: 'bad', account_id: 'a', bit_window_id: 'wa', created_at: '1' },
    { task_id: 'good', account_id: 'b', bit_window_id: 'wb', created_at: '1' }
  ]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(states.filter(([id, status]) => id === 'bad').at(-1), ['bad', 'blocked_account']);
  assert.deepEqual(states.filter(([id, status]) => id === 'good').at(-1), ['good', 'ready_before_publish']);
});
