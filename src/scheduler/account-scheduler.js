const crypto = require('node:crypto');

class AccountScheduler {
  constructor({ storage, worker, maxConcurrent = 2, now } = {}) {
    this.storage = storage;
    this.worker = worker;
    this.maxConcurrent = Math.max(1, Math.min(5, maxConcurrent));
    this.now = now ?? (() => new Date().toISOString());
    this.runId = crypto.randomBytes(8).toString('hex');
    this.running = new Map();
    this.queues = new Map();
    this.blockedAccounts = new Set(storage?.listBlockedAccounts?.() ?? []);
    this.started = false;
  }

  start(tasks) {
    if (this.started) return { run_id: this.runId, started: false };
    this.started = true;
    for (const task of tasks) {
      if (!this.queues.has(task.account_id)) this.queues.set(task.account_id, []);
      this.queues.get(task.account_id).push(task);
    }
    for (const queue of this.queues.values()) queue.sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')) || String(a.task_id).localeCompare(String(b.task_id)));
    for (const task of tasks) this.storage.updateScheduledTask?.(task.task_id, 'queued');
    this.pump();
    return { run_id: this.runId, started: true };
  }

  setMaxConcurrent(value) {
    if (!Number.isInteger(value) || value < 1 || value > 5) throw new Error('并发数必须是 1～5。');
    if (this.started) throw new Error('调度器运行中不能修改并发数。');
    this.maxConcurrent = value;
  }

  stop() { this.started = false; }

  status() {
    return { run_id: this.runId, started: this.started, running: [...this.running.values()], queued: [...this.queues.values()].reduce((sum, queue) => sum + queue.length, 0) };
  }

  pump() {
    if (!this.started) return;
    let blocked = 0;
    while (this.running.size < this.maxConcurrent) {
      const task = this.nextTask();
      if (!task) break;
      const lease = this.storage.acquireSchedulerLeases({ ownerRunId: this.runId, accountId: task.account_id, bitWindowId: task.bit_window_id, maxConcurrent: this.maxConcurrent, now: this.now() });
      if (!lease.acquired) {
        this.requeue(task);
        blocked += 1;
        if (blocked >= this.queuedCount()) break;
        continue;
      }
      blocked = 0;
      this.running.set(task.task_id, { task_id: task.task_id, account_id: task.account_id, bit_window_id: task.bit_window_id, slot: lease.slot ?? null, status: 'running' });
      this.storage.updateScheduledTask?.(task.task_id, 'running');
      this.execute(task).finally(() => {
        const execution = this.running.get(task.task_id);
        this.running.delete(task.task_id);
        this.storage.releaseSchedulerLeases({ ownerRunId: this.runId, accountId: task.account_id, bitWindowId: task.bit_window_id, slot: execution?.slot });
        queueMicrotask(() => this.pump());
      });
    }
  }

  nextTask() {
    const candidates = [...this.queues.entries()]
      .filter(([accountId, queue]) => queue.length && !this.runningHasAccount(accountId) && !this.blockedAccounts.has(accountId))
      .map(([, queue]) => queue[0])
      .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')) || String(a.task_id).localeCompare(String(b.task_id)));
    const task = candidates[0];
    return task ? this.queues.get(task.account_id).shift() : null;
  }

  hasStartableTask() {
    return [...this.queues].some(([accountId, queue]) => queue.length && !this.runningHasAccount(accountId));
  }

  queuedCount() {
    return [...this.queues.values()].reduce((sum, queue) => sum + queue.length, 0);
  }

  requeue(task) { this.queues.get(task.account_id)?.unshift(task); }
  runningHasAccount(accountId) { return [...this.running.values()].some((item) => item.account_id === accountId); }

  async execute(task) {
    const heartbeat = this.storage.heartbeatSchedulerLeases
      ? setInterval(() => this.storage.heartbeatSchedulerLeases({ ownerRunId: this.runId, now: this.now() }), 10 * 60 * 1000)
      : null;
    heartbeat?.unref?.();
    try {
      await this.worker(task);
      this.storage.updateScheduledTask?.(task.task_id, 'ready_before_publish');
    } catch (error) {
      const blocked = ['ACCOUNT_MISMATCH', 'NOT_LOGGED_IN', 'CAPTCHA', 'AUTH_REQUIRED', 'WINDOW_UNAVAILABLE', 'CDP_DISCONNECTED'].includes(error.code);
      const status = error.code === 'RESULT_UNCERTAIN' ? 'result_uncertain' : blocked ? 'blocked_account' : 'failed_before_publish';
      if (blocked) {
        this.blockedAccounts.add(task.account_id);
        this.storage.blockAccount?.(task.account_id, error.message);
      }
      this.storage.updateScheduledTask?.(task.task_id, status, error);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }
}

module.exports = { AccountScheduler };
