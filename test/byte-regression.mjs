#!/usr/bin/env node
/**
 * byte-regression.mjs — 字节级回归：改一个定长值，除目标字节外文件必须完全不变。
 *
 * 这是整个引擎最重要的不变量。原工具在这里翻过车（结构体数组错位），
 * 所以单独成测：任何改动导致多余字节变化，都说明回写逻辑出了问题。
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Package } from '../src/core/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(root, 'test/fixtures/TestAsset.uasset');

if (!fs.existsSync(fixture)) {
  console.error('缺少夹具，先运行: node scripts/make-fixture.mjs');
  process.exit(1);
}

function diffOffsets(a, b) {
  const out = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) out.push(i);
  return out;
}

// ---- 用例 1：改 FloatProperty，只允许目标 4 字节变化 ----
{
  const origUexp = fs.readFileSync(path.join(root, 'test/fixtures/TestAsset.uexp'));
  const pkg = await Package.fromFile(fixture);
  const before = pkg.get('Default__TestAsset_C.TestFloat').value;
  pkg.set('Default__TestAsset_C.TestFloat', 9.75);
  const out = pkg.save();

  assert.deepStrictEqual(out.verification.problems, [], '保存自检必须无问题');
  const newUexp = Buffer.from(out.uexp);
  assert.strictEqual(newUexp.length, origUexp.length, '定长编辑不能改变文件大小');

  const d = diffOffsets(origUexp, newUexp);
  assert.ok(d.length > 0, '值必须真的被改了');
  assert.ok(d.length <= 4, `定长编辑最多动 4 字节，实际动了 ${d.length} 字节 @ ${d.slice(0, 8)}`);
  assert.strictEqual(before, 1.5, '初始值应为 1.5');

  // 重载确认
  const tmp = '/tmp/_byte_reg.uasset';
  fs.writeFileSync(tmp, Buffer.from(out.uasset));
  fs.writeFileSync('/tmp/_byte_reg.uexp', newUexp);
  const re = await Package.fromFile(tmp);
  assert.strictEqual(re.get('Default__TestAsset_C.TestFloat').value, 9.75, '重载后应为新值');
  console.log('✓ 定长编辑：仅 %d 字节变化，重载读回 9.75', d.length);
}

// ---- 用例 2：改 Bool，只允许目标 1 字节变化 ----
{
  const origUexp = fs.readFileSync(path.join(root, 'test/fixtures/TestAsset.uexp'));
  const pkg = await Package.fromFile(fixture);
  pkg.set('Default__TestAsset_C.TestBool', false);
  const out = pkg.save();
  const d = diffOffsets(origUexp, Buffer.from(out.uexp));
  assert.ok(d.length <= 1, `布尔编辑最多动 1 字节，实际 ${d.length}`);
  console.log('✓ 布尔编辑：仅 %d 字节变化', d.length);
}

// ---- 用例 3：改 Int，只允许目标 4 字节变化 ----
{
  const origUexp = fs.readFileSync(path.join(root, 'test/fixtures/TestAsset.uexp'));
  const pkg = await Package.fromFile(fixture);
  pkg.set('Default__TestAsset_C.TestInt', -7);
  const out = pkg.save();
  const d = diffOffsets(origUexp, Buffer.from(out.uexp));
  assert.ok(d.length <= 4, `整型编辑最多动 4 字节，实际 ${d.length}`);
  console.log('✓ 整型编辑：仅 %d 字节变化', d.length);
}

// ---- 用例 4：改结构体分量（Vector.x），只动 4 字节 ----
{
  const origUexp = fs.readFileSync(path.join(root, 'test/fixtures/TestAsset.uexp'));
  const pkg = await Package.fromFile(fixture);
  const r = pkg.set('Default__TestAsset_C.TestVector.x', 5.5);
  const out = pkg.save();
  const d = diffOffsets(origUexp, Buffer.from(out.uexp));
  assert.ok(d.length <= 4, `结构体分量编辑最多动 4 字节，实际 ${d.length} (mode=${r.mode})`);
  console.log('✓ 结构体分量：仅 %d 字节变化（mode=%s）', d.length, r.mode);
}

// ---- 用例 5：改字符串（变长）必须重建且自检通过 ----
{
  const pkg = await Package.fromFile(fixture);
  pkg.set('Default__TestAsset_C.TestString', 'A_Much_Longer_String_Value');
  const out = pkg.save();
  assert.deepStrictEqual(out.verification.problems, [], '变长编辑自检必须通过');
  assert.ok(Buffer.from(out.uexp).length > 194, '变长字符串应让 uexp 变大');
  fs.writeFileSync('/tmp/_byte_reg5.uasset', Buffer.from(out.uasset));
  fs.writeFileSync('/tmp/_byte_reg5.uexp', Buffer.from(out.uexp));
  const re = await Package.fromFile('/tmp/_byte_reg5.uasset');
  assert.strictEqual(re.get('Default__TestAsset_C.TestString').value, 'A_Much_Longer_String_Value');
  console.log('✓ 变长字符串：uexp 194 → %d，重载读回正确', Buffer.from(out.uexp).length);
}

console.log('\n字节级回归全部通过');
