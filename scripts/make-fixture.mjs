#!/usr/bin/env node
/**
 * make-fixture.mjs — 生成测试夹具。
 *
 * CI 里没有真实 UE 资产（体积与版权原因不入库），所以这里**手工构造**一个
 * 最小但结构完整的 .uasset + .uexp：包头 + 名称表 + 导入表 + 导出表 + 属性。
 * 它不是从某个游戏里拷出来的，而是按 UE4 序列化格式逐字段写出来的，
 * 用于验证解析器与回写器在已知字节上的行为。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'test/fixtures');
fs.mkdirSync(outDir, { recursive: true });

class W {
  constructor(n = 4096) { this.buf = Buffer.alloc(n); this.p = 0; }
  ensure(n) { if (this.p + n > this.buf.length) { const nb = Buffer.alloc(Math.max(this.buf.length * 2, this.p + n + 1024)); this.buf.copy(nb); this.buf = nb; } }
  i32(v) { this.ensure(4); this.buf.writeInt32LE(v | 0, this.p); this.p += 4; return this; }
  u32(v) { this.ensure(4); this.buf.writeUInt32LE(v >>> 0, this.p); this.p += 4; return this; }
  i64(v) { this.ensure(8); this.buf.writeBigInt64LE(BigInt(v), this.p); this.p += 8; return this; }
  u8(v) { this.ensure(1); this.buf.writeUInt8(v & 0xff, this.p); this.p += 1; return this; }
  f32(v) { this.ensure(4); this.buf.writeFloatLE(v, this.p); this.p += 4; return this; }
  bytes(b) { this.ensure(b.length); Buffer.from(b).copy(this.buf, this.p); this.p += b.length; return this; }
  zeros(n) { this.ensure(n); this.buf.fill(0, this.p, this.p + n); this.p += n; return this; }
  fstring(s) {
    const body = Buffer.from(s + '\0', 'latin1');
    this.i32(body.length);
    this.bytes(body);
    return this;
  }
  fname(name, number = 0) { return this.i32(this.nameIndex(name)).i32(number); }
  nameIndex(n) {
    const i = NAMES.indexOf(n);
    if (i < 0) throw new Error('名称未登记: ' + n);
    return i;
  }
  out() { return this.buf.subarray(0, this.p); }
}

const NAMES = [
  'None', 'TestAsset', 'TestAsset_C', 'Default__TestAsset_C', 'FloatProperty', 'BoolProperty',
  'IntProperty', 'StrProperty', 'ArrayProperty', 'StructProperty', 'ObjectProperty', 'Vector',
  'TestFloat', 'TestBool', 'TestInt', 'TestString', 'TestVector', 'TestArray',
  'SomeObject', '/Game/Test/SomeObject',
];

// ---- 导出内容（.uexp）----
function buildExportPayload() {
  const w = new W(1024);
  // TestFloat: FloatProperty
  w.fname('TestFloat').fname('FloatProperty').i32(4).i32(0).u8(0).f32(1.5);
  // TestBool: BoolProperty（值在 tag 里，size=0）
  w.fname('TestBool').fname('BoolProperty').i32(0).i32(0).u8(1).u8(0);
  // TestInt: IntProperty
  w.fname('TestInt').fname('IntProperty').i32(4).i32(0).u8(0).i32(42);
  // TestString: StrProperty —— UE 里 tag.Size = 4(长度前缀) + 字符串字节数
  const strBody = Buffer.from('HelloUAsset\0', 'latin1');
  w.fname('TestString').fname('StrProperty').i32(4 + strBody.length).i32(0).u8(0);
  w.i32(strBody.length).bytes(strBody);
  // TestVector: StructProperty(Vector)，12 字节 = 3×float
  w.fname('TestVector').fname('StructProperty').i32(12).i32(0).fname('Vector').zeros(16).u8(0);
  w.f32(1).f32(2).f32(3);
  // 属性表结束
  w.fname('None');
  return w.out();
}

const payload = buildExportPayload();

// ---- .uasset 头部 ----
const u = new W(8192);
u.u32(0x9e2a83c1);      // tag
u.i32(-7);              // legacyFileVersion
u.i32(0);               // legacyUE3Version
u.i32(522);             // fileVersionUE4
u.i32(0);               // fileVersionLicenseeUE4
u.i32(1);               // customVersionCount
u.bytes(Buffer.from('d5c4b3a72918f7e66d5c4b3a12908f7e', 'hex'));
u.i32(1);               // customVersion value

const totalHeaderSizePos = u.p;
u.i32(0);               // totalHeaderSize（稍后回填）
u.fstring('None');      // folderName
u.u32(0x80000000);      // packageFlags

const nameCountPos = u.p;
u.i32(NAMES.length);
const nameOffsetPos = u.p;
u.i32(0);               // nameOffset（稍后回填）
u.fstring('');          // localizationId（v459+ 存在）

// 包头剩余字段先写（名称表在包头之后，偏移稍后回填）
u.i32(0);               // gatherableTextDataCount
u.i32(0);               // gatherableTextDataOffset
u.i32(1);               // exportCount
const exportOffsetPos = u.p;
u.i32(0);               // exportOffset（稍后回填）
u.i32(0);               // importCount
u.i32(0);               // importOffset
u.i32(0);               // dependsOffset
u.i32(0);               // softPackageReferencesCount
u.i32(0);               // softPackageReferencesOffset
u.i32(0);               // searchableNamesOffset
u.i32(0);               // thumbnailTableOffset
u.zeros(16);            // guid
u.i32(1);               // generationCount
u.i32(1); u.i32(NAMES.length);  // generations[0]
// EngineVersion: u16 major/minor/patch + u32 changelist + fstring branch
for (let k = 0; k < 2; k++) { u.ensure(2); u.buf.writeUInt16LE(0, u.p); u.p += 2;
                              u.ensure(2); u.buf.writeUInt16LE(0, u.p); u.p += 2;
                              u.ensure(2); u.buf.writeUInt16LE(0, u.p); u.p += 2;
                              u.u32(0); u.fstring(''); }
u.u32(0);               // compressionFlags
u.i32(0);               // compressedChunks
u.u32(0);               // packageSource
u.i32(0);               // additionalPackagesToCook
const assetRegistryPos = u.p;
u.i32(0);               // assetRegistryDataOffset（稍后回填到文件末尾）
u.i64(0);               // bulkDataStartOffset
u.i32(0);               // worldTileInfoDataOffset
u.i32(0);               // chunkIDs
u.i32(0);               // preloadDependencyCount
u.i32(0);               // preloadDependencyOffset

// 名称表（位于包头之后）
const nameOffset = u.p;
const hasHash = true;
for (const n of NAMES) {
  const ascii = /^[\x00-\x7F]*$/.test(n);
  const body = ascii ? Buffer.from(n + '\0', 'latin1') : Buffer.from(n + '\0', 'utf16le');
  u.i32(ascii ? body.length : -(n.length + 1));
  u.bytes(body);
  u.u32(0); // hash（UE 允许为 0）
}

// 导出表（一条：Default__TestAsset_C）—— 位于包头之内
const exportOffset = u.p;
const serialOffsetPlaceholder = 0;      // 稍后回填 = totalHeaderSize
// 导出表条目（v522 / 513 布局，见 engine.js readExports）
u.i32(0);                               // ClassIndex
u.i32(0);                               // SuperIndex
u.i32(0);                               // TemplateIndex
u.i32(0);                               // OuterIndex
u.fname('Default__TestAsset_C');        // ObjectName (FName = idx + number)
u.u32(0);                               // ObjectFlags
const serialSizePos = u.p;
u.i64(payload.length);                  // SerialSize  (v508+ i64)
const serialOffsetPos2 = u.p;
u.i64(0);                               // SerialOffset (稍后回填)
u.i32(0);                               // bForcedExport
u.i32(0);                               // bNotForClient
u.i32(0);                               // bNotForServer
u.zeros(16);                            // packageGuid
u.u32(0);                               // packageFlags
u.i32(0);                               // bNotAlwaysLoadedForEditorGame (v365+)
u.i32(1);                               // bIsAsset (v465+)
u.zeros(20);                            // 5×i32 preloadDependencies (v507+)

// totalHeaderSize = 导出表结束位置（真实 UE 里它覆盖名称表+导入表+导出表等全部头部数据）
const totalHeaderSize = u.p;
const serialOffset = totalHeaderSize;

// 尾部数据（AssetRegistry 占位），保证 .uasset 长度 > totalHeaderSize
const assetRegistryOffset = u.p;
u.i32(0x11223344);
u.i32(0);

// 回填
const finalU = u.out();
const dv = new DataView(finalU.buffer, finalU.byteOffset, finalU.byteLength);
dv.setInt32(totalHeaderSizePos, totalHeaderSize, true);
dv.setInt32(nameOffsetPos, nameOffset, true);
dv.setInt32(exportOffsetPos, exportOffset, true);
dv.setInt32(assetRegistryPos, assetRegistryOffset, true);
dv.setInt32(totalHeaderSizePos, totalHeaderSize, true);
dv.setBigInt64(serialSizePos, BigInt(payload.length), true);
dv.setBigInt64(serialOffsetPos2, BigInt(serialOffset), true);

fs.writeFileSync(path.join(outDir, 'TestAsset.uasset'), finalU);
fs.writeFileSync(path.join(outDir, 'TestAsset.uexp'), payload);
fs.writeFileSync(
  path.join(outDir, 'README.md'),
  `# 测试夹具\n\n` +
  `\`TestAsset.uasset\` / \`TestAsset.uexp\` 由 \`scripts/make-fixture.mjs\` 按 UE4 序列化格式**手工构造**，\n` +
  `不是从任何游戏里提取的资产。用途：在 CI 里验证解析器与回写器，无需分发真实资产。\n\n` +
  `结构：1 个导出（Default__TestAsset_C），含 Float / Bool / Int / Str / Struct(Vector) 五类属性。\n` +
  `重新生成：\`node scripts/make-fixture.mjs\`\n`
);

console.log('[fixture] TestAsset.uasset %d bytes, TestAsset.uexp %d bytes', finalU.length, payload.length);
