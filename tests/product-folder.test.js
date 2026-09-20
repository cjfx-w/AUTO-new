const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanProductFolder, buildProductPreview } = require('../src/import/product-folder');

test('scans arbitrary video names recursively and creates video x account tasks', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-product-'));
  fs.mkdirSync(path.join(root, 'sub')); fs.writeFileSync(path.join(root, 'IMG_001.mp4'), 'one'); fs.writeFileSync(path.join(root, 'sub', 'final-video.mov'), 'two');
  const assets = await scanProductFolder(root);
  const accounts = [{ account_id: 'a1', bit_window_id: 'w1', pinterest_username: 'alice' }, { account_id: 'a2', bit_window_id: 'w2', pinterest_username: 'bob' }];
  const preview = buildProductPreview({ productName: '洗发皂', title: '标题', description: '描述', productUrl: '', boardName: '洗发皂', assets, accounts, selectedAccountIds: ['a1', 'a2'] });
  assert.equal(preview.errors.length, 0); assert.equal(preview.task_count, 4); assert.equal(preview.assets.length, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

test('accepts an absolute folder path from the native directory picker', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-native-folder-'));
  fs.writeFileSync(path.join(root, 'product-video.mp4'), 'video');
  const assets = await scanProductFolder(root);
  assert.equal(path.isAbsolute(assets[0].file_path), true);
  assert.equal(assets[0].relative_path, 'product-video.mp4');
  fs.rmSync(root, { recursive: true, force: true });
});

test('rejects invalid product folder fields', () => {
  const result = buildProductPreview({ productName: '', title: '', description: '', productUrl: 'not-url', boardName: '', assets: [], accounts: [], selectedAccountIds: [] });
  assert.equal(result.errors.length >= 5, true);
});

test('marks same-content videos as duplicate for the same account', () => {
  const assets = [{ asset_id: '1', asset_hash: 'same', file_name: 'a.mp4', relative_path: 'a.mp4', file_path: 'a', file_size: 1, modified_at: 'now' }, { asset_id: '2', asset_hash: 'same', file_name: 'b.mp4', relative_path: 'b.mp4', file_path: 'b', file_size: 1, modified_at: 'now' }];
  const result = buildProductPreview({ productName: 'P', title: 'T', description: 'D', boardName: 'P', assets, accounts: [{ account_id: 'a1', bit_window_id: 'w1' }], selectedAccountIds: ['a1'] });
  assert.equal(result.task_count, 1); assert.equal(result.duplicate_count, 1);
});
