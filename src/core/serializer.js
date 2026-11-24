/* eslint-disable */
/**
 * serializer.js — 把内存中的资产写回 .uasset / .uexp。
 *
 * 与原工具 rebuildUexp + growUAssetNameMap + patchExportTableForNewOffsets 等价，
 * 但整理成单一函数、无全局状态，并额外提供：
 *   - 单文件资产（无 .uexp）的完整重建支持
 *   - 每个导出重建后的自检（写出的字节数 == 记录 size）
 *   - 结构化 report，便于 MCP/CLI 直接展示差异
 */
import {
  UAssetBinaryWriter,
  UAssetPropertyWriter,
  UAssetPropertyReader,
  UAssetHeaderReader,
  UAssetNameMapReader,
  UAssetObjectReader,
} from './engine.js';
import { growNameMap } from './names.js';

/** 导出表条目大小（随版本变化），用于回填 serialSize / serialOffset */
export function exportEntrySize(ver) {
  return (
    28 + // ClassIndex/ObjectName/OuterIndex/SuperIndex/TemplateIndex
    (ver >= 508 ? 16 : 8) + // ObjectFlags
    12 +
    16 +
    4 +
    (ver >= 365 ? 4 : 0) +
    (ver >= 465 ? 4 : 0) +
    (ver >= 507 ? 20 : 0)
  );
}

/**
 * @param {object} ctx {uasset, uexp, header, names, originalNames, imports, exports}
 * @param {{rebuildAll?:boolean, debug?:boolean}} opts
 */
export function serializePackage(ctx, opts = {}) {
  const { rebuildAll = false, debug = false } = opts;
  const header0 = ctx.header;
  const src = ctx.uexp || ctx.uasset;
  const base = header0.totalHeaderSize;

  const report = {
    exports: [],
    rebuilt: 0,
    copied: 0,
    failed: 0,
    nameMapDelta: 0,
    exportTablePatched: 0,
    tailBytes: 0,
    sizes: {},
  };

  // ---- 1. 名称表变更（新增/改名）先把头部区重建好，后续偏移都基于新头部 ----
  let uasset = ctx.uasset;
  let header = header0;
  if (ctx.namesDirty || ctx.names.length !== ctx.originalNames.length) {
    const r = growNameMap({ uasset, header, names: ctx.names, originalNames: ctx.originalNames });
    uasset = r.uasset;
    header = r.header;
    report.nameMapDelta = r.delta;
  }

  // ---- 2. 逐导出写出（只重建改动过的；其余按原始字节搬运） ----
  const stream = new UAssetBinaryWriter(Math.max(1 << 20, src.length + (1 << 16)));
  const propWriter = new UAssetPropertyWriter(stream, ctx.names, debug);
  const offsets = new Map();

  let maxOriginalEnd = 0;
  for (const exp of ctx.exports) {
    const end = exp.serialOffset + Math.max(0, exp.serialSize);
    if (end > maxOriginalEnd) maxOriginalEnd = end;
  }
  maxOriginalEnd -= base;

  for (let i = 0; i < ctx.exports.length; i++) {
    const exp = ctx.exports[i];
    let original = null;
    if (exp.serialSize > 0) {
      const rel = exp.serialOffset - base;
      if (rel >= 0 && rel + exp.serialSize <= src.length) {
        original = src.subarray(rel, rel + exp.serialSize);
      }
    }

    const start = stream.getPosition();
    const shouldRebuild = exp.__raw ? true : rebuildAll || (exp.isModified === true && Array.isArray(exp.properties));

    if (exp.__raw) {
      stream.writeBytes(exp.__raw);
      report.rebuilt++;
    } else if (shouldRebuild && exp.properties) {
      try {
        writeExportPayload(propWriter, stream, exp);
        report.rebuilt++;
      } catch (e) {
        if (original) stream.writeBytes(original);
        report.failed++;
        report.exports.push({ index: i, name: exp.objectName, error: String(e && e.message || e), fellBack: !!original });
        const end = stream.getPosition();
        offsets.set(i, { offset: start, size: end - start });
        continue;
      }
    } else if (original) {
      stream.writeBytes(original);
      report.copied++;
    }

    const end = stream.getPosition();
    offsets.set(i, { offset: start, size: end - start });
    report.exports.push({
      index: i,
      name: exp.objectName,
      oldSize: exp.serialSize,
      newSize: end - start,
      rebuilt: !!shouldRebuild || !!exp.__raw,
    });
  }

  // ---- 3. 尾部数据（AssetRegistry / 缩略图 / bulk / 对齐填充） ----
  if (maxOriginalEnd >= 0 && maxOriginalEnd < src.length) {
    const tail = src.subarray(maxOriginalEnd);
    stream.writeBytes(tail);
    report.tailBytes = tail.length;
  }

  let data = stream.getBuffer();

  // 单文件资产：没有 .uexp 时补 4 字节对齐
  if (!ctx.uexp) {
    const pad = (4 - (data.length % 4)) % 4;
    if (pad) {
      const padded = new Uint8Array(data.length + pad);
      padded.set(data);
      data = padded;
    }
  }

  // ---- 4. 把新的 offset/size 回填进导出表 ----
  const headerLen = header.totalHeaderSize;
  const prefix = uasset.subarray(0, headerLen);
  const outAsset = new Uint8Array(headerLen + (ctx.uexp ? 0 : data.length));
  outAsset.set(prefix, 0);
  if (!ctx.uexp) outAsset.set(data, headerLen);

  const view = new DataView(outAsset.buffer, outAsset.byteOffset, outAsset.byteLength);
  const ver = header.fileVersionUE4;
  const is64 = ver >= 508;
  const entrySize = exportEntrySize(ver);
  let pos = header.exportOffset;

  for (let i = 0; i < ctx.exports.length; i++) {
    const exp = ctx.exports[i];
    const rec = offsets.get(i);
    if (!rec) continue;
    if (pos + entrySize > outAsset.length) break;
    const newSize = rec.size;
    const newOffset = headerLen + rec.offset;
    if (newSize !== exp.serialSize || newOffset !== exp.serialOffset) report.exportTablePatched++;
    exp.serialSize = newSize;
    exp.serialOffset = newOffset;
    if (is64) {
      view.setBigInt64(pos + 28, BigInt(Math.floor(newSize)), true);
      view.setBigInt64(pos + 36, BigInt(Math.floor(newOffset)), true);
    } else {
      view.setInt32(pos + 28, newSize | 0, true);
      view.setInt32(pos + 32, newOffset | 0, true);
    }
    pos += entrySize;
  }

  report.sizes = {
    uasset: outAsset.length,
    uexp: ctx.uexp ? data.length : 0,
    originalUasset: ctx.uasset.length,
    originalUexp: ctx.uexp ? ctx.uexp.length : 0,
  };

  ctx.header = header;
  return { uasset: outAsset, uexp: ctx.uexp ? data : null, header, report };
}

/** 写出单个导出的序列化载荷（属性表 + DataTable 行 + extraData） */
function writeExportPayload(propWriter, stream, exp) {
  if (exp.dtInfo && Array.isArray(exp.dtInfo.rows) && exp.dtInfo.rows.length > 0) {
    const tableProps = exp.properties.filter((p) => !p.__row);
    propWriter.writeProperties(tableProps);
    stream.writeInt32(0);
    stream.writeInt32(exp.dtInfo.rows.length);
    for (const row of exp.dtInfo.rows) {
      propWriter.writeFName(row.name);
      propWriter.writeProperties(row.props);
    }
  } else {
    propWriter.writeProperties(exp.properties);
  }
  if (exp.extraData && exp.extraData.length) stream.writeBytes(exp.extraData);
}

/**
 * 保存后自检：重新解析头部/名称表/导出表，校验每个导出的区间落在数据流内，
 * 并可选地重新解析被改动导出的属性表，确认能完整走完且结束符正确。
 */
export function verifySaved(ctx, { uasset, uexp }, { deep = true } = {}) {
  const problems = [];
  try {
    const h = new UAssetHeaderReader(uasset.buffer.slice(uasset.byteOffset, uasset.byteOffset + uasset.byteLength)).read();
    if (!h) return { ok: false, problems: ['header 解析失败'] };
    const nmr = new UAssetNameMapReader(uasset.buffer.slice(uasset.byteOffset, uasset.byteOffset + uasset.byteLength), h.fileVersionUE4);
    const endOff = h.importOffset > 0 ? h.importOffset : h.exportOffset;
    const names = nmr.read(h.nameOffset, h.nameCount, endOff);
    if (names.length !== h.nameCount) problems.push(`名称表残缺 ${names.length}/${h.nameCount}`);

    const objR = new UAssetObjectReader(uasset.buffer.slice(uasset.byteOffset, uasset.byteOffset + uasset.byteLength), names, h.fileVersionUE4);
    let imports = [];
    if (h.importCount) {
      objR.setOffset(h.importOffset);
      imports = objR.readImports(h.importCount);
    }
    objR.setOffset(h.exportOffset);
    const exports = objR.readExports(h.exportCount);
    const streamLen = uexp ? uexp.length : uasset.length - h.totalHeaderSize;

    for (let i = 0; i < exports.length; i++) {
      const e = exports[i];
      if (e.serialSize <= 0) continue;
      const rel = e.serialOffset - h.totalHeaderSize;
      if (rel < 0) problems.push(`导出 #${i} offset < header`);
      else if (rel + e.serialSize > streamLen) problems.push(`导出 #${i} 越界 (${rel}+${e.serialSize}>${streamLen})`);
    }

    if (deep && uexp) {
      const pr = new UAssetPropertyReaderSafe(uasset, uexp, names, imports, exports, h);
      for (const idx of ctx.modifiedExports || []) {
        const e = exports[idx];
        if (!e || e.serialSize <= 0) continue;
        try {
          const props = pr.read(idx);
          if (!Array.isArray(props)) problems.push(`导出 #${idx} 解析失败`);
        } catch (err) {
          problems.push(`导出 #${idx} 解析异常: ${err.message || err}`);
        }
      }
    }

    return { ok: problems.length === 0, problems, header: { names: h.nameCount, exports: h.exportCount, totalHeaderSize: h.totalHeaderSize } };
  } catch (e) {
    return { ok: false, problems: [String(e && e.message || e)] };
  }
}

/** 内部：按导出索引重新解析属性的小工具 */
class UAssetPropertyReaderSafe {
  constructor(uasset, uexp, names, imports, exports, header) {
    this.uasset = uasset;
    this.uexp = uexp;
    this.names = names;
    this.imports = imports;
    this.exports = exports;
    this.header = header;
  }
  read(idx) {
    const ab = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    const r = new UAssetPropertyReader(
      ab(this.uasset),
      this.names,
      this.imports,
      this.exports,
      this.header.totalHeaderSize,
      this.uexp ? ab(this.uexp) : undefined,
      false
    );
    r.setOffset(this.exports[idx].serialOffset);
    return r.readProperties();
  }
}
