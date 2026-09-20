const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm']);
const MAX_FILES = 500;

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function scanFiles(root, current = root, depth = 0, output = []) {
  if (depth > 20) throw new Error('产品视频目录层级过深。');
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const fullPath = path.join(current, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) scanFiles(root, fullPath, depth + 1, output);
    else if (VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) output.push(fullPath);
  }
  return output;
}

async function scanProductFolder(folderPath, { hashCache = new Map() } = {}) {
  if (!folderPath || !path.isAbsolute(folderPath)) throw new Error('请选择有效的视频文件夹。');
  if (fs.lstatSync(folderPath).isSymbolicLink()) throw new Error('产品文件夹不能是符号链接。');
  const root = fs.realpathSync(folderPath);
  const files = scanFiles(root);
  if (!files.length) throw new Error('文件夹中没有发现支持的视频文件。');
  if (files.length > MAX_FILES) throw new Error(`视频数量超过限制（最多 ${MAX_FILES} 个）。`);
  const assets = [];
  for (const filePath of files) {
    const stat = fs.statSync(filePath);
    const cacheKey = `${filePath}:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
    const assetHash = hashCache.get(cacheKey) ?? await hashFile(filePath);
    assets.push({
      asset_id: crypto.createHash('sha256').update(filePath).digest('hex').slice(0, 24),
      asset_hash: assetHash,
      file_name: path.basename(filePath),
      relative_path: path.relative(root, filePath),
      file_path: filePath,
      file_size: stat.size,
      modified_at: stat.mtime.toISOString()
    });
  }
  return assets;
}

function buildProductPreview({ productName, title, description, productUrl = '', boardName, assets, accounts, selectedAccountIds, existingHashes = new Set(), boardsByAccount = new Map() }) {
  const errors = [];
  if (!productName?.trim()) errors.push('产品名称不能为空。');
  if (!title?.trim()) errors.push('Pin 标题不能为空。');
  if (!description?.trim()) errors.push('Pin 描述不能为空。');
  if (productUrl && !/^https?:\/\/[^\s]+$/i.test(productUrl)) errors.push('产品链接格式不正确。');
  if (!boardName?.trim()) errors.push('Board 名称不能为空。');
  const selected = accounts.filter((account) => selectedAccountIds.includes(account.account_id));
  if (!selected.length) errors.push('至少选择一个 Pinterest 账号。');
  const seenRunHashes = new Set();
  const tasks = assets.flatMap((asset) => selected.map((account) => {
    const board = (boardsByAccount.get(account.account_id) ?? []).find((candidate) => candidate.board_name.toLowerCase() === boardName.toLowerCase());
    const lockKey = `${account.account_id}:${asset.asset_hash}`;
    const duplicate = existingHashes.has(lockKey) || seenRunHashes.has(lockKey);
    seenRunHashes.add(lockKey);
    return { asset, account_id: account.account_id, bit_window_id: account.bit_window_id, account_username: account.pinterest_username, window_name: account.window_name, pinterest_profile_url: account.pinterest_profile_url ?? null, verification_state: account.verification_state ?? null, board_sync_state: account.board_sync_state ?? null, last_board_checked_at: account.last_board_checked_at ?? null, board_id: board?.board_id ?? null, board_url: board?.board_url ?? null, board_name: boardName, title, description, product_url: productUrl, duplicate };
  }));
  return { errors, selected_accounts: selected, assets, tasks, task_count: tasks.filter((task) => !task.duplicate).length, duplicate_count: tasks.filter((task) => task.duplicate).length };
}

module.exports = { VIDEO_EXTENSIONS, scanProductFolder, buildProductPreview };
