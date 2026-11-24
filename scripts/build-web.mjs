#!/usr/bin/env node
/**
 * build-web.mjs — 把 src/core + src/web 打包成单文件 web/app.js
 *
 * 为什么要打包而不是直接 <script type="module">：
 *   原 UI 代码是经典脚本（依赖全局变量与内联 onclick），改成 ESM 要重写全部事件绑定。
 *   打包成 IIFE 并把引擎符号挂到 globalThis，既保留原行为，又能用模块化的 core。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const log = read('src/core/log.js')
  .replace(/^export\s*\{[^}]*\};?\s*$/m, '')
  .replace(/^const g = .*$/m, 'const g = typeof globalThis !== "undefined" ? globalThis : {};');

const engine = read('src/core/engine.js')
  .replace(/^import\s+\{[^}]*\}\s+from\s+'\.\/log\.js';\s*$/m, '')
  .replace(/^export\s*\{[\s\S]*?\};?\s*$/m, '');

const ui = read('src/web/ui.js');

const banner = `/*!
 * uasset-studio web bundle — 自动生成，请勿直接编辑
 * 源：src/core/{log,engine}.js + src/web/ui.js
 * 构建：node scripts/build-web.mjs
 */
(function () {
"use strict";
`;

const bridge = `
// ---- 模块化 core → 全局符号（原 UI 代码按经典脚本编写，需要这些全局名）----
globalThis.isDebugEnabled = isDebugEnabled;
globalThis.debugLog = debugLog;
globalThis.debugWarn = debugWarn;
globalThis.debugError = debugError;
globalThis.debugInfo = debugInfo;
globalThis.UAssetBinaryReader = UAssetBinaryReader;
globalThis.UAssetHeaderReader = UAssetHeaderReader;
globalThis.UAssetNameMapReader = UAssetNameMapReader;
globalThis.UAssetObjectReader = UAssetObjectReader;
globalThis.UAssetPropertyReader = UAssetPropertyReader;
globalThis.UAssetBinaryWriter = UAssetBinaryWriter;
globalThis.UAssetHeaderWriter = UAssetHeaderWriter;
globalThis.UAssetPropertyWriter = UAssetPropertyWriter;
`;

const out = [banner, log, engine, bridge, ui, '})();', ''].join('\n');
fs.mkdirSync(path.join(root, 'web'), { recursive: true });
fs.writeFileSync(path.join(root, 'web/app.js'), out);
console.log('[build-web] web/app.js %d KB', Math.round(out.length / 1024));

// 顺带把 xev（十六进制编辑器）也做一次语法检查
for (const f of ['web/xev.js']) {
  try { new Function(fs.readFileSync(path.join(root, f), 'utf8')); console.log('[build-web] %s 语法 OK', f); }
  catch (e) { console.error('[build-web] %s 语法错误: %s', f, e.message); process.exitCode = 1; }
}
