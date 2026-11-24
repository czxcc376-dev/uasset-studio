#!/usr/bin/env node
/**
 * pak.test.mjs — pak 归档往返测试（不依赖外部 pak 文件）
 *
 * 做法：用 Pak 自己写一个 pak，再用自己读回，验证索引格式自洽；
 * 然后替换条目、压缩重建，确认其余条目字节不变。
 */
import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Pak } from '../src/core/pak.js';

const files = [
  { name: '../../../Game/Content/A.uasset', data: Buffer.from('uasset-payload-'.repeat(80)) },
  { name: '../../../Game/Content/A.uexp', data: Buffer.from('uexp-payload-'.repeat(120)) },
  { name: '../../../Game/Content/B.uasset', data: crypto.randomBytes(512) },
  { name: '../../../Game/Config/Default.ini', data: Buffer.from('[Core]\nValue=1\n') },
];

// ---- 1. 建包 → 读回 ----
const blank = new Pak(Buffer.alloc(0));
blank.version = 8;
blank.mountPoint = '../../../';
blank.entries = [];
const built = blank.rebuildWith(files, { compression: 0 });
fs.writeFileSync('/tmp/_pak_test.pak', built);

const pak = Pak.fromBuffer(fs.readFileSync('/tmp/_pak_test.pak'));
assert.strictEqual(pak.entries.length, files.length, '条目数应一致');
for (const f of files) {
  const got = pak.read(f.name).data;
  assert.strictEqual(Buffer.compare(got, f.data), 0, `${f.name} 往返字节应一致`);
}
console.log('✓ 建包/读回：%d 个条目全部一致', files.length);

// ---- 2. list / find ----
const listed = pak.list({ filter: '\\.uasset$' });
assert.strictEqual(listed.total, 2, 'uasset 条目应有 2 个');
assert.ok(pak.find('A.uexp').length >= 1, 'find 子串应命中');
assert.strictEqual(pak.find('../../../Game/Content/A.uexp').length, 1, 'find 精确名应命中 1 个');
console.log('✓ list/find：过滤与查找正常');

// ---- 3. 替换一个条目 → 其余不变 ----
const replacement = Buffer.from('REPLACED-CONTENT-0123456789');
const rebuilt = pak.rebuildWith([{ name: files[0].name, data: replacement }], { compression: 0 });
fs.writeFileSync('/tmp/_pak_test2.pak', rebuilt);
const pak2 = Pak.fromBuffer(fs.readFileSync('/tmp/_pak_test2.pak'));
assert.strictEqual(pak2.read(files[0].name).data.toString(), replacement.toString(), '被替换条目应是新内容');
for (const f of files.slice(1)) {
  assert.strictEqual(Buffer.compare(pak2.read(f.name).data, f.data), 0, `${f.name} 应保持不变`);
}
console.log('✓ 替换条目：目标更新，其余 %d 个条目字节不变', files.length - 1);

// ---- 4. 压缩重建 ----
const compressed = pak.rebuildWith([], { compression: 1 });
fs.writeFileSync('/tmp/_pak_test3.pak', compressed);
const pak3 = Pak.fromBuffer(fs.readFileSync('/tmp/_pak_test3.pak'));
assert.ok(pak3.info().compressed > 0, '应有压缩条目');
for (const f of files) {
  assert.strictEqual(Buffer.compare(pak3.read(f.name).data, f.data), 0, `压缩往返 ${f.name} 应一致`);
}
assert.ok(compressed.length < built.length, '可压缩内容应让 pak 变小');
console.log('✓ 压缩重建：%d → %d 字节，%d 个条目压缩，解压后全部一致', built.length, compressed.length, pak3.info().compressed);

// ---- 5. 新增条目 ----
const withNew = pak.rebuildWith([{ name: '../../../Game/New.uasset', data: Buffer.from('brand-new') }], { compression: 0 });
const pak4 = Pak.fromBuffer(withNew);
assert.strictEqual(pak4.entries.length, files.length + 1, '应多一个条目');
assert.strictEqual(pak4.read('../../../Game/New.uasset').data.toString(), 'brand-new');
console.log('✓ 新增条目：%d → %d 个', files.length, pak4.entries.length);

// ---- 6. 加密 pak 无 key 必须明确报错 ----
{
  const enc = Buffer.from(built);
  const footerPos = enc.length - 45;
  enc.writeUInt8(1, footerPos + 44); // 标记 encrypted
  assert.throws(
    () => Pak.fromBuffer(enc),
    /需要 32 字节 AES key/,
    '加密 pak 无 key 应报明确错误'
  );
  console.log('✓ 加密 pak：无 key 时给出明确错误而非静默失败');
}

console.log('\npak 测试全部通过');
