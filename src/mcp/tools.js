/* eslint-disable */
/**
 * tools.js — MCP 工具集（全部基于 core 的 Package，无第三方依赖）
 *
 * 设计原则（给 AI 用）：
 *   - 每个工具都有明确的 schema 描述与 examples
 *   - 读接口允许分页/截断，避免一次把 5MB 属性树塞进上下文
 *   - 写接口默认 dryRun 可观（返回 before/after/mode），并区分 patch / rebuild 两种落盘方式
 *   - 所有失败都返回可执行的下一步（相近属性名、合法导出名、可用类型等）
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { Package, toHex, fromHex } from '../core/index.js';
import { Pak } from '../core/pak.js';

const sessions = new Map();
let seq = 0;
const MAX_SESSIONS = 32;

function newSession(pkg, source) {
  const id = `s${++seq}`;
  if (sessions.size >= MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    sessions.delete(oldest);
  }
  sessions.set(id, { pkg, source, openedAt: Date.now() });
  return id;
}

function getSession(id) {
  const s = sessions.get(id);
  if (!s) {
    const ids = [...sessions.keys()];
    throw new Error(`会话不存在: ${id}${ids.length ? `（当前活动会话: ${ids.join(', ')}）` : '（还没有打开任何资产，先调用 uasset_open）'}`);
  }
  return s;
}

/** 值预览：给 AI 看的紧凑表示，不塞二进制 */
function previewValue(v, depth = 0) {
  if (v === null || v === undefined) return null;
  if (v instanceof Uint8Array) return `<${v.length} bytes>`;
  if (typeof v !== 'object') return v;
  if (Array.isArray(v)) {
    if (v.length === 0) return [];
    if (depth >= 2) return `[${v.length} items]`;
    return v.slice(0, 20).map((x) => previewValue(x, depth + 1));
  }
  if (v.assetPathName !== undefined) return { assetPathName: v.assetPathName, subPathString: v.subPathString };
  const out = {};
  for (const k of Object.keys(v).slice(0, 20)) {
    if (k.startsWith('__') || k === '_rawBytes') continue;
    out[k] = previewValue(v[k], depth + 1);
  }
  return out;
}

/** 统计属性树里有多少节点退化成原始字节块 */
function countRawBlocks(props) {
  let n = 0;
  const walk = (list) => {
    if (!Array.isArray(list)) return;
    if (list._rawBytes && list.length === 0) n++;
    for (const p of list) {
      if (!p || typeof p !== 'object') continue;
      if (p.value instanceof Uint8Array && (p.type === 'StructProperty' || p.type === 'ArrayProperty')) n++;
      else if (Array.isArray(p.value) && p.value._rawBytes && p.value.length === 0) n++;
      if (Array.isArray(p.value)) for (const el of p.value) if (Array.isArray(el)) walk(el);
    }
  };
  walk(props);
  return n;
}

const pakSessions = new Map();
let pakSeq = 0;

function newPakSession(pak, source) {
  const id = `p${++pakSeq}`;
  if (pakSessions.size >= MAX_SESSIONS) pakSessions.delete(pakSessions.keys().next().value);
  pakSessions.set(id, { pak, source, openedAt: Date.now() });
  return id;
}

function getPakSession(id) {
  const s = pakSessions.get(id);
  if (!s) {
    const ids = [...pakSessions.keys()];
    throw new Error(`pak 会话不存在: ${id}${ids.length ? `（可用: ${ids.join(', ')}）` : '（先调用 pak_open）'}`);
  }
  return s;
}

const asText = (x) => (typeof x === 'string' ? x : JSON.stringify(x));

export const tools = [
  {
    name: 'uasset_open',
    description:
      '打开一个 UE4/UE5 资产（.uasset，配套 .uexp 自动发现）。返回 sessionId 与结构概况。' +
      '后续所有读写工具都要带 session。配套 .uexp 缺省按同名推断。',
    inputSchema: {
      type: 'object',
      properties: {
        uassetPath: { type: 'string', description: '绝对路径，例如 /sdcard/Download/BP_Rifle.uasset' },
        uexpPath: { type: 'string', description: '可选，显式指定 .uexp 路径' },
      },
      required: ['uassetPath'],
    },
    examples: [{ uassetPath: '/sdcard/Download/BP_Rifle_AUG.uasset' }],
    handler: async ({ uassetPath, uexpPath }) => {
      const pkg = await Package.fromFile(uassetPath, { uexpPath });
      const id = newSession(pkg, { uassetPath, uexpPath: uexpPath || (pkg.isSplit ? uassetPath.replace(/\.uasset$/i, '.uexp') : null) });
      return { session: id, ...pkg.info(), next: 'uasset_list_exports / uasset_tree' };
    },
  },
  {
    name: 'uasset_open_bytes',
    description: '以 base64 打开资产（适合从手机/远端直接贴内容，或浏览器端传来）。',
    inputSchema: {
      type: 'object',
      properties: {
        uassetBase64: { type: 'string' },
        uexpBase64: { type: 'string' },
        name: { type: 'string' },
      },
      required: ['uassetBase64'],
    },
    handler: async ({ uassetBase64, uexpBase64, name }) => {
      const dec = (b64) => {
        const buf = Buffer.from(b64, 'base64');
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      };
      const pkg = new Package({ uasset: dec(uassetBase64), uexp: uexpBase64 ? dec(uexpBase64) : null, name: name || 'inline.uasset' });
      const id = newSession(pkg, { name: name || 'inline' });
      return { session: id, ...pkg.info() };
    },
  },
  {
    name: 'uasset_close',
    description: '关闭会话并释放内存。',
    inputSchema: { type: 'object', properties: { session: { type: 'string' } }, required: ['session'] },
    handler: async ({ session }) => {
      const existed = sessions.delete(session);
      return { session, closed: existed };
    },
  },
  {
    name: 'uasset_info',
    description: '资产概况：引擎版本、包内表大小、导出/导入数量、是否脏（有未保存改动）、备注（解析告警）。',
    inputSchema: { type: 'object', properties: { session: { type: 'string' } }, required: ['session'] },
    handler: async ({ session }) => {
      const { pkg } = getSession(session);
      return { ...pkg.info(), notes: pkg.notes.slice(-10), modifiedExports: [...pkg.modifiedExports] };
    },
  },
  {
    name: 'uasset_list_exports',
    description: '列导出（对象）。支持按名字/类名过滤与分页；AI 先用它确定要改哪个导出。',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        filter: { type: 'string', description: '子串过滤（名字或类名，忽略大小写）' },
        offset: { type: 'integer', default: 0 },
        limit: { type: 'integer', default: 50 },
      },
      required: ['session'],
    },
    handler: async ({ session, filter = '', offset = 0, limit = 50 }) => getSession(session).pkg.exportList({ filter, offset, limit }),
  },
  {
    name: 'uasset_list_names',
    description: '列名称表（FName 表）。新增属性/改名时用它确认名称是否已存在。',
    inputSchema: {
      type: 'object',
      properties: { session: { type: 'string' }, query: { type: 'string' }, offset: { type: 'integer', default: 0 }, limit: { type: 'integer', default: 100 } },
      required: ['session'],
    },
    handler: async ({ session, query = '', offset = 0, limit = 100 }) => getSession(session).pkg.nameList({ query, offset, limit }),
  },
  {
    name: 'uasset_tree',
    description:
      '读一个导出的属性树（有深度与条数上限，适合一眼看清结构）。默认导出 #0，建议先对 CDO（名字常以 Default__ 开头）取树。',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        export: { type: ['string', 'integer'], description: '导出名或 #索引' },
        depth: { type: 'integer', default: 3 },
        maxItems: { type: 'integer', default: 40 },
      },
      required: ['session'],
    },
    handler: async ({ session, export: exp, depth = 3, maxItems = 40 }) => getSession(session).pkg.tree({ exportRef: exp ?? 0, depth, maxItems }),
  },
  {
    name: 'uasset_get',
    description:
      '按路径读值。路径语法：`导出名.属性[下标].子属性`，例如 `Default__BP_Rifle_AUG_C.WeaponAttrModifyConfigList[0].ModifyConfigID`。' +
      '导出名可用 #索引。返回类型/大小/值（复杂值已做摘要，必要时用 uasset_tree 展开）。',
    inputSchema: { type: 'object', properties: { session: { type: 'string' }, path: { type: 'string' } }, required: ['session', 'path'] },
    handler: async ({ session, path: p }) => getSession(session).pkg.get(p),
  },
  {
    name: 'uasset_set',
    description:
      '按路径写值。自动按属性类型归一化（bool/number/string/enum/FText/SoftObject…）。' +
      '定长值走「字节补丁」（mode=patch，只改动目标字节，最安全）；变长值走结构重建（mode=rebuild）。' +
      'dryRun=true 只计算不落内存。',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        path: { type: 'string' },
        value: { description: '新值（布尔/数字/字符串/对象）' },
        dryRun: { type: 'boolean', default: false },
      },
      required: ['session', 'path', 'value'],
    },
    handler: async ({ session, path: p, value, dryRun = false }) => {
      const { pkg } = getSession(session);
      const before = pkg.get(p);
      if (dryRun) {
        return { dryRun: true, path: p, current: { type: before.type, value: before.value }, willSet: value };
      }
      const r = pkg.set(p, value);
      return { ...r, next: 'uasset_save（或继续改）' };
    },
  },
  {
    name: 'uasset_set_many',
    description: '批量写（一次事务）。任一失败默认整体回滚（atomic=true）。',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        edits: {
          type: 'array',
          items: { type: 'object', properties: { path: { type: 'string' }, value: {} }, required: ['path', 'value'] },
        },
        atomic: { type: 'boolean', default: true },
      },
      required: ['session', 'edits'],
    },
    handler: async ({ session, edits, atomic = true }) => {
      const { pkg } = getSession(session);
      const snapshot = { uasset: pkg.uasset.slice(), uexp: pkg.uexp ? pkg.uexp.slice() : null, mods: new Set(pkg.modifiedExports) };
      const results = [];
      try {
        for (const e of edits) results.push(pkg.set(e.path, e.value));
      } catch (err) {
        if (atomic) {
          pkg.rollback();
          for (const m of snapshot.mods) pkg.modifiedExports.add(m);
        }
        return { ok: false, error: String(err.message || err), rolledBack: atomic, applied: results };
      }
      return { ok: true, count: results.length, results };
    },
  },
  {
    name: 'uasset_add_property',
    description:
      '给导出新增属性。name 会自动登记进名称表（原实现遇到未登记名字会静默写成 None，这里不会）。' +
      'type 取 UE 属性类型名，如 IntProperty/FloatProperty/BoolProperty/StrProperty/NameProperty/EnumProperty/ObjectProperty/StructProperty。' +
      'StructProperty 需带 structName；ArrayProperty 需带 innerType；Enum/Byte 建议带 enumName。',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        export: { type: ['string', 'integer'] },
        name: { type: 'string' },
        type: { type: 'string' },
        value: {},
        structName: { type: 'string' },
        innerType: { type: 'string' },
        valueType: { type: 'string' },
        enumName: { type: 'string' },
      },
      required: ['session', 'export', 'name', 'type'],
    },
    handler: async (args) => {
      const { pkg } = getSession(args.session);
      const r = pkg.addProperty(args.export, args);
      return { ...r, dirty: true, hint: '新增属性需要重建导出，保存时会自动扩容名称表' };
    },
  },
  {
    name: 'uasset_delete_property',
    description: '删除属性或数组元素（路径支持 `Export.Prop` 与 `Export.Arr[0]`）。',
    inputSchema: { type: 'object', properties: { session: { type: 'string' }, path: { type: 'string' } }, required: ['session', 'path'] },
    handler: async ({ session, path: p }) => getSession(session).pkg.removeProperty(p),
  },
  {
    name: 'uasset_search',
    description: '搜索名称表/属性名/字符串值（支持正则）。用于定位「后坐力/Recoil」「伤害/Damage」这类目标。',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        query: { type: 'string' },
        regex: { type: 'boolean', default: false },
        scope: { type: 'string', enum: ['all', 'names', 'values', 'properties'], default: 'all' },
        limit: { type: 'integer', default: 80 },
      },
      required: ['session', 'query'],
    },
    handler: async ({ session, query, regex = false, scope = 'all', limit = 80 }) => getSession(session).pkg.search(query, { regex, scope, limit }),
  },
  {
    name: 'uasset_hexdump',
    description: '看导出序列化区间的十六进制（定位引擎不认识的类型/手工微调用）。',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        export: { type: ['string', 'integer'] },
        offset: { type: 'integer', default: 0 },
        length: { type: 'integer', default: 256 },
      },
      required: ['session', 'export'],
    },
    handler: async ({ session, export: exp, offset = 0, length = 256 }) => {
      const r = getSession(session).pkg.hexDump(exp, { offset, length });
      return { exportIndex: r.exportIndex, absoluteOffset: r.absoluteOffset, hex: r.hex };
    },
  },
  {
    name: 'uasset_patch_bytes',
    description:
      '直接改导出内的原始字节（十六进制字符串，如 "0000803f"）。用于引擎解析不出的字段：' +
      '先 uasset_hexdump 定位，再精确覆盖。',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        export: { type: ['string', 'integer'] },
        offset: { type: 'integer' },
        hex: { type: 'string' },
      },
      required: ['session', 'export', 'offset', 'hex'],
    },
    handler: async ({ session, export: exp, offset, hex }) => getSession(session).pkg.patchBytes(exp, offset, hex),
  },
  {
    name: 'uasset_verify',
    description: '对当前内存状态做一次预演序列化 + 自检（不写盘）：名称表、导出区间、被改导出的可解析性。',
    inputSchema: { type: 'object', properties: { session: { type: 'string' }, force: { type: 'boolean', default: false } }, required: ['session'] },
    handler: async ({ session, force = false }) => {
      const { pkg } = getSession(session);
      try {
        const out = pkg.save({ verify: true, force });
        return { ok: out.verification.ok, problems: out.verification.problems, report: out.report, changed: !out.unchanged };
      } catch (e) {
        return { ok: false, error: String(e.message || e) };
      }
    },
  },
  {
    name: 'uasset_save',
    description:
      '保存。默认写 `<原名>.mod.uasset` / `.mod.uexp`（不覆盖源文件）；overwrite=true 才就地覆盖。' +
      '返回路径与自检结果。force=true 才允许对「含未解析原始块」的结构做强制重建。',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        outDir: { type: 'string', description: '可选输出目录' },
        overwrite: { type: 'boolean', default: false },
        suffix: { type: 'string', default: '.mod' },
        force: { type: 'boolean', default: false },
      },
      required: ['session'],
    },
    handler: async ({ session, outDir, overwrite = false, suffix = '.mod', force = false }) => {
      const s = getSession(session);
      const { pkg } = s;
      const src = s.source.uassetPath;
      let target = src;
      if (!src) throw new Error('该会话是用 base64 打开的，请用 uasset_export_base64');
      if (outDir) {
        await fs.mkdir(outDir, { recursive: true });
        target = path.join(outDir, path.basename(src));
      }
      const res = await pkg.saveToFile(target, { overwrite, suffix, force });
      return { ...res, note: res.uexpPath ? '.uasset 与 .uexp 必须成对使用' : '单文件资产' };
    },
  },
  {
    name: 'uasset_export_base64',
    description: '把当前（可能已修改的）资产导出为 base64，便于远端/浏览器直接使用。',
    inputSchema: { type: 'object', properties: { session: { type: 'string' }, force: { type: 'boolean', default: false } }, required: ['session'] },
    handler: async ({ session, force = false }) => {
      const out = getSession(session).pkg.save({ force });
      return {
        uassetBytes: out.uasset.length,
        uexpBytes: out.uexp ? out.uexp.length : 0,
        uassetBase64: Buffer.from(out.uasset).toString('base64'),
        uexpBase64: out.uexp ? Buffer.from(out.uexp).toString('base64') : null,
        verification: out.verification,
      };
    },
  },
  {
    name: 'uasset_export_json',
    description: '导出为 JSON（全部导出或指定导出）。depth 控制嵌套深度，避免超大输出。',
    inputSchema: {
      type: 'object',
      properties: { session: { type: 'string' }, export: { type: ['string', 'integer'] }, depth: { type: 'integer', default: 8 } },
      required: ['session'],
    },
    handler: async ({ session, export: exp, depth = 8 }) => getSession(session).pkg.toJSON({ exportRef: exp ?? null, depth }),
  },
  {
    name: 'uasset_diff',
    description: '对比两个会话（或一个会话与磁盘文件）的属性差异，返回逐路径的 before/after。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionA: { type: 'string' },
        sessionB: { type: 'string', description: '另一个会话；与 uassetPathB 二选一' },
        uassetPathB: { type: 'string', description: '磁盘上的另一个资产' },
        limit: { type: 'integer', default: 100 },
      },
      required: ['sessionA'],
    },
    handler: async ({ sessionA, sessionB, uassetPathB, limit = 100 }) => {
      const a = getSession(sessionA).pkg;
      const b = sessionB ? getSession(sessionB).pkg : await Package.fromFile(uassetPathB);
      const d = a.diff(b);
      return { total: d.length, truncated: d.length > limit, items: d.slice(0, limit) };
    },
  },
  {
    name: 'uasset_rename_name',
    description: '改名称表某一项（影响所有引用它的属性名/字符串）。定长以内只会打补丁，超长需要扩容。',
    inputSchema: {
      type: 'object',
      properties: { session: { type: 'string' }, index: { type: 'integer' }, newName: { type: 'string' } },
      required: ['session', 'index', 'newName'],
    },
    handler: async ({ session, index, newName }) => getSession(session).pkg.renameName(index, newName),
  },
  {
    name: 'uasset_rollback',
    description: '丢弃当前会话的所有改动，回到打开时的字节状态。',
    inputSchema: { type: 'object', properties: { session: { type: 'string' } }, required: ['session'] },
    handler: async ({ session }) => {
      getSession(session).pkg.rollback();
      return { session, rolledBack: true };
    },
  },
  {
    name: 'uasset_scan_dir',
    description:
      '批量扫描目录里的资产并汇总（类名、引擎版本、导出数、大小、是否 DataTable）。' +
      '用于「这一堆 pak 解出来的资产里哪几个是武器配置」这类问题。',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string' },
        recursive: { type: 'boolean', default: true },
        filter: { type: 'string', description: '文件名子串过滤' },
        limit: { type: 'integer', default: 200 },
      },
      required: ['dir'],
    },
    handler: async ({ dir, recursive = true, filter = '', limit = 200 }) => {
      const out = [];
      const walk = async (d, depth) => {
        if (out.length >= limit || depth > 8) return;
        let entries;
        try {
          entries = await fs.readdir(d, { withFileTypes: true });
        } catch {
          return;
        }
        for (const ent of entries) {
          if (out.length >= limit) return;
          const full = path.join(d, ent.name);
          if (ent.isDirectory()) {
            if (recursive && !ent.name.startsWith('.')) await walk(full, depth + 1);
            continue;
          }
          if (!/\.uasset$/i.test(ent.name)) continue;
          if (filter && !ent.name.toLowerCase().includes(filter.toLowerCase())) continue;
          try {
            const pkg = await Package.fromFile(full);
            const classes = new Set();
            pkg.exports.forEach((e) => classes.add(pkg.exportList({ limit: 1 }).items[0]?.className || ''));
            out.push({
              path: full,
              engine: pkg.header.fileVersionUE4,
              split: pkg.isSplit,
              names: pkg.header.nameCount,
              exports: pkg.header.exportCount,
              size: pkg.uasset.length + (pkg.uexp ? pkg.uexp.length : 0),
              names_head: pkg.names.slice(0, 4),
            });
          } catch (e) {
            out.push({ path: full, error: String(e.message || e) });
          }
        }
      };
      await walk(dir, 0);
      return { scanned: out.length, limit, items: out };
    },
  },
  {
    name: 'uasset_query',
    description:
      '按条件在所有导出里筛属性，一次返回匹配项的路径/类型/当前值（只读）。' +
      '用于「找出所有名字含 Recoil 的 float」这类探索，避免逐个 export 翻。',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        namePattern: { type: 'string', description: '属性名匹配，支持正则（默认子串、忽略大小写）' },
        type: { type: 'string', description: '限定属性类型，如 FloatProperty' },
        valuePattern: { type: 'string', description: '对当前值的字符串表示做正则匹配' },
        exportFilter: { type: 'string', description: '只在这些导出里找（导出名子串）' },
        limit: { type: 'number', description: '最多返回条数，默认 100' },
        withPaths: { type: 'boolean', description: '返回可读的完整路径，默认 true' },
      },
      required: ['session'],
    },
    examples: [{ session: 's1', namePattern: 'Recoil', type: 'FloatProperty', limit: 20 }],
    handler: async ({ session, namePattern, type, valuePattern, exportFilter, limit = 100 }) => {
      const { pkg } = getSession(session);
      const nameRe = namePattern ? new RegExp(namePattern, 'i') : null;
      const valRe = valuePattern ? new RegExp(valuePattern, 'i') : null;
      const expRe = exportFilter ? new RegExp(exportFilter, 'i') : null;
      const hits = [];
      for (let i = 0; i < pkg.exports.length; i++) {
        const exp = pkg.exports[i];
        if (expRe && !expRe.test(exp.objectName)) continue;
        let props;
        try { props = pkg.parseExport(i); } catch { continue; }
        if (!props) continue;
        const walk = (list, prefix) => {
          for (const p of list) {
            if (hits.length >= limit) return;
            if (!p || typeof p !== 'object') continue;
            const here = `${prefix}.${p.name}${p.arrayIndex ? `[${p.arrayIndex}]` : ''}`;
            if ((!nameRe || nameRe.test(p.name)) && (!type || p.type === type)) {
              const shown = previewValue(p.value);
              if (!valRe || valRe.test(shown)) {
                hits.push({ exportIndex: i, exportName: exp.objectName, path: here, type: p.type, structName: p.structName, size: p.size, value: shown });
              }
            }
            if (Array.isArray(p.value)) {
              for (let k = 0; k < p.value.length && hits.length < limit; k++) {
                const el = p.value[k];
                if (Array.isArray(el)) walk(el, `${here}[${k}]`);
              }
            }
          }
        };
        walk(props, exp.objectName);
      }
      return { matched: hits.length, truncated: hits.length >= limit, items: hits };
    },
  },
  {
    name: 'uasset_set_by_query',
    description:
      '批量改值：先按 uasset_query 的条件筛出属性，再统一写入同一个新值（或按缩放系数改数值）。' +
      '一次调用即可完成「把所有后坐力字段乘以 0.5」这类操作，返回每条 before/after。',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        namePattern: { type: 'string' },
        type: { type: 'string' },
        exportFilter: { type: 'string' },
        value: { description: '写入的新值（number/string/bool）' },
        scale: { type: 'number', description: '数值型属性乘以该系数（与 value 二选一）' },
        offset: { type: 'number', description: '数值型属性加上该偏移' },
        limit: { type: 'number', description: '最多改多少条，默认 50（防误伤）' },
        dryRun: { type: 'boolean', description: '只报告将要做的改动，不实际写入' },
      },
      required: ['session'],
    },
    examples: [
      { session: 's1', namePattern: 'Recoil', type: 'FloatProperty', scale: 0.5, dryRun: true },
    ],
    handler: async ({ session, namePattern, type, exportFilter, value, scale, offset, limit = 50, dryRun = false }) => {
      const { pkg } = getSession(session);
      const nameRe = namePattern ? new RegExp(namePattern, 'i') : null;
      const expRe = exportFilter ? new RegExp(exportFilter, 'i') : null;
      if (value === undefined && scale === undefined && offset === undefined) {
        throw new Error('必须给出 value / scale / offset 之一');
      }
      const targets = [];
      for (let i = 0; i < pkg.exports.length && targets.length < limit; i++) {
        const exp = pkg.exports[i];
        if (expRe && !expRe.test(exp.objectName)) continue;
        let props;
        try { props = pkg.parseExport(i); } catch { continue; }
        if (!props) continue;
        const walk = (list, prefix) => {
          for (const p of list) {
            if (targets.length >= limit) return;
            if (!p || typeof p !== 'object') continue;
            const here = `${prefix}.${p.name}${p.arrayIndex ? `[${p.arrayIndex}]` : ''}`;
            if ((!nameRe || nameRe.test(p.name)) && (!type || p.type === type) && p.type !== 'StructProperty' && p.type !== 'ArrayProperty') {
              targets.push({ path: here, prop: p });
            }
            if (Array.isArray(p.value)) {
              for (let k = 0; k < p.value.length && targets.length < limit; k++) {
                const el = p.value[k];
                if (Array.isArray(el)) walk(el, `${here}[${k}]`);
              }
            }
          }
        };
        walk(props, exp.objectName);
      }
      if (!targets.length) throw new Error('没有匹配到任何属性，先用 uasset_query 确认条件');
      const results = [];
      for (const t of targets) {
        const before = t.prop.value;
        let next;
        if (value !== undefined) next = value;
        else if (typeof before === 'number') next = (scale !== undefined ? before * scale : before) + (offset || 0);
        else next = before;
        if (dryRun) {
          results.push({ path: t.path, type: t.prop.type, before: previewValue(before), after: previewValue(next), applied: false });
          continue;
        }
        try {
          const r = pkg.set(t.path, next);
          results.push({ path: t.path, type: r.type, before: previewValue(r.before), after: previewValue(r.after), mode: r.mode, applied: true });
        } catch (e) {
          results.push({ path: t.path, error: String(e.message || e), applied: false });
        }
      }
      return {
        matched: targets.length,
        applied: results.filter((r) => r.applied).length,
        dryRun,
        results,
        next: dryRun ? '确认无误后去掉 dryRun 再调一次' : 'uasset_verify 然后 uasset_save',
      };
    },
  },
  {
    name: 'uasset_batch',
    description:
      '在一个会话里连续执行多条 set/delete/add 操作，全部成功才提交（失败即整批回滚）。' +
      '比逐条 uasset_set 更省 token，也避免改一半留下脏状态。',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        ops: {
          type: 'array',
          description: '操作列表：{op:"set", path, value} / {op:"delete", path} / {op:"add", export, def}',
          items: { type: 'object' },
        },
        stopOnError: { type: 'boolean', description: '默认 true；false 则跳过失败项继续' },
      },
      required: ['session', 'ops'],
    },
    examples: [
      {
        session: 's1',
        ops: [
          { op: 'set', path: 'Default__BP_Rifle_AUG_C.bEnableInspect', value: false },
          { op: 'set', path: 'Default__BP_Rifle_AUG_C.WeaponAttrModifyConfigList[0].WeaponAttrModifiers[0].ModifyValue', value: 0.5 },
        ],
      },
    ],
    handler: async ({ session, ops, stopOnError = true }) => {
      const s = getSession(session);
      const { pkg } = s;
      const snapshot = pkg.snapshotState();
      const done = [];
      try {
        for (const op of ops) {
          const kind = op.op || 'set';
          if (kind === 'set') {
            done.push({ op: 'set', ...pkg.set(op.path, op.value) });
          } else if (kind === 'delete') {
            done.push({ op: 'delete', ...pkg.removeProperty(op.path) });
          } else if (kind === 'add') {
            done.push({ op: 'add', ...pkg.addProperty(op.export, op.def) });
          } else {
            throw new Error(`未知 op: ${kind}（支持 set/delete/add）`);
          }
        }
      } catch (e) {
        if (stopOnError) {
          pkg.restoreState(snapshot);
          return {
            committed: false,
            rolledBack: true,
            completedBeforeError: done.length,
            error: String(e.message || e),
            hint: '整批已回滚到执行前状态。修正失败的那条后重试，或把 stopOnError 设为 false 只跳过它。',
          };
        }
        done.push({ op: 'error', error: String(e.message || e) });
      }
      return { committed: true, count: done.length, results: done, next: 'uasset_verify 然后 uasset_save' };
    },
  },
  {
    name: 'uasset_blueprint',
    description:
      '把蓝图资产读成结构化视图：类名/父类、函数列表、组件树、变量与默认值、事件/函数引用。' +
      '比直接 dump 属性树更适合理解「这个蓝图是什么、有哪些可改的地方」。',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        includeDefaults: { type: 'boolean', description: '是否带出 CDO 的可编辑默认值，默认 true' },
        limit: { type: 'number', description: '每类最多列多少项，默认 60' },
      },
      required: ['session'],
    },
    examples: [{ session: 's1', includeDefaults: true }],
    handler: async ({ session, includeDefaults = true, limit = 60 }) => {
      const { pkg } = getSession(session);
      const classes = [];
      const functions = [];
      const components = [];
      const defaults = [];
      for (let i = 0; i < pkg.exports.length; i++) {
        const exp = pkg.exports[i];
        const cls = pkg.exportList({ offset: i, limit: 1 }).items[0]?.className || '';
        if (/Class$/.test(cls) || /BlueprintGeneratedClass/.test(cls)) {
          classes.push({ index: i, name: exp.objectName, className: cls, size: exp.serialSize });
        }
        if (cls === 'Function' || /Function$/.test(exp.objectName)) {
          functions.push({ index: i, name: exp.objectName, size: exp.serialSize });
        }
        if (/Component/.test(exp.objectName) && exp.serialSize > 0 && exp.serialSize < 4096) {
          components.push({ index: i, name: exp.objectName, size: exp.serialSize });
        }
        if (exp.objectName.startsWith('Default__') && includeDefaults) {
          let props = [];
          try { props = pkg.parseExport(i) || []; } catch { props = []; }
          defaults.push({
            index: i,
            name: exp.objectName,
            propertyCount: props.length,
            properties: props.slice(0, limit).map((p) => ({
              name: p.name,
              type: p.type,
              structName: p.structName,
              innerType: p.innerType,
              value: previewValue(p.value),
              editable: p.type !== 'StructProperty' && p.type !== 'ArrayProperty',
            })),
          });
        }
      }
      return {
        asset: pkg.name,
        isBlueprint: classes.length > 0,
        classes: classes.slice(0, limit),
        functions: functions.slice(0, limit),
        components: components.slice(0, limit),
        defaults,
        importsOfInterest: pkg.imports.slice(0, limit).map((x) => x.objectName),
        next: defaults.length ? 'uasset_set path=Default__Xxx.Prop value=... 修改默认值' : 'uasset_tree 看具体导出',
      };
    },
  },
  {
    name: 'uasset_snapshot',
    description:
      '给当前会话打快照（内存内），之后可用 uasset_restore 一键回到这个状态。' +
      '适合「改一批→验证→不行就退回」的迭代，比重新打开文件快。',
    inputSchema: {
      type: 'object',
      properties: { session: { type: 'string' }, label: { type: 'string', description: '快照备注' } },
      required: ['session'],
    },
    handler: async ({ session, label = '' }) => {
      const s = getSession(session);
      s.snapshots = s.snapshots || new Map();
      const id = `snap${s.snapshots.size + 1}`;
      s.snapshots.set(id, { state: s.pkg.snapshotState(), label, at: Date.now() });
      return { snapshot: id, label, available: [...s.snapshots.keys()] };
    },
  },
  {
    name: 'uasset_restore',
    description: '把会话恢复到某个快照（默认最近一个）。',
    inputSchema: {
      type: 'object',
      properties: { session: { type: 'string' }, snapshot: { type: 'string' } },
      required: ['session'],
    },
    handler: async ({ session, snapshot }) => {
      const s = getSession(session);
      const snaps = s.snapshots || new Map();
      if (!snaps.size) throw new Error('没有快照，先调用 uasset_snapshot');
      const id = snapshot || [...snaps.keys()].pop();
      const snap = snaps.get(id);
      if (!snap) throw new Error(`快照不存在: ${id}（可用: ${[...snaps.keys()].join(', ')}）`);
      s.pkg.restoreState(snap.state);
      return { restored: id, label: snap.label, ...s.pkg.info() };
    },
  },
  {
    name: 'uasset_validate',
    description:
      '深度体检：逐导出解析一遍，报告哪些能完整解析、哪些退化成原始块、哪些偏移越界。' +
      'AI 在动手改之前应该先跑这个，知道哪些区域是「盲区」。',
    inputSchema: {
      type: 'object',
      properties: { session: { type: 'string' }, limit: { type: 'number', description: '最多检查多少导出，默认全部' } },
      required: ['session'],
    },
    handler: async ({ session, limit }) => {
      const { pkg } = getSession(session);
      const n = Math.min(pkg.exports.length, limit || pkg.exports.length);
      const items = [];
      let ok = 0, degraded = 0, failed = 0;
      for (let i = 0; i < n; i++) {
        const exp = pkg.exports[i];
        if (!exp.serialSize) { items.push({ index: i, name: exp.objectName, status: 'empty' }); continue; }
        try {
          const props = pkg.parseExport(i);
          const raw = countRawBlocks(props);
          if (raw > 0) {
            degraded++;
            items.push({ index: i, name: exp.objectName, status: 'degraded', rawBlocks: raw, properties: props.length });
          } else {
            ok++;
            items.push({ index: i, name: exp.objectName, status: 'ok', properties: props.length });
          }
        } catch (e) {
          failed++;
          items.push({ index: i, name: exp.objectName, status: 'failed', error: String(e.message || e) });
        }
      }
      return {
        total: n,
        ok,
        degraded,
        failed,
        items: items.filter((x) => x.status !== 'ok').slice(0, 60),
        note: degraded ? 'degraded 的导出里存在未解析的原始块，改这些导出时优先用定长字段' : '全部导出均可完整解析',
      };
    },
  },
  {
    name: 'pak_open',
    description:
      '打开 .pak 归档（UE4/UE5）。返回条目数/压缩/加密情况。' +
      '加密 pak 需传 aesKey（64 位 hex）。之后可 pak_list / pak_read / pak_extract。',
    inputSchema: {
      type: 'object',
      properties: {
        pakPath: { type: 'string', description: 'pak 文件绝对路径' },
        aesKey: { type: 'string', description: '32 字节 AES key 的 hex（仅加密 pak 需要）' },
      },
      required: ['pakPath'],
    },
    examples: [{ pakPath: '/sdcard/Download/pakchunk0-Android_ASTC.pak' }],
    handler: async ({ pakPath, aesKey }) => {
      const pak = await Pak.fromFile(pakPath, { key: aesKey });
      const id = newPakSession(pak, pakPath);
      return { session: id, ...pak.info(), next: 'pak_list 看条目，pak_read 取单个文件' };
    },
  },
  {
    name: 'pak_list',
    description: '列出 pak 里的条目（可按正则过滤、分页）。',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        filter: { type: 'string', description: '正则或子串，例如 \\.uasset$' },
        offset: { type: 'number' },
        limit: { type: 'number', description: '默认 200' },
      },
      required: ['session'],
    },
    handler: async ({ session, filter, offset = 0, limit = 200 }) => {
      const { pak } = getPakSession(session);
      return pak.list({ filter, offset, limit });
    },
  },
  {
    name: 'pak_read',
    description: '从 pak 读出一个文件（按名字或索引）。返回 base64 与字节数，二进制安全。',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        name: { type: 'string', description: '完整条目名，或唯一子串' },
        index: { type: 'number', description: '条目索引（与 name 二选一）' },
        asText: { type: 'boolean', description: '若内容是文本则直接返回文本，默认 false' },
      },
      required: ['session'],
    },
    handler: async ({ session, name, index, asText = false }) => {
      const { pak } = getPakSession(session);
      const r = pak.read(index !== undefined ? index : name);
      const out = { name: r.name, bytes: r.data.length };
      if (asText) out.text = r.data.toString('utf8').slice(0, 200000);
      else out.base64 = r.data.toString('base64');
      return out;
    },
  },
  {
    name: 'pak_extract',
    description:
      '把 pak 里的文件批量提取到目录（保持条目内的相对路径）。' +
      '可按 filter 只取资产，limit 控制数量。返回成功/失败清单。',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        outDir: { type: 'string', description: '输出目录（绝对路径）' },
        filter: { type: 'string', description: '正则，例如 \\.(uasset|uexp)$' },
        limit: { type: 'number', description: '最多提取多少个，默认 0=全部' },
      },
      required: ['session', 'outDir'],
    },
    examples: [{ session: 'p1', outDir: '/sdcard/Download/unpacked', filter: '\\.uasset$', limit: 50 }],
    handler: async ({ session, outDir, filter, limit = 0 }) => {
      const { pak } = getPakSession(session);
      const fs = await import('node:fs/promises');
      const nodePath = await import('node:path');
      const re = filter ? new RegExp(filter, 'i') : null;
      const written = [];
      const failed = [];
      for (let i = 0; i < pak.entries.length; i++) {
        if (limit && written.length >= limit) break;
        const e = pak.entries[i];
        if (re && !re.test(e.name)) continue;
        try {
          const { data } = pak.read(i);
          const rel = e.name.replace(/^(?:\.\.\/)+/g, '').replace(/^\/+/, '');
          const target = nodePath.join(outDir, rel);
          await fs.mkdir(nodePath.dirname(target), { recursive: true });
          await fs.writeFile(target, data);
          written.push({ name: e.name, path: target, bytes: data.length });
        } catch (err) {
          failed.push({ name: e.name, error: String(err.message || err) });
        }
      }
      return { extracted: written.length, failed: failed.length, outDir, items: written.slice(0, 50), errors: failed.slice(0, 20) };
    },
  },
  {
    name: 'pak_replace',
    description:
      '替换/新增 pak 内的文件并写出新 pak（不改原包）。' +
      '常用流程：pak_extract → uasset_open 改资产 → uasset_save 到临时目录 → 本工具把改后的文件写回包。',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        replacements: {
          type: 'array',
          description: '[{name:"条目名", filePath:"本地文件路径"}] 或 [{name, base64}]',
          items: { type: 'object' },
        },
        outPath: { type: 'string', description: '输出 pak 路径' },
        compression: { type: 'number', description: '0=不压缩（默认，最稳），1=zlib' },
      },
      required: ['session', 'replacements', 'outPath'],
    },
    examples: [
      { session: 'p1', replacements: [{ name: '../../../Game/Content/BP_Rifle_AUG.uasset', filePath: '/tmp/out.uasset' }], outPath: '/tmp/pakchunk0-mod.pak' },
    ],
    handler: async ({ session, replacements, outPath, compression = 0 }) => {
      const { pak } = getPakSession(session);
      const fs = await import('node:fs/promises');
      const items = [];
      for (const r of replacements) {
        if (!r.name) throw new Error('replacement 缺少 name');
        let data;
        if (r.base64) data = Buffer.from(r.base64, 'base64');
        else if (r.filePath) data = await fs.readFile(r.filePath);
        else throw new Error(`replacement ${r.name} 缺少 filePath 或 base64`);
        items.push({ name: r.name, data });
      }
      const out = pak.rebuildWith(items, { compression });
      await fs.writeFile(outPath, out);
      const verify = Pak.fromBuffer(out);
      const problems = [];
      for (const it of items) {
        try {
          const back = verify.read(it.name).data;
          if (Buffer.compare(back, it.data) !== 0) problems.push(`${it.name}: 回读内容不一致`);
        } catch (e) {
          problems.push(`${it.name}: 回读失败 ${e.message}`);
        }
      }
      return {
        outPath,
        bytes: out.length,
        replaced: items.length,
        entries: verify.entries.length,
        verification: { ok: problems.length === 0, problems },
      };
    },
  },
  {
    name: 'uasset_help',
    description: '返回本服务器的使用说明：路径语法、推荐工作流、类型对照、常见坑。AI 不确定时先调这个。',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => HELP,
  },
];

const HELP = {
  version: '2.0.0',
  workflow: [
    '1) uasset_open uassetPath=/path/x.uasset（.uexp 自动发现）',
    '2) uasset_list_exports 找目标对象（CDO 常以 Default__ 开头）',
    '3) uasset_search query=Recoil 之类，先看名字表里有什么',
    '4) uasset_tree export=Default__XXX_C depth=3 看结构',
    '5) uasset_get path=Default__XXX_C.Prop[0].Sub 确认当前值',
    '6) uasset_set path=... value=...（定长值走 patch，最安全）',
    '7) uasset_verify 预演 + 自检',
    '8) uasset_save（默认写 .mod.uasset，不覆盖源文件）',
  ],
  pathSyntax: {
    exportSelector: '导出名（完整名优先、忽略大小写）或 #索引',
    property: '.属性名',
    array: '[3]',
    example: 'Default__BP_Rifle_AUG_C.WeaponAttrModifyConfigList[0].WeaponAttrModifiers[0].ModifyValue',
  },
  valueTypes: {
    BoolProperty: 'true/false',
    IntProperty_int64_uint32: 'number',
    FloatProperty_DoubleProperty: 'number（写回 float32 精度）',
    StrProperty_NameProperty: 'string',
    EnumProperty_ByteProperty: 'string（枚举名）或 number',
    ObjectProperty_ClassProperty: 'string（对象名，会登记进名称表）',
    SoftObjectProperty: '{assetPathName, subPathString} 或 string',
    TextProperty: '{flags,historyType,namespace,key,sourceString} 或 string（只改 sourceString）',
    StructProperty: '属性列表或 {子属性: 值} 映射',
  },
  pakWorkflow: [
    '1) pak_open pakPath=xxx.pak（加密包加 aesKey）',
    '2) pak_list filter="\\.uasset$" limit=50 看有哪些资产',
    '3) pak_extract outDir=/tmp/x filter="BP_Rifle" 只解需要的',
    '4) uasset_open /tmp/x/.../BP_Rifle_AUG.uasset → 改 → uasset_save',
    '5) pak_replace replacements=[{name:"../../../Game/.../BP_Rifle_AUG.uasset", filePath:"<改后的文件>"}] outPath=新包',
    '注意：替换条目名必须和 pak 里的完全一致（含 ../../../ 前缀）；Oodle 压缩包本工具只能解 zlib。',
  ],
  gotchas: [
    '定长编辑（bool/number/enum）走字节补丁，不改变任何偏移，最安全。',
    '变长编辑（字符串/数组增删）会重建导出；若导出里有「未解析的原始块」会被拒绝，需要 force=true。',
    '新增名称会自动扩容名称表，并整体后移头部之后的绝对偏移（已自检）。',
    '.uasset 与 .uexp 必须成对使用；保存默认输出 .mod 后缀。',
    'DataTable 资产的行数据以 __row 属性呈现，可像普通属性一样读写。',
    '不确定从哪下手时：uasset_validate 看哪些导出可安全改，uasset_query 按名字/类型筛属性，uasset_blueprint 看蓝图全貌。',
    '批量改值用 uasset_set_by_query（支持 dryRun 预演），多条编辑用 uasset_batch（失败整批回滚）。',
    '改之前先 uasset_snapshot，不满意 uasset_restore 一秒退回。',
  ],
};

export const toolMap = new Map(tools.map((t) => [t.name, t]));

export async function callTool(name, args) {
  const t = toolMap.get(name);
  if (!t) throw new Error(`未知工具: ${name}（可用: ${[...toolMap.keys()].join(', ')}）`);
  const missing = (t.inputSchema.required || []).filter((k) => args?.[k] === undefined);
  if (missing.length) throw new Error(`缺少参数: ${missing.join(', ')}`);
  return t.handler(args || {});
}
