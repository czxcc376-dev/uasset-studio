/**
 * mcp-app.test.mjs — App 内 MCP 的协议与工具测试（不需模拟器）
 *
 * 覆盖：JSON-RPC 协议、25 个工具中的核心路径、错误提示是否可执行。
 * 用的字节是 scripts/make-fixture.mjs 生成的夹具，不是任何游戏的资产。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { createAppEnv, readFixture } from './helpers/app-env.mjs';

const env = createAppEnv({ AndroidFS: { listAiFiles: () => '{"files":[]}' } });
const M = env.window.__APP_MCP;

const rpc = (obj) => M.handle(JSON.stringify(obj));
const call = (name, args) => rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
const payload = (r) => r.result.structuredContent;
const errText = (r) => (r.result.content && r.result.content[0] && r.result.content[0].text) || '';

test('协议：initialize / tools/list / ping / 未知方法', () => {
  assert.ok(M, '应暴露 window.__APP_MCP');

  const init = rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  assert.equal(init.result.serverInfo.name, 'uasset-studio-app');
  assert.ok(init.result.capabilities.tools);

  const list = rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(list.result.tools.length, M.toolNames().length);
  assert.ok(list.result.tools.length >= 20, `工具数应 >= 20，实际 ${list.result.tools.length}`);
  for (const t of list.result.tools) {
    assert.ok(t.description && t.inputSchema, `工具 ${t.name} 缺描述或 schema`);
  }

  assert.deepEqual(rpc({ jsonrpc: '2.0', id: 3, method: 'ping' }).result, {});
  assert.equal(rpc({ jsonrpc: '2.0', id: 4, method: 'nope' }).error.code, -32601);
  assert.equal(M.handle('{bad json').error.code, -32700);
  assert.equal(rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
});

test('资产登记 + 只读工具', () => {
  const ua = readFixture('TestAsset.uasset');
  const ue = readFixture('TestAsset.uexp');
  const sid = M.register('TestAsset.uasset', new Uint8Array(ua), new Uint8Array(ue));
  assert.ok(sid, 'register 应返回 session');

  const st = payload(call('app_status', {}));
  assert.equal(st.assets.length >= 1, true);
  assert.ok(st.assets.some((a) => a.session === sid));

  const info = payload(call('uasset_info', { session: sid }));
  assert.equal(info.tables.exports, 1);
  assert.equal(info.tables.names, 20);
  assert.equal(info.split, true);

  const ex = payload(call('uasset_list_exports', { session: sid }));
  assert.equal(ex.items[0].name, 'Default__TestAsset_C');
  assert.equal(ex.items[0].serialSize, 194);

  assert.equal(payload(call('uasset_get', { session: sid, path: 'Default__TestAsset_C.TestFloat' })).value, 1.5);
  assert.equal(payload(call('uasset_get', { session: sid, path: 'Default__TestAsset_C.TestString' })).value, 'HelloUAsset');

  const q = payload(call('uasset_query', { session: sid, namePattern: 'Test' }));
  assert.ok(q.matched >= 4, `应匹配到多个属性，实际 ${q.matched}`);

  const v = payload(call('uasset_validate', { session: sid }));
  assert.equal(v.total, 1);
  assert.equal(v.ok, 1);
  assert.equal(v.failed, 0);

  const bp = payload(call('uasset_blueprint', { session: sid }));
  assert.equal(bp.defaults.length, 1);
  assert.equal(bp.defaults[0].name, 'Default__TestAsset_C');
  assert.equal(bp.defaults[0].propertyCount, 5);

  const hex = payload(call('uasset_hexdump', { session: sid, export: 0, length: 32 }));
  assert.ok((hex.hex || '').length > 10);

  const srch = payload(call('uasset_search', { session: sid, query: 'Test' }));
  assert.ok(srch.total >= 1);

  const tree = payload(call('uasset_tree', { session: sid, export: 'Default__TestAsset_C' }));
  assert.ok(tree);
});

test('编辑：set / 批量 / dryRun / 回滚 / 快照恢复', () => {
  const sid = M.assets()[0];

  const snap = payload(call('uasset_snapshot', { session: sid, label: 'before' }));
  assert.ok(snap.snapshot);

  const set = payload(call('uasset_set', { session: sid, path: 'Default__TestAsset_C.TestFloat', value: 9.75 }));
  assert.equal(set.after, 9.75);
  assert.equal(payload(call('uasset_get', { session: sid, path: 'Default__TestAsset_C.TestFloat' })).value, 9.75);

  const dry = payload(call('uasset_set_by_query', { session: sid, namePattern: 'TestInt', value: 7, dryRun: true }));
  assert.equal(dry.dryRun, true);
  assert.ok(dry.results.every((r) => r.applied === false), 'dryRun 不应落地');
  assert.equal(payload(call('uasset_get', { session: sid, path: 'Default__TestAsset_C.TestInt' })).value, 42);

  const bt = payload(call('uasset_batch', {
    session: sid,
    ops: [
      { op: 'set', path: 'Default__TestAsset_C.TestInt', value: 99 },
      { op: 'set', path: 'NoSuch.Prop', value: 1 },
    ],
  }));
  assert.equal(bt.committed, false);
  assert.equal(bt.rolledBack, true);
  assert.equal(payload(call('uasset_get', { session: sid, path: 'Default__TestAsset_C.TestInt' })).value, 42,
    '整批回滚后 TestInt 应保持 42');

  const rs = payload(call('uasset_restore', { session: sid }));
  assert.equal(rs.restored, snap.snapshot);
  assert.equal(payload(call('uasset_get', { session: sid, path: 'Default__TestAsset_C.TestFloat' })).value, 1.5,
    '恢复快照后 TestFloat 应回到 1.5');
});

test('导出：save 自检 + base64 往返', () => {
  const sid = M.assets()[0];
  call('uasset_set', { session: sid, path: 'Default__TestAsset_C.TestFloat', value: 3.25 });

  const exp = payload(call('uasset_export_base64', { session: sid }));
  assert.deepEqual(exp.verification.problems, [], '保存自检应无问题');
  assert.ok(exp.uassetBase64.length > 100);
  assert.ok(exp.uexpBase64.length > 100);

  // 拿导出的字节重新登记，确认值真的写进去了
  const sid2 = M.register('copy.uasset',
    new Uint8Array(Buffer.from(exp.uassetBase64, 'base64')),
    new Uint8Array(Buffer.from(exp.uexpBase64, 'base64')));
  assert.equal(payload(call('uasset_get', { session: sid2, path: 'Default__TestAsset_C.TestFloat' })).value, 3.25);

  // 没有目标 URI 时应明确告知怎么拿 URI，而不是假装保存成功
  const save = payload(call('uasset_save', { session: sid }));
  assert.equal(save.saved, false);
  assert.equal(save.pending, true);
  assert.ok(/选择保存位置/.test(save.hint));

  const json = payload(call('uasset_export_json', { session: sid, export: 'Default__TestAsset_C' }));
  assert.ok(Array.isArray(json.properties) || json.exportName);
});

test('错误路径给出可执行的下一步', () => {
  const sid = M.assets()[0];

  const e1 = errText(call('uasset_get', { session: 'nope', path: 'x' }));
  assert.ok(/资产不存在/.test(e1), e1);

  const e2 = errText(call('uasset_get', { session: sid, path: 'Default__TestAsset_C.NoSuchProp' }));
  assert.ok(/属性不存在/.test(e2), e2);

  const e3 = errText(call('unknown_tool', {}));
  assert.ok(/未知工具/.test(e3), e3);

  const e4 = errText(call('uasset_get', { session: sid }));
  assert.ok(/缺少参数: path/.test(e4), e4);

  const e5 = errText(call('uasset_set', { session: sid, path: 'Default__TestAsset_C.TestFloat' }));
  assert.ok(/缺少参数: value/.test(e5), e5);
});
