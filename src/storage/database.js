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
    )
  `);
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
      AND (? IS NULL OR board_name = ?)
      AND (? IS NULL OR board_url = ?)
    LIMIT 1
  `).get(accountId, boardId ?? null, boardId ?? null, boardName ?? null, boardName ?? null, canonicalUrl, canonicalUrl);
  return { valid: Boolean(board), board: board ?? null };
}

module.exports = { initDatabase, saveBitBrowserWindows, getAccountByWindow, getAccountSnapshot, saveAccountBinding, saveAccountAndBoards, markBoardSyncFailed, getBoards, validateBoard, canonicalizeBoardQuery };
