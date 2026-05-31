/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║     نظام البصمة الرقمية الدائمة - fingerprint.js        ║
 * ║  يُولِّد هوية فريدة ثابتة لكل جهاز مهما تغيّر الـ IP   ║
 * ╚══════════════════════════════════════════════════════════╝
 */
(function(global) {
  'use strict';

  // ── Hash Function (FNV-1a 32bit) ──────────────────────────────────────────
  function hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  function combineHashes(parts) {
    return 'fp_' + hash(parts.filter(Boolean).join('|'));
  }

  // ── Layer 1: Canvas Fingerprint ───────────────────────────────────────────
  function getCanvasFingerprint() {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 200; canvas.height = 50;
      const ctx = canvas.getContext('2d');
      ctx.textBaseline = 'top';
      ctx.font = '14px Arial';
      ctx.fillStyle = '#f60';
      ctx.fillRect(125, 1, 62, 20);
      ctx.fillStyle = '#069';
      ctx.fillText('BrowserFP 🔒', 2, 15);
      ctx.fillStyle = 'rgba(102,204,0,0.7)';
      ctx.fillText('BrowserFP 🔒', 4, 17);
      return hash(canvas.toDataURL());
    } catch(e) { return '00000000'; }
  }

  // ── Layer 2: WebGL Fingerprint ────────────────────────────────────────────
  function getWebGLFingerprint() {
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (!gl) return '00000000';
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const vendor   = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)   : gl.getParameter(gl.VENDOR);
      const renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      const params = [
        gl.getParameter(gl.MAX_TEXTURE_SIZE),
        gl.getParameter(gl.MAX_VERTEX_ATTRIBS),
        gl.getParameter(gl.MAX_VARYING_VECTORS),
        gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS),
        gl.getParameter(gl.ALIASED_LINE_WIDTH_RANGE),
        gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)
      ].join(',');
      return hash(vendor + renderer + params);
    } catch(e) { return '00000000'; }
  }

  // ── Layer 3: AudioContext Fingerprint ─────────────────────────────────────
  function getAudioFingerprint(callback) {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) { callback('00000000'); return; }
      const ctx = new AudioCtx();
      const oscillator = ctx.createOscillator();
      const analyser   = ctx.createAnalyser();
      const gain       = ctx.createGain();
      const scriptProcessor = ctx.createScriptProcessor(4096, 1, 1);

      gain.gain.value = 0;
      oscillator.type = 'triangle';
      oscillator.frequency.value = 10000;
      oscillator.connect(analyser);
      analyser.connect(scriptProcessor);
      scriptProcessor.connect(gain);
      gain.connect(ctx.destination);

      scriptProcessor.onaudioprocess = function(e) {
        const data = e.inputBuffer.getChannelData(0);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += Math.abs(data[i]);
        oscillator.disconnect(); analyser.disconnect();
        scriptProcessor.disconnect(); gain.disconnect();
        try { ctx.close(); } catch(e){}
        callback(hash(sum.toString()));
      };

      oscillator.start(0);
      setTimeout(function() { try { oscillator.stop(); } catch(e){} callback('00000000'); }, 500);
    } catch(e) { callback('00000000'); }
  }

  // ── Layer 4: Font Detection ───────────────────────────────────────────────
  function getFontFingerprint() {
    const baseFonts = ['monospace', 'sans-serif', 'serif'];
    const testFonts = [
      'Arial', 'Arial Black', 'Comic Sans MS', 'Courier New', 'Georgia',
      'Impact', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Helvetica',
      'Palatino', 'Garamond', 'Bookman', 'Tahoma', 'Lucida Console',
      'Lucida Sans Unicode', 'MS Sans Serif', 'MS Serif', 'Symbol',
      'Wingdings', 'Calibri', 'Cambria', 'Candara', 'Consolas',
      'Constantia', 'Corbel', 'Franklin Gothic Medium', 'Segoe UI',
      'Gill Sans MT', 'Century Gothic', 'Futura', 'Optima', 'Geneva',
      'Monaco', 'Menlo', 'Andale Mono', 'Courier', 'Osaka'
    ];
    const testStr = 'mmmmmmmmmmlli';
    const testSize = '72px';
    const span = document.createElement('span');
    span.style.cssText = `position:absolute;left:-9999px;fontSize:${testSize};fontStyle:normal;fontWeight:normal;letterSpacing:normal;lineBreak:auto;lineHeight:normal;textTransform:none;textAlign:left;textDecoration:none;textShadow:none;whiteSpace:normal;wordBreak:normal;wordSpacing:normal`;
    span.textContent = testStr;
    document.body.appendChild(span);

    const baseSizes = {};
    baseFonts.forEach(f => { span.style.fontFamily = f; baseSizes[f] = { w: span.offsetWidth, h: span.offsetHeight }; });

    const detected = [];
    testFonts.forEach(font => {
      let found = false;
      for (const base of baseFonts) {
        span.style.fontFamily = `'${font}',${base}`;
        if (span.offsetWidth !== baseSizes[base].w || span.offsetHeight !== baseSizes[base].h) { found = true; break; }
      }
      if (found) detected.push(font);
    });

    document.body.removeChild(span);
    return hash(detected.join(','));
  }

  // ── Layer 5: Screen & Hardware ────────────────────────────────────────────
  function getHardwareFingerprint() {
    const data = [
      screen.width, screen.height, screen.colorDepth,
      screen.pixelDepth, window.devicePixelRatio || 1,
      navigator.hardwareConcurrency || 0,
      navigator.deviceMemory || 0,
      navigator.maxTouchPoints || 0,
      window.screen.availWidth, window.screen.availHeight
    ].join(',');
    return hash(data);
  }

  // ── Layer 6: Browser & Platform ───────────────────────────────────────────
  function getBrowserFingerprint() {
    const data = [
      navigator.platform,
      navigator.language,
      navigator.languages ? navigator.languages.join(',') : '',
      navigator.cookieEnabled,
      navigator.doNotTrack || '',
      Intl.DateTimeFormat().resolvedOptions().timeZone,
      typeof window.indexedDB !== 'undefined',
      typeof window.openDatabase !== 'undefined',
      typeof window.sessionStorage !== 'undefined',
      typeof window.localStorage !== 'undefined',
      typeof window.Worker !== 'undefined',
      typeof window.WebSocket !== 'undefined',
      typeof window.RTCPeerConnection !== 'undefined',
      navigator.vendor || '',
      navigator.product || '',
      window.chrome ? 'chrome' : '',
      navigator.connection ? navigator.connection.effectiveType || '' : ''
    ].join('|');
    return hash(data);
  }

  // ── Layer 7: CSS Media Fingerprint ────────────────────────────────────────
  function getCSSFingerprint() {
    const queries = [
      '(prefers-color-scheme: dark)',
      '(prefers-color-scheme: light)',
      '(prefers-reduced-motion: reduce)',
      '(pointer: coarse)',
      '(pointer: fine)',
      '(hover: hover)',
      '(display-mode: standalone)',
      '(-webkit-min-device-pixel-ratio: 2)',
      '(min-resolution: 2dppx)'
    ];
    const results = queries.map(q => window.matchMedia(q).matches ? '1' : '0').join('');
    return hash(results);
  }

  // ── Layer 8: localStorage Persistent Token ────────────────────────────────
  function getStorageToken() {
    const KEY = '__vid_fp__';
    try {
      let token = localStorage.getItem(KEY);
      if (!token) {
        token = 'ls_' + Math.random().toString(36).substr(2, 12) + Date.now().toString(36);
        localStorage.setItem(KEY, token);
      }
      return hash(token);
    } catch(e) { return '00000000'; }
  }

  // ── Layer 9: IndexedDB Persistent Token ──────────────────────────────────
  function getIDBToken(callback) {
    const KEY = '__vid_idb__';
    try {
      const req = indexedDB.open('_fpdb', 1);
      req.onupgradeneeded = function(e) {
        e.target.result.createObjectStore('fp', { keyPath: 'id' });
      };
      req.onsuccess = function(e) {
        const db = e.target.result;
        const tx = db.transaction('fp', 'readwrite');
        const store = tx.objectStore('fp');
        const get = store.get(KEY);
        get.onsuccess = function() {
          if (get.result) { callback(hash(get.result.val)); return; }
          const val = 'idb_' + Math.random().toString(36).substr(2, 12) + Date.now().toString(36);
          store.put({ id: KEY, val });
          callback(hash(val));
        };
        get.onerror = function() { callback('00000000'); };
      };
      req.onerror = function() { callback('00000000'); };
    } catch(e) { callback('00000000'); }
  }

  // ── Layer 10: WebRTC Local IP (non-VPN detection) ─────────────────────────
  function getWebRTCFingerprint(callback) {
    try {
      const RTCPeer = window.RTCPeerConnection || window.webkitRTCPeerConnection || window.mozRTCPeerConnection;
      if (!RTCPeer) { callback('00000000'); return; }
      const pc = new RTCPeer({ iceServers: [] });
      pc.createDataChannel('');
      pc.createOffer().then(o => pc.setLocalDescription(o));
      const ips = new Set();
      pc.onicecandidate = function(e) {
        if (!e.candidate) {
          pc.close();
          callback(hash([...ips].sort().join(',')));
          return;
        }
        const m = e.candidate.candidate.match(/(\d+\.\d+\.\d+\.\d+)/);
        if (m) ips.add(m[1]);
      };
      setTimeout(function() { try { pc.close(); } catch(e){} callback(hash([...ips].sort().join(','))); }, 1000);
    } catch(e) { callback('00000000'); }
  }

  // ── Main: Collect All Layers ──────────────────────────────────────────────
  function collect(callback) {
    const layers = {
      canvas:   getCanvasFingerprint(),
      webgl:    getWebGLFingerprint(),
      hardware: getHardwareFingerprint(),
      browser:  getBrowserFingerprint(),
      css:      getCSSFingerprint(),
      storage:  getStorageToken(),
      fonts:    '00000000' // will be filled
    };

    // Font detection (needs DOM ready)
    if (document.body) {
      layers.fonts = getFontFingerprint();
    }

    // Async layers
    let pending = 3;
    function done() { if (--pending === 0) finish(); }

    getAudioFingerprint(function(v) { layers.audio = v; done(); });
    getIDBToken(function(v) { layers.idb = v; done(); });
    getWebRTCFingerprint(function(v) { layers.webrtc = v; done(); });

    function finish() {
      // Primary fingerprint (most stable layers)
      const primary = combineHashes([
        layers.canvas, layers.webgl, layers.hardware,
        layers.browser, layers.audio, layers.fonts
      ]);

      // Extended fingerprint (all layers)
      const extended = combineHashes([
        layers.canvas, layers.webgl, layers.hardware,
        layers.browser, layers.audio, layers.fonts,
        layers.css, layers.storage, layers.idb, layers.webrtc
      ]);

      // Confidence score (how many layers matched)
      const confidence = Object.values(layers).filter(v => v !== '00000000').length;

      callback({
        primary,      // الهوية الأساسية (ثابتة جداً)
        extended,     // الهوية الموسعة (أكثر دقة)
        layers,       // تفاصيل كل طبقة
        confidence,   // عدد الطبقات الناجحة (من 10)
        timestamp: new Date().toISOString()
      });
    }
  }

  // ── Export ────────────────────────────────────────────────────────────────
  global.DeviceFingerprint = { collect };

})(window);
