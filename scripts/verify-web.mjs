#!/usr/bin/env node
/**
 * verify-web.mjs — 构建产物的洁净性校验（CI 与本地共用）
 *
 * 检查三件事，任一条不满足就退出 1：
 *   1. index.html 不含任何远端配置/门禁调用与第三方注入标记
 *   2. 引用的本地脚本都存在，且不含指向不存在文件的引用
 *   3. app.js 能被解析（语法正确），且关键引擎符号已挂到全局
 *
 * 不用 grep：注释里出现这些词是允许的，要查的是「真的在调/在引用」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = path.join(root, 'web');
const html = fs.readFileSync(path.join(web, 'index.html'), 'utf8');
const problems = [];

// ---- 1. 去掉注释与字符串后的「有效代码」中不得出现远端门禁痕迹 ----
const stripped = html
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '');

const FORBIDDEN = [
  [/https?:\/\/[^"'\s]*(cfg\.json|gb-assets)/i, '远端配置地址'],
  [/HMAC/i, 'HMAC 校验'],
  [/kill\s*switch/i, '远程停用'],
  [/__HP_(ASSET|VOICE)/, '第三方注入资源'],
  [/window\.HP_GATE/, '门禁全局对象'],
];
for (const [re, why] of FORBIDDEN) {
  if (re.test(stripped)) problems.push(`index.html 有效代码里仍有${why}（${re}）`);
}

// ---- 2. 引用的脚本必须存在 ----
const refs = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
for (const r of refs) {
  const clean = r.split('?')[0];
  if (/^https?:/.test(clean)) { problems.push(`引用了远端脚本: ${r}`); continue; }
  if (!fs.existsSync(path.join(web, clean))) problems.push(`引用了不存在的脚本: ${r}`);
}
if (!refs.some((r) => r.startsWith('app.js'))) problems.push('index.html 没有引用 app.js（构建未生效？）');

// ---- 3. app.js 可解析且引擎符号已挂载 ----
const appPath = path.join(web, 'app.js');
if (!fs.existsSync(appPath)) {
  problems.push('web/app.js 不存在，先运行 node scripts/build-web.mjs');
} else {
  const app = fs.readFileSync(appPath, 'utf8');
  try { new Function(app); } catch (e) { problems.push(`app.js 语法错误: ${e.message}`); }
  for (const sym of ['UAssetHeaderReader', 'UAssetNameMapReader', 'UAssetObjectReader', 'UAssetPropertyReader', 'UAssetPropertyWriter']) {
    if (!app.includes(`globalThis.${sym}`)) problems.push(`app.js 未挂载 ${sym} 到全局`);
  }
  const kb = Math.round(app.length / 1024);
  if (kb > 2000) problems.push(`app.js 体积异常 (${kb} KB)，可能误把大块资源打进来了`);
}

if (problems.length) {
  console.error('Web 产物校验失败:');
  for (const p of problems) console.error('  ✗', p);
  process.exit(1);
}
console.log('✓ index.html %d KB，引用 %d 个本地脚本，无远端依赖', Math.round(html.length / 1024), refs.length);
console.log('✓ app.js 语法正确，引擎符号已挂载');
