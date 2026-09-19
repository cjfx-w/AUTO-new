const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeRows, hashBuffer } = require('../src/import/batch-preview');

const account = { account_id: 'a1', pinterest_username: 'alice', window_name: '窗口 1' };
const board = { account_id: 'a1', board_id: 'b1', board_name: 'Home Decor', board_url: 'https://www.pinterest.com/alice/home-decor/' };

test('groups valid spreadsheet rows into product batches', () => {
  const result = normalizeRows([
    { product_id: 'P1', product_name: '架子', video_id: 'V1', file_name: 'one.mp4', title: '标题', description: '描述', product_url: 'https://example.com/p1', account_group: 'alice', board: 'Home Decor' },
    { product_id: 'P1', product_name: '架子', video_id: 'V2', file_name: 'two.mp4', title: '标题2', description: '描述2', product_url: 'https://example.com/p1', account_group: 'alice', board: 'Home Decor' }
  ], [{ path: 'C:/media/one.mp4', buffer: Buffer.from('one') }, { path: 'C:/media/two.mp4', buffer: Buffer.from('two') }], [account], new Map([['a1', [board]]]), new Set());
  assert.equal(result.errors.length, 0);
  assert.equal(result.batches.length, 1);
  assert.equal(result.batches[0].items.length, 2);
});

test('reports missing files and unknown Boards', () => {
  const result = normalizeRows([{ product_id: 'P1', product_name: '架子', file_name: 'missing.mp4', account_group: 'alice', board: 'Unknown' }], [], [account], new Map([['a1', [board]]]), new Set());
  assert.equal(result.batches.length, 1);
  assert.equal(result.batches[0].items[0].validation_error.includes('找不到视频文件'), true);
  assert.equal(result.errors.length, 1);
});

test('flags repeated video hashes', () => {
  const buffer = Buffer.from('same');
  const row = { product_id: 'P1', product_name: '架子', file_name: 'one.mp4', title: '标题', description: '描述', product_url: 'https://example.com/p1', account_group: 'alice', board: 'Home Decor' };
  const result = normalizeRows([row, { ...row, product_id: 'P2', product_name: '另一个架子' }], [{ path: 'C:/media/one.mp4', buffer }], [account], new Map([['a1', [board]]]), new Set([hashBuffer(buffer)]));
  assert.equal(result.batches[0].items[0].duplicate, true);
  assert.equal(result.batches[1].items[0].duplicate, true);
});

test('rejects invalid links and conflicting names for one product id', () => {
  const rows = [
    { product_id: 'P1', product_name: '架子', file_name: 'one.mp4', title: '标题', description: '描述', product_url: 'not-a-url', account_group: 'alice', board: 'Home Decor' },
    { product_id: 'P1', product_name: '另一个架子', file_name: 'two.mp4', title: '标题', description: '描述', product_url: 'https://example.com/p1', account_group: 'alice', board: 'Home Decor' }
  ];
  const result = normalizeRows(rows, [{ path: 'C:/media/one.mp4', buffer: Buffer.from('one') }, { path: 'C:/media/two.mp4', buffer: Buffer.from('two') }], [account], new Map([['a1', [board]]]), new Set());
  assert.equal(result.errors.some((error) => error.includes('链接格式')), true);
  assert.equal(result.errors.some((error) => error.includes('多个产品名称')), true);
});
