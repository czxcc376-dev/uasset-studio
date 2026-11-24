#!/usr/bin/env node
/**
 * e2e.mjs — 端到端：解析 → 读 → 改 → 保存 → 自检 → 重载
 *
 * 默认跑 CI 夹具（test/fixtures/TestAsset.uasset）。
 * 传入真实资产路径则跑真实资产：
 *   node test/e2e.mjs /path/BP_XXX.uasset
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Package } from '../src/core/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetPath = process.argv[2] || path.join(root, 'test/fixtures/TestAsset.uasset');
const isFixture = assetPath.includes('fixtures');

if (!fs.existsSync(assetPath)) {
  console.error('资产不存在: %s', assetPath);
  console.error('若是 CI 环境，先运行: node scripts/make-fixture.mjs');
  process.exit(1);
}

const pkg = await Package.fromFile(assetPath);
const info = pkg.info();
console.log('资产: %s', info.name);
console.log('  引擎: UE4 v%d%s', info.engine.fileVersionUE4, info.engine.fileVersionUE5 ? ` / UE5 v${info.engine.fileVersionUE5}` : '');
console.log('  表: 名称 %d / 导入 %d / 导出 %d', info.tables.names, info.tables.imports, info.tables.exports);
console.log('  大小: uasset %d%s', info.sizes.uasset, info.sizes.uexp ? ` + uexp ${info.sizes.uexp}` : '');

assert.ok(info.tables.exports > 0, '导出表不能为空');
assert.ok(info.tables.names > 0, '名称表不能为空');

// 选第一个有属性的导出作为目标
const target = pkg.exportList({ limit: 50 }).items.find((e) => e.serialSize > 0);
assert.ok(target, '至少要有一个非空导出');
console.log('目标导出: %s (#%d, %d 字节)', target.name, target.index, target.serialSize);

const props = pkg.parseExport(target.index);
assert.ok(Array.isArray(props) && props.length > 0, '目标导出应能解析出属性');
console.log('属性数: %d', props.length);

// 找一个可定长编辑的数值属性
const numeric = props.find((p) => p.type === 'FloatProperty' || p.type === 'IntProperty');
if (numeric) {
  const p = `${target.name}.${numeric.name}`;
  const before = pkg.get(p).value;
  const next = numeric.type === 'FloatProperty' ? before + 0.25 : before + 1;
  const r = pkg.set(p, next);
  console.log('改值: %s  %s → %s  (mode=%s)', p, r.before, r.after, r.mode || 'rebuild');
  assert.strictEqual(pkg.get(p).value, next, '内存中的值应立即更新');
}

const saved = pkg.save();
assert.deepStrictEqual(saved.verification.problems, [], `保存自检不应有问题: ${saved.verification.problems}`);
console.log('保存: uasset %d, uexp %d, 重建 %d / 复制 %d / 失败 %d',
  saved.report.sizes.uasset, saved.report.sizes.uexp || 0,
  saved.report.rebuilt, saved.report.copied, saved.report.failed);
assert.strictEqual(saved.report.failed, 0, '不应有导出重建失败');

// 写盘并重载，确认真的能读回来
const outU = '/tmp/_e2e.uasset';
const outE = '/tmp/_e2e.uexp';
fs.writeFileSync(outU, Buffer.from(saved.uasset));
if (saved.uexp) fs.writeFileSync(outE, Buffer.from(saved.uexp));

const re = await Package.fromFile(outU);
assert.strictEqual(re.exports.length, pkg.exports.length, '重载后导出数应一致');
if (numeric) {
  const p = `${target.name}.${numeric.name}`;
  const back = re.get(p).value;
  assert.strictEqual(back, pkg.get(p).value, '重载后读回的值应与写入一致');
  console.log('重载: %s = %s ✓', p, back);
}

// 名称表扩容路径（只在夹具上做，真实资产保持最小改动）
if (isFixture) {
  const before = re.names.length;
  re.set(`${target.name}.TestString`, 'A_Longer_String_To_Force_Rebuild');
  const s2 = re.save();
  assert.deepStrictEqual(s2.verification.problems, [], '变长编辑自检应通过');
  fs.writeFileSync('/tmp/_e2e2.uasset', Buffer.from(s2.uasset));
  fs.writeFileSync('/tmp/_e2e2.uexp', Buffer.from(s2.uexp));
  const re2 = await Package.fromFile('/tmp/_e2e2.uasset');
  assert.strictEqual(re2.get(`${target.name}.TestString`).value, 'A_Longer_String_To_Force_Rebuild');
  console.log('变长编辑: 名称 %d → %d，uexp %d → %d，读回正确 ✓',
    before, re2.names.length, saved.report.sizes.uexp, s2.report.sizes.uexp);
}

console.log('\n端到端通过');
