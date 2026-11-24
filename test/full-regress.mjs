import { Package, Pak } from '../src/core/index.js';
import { Pak as P } from '../src/core/pak.js';
import fs from 'node:fs';
import crypto from 'node:crypto';

const A = process.argv[2] || '/tmp/real.uasset';
const log = (...a) => console.log(...a);
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { ok ? (pass++, log('  ✓', name, extra)) : (fail++, log('  ✗', name, extra)); };

// ---- 1. 真实资产：只改一个 float，检查字节影响面 ----
log('\n[1] 真实资产 定长编辑');
{
  const orig = fs.readFileSync('/tmp/real.uexp');
  const pkg = await Package.fromFile(A);
  const P1 = 'Default__BP_Rifle_AUG_C.MagDropDownDelay';
  const before = pkg.get(P1).value;
  pkg.set(P1, 0.75);
  const out = pkg.save();
  const nb = Buffer.from(out.uexp);
  let d = []; for (let i = 0; i < orig.length; i++) if (orig[i] !== nb[i]) d.push(i);
  check('文件大小不变', nb.length === orig.length, `${orig.length}`);
  check('只动目标字节', d.length <= 4, `${d.length} 字节 @ ${d.slice(0,6)}`);
  check('自检通过', out.verification.problems.length === 0, JSON.stringify(out.verification.problems));
  check('重建 1 个 / 复制 22 个', out.report.rebuilt === 1 && out.report.copied === 22, `rebuilt=${out.report.rebuilt} copied=${out.report.copied}`);
  fs.writeFileSync('/tmp/r1.uasset', Buffer.from(out.uasset));
  fs.writeFileSync('/tmp/r1.uexp', nb);
  const re = await Package.fromFile('/tmp/r1.uasset');
  check('重载读回', re.get(P1).value === Math.fround(0.75), String(re.get(P1).value));
}

// ---- 2. 嵌套结构体数组（原工具错位的地方）----
log('\n[2] 嵌套变长结构体数组');
{
  const pkg = await Package.fromFile(A);
  pkg.parseExport(3);
  const arr = pkg.exports[3].properties.find(p => p.name === 'WeaponAttrModifyConfigList');
  const n = arr.value.length;
  check('8 个元素全部解析（非原始块）', n === 8 && arr.value.every(e => Array.isArray(e) && e.length > 0), `${n} 个`);
  check('header 识别为总长格式', arr.arrayStructInfo.originalHeaderSize === 2317, String(arr.arrayStructInfo.originalHeaderSize));
  const P2 = 'Default__BP_Rifle_AUG_C.WeaponAttrModifyConfigList[3].WeaponAttrModifiers[0].ModifyValue';
  const v0 = pkg.get(P2).value;
  pkg.set(P2, 0.123);
  const out = pkg.save();
  check('改嵌套元素后自检通过', out.verification.problems.length === 0, JSON.stringify(out.verification.problems));
  fs.writeFileSync('/tmp/r2.uasset', Buffer.from(out.uasset));
  fs.writeFileSync('/tmp/r2.uexp', Buffer.from(out.uexp));
  const re = await Package.fromFile('/tmp/r2.uasset');
  check('重载读回嵌套值', re.get(P2).value === Math.fround(0.123), `${v0} -> ${re.get(P2).value}`);
}

// ---- 3. 名称表扩容 ----
log('\n[3] 名称表扩容 + 偏移修正');
{
  const pkg = await Package.fromFile(A);
  const n0 = pkg.names.length, ths0 = pkg.header.totalHeaderSize;
  pkg.set('Default__BP_Rifle_AUG_C.WeaponAttrModifyConfigList[0].WeaponAttrModifiers[0].ModifyAttr',
          'AVeryLongNewAttributeNameForRegressionTest');
  const out = pkg.save();
  const re = await Package.fromFile('/tmp/r3.uasset').catch(async () => {
    fs.writeFileSync('/tmp/r3.uasset', Buffer.from(out.uasset));
    fs.writeFileSync('/tmp/r3.uexp', Buffer.from(out.uexp));
    return Package.fromFile('/tmp/r3.uasset');
  });
  check('名称数不变', re.names.length === n0, `${n0}`);
  check('totalHeaderSize 不变', re.header.totalHeaderSize === ths0, `${ths0}`);
  check('值写入成功', re.get('Default__BP_Rifle_AUG_C.WeaponAttrModifyConfigList[0].WeaponAttrModifiers[0].ModifyAttr').value === 'AVeryLongNewAttributeNameForRegressionTest');
  check('所有导出偏移仍在有效范围', re.exports.every(e => e.serialOffset >= re.header.totalHeaderSize));
}

// ---- 4. 批量改值（dryRun 不落地）----
log('\n[4] 批量改值');
{
  const { callTool } = await import('../src/mcp/tools.js');
  const o = await callTool('uasset_open', { uassetPath: A });
  const dry = await callTool('uasset_set_by_query', { session: o.session, namePattern: 'ModifyValue', type: 'FloatProperty', scale: 0.5, dryRun: true, limit: 4 });
  check('dryRun 匹配到目标', dry.matched > 0, `${dry.matched} 条`);
  check('dryRun 未实际写入', dry.results.every(r => r.applied === false));
  const real = await callTool('uasset_set_by_query', { session: o.session, namePattern: 'ModifyValue', type: 'FloatProperty', scale: 0.5, limit: 4 });
  check('实际写入', real.applied > 0, `${real.applied} 条`);
  const sv = await callTool('uasset_save', { session: o.session, outDir: '/tmp/r4' });
  check('批量后保存成功', !!sv.uassetPath, sv.uassetPath);
}

// ---- 5. pak 端到端：把改后的资产打进包再读回 ----
log('\n[5] pak 端到端');
{
  const files = [
    { name: '../../../Game/Content/BP_Rifle_AUG.uasset', data: fs.readFileSync('/tmp/r1.uasset') },
    { name: '../../../Game/Content/BP_Rifle_AUG.uexp', data: fs.readFileSync('/tmp/r1.uexp') },
  ];
  const blank = new P(Buffer.alloc(0));
  blank.version = 8; blank.mountPoint = '../../../'; blank.entries = [];
  const built = blank.rebuildWith(files, { compression: 1 });
  fs.writeFileSync('/tmp/r5.pak', built);
  const pak = P.fromBuffer(fs.readFileSync('/tmp/r5.pak'));
  check('pak 建包并读回', pak.entries.length === 2 && Buffer.compare(pak.read(files[0].name).data, files[0].data) === 0);
  check('pak 压缩生效', pak.info().compressed === 2, `compressed=${pak.info().compressed}`);

  // 从包里取资产 → 解析 → 确认是改过的值
  const extracted = pak.read(files[0].name).data;
  fs.writeFileSync('/tmp/r5.uasset', extracted);
  fs.writeFileSync('/tmp/r5.uexp', pak.read(files[1].name).data);
  const re = await Package.fromFile('/tmp/r5.uasset');
  check('包内资产可解析且值正确', re.get('Default__BP_Rifle_AUG_C.MagDropDownDelay').value === Math.fround(0.75), String(re.get('Default__BP_Rifle_AUG_C.MagDropDownDelay').value));
}

log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
