const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm']);
const MAX_VIDEO_BYTES = 512 * 1024 * 1024;
const MAX_VIDEO_COUNT = 500;
const MAX_TOTAL_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_SCAN_DEPTH = 20;
const MAX_WORKBOOK_BYTES = 50 * 1024 * 1024;
const MAX_WORKBOOK_ROWS = 10000;
const FIELD_ALIASES = {
  product_id: ['product_id', 'productId', '产品编号', '产品ID'],
  product_name: ['product_name', 'productName', '产品名称'],
  video_id: ['video_id', 'videoId', '视频编号'],
  file_name: ['file_name', 'fileName', '文件名', '视频文件名'],
  title: ['title', '标题'],
  description: ['description', '描述'],
  product_url: ['product_url', 'productUrl', '产品链接', '链接'],
  account_group: ['account_group', 'accountGroup', '账号组', '账号'],
  board: ['board', 'Board', '看板']
};

function valueFromRow(row, field) {
  for (const key of FIELD_ALIASES[field]) {
    if (row[key] !== undefined && row[key] !== null) return String(row[key]).trim();
  }
  return '';
}

function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function isValidHttpUrl(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && Boolean(url.hostname); } catch { return false; }
}

function normalizeBoardReference(value) {
  try {
    const url = new URL(value);
    if (!/(^|\.)pinterest\.com$/i.test(url.hostname)) return String(value ?? '').toLowerCase();
    url.protocol = 'https:'; url.hostname = 'www.pinterest.com'; url.search = ''; url.hash = '';
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
    return url.toString().toLowerCase();
  } catch { return String(value ?? '').toLowerCase(); }
}

function listVideoFiles(mediaDir, depth = 0) {
  if (depth > MAX_SCAN_DEPTH) throw new Error('media 目录层级过深。');
  if (!fs.existsSync(mediaDir)) return [];
  return fs.readdirSync(mediaDir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(mediaDir, entry.name);
    if (entry.isDirectory()) return listVideoFiles(fullPath, depth + 1);
    if (entry.isSymbolicLink()) return [];
    return VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) ? [fullPath] : [];
  });
}

function parseWorkbook(buffer, xlsx = require('xlsx')) {
  if (buffer.length > MAX_WORKBOOK_BYTES) throw new Error('pins.xlsx 文件过大。');
  const workbook = xlsx.read(buffer, { type: 'buffer' });
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!firstSheet) throw new Error('pins.xlsx 没有可读取的工作表。');
  const rows = xlsx.utils.sheet_to_json(firstSheet, { defval: '' });
  if (!rows.length) throw new Error('pins.xlsx 没有数据行。');
  const headers = Object.keys(rows[0]);
  const hasField = (field) => FIELD_ALIASES[field].some((alias) => headers.includes(alias));
  if (!hasField('product_id') || !hasField('product_name') || !hasField('file_name')) throw new Error('pins.xlsx 缺少必需表头：产品编号、产品名称或文件名。');
  if (rows.length > MAX_WORKBOOK_ROWS) throw new Error(`pins.xlsx 行数超过限制（最多 ${MAX_WORKBOOK_ROWS} 行）。`);
  return rows;
}

function accountMatches(account, value) {
  return account && [account.account_id, account.pinterest_username, account.window_name].some((candidate) => candidate && candidate.toLowerCase() === value.toLowerCase());
}

function boardMatches(board, value) {
  const reference = normalizeBoardReference(value);
  return board && [board.board_id, board.board_name, board.board_url].some((candidate) => candidate && normalizeBoardReference(candidate) === reference);
}

function normalizeRows(rows, videoFiles, accounts = [], boardsByAccount = new Map(), existingHashes = new Set()) {
  const filesByName = new Map();
  for (const file of videoFiles) {
    const key = path.basename(file.path).toLowerCase();
    if (!filesByName.has(key)) filesByName.set(key, []);
    filesByName.get(key).push(file);
  }
  const knownHashes = new Set(existingHashes);
  const errors = [];
  const batches = new Map();
  for (const [index, row] of rows.entries()) {
    const normalized = Object.fromEntries(Object.keys(FIELD_ALIASES).map((field) => [field, valueFromRow(row, field)]));
    if (!normalized.product_id || !normalized.product_name || !normalized.file_name) {
      const invalidId = normalized.product_id || `__invalid_${index + 2}`;
      const invalidItem = { product_id: invalidId, product_name: normalized.product_name || '无效产品行', video_id: normalized.video_id, file_name: normalized.file_name || `第 ${index + 2} 行`, file_path: '', title: normalized.title, description: normalized.description, product_url: normalized.product_url, account_group: normalized.account_group, board: normalized.board, account_id: null, board_id: null, asset_hash: `invalid-${index}`, duplicate: true, validation_error: '缺少产品编号、产品名称或文件名' };
      errors.push(`第 ${index + 2} 行缺少产品编号、产品名称或文件名。`);
      if (!batches.has(invalidId)) batches.set(invalidId, { product_id: invalidId, product_name: invalidItem.product_name, status: 'pending_confirmation', items: [] });
      batches.get(invalidId).items.push(invalidItem);
      continue;
    }
    const addInvalidItem = (message) => {
      errors.push(`第 ${index + 2} 行${message}`);
      const invalidItem = {
        product_id: normalized.product_id,
        product_name: normalized.product_name,
        video_id: normalized.video_id,
        file_name: normalized.file_name,
        file_path: '',
        title: normalized.title,
        description: normalized.description,
        product_url: normalized.product_url,
        account_group: normalized.account_group,
        board: normalized.board,
        account_id: null,
        board_id: null,
        asset_hash: `invalid-${index}`,
        duplicate: true,
        validation_error: message
      };
      if (!batches.has(invalidItem.product_id)) batches.set(invalidItem.product_id, { product_id: invalidItem.product_id, product_name: invalidItem.product_name, status: 'pending_confirmation', items: [] });
      batches.get(invalidItem.product_id).items.push(invalidItem);
    };
    const matchingFiles = filesByName.get(normalized.file_name.toLowerCase()) ?? [];
    if (!matchingFiles.length) {
      addInvalidItem(`找不到视频文件：${normalized.file_name}`);
      continue;
    }
    if (matchingFiles.length > 1) {
      addInvalidItem(`视频文件名存在多个匹配：${normalized.file_name}`);
      continue;
    }
    const file = matchingFiles[0];
    const account = accounts.find((item) => accountMatches(item, normalized.account_group));
    const rowErrors = [];
    if (normalized.product_url && !isValidHttpUrl(normalized.product_url)) rowErrors.push('产品链接格式不正确');
    if (!normalized.title) rowErrors.push('标题不能为空');
    if (!normalized.description) rowErrors.push('描述不能为空');
    if (!account) rowErrors.push(`账号组无法匹配：${normalized.account_group || '未填写'}`);
    const boards = account ? (boardsByAccount.get(account.account_id) ?? []) : [];
    const board = boards.find((item) => boardMatches(item, normalized.board));
    if (!board) rowErrors.push(`Board 无法匹配：${normalized.board || '未填写'}`);
    for (const rowError of rowErrors) errors.push(`第 ${index + 2} 行${rowError}。`);
    const assetHash = file.hash ?? hashBuffer(file.buffer);
    const duplicate = knownHashes.has(assetHash);
    knownHashes.add(assetHash);
    const item = {
      product_id: normalized.product_id,
      product_name: normalized.product_name,
      video_id: normalized.video_id,
      file_name: normalized.file_name,
      file_path: file.path,
      title: normalized.title,
      description: normalized.description,
      product_url: normalized.product_url,
      account_group: normalized.account_group,
      board: board?.board_name ?? normalized.board,
      account_id: account?.account_id ?? null,
      board_id: board?.board_id ?? null,
      asset_hash: assetHash,
      duplicate,
      validation_error: rowErrors.join('；')
    };
    if (batches.has(item.product_id) && batches.get(item.product_id).product_name !== item.product_name) {
      errors.push(`第 ${index + 2} 行产品编号对应了多个产品名称：${item.product_id}`);
      item.validation_error = [item.validation_error, '产品名称冲突'].filter(Boolean).join('；');
    }
    if (batches.has(item.product_id) && batches.get(item.product_id).items[0]?.product_url !== item.product_url) {
      errors.push(`第 ${index + 2} 行同一产品编号对应了多个产品链接：${item.product_id}`);
      item.validation_error = [item.validation_error, '产品链接冲突'].filter(Boolean).join('；');
    }
    if (!batches.has(item.product_id)) batches.set(item.product_id, { product_id: item.product_id, product_name: item.product_name, status: 'pending_confirmation', items: [] });
    batches.get(item.product_id).items.push(item);
  }
  return { batches: [...batches.values()], errors };
}

async function buildImportPreview({ folderPath, accounts = [], boardsByAccount = new Map(), existingHashes = new Set(), xlsx } = {}) {
  if (!folderPath || !path.isAbsolute(folderPath)) throw new Error('请选择有效的产品文件夹。');
  if (fs.lstatSync(folderPath).isSymbolicLink()) throw new Error('产品文件夹不能是符号链接。');
  const rootPath = fs.realpathSync(folderPath);
  const workbookPath = path.join(folderPath, 'pins.xlsx');
  if (!fs.existsSync(workbookPath)) throw new Error('产品文件夹中没有找到 pins.xlsx。');
  if (fs.lstatSync(workbookPath).isSymbolicLink()) throw new Error('pins.xlsx 不能是符号链接。');
  const mediaPath = path.join(folderPath, 'media');
  if (fs.existsSync(mediaPath) && fs.lstatSync(mediaPath).isSymbolicLink()) throw new Error('media 目录不能是符号链接。');
  const videoPaths = listVideoFiles(mediaPath);
  if (videoPaths.length > MAX_VIDEO_COUNT) throw new Error(`视频文件数量超过限制（最多 ${MAX_VIDEO_COUNT} 个）。`);
  let totalBytes = 0;
  const videoFiles = [];
  for (const filePath of videoPaths) {
    const realPath = fs.realpathSync(filePath);
    const relative = path.relative(rootPath, realPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('视频文件必须位于所选产品文件夹内。');
    const size = fs.statSync(realPath).size;
    if (size > MAX_VIDEO_BYTES) throw new Error(`视频文件过大：${path.basename(filePath)}`);
    totalBytes += size;
    if (totalBytes > MAX_TOTAL_VIDEO_BYTES) throw new Error('视频素材总大小超过限制。');
    videoFiles.push({ path: realPath, hash: await hashFile(realPath) });
  }
  if (fs.statSync(workbookPath).size > MAX_WORKBOOK_BYTES) throw new Error('pins.xlsx 文件过大。');
  const rows = parseWorkbook(fs.readFileSync(workbookPath), xlsx);
  return { folderPath, ...normalizeRows(rows, videoFiles, accounts, boardsByAccount, existingHashes), videoCount: videoFiles.length };
}

module.exports = { VIDEO_EXTENSIONS, hashBuffer, isValidHttpUrl, parseWorkbook, normalizeRows, buildImportPreview };
