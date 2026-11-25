#!/usr/bin/env node
/**
 * lint-java.mjs — 没有 JDK 时的 Java 静态自检
 *
 * CI 上会真正 gradle 编译，这里只是为了「本地/快速」发现低级错误：
 *   - 括号/花括号配平（忽略字符串与注释）
 *   - 每个 .java 的 package 与目录一致
 *   - public class 名与文件名一致
 *   - 用到的 import 是否写了（粗查常见类）
 *   - 不允许出现 TODO/FIXME 留在提交里
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'android/app/src/main/java');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    e.isDirectory() ? walk(p, out) : (p.endsWith('.java') && out.push(p));
  }
  return out;
}

/** 去掉注释与字符串字面量，便于统计括号 */
function strip(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'") {
      const q = c; i++;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === q) { i++; break; }
        i++;
      }
      out += '""';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const problems = [];
const files = fs.existsSync(srcDir) ? walk(srcDir) : [];
if (!files.length) {
  console.error('没有找到 Java 源文件');
  process.exit(1);
}

for (const file of files) {
  const rel = path.relative(srcDir, file);
  const name = path.basename(file, '.java');
  const src = fs.readFileSync(file, 'utf8');
  const code = strip(src);

  // 1. 括号配平
  const counts = { '{': 0, '(': 0, '[': 0 };
  const pairs = { '}': '{', ')': '(', ']': '[' };
  for (const ch of code) {
    if (counts[ch] !== undefined) counts[ch]++;
    else if (pairs[ch]) {
      counts[pairs[ch]]--;
      if (counts[pairs[ch]] < 0) { problems.push(`${rel}: 括号不配平（多余的 ${ch}）`); break; }
    }
  }
  if (counts['{'] !== 0) problems.push(`${rel}: 花括号差 ${counts['{']}`);
  if (counts['('] !== 0) problems.push(`${rel}: 圆括号差 ${counts['(']}`);

  // 2. package 与目录一致
  const pkg = (src.match(/^\s*package\s+([\w.]+)\s*;/m) || [])[1];
  const expected = path.dirname(rel).split(path.sep).join('.');
  if (pkg !== expected) problems.push(`${rel}: package 应为 ${expected}，实际 ${pkg}`);

  // 3. public class 名与文件名一致
  const pub = (src.match(/public\s+(?:final\s+)?(?:class|interface|enum)\s+(\w+)/) || [])[1];
  if (pub && pub !== name) problems.push(`${rel}: public class ${pub} 与文件名 ${name} 不一致`);

  // 4. 常见类型是否 import（只查高频、且不在 java.lang）
  const need = {
    'JSONObject': 'org.json.JSONObject',
    'JSONArray': 'org.json.JSONArray',
    'WebView': 'android.webkit.WebView',
    'Uri': 'android.net.Uri',
    'SharedPreferences': 'android.content.SharedPreferences',
    'CountDownLatch': 'java.util.concurrent.CountDownLatch',
  };
  for (const [sym, imp] of Object.entries(need)) {
    if (new RegExp('\\b' + sym + '\\b').test(code) && !src.includes(imp)) {
      problems.push(`${rel}: 用到 ${sym} 但没 import ${imp}`);
    }
  }

  // 5. 不留 TODO
  if (/\b(TODO|FIXME|XXX)\b/.test(src)) problems.push(`${rel}: 有未完成的 TODO/FIXME`);

  console.log('  %s  %d 行', rel, src.split('\n').length);
}

if (problems.length) {
  console.error('\nJava 静态检查失败:');
  for (const p of problems) console.error('  ✗', p);
  process.exit(1);
}
console.log('\n✓ %d 个 Java 文件通过静态检查（括号/package/类名/import）', files.length);
