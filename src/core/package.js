/* eslint-disable */
/**
 * package.js — 面向「人/CLI/AI」的高层资产对象。
 *
 * 设计目标（相对原工具的三个改进）：
 *   1) 无 DOM、无全局状态：一个 Package 实例 = 一次打开的资产，可并发持有多份
 *   2) 路径寻址：`Default__BP_Rifle_AUG_C.WeaponAttrModifyConfigList[0].ModifyConfigID`
 *      读/改/删都用同一个路径语法，MCP 与 CLI 共用
 *   3) 写入前自动补名称表（原实现遇到未登记的 FName 会静默写 "None" 造成静默损坏）
 */
import {
  UAssetBinaryWriter,
  UAssetPropertyWriter,
  UAssetHeaderReader,
  UAssetNameMapReader,
  UAssetObjectReader,
  UAssetPropertyReader,
} from './engine.js';
import { serializePackage, verifySaved } from './serializer.js';

const toAB = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
const asU8 = (b) => (b instanceof Uint8Array ? b : new Uint8Array(b));

const NAME_TYPES = new Set(['NameProperty']);
const OBJECT_TYPES = new Set([
  'ObjectProperty', 'ClassProperty', 'InterfaceProperty', 'WeakObjectProperty',
  'LazyObjectProperty', 'AssetObjectProperty', 'AssetClassProperty',
]);

export class Package {
  /**
   * @param {{uasset:ArrayBuffer|Uint8Array, uexp?:ArrayBuffer|Uint8Array, name?:string}} input
   */
  constructor({ uasset, uexp, name = 'asset' }) {
    this.name = name;
    this.original = {
      uasset: asU8(uasset).slice(),
      uexp: uexp ? asU8(uexp).slice() : null,
    };
    this.#loadBuffers(this.original.uasset, this.original.uexp);
    this.modifiedExports = new Set();
    this.notes = [];
  }

  static fromBuffers(input) {
    return new Package(input);
  }

  static async fromFile(uassetPath, { uexpPath } = {}) {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const uasset = await fs.readFile(uassetPath);
    let uexp = null;
    let uexpResolved = uexpPath;
    if (!uexpResolved) {
      const guess = uassetPath.replace(/\.uasset$/i, '.uexp');
      try {
        await fs.access(guess);
        uexpResolved = guess;
      } catch { /* 单文件资产 */ }
    }
    if (uexpResolved) uexp = await fs.readFile(uexpResolved);
    return new Package({ uasset, uexp, name: path.basename(uassetPath) });
  }

  // ---------------------------------------------------------------- 内部
  #loadBuffers(uassetU8, uexpU8) {
    this.uasset = asU8(uassetU8);
    this.uexp = uexpU8 ? asU8(uexpU8) : null;
    this.header = new UAssetHeaderReader(toAB(this.uasset)).read();
    const endOffset = this.header.importOffset > 0 ? this.header.importOffset : this.header.exportOffset;
    this.names = new UAssetNameMapReader(toAB(this.uasset), this.header.fileVersionUE4)
      .read(this.header.nameOffset, this.header.nameCount, endOffset);
    this.originalNames = [...this.names];
    this.namesDirty = false;

    const objR = new UAssetObjectReader(toAB(this.uasset), this.names, this.header.fileVersionUE4);
    this.imports = [];
    this.exports = [];
    if (this.header.importCount > 0) {
      objR.setOffset(this.header.importOffset);
      this.imports = objR.readImports(this.header.importCount);
    }
    if (this.header.exportCount > 0) {
      objR.setOffset(this.header.exportOffset);
      this.exports = objR.readExports(this.header.exportCount);
    }
    for (const exp of this.exports) {
      exp.properties = null;
      exp.isModified = false;
      exp.__raw = null;
    }
  }

  get isSplit() {
    return !!this.uexp;
  }

  // ---------------------------------------------------------------- 概况
  info() {
    return {
      name: this.name,
      split: this.isSplit,
      engine: {
        fileVersionUE4: this.header.fileVersionUE4,
        fileVersionUE5: this.header.fileVersionUE5 ?? null,
        legacyFileVersion: this.header.legacyFileVersion,
        licensee: this.header.fileVersionLicenseeUE4,
        customVersions: this.header.customVersions || [],
      },
      sizes: {
        uasset: this.uasset.length,
        uexp: this.uexp ? this.uexp.length : 0,
        totalHeaderSize: this.header.totalHeaderSize,
      },
      tables: {
        names: this.header.nameCount,
        imports: this.header.importCount,
        exports: this.header.exportCount,
      },
      isDataTable: !!this.header.isDeltaForce,
      dirty: this.modifiedExports.size > 0 || this.namesDirty,
    };
  }

  // ---------------------------------------------------------------- 导出
  exportList({ filter = '', offset = 0, limit = 200 } = {}) {
    const needle = filter.toLowerCase();
    const all = this.exports.map((e, i) => ({
      index: i,
      name: e.objectName,
      className: this.#classNameOf(e),
      outerIndex: e.outerIndex,
      serialOffset: e.serialOffset,
      serialSize: e.serialSize,
      modified: this.modifiedExports.has(i),
    }));
    const rows = needle ? all.filter((r) => r.name.toLowerCase().includes(needle) || (r.className || '').toLowerCase().includes(needle)) : all;
    return { total: rows.length, offset, limit, items: rows.slice(offset, offset + limit) };
  }

  #classNameOf(exp) {
    try {
      if (exp.classIndex < 0) {
        const dep = this.imports[-exp.classIndex - 1];
        return dep ? dep.objectName : `Import${exp.classIndex}`;
      }
      const dep = this.exports[exp.classIndex];
      return dep ? dep.objectName : `Export${exp.classIndex}`;
    } catch {
      return null;
    }
  }

  resolveExport(ref) {
    if (typeof ref === 'number') return ref;
    const s = String(ref);
    const hash = s.match(/^#?(\d+)$/);
    if (hash) return Number(hash[1]);
    const exact = this.exports.findIndex((e) => e.objectName === s);
    if (exact >= 0) return exact;
    const ci = this.exports.findIndex((e) => e.objectName.toLowerCase() === s.toLowerCase());
    if (ci >= 0) return ci;
    const partial = this.exports.findIndex((e) => e.objectName.toLowerCase().includes(s.toLowerCase()));
    if (partial >= 0) return partial;
    throw new Error(`找不到导出: ${ref}`);
  }

  parseExport(ref) {
    const idx = this.resolveExport(ref);
    const exp = this.exports[idx];
    if (exp.properties) return exp.properties;
    if (exp.serialSize <= 0) {
      exp.properties = [];
      return exp.properties;
    }
    const reader = new UAssetPropertyReader(
      toAB(this.uasset),
      this.names,
      this.imports,
      this.exports,
      this.header.totalHeaderSize,
      this.uexp ? toAB(this.uexp) : undefined,
      false
    );
    reader.setOffset(exp.serialOffset);
    let props = reader.readProperties();

    // DataTable：属性后跟行
    if (this.header.isDeltaForce && props.length > 0 && props[0].name === 'RowStruct') {
      try {
        const dt = reader.readDataTableRows();
        if (dt && dt.rows.length > 0) {
          exp.dtInfo = dt;
          for (const row of dt.rows) {
            props.push({
              name: row.name, type: 'StructProperty', structType: 'RowData',
              size: 0, arrayIndex: 0, value: row.props, __row: true,
            });
          }
        }
      } catch (e) {
        this.notes.push(`DataTable 行解析失败: ${e.message || e}`);
      }
    }
    exp.properties = props;
    return props;
  }

  parseAll() {
    for (let i = 0; i < this.exports.length; i++) {
      try { this.parseExport(i); } catch (e) { this.notes.push(`导出 #${i} 解析失败: ${e.message || e}`); }
    }
    return this;
  }

  // ---------------------------------------------------------------- 路径
  /**
   * 解析路径：`Export`、`#3`、`Export.Prop`、`Export.Prop[0].Sub`
   * @returns {{exportIndex:number, tokens:Array<{type:'prop'|'index'|'key', value:any}>}}
   */
  parsePath(path) {
    if (!path || typeof path !== 'string') throw new Error('路径不能为空');
    const tokens = [];
    let rest = path.trim();
    let exportIndex = null;

    const headHash = rest.match(/^#(\d+)/);
    if (headHash) {
      exportIndex = Number(headHash[1]);
      rest = rest.slice(headHash[0].length);
    } else {
      // 导出名可能包含 '.'，因此优先整体匹配已知导出名（最长匹配）
      const candidates = this.exports
        .map((e, i) => ({ i, n: e.objectName }))
        .filter((c) => rest === c.n || rest.startsWith(c.n + '.') || rest.startsWith(c.n + '['))
        .sort((a, b) => b.n.length - a.n.length);
      if (candidates.length) {
        exportIndex = candidates[0].i;
        rest = rest.slice(candidates[0].n.length);
      }
    }

    const re = /\.([^.\[\]]+)|\[(\d+)\]|\["([^"]+)"\]|\[([^\[\]]+)\]/g;
    let m;
    while ((m = re.exec(rest))) {
      if (m[1] !== undefined) tokens.push({ type: 'prop', value: m[1] });
      else if (m[2] !== undefined) tokens.push({ type: 'index', value: Number(m[2]) });
      else if (m[3] !== undefined) tokens.push({ type: 'key', value: m[3] });
      else tokens.push({ type: 'key', value: m[4] });
    }
    if (rest.length && tokens.length === 0) throw new Error(`路径语法无法解析: ${rest}`);
    if (exportIndex === null) throw new Error(`路径缺少导出名或 #索引（导出列表: ${this.exports.slice(0, 5).map((e) => e.objectName).join(', ')} ...）`);
    return { exportIndex, tokens };
  }

  /**
   * 读取路径指向的值。
   * @returns {{path:string, exportIndex:number, exportName:string, kind:'export'|'property'|'element', type?:string, value?:any, size?:number, structName?:string, innerType?:string}}
   */
  get(path) {
    const { exportIndex, tokens } = this.parsePath(path);
    const exp = this.exports[exportIndex];
    if (tokens.length === 0) {
      return {
        path,
        exportIndex,
        exportName: exp.objectName,
        kind: 'export',
        type: this.#classNameOf(exp) || 'Export',
        value: {
          objectName: exp.objectName,
          className: this.#classNameOf(exp),
          serialOffset: exp.serialOffset,
          serialSize: exp.serialSize,
          propertyCount: this.parseExport(exportIndex).length,
        },
        size: exp.serialSize,
      };
    }

    let node = this.parseExport(exportIndex);
    let owner = null;
    let parent = null;
    let last = null;

    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.type === 'prop') {
        if (!Array.isArray(node)) {
          if (node && typeof node === 'object' && t.value in node) {
            parent = node;
            last = t.value;
            node = node[t.value];
            continue;
          }
          throw new Error(`节点不是属性列表，无法取 .${t.value}`);
        }
        const found = node.find((p) => p && p.name === t.value);
        if (!found) {
          const near = node.filter((p) => p && typeof p.name === 'string' && p.name.toLowerCase().includes(String(t.value).toLowerCase())).slice(0, 5).map((p) => p.name);
          throw new Error(`属性不存在: ${t.value}${near.length ? `（相近: ${near.join(', ')}）` : ''}`);
        }
        owner = found;
        parent = node;
        last = t.value;
        node = found.value;
      } else {
        const idx = t.type === 'index' ? t.value : t.value;
        if (!Array.isArray(node)) throw new Error(`[${t.value}] 用于非数组节点`);
        if (t.type === 'index' && (idx < 0 || idx >= node.length)) throw new Error(`索引越界: ${idx} (长度 ${node.length})`);
        parent = node;
        last = idx;
        node = node[idx];
        owner = node && node.name && node.type ? node : owner;
      }
    }

    const isPropList = Array.isArray(node) && node.length && node[0] && node[0].name && node[0].type;
    return {
      path,
      exportIndex,
      exportName: exp.objectName,
      kind: owner ? 'property' : 'element',
      type: owner ? owner.type : Array.isArray(node) ? 'Array' : typeof node,
      structName: owner && owner.structName,
      innerType: owner && owner.innerType,
      arrayIndex: owner && owner.arrayIndex,
      size: owner ? owner.size : undefined,
      value: isPropList ? summarizeProps(node) : node,
    };
  }

  /**
   * 修改路径指向的值（自动按属性类型归一化）。
   * @returns {{path:string, before:any, after:any, type:string}}
   */
  set(path, value) {
    const { exportIndex, tokens } = this.parsePath(path);
    if (tokens.length === 0) throw new Error('不能直接替换整个导出，请指定属性路径');
    const exp = this.exports[exportIndex];
    let node = this.parseExport(exportIndex);
    const chain = []; // 沿途的 prop 节点，全部标记为已修改，避免上层走 _rawBytes 快速通道

    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      const isLast = i === tokens.length - 1;
      if (t.type === 'prop') {
        if (!Array.isArray(node)) {
          if (node && typeof node === 'object' && t.value in node) {
            if (isLast) {
              const before = node[t.value];
              node[t.value] = value;
              markChain(chain);
              this.#touch(exportIndex, exp);
              return { path, before, after: value, type: typeof value };
            }
            node = node[t.value];
            continue;
          }
          throw new Error(`节点不是属性列表，无法取 .${t.value}`);
        }
        const found = node.find((p) => p && p.name === t.value);
        if (!found) throw new Error(`属性不存在: ${t.value}`);
        chain.push(found);
        if (isLast) {
          const before = found.value;
          const next = coerceValue(found, value, (n) => this.ensureName(n));
          if (Array.isArray(next)) ensureNamesDeep(next, (n) => this.ensureName(n));
          const patched = this.#tryPatchValue(exportIndex, exp, found, next);
          found.value = next;
          if (!patched) {
            exp.__raw = null; // 结构重建优先于字节补丁，避免两套数据打架
            markChain(chain);
            this.#touch(exportIndex, exp);
          }
          return { path, before, after: preview(next), type: found.type, mode: patched ? 'patch' : 'rebuild' };
        }
        node = found.value;
      } else {
        if (!Array.isArray(node)) throw new Error(`[${t.value}] 用于非数组节点`);
        if (t.type === 'index' && (t.value < 0 || t.value >= node.length)) throw new Error(`索引越界: ${t.value} (长度 ${node.length})`);
        if (isLast) {
          const before = node[t.value];
          node[t.value] = value;
          if (ownerIsStructList(node)) ensureNamesDeep(node[t.value], (n) => this.ensureName(n));
          markChain(chain);
          this.#touch(exportIndex, exp);
          return { path, before: preview(before), after: preview(value), type: typeof value };
        }
        node = node[t.value];
      }
    }
    throw new Error('路径解析失败');
  }

  /**
   * 值大小不变时直接在原始字节上打补丁（不做结构重建）。
   * 这是默认路径：数值/布尔/枚举/定长字符串插槽的编辑都是字节级精确的。
   * @returns {boolean} 是否成功就地打补丁
   */
  #tryPatchValue(exportIndex, exp, prop, nextValue) {
    if (!prop || typeof prop.__payloadOffset !== 'number') return false;
    if (exp.__raw === null && exp.isModified) return false; // 已走结构重建，补丁会与新布局冲突
    const relStart = exp.serialOffset - this.header.totalHeaderSize;
    if (relStart < 0) return false;
    const src = this.uexp || this.uasset;
    const base = exp.__raw || src.subarray(relStart, relStart + exp.serialSize);
    // reader 记录的偏移是「虚拟绝对偏移」（uexp 视图中以 totalHeaderSize 起算），转成导内相对偏移
    const local = (abs) => abs - exp.serialOffset;
    try {
      if (prop.type === 'BoolProperty') {
        if (typeof prop.__boolOffset !== 'number') return false;
        const copy = new Uint8Array(base);
        copy[local(prop.__boolOffset)] = nextValue ? 1 : 0;
        exp.__raw = copy;
        exp.isModified = true;
        this.modifiedExports.add(exportIndex);
        return true;
      }
      const probe = { ...prop, value: nextValue, __payloadOffset: undefined };
      const bytes = serializePayload(probe, this.names);
      if (bytes.length !== prop.size) return false; // 变长（字符串/数组）→ 走结构重建
      const copy = new Uint8Array(base);
      copy.set(bytes, local(prop.__payloadOffset));
      exp.__raw = copy;
      exp.isModified = true;
      this.modifiedExports.add(exportIndex);
      return true;
    } catch {
      return false;
    }
  }

  #markProp(prop) {
    prop.isModified = true;
  }

  #touch(exportIndex, exp) {
    exp.isModified = true;
    this.modifiedExports.add(exportIndex);
  }

  // ---------------------------------------------------------------- 结构编辑
  /** 在导出（或结构体路径）里新增属性 */
  addProperty(exportRef, def) {
    const exportIndex = this.resolveExport(exportRef);
    const exp = this.exports[exportIndex];
    const list = this.parseExport(exportIndex);
    if (!def || !def.name || !def.type) throw new Error('新增属性需要 name 与 type');
    if (list.some((p) => p.name === def.name && (p.arrayIndex || 0) === (def.arrayIndex || 0))) {
      throw new Error(`属性已存在: ${def.name}`);
    }
    const prop = {
      name: def.name,
      type: def.type,
      size: 0,
      arrayIndex: def.arrayIndex || 0,
      value: coerceValue({ type: def.type, ...def }, def.value, (n) => this.ensureName(n)),
      structName: def.structName,
      innerType: def.innerType,
      valueType: def.valueType,
      enumName: def.enumName,
      isExpandable: !!def.isExpandable,
      isModified: true,
    };
    ensureNamesDeep(prop, (n) => this.ensureName(n));
    list.push(prop);
    this.#touch(exportIndex, exp);
    return { exportIndex, added: prop.name, type: prop.type };
  }

  /** 删除属性（支持 `Export.Prop`、`Export.Array[0]`） */
  removeProperty(path) {
    const { exportIndex, tokens } = this.parsePath(path);
    if (!tokens.length) throw new Error('需要属性路径');
    const exp = this.exports[exportIndex];
    let node = this.parseExport(exportIndex);
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      const isLast = i === tokens.length - 1;
      if (t.type === 'prop') {
        if (!Array.isArray(node)) throw new Error('节点不是属性列表');
        const pos = node.findIndex((p) => p && p.name === t.value);
        if (pos < 0) throw new Error(`属性不存在: ${t.value}`);
        if (isLast) {
          const [removed] = node.splice(pos, 1);
          this.#touch(exportIndex, exp);
          return { exportIndex, removed: removed.name };
        }
        node = node[pos].value;
      } else {
        if (!Array.isArray(node)) throw new Error('非数组节点');
        if (isLast) {
          const [removed] = node.splice(t.value, 1);
          this.#touch(exportIndex, exp);
          return { exportIndex, removedIndex: t.value, removed };
        }
        node = node[t.value];
      }
    }
    throw new Error('路径解析失败');
  }

  /** 名称表：登记（不存在则追加） */
  ensureName(name) {
    if (typeof name !== 'string' || !name) return -1;
    const idx = this.names.indexOf(name);
    if (idx >= 0) return idx;
    this.names.push(name);
    this.namesDirty = true;
    return this.names.length - 1;
  }

  renameName(index, newName) {
    if (index < 0 || index >= this.names.length) throw new Error(`名称索引越界: ${index}`);
    const before = this.names[index];
    this.names[index] = newName;
    this.namesDirty = true;
    return { index, before, after: newName };
  }

  nameList({ query = '', offset = 0, limit = 200 } = {}) {
    const q = query.toLowerCase();
    const rows = this.names
      .map((n, i) => ({ index: i, name: n, referenced: n }))
      .filter((r) => !q || r.name.toLowerCase().includes(q));
    return { total: rows.length, offset, limit, items: rows.slice(offset, offset + limit) };
  }

  // ---------------------------------------------------------------- 搜索
  search(query, { regex = false, scope = 'all', limit = 100, caseSensitive = false } = {}) {
    let match;
    if (regex) {
      const re = new RegExp(query, caseSensitive ? '' : 'i');
      match = (s) => re.test(s);
    } else if (caseSensitive) {
      match = (s) => s.includes(query);
    } else {
      const q = query.toLowerCase();
      match = (s) => s.toLowerCase().includes(q);
    }

    const hits = [];
    if (scope === 'all' || scope === 'names') {
      this.names.forEach((n, i) => {
        if (match(n)) hits.push({ scope: 'name', index: i, value: n });
      });
    }
    if (scope === 'all' || scope === 'values' || scope === 'properties') {
      for (let i = 0; i < this.exports.length; i++) {
        let props;
        try { props = this.parseExport(i); } catch { continue; }
        walkProps(props, [], (prop, pathArr) => {
          if (scope !== 'names' && match(String(prop.name))) {
            hits.push({ scope: 'property', exportIndex: i, exportName: this.exports[i].objectName, path: pathArr.join('.'), type: prop.type, value: preview(prop.value) });
          }
          if (['StrProperty', 'NameProperty', 'TextProperty', 'EnumProperty', 'ObjectProperty', 'SoftObjectProperty'].includes(prop.type)) {
            const s = prop.type === 'TextProperty' ? prop.value && prop.value.sourceString : prop.type === 'SoftObjectProperty' ? prop.value && prop.value.assetPathName : prop.value;
            if (typeof s === 'string' && match(s)) {
              hits.push({ scope: 'value', exportIndex: i, exportName: this.exports[i].objectName, path: pathArr.join('.'), type: prop.type, value: s });
            }
          }
        });
        if (hits.length >= limit) break;
      }
    }
    return { total: hits.length, truncated: hits.length >= limit, items: hits.slice(0, limit) };
  }

  // ---------------------------------------------------------------- 原始字节
  /** 读取导出序列化区间的十六进制 */
  hexDump(exportRef, { offset = 0, length = 256 } = {}) {
    const idx = this.resolveExport(exportRef);
    const exp = this.exports[idx];
    const src = this.uexp || this.uasset;
    const start = exp.serialOffset - this.header.totalHeaderSize + offset;
    const bytes = src.subarray(Math.max(0, start), Math.min(src.length, start + length));
    return { exportIndex: idx, absoluteOffset: exp.serialOffset + offset, bytes: Array.from(bytes), hex: toHex(bytes) };
  }

  /** 直接改导出内的原始字节（用于引擎不认识的类型 / 手工微调） */
  patchBytes(exportRef, offset, bytes) {
    const idx = this.resolveExport(exportRef);
    const exp = this.exports[idx];
    const src = this.uexp || this.uasset;
    const rel = exp.serialOffset - this.header.totalHeaderSize;
    const base = exp.__raw || src.subarray(rel, rel + exp.serialSize);
    const copy = new Uint8Array(base);
    const patch = typeof bytes === 'string' ? fromHex(bytes) : asU8(bytes);
    if (offset < 0 || offset + patch.length > copy.length) {
      throw new Error(`补丁越界: offset=${offset} len=${patch.length} 区间=0..${copy.length}`);
    }
    copy.set(patch, offset);
    exp.__raw = copy;
    exp.isModified = true;
    this.modifiedExports.add(idx);
    return { exportIndex: idx, offset, length: patch.length, hex: toHex(patch) };
  }

  // ---------------------------------------------------------------- 保存
  /**
   * 序列化。
   * @param {{rebuildAll?:boolean, verify?:boolean}} opts
   */
  save({ rebuildAll = false, verify = true, force = false } = {}) {
    if (this.modifiedExports.size === 0 && !this.namesDirty) {
      return {
        uasset: this.uasset,
        uexp: this.uexp,
        unchanged: true,
        report: null,
        verification: { ok: true, problems: [] },
      };
    }
    // 写入前把所有会被引用的名称登记好（避免静默写成 "None"）
    for (const idx of this.modifiedExports) {
      const exp = this.exports[idx];
      if (exp.properties) ensureNamesDeep(exp.properties, (n) => this.ensureName(n));
    }
    // 重建前修正结构体数组的内层 header size（元素边界必须自洽，否则 UE 读不了）
    for (const idx of this.modifiedExports) {
      const exp = this.exports[idx];
      if (exp.properties) patchStructArraySizes(exp.properties, this.names);
    }
    if (!force) {
      for (const idx of this.modifiedExports) {
        const exp = this.exports[idx];
        if (exp.properties && !exp.__raw) {
          const bad = findRawFallback(exp.properties, exp.objectName);
          if (bad) {
            throw new Error(
              `拒绝重建导出 #${idx} (${exp.objectName})：${bad}。\n` +
              `这类结构在解析时退化为原始字节块，重建会改变字节布局。\n` +
              `改用定长编辑（数值/布尔/枚举，会自动走字节补丁），或显式传入 force=true 强制重建。`
            );
          }
        }
      }
    }

    const out = serializePackage(
      {
        uasset: this.uasset,
        uexp: this.uexp,
        header: this.header,
        names: this.names,
        originalNames: this.originalNames,
        imports: this.imports,
        exports: this.exports,
      },
      { rebuildAll }
    );

    const verification = verify ? verifySaved({ modifiedExports: [...this.modifiedExports] }, out, { deep: true }) : { ok: true, problems: [] };
    return { ...out, unchanged: false, report: out.report, verification };
  }

  /**
   * 保存到磁盘（默认写入 `.mod.uasset` / `.mod.uexp`，绝不覆盖源文件，除非 overwrite=true）
   */
  async saveToFile(uassetPath, { uexpPath, overwrite = false, suffix = '.mod', verify = true, force = false } = {}) {
    const fs = await import('node:fs/promises');
    const out = this.save({ verify, force });
    const outAsset = overwrite ? uassetPath : uassetPath.replace(/\.uasset$/i, `${suffix}.uasset`);
    await fs.writeFile(outAsset, Buffer.from(out.uasset));
    let outUexp = null;
    if (out.uexp) {
      const guessed = uexpPath || uassetPath.replace(/\.uasset$/i, '.uexp');
      outUexp = overwrite ? guessed : guessed.replace(/\.uexp$/i, `${suffix}.uexp`);
      await fs.writeFile(outUexp, Buffer.from(out.uexp));
    }
    return { uassetPath: outAsset, uexpPath: outUexp, verification: out.verification, report: out.report };
  }

  /**
   * 打一个「编辑状态」快照。
   *
   * 注意：set() 改的是解析树，不是 this.uasset 缓冲区 —— 所以快照必须深拷贝解析树，
   * 用缓冲区做快照会把快照之前的所有修改一起丢掉。
   */
  snapshotState() {
    return {
      exports: deepClone(this.exports),
      names: [...this.names],
      modified: [...this.modifiedExports],
      namesDirty: this.namesDirty,
    };
  }

  /** 恢复到 snapshotState() 的结果 */
  restoreState(snap) {
    if (!snap) throw new Error('快照为空');
    this.exports = deepClone(snap.exports);
    this.names = [...snap.names];
    this.modifiedExports = new Set(snap.modified);
    this.namesDirty = snap.namesDirty;
    return this;
  }

  /** 用上次 save 的结果刷新内存状态（继续编辑时用） */
  adopt({ uasset, uexp }) {
    this.#loadBuffers(uasset, uexp);
    this.modifiedExports.clear();
    this.namesDirty = false;
    return this;
  }

  /** 回滚到打开时的状态 */
  rollback() {
    this.#loadBuffers(this.original.uasset, this.original.uexp);
    this.modifiedExports.clear();
    this.namesDirty = false;
    this.notes = [];
    return this;
  }

  // ---------------------------------------------------------------- 输出
  toJSON({ exportRef = null, depth = 12 } = {}) {
    if (exportRef !== null) {
      const idx = this.resolveExport(exportRef);
      return {
        exportIndex: idx,
        exportName: this.exports[idx].objectName,
        className: this.#classNameOf(this.exports[idx]),
        properties: toPlain(this.parseExport(idx), depth),
      };
    }
    return {
      info: this.info(),
      exports: this.exports.map((e, i) => {
        let props = null;
        try { props = toPlain(this.parseExport(i), depth); } catch (e) { props = { error: String(e.message || e) }; }
        return { index: i, name: e.objectName, className: this.#classNameOf(e), serialOffset: e.serialOffset, serialSize: e.serialSize, properties: props };
      }),
    };
  }

  /** 面向 AI 的紧凑树：按需展开，控制 token */
  tree({ exportRef = null, depth = 3, maxItems = 40 } = {}) {
    const idx = exportRef === null ? 0 : this.resolveExport(exportRef);
    const exp = this.exports[idx];
    const props = this.parseExport(idx);
    return {
      exportIndex: idx,
      exportName: exp.objectName,
      className: this.#classNameOf(exp),
      serialSize: exp.serialSize,
      properties: props.slice(0, maxItems).map((p) => treeProp(p, depth)),
      total: props.length,
      truncated: props.length > maxItems,
    };
  }

  diff(other) {
    const a = this.parseAll().toJSON();
    const b = other.parseAll().toJSON();
    return diffJSON(a, b);
  }
}

// -------------------------------------------------------------------- 工具
/**
 * 修正「结构体数组」的内层 header size。
 * UE 的 array-of-struct 在元素前有一个内层 FPropertyTag（name/type/size/index/structName/guid/hasGuid），
 * 其中的 size 必须等于所有元素序列化后的总字节数，否则后续元素边界会错位。
 */
/** 深拷贝解析树：保留 Uint8Array、保留属性数组上的 _rawBytes 等附加键 */
export function deepClone(v) {
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof Uint8Array) return v.slice();
  if (Array.isArray(v)) {
    const out = v.map(deepClone);
    for (const k of Object.keys(v)) {
      if (/^\d+$/.test(k)) continue;
      out[k] = deepClone(v[k]);
    }
    return out;
  }
  const out = {};
  for (const k of Object.keys(v)) out[k] = deepClone(v[k]);
  return out;
}

export function patchStructArraySizes(props, names) {
  for (const p of props || []) {
    if (!p || typeof p !== 'object') continue;

    if (p.type === 'ArrayProperty' && p.innerType === 'StructProperty'
        && p.arrayStructInfo && Array.isArray(p.value)
        && !p.arrayStructInfo.isNativePhysicsArray) {
      const info = p.arrayStructInfo;
      // 只有「需要重算」的数组才动 header：被改动、或含未解析的原始块
      let total = 0;
      let exact = true;
      for (const item of p.value) {
        if (item instanceof Uint8Array) {
          total += item.length;               // 原始块：长度已知，原样搬运
        } else if (Array.isArray(item)) {
          if (item.length === 1 && item[0] && item[0].type === 'ByteProperty' && item[0].value instanceof Uint8Array) {
            total += item[0].value.length;
          } else {
            try {
              total += measureProps(item, names);
            } catch {
              exact = false;
            }
          }
        } else if (item && typeof item === 'object') {
          total += structPrimitiveSize(info.structName);
        }
      }
      // 写回前把 header 总长改成实际写出的字节数；UE 用这个字段界定数组边界
      if (exact && total > 0) info.originalHeaderSize = total;
      if (exact) info.size = p.value.length > 0 ? Math.floor(total / p.value.length) : info.size;
    }

    if (p.type === 'StructProperty' && Array.isArray(p.value)) patchStructArraySizes(p.value, names);
    if (p.type === 'ArrayProperty' && Array.isArray(p.value)) {
      for (const el of p.value) if (Array.isArray(el) && el[0] && el[0].name) patchStructArraySizes(el, names);
    }
  }
}

function measureProps(props, names) {
  const w = new UAssetBinaryWriter(1 << 16);
  const pw = new UAssetPropertyWriter(w, names, false);
  pw.writeProperties(props);
  return w.getBuffer().length;
}

function structPrimitiveSize(structName) {
  switch (structName) {
    case 'Vector': case 'Rotator': return 12;
    case 'Vector2D': return 8;
    case 'Quat': case 'Vector4': case 'LinearColor': case 'Plane': return 16;
    case 'Color': return 4;
    case 'IntPoint': return 8;
    case 'Box': return 25;
    case 'Box2D': return 17;
    case 'Transform': return 40;
    case 'Guid': return 16;
    default: return 0;
  }
}

/** 把一条属性链上的所有节点标记为已修改（struct 的 _rawBytes 快路径依赖 isModified） */
function markChain(chain) {
  for (const p of chain) {
    if (!p || typeof p !== 'object') continue;
    p.isModified = true;
    if (Array.isArray(p.value)) {
      for (const el of p.value) {
        if (Array.isArray(el)) {
          for (const c of el) if (c && typeof c === 'object') c.isModified = true;
        } else if (el && typeof el === 'object' && el.name) {
          el.isModified = true;
        }
      }
    }
  }
}

function ownerIsStructList(node) {
  return Array.isArray(node) && node.length > 0 && Array.isArray(node[0]) && node[0][0] && node[0][0].name;
}

function summarizeProps(props) {
  const out = {};
  for (const p of props) out[p.name] = preview(p.value);
  return out;
}

function treeProp(p, depth) {
  const base = { name: p.name, type: p.type, size: p.size, arrayIndex: p.arrayIndex || 0 };
  if (p.structName) base.structName = p.structName;
  if (p.innerType) base.innerType = p.innerType;
  if (p.enumName) base.enumName = p.enumName;
  if (depth <= 0) { base.value = preview(p.value); return base; }
  if (p.type === 'StructProperty' && Array.isArray(p.value)) {
    base.children = p.value.slice(0, 40).map((c) => treeProp(c, depth - 1));
    if (p.value.length > 40) base.childrenTruncated = p.value.length - 40;
    return base;
  }
  if (p.type === 'ArrayProperty' && Array.isArray(p.value)) {
    base.count = p.value.length;
    base.items = p.value.slice(0, 10).map((item) =>
      Array.isArray(item) && item[0] && item[0].name
        ? { children: item.slice(0, 40).map((c) => treeProp(c, depth - 1)) }
        : preview(item)
    );
    if (p.value.length > 10) base.itemsTruncated = p.value.length - 10;
    return base;
  }
  base.value = preview(p.value);
  return base;
}

/** 归一化赋值：按属性类型转换 */
export function coerceValue(prop, value, ensureName) {
  const t = prop.type;
  switch (t) {
    case 'BoolProperty':
      return typeof value === 'string' ? value.toLowerCase() === 'true' || value === '1' : !!value;
    case 'Int8Property': case 'Int16Property': case 'IntProperty': case 'Int64Property':
    case 'UInt16Property': case 'UInt32Property': case 'UInt64Property':
    case 'FloatProperty': case 'DoubleProperty':
      return typeof value === 'number' ? value : Number(value);
    case 'StrProperty': case 'AnsiStrProperty': case 'Utf8StrProperty':
      return String(value);
    case 'NameProperty':
      if (ensureName) ensureName(String(value));
      return String(value);
    case 'EnumProperty':
      if (ensureName) ensureName(String(value));
      return typeof value === 'object' ? value : String(value);
    case 'ByteProperty':
      if (typeof value === 'string' && !/^-?\d+$/.test(value)) {
        if (ensureName) ensureName(value);
        return value;
      }
      return Number(value);
    case 'ObjectProperty': case 'ClassProperty': case 'InterfaceProperty':
    case 'WeakObjectProperty': case 'LazyObjectProperty': case 'AssetObjectProperty': case 'AssetClassProperty':
      if (ensureName) ensureName(String(value));
      return String(value);
    case 'SoftObjectProperty': case 'SoftClassProperty':
      if (typeof value === 'object' && value) return value;
      if (ensureName) ensureName(String(value));
      return { assetPathName: String(value), subPathString: prop.value && prop.value.subPathString ? prop.value.subPathString : '' };
    case 'TextProperty': {
      const prev = prop.value && typeof prop.value === 'object' ? prop.value : { flags: 0, historyType: 0, namespace: '', key: '' };
      if (typeof value === 'object' && value) return { ...prev, ...value };
      return { ...prev, sourceString: String(value) };
    }
    case 'StructProperty':
      if (Array.isArray(value)) return value;
      if (typeof value === 'object' && value) {
        const children = Array.isArray(prop.value) ? prop.value : [];
        return children.map((c) => (value[c.name] !== undefined ? { ...c, value: coerceValue(c, value[c.name], ensureName), isModified: true } : c));
      }
      return value;
    case 'ArrayProperty':
      return Array.isArray(value) ? value : [value];
    default:
      return value;
  }
}

/** 递归登记一个属性树里所有会被写成 FName 的字符串 */
export function ensureNamesDeep(node, ensureName) {
  if (Array.isArray(node)) {
    for (const item of node) ensureNamesDeep(item, ensureName);
    return;
  }
  if (!node || typeof node !== 'object') return;
  if (typeof node.name === 'string' && typeof node.type === 'string') {
    ensureName(node.name);
    ensureName(node.type);
    if (node.structName) ensureName(node.structName);
    if (node.innerType) ensureName(node.innerType);
    if (node.valueType) ensureName(node.valueType);
    if (node.enumName) ensureName(node.enumName);
    const t = node.type;
    const v = node.value;
    if ((t === 'EnumProperty' || t === 'ByteProperty' || t === 'ObjectProperty' || t === 'ClassProperty' ||
         t === 'InterfaceProperty' || t === 'WeakObjectProperty' || t === 'LazyObjectProperty' ||
         t === 'AssetObjectProperty' || t === 'AssetClassProperty') && typeof v === 'string') {
      ensureName(v);
    }
    if ((t === 'SoftObjectProperty' || t === 'SoftClassProperty') && v && typeof v === 'object' && v.assetPathName) {
      ensureName(v.assetPathName);
    }
    if (t === 'DelegateProperty' && v && v.functionName) ensureName(v.functionName);
    if (t === 'MulticastDelegateProperty' && Array.isArray(v)) v.forEach((d) => d && d.functionName && ensureName(d.functionName));
    if (v && typeof v === 'object') ensureNamesDeep(v, ensureName);
    return;
  }
  for (const k of Object.keys(node)) ensureNamesDeep(node[k], ensureName);
}

function preview(v, depth = 0) {
  if (v === null || v === undefined) return v ?? null;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v;
  if (v instanceof Uint8Array) return `<${v.length} bytes>`;
  if (Array.isArray(v)) {
    if (v.length && v[0] && v[0].name && v[0].type) {
      const o = {};
      for (const p of v) o[p.name] = preview(p.value, depth + 1);
      return o;
    }
    return v.slice(0, 8).map((x) => preview(x, depth + 1)).concat(v.length > 8 ? [`...+${v.length - 8}`] : []);
  }
  if (typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).slice(0, 12)) o[k] = preview(v[k], depth + 1);
    return o;
  }
  return String(v);
}

function walkProps(props, pathArr, cb) {
  if (!Array.isArray(props)) return;
  for (const p of props || []) {
    if (!p || typeof p !== 'object') continue;
    cb(p, [...pathArr, p.name]);
    if (Array.isArray(p.value)) {
      if (p.value.length && p.value[0] && p.value[0].name && p.value[0].type) {
        walkProps(p.value, [...pathArr, p.name], cb);
      } else if (p.value.length && Array.isArray(p.value[0])) {
        p.value.forEach((el, i) => walkProps(el, [...pathArr, `${p.name}[${i}]`], cb));
      }
    }
  }
}

function toPlain(node, depth) {
  if (depth < 0) return '<deep>';
  if (node instanceof Uint8Array) return `<${node.length} bytes: ${toHex(node.subarray(0, 32))}${node.length > 32 ? '...' : ''}>`;
  if (Array.isArray(node)) return node.map((x) => toPlain(x, depth - 1));
  if (node && typeof node === 'object') {
    const o = {};
    for (const k of Object.keys(node)) {
      if (k === 'originalBytes' || k === '__raw' || k === 'paddingData') continue;
      o[k] = toPlain(node[k], depth - 1);
    }
    return o;
  }
  return node;
}

export function toHex(u8) {
  return Array.from(u8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex) {
  const clean = String(hex).replace(/[^0-9a-fA-F]/g, '');
  if (clean.length % 2) throw new Error('十六进制长度必须是偶数');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function diffJSON(a, b, path = '', out = []) {
  const isObj = (x) => x && typeof x === 'object';
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (i >= a.length) out.push({ path: `${path}[${i}]`, kind: 'added', after: b[i] });
      else if (i >= b.length) out.push({ path: `${path}[${i}]`, kind: 'removed', before: a[i] });
      else diffJSON(a[i], b[i], `${path}[${i}]`, out);
    }
    return out;
  }
  if (isObj(a) && isObj(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (!(k in a)) out.push({ path: path ? `${path}.${k}` : k, kind: 'added', after: b[k] });
      else if (!(k in b)) out.push({ path: path ? `${path}.${k}` : k, kind: 'removed', before: a[k] });
      else diffJSON(a[k], b[k], path ? `${path}.${k}` : k, out);
    }
    return out;
  }
  if (a !== b) out.push({ path, kind: 'changed', before: a, after: b });
  return out;
}

/**
 * 找出「解析时退化成原始字节块、且又被改动链波及」的结构体。
 *
 * 判据：节点自身没有 isModified 时，写入器会直接吐出它的 _rawBytes（原字节），
 * 这类节点重建是安全的；只有落在改动链上、又被降级成原始块的节点才会破坏布局。
 *
 * @returns {string|null} 第一个命中的路径，未命中返回 null
 */
export function findRawFallback(props, exportName = '') {
  const stack = [{ props, path: exportName }];
  while (stack.length) {
    const { props: list, path } = stack.pop();
    if (!Array.isArray(list)) continue;
    if (list._rawBytes && list.length === 0 && list.isModified) return `${path} 的属性表退化为原始字节块且被改动`;
    for (const p of list) {
      if (!p || typeof p !== 'object') continue;
      const here = path ? `${path}.${p.name}` : p.name;
      const isComplex = p.type === 'StructProperty' || p.type === 'ArrayProperty'
        || p.type === 'SetProperty' || p.type === 'MapProperty';
      if (isComplex && p.isModified) {
        if (p.value instanceof Uint8Array) return `${here} 结构体解析失败（${p.value.length} 字节原始块）且被改动`;
        if (Array.isArray(p.value) && p.value._rawBytes && p.value.length === 0) {
          return `${here} 结构体解析失败（${p.value._rawBytes.length} 字节原始块）且被改动`;
        }
        // 数组元素级别：被改动数组里若有元素本身是原始块，也要拒绝
        if (Array.isArray(p.value)) {
          for (let i = 0; i < p.value.length; i++) {
            const el = p.value[i];
            if (el instanceof Uint8Array) return `${here}[${i}] 元素为原始字节块且所在数组被改动`;
            if (Array.isArray(el) && el._rawBytes && el.length === 0) {
              return `${here}[${i}] 元素结构体解析失败（${el._rawBytes.length} 字节）且所在数组被改动`;
            }
          }
        }
      }
      if (Array.isArray(p.value)) {
        for (let i = p.value.length - 1; i >= 0; i--) {
          const el = p.value[i];
          if (Array.isArray(el)) stack.push({ props: el, path: `${here}[${i}]` });
        }
      }
    }
  }
  return null;
}
