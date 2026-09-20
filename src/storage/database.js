function initDatabase(filename) {
  // SQLite is initialized here so later phases can add accounts, boards, tasks,
  // and attempts without coupling them to the BitBrowser client.
  const Database = require('better-sqlite3');
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS bitbrowser_windows (
      window_id TEXT PRIMARY KEY,
      window_name TEXT NOT NULL,
      remark TEXT NOT NULL DEFAULT '',
      is_open INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS accounts (
      account_id TEXT PRIMARY KEY,
      bit_window_id TEXT NOT NULL UNIQUE,
      window_name TEXT NOT NULL DEFAULT '',
      pinterest_username TEXT NOT NULL,
      pinterest_profile_url TEXT NOT NULL,
      verification_state TEXT NOT NULL,
      last_verified_at TEXT NOT NULL,
      board_sync_state TEXT NOT NULL DEFAULT 'not_checked',
      board_sync_error TEXT,
      last_board_checked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS boards (
      account_id TEXT NOT NULL,
      board_id TEXT NOT NULL,
      board_name TEXT NOT NULL,
      board_url TEXT NOT NULL,
      synced_at TEXT NOT NULL,
      PRIMARY KEY (account_id, board_id),
      FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS import_batches (
      batch_id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      product_name TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      confirmed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS import_items (
      item_id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      product_name TEXT NOT NULL,
      video_id TEXT NOT NULL DEFAULT '',
      file_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      product_url TEXT NOT NULL DEFAULT '',
      account_group TEXT NOT NULL DEFAULT '',
      board TEXT NOT NULL DEFAULT '',
      account_id TEXT,
      board_id TEXT,
      asset_hash TEXT NOT NULL,
      duplicate INTEGER NOT NULL DEFAULT 0,
      validation_error TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (batch_id) REFERENCES import_batches(batch_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS dry_run_attempts (
      attempt_id TEXT PRIMARY KEY,
      task_id TEXT,
      item_id TEXT NOT NULL,
      bit_window_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      status TEXT NOT NULL,
      current_step TEXT NOT NULL,
      page_url TEXT,
      last_screenshot_path TEXT,
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dry_run_steps (
      attempt_id TEXT NOT NULL,
      step_index INTEGER NOT NULL,
      step TEXT NOT NULL,
      page_url TEXT,
      screenshot_path TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (attempt_id, step_index),
      FOREIGN KEY (attempt_id) REFERENCES dry_run_attempts(attempt_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS products (
      product_id TEXT PRIMARY KEY,
      run_key TEXT UNIQUE NOT NULL,
      product_name TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      product_url TEXT NOT NULL DEFAULT '',
      board_name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS product_assets (
      asset_id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      asset_hash TEXT NOT NULL,
      file_name TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      modified_at TEXT NOT NULL,
      FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS product_tasks (
      task_id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      product_name TEXT NOT NULL DEFAULT '',
      asset_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      bit_window_id TEXT NOT NULL,
      board_name TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      product_url TEXT NOT NULL DEFAULT '',
      account_username TEXT NOT NULL DEFAULT '',
      window_name TEXT NOT NULL DEFAULT '',
      pinterest_profile_url TEXT,
      verification_state TEXT,
      board_sync_state TEXT,
      last_board_checked_at TEXT,
      board_id TEXT,
      board_url TEXT,
      asset_hash TEXT NOT NULL DEFAULT '',
      file_name TEXT NOT NULL DEFAULT '',
      relative_path TEXT NOT NULL DEFAULT '',
      content_version TEXT NOT NULL DEFAULT 'v1',
      status TEXT NOT NULL DEFAULT 'ready',
      last_error_code TEXT,
      last_error_message TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (product_id) REFERENCES products(product_id),
      FOREIGN KEY (asset_id) REFERENCES product_assets(asset_id)
    );
    CREATE TABLE IF NOT EXISTS publication_locks (
      platform TEXT NOT NULL,
      account_id TEXT NOT NULL,
      asset_hash TEXT NOT NULL,
      state TEXT NOT NULL,
      first_attempt_id TEXT,
      owner_product_id TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (platform, account_id, asset_hash)
    );
    CREATE TABLE IF NOT EXISTS scheduler_leases (
      lease_key TEXT PRIMARY KEY,
      lease_type TEXT NOT NULL,
      owner_run_id TEXT NOT NULL,
      account_id TEXT,
      bit_window_id TEXT,
      acquired_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scheduler_blocked_accounts (
      account_id TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      blocked_at TEXT NOT NULL
    )
  `);
  const columns = db.prepare('PRAGMA table_info(dry_run_attempts)').all().map((column) => column.name);
  if (!columns.includes('task_id')) db.exec('ALTER TABLE dry_run_attempts ADD COLUMN task_id TEXT');
  const taskColumns = db.prepare('PRAGMA table_info(product_tasks)').all().map((column) => column.name);
  if (!taskColumns.includes('last_error_code')) db.exec('ALTER TABLE product_tasks ADD COLUMN last_error_code TEXT');
  if (!taskColumns.includes('last_error_message')) db.exec('ALTER TABLE product_tasks ADD COLUMN last_error_message TEXT');
  db.pragma('foreign_keys = ON');
  return db;
}

function saveBitBrowserWindows(db, windows) {
  const statement = db.prepare(`
    INSERT INTO bitbrowser_windows (window_id, window_name, remark, is_open, updated_at)
    VALUES (@window_id, @window_name, @remark, @is_open, @updated_at)
    ON CONFLICT(window_id) DO UPDATE SET
      window_name = excluded.window_name,
      remark = excluded.remark,
      is_open = excluded.is_open,
      updated_at = excluded.updated_at
  `);
  const save = db.transaction((items) => {
    db.prepare('DELETE FROM bitbrowser_windows').run();
    for (const item of items) statement.run({
      window_id: item.window_id,
      window_name: item.window_name,
      remark: item.remark,
      is_open: item.is_open ? 1 : 0,
      updated_at: new Date().toISOString()
    });
  });
  save(windows);
}

function getAccountByWindow(db, bitWindowId) {
  return db.prepare('SELECT * FROM accounts WHERE bit_window_id = ?').get(bitWindowId) ?? null;
}

function assertAccountWindowAvailable(db, account) {
  const existing = getAccountByWindow(db, account.bit_window_id);
  if (existing && existing.account_id !== account.account_id) {
    const { PinterestValidationError } = require('../pinterest/errors');
    throw new PinterestValidationError('ACCOUNT_MISMATCH', '当前窗口登录了其他账号，已阻止覆盖原绑定。');
  }
  return existing;
}

function saveAccountBinding(db, account) {
  const existing = assertAccountWindowAvailable(db, account);
  if (existing) {
    db.prepare(`
      UPDATE accounts
      SET window_name = ?, pinterest_username = ?, pinterest_profile_url = ?, verification_state = ?, last_verified_at = ?
      WHERE account_id = ?
    `).run(account.window_name, account.pinterest_username, account.pinterest_profile_url, account.verification_state, account.last_verified_at, account.account_id);
    return;
  }
  db.prepare(`
    INSERT INTO accounts (account_id, bit_window_id, window_name, pinterest_username, pinterest_profile_url, verification_state, last_verified_at, board_sync_state, board_sync_error, last_board_checked_at)
    VALUES (@account_id, @bit_window_id, @window_name, @pinterest_username, @pinterest_profile_url, @verification_state, @last_verified_at, 'not_checked', NULL, NULL)
  `).run(account);
}

function saveAccountAndBoards(db, snapshot) {
  assertAccountWindowAvailable(db, snapshot.account);

  const save = db.transaction(() => {
    db.prepare(`
      INSERT INTO accounts (account_id, bit_window_id, window_name, pinterest_username, pinterest_profile_url, verification_state, last_verified_at, board_sync_state, board_sync_error, last_board_checked_at)
      VALUES (@account_id, @bit_window_id, @window_name, @pinterest_username, @pinterest_profile_url, @verification_state, @last_verified_at, 'ok', NULL, @last_verified_at)
      ON CONFLICT(account_id) DO UPDATE SET
        bit_window_id = excluded.bit_window_id,
        window_name = excluded.window_name,
        pinterest_username = excluded.pinterest_username,
        pinterest_profile_url = excluded.pinterest_profile_url,
        verification_state = excluded.verification_state,
        last_verified_at = excluded.last_verified_at,
        board_sync_state = 'ok',
        board_sync_error = NULL,
        last_board_checked_at = excluded.last_board_checked_at
    `).run(snapshot.account);
    db.prepare('DELETE FROM boards WHERE account_id = ?').run(snapshot.account.account_id);
    const insertBoard = db.prepare(`
      INSERT INTO boards (account_id, board_id, board_name, board_url, synced_at)
      VALUES (@account_id, @board_id, @board_name, @board_url, @synced_at)
    `);
    for (const board of snapshot.boards) insertBoard.run(board);
  });
  save();
}

function getBoards(db, accountId) {
  return db.prepare('SELECT * FROM boards WHERE account_id = ? ORDER BY board_name COLLATE NOCASE').all(accountId);
}

function saveCreatedBoard(db, { accountId, boardId, boardName, boardUrl }) {
  db.prepare(`
    INSERT INTO boards (account_id, board_id, board_name, board_url, synced_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(account_id, board_id) DO UPDATE SET board_name = excluded.board_name, board_url = excluded.board_url, synced_at = excluded.synced_at
  `).run(accountId, boardId, boardName, boardUrl, new Date().toISOString());
}

function updateImportItemBoard(db, itemId, boardId, boardName) {
  const current = db.prepare('SELECT validation_error FROM import_items WHERE item_id = ?').get(itemId);
  const remainingErrors = String(current?.validation_error ?? '').split('；').filter((error) => !/^Board 无法匹配/.test(error)).join('；');
  db.prepare('UPDATE import_items SET board_id = ?, board = ?, validation_error = ? WHERE item_id = ?').run(boardId, boardName, remainingErrors, itemId);
}

function updateProductTaskBoard(db, taskId, boardId, boardName) {
  db.prepare('UPDATE product_tasks SET board_id = ?, board_name = ?, board_url = (SELECT board_url FROM boards WHERE board_id = ? AND account_id = product_tasks.account_id) WHERE task_id = ?').run(boardId, boardName, boardId, taskId);
}

function saveCreatedBoardAndUpdateItem(db, { accountId, boardId, boardName, boardUrl, itemId, taskId }) {
  const save = db.transaction(() => {
    saveCreatedBoard(db, { accountId, boardId, boardName, boardUrl });
    if (taskId) updateProductTaskBoard(db, taskId, boardId, boardName); else updateImportItemBoard(db, itemId, boardId, boardName);
  });
  save();
}

function getAccountSnapshot(db, bitWindowId) {
  const account = getAccountByWindow(db, bitWindowId);
  if (!account) return null;
  return { account, boards: getBoards(db, account.account_id) };
}

function markBoardSyncFailed(db, { bitWindowId, errorState, diagnosticPath, checkedAt }) {
  db.prepare(`
    UPDATE accounts
    SET board_sync_state = 'needs_resync', board_sync_error = ?, last_board_checked_at = ?
    WHERE bit_window_id = ?
  `).run([errorState, diagnosticPath].filter(Boolean).join(':'), checkedAt, bitWindowId);
}

function canonicalizeBoardQuery(boardUrl) {
  if (!boardUrl) return { valid: true, value: null };
  try {
    const parsed = new URL(boardUrl);
    if (!/(^|\.)pinterest\.com$/i.test(parsed.hostname) || parsed.username || parsed.password) return { valid: false, value: null };
    const parts = parsed.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
    const reserved = new Set(['about', 'business', 'categories', 'contact', 'downloads', 'explore', 'help', 'ideas', 'legal', 'login', 'news', 'pin', 'pins', 'press', 'privacy', 'search', 'settings', 'signup', 'terms', 'today', 'boards']);
    if (parts.length !== 2 || reserved.has(parts[0].toLowerCase()) || reserved.has(parts[1].toLowerCase())) return { valid: false, value: null };
    parsed.protocol = 'https:';
    parsed.hostname = 'www.pinterest.com';
    parsed.search = '';
    parsed.hash = '';
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/`;
    return { valid: true, value: parsed.toString() };
  } catch {
    return { valid: false, value: null };
  }
}

function validateBoard(db, { accountId, boardId, boardName, boardUrl }) {
  if (![boardId, boardName, boardUrl].some((value) => typeof value === 'string' && value.trim())) {
    const { PinterestValidationError } = require('../pinterest/errors');
    throw new PinterestValidationError('INVALID_BOARD_QUERY', '必须提供 Board ID、名称或地址。');
  }
  const normalizedUrl = canonicalizeBoardQuery(boardUrl);
  if (!normalizedUrl.valid) return { valid: false, board: null };
  const canonicalUrl = normalizedUrl.value;
  const board = db.prepare(`
    SELECT * FROM boards
    WHERE account_id = ?
      AND (? IS NULL OR board_id = ?)
      AND (? IS NULL OR lower(board_name) = lower(?))
      AND (? IS NULL OR board_url = ?)
    LIMIT 1
  `).get(accountId, boardId ?? null, boardId ?? null, boardName ?? null, boardName ?? null, canonicalUrl, canonicalUrl);
  return { valid: Boolean(board), board: board ?? null };
}

function listAccounts(db) {
  return db.prepare('SELECT * FROM accounts ORDER BY pinterest_username COLLATE NOCASE').all();
}

function listImportAssetHashes(db) {
  return new Set(db.prepare('SELECT asset_hash FROM import_items').all().map((row) => row.asset_hash));
}

function saveImportPreview(db, preview) {
  const crypto = require('node:crypto');
  const now = new Date().toISOString();
  const save = db.transaction(() => {
    const batches = [];
    for (const batch of preview.batches) {
      const batchId = crypto.createHash('sha256').update(`${batch.product_id}:${now}:${Math.random()}`).digest('hex').slice(0, 24);
      db.prepare('INSERT INTO import_batches (batch_id, product_id, product_name, status, created_at, confirmed_at) VALUES (?, ?, ?, ?, ?, NULL)').run(batchId, batch.product_id, batch.product_name, 'pending_confirmation', now);
      const insert = db.prepare(`INSERT INTO import_items (item_id, batch_id, product_id, product_name, video_id, file_name, file_path, title, description, product_url, account_group, board, account_id, board_id, asset_hash, duplicate, validation_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const items = batch.items.map((item) => {
        const itemId = crypto.createHash('sha256').update(`${batchId}:${item.file_name}:${item.asset_hash}`).digest('hex').slice(0, 24);
        insert.run(itemId, batchId, batch.product_id, batch.product_name, item.video_id, item.file_name, item.file_path, item.title, item.description, item.product_url, item.account_group, item.board, item.account_id, item.board_id, item.asset_hash, item.duplicate ? 1 : 0, item.validation_error ?? '');
        return { ...item, item_id: itemId, batch_id: batchId };
      });
      batches.push({ ...batch, batch_id: batchId, items });
    }
    return batches;
  });
  return save();
}

function updateImportItem(db, { itemId, title, description, productUrl, board, boardId }) {
  const state = db.prepare('SELECT b.status, i.account_id, i.file_path, i.validation_error FROM import_items i JOIN import_batches b ON b.batch_id = i.batch_id WHERE i.item_id = ?').get(itemId);
  if (!state || state.status !== 'pending_confirmation') throw new Error('已确认批次不能再修改。');
  if (board !== undefined && boardId === undefined) {
    let boardReference = board;
    try { const parsed = new URL(board); if (/(^|\.)pinterest\.com$/i.test(parsed.hostname)) { parsed.protocol = 'https:'; parsed.hostname = 'www.pinterest.com'; parsed.search = ''; parsed.hash = ''; parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/`; boardReference = parsed.toString(); } } catch {}
    const match = state.account_id ? db.prepare('SELECT board_id, board_name FROM boards WHERE account_id = ? AND (lower(board_name) = lower(?) OR board_id = ? OR lower(board_url) = lower(?))').get(state.account_id, boardReference, boardReference, boardReference) : null;
    boardId = match?.board_id ?? null;
    board = match?.board_name ?? board;
  }
  if (boardId !== undefined && boardId !== null) {
    const validBoard = db.prepare('SELECT board_name FROM boards WHERE account_id = ? AND board_id = ?').get(state.account_id, boardId);
    if (!validBoard || String(validBoard.board_name).toLowerCase() !== String(board ?? '').toLowerCase()) boardId = null;
  }
  const validationErrors = String(state.validation_error || '').split('；').filter((error) => error && !(['产品链接格式不正确'].includes(error) || error.startsWith('标题') || error.startsWith('描述') || error.startsWith('Board 无法匹配')));
  if (!state.file_path) validationErrors.push(state.validation_error || '素材文件无效');
  if (productUrl) { try { const url = new URL(productUrl); if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) validationErrors.push('产品链接格式不正确'); } catch { validationErrors.push('产品链接格式不正确'); } }
  if (!title || !description) validationErrors.push('标题、描述不能为空');
  if (!boardId) validationErrors.push('Board 无法匹配');
  db.prepare('UPDATE import_items SET title = ?, description = ?, product_url = ?, board = ?, board_id = ?, validation_error = ? WHERE item_id = ?').run(title, description, productUrl, board, boardId ?? null, validationErrors.join('；'), itemId);
  return db.prepare('SELECT * FROM import_items WHERE item_id = ?').get(itemId);
}

function confirmImportBatch(db, batchId) {
  const fs = require('node:fs');
  const now = new Date().toISOString();
  const items = db.prepare('SELECT * FROM import_items WHERE batch_id = ?').all(batchId);
  if (!items.length) return { confirmed: false, batch_id: batchId, status: 'invalid', reason: '批次没有素材。' };
  if (items.some((item) => {
    try { return !item.file_path || !fs.statSync(item.file_path).isFile(); } catch { return true; }
  })) return { confirmed: false, batch_id: batchId, status: 'invalid', reason: '有视频素材已不存在，请重新导入。' };
  const productIdentity = new Map();
  for (const item of items) {
    const previous = productIdentity.get(item.product_id);
    if (previous && (previous.product_name !== item.product_name || previous.product_url !== item.product_url)) {
      return { confirmed: false, batch_id: batchId, status: 'invalid', reason: '同一产品的名称和链接必须保持一致。' };
    }
    productIdentity.set(item.product_id, { product_name: item.product_name, product_url: item.product_url });
  }
  const boardMatches = items.every((item) => {
    const board = db.prepare('SELECT board_name FROM boards WHERE account_id = ? AND board_id = ?').get(item.account_id, item.board_id);
    return board && String(board.board_name).toLowerCase() === String(item.board).toLowerCase();
  });
  if (!boardMatches) return { confirmed: false, batch_id: batchId, status: 'invalid', reason: 'Board 必须属于当前账号，且名称与 Board ID 一致。' };
  const validLinks = (value) => { if (!value) return true; try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && Boolean(url.hostname); } catch { return false; } };
  if (items.some((item) => item.duplicate || item.validation_error || !item.account_id || !item.board_id || !item.title || !item.description || !validLinks(item.product_url))) {
    return { confirmed: false, batch_id: batchId, status: 'invalid', reason: '请先处理重复素材、账号、Board 和内容字段。' };
  }
  const result = db.prepare("UPDATE import_batches SET status = 'confirmed', confirmed_at = ? WHERE batch_id = ? AND status = 'pending_confirmation'").run(now, batchId);
  return { confirmed: result.changes === 1, batch_id: batchId, status: result.changes === 1 ? 'confirmed' : 'unchanged' };
}

function getImportBatches(db) {
  const batches = db.prepare('SELECT * FROM import_batches ORDER BY created_at DESC').all();
  const itemQuery = db.prepare('SELECT * FROM import_items WHERE batch_id = ? ORDER BY item_id');
  return batches.map((batch) => ({ ...batch, items: itemQuery.all(batch.batch_id) }));
}

function getConfirmedImportItem(db, itemId) {
  return db.prepare("SELECT i.*, b.status AS batch_status FROM import_items i JOIN import_batches b ON b.batch_id = i.batch_id WHERE i.item_id = ? AND b.status = 'confirmed'").get(itemId) ?? null;
}

function getDryRunTask(db, { taskId, itemId }) {
  if (taskId) return db.prepare("SELECT t.task_id, t.product_id, t.product_name, t.asset_id, a.asset_hash, a.file_path, t.title, t.description, t.product_url, t.account_id, t.bit_window_id, t.board_name AS board, t.board_id, t.board_url, t.status FROM product_tasks t JOIN product_assets a ON a.asset_id = t.asset_id WHERE t.task_id = ? AND t.status IN ('ready', 'queued', 'running')").get(taskId) ?? null;
  return getConfirmedImportItem(db, itemId);
}

function getAccountById(db, accountId) {
  return db.prepare('SELECT * FROM accounts WHERE account_id = ?').get(accountId) ?? null;
}

function getProductAssetHashes(db, accountIds) {
  const result = new Set();
  if (!accountIds.length) return result;
  const placeholders = accountIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT account_id, asset_hash FROM publication_locks WHERE account_id IN (${placeholders})`).all(...accountIds);
  for (const row of rows) result.add(`${row.account_id}:${row.asset_hash}`);
  return result;
}

function getProductAssetHashCache(db) {
  const cache = new Map();
  for (const row of db.prepare('SELECT file_path, file_size, modified_at, asset_hash FROM product_assets').all()) {
    const modified = Date.parse(row.modified_at);
    if (Number.isFinite(modified)) cache.set(`${row.file_path}:${row.file_size}:${modified}`, row.asset_hash);
  }
  return cache;
}

function saveProductRun(db, preview) {
  const crypto = require('node:crypto');
  const now = new Date().toISOString();
  const stableAccounts = preview.tasks.map((task) => JSON.stringify({ account_id: task.account_id, board_id: task.board_id, board_url: task.board_url, account_username: task.account_username })).sort();
  const runKey = crypto.createHash('sha256').update(JSON.stringify({ productName: preview.productName, title: preview.title, description: preview.description, productUrl: preview.productUrl || '', boardName: preview.boardName, assets: preview.assets.map((asset) => asset.asset_hash).sort(), accounts: stableAccounts })).digest('hex');
  const productId = crypto.randomBytes(12).toString('hex');
  const save = db.transaction(() => {
    const inserted = db.prepare('INSERT OR IGNORE INTO products (product_id, run_key, product_name, title, description, product_url, board_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(productId, runKey, preview.productName, preview.title, preview.description, preview.productUrl || '', preview.boardName, now);
    if (!inserted.changes) { const existing = db.prepare('SELECT product_id FROM products WHERE run_key = ?').get(runKey); return { product_id: existing.product_id, task_count: db.prepare('SELECT COUNT(*) AS count FROM product_tasks WHERE product_id = ?').get(existing.product_id).count, idempotent: true }; }
    const assetIds = new Map();
    const assetInsert = db.prepare('INSERT INTO product_assets (asset_id, product_id, asset_hash, file_name, relative_path, file_path, file_size, modified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const asset of preview.assets) {
      const assetId = crypto.randomBytes(12).toString('hex');
      assetIds.set(asset.asset_id, assetId);
      assetInsert.run(assetId, productId, asset.asset_hash, asset.file_name, asset.relative_path, asset.file_path, asset.file_size, asset.modified_at);
    }
    const lock = db.prepare('INSERT OR IGNORE INTO publication_locks (platform, account_id, asset_hash, state, owner_product_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
    const taskInsert = db.prepare('INSERT INTO product_tasks (task_id, product_id, product_name, asset_id, account_id, bit_window_id, board_name, title, description, product_url, account_username, window_name, pinterest_profile_url, verification_state, board_sync_state, last_board_checked_at, board_id, board_url, asset_hash, file_name, relative_path, content_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    let generated = 0;
    for (const task of preview.tasks) {
      const assetId = assetIds.get(task.asset.asset_id);
      const lockResult = lock.run('pinterest', task.account_id, task.asset.asset_hash, 'reserved', productId, now);
      if (!lockResult.changes) continue;
      taskInsert.run(crypto.randomBytes(12).toString('hex'), productId, preview.productName, assetId, task.account_id, task.bit_window_id, task.board_name, task.title, task.description, task.product_url || '', task.account_username || '', task.window_name || '', task.pinterest_profile_url || null, task.verification_state || null, task.board_sync_state || null, task.last_board_checked_at || null, task.board_id, task.board_url, task.asset.asset_hash, task.asset.file_name, task.asset.relative_path, 'v1', now);
      generated += 1;
    }
    if (!generated) { db.prepare('DELETE FROM products WHERE product_id = ?').run(productId); return { product_id: null, task_count: 0, duplicate: true }; }
    return { product_id: productId, task_count: generated };
  });
  return save();
}

function listProductTasks(db, productId = null) {
  if (productId) return db.prepare('SELECT * FROM product_tasks WHERE product_id = ? ORDER BY created_at, task_id').all(productId);
  return db.prepare('SELECT * FROM product_tasks ORDER BY created_at, task_id').all();
}

function listBlockedSchedulerAccounts(db) {
  return db.prepare('SELECT account_id FROM scheduler_blocked_accounts ORDER BY blocked_at').all().map((row) => row.account_id);
}

function blockSchedulerAccount(db, accountId, reason = 'account_blocked') {
  db.prepare('INSERT INTO scheduler_blocked_accounts (account_id, reason, blocked_at) VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET reason = excluded.reason, blocked_at = excluded.blocked_at').run(accountId, reason, new Date().toISOString());
}

function releasePublicationLock(db, { accountId, assetHash, productId }) {
  const owned = db.prepare("SELECT 1 FROM product_tasks WHERE product_id = ? AND account_id = ? AND asset_hash = ? AND status = 'ready' LIMIT 1").get(productId, accountId, assetHash);
  if (!owned) return false;
  return db.prepare("DELETE FROM publication_locks WHERE platform = 'pinterest' AND account_id = ? AND asset_hash = ? AND owner_product_id = ? AND state = 'reserved'").run(accountId, assetHash, productId).changes === 1;
}

function acquireSchedulerLeases(db, { ownerRunId, accountId, bitWindowId, maxConcurrent = 2, now }) {
  const expires = new Date(Date.parse(now) + 30 * 60 * 1000).toISOString();
  const acquire = db.transaction(() => {
    db.prepare("DELETE FROM scheduler_leases WHERE julianday(expires_at) < julianday(?)").run(now);
    for (const [type, value] of [['account', accountId], ['window', bitWindowId]]) {
      const key = `${type}:${value}`;
      if (db.prepare('SELECT 1 FROM scheduler_leases WHERE lease_key = ?').get(key)) return { acquired: false };
    }
    const slotCount = Math.max(1, Math.min(5, Number(maxConcurrent)));
    let slot = null;
    for (let index = 0; index < slotCount; index += 1) {
      const key = `global_slot:${index}`;
      if (!db.prepare('SELECT 1 FROM scheduler_leases WHERE lease_key = ?').get(key)) { slot = index; break; }
    }
    if (slot === null) return { acquired: false };
    const rows = [
      ['account', `account:${accountId}`, accountId, bitWindowId],
      ['window', `window:${bitWindowId}`, accountId, bitWindowId],
      ['global_slot', `global_slot:${slot}`, accountId, bitWindowId]
    ];
    for (const [type, key, leaseAccount, leaseWindow] of rows) db.prepare('INSERT INTO scheduler_leases (lease_key, lease_type, owner_run_id, account_id, bit_window_id, acquired_at, heartbeat_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(key, type, ownerRunId, leaseAccount, leaseWindow, now, now, expires);
    return { acquired: true, slot };
  });
  return acquire();
}

function releaseSchedulerLeases(db, { ownerRunId, accountId, bitWindowId, slot }) {
  db.prepare('DELETE FROM scheduler_leases WHERE owner_run_id = ? AND lease_key IN (?, ?, ?)').run(ownerRunId, `account:${accountId}`, `window:${bitWindowId}`, `global_slot:${slot ?? -1}`);
}

function heartbeatSchedulerLeases(db, { ownerRunId, now }) {
  const expires = new Date(Date.parse(now) + 30 * 60 * 1000).toISOString();
  return db.prepare('UPDATE scheduler_leases SET heartbeat_at = ?, expires_at = ? WHERE owner_run_id = ?').run(now, expires, ownerRunId).changes;
}

function recoverSchedulerState(db, now = new Date().toISOString()) {
  const result = db.transaction(() => {
    const expired = db.prepare("DELETE FROM scheduler_leases WHERE julianday(expires_at) < julianday(?)").run(now).changes;
    const queued = db.prepare("UPDATE product_tasks SET status = 'queued' WHERE status = 'running'").run().changes;
    return { expired_leases: expired, requeued_tasks: queued };
  })();
  return result;
}

function updateScheduledTask(db, taskId, status, errorMessage = null) {
  const code = errorMessage?.code ?? null;
  const message = typeof errorMessage === 'string' ? errorMessage : errorMessage?.message ?? null;
  db.prepare('UPDATE product_tasks SET status = ?, last_error_code = ?, last_error_message = ? WHERE task_id = ?').run(status, code, message, taskId);
}

function createDryRunAttempt(db, { itemId, taskId, bitWindowId, accountId }) {
  const crypto = require('node:crypto');
  const now = new Date().toISOString();
  return db.transaction(() => {
    db.prepare("UPDATE dry_run_attempts SET status = 'timed_out', current_step = 'timed_out', updated_at = ? WHERE status NOT IN ('ready_before_publish', 'failed', 'timed_out') AND julianday(updated_at) < julianday('now', '-30 minutes')").run(now);
    const active = db.prepare("SELECT attempt_id FROM dry_run_attempts WHERE status NOT IN ('ready_before_publish', 'failed', 'timed_out') AND ((task_id IS NOT NULL AND task_id = ?) OR (task_id IS NULL AND item_id = ?) OR bit_window_id = ?) LIMIT 1").get(taskId ?? null, itemId ?? null, bitWindowId);
    if (active) throw new Error('该任务或窗口已有正在进行的预演。');
    const attemptId = crypto.randomBytes(12).toString('hex');
    db.prepare('INSERT INTO dry_run_attempts (attempt_id, task_id, item_id, bit_window_id, account_id, status, current_step, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(attemptId, taskId ?? null, itemId ?? null, bitWindowId, accountId, 'started', 'started', now, now);
    return { attempt_id: attemptId, task_id: taskId ?? null, item_id: itemId ?? null, status: 'started', current_step: 'started' };
  })();
}

function updateDryRunStep(db, attemptId, step, pageUrl, screenshotPath) {
  db.prepare('UPDATE dry_run_attempts SET status = ?, current_step = ?, page_url = ?, last_screenshot_path = ?, updated_at = ? WHERE attempt_id = ?').run(step, step, pageUrl ?? null, screenshotPath ?? null, new Date().toISOString(), attemptId);
  const next = db.prepare('SELECT COALESCE(MAX(step_index), -1) + 1 AS value FROM dry_run_steps WHERE attempt_id = ?').get(attemptId).value;
  db.prepare('INSERT INTO dry_run_steps (attempt_id, step_index, step, page_url, screenshot_path, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(attemptId, next, step, pageUrl ?? null, screenshotPath ?? null, new Date().toISOString());
}

function finishDryRunAttempt(db, attemptId, { status, pageUrl }) {
  db.prepare('UPDATE dry_run_attempts SET status = ?, current_step = ?, page_url = ?, updated_at = ? WHERE attempt_id = ?').run(status, status, pageUrl ?? null, new Date().toISOString(), attemptId);
}

function failDryRunAttempt(db, attemptId, { code, message, pageUrl, screenshotPath }) {
  db.prepare('UPDATE dry_run_attempts SET status = ?, current_step = ?, page_url = ?, last_screenshot_path = ?, error_code = ?, error_message = ?, updated_at = ? WHERE attempt_id = ?').run('failed', 'failed', pageUrl ?? null, screenshotPath ?? null, code, message, new Date().toISOString(), attemptId);
}

module.exports = { initDatabase, saveBitBrowserWindows, getAccountByWindow, getAccountSnapshot, saveAccountBinding, saveAccountAndBoards, markBoardSyncFailed, getBoards, saveCreatedBoard, saveCreatedBoardAndUpdateItem, updateImportItemBoard, updateProductTaskBoard, validateBoard, canonicalizeBoardQuery, listAccounts, listImportAssetHashes, saveImportPreview, updateImportItem, confirmImportBatch, getImportBatches, getConfirmedImportItem, getDryRunTask, getAccountById, getProductAssetHashes, getProductAssetHashCache, saveProductRun, listProductTasks, listBlockedSchedulerAccounts, blockSchedulerAccount, releasePublicationLock, acquireSchedulerLeases, releaseSchedulerLeases, heartbeatSchedulerLeases, recoverSchedulerState, updateScheduledTask, createDryRunAttempt, updateDryRunStep, finishDryRunAttempt, failDryRunAttempt };
