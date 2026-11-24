/* eslint-disable */
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
function isDebugEnabled() {
    return readFlag("uasset_debug", "debug");
}
function debugLog(message, color) {
    if (isDebugEnabled()) {
        if (color) {
            console.log(`%c${message}`, color);
        } else {
            console.log(message);
        }
    }
}
function debugWarn(message) {
    if (isDebugEnabled()) {
        console.warn(`[DEBUG] ${message}`);
    } else {
    }
}
function debugError(message, ...args) {
    console.error(`[ERROR] ${message}`, ...args);
}
function debugInfo(message) {
    if (isDebugEnabled()) {
        console.log(`[INFO] ${message}`);
    }
}
export { isDebugEnabled, debugLog, debugWarn, debugError, debugInfo };
