#!/usr/bin/env node
/**
 * build-web.mjs — 把 core 模块 + 界面逻辑打成单文件 web/app.js
 *
 * 为什么打包而不是直接 <script type="module">：
 *   原 UI 代码是经典脚本（依赖全局变量与内联 onclick），改成 ESM 要重写全部事件绑定。
 *   这里做的是「去掉 import/export 语法 → 拼成 IIFE → 把符号挂到 globalThis」，
 *   既保留原行为，又能复用模块化的 core。
 *
 * 打包顺序有依赖：log → engine → names → serializer → package → 全局桥 → ui → mcp-app
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

/** 去掉 ESM 语法，得到可直接拼接的经典脚本片段 */
function stripModule(src) {
  return src
    .replace(/^import\s+[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^export\s*\{[\s\S]*?\};?\s*$/gm, '')
    .replace(/^export\s+(function|class|const|let|var)\s/gm, '$1 ');
}

const modules = [
  ['src/core/log.js', 'log'],
  ['src/core/engine.js', 'engine'],
  ['src/core/names.js', 'names'],
  ['src/core/serializer.js', 'serializer'],
  ['src/core/package.js', 'package'],
];

const parts = [];
for (const [file, label] of modules) {
  const src = stripModule(read(file));
  parts.push(`\n/* ==================== ${label} (${file}) ==================== */\n${src}`);
}

const bridge = `
/* ==================== 模块化 core → 全局符号 ==================== */
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
globalThis.Package = Package;
`;

const ui = read('src/web/ui.js');
const mcpApp = read('src/web/mcp-app.js');

const out = [
  '/*!',
  ' * uasset-studio web bundle — 自动生成，请勿直接编辑',
  ' * 源：src/core/{log,engine,names,serializer,package}.js + src/web/{ui,mcp-app}.js',
  ' * 构建：node scripts/build-web.mjs',
  ' */',
  '(function () {',
  '"use strict";',
  ...parts,
  bridge,
  '\n/* ==================== ui (src/web/ui.js) ==================== */\n',
  ui,
  '\n/* ==================== mcp-app (src/web/mcp-app.js) ==================== */\n',
  mcpApp,
  '})();',
  '',
].join('\n');

fs.mkdirSync(path.join(root, 'web'), { recursive: true });
fs.writeFileSync(path.join(root, 'web/app.js'), out);

const kb = Math.round(out.length / 1024);
console.log('[build-web] web/app.js %d KB（%d 个模块 + ui + mcp-app）', kb, modules.length);

// 语法自检
try {
  new Function(out);
  console.log('[build-web] 语法检查通过');
} catch (e) {
  console.error('[build-web] 语法错误: %s', e.message);
  process.exitCode = 1;
}

for (const f of ['web/xev.js']) {
  try {
    new Function(fs.readFileSync(path.join(root, f), 'utf8'));
    console.log('[build-web] %s 语法 OK', f);
  } catch (e) {
    console.error('[build-web] %s 语法错误: %s', f, e.message);
    process.exitCode = 1;
  }
}
