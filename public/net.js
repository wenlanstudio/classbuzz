'use strict';
// 共享客户端库：WS 封装（心跳 / 断线重连 / 恢复）+ 小工具。
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

class Buzz {
  constructor(opts = {}) {
    this.handlers = {};
    this.onOpen = opts.onOpen || (() => {});
    this.onStatus = opts.onStatus || (() => {});
    this._retry = 0;
    this._hb = null;
    this._lastIn = Date.now();
    this._closed = false;
    this._ws = null;
  }

  on(type, fn) {
    (this.handlers[type] = this.handlers[type] || []).push(fn);
    return this;
  }

  connect() {
    // 页面走 https（natapp/云部署常见）时用 wss://，否则浏览器会因混合内容拦截而连不上
    const wsScheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this._ws = new WebSocket(`${wsScheme}//${location.host}/`);
    this._ws.onopen = () => {
      this._retry = 0;
      this._lastIn = Date.now();
      this.onStatus('online');
      clearInterval(this._hb);
      // 应用层心跳保活；长时间无任何下行视为死链，主动断开触发重连
      this._hb = setInterval(() => {
        this.send({ type: 'ping' });
        if (Date.now() - this._lastIn > 45000) {
          try { this._ws.close(); } catch {}
        }
      }, 15000);
      this.onOpen();
    };
    this._ws.onmessage = ev => {
      this._lastIn = Date.now();
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      for (const fn of this.handlers[msg.type] || []) fn(msg);
    };
    this._ws.onclose = () => {
      clearInterval(this._hb);
      this.onStatus('offline');
      if (this._closed) return;
      const delay = Math.min(5000, 1000 * Math.pow(2, this._retry++));
      setTimeout(() => this.connect(), delay);
    };
    this._ws.onerror = () => {};
  }

  send(obj) {
    if (this._ws && this._ws.readyState === 1) this._ws.send(JSON.stringify(obj));
  }

  close() {
    this._closed = true;
    try { this._ws && this._ws.close(); } catch {}
  }
}

let _toastTimer = null;
function toast(text, ms = 2600) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}
