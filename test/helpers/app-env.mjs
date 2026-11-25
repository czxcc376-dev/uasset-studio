/**
 * app-env.mjs — 在 Node 里模拟 WebView 环境
 *
 * 目的：App 内的 MCP 与设置面板逻辑都是跑在 WebView 里的普通 JS，
 * 用一个足够像的 DOM stub + 假的原生桥，就能在没有模拟器的情况下验证：
 *   - JSON-RPC 协议处理（initialize / tools/list / tools/call）
 *   - 25 个工具的实际行为（真实资产字节）
 *   - 设置面板的接线（开关/端口/复制配置/文件授权）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../..');

function mkStyle() {
  const t = {};
  return new Proxy(t, {
    get(o, k) {
      if (k === 'setProperty') return (n, v) => { o[n] = v; };
      if (k === 'removeProperty') return (n) => { delete o[n]; };
      if (k === 'getPropertyValue') return (n) => o[n] || '';
      return o[k];
    },
    set(o, k, v) { o[k] = v; return true; },
  });
}

function el(id = '') {
  const node = {
    id, style: mkStyle(), dataset: {}, textContent: '', value: '', checked: false, className: '',
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    _handlers: {},
    addEventListener(t, f) { this._handlers[t] = f; },
    removeEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); },
    _text() {
      // 真实浏览器里 textContent 与 innerHTML 是互斥的两种写法，这里合并取
      const own = (this.textContent || '') + ' ' + (this.innerHTML || '');
      const kids = this.children.map((c) => (c._text ? c._text() : (c.textContent || ''))).join(' ');
      return (own + ' ' + kids).trim();
    },
    querySelector() { return el(); }, querySelectorAll() { return []; },
    getContext() { return null; }, setAttribute() {}, getAttribute() { return null; },
    focus() {}, blur() {}, click() { if (this.onclick) this.onclick(); },
    insertBefore() {}, replaceChildren() {}, remove() {},
    children: [], childNodes: [], parentNode: null,
    offsetWidth: 100, offsetHeight: 100, scrollTop: 0, scrollHeight: 0, clientHeight: 600,
  };
  return new Proxy(node, {
    get(t, k) { if (k in t) return t[k]; return undefined; },
    set(t, k, v) { t[k] = v; return true; },
  });
}

function withHtml(node) {
  let html = '';
  Object.defineProperty(node, 'innerHTML', {
    get() { return html; },
    set(v) { html = v; node.children.length = 0; },
    configurable: true,
  });
  return node;
}

export function createAppEnv({ AndroidMCP, AndroidFS, loadBundle = true } = {}) {
  const nodes = new Map();
  const getEl = (id) => {
    if (!nodes.has(id)) nodes.set(id, withHtml(el(id)));
    return nodes.get(id);
  };

  const doc = {
    getElementById: getEl,
    querySelector: () => withHtml(el()),
    querySelectorAll: () => [],
    createElement: () => withHtml(el()),
    createTextNode: () => el(),
    createDocumentFragment: () => withHtml(el()),
    addEventListener() {}, removeEventListener() {},
    body: withHtml(el()), documentElement: withHtml(el()), head: withHtml(el()),
    readyState: 'complete',
  };

  const storage = new Map();
  const g = globalThis;
  g.document = doc;
  g.window = g;
  g.addEventListener = () => {};
  g.removeEventListener = () => {};
  g.localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  };
  g.navigator = { userAgent: 'node-webview-stub' };
  g.location = { search: '', href: 'file:///android_asset/index.html', pathname: '/index.html' };
  g.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  g.alert = () => {};
  g.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
  g.atob = (s) => Buffer.from(s, 'base64').toString('binary');
  g.Blob = class {};
  g.FileReader = class { readAsArrayBuffer() {} readAsText() {} };
  g.CustomEvent = class { constructor(t, i) { this.type = t; Object.assign(this, i); } };
  g.getComputedStyle = () => ({ getPropertyValue: () => '' });
  // 显式覆盖/清除，避免同一进程里前后两个用例互相污染
  if (AndroidMCP) g.AndroidMCP = AndroidMCP;
  else delete g.AndroidMCP;
  if (AndroidFS) g.AndroidFS = AndroidFS;
  else delete g.AndroidFS;

  if (loadBundle) {
    const bundle = fs.readFileSync(path.join(ROOT, 'web/app.js'), 'utf8');
    new Function(bundle)();
  }

  return { window: g, document: doc, getEl, nodes };
}

export function readFixture(name) {
  return fs.readFileSync(path.join(ROOT, 'test/fixtures', name));
}

export const ROOT_DIR = ROOT;
