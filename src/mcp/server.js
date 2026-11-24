#!/usr/bin/env node
/* eslint-disable */
/**
 * server.js — 零依赖 MCP 服务器（Model Context Protocol）
 *
 * 传输：
 *   stdio（默认）      —— 给 Claude Desktop / Cursor / Roo 等本地 MCP 客户端
 *   HTTP（--http 8787）—— POST /mcp 走 JSON-RPC，GET /health、GET /tools 方便调试
 *
 * 协议：JSON-RPC 2.0，实现 initialize / tools / resources / prompts / ping。
 * 不依赖 @modelcontextprotocol/sdk，任何 Node 18+ 环境（含 Termux）可直接跑。
 */
import readline from 'node:readline';
import http from 'node:http';
import { tools, callTool } from './tools.js';

const SERVER_INFO = { name: 'uasset-studio', version: '2.0.0' };
const PROTOCOL_VERSION = '2024-11-05';

const log = (...a) => process.stderr.write(`[uasset-mcp] ${a.join(' ')}\n`);

/* ------------------------------------------------------------------ 元数据 */
function resourcesList() {
  return { resources: [] };
}

const PROMPTS = [
  {
    name: 'edit-uasset-safely',
    description: '引导 AI 用「读→定位→定长改写→自检→保存」的安全顺序改资产',
    arguments: [{ name: 'goal', description: '要达成的改动，例如「把 AUG 的后坐力改小一半」', required: true }],
  },
];

/* ------------------------------------------------------------------ 分发 */
async function handle(msg) {
  const { id, method, params } = msg || {};
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, message, data) => ({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });

  try {
    switch (method) {
      case 'initialize':
        return reply({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, prompts: {} },
          serverInfo: SERVER_INFO,
          instructions:
            'UE4/UE5 .uasset/.uexp 资产编辑器。先 uasset_open 打开，再用 uasset_help 看路径语法与工作流。' +
            '定长值编辑走字节补丁（安全），变长编辑才重建导出。',
        });
      case 'notifications/initialized':
      case 'initialized':
        return null;
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: tools.map(({ name, description, inputSchema, examples }) => ({ name, description, inputSchema, ...(examples ? { examples } : {}) })) });
      case 'tools/call': {
        const name = params?.name;
        const args = params?.arguments || {};
        try {
          const result = await callTool(name, args);
          const text = JSON.stringify(result);
          return reply({ content: [{ type: 'text', text }], structuredContent: result, isError: false });
        } catch (e) {
          return reply({ content: [{ type: 'text', text: `错误: ${e.message || e}` }], isError: true });
        }
      }
      case 'resources/list':
        return reply(resourcesList());
      case 'resources/read': {
        const uri = params?.uri || '';
        return reply({ contents: [{ uri, mimeType: 'application/json', text: JSON.stringify({ error: '该实现不暴露 resources，请用 tools' }) }] });
      }
      case 'prompts/list':
        return reply({ prompts: PROMPTS.map(({ name, description, arguments: a }) => ({ name, description, arguments: a })) });
      case 'prompts/get': {
        const goal = params?.arguments?.goal || '（未填写目标）';
        return reply({
          description: '安全改资产的步骤',
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text:
                  `目标：${goal}\n\n` +
                  `按这个顺序做，每步失败就停并读错误信息：\n` +
                  `1. uasset_open({uassetPath}) 打开资产\n` +
                  `2. uasset_list_exports({session, filter}) 找目标对象，优先看 Default__ 开头的 CDO\n` +
                  `3. uasset_search({session, query}) 在名称表/字符串里定位关键字段\n` +
                  `4. uasset_tree({session, export, depth:2}) 看结构，uasset_get 确认当前值\n` +
                  `5. uasset_set({session, path, value})：定长值会返回 mode=patch（只改目标字节）\n` +
                  `6. uasset_verify({session}) 预演+自检，再 uasset_save({session})\n` +
                  `注意：变长编辑会重建导出；遇到「未解析原始块」的拒绝提示时，优先改用定长字段，不要盲目 force。`,
              },
            },
          ],
        });
      }
      default:
        if (method && method.startsWith('notifications/')) return null;
        return fail(-32601, `未实现的方法: ${method}`);
    }
  } catch (e) {
    log('handler error', e && e.stack || e);
    return fail(-32603, String(e && e.message || e));
  }
}

/* ------------------------------------------------------------------ 传输 */
function startStdio() {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch (e) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } }) + '\n');
      return;
    }
    const batch = Array.isArray(msg) ? msg : [msg];
    const replies = [];
    for (const m of batch) {
      const r = await handle(m);
      if (r) replies.push(r);
    }
    if (replies.length) process.stdout.write((Array.isArray(msg) ? JSON.stringify(replies) : JSON.stringify(replies[0])) + '\n');
  });
  log('stdio 传输就绪，等待 JSON-RPC 消息（stderr 仅用于日志）');
}

function startHttp(port) {
  const server = http.createServer(async (req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true, ...SERVER_INFO });
    if (req.method === 'GET' && req.url === '/tools') {
      return send(200, { tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
    }
    if (req.method === 'POST' && (req.url === '/mcp' || req.url === '/')) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        let msg;
        try {
          msg = JSON.parse(body);
        } catch {
          return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } });
        }
        const batch = Array.isArray(msg) ? msg : [msg];
        const out = [];
        for (const m of batch) {
          const r = await handle(m);
          if (r) out.push(r);
        }
        if (!out.length) {
          res.writeHead(202).end();
          return;
        }
        send(200, Array.isArray(msg) ? out : out[0]);
      });
      return;
    }
    send(404, { error: 'not found', endpoints: ['POST /mcp', 'GET /health', 'GET /tools'] });
  });
  server.listen(port, '127.0.0.1', () => log(`HTTP 传输: http://127.0.0.1:${port}/mcp`));
  return server;
}

const arg = process.argv.find((a) => a.startsWith('--http'));
if (arg) {
  const port = Number(arg.split('=')[1] || process.argv[process.argv.indexOf(arg) + 1] || 8787);
  startHttp(port);
} else if (process.argv.includes('--list-tools')) {
  console.log(JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description })), null, 2));
} else {
  startStdio();
}
