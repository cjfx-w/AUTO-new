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
    )
  `);
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

module.exports = { initDatabase, saveBitBrowserWindows };
