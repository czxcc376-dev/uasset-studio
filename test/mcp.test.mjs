/**
 * MCP 端到端测试：真的用 stdio 起服务器，走 JSON-RPC 完成 打开→读→改→自检→保存。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const SERVER = path.resolve('src/mcp/server.js');
const FIXTURE = path.resolve('test/fixtures/TestAsset.uasset');

function startServer() {
  const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
  const waiters = new Map();
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const w = waiters.get(msg.id);
      if (w) { waiters.delete(msg.id); w(msg); }
    }
  });
  let id = 0;
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const myId = ++id;
    waiters.set(myId, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
    setTimeout(() => { if (waiters.has(myId)) { waiters.delete(myId); reject(new Error(`超时: ${method}`)); } }, 20000);
  });
  return { child, rpc };
}

test('MCP 全链路：open → list → get → set(patch) → verify → save', async () => {
  const { child, rpc } = startServer();
  try {
    const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.equal(init.result.serverInfo.name, 'uasset-studio');

    const list = await rpc('tools/list');
    assert.ok(list.result.tools.length >= 30, `工具数应 >= 30，实际 ${list.result.tools.length}`);

    const open = await rpc('tools/call', { name: 'uasset_open', arguments: { uassetPath: FIXTURE } });
    const info = open.result.structuredContent;
    assert.ok(info.session);
    assert.ok(info.tables.exports >= 1, '导出表不能为空');
    assert.ok(info.tables.names >= 1, '名称表不能为空');
    const session = info.session;

    const exports = await rpc('tools/call', { name: 'uasset_list_exports', arguments: { session, filter: 'Default__' } });
    assert.ok(exports.result.structuredContent.items.length >= 1);

    const got = await rpc('tools/call', {
      name: 'uasset_get',
      arguments: { session, path: 'Default__TestAsset_C.TestBool' },
    });
    assert.equal(got.result.structuredContent.value, true);

    const set = await rpc('tools/call', {
      name: 'uasset_set',
      arguments: { session, path: 'Default__TestAsset_C.TestBool', value: false },
    });
    assert.equal(set.result.structuredContent.mode, 'patch');

    const verify = await rpc('tools/call', { name: 'uasset_verify', arguments: { session } });
    assert.equal(verify.result.structuredContent.ok, true);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uasset-'));
    const save = await rpc('tools/call', { name: 'uasset_save', arguments: { session, outDir: tmp } });
    assert.ok(save.result.structuredContent.uassetPath.includes('.mod.uasset'));
    assert.ok(fs.existsSync(save.result.structuredContent.uassetPath));

    // 重新打开保存后的文件，确认改动生效
    const reopen = await rpc('tools/call', { name: 'uasset_open', arguments: { uassetPath: save.result.structuredContent.uassetPath } });
    const s2 = reopen.result.structuredContent.session;
    const got2 = await rpc('tools/call', { name: 'uasset_get', arguments: { session: s2, path: 'Default__TestAsset_C.TestBool' } });
    assert.equal(got2.result.structuredContent.value, false);
  } finally {
    child.kill();
  }
});

test('MCP 错误路径给出可执行提示', async () => {
  const { child, rpc } = startServer();
  try {
    await rpc('initialize', {});
    const open = await rpc('tools/call', { name: 'uasset_open', arguments: { uassetPath: FIXTURE } });
    const session = open.result.structuredContent.session;
    const bad = await rpc('tools/call', { name: 'uasset_get', arguments: { session, path: 'Default__TestAsset_C.NoSuchProp' } });
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /属性不存在/);
    const noSession = await rpc('tools/call', { name: 'uasset_info', arguments: { session: 'nope' } });
    assert.match(noSession.result.content[0].text, /会话不存在/);
  } finally {
    child.kill();
  }
});
