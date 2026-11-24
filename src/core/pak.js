/* eslint-disable */
/**
 * pak.js — UE .pak 归档读写（UE4 v4~v8 / UE5 v9~v11）。
 *
 * 原工具只能处理散装 .uasset+.uexp，实际资产都在 .pak 里。不做这个，
 * AI 就只能对着一堆手工解出来的文件干活，没法「直接改包里的资产再打回去」。
 *
 * 支持：索引解析、AES-256-ECB 解密（只读）、zlib/gzip 分块解压、
 *       提取、替换后重建、可选压缩重建。
 * 明确不支持（报错而不是产出坏包）：Oodle 压缩、加密 pak 的写入。
 */
import zlib from 'node:zlib';
import crypto from 'node:crypto';

export const PAK_MAGIC = 0x5a6f12e1;

const COMPRESSION = { NONE: 0x00, ZLIB: 0x01 };

function readFString(buf, off) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let len = view.getInt32(off, true);
  off += 4;
  if (len === 0) return { value: '', offset: off };
  let wide = false;
  if (len < 0) { wide = true; len = -len; }
  let value;
  if (wide) {
    value = Buffer.from(buf.subarray(off, off + len * 2)).toString('utf16le').replace(/\0+$/, '');
    off += len * 2;
  } else {
    value = Buffer.from(buf.subarray(off, off + len)).toString('utf8').replace(/\0+$/, '');
    off += len;
  }
  return { value, offset: off };
}

function writeFString(str) {
  const ascii = /^[\x00-\x7F]*$/.test(str);
  const body = ascii ? Buffer.from(str + '\0', 'latin1') : Buffer.from(str + '\0', 'utf16le');
  const head = Buffer.alloc(4);
  head.writeInt32LE(ascii ? body.length : -(str.length + 1), 0);
  return Buffer.concat([head, body]);
}

function aesDecrypt(data, key) {
  const d = crypto.createDecipheriv('aes-256-ecb', key, null);
  d.setAutoPadding(false);
  return Buffer.concat([d.update(data), d.final()]);
}

export function decompressBlock(data, method) {
  const m = method & 0x0f;
  if (m === 0) return data;
  if (m === 1) return zlib.inflateSync(data);
  if (method === 2) return zlib.gunzipSync(data);
  if (m === 3) throw new Error('该块是 Oodle 压缩，本实现不内置 Oodle（需要 oo2core 库），可先用 retoc / UAssetGUI 解包');
  throw new Error('未知压缩方法: 0x' + method.toString(16));
}

export function compressBlock(data, method) {
  const m = method & 0x0f;
  if (m === 0) return data;
  if (m === 1) return zlib.deflateSync(data, { level: 9 });
  throw new Error('不支持写入压缩方法: 0x' + method.toString(16));
}

export class Pak {
  constructor(buf) {
    this.buffer = Buffer.from(buf);
    this.entries = [];
    this.mountPoint = '../../../';
    this.version = 0;
    this.encrypted = false;
    this.key = null;
  }

  static fromBuffer(buf, opts = {}) {
    const pak = new Pak(buf);
    pak.parse(opts);
    return pak;
  }

  static async fromFile(file, opts = {}) {
    const fs = await import('node:fs/promises');
    const pak = Pak.fromBuffer(await fs.readFile(file), opts);
    pak.path = file;
    return pak;
  }

  parse({ key } = {}) {
    const buf = this.buffer;
    if (buf.length < 44) throw new Error('文件太小，不是 pak');
    const windowStart = Math.max(0, buf.length - 512);
    const tail = buf.subarray(windowStart);
    let magicPos = -1;
    for (let i = tail.length - 4; i >= 0; i--) {
      if (tail.readUInt32LE(i) === PAK_MAGIC) { magicPos = i; break; }
    }
    if (magicPos < 0) throw new Error('未找到 pak magic (0x5A6F12E1)');

    const abs = windowStart + magicPos;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.version = dv.getUint32(abs + 4, true);
    this.indexOffset = Number(dv.getBigInt64(abs + 8, true));
    this.indexSize = Number(dv.getBigInt64(abs + 16, true));
    this.indexHash = buf.subarray(abs + 24, abs + 40);
    this.encrypted = buf.length >= abs + 45 && buf.readUInt8(abs + 44) !== 0;
    this.footerPos = abs;

    let index = buf.subarray(this.indexOffset, this.indexOffset + this.indexSize);
    if (this.encrypted) {
      if (!key) throw new Error('pak 索引已加密，需要 32 字节 AES key');
      this.key = Buffer.isBuffer(key) ? key : Buffer.from(key, 'hex');
      if (this.key.length !== 32) throw new Error('AES key 必须 32 字节，当前 ' + this.key.length);
      index = aesDecrypt(index, this.key);
    }
    this._parseIndex(index);
    return this;
  }

  _parseIndex(index) {
    const view = new DataView(index.buffer, index.byteOffset, index.byteLength);
    const mount = readFString(index, 0);
    this.mountPoint = mount.value;
    let off = mount.offset;

    const numEntries = view.getInt32(off, true); off += 4;
    off += 8; // pathHashSeed
    const hasPathHash = view.getInt32(off, true) !== 0; off += 4;
    if (hasPathHash) off += 8 + 8 + 20;
    const hasFullDir = view.getInt32(off, true) !== 0; off += 4;
    if (hasFullDir) off += 8 + 8 + 20;
    off += 4 + 8 + 8 + 8 + 8; // encryptedIndex/size 等预留

    let cur = off;
    this.entries = [];
    for (let i = 0; i < numEntries; i++) {
      const name = readFString(index, cur);
      cur = name.offset;
      const e = { name: name.value };
      e.offset = Number(view.getBigInt64(cur, true)); cur += 8;
      e.size = Number(view.getBigInt64(cur, true)); cur += 8;
      e.uncompressedSize = Number(view.getBigInt64(cur, true)); cur += 8;
      e.compressionMethod = view.getUint32(cur, true); cur += 4;
      e.hash = Buffer.from(index.subarray(cur, cur + 20)); cur += 20;
      e.compressionBlocks = [];
      if (e.compressionMethod !== 0) {
        const n = view.getInt32(cur, true); cur += 4;
        for (let b = 0; b < n; b++) {
          const s = Number(view.getBigInt64(cur, true)); cur += 8;
          const en = Number(view.getBigInt64(cur, true)); cur += 8;
          e.compressionBlocks.push({ start: s, end: en });
        }
      }
      e.encrypted = view.getUint8(cur) !== 0; cur += 1;
      e.compressionBlockSize = view.getUint32(cur, true); cur += 4;
      if (this.version >= 3) cur += 8;
      this.entries.push(e);
    }
    this.indexParseEnd = cur;
  }

  list({ filter = '', offset = 0, limit = 200 } = {}) {
    const re = filter ? new RegExp(filter, 'i') : null;
    const all = this.entries
      .map((e, i) => ({ index: i, name: e.name, size: e.size, uncompressedSize: e.uncompressedSize, compressionMethod: e.compressionMethod, encrypted: e.encrypted }))
      .filter((e) => !re || re.test(e.name));
    return { total: all.length, offset, limit, items: all.slice(offset, offset + limit) };
  }

  find(nameOrRe) {
    if (nameOrRe instanceof RegExp) {
      return this.entries.map((e, i) => ({ e, i })).filter(({ e }) => nameOrRe.test(e.name)).map(({ i }) => i);
    }
    const exact = this.entries.findIndex((e) => e.name === nameOrRe);
    if (exact >= 0) return [exact];
    const needle = String(nameOrRe).toLowerCase();
    return this.entries.map((e, i) => ({ e, i })).filter(({ e }) => e.name.toLowerCase().includes(needle)).map(({ i }) => i);
  }

  read(indexOrName) {
    const idx = typeof indexOrName === 'number' ? indexOrName : this.find(indexOrName)[0];
    if (idx === undefined || idx < 0) throw new Error('pak 中找不到: ' + indexOrName);
    const e = this.entries[idx];
    if (e.compressionMethod === 0) {
      let data = this.buffer.subarray(e.offset, e.offset + e.size);
      if (e.encrypted) {
        if (!this.key) throw new Error('条目已加密但未提供 key');
        data = aesDecrypt(data, this.key);
      }
      return { name: e.name, data: Buffer.from(data) };
    }
    const parts = [];
    for (const b of e.compressionBlocks) {
      let chunk = this.buffer.subarray(b.start, b.end);
      if (e.encrypted) {
        if (!this.key) throw new Error('条目已加密但未提供 key');
        chunk = aesDecrypt(chunk, this.key);
      }
      parts.push(decompressBlock(chunk, e.compressionMethod));
    }
    return { name: e.name, data: Buffer.concat(parts) };
  }

  extractAll({ filter = '', limit = 0 } = {}) {
    const re = filter ? new RegExp(filter, 'i') : null;
    const out = [];
    for (let i = 0; i < this.entries.length; i++) {
      if (limit && out.length >= limit) break;
      if (re && !re.test(this.entries[i].name)) continue;
      try { out.push({ index: i, ...this.read(i) }); }
      catch (err) { out.push({ index: i, name: this.entries[i].name, error: String(err.message || err) }); }
    }
    return out;
  }

  rebuildWith(replacements, { compression = 0 } = {}) {
    const byName = new Map(replacements.map((r) => [r.name, r.data]));
    const chunks = [];
    const newEntries = [];
    let cursor = 0;

    const push = (name, raw) => {
      let payload = raw;
      let method = 0;
      let blocks = [];
      if (compression) {
        const packed = compressBlock(raw, compression);
        if (packed.length < raw.length) {
          payload = packed;
          method = compression;
          blocks = [{ start: cursor, end: cursor + packed.length }];
        }
      }
      chunks.push(payload);
      newEntries.push({
        name, offset: cursor, size: payload.length, uncompressedSize: raw.length,
        compressionMethod: method,
        hash: crypto.createHash('sha1').update(raw).digest(),
        compressionBlocks: blocks, encrypted: false, compressionBlockSize: raw.length,
      });
      cursor += payload.length;
    };

    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      push(e.name, byName.has(e.name) ? byName.get(e.name) : this.read(i).data);
    }
    for (const r of replacements) {
      if (this.entries.some((e) => e.name === r.name)) continue;
      push(r.name, r.data);
    }

    const dataBuf = Buffer.concat(chunks);
    const indexBuf = this._buildIndex(newEntries);
    const indexHash = crypto.createHash('sha1').update(indexBuf).digest();
    const footer = Buffer.alloc(45);
    footer.writeUInt32LE(PAK_MAGIC, 0);
    footer.writeUInt32LE(this.version || 8, 4);
    footer.writeBigInt64LE(BigInt(dataBuf.length), 8);
    footer.writeBigInt64LE(BigInt(indexBuf.length), 16);
    indexHash.copy(footer, 24);
    footer.writeUInt8(0, 44);
    return Buffer.concat([dataBuf, indexBuf, footer]);
  }

  _buildIndex(entries) {
    const parts = [writeFString(this.mountPoint || '../../../')];
    const head = Buffer.alloc(12);
    head.writeInt32LE(entries.length, 0);
    head.writeBigInt64LE(BigInt(0), 4);
    parts.push(head);
    parts.push(Buffer.alloc(4)); // hasPathHashIndex = 0
    parts.push(Buffer.alloc(4)); // hasFullDirectory = 0
    parts.push(Buffer.alloc(36)); // 预留

    for (const e of entries) {
      parts.push(writeFString(e.name));
      const fixed = Buffer.alloc(28);
      fixed.writeBigInt64LE(BigInt(e.offset), 0);
      fixed.writeBigInt64LE(BigInt(e.size), 8);
      fixed.writeBigInt64LE(BigInt(e.uncompressedSize), 16);
      fixed.writeUInt32LE(e.compressionMethod, 24);
      parts.push(fixed);
      parts.push(e.hash);
      if (e.compressionMethod !== 0) {
        const bc = Buffer.alloc(4);
        bc.writeInt32LE(e.compressionBlocks.length, 0);
        parts.push(bc);
        for (const b of e.compressionBlocks) {
          const bb = Buffer.alloc(16);
          bb.writeBigInt64LE(BigInt(b.start), 0);
          bb.writeBigInt64LE(BigInt(b.end), 8);
          parts.push(bb);
        }
      }
      const enc = Buffer.alloc(1);
      enc.writeUInt8(e.encrypted ? 1 : 0, 0);
      parts.push(enc);
      const bs = Buffer.alloc(4);
      bs.writeUInt32LE(e.compressionBlockSize || 0, 0);
      parts.push(bs);
      if (this.version >= 3) parts.push(Buffer.alloc(8));
    }
    return Buffer.concat(parts);
  }

  info() {
    return {
      version: this.version,
      mountPoint: this.mountPoint,
      entries: this.entries.length,
      compressed: this.entries.filter((e) => e.compressionMethod !== 0).length,
      encrypted: this.entries.filter((e) => e.encrypted).length,
      size: this.buffer.length,
      indexOffset: this.indexOffset,
      indexSize: this.indexSize,
      hasKey: !!this.key,
      oodle: this.entries.some((e) => (e.compressionMethod & 0x0f) === 3),
    };
  }
}

export { COMPRESSION };
