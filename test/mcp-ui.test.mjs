/**
 * mcp-ui.test.mjs — 设置面板里「MCP 服务」这块的接线测试
 *
 * 验证的是真实交互：开关 → 调原生 start；改端口 → 自动重启；非法端口 → 拒绝并弹回开关；
 * 复制配置 → 输出合法的 MCP 客户端 JSON；文件授权列表 → 渲染与移除。
 * 不需要模拟器：用一个假的原生桥（AndroidMCP / AndroidFS）驱动。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { createAppEnv } from './helpers/app-env.mjs';

function makeNative() {
  const state = { running: false, port: 0, lan: false, copied: '', picked: 0, saveTarget: 0 };
  const files = [
    { id: 'f1', name: 'BP_Rifle_AUG.uasset', uri: 'content://x/1', isUasset: true },
    { id: 'f2', name: 'BP_Rifle_AUG.uexp', uri: 'content://x/2', isUexp: true },
  ];
  const endpoint = () => `http://127.0.0.1:${state.port || 8787}/mcp`;

  const AndroidMCP = {
    start(port, lan) {
      state.running = true;
      state.port = port;
      state.lan = lan;
      return JSON.stringify({
        running: true, port, lan,
        endpoint: endpoint(),
        lanEndpoint: lan ? `http://192.168.1.9:${port}/mcp` : null,
      });
    },
    stop() { state.running = false; return '{"running":false}'; },
    status() {
      return JSON.stringify({
        running: state.running, port: state.port || 8787, lan: state.lan,
        endpoint: endpoint(),
        lanEndpoint: state.lan ? `http://192.168.1.9:${state.port}/mcp` : null,
      });
    },
    copy(t) { state.copied = t; },
    toolsJson() { return '{"tools":[]}'; },
  };

  const AndroidFS = {
    listAiFiles() { return JSON.stringify({ files, count: files.length }); },
    readBase64() { return JSON.stringify({ ok: false, error: 'not used' }); },
    displayName(u) { return u; },
    writeBase64() { return JSON.stringify({ ok: true, data: 'written' }); },
    pickForAi() { state.picked++; },
    forgetAiFile(uri) {
      const i = files.findIndex((f) => f.uri === uri);
      if (i >= 0) files.splice(i, 1);
      return '{"ok":true}';
    },
    pickSaveTarget() { state.saveTarget++; },
  };

  return { state, files, AndroidMCP, AndroidFS };
}

test('设置面板：开关 / 端口 / 局域网 / 复制配置 / 文件授权', () => {
  const { state, AndroidMCP, AndroidFS } = makeNative();
  const env = createAppEnv({ AndroidMCP, AndroidFS });
  const $ = (id) => env.getEl(id);

  const enable = $('mcpEnable');
  assert.equal(typeof enable.onchange, 'function', '面板应已接线');
  assert.ok(/未启动/.test($('mcpStatus')._text()), '初始应显示未启动');

  // 打开
  enable.checked = true;
  enable.onchange();
  assert.equal(state.running, true);
  assert.equal(state.port, 8787);
  assert.equal(state.lan, false);
  assert.ok($('mcpStatus').className.includes('on'));
  assert.ok(/127\.0\.0\.1:8787/.test($('mcpStatus')._text()), $('mcpStatus')._text());

  // 改端口 → 自动重启
  const port = $('mcpPort');
  port.value = '9001';
  port.onchange();
  assert.equal(state.running, true);
  assert.equal(state.port, 9001);

  // 局域网
  const lan = $('mcpLan');
  lan.checked = true;
  lan.onchange();
  assert.equal(state.lan, true);
  assert.ok(/192\.168\.1\.9:9001/.test($('mcpStatus')._text()), $('mcpStatus')._text());

  // 非法端口 → 拒绝并弹回
  port.value = '80';
  port.onchange();
  assert.ok(/1024~65535/.test($('mcpStatus')._text()));
  assert.equal(enable.checked, false);

  // 恢复
  port.value = '8787';
  enable.checked = true;
  enable.onchange();

  // 复制客户端配置
  $('mcpCopyConfig').onclick();
  const cfg = JSON.parse(state.copied);
  assert.equal(cfg.mcpServers['uasset-studio-app'].url, 'http://127.0.0.1:8787/mcp');
  assert.equal(cfg.mcpServers['uasset-studio-app'].type, 'http');

  // 文件授权列表
  const filesBox = $('mcpFiles');
  assert.equal(filesBox.children.length, 2, `应渲染 2 个授权文件，实际 ${filesBox.children.length}`);

  $('mcpAddFiles').onclick();
  assert.equal(state.picked, 1, '应打开文件选择器');

  $('mcpSaveTarget').onclick();
  assert.equal(state.saveTarget, 1, '应打开保存位置选择器');

  // 原生回调
  env.window.__onAiFilesChanged(JSON.stringify({ files: [AndroidFS.listAiFiles.call(null) && { id: 'f1', name: 'A.uasset', uri: 'content://x/1' }] }));
  assert.equal(filesBox.children.length, 1, '回调后列表应变 1 项');

  env.window.__onSaveTargetChosen('content://save/1');
  assert.equal(env.window.__lastSaveTarget, 'content://save/1');

  // 关闭
  enable.checked = false;
  enable.onchange();
  assert.equal(state.running, false);
});

test('非 App 环境：面板提示改用 Node 版，不假装可用', () => {
  const env = createAppEnv({});   // 不给原生桥
  const status = env.getEl('mcpStatus');
  assert.ok(/不支持内嵌 MCP/.test(status._text()), status._text());
  // 打开开关不应抛错
  const enable = env.getEl('mcpEnable');
  enable.checked = true;
  enable.onchange();
  assert.ok(/不支持内嵌 MCP/.test(status._text()));
});
