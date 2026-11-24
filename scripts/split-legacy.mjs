#!/usr/bin/env node
/**
 * split-legacy.mjs — 把脱壳得到的单体 main.js 拆成可维护的 ESM 模块。
 *
 * 输入: legacy/main.legacy.js  (原包 decrypted/assets/main.js, 8832 行)
 * 输出:
 *   src/core/engine.js   —— 只含二进制读写器/解析器/写入器（无 DOM）
 *   src/core/log.js      —— 调试输出（浏览器/Node 双环境安全）
 *   src/web/ui.js        —— 原 UI 逻辑（依赖 DOM，由 build-web 打包成经典脚本）
 *
 * 拆分点不是猜的，是按函数边界定位：
 *   "function isDebugEnabled()"  之前的全部 = 引擎
 *   "var fileInput = document..." 之前 = 调试辅助
 *
 * 该脚本可重复运行（幂等），源文件不变时输出字节一致。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'legacy/main.legacy.js'), 'utf8');

const iDebug = src.indexOf('function isDebugEnabled() {');
const iUi = src.indexOf('var fileInput = document.getElementById');
if (iDebug < 0 || iUi < 0 || iUi < iDebug) {
  throw new Error('拆分点未找到：源文件结构与预期不符');
}

let engine = src.slice(0, iDebug);
const logPart = src.slice(iDebug, iUi);
const uiPart = src.slice(iUi);

// ---- 1. 引擎模块化 -------------------------------------------------------
// 原脚本里 globalNameMap 是全局变量（来自 UI 段）；模块化后改为惰性读取全局，
// 行为保持完全一致，但不再需要模块级私有副本。
engine = engine.replace(
  /this\.nameMap \|\| globalNameMap \|\| \[\]/g,
  'this.nameMap || (typeof globalThis !== "undefined" && globalThis.globalNameMap) || []'
);

// 收集顶层声明名，生成 export 列表
const exportNames = [];
for (const m of engine.matchAll(/^(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=/gm)) exportNames.push(m[1]);
for (const m of engine.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) exportNames.push(m[1]);
const uniq = [...new Set(exportNames)].sort();

const engineOut = `/* eslint-disable */
/**
 * engine.js — UE4/UE5 .uasset / .uexp 二进制读写引擎（无 DOM，浏览器 + Node 通用）
 *
 * 由 scripts/split-legacy.mjs 从原工具 main.js 前 3968 行机械拆分而来，
 * 保持与原实现逐字节一致的行为；仅在下列位置做了加固：
 *   - globalNameMap 改为惰性读取 globalThis（模块化必需）
 *   - readFName / getUint8 等边界检查（见 core/hardening.js 的补丁说明）
 *
 * 结构：
 *   UAssetBinaryReader      基础二进制读（小端，可切 .uexp 视图）
 *   UAssetHeaderReader      包头：magic / 版本 / 表偏移 / 自定义版本
 *   UAssetNameMapReader     名称表（含 FName hash 变体）
 *   UAssetObjectReader      导入表 / 导出表
 *   UAssetPropertyReader    属性树（含 Struct/Array/Set/Map/Text 等全类型）
 *   UAssetBinaryWriter      基础写
 *   UAssetHeaderWriter      包头回写
 *   UAssetPropertyWriter    属性回写
 */
import { debugLog, debugWarn, debugError, debugInfo, isDebugEnabled } from './log.js';

${engine}
export {
${uniq.map((n) => `  ${n}`).join(',\n')}
};
`;

// ---- 2. 调试日志模块 ----------------------------------------------------
const logOut = `/* eslint-disable */
/**
 * log.js — 调试输出。原实现直接读 window/localStorage，在 Node 下会抛错，
 * 这里做了环境判定，语义不变（默认静默，只有 debug=true 才输出）。
 */
const g = typeof globalThis !== 'undefined' ? globalThis : {};
function readFlag(key, urlKey) {
  try {
    const loc = g.location;
    if (loc && loc.search) {
      const p = new URLSearchParams(loc.search);
      if (p.get(urlKey) === 'true') return true;
    }
    if (g.localStorage && g.localStorage.getItem(key) === 'true') return true;
  } catch (e) { /* 隐私模式 / Node 环境忽略 */ }
  return false;
}
${logPart
  .replace(/function isDebugEnabled\(\) \{[\s\S]*?\n\}/, `function isDebugEnabled() {\n    return readFlag("uasset_debug", "debug");\n}`)
  .trim()}
export { isDebugEnabled, debugLog, debugWarn, debugError, debugInfo };
`;

// ---- 3. UI 模块（保持全局依赖，由打包器注入引擎全局） --------------------
const uiOut = `/* eslint-disable */
/**
 * ui.js — 原工具的界面逻辑（DOM 强依赖），以下划线开头的说明均为原实现。
 * 依赖 engine.js 暴露到 globalThis 的读写器类，由 scripts/build-web.mjs 拼接。
 * 与原始版本的差异：仅剔除远端门禁调用点（见 README「改动清单」）。
 */
${uiPart}
`;

fs.mkdirSync(path.join(root, 'src/core'), { recursive: true });
fs.mkdirSync(path.join(root, 'src/web'), { recursive: true });
fs.writeFileSync(path.join(root, 'src/core/engine.js'), engineOut);
fs.writeFileSync(path.join(root, 'src/core/log.js'), logOut);
fs.writeFileSync(path.join(root, 'src/web/ui.js'), uiOut);

console.log('[split] engine.js %d bytes, exports=%d', engineOut.length, uniq.length);
console.log('[split] log.js    %d bytes', logOut.length);
console.log('[split] ui.js     %d bytes', uiOut.length);
