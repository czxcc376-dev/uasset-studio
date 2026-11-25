/* eslint-disable */
/**
 * mcp-app.js — App 内 MCP：让 AI 直接操作「手机上正在编辑的资产」。
 *
 * 为什么在 WebView 里实现协议、由 Java 只做 HTTP 转发：
 *   解析/回写逻辑本来就在这个 JS 引擎里，重写一遍 Java 版必然与 CLI 行为分叉。
 *   所以 Java 只负责收发字节，JSON-RPC 与 26 个工具全部在这里，和 Node 侧共用 Package。
 *
 * 与 Node 版 MCP 的差别：文件访问走 SAF（content:// URI），没有目录概念，
 * 所以 scan_dir / pak 这些基于路径的工具不在这里，改用 app_* 系列。
 */
(function () {
    'use strict';

    var assets = new Map();     // id -> { id, name, pkg, uasset, uexp, openedAt }
    var seq = 0;
    var MAX_ASSETS = 8;

    function nextId() { return 'a' + (++seq); }

    function getAsset(id) {
        var a = assets.get(id);
        if (!a) {
            var ids = Array.from(assets.keys());
            throw new Error('资产不存在: ' + id +
                (ids.length ? '（已载入: ' + ids.join(', ') + '）' : '（还没有载入任何资产，先用 app_open_file 或 uasset_open_uri）'));
        }
        return a;
    }

    /* ------------------------------------------------------------ 小工具 */

    function preview(v, depth) {
        depth = depth || 0;
        if (v === null || v === undefined) return null;
        if (v instanceof Uint8Array) return '<' + v.length + ' bytes>';
        if (typeof v !== 'object') return v;
        if (Array.isArray(v)) {
            if (!v.length) return [];
            if (depth >= 2) return '[' + v.length + ' items]';
            return v.slice(0, 20).map(function (x) { return preview(x, depth + 1); });
        }
        if (v.assetPathName !== undefined) return { assetPathName: v.assetPathName, subPathString: v.subPathString };
        var out = {};
        Object.keys(v).slice(0, 20).forEach(function (k) {
            if (k.indexOf('__') === 0 || k === '_rawBytes') return;
            out[k] = preview(v[k], depth + 1);
        });
        return out;
    }

    function countRaw(props) {
        var n = 0;
        (function walk(list) {
            if (!Array.isArray(list)) return;
            if (list._rawBytes && list.length === 0) n++;
            list.forEach(function (p) {
                if (!p || typeof p !== 'object') return;
                if (p.value instanceof Uint8Array && (p.type === 'StructProperty' || p.type === 'ArrayProperty')) n++;
                else if (Array.isArray(p.value) && p.value._rawBytes && p.value.length === 0) n++;
                if (Array.isArray(p.value)) p.value.forEach(function (el) { if (Array.isArray(el)) walk(el); });
            });
        })(props);
        return n;
    }

    function b64ToBytes(b64) {
        var bin = atob(b64);
        var out = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    function bytesToB64(bytes) {
        var CH = 0x8000, out = '';
        for (var i = 0; i < bytes.length; i += CH) {
            out += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
        }
        return btoa(out);
    }

    function bridge() {
        if (typeof AndroidFS === 'undefined' || !AndroidFS) {
            throw new Error('这个环境没有 AndroidFS 桥（只能在 App 内使用文件相关工具）');
        }
        return AndroidFS;
    }

    function readJson(s) {
        try { return JSON.parse(s); } catch (e) { return null; }
    }

    /* ------------------------------------------------------------ 资产登记 */

    function register(name, uasset, uexp) {
        // 同一份资产重复登记时复用，避免 AI 每轮都开新的
        for (var entry of assets) {
            var a = entry[1];
            if (a.name === name && a.uasset.length === uasset.length) return a.id;
        }
        if (assets.size >= MAX_ASSETS) assets.delete(assets.keys().next().value);
        var id = nextId();
        var pkg = new Package({ uasset: uasset, uexp: uexp || null, name: name || 'asset' });
        assets.set(id, { id: id, name: name || 'asset', pkg: pkg, uasset: uasset, uexp: uexp || null, openedAt: Date.now() });
        return id;
    }

    function openFromUri(uri, uexpUri) {
        var fs = bridge();
        var r1 = readJson(fs.readBase64(uri));
        if (!r1 || !r1.ok) throw new Error('读取失败: ' + (r1 && r1.error));
        var uasset = b64ToBytes(r1.data);
        var uexp = null;
        if (uexpUri) {
            var r2 = readJson(fs.readBase64(uexpUri));
            if (!r2 || !r2.ok) throw new Error('读取 .uexp 失败: ' + (r2 && r2.error));
            uexp = b64ToBytes(r2.data);
        }
        var name = fs.displayName(uri);
        return register(name, uasset, uexp);
    }

    /* ------------------------------------------------------------ 工具实现 */

    var T = {};

    T.app_status = {
        desc: 'App 内 MCP 的运行状态与已载入资产。第一次连上先调这个。',
        schema: { type: 'object', properties: {} },
        run: function () {
            return {
                running: true,
                version: '2.0.0',
                assets: Array.from(assets.values()).map(function (a) {
                    return { session: a.id, name: a.name, exports: a.pkg.exports.length, names: a.pkg.names.length, split: a.pkg.isSplit };
                }),
                note: 'session 就是这里返回的 id；只能操作已载入的资产',
            };
        },
    };

    T.app_list_files = {
        desc: '列出用户已授权给 AI 读取的文件（SAF 授权，重启后仍有效）。用返回的 session/uri 去 app_open_file。',
        schema: { type: 'object', properties: {} },
        run: function () {
            var fs = bridge();
            var list = readJson(fs.listAiFiles());
            return list || { files: [], note: '读取授权列表失败' };
        },
    };

    T.app_open_file = {
        desc: '按 app_list_files 返回的 uri 载入资产（可同时给 uexpUri 配对）。返回 session。',
        schema: {
            type: 'object',
            properties: {
                uri: { type: 'string', description: '.uasset 的 content:// URI（或 app_list_files 里的 id）' },
                uexpUri: { type: 'string', description: '可选，配套 .uexp 的 URI' },
            },
            required: ['uri'],
        },
        run: function (args) {
            var fs = bridge();
            var uri = args.uri;
            // 允许直接传 app_list_files 里的 id
            if (!/^content:|^file:/.test(uri)) {
                var list = readJson(fs.listAiFiles()) || {};
                var hit = (list.files || []).filter(function (f) { return f.id === uri || f.name === uri; })[0];
                if (!hit) throw new Error('找不到该 id/名字对应的授权文件: ' + uri + '（先调 app_list_files 看有哪些）');
                uri = hit.uri;
                if (!args.uexpUri) {
                    var pair = (list.files || []).filter(function (f) {
                        return f.name === hit.name.replace(/\.uasset$/i, '.uexp');
                    })[0];
                    if (pair) args.uexpUri = pair.uri;
                }
            }
            var id = openFromUri(uri, args.uexpUri);
            var a = assets.get(id);
            return { session: id, name: a.name, ...a.pkg.info() };
        },
    };

    T.app_close = {
        desc: '关闭会话，释放内存。',
        schema: { type: 'object', properties: { session: { type: 'string' } }, required: ['session'] },
        run: function (args) {
            if (!assets.has(args.session)) throw new Error('会话不存在: ' + args.session);
            assets.delete(args.session);
            return { closed: args.session, remaining: Array.from(assets.keys()) };
        },
    };

    T.uasset_info = {
        desc: '资产概况：引擎版本、表大小、导出/导入数、是否有未保存改动。',
        schema: { type: 'object', properties: { session: { type: 'string' } }, required: ['session'] },
        run: function (a) { return getAsset(a.session).pkg.info(); },
    };

    T.uasset_list_exports = {
        desc: '列导出（对象）。可按名字/类名过滤、分页。',
        schema: {
            type: 'object',
            properties: { session: { type: 'string' }, filter: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } },
            required: ['session'],
        },
        run: function (a) {
            return getAsset(a.session).pkg.exportList({ filter: a.filter || '', offset: a.offset || 0, limit: a.limit || 100 });
        },
    };

    T.uasset_list_names = {
        desc: '列名称表条目（可按子串过滤、分页）。新增属性或改名时先查重。',
        schema: {
            type: 'object',
            properties: { session: { type: 'string' }, query: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } },
            required: ['session'],
        },
        run: function (a) {
            return getAsset(a.session).pkg.nameList({ query: a.query || '', offset: a.offset || 0, limit: a.limit || 200 });
        },
    };

    T.uasset_tree = {
        desc: '看导出或属性的结构树（受 depth / maxItems 限制，避免一次塞太多）。',
        schema: {
            type: 'object',
            properties: { session: { type: 'string' }, export: { description: '导出名或 #索引' }, depth: { type: 'number' }, maxItems: { type: 'number' } },
            required: ['session'],
        },
        run: function (a) {
            return getAsset(a.session).pkg.tree({ exportRef: a.export, depth: a.depth === undefined ? 3 : a.depth, maxItems: a.maxItems || 40 });
        },
    };

    T.uasset_get = {
        desc: '读一个路径的值，返回类型/大小/当前值。路径形如 Default__Xxx_C.Prop[0].Sub',
        schema: { type: 'object', properties: { session: { type: 'string' }, path: { type: 'string' } }, required: ['session', 'path'] },
        run: function (a) { return getAsset(a.session).pkg.get(a.path); },
    };

    T.uasset_set = {
        desc: '改一个路径的值。内部自动判定「定长字节补丁」还是「重建导出」，返回值里的 mode 告诉你走了哪条。',
        schema: {
            type: 'object',
            properties: { session: { type: 'string' }, path: { type: 'string' }, value: {} },
            required: ['session', 'path', 'value'],
        },
        run: function (a) { return getAsset(a.session).pkg.set(a.path, a.value); },
    };

    T.uasset_set_many = {
        desc: '一次改多个路径（同 uasset_set 的批量版）。',
        schema: {
            type: 'object',
            properties: { session: { type: 'string' }, edits: { type: 'array', items: { type: 'object' } } },
            required: ['session', 'edits'],
        },
        run: function (a) {
            var pkg = getAsset(a.session).pkg;
            return { results: (a.edits || []).map(function (e) {
                try { return Object.assign({ path: e.path }, pkg.set(e.path, e.value)); }
                catch (err) { return { path: e.path, error: String(err.message || err) }; }
            }) };
        },
    };

    T.uasset_query = {
        desc: '按名字/类型/值正则在所有导出里筛属性，返回可读路径与当前值（只读）。改之前先用它定位。',
        schema: {
            type: 'object',
            properties: {
                session: { type: 'string' }, namePattern: { type: 'string' }, type: { type: 'string' },
                valuePattern: { type: 'string' }, exportFilter: { type: 'string' }, limit: { type: 'number' },
            },
            required: ['session'],
        },
        run: function (a) {
            var pkg = getAsset(a.session).pkg;
            var nameRe = a.namePattern ? new RegExp(a.namePattern, 'i') : null;
            var valRe = a.valuePattern ? new RegExp(a.valuePattern, 'i') : null;
            var expRe = a.exportFilter ? new RegExp(a.exportFilter, 'i') : null;
            var limit = a.limit || 100;
            var hits = [];
            for (var i = 0; i < pkg.exports.length && hits.length < limit; i++) {
                var exp = pkg.exports[i];
                if (expRe && !expRe.test(exp.objectName)) continue;
                var props;
                try { props = pkg.parseExport(i); } catch (e) { continue; }
                if (!props) continue;
                (function walk(list, prefix) {
                    list.forEach(function (p) {
                        if (hits.length >= limit || !p || typeof p !== 'object') return;
                        var here = prefix + '.' + p.name + (p.arrayIndex ? '[' + p.arrayIndex + ']' : '');
                        if ((!nameRe || nameRe.test(p.name)) && (!a.type || p.type === a.type)) {
                            var shown = preview(p.value);
                            if (!valRe || valRe.test(JSON.stringify(shown))) {
                                hits.push({ exportIndex: i, exportName: exp.objectName, path: here, type: p.type, structName: p.structName, size: p.size, value: shown });
                            }
                        }
                        if (Array.isArray(p.value)) {
                            p.value.forEach(function (el, k) { if (Array.isArray(el)) walk(el, here + '[' + k + ']'); });
                        }
                    });
                })(props, exp.objectName);
            }
            return { matched: hits.length, truncated: hits.length >= limit, items: hits };
        },
    };

    T.uasset_set_by_query = {
        desc: '按条件批量改值（支持 value / scale / offset）。dryRun=true 只报告不落地。',
        schema: {
            type: 'object',
            properties: {
                session: { type: 'string' }, namePattern: { type: 'string' }, type: { type: 'string' },
                exportFilter: { type: 'string' }, value: {}, scale: { type: 'number' }, offset: { type: 'number' },
                limit: { type: 'number' }, dryRun: { type: 'boolean' },
            },
            required: ['session'],
        },
        run: function (a) {
            if (a.value === undefined && a.scale === undefined && a.offset === undefined) {
                throw new Error('必须给出 value / scale / offset 之一');
            }
            var pkg = getAsset(a.session).pkg;
            var q = T.uasset_query.run({
                session: a.session, namePattern: a.namePattern, type: a.type,
                exportFilter: a.exportFilter, limit: a.limit || 50,
            });
            var out = q.items.filter(function (x) {
                return x.type !== 'StructProperty' && x.type !== 'ArrayProperty';
            }).map(function (x) {
                var before = x.value;
                var next = a.value !== undefined ? a.value
                    : (typeof before === 'number' ? before * (a.scale === undefined ? 1 : a.scale) + (a.offset || 0) : before);
                if (a.dryRun) return { path: x.path, type: x.type, before: before, after: next, applied: false };
                try {
                    var r = pkg.set(x.path, next);
                    return { path: x.path, type: r.type, before: preview(r.before), after: preview(r.after), mode: r.mode, applied: true };
                } catch (e) {
                    return { path: x.path, error: String(e.message || e), applied: false };
                }
            });
            return {
                matched: out.length,
                applied: out.filter(function (r) { return r.applied; }).length,
                dryRun: !!a.dryRun,
                results: out,
            };
        },
    };

    T.uasset_batch = {
        desc: '一次提交多条 set / delete / add，任何一条失败整批回滚。',
        schema: {
            type: 'object',
            properties: { session: { type: 'string' }, ops: { type: 'array', items: { type: 'object' } }, stopOnError: { type: 'boolean' } },
            required: ['session', 'ops'],
        },
        run: function (a) {
            var pkg = getAsset(a.session).pkg;
            var snap = pkg.snapshotState();
            var done = [];
            var stopOnError = a.stopOnError !== false;
            try {
                (a.ops || []).forEach(function (op) {
                    var kind = op.op || 'set';
                    if (kind === 'set') done.push(Object.assign({ op: kind }, pkg.set(op.path, op.value)));
                    else if (kind === 'delete') done.push(Object.assign({ op: kind }, pkg.removeProperty(op.path)));
                    else if (kind === 'add') done.push(Object.assign({ op: kind }, pkg.addProperty(op.export, op.def)));
                    else throw new Error('未知 op: ' + kind + '（支持 set/delete/add）');
                });
            } catch (e) {
                if (stopOnError) {
                    pkg.restoreState(snap);
                    return { committed: false, rolledBack: true, completedBeforeError: done.length, error: String(e.message || e) };
                }
                done.push({ op: 'error', error: String(e.message || e) });
            }
            return { committed: true, count: done.length, results: done };
        },
    };

    T.uasset_validate = {
        desc: '逐个导出体检：哪些能完整解析、哪些退化成原始字节块、哪些失败。改之前先跑。',
        schema: { type: 'object', properties: { session: { type: 'string' }, limit: { type: 'number' } }, required: ['session'] },
        run: function (a) {
            var pkg = getAsset(a.session).pkg;
            var n = Math.min(pkg.exports.length, a.limit || pkg.exports.length);
            var items = [], ok = 0, degraded = 0, failed = 0;
            for (var i = 0; i < n; i++) {
                var exp = pkg.exports[i];
                if (!exp.serialSize) { items.push({ index: i, name: exp.objectName, status: 'empty' }); continue; }
                try {
                    var props = pkg.parseExport(i);
                    var raw = countRaw(props);
                    if (raw) { degraded++; items.push({ index: i, name: exp.objectName, status: 'degraded', rawBlocks: raw, properties: props.length }); }
                    else { ok++; items.push({ index: i, name: exp.objectName, status: 'ok', properties: props.length }); }
                } catch (e) {
                    failed++;
                    items.push({ index: i, name: exp.objectName, status: 'failed', error: String(e.message || e) });
                }
            }
            return {
                total: n, ok: ok, degraded: degraded, failed: failed,
                items: items.filter(function (x) { return x.status !== 'ok'; }).slice(0, 60),
                note: degraded ? 'degraded 的导出含未解析原始块，优先改定长字段' : '全部导出可完整解析',
            };
        },
    };

    T.uasset_snapshot = {
        desc: '给会话打快照（内存内），不满意可 uasset_restore 退回。',
        schema: { type: 'object', properties: { session: { type: 'string' }, label: { type: 'string' } }, required: ['session'] },
        run: function (a) {
            var asset = getAsset(a.session);
            asset.snaps = asset.snaps || new Map();
            var id = 'snap' + (asset.snaps.size + 1);
            asset.snaps.set(id, { state: asset.pkg.snapshotState(), label: a.label || '' });
            return { snapshot: id, label: a.label || '', available: Array.from(asset.snaps.keys()) };
        },
    };

    T.uasset_restore = {
        desc: '恢复到某个快照（默认最近一个）。',
        schema: { type: 'object', properties: { session: { type: 'string' }, snapshot: { type: 'string' } }, required: ['session'] },
        run: function (a) {
            var asset = getAsset(a.session);
            if (!asset.snaps || !asset.snaps.size) throw new Error('没有快照，先调用 uasset_snapshot');
            var id = a.snapshot || Array.from(asset.snaps.keys()).pop();
            var s = asset.snaps.get(id);
            if (!s) throw new Error('快照不存在: ' + id);
            asset.pkg.restoreState(s.state);
            return { restored: id, label: s.label, ...asset.pkg.info() };
        },
    };

    T.uasset_search = {
        desc: '在名称表与属性值里搜字符串（支持正则）。',
        schema: {
            type: 'object',
            properties: { session: { type: 'string' }, query: { type: 'string' }, regex: { type: 'boolean' }, limit: { type: 'number' } },
            required: ['session', 'query'],
        },
        run: function (a) {
            return getAsset(a.session).pkg.search(a.query, { regex: !!a.regex, limit: a.limit || 100 });
        },
    };

    T.uasset_hexdump = {
        desc: '看某个导出的原始字节十六进制（分页）。',
        schema: {
            type: 'object',
            properties: { session: { type: 'string' }, export: {}, offset: { type: 'number' }, length: { type: 'number' } },
            required: ['session', 'export'],
        },
        run: function (a) {
            return getAsset(a.session).pkg.hexDump(a.export, { offset: a.offset || 0, length: a.length || 256 });
        },
    };

    T.uasset_patch_bytes = {
        desc: '在导出内按偏移写原始字节（hex）。用于改解析器没覆盖到的字段。',
        schema: {
            type: 'object',
            properties: { session: { type: 'string' }, export: {}, offset: { type: 'number' }, hex: { type: 'string' } },
            required: ['session', 'export', 'offset', 'hex'],
        },
        run: function (a) {
            return getAsset(a.session).pkg.patchBytes(a.export, a.offset, a.hex);
        },
    };

    T.uasset_blueprint = {
        desc: '蓝图视图：类/父类、函数、组件、CDO 默认值一览。比直接 dump 属性树更适合先看懂结构。',
        schema: { type: 'object', properties: { session: { type: 'string' }, limit: { type: 'number' } }, required: ['session'] },
        run: function (a) {
            var pkg = getAsset(a.session).pkg;
            var limit = a.limit || 60;
            var classes = [], functions = [], components = [], defaults = [];
            for (var i = 0; i < pkg.exports.length; i++) {
                var exp = pkg.exports[i];
                var cls = pkg.exportList({ offset: i, limit: 1 }).items[0].className || '';
                if (/Class$/.test(cls)) classes.push({ index: i, name: exp.objectName, className: cls, size: exp.serialSize });
                if (cls === 'Function') functions.push({ index: i, name: exp.objectName, size: exp.serialSize });
                if (/Component/.test(exp.objectName) && exp.serialSize && exp.serialSize < 4096) {
                    components.push({ index: i, name: exp.objectName, size: exp.serialSize });
                }
                if (exp.objectName.indexOf('Default__') === 0) {
                    var props = [];
                    try { props = pkg.parseExport(i) || []; } catch (e) { props = []; }
                    defaults.push({
                        index: i, name: exp.objectName, propertyCount: props.length,
                        properties: props.slice(0, limit).map(function (p) {
                            return {
                                name: p.name, type: p.type, structName: p.structName, innerType: p.innerType,
                                value: preview(p.value), editable: p.type !== 'StructProperty' && p.type !== 'ArrayProperty',
                            };
                        }),
                    });
                }
            }
            return {
                asset: pkg.name, isBlueprint: classes.length > 0,
                classes: classes.slice(0, limit), functions: functions.slice(0, limit),
                components: components.slice(0, limit), defaults: defaults,
            };
        },
    };

    T.uasset_export_base64 = {
        desc: '把当前内存里的资产导出成 base64（可选只导出改动后的）。AI 可据此拿到完整文件。',
        schema: {
            type: 'object',
            properties: { session: { type: 'string' }, verify: { type: 'boolean' } },
            required: ['session'],
        },
        run: function (a) {
            var asset = getAsset(a.session);
            var out = asset.pkg.save({ verify: a.verify !== false });
            return {
                unchanged: !!out.unchanged,
                verification: out.verification,
                uassetBase64: bytesToB64(out.uasset),
                uexpBase64: out.uexp ? bytesToB64(out.uexp) : null,
                sizes: { uasset: out.uasset.length, uexp: out.uexp ? out.uexp.length : 0 },
            };
        },
    };

    T.uasset_export_json = {
        desc: '把导出（或整个资产）转成 JSON 结构，便于 AI 引用与对比。',
        schema: { type: 'object', properties: { session: { type: 'string' }, export: {} }, required: ['session'] },
        run: function (a) { return getAsset(a.session).pkg.toJSON({ exportRef: a.export === undefined ? null : a.export }); },
    };

    T.uasset_save = {
        desc: '保存并写盘。优先用给定 uri（先在 App 里「选择保存位置」拿到）；没给则由 App 弹保存对话框。',
        schema: {
            type: 'object',
            properties: {
                session: { type: 'string' },
                uri: { type: 'string', description: '目标 .uasset 的 content:// URI' },
                uexpUri: { type: 'string', description: '目标 .uexp 的 URI（分离资产需要）' },
                verify: { type: 'boolean' },
            },
            required: ['session'],
        },
        run: function (a) {
            var asset = getAsset(a.session);
            var out = asset.pkg.save({ verify: a.verify !== false });
            if (!a.uri) {
                return {
                    saved: false,
                    pending: true,
                    verification: out.verification,
                    hint: '需要在手机上选择保存位置：点 App 设置里的「选择保存位置」，再把返回的 uri 传进来；或直接用 uasset_export_base64 取走字节。',
                    sizes: { uasset: out.uasset.length, uexp: out.uexp ? out.uexp.length : 0 },
                };
            }
            var fs = bridge();
            var r1 = readJson(fs.writeBase64(a.uri, bytesToB64(out.uasset)));
            if (!r1 || !r1.ok) throw new Error('写 .uasset 失败: ' + (r1 && r1.error));
            var r2 = null;
            if (out.uexp && a.uexpUri) {
                r2 = readJson(fs.writeBase64(a.uexpUri, bytesToB64(out.uexp)));
                if (!r2 || !r2.ok) throw new Error('写 .uexp 失败: ' + (r2 && r2.error));
            }
            // 以写盘结果为新基线，后续改动基于它继续
            asset.uasset = out.uasset.slice();
            asset.uexp = out.uexp ? out.uexp.slice() : null;
            asset.pkg = new Package({ uasset: asset.uasset, uexp: asset.uexp, name: asset.name });
            return {
                saved: true,
                verification: out.verification,
                sizes: { uasset: out.uasset.length, uexp: out.uexp ? out.uexp.length : 0 },
                uexpWritten: !!r2,
            };
        },
    };

    T.uasset_help = {
        desc: '返回本服务器的工作流、路径语法、常见坑。不确定时先调。',
        schema: { type: 'object', properties: {} },
        run: function () { return HELP; },
    };

    var HELP = {
        version: '2.0.0 (App)',
        workflow: [
            '1) app_status 看已载入哪些资产（session）',
            '2) app_list_files / app_open_file 打开用户授权过的文件',
            '3) uasset_validate 先看哪些导出能安全改',
            '4) uasset_query 按名字/类型定位属性，uasset_get 确认当前值',
            '5) uasset_set 改值（定长走字节补丁，mode=patch 最安全）',
            '6) uasset_export_base64 自检通过后取走字节，或 uasset_save 写盘',
        ],
        pathSyntax: {
            exportSelector: '导出名（完整名优先）或 #索引',
            property: '.属性名',
            array: '[3]',
            example: 'Default__BP_Rifle_AUG_C.WeaponAttrModifyConfigList[0].WeaponAttrModifiers[0].ModifyValue',
        },
        gotchas: [
            '只能操作 App 里已载入的资产；没有路径/目录概念（文件访问走 SAF 授权）。',
            '改之前先 uasset_snapshot，不满意 uasset_restore 退回。',
            '变长编辑（字符串/数组增删）会重建导出；遇到「未解析原始块」的拒绝提示时改用定长字段。',
            '写盘需要目标 URI：App 设置里「选择保存位置」后会给出。',
        ],
    };

    /* ------------------------------------------------------------ 协议 */

    var TOOL_LIST = Object.keys(T).map(function (name) {
        return { name: name, description: T[name].desc, inputSchema: T[name].schema };
    });

    function handleCall(name, args) {
        var t = T[name];
        if (!t) throw new Error('未知工具: ' + name + '（可用: ' + Object.keys(T).join(', ') + '）');
        var missing = (t.schema.required || []).filter(function (k) { return args[k] === undefined; });
        if (missing.length) throw new Error('缺少参数: ' + missing.join(', '));
        return t.run(args || {});
    }

    function handle(msg) {
        var id = msg && msg.id;
        var method = msg && msg.method;
        function ok(result) { return { jsonrpc: '2.0', id: id, result: result }; }
        function err(code, message) { return { jsonrpc: '2.0', id: id, error: { code: code, message: message } }; }
        try {
            switch (method) {
                case 'initialize':
                    return ok({
                        protocolVersion: '2024-11-05',
                        capabilities: { tools: { listChanged: false } },
                        serverInfo: { name: 'uasset-studio-app', version: APP_MCP_VERSION },
                        instructions: '手机上运行的 UE 资产编辑器 MCP。先 app_status，再 uasset_help 了解路径语法。',
                    });
                case 'notifications/initialized':
                case 'initialized':
                    return null;
                case 'ping':
                    return ok({});
                case 'tools/list':
                    return ok({ tools: TOOL_LIST });
                case 'tools/call': {
                    var p = msg.params || {};
                    try {
                        var r = handleCall(p.name, p.arguments || {});
                        return ok({ content: [{ type: 'text', text: JSON.stringify(r) }], structuredContent: r, isError: false });
                    } catch (e) {
                        return ok({ content: [{ type: 'text', text: '错误: ' + (e.message || e) }], isError: true });
                    }
                }
                default:
                    if (method && method.indexOf('notifications/') === 0) return null;
                    return err(-32601, '未实现的方法: ' + method);
            }
        } catch (e) {
            return err(-32603, String(e && e.message || e));
        }
    }

    var APP_MCP_VERSION = '2.0.0';

    /* ------------------------------------------------------------ 对外 */


    /* ------------------------------------------------------------ 设置面板接线 */

    var ui = {};

    function $(id) { try { return document.getElementById(id); } catch (e) { return null; } }

    function hasNativeMcp() {
        return typeof AndroidMCP !== 'undefined' && AndroidMCP && typeof AndroidMCP.start === 'function';
    }

    function readStatus() {
        if (!hasNativeMcp()) return null;
        try { return JSON.parse(AndroidMCP.status()); } catch (e) { return null; }
    }

    function renderStatus(st) {
        var box = ui.status;
        if (!box) return;
        if (!hasNativeMcp()) {
            box.className = 'mcp-status';
            box.textContent = '当前环境不支持内嵌 MCP（需要在 App 内运行；桌面端用 node src/mcp/server.js）';
            return;
        }
        if (st && st.running) {
            box.className = 'mcp-status on';
            box.innerHTML = '';
            var line1 = document.createElement('div');
            line1.innerHTML = '运行中 · 端点 <code>' + st.endpoint + '</code>';
            box.appendChild(line1);
            if (st.lan && st.lanEndpoint) {
                var line2 = document.createElement('div');
                line2.innerHTML = '局域网 <code>' + st.lanEndpoint + '</code>';
                box.appendChild(line2);
            }
            var line3 = document.createElement('div');
            line3.textContent = '工具 ' + (window.__APP_MCP.toolNames().length) + ' 个 · 已载入资产 ' + assets.size + ' 个';
            box.appendChild(line3);
            if (ui.enable) ui.enable.checked = true;
        } else {
            box.className = 'mcp-status';
            box.textContent = '未启动（打开上面的开关）';
            if (ui.enable) ui.enable.checked = false;
        }
    }

    function renderFiles(files) {
        var box = ui.files;
        if (!box) return;
        box.innerHTML = '';
        var list = (files && files.files) || [];
        if (!list.length) {
            box.textContent = '（还没有授权文件）';
            return;
        }
        list.forEach(function (f) {
            var row = document.createElement('div');
            row.className = 'mcp-file';
            var name = document.createElement('span');
            name.textContent = f.name || f.uri;
            var del = document.createElement('button');
            del.textContent = '移除';
            del.onclick = function () {
                try {
                    AndroidFS.forgetAiFile(f.uri);
                    refreshFiles();
                } catch (e) { console.warn(e); }
            };
            row.appendChild(name);
            row.appendChild(del);
            box.appendChild(row);
        });
    }

    function refreshFiles() {
        if (typeof AndroidFS === 'undefined' || !AndroidFS) { renderFiles(null); return; }
        try { renderFiles(JSON.parse(AndroidFS.listAiFiles())); } catch (e) { renderFiles(null); }
    }

    function startStop(on) {
        if (!hasNativeMcp()) {
            renderStatus(null);
            return;
        }
        var port = parseInt((ui.port && ui.port.value) || '8787', 10);
        if (!(port >= 1024 && port <= 65535)) {
            if (ui.status) { ui.status.className = 'mcp-status err'; ui.status.textContent = '端口需在 1024~65535 之间'; }
            if (ui.enable) ui.enable.checked = false;
            return;
        }
        try {
            var st;
            if (on) {
                st = JSON.parse(AndroidMCP.start(port, !!(ui.lan && ui.lan.checked)));
            } else {
                AndroidMCP.stop();
                st = { running: false };
            }
            if (st && st.ok === false) {
                if (ui.status) { ui.status.className = 'mcp-status err'; ui.status.textContent = '启动失败：' + (st.error || '未知错误'); }
                if (ui.enable) ui.enable.checked = false;
                return;
            }
            try { localStorage.setItem('mcp_port', String(port)); } catch (e) { }
            try { localStorage.setItem('mcp_lan', (ui.lan && ui.lan.checked) ? '1' : '0'); } catch (e) { }
            renderStatus(st);
        } catch (e) {
            if (ui.status) { ui.status.className = 'mcp-status err'; ui.status.textContent = '启动失败：' + (e.message || e); }
            if (ui.enable) ui.enable.checked = false;
        }
    }

    function clientConfig() {
        var st = readStatus();
        var url = (st && st.endpoint) || 'http://127.0.0.1:8787/mcp';
        return JSON.stringify({
            mcpServers: {
                'uasset-studio-app': { type: 'http', url: url, headers: {} },
            },
        }, null, 2);
    }

    function initUi() {
        ui.enable = $('mcpEnable');
        ui.port = $('mcpPort');
        ui.lan = $('mcpLan');
        ui.status = $('mcpStatus');
        ui.files = $('mcpFiles');
        ui.addFiles = $('mcpAddFiles');
        ui.saveTarget = $('mcpSaveTarget');
        ui.copy = $('mcpCopyConfig');
        if (!ui.enable || !ui.status) return;   // 页面里没有这块面板

        // 恢复上次的端口/局域网设置
        try {
            var savedPort = localStorage.getItem('mcp_port');
            if (savedPort && ui.port) ui.port.value = savedPort;
            if (ui.lan) ui.lan.checked = localStorage.getItem('mcp_lan') === '1';
        } catch (e) { }

        ui.enable.onchange = function () { startStop(!!ui.enable.checked); };
        if (ui.port) {
            ui.port.onchange = function () {
                if (ui.enable.checked) startStop(true);   // 改端口后自动重启
            };
        }
        if (ui.lan) {
            ui.lan.onchange = function () {
                if (ui.enable.checked) startStop(true);
            };
        }
        if (ui.addFiles) {
            ui.addFiles.onclick = function () {
                if (typeof AndroidFS === 'undefined' || !AndroidFS || !AndroidFS.pickForAi) {
                    alert('需要在 App 内使用');
                    return;
                }
                AndroidFS.pickForAi();
            };
        }
        if (ui.saveTarget) {
            ui.saveTarget.onclick = function () {
                if (typeof AndroidFS === 'undefined' || !AndroidFS || !AndroidFS.pickSaveTarget) {
                    alert('需要在 App 内使用');
                    return;
                }
                AndroidFS.pickSaveTarget('asset.mod.uasset');
            };
        }
        if (ui.copy) {
            ui.copy.onclick = function () {
                var text = clientConfig();
                if (hasNativeMcp() && AndroidMCP.copy) {
                    AndroidMCP.copy(text);
                } else if (navigator.clipboard) {
                    navigator.clipboard.writeText(text).catch(function () { });
                }
            };
        }

        renderStatus(readStatus());
        refreshFiles();
    }

    // 页面回调：用户选完可读文件 / 选完保存位置
    window.__onAiFilesChanged = function (json) {
        try { renderFiles(typeof json === 'string' ? JSON.parse(json) : json); } catch (e) { refreshFiles(); }
    };
    window.__onSaveTargetChosen = function (uri) {
        window.__lastSaveTarget = uri || null;
        try {
            if (uri) {
                var txt = '已选保存位置，AI 可用这个 URI 写盘：\n' + uri;
                if (typeof showToast === 'function') showToast('保存位置已就绪');
                console.log('[MCP]', txt);
            }
        } catch (e) { }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initUi);
    } else {
        initUi();
    }

    // 面板打开时刷新一次状态（用户可能刚在别处改了资产）
    var settingsBtn = $('settingsToggle');
    if (settingsBtn) settingsBtn.addEventListener('click', function () { setTimeout(function () { renderStatus(readStatus()); refreshFiles(); }, 50); });

    window.__APP_MCP = {
        register: function (name, uasset, uexp) {
            try { return register(name, uasset, uexp); } catch (e) { console.warn('[MCP] 登记资产失败', e); return null; }
        },
        // Java 侧通过 evaluateJavascript 调用，传 JSON 字符串，返回响应对象
        handle: function (requestText) {
            var msg;
            try { msg = typeof requestText === 'string' ? JSON.parse(requestText) : requestText; }
            catch (e) { return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } }; }
            if (Array.isArray(msg)) {
                return msg.map(handle).filter(Boolean);
            }
            return handle(msg);
        },

        toolNames: function () { return Object.keys(T); },
        assets: function () { return Array.from(assets.keys()); },
    };
})();
