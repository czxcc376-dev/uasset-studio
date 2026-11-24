/* eslint-disable */
/**
 * names.js — FName 表（NameMap）编解码、UE hash、以及名称表扩容。
 *
 * 与原工具 growUAssetNameMap 的差异：
 *   - 抽成纯函数，用 ctx 传状态（无全局变量）
 *   - 未改动条目按原始字节拷贝（保留原 hash 与 UTF-16 编码），改动/新增条目才重编码
 *   - 扩容后统一把「位于名称表之后的所有绝对偏移」按 delta 后移，并同步 totalHeaderSize / nameCount
 */

/** UE4 FName hash 依赖表 */
const DEP_TABLE = new Uint32Array([
  0x00000000, 0x04c11db7, 0x09823b6e, 0x0d4326d9, 0x130476dc, 0x17c56b6b, 0x1a864db2, 0x1e475005,
  0x2608edb8, 0x22c9f00f, 0x2f8ad6d6, 0x2b4bcb61, 0x350c9b64, 0x31cd86d3, 0x3c8ea00a, 0x384fbdbd,
]);

let CRC_TABLE = null;

function ensureCrcTable() {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[i] = c;
    }
  }
}

export function crc32Bytes(bytes) {
  ensureCrcTable();
  let crc = -1;
  for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

/** 与 UE4 UAssetAPI 一致的 FName hash（UE4.23+ 名称表每条带 4 字节 hash） */
export function nameHash(str) {
  ensureCrcTable();
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c >= 97 && c <= 122) c -= 32;
    const bytes = [];
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    for (let k = 0; k < bytes.length; k++) h = ((h >>> 8) & 0x00ffffff) ^ DEP_TABLE[(h ^ bytes[k]) & 0xff];
  }
  let crc = 0xffffffff;
  for (let j = 0; j < str.length; j++) {
    let ch = str.charCodeAt(j);
    for (let n = 0; n < 4; n++) {
      crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ (ch & 0xff)) & 0xff];
      ch >>= 8;
    }
  }
  crc = ~crc >>> 0;
  return ((h & 0xffff) | ((crc & 0xffff) << 16)) >>> 0;
}

/** 名称表在磁盘上的结束偏移 */
export function nameMapEndOffset(bytes, nameOffset, count, hasHash) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = nameOffset;
  for (let i = 0; i < count; i++) {
    const len = view.getInt32(pos, true);
    pos += 4;
    pos += len < 0 ? -len * 2 : len;
    if (hasHash) pos += 4;
  }
  return pos;
}

/** 把一条 FName 编码成磁盘格式（ASCII 用正长度，非 ASCII 用 UTF-16LE 负长度） */
export function encodeNameEntry(name, hasHash, hashVal) {
  const ascii = /^[\x00-\x7F]*$/.test(name);
  const bodyLen = ascii ? name.length + 1 : (name.length + 1) * 2;
  const out = new Uint8Array(4 + bodyLen + (hasHash ? 4 : 0));
  const view = new DataView(out.buffer);
  if (ascii) {
    view.setInt32(0, name.length + 1, true);
    for (let i = 0; i < name.length; i++) out[4 + i] = name.charCodeAt(i) & 0xff;
    out[4 + name.length] = 0;
  } else {
    view.setInt32(0, -(name.length + 1), true);
    let p = 4;
    for (let j = 0; j < name.length; j++) {
      const code = name.charCodeAt(j);
      out[p++] = code & 0xff;
      out[p++] = (code >> 8) & 0xff;
    }
    out[p++] = 0;
    out[p++] = 0;
  }
  if (hasHash) view.setUint32(4 + bodyLen, (hashVal ?? 0) >>> 0, true);
  return out;
}

/**
 * 名称表扩容/改名后重建 .uasset 头部区。
 * @param {{uasset:Uint8Array, header:object, names:string[], originalNames:string[]}} ctx
 * @returns {{uasset:Uint8Array, header:object, delta:number}}
 */
export function growNameMap(ctx) {
  const header = ctx.header;
  const oldBytes = ctx.uasset;
  const nameOffset = header.nameOffset;
  const hasHash = header.fileVersionUE4 >= 504;
  const oldCount = header.nameCount;
  const mapEnd = nameMapEndOffset(oldBytes, nameOffset, oldCount, hasHash);

  const view0 = new DataView(oldBytes.buffer, oldBytes.byteOffset, oldBytes.byteLength);
  const oldSpans = [];
  let q = nameOffset;
  for (let i = 0; i < oldCount; i++) {
    const start = q;
    const len = view0.getInt32(q, true);
    q += 4;
    q += len < 0 ? -len * 2 : len;
    if (hasHash) q += 4;
    oldSpans.push([start, q]);
  }

  const entries = [];
  let newLen = 0;
  for (let i = 0; i < ctx.names.length; i++) {
    let e;
    if (i < oldCount && ctx.names[i] === ctx.originalNames[i]) {
      e = oldBytes.subarray(oldSpans[i][0], oldSpans[i][1]);
    } else {
      e = encodeNameEntry(ctx.names[i] || '', hasHash, hasHash ? nameHash(ctx.names[i] || '') : null);
    }
    entries.push(e);
    newLen += e.length;
  }

  const origLen = mapEnd - nameOffset;
  if (newLen < origLen) {
    entries.push(new Uint8Array(origLen - newLen)); // 只变短时补齐，保持后续结构不动
    newLen = origLen;
  }
  const delta = newLen - origLen;
  const tail = oldBytes.subarray(mapEnd);
  const out = new Uint8Array(nameOffset + newLen + tail.length);
  out.set(oldBytes.subarray(0, nameOffset), 0);
  let p = nameOffset;
  for (const e of entries) {
    out.set(e, p);
    p += e.length;
  }
  out.set(tail, nameOffset + newLen);

  const view = new DataView(out.buffer);
  const updated = { ...header, nameCount: ctx.names.length, totalHeaderSize: header.totalHeaderSize + delta };
  const positions = header.offsetPositions || {};
  const shifted = {};
  for (const key of Object.keys(positions)) {
    const fieldPos = positions[key];
    if (typeof fieldPos !== 'number') continue;
    if (key === 'nameOffset' || key === 'totalHeaderSize') continue;
    if (fieldPos + 4 > out.length) continue;
    const val = view.getInt32(fieldPos, true);
    if (val >= mapEnd && val !== 0) {
      view.setInt32(fieldPos, val + delta, true);
      shifted[key] = val + delta;
    }
  }
  Object.assign(updated, shifted);
  if (typeof positions.totalHeaderSize === 'number') {
    view.setInt32(positions.totalHeaderSize, updated.totalHeaderSize, true);
  }
  if (typeof positions.nameOffset === 'number') {
    view.setInt32(positions.nameOffset - 4, ctx.names.length, true);
  }
  return { uasset: out, header: updated, delta };
}
