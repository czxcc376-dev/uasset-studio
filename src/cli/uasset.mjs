#!/usr/bin/env node
/* eslint-disable */
/**
 * uasset — 命令行入口。与 MCP 工具一一对应，方便脚本化与人工排查。
 *
 *   uasset info  <file.uasset>
 *   uasset ls    <file.uasset> [filter]
 *   uasset names <file.uasset> [query]
 *   uasset tree  <file.uasset> [export] [depth]
 *   uasset get   <file.uasset> <path>
 *   uasset set   <file.uasset> <path> <value> [--out dir] [--overwrite] [--force]
 *   uasset add   <file.uasset> <export> <name> <type> <value> [--struct Name] [--inner Type]
 *   uasset del   <file.uasset> <path>
 *   uasset search<file.uasset> <query> [--regex] [--scope all|names|values|properties]
 *   uasset hex   <file.uasset> <export> [offset] [length]
 *   uasset patch <file.uasset> <export> <offset> <hex> [--out dir]
 *   uasset save  <file.uasset> [--out dir] [--overwrite] [--force]
 *   uasset diff  <a.uasset> <b.uasset>
 *   uasset json  <file.uasset> [export] [--depth N]
 *   uasset scan  <dir> [filter]
 *   uasset mcp             （打印 MCP 配置片段）
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { Package } from '../core/index.js';

const argv = process.argv.slice(2);
const cmd = argv[0];
const flags = {};
const positional = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--regex') flags.regex = true;
  else if (a === '--overwrite') flags.overwrite = true;
  else if (a === '--force') flags.force = true;
  else if (a === '--out') flags.out = argv[++i];
  else if (a === '--struct') flags.structName = argv[++i];
  else if (a === '--inner') flags.innerType = argv[++i];
  else if (a === '--value-type') flags.valueType = argv[++i];
  else if (a === '--enum') flags.enumName = argv[++i];
  else if (a === '--scope') flags.scope = argv[++i];
  else if (a === '--depth') flags.depth = Number(argv[++i]);
  else if (a === '--exec') flags.exec = true;
  else positional.push(a);
}

const print = (x) => console.log(typeof x === 'string' ? x : JSON.stringify(x, null, 2));
const need = (n, usage) => { if (positional.length < n) { console.error(`用法: ${usage}`); process.exit(2); } };

function coerce(raw, type) {
  if (raw === undefined) return undefined;
  if (/^(Int|UInt|Float|Double|Byte|Enum)/.test(type || '')) {
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  if (type === 'BoolProperty') return raw === 'true' || raw === '1';
  if (/^(Str|Name|Object|Class|Soft)/.test(type || '')) return raw;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const n = Number(raw);
  return Number.isNaN(n) ? raw : n;
}

async function main() {
  switch (cmd) {
    case 'info': {
      need(1, 'uasset info <file.uasset>');
      const pkg = await Package.fromFile(positional[0]);
      print(pkg.info());
      break;
    }
    case 'ls': {
      need(1, 'uasset ls <file.uasset> [filter]');
      const pkg = await Package.fromFile(positional[0]);
      const r = pkg.exportList({ filter: positional[1] || '', limit: 500 });
      print(r.items.map((e) => `#${e.index}\t${e.name}\t${e.className}\t${e.serialSize}B`).join('\n'));
      break;
    }
    case 'names': {
      need(1, 'uasset names <file.uasset> [query]');
      const pkg = await Package.fromFile(positional[0]);
      const r = pkg.nameList({ query: positional[1] || '', limit: 2000 });
      print(r.items.map((n) => `${n.index}\t${n.name}`).join('\n'));
      break;
    }
    case 'tree': {
      need(1, 'uasset tree <file.uasset> [export] [depth]');
      const pkg = await Package.fromFile(positional[0]);
      const exp = positional[1] ?? 0;
      const depth = positional[2] ? Number(positional[2]) : 3;
      print(pkg.tree({ exportRef: isNaN(Number(exp)) ? exp : Number(exp), depth }));
      break;
    }
    case 'get': {
      need(2, 'uasset get <file.uasset> <path>');
      const pkg = await Package.fromFile(positional[0]);
      print(pkg.get(positional[1]));
      break;
    }
    case 'set': {
      need(3, 'uasset set <file.uasset> <path> <value> [--out dir] [--overwrite] [--force]');
      const pkg = await Package.fromFile(positional[0]);
      const cur = pkg.get(positional[1]);
      const r = pkg.set(positional[1], coerce(positional[2], cur.type));
      print(r);
      const res = await pkg.saveToFile(positional[0], { overwrite: flags.overwrite, force: flags.force, suffix: flags.overwrite ? '' : '.mod' });
      if (flags.out) {
        await fs.mkdir(flags.out, { recursive: true });
        await fs.writeFile(path.join(flags.out, path.basename(res.uassetPath)), Buffer.from(pkg.save({ force: flags.force }).uasset));
      }
      print({ saved: res.uassetPath, uexp: res.uexpPath, verification: res.verification });
      break;
    }
    case 'add': {
      need(5, 'uasset add <file.uasset> <export> <name> <type> <value>');
      const pkg = await Package.fromFile(positional[0]);
      const r = pkg.addProperty(positional[1], {
        name: positional[2], type: positional[3], value: coerce(positional[4], positional[3]),
        structName: flags.structName, innerType: flags.innerType, valueType: flags.valueType, enumName: flags.enumName,
      });
      print(r);
      const res = await pkg.saveToFile(positional[0], { force: flags.force, overwrite: flags.overwrite, suffix: flags.overwrite ? '' : '.mod' });
      print({ saved: res.uassetPath, verification: res.verification });
      break;
    }
    case 'del': {
      need(2, 'uasset del <file.uasset> <path>');
      const pkg = await Package.fromFile(positional[0]);
      print(pkg.removeProperty(positional[1]));
      const res = await pkg.saveToFile(positional[0], { force: flags.force, overwrite: flags.overwrite, suffix: flags.overwrite ? '' : '.mod' });
      print({ saved: res.uassetPath, verification: res.verification });
      break;
    }
    case 'search': {
      need(2, 'uasset search <file.uasset> <query> [--regex] [--scope ...]');
      const pkg = await Package.fromFile(positional[0]);
      const r = pkg.search(positional[1], { regex: !!flags.regex, scope: flags.scope || 'all', limit: 200 });
      print(r);
      break;
    }
    case 'hex': {
      need(2, 'uasset hex <file.uasset> <export> [offset] [length]');
      const pkg = await Package.fromFile(positional[0]);
      const r = pkg.hexDump(isNaN(Number(positional[1])) ? positional[1] : Number(positional[1]), { offset: Number(positional[2] || 0), length: Number(positional[3] || 256) });
      print(`${r.hex}`);
      break;
    }
    case 'patch': {
      need(4, 'uasset patch <file.uasset> <export> <offset> <hex>');
      const pkg = await Package.fromFile(positional[0]);
      print(pkg.patchBytes(isNaN(Number(positional[1])) ? positional[1] : Number(positional[1]), Number(positional[2]), positional[3]));
      const res = await pkg.saveToFile(positional[0], { overwrite: flags.overwrite, suffix: flags.overwrite ? '' : '.mod', force: true });
      print({ saved: res.uassetPath, verification: res.verification });
      break;
    }
    case 'save': {
      need(1, 'uasset save <file.uasset> [--out dir] [--overwrite] [--force]');
      const pkg = await Package.fromFile(positional[0]);
      const res = await pkg.saveToFile(positional[0], { overwrite: flags.overwrite, force: flags.force, suffix: flags.overwrite ? '' : '.mod' });
      print(res);
      break;
    }
    case 'diff': {
      need(2, 'uasset diff <a.uasset> <b.uasset>');
      const a = await Package.fromFile(positional[0]);
      const b = await Package.fromFile(positional[1]);
      print(a.diff(b).slice(0, 200));
      break;
    }
    case 'json': {
      need(1, 'uasset json <file.uasset> [export] [--depth N]');
      const pkg = await Package.fromFile(positional[0]);
      const exp = positional[1] === undefined ? null : isNaN(Number(positional[1])) ? positional[1] : Number(positional[1]);
      print(pkg.toJSON({ exportRef: exp, depth: flags.depth ?? 8 }));
      break;
    }
    case 'scan': {
      need(1, 'uasset scan <dir> [filter]');
      const root = positional[0];
      const out = [];
      const walk = async (d) => {
        for (const ent of await fs.readdir(d, { withFileTypes: true })) {
          const full = path.join(d, ent.name);
          if (ent.isDirectory()) { if (!ent.name.startsWith('.')) await walk(full); continue; }
          if (!/\.uasset$/i.test(ent.name)) continue;
          if (positional[1] && !full.toLowerCase().includes(positional[1].toLowerCase())) continue;
          try {
            const pkg = await Package.fromFile(full);
            out.push({ path: full, v: pkg.header.fileVersionUE4, names: pkg.header.nameCount, exports: pkg.header.exportCount, split: pkg.isSplit });
          } catch (e) {
            out.push({ path: full, error: String(e.message || e) });
          }
        }
      };
      await walk(root);
      print(out);
      break;
    }
    case 'mcp': {
      const self = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../mcp/server.js');
      print({
        stdio: { command: 'node', args: [self] },
        http: { command: 'node', args: [self, '--http', '8787'], endpoint: 'http://127.0.0.1:8787/mcp' },
        claudeDesktop: {
          mcpServers: { 'uasset-studio': { command: 'node', args: [self] } },
        },
      });
      break;
    }
    default:
      print(`uasset-studio CLI\n\n命令:\n  info ls names tree get set add del search hex patch save diff json scan mcp\n\n示例:\n  uasset tree BP.uasset Default__BP_Rifle_AUG_C 3\n  uasset set BP.uasset Default__BP_Rifle_AUG_C.bEnableInspect false\n  uasset search BP.uasset Recoil\n  uasset mcp\n`);
  }
}

main().catch((e) => {
  console.error('错误:', e.message || e);
  process.exit(1);
});
