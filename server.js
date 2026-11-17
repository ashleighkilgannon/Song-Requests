'use strict';
// Song request server. No dependencies; needs Node 18 or newer.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

let PIN = process.env.STAGE_PIN;
if (!PIN) {
  PIN = String(crypto.randomInt(1000, 10000));
  console.log(`STAGE_PIN is not set. Using the temporary PIN ${PIN} until this server restarts.`);
}

// ---------- state ----------
let state = { title: 'Request a song', open: true, songs: [], queue: [], setlist: [], current: null };
function applySaved(saved) {
  if (!saved || typeof saved !== 'object') return;
  if (typeof saved.title === 'string') state.title = saved.title;
  if (typeof saved.open === 'boolean') state.open = saved.open;
  if (Array.isArray(saved.songs)) state.songs = saved.songs;
  if (Array.isArray(saved.queue)) state.queue = saved.queue;
  if (Array.isArray(saved.setlist)) state.setlist = saved.setlist.filter(x => typeof x === 'string');
  if (typeof saved.current === 'string') state.current = saved.current;
}
try { applySaved(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); } catch (_) { /* first run, or a host with no saved file */ }

// Optional lasting storage. Free hosts wipe their disk on every restart, so set these two
// variables (from a free Upstash Redis database) and the data is kept there instead.
const REDIS_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const REDIS_KEY = 'songrequest:state';
const useRedis = !!(REDIS_URL && REDIS_TOKEN);
let redisWritable = false;

async function redis(cmd) {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify(cmd),
    signal: AbortSignal.timeout(8000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || 'HTTP ' + r.status);
  return j.result;
}

async function loadRedis() {
  for (let i = 1; i <= 4; i++) {
    try {
      const v = await redis(['GET', REDIS_KEY]);
      if (v) applySaved(JSON.parse(v));
      redisWritable = true; // only write once a read has worked, so a failed read can never wipe saved data
      console.log(v ? 'Loaded saved songs from Upstash.' : 'Upstash is connected and empty.');
      return;
    } catch (e) {
      console.log('Could not read Upstash (try ' + i + '): ' + e.message);
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  console.log('Upstash is not reachable. Running without lasting storage until the next restart.');
}

let saveTimer = null;
let redisWarned = false;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const json = JSON.stringify(state);
    fs.writeFile(DATA_FILE, json, () => {});
    if (useRedis && redisWritable) {
      if (json.length > 900000) { if (!redisWarned) console.log('Data is too large for Upstash (about 1 MB limit).'); redisWarned = true; return; }
      redis(['SET', REDIS_KEY, json]).catch(e => console.log('Could not save to Upstash: ' + e.message));
    }
  }, 500);
}

const str = (v, n) => String(v == null ? '' : v).slice(0, n);

function cleanSong(s) {
  s = s || {};
  return {
    id: /^[\w-]{1,40}$/.test(s.id || '') ? s.id : crypto.randomUUID(),
    title: str(s.title, 120).trim(),
    artist: str(s.artist, 120).trim(),
    key: str(s.key, 10).trim(),
    speed: Math.min(60, Math.max(4, Math.round(Number(s.speed)) || 14)),
    // Tempo scrolling: bpm 0 means off. One lyric line lasts beats x bars beats.
    bpm: Number(s.bpm) >= 30 ? Math.min(300, Math.round(Number(s.bpm))) : 0,
    beats: Math.min(12, Math.max(1, Math.round(Number(s.beats)) || 4)),
    bars: Math.min(16, Math.max(0.5, Math.round((Number(s.bars) || 2) * 2) / 2)),
    text: str(s.text, 30000).replace(/\r\n?/g, '\n'),
  };
}

function publicView() {
  const cur = state.songs.find(s => s.id === state.current);
  return {
    title: state.title,
    open: state.open,
    now: cur ? { title: cur.title, artist: cur.artist } : null,
    songs: state.songs.map(s => ({ id: s.id, title: s.title, artist: s.artist })),
    queued: state.queue.map(q => q.songId),
    planned: state.setlist,
  };
}

function stageView() {
  return { ...state, queue: state.queue.map(({ cids, ...q }) => q) };
}

function cleanLists() {
  const ids = new Set(state.songs.map(s => s.id));
  state.queue = state.queue.filter(q => ids.has(q.songId));
  const seen = new Set();
  state.setlist = state.setlist.filter(id => ids.has(id) && !seen.has(id) && seen.add(id));
  if (state.current && !ids.has(state.current)) state.current = null;
}

// Playing a song takes it out of the queue and the setlist so it is not played twice.
function startSong(id) {
  state.current = id;
  state.queue = state.queue.filter(q => q.songId !== id);
  state.setlist = state.setlist.filter(x => x !== id);
}

// ---------- live updates (server-sent events) ----------
const pubClients = new Set();
const stageClients = new Set();

function openStream(req, res, set, first) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  res.write(`data: ${JSON.stringify(first)}\n\n`);
  set.add(res);
  req.on('close', () => set.delete(res));
}

function broadcast() {
  const p = `data: ${JSON.stringify(publicView())}\n\n`;
  for (const r of pubClients) r.write(p);
  const s = `data: ${JSON.stringify(stageView())}\n\n`;
  for (const r of stageClients) r.write(s);
  save();
}

setInterval(() => {
  for (const r of pubClients) r.write(': ping\n\n');
  for (const r of stageClients) r.write(': ping\n\n');
}, 20000).unref();

// ---------- helpers ----------
function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '');
  return xf.split(',').pop().trim() || req.socket.remoteAddress || 'unknown';
}

const failures = new Map();
function pinOk(req, url) {
  const ip = clientIp(req);
  const now = Date.now();
  const f = failures.get(ip);
  if (f && f.n >= 10 && now - f.t < 10 * 60 * 1000) return false;
  const given = String(req.headers['x-stage-pin'] || url.searchParams.get('pin') || '');
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(PIN).digest();
  const ok = crypto.timingSafeEqual(a, b);
  if (ok) failures.delete(ip);
  else failures.set(ip, { n: (f && now - f.t < 10 * 60 * 1000 ? f.n : 0) + 1, t: now });
  return ok;
}

function readBody(req, max = 1000000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > max) {
        reject(Object.assign(new Error('That is too large.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (_) {
        reject(Object.assign(new Error('Bad request.'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(res, p) {
  if (p === '/') p = '/audience.html';
  else if (p === '/stage') p = '/stage.html';
  let file;
  try { file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(p))); } catch (_) { file = ''; }
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(buf);
  });
}

// ---------- audience requests ----------
const lastByClient = new Map();
const countByIp = new Map();
setInterval(() => {
  const cut = Date.now() - 60000;
  for (const [k, v] of lastByClient) if (v < cut) lastByClient.delete(k);
  for (const [k, v] of countByIp) if (v.t < cut) countByIp.delete(k);
}, 60000).unref();

function handleRequest(req, res, b) {
  if (!state.open) return send(res, 403, { error: 'Requests are closed right now.' });
  const ip = clientIp(req);
  const now = Date.now();
  const cid = /^[\w-]{8,64}$/.test(b.cid || '') ? b.cid : ip;

  const ipc = countByIp.get(ip);
  if (ipc && now - ipc.t < 60000 && ipc.n >= 40) return send(res, 429, { error: 'Too many requests. Wait a moment.' });
  if (now - (lastByClient.get(cid) || 0) < 6000) return send(res, 429, { error: 'Easy there. Wait a few seconds and try again.' });

  const song = state.songs.find(s => s.id === b.songId);
  if (!song) return send(res, 404, { error: 'That song is not on the list.' });

  const name = str(b.name, 40).replace(/[\u0000-\u001f]/g, '').trim();
  let item = state.queue.find(q => q.songId === song.id);
  if (item) {
    item.cids = item.cids || [];
    if (item.cids.includes(cid)) return send(res, 409, { error: 'You already requested this one.' });
    item.count += 1;
    if (item.cids.length < 300) item.cids.push(cid);
    if (name && !item.names.includes(name) && item.names.length < 5) item.names.push(name);
  } else {
    if (state.queue.length >= 100) return send(res, 429, { error: 'The queue is full. Try again soon.' });
    state.queue.push({ id: crypto.randomUUID(), songId: song.id, count: 1, names: name ? [name] : [], at: now, cids: [cid] });
  }
  lastByClient.set(cid, now);
  countByIp.set(ip, { n: (ipc && now - ipc.t < 60000 ? ipc.n : 0) + 1, t: ipc && now - ipc.t < 60000 ? ipc.t : now });
  broadcast();
  send(res, 200, { ok: true });
}

// ---------- performer actions ----------
function handleStage(res, p, b) {
  const ok = () => { broadcast(); send(res, 200, { ok: true, state: stageView() }); };
  switch (p) {
    case '/api/stage/check':
      return send(res, 200, { ok: true, state: stageView() });

    case '/api/stage/song': {
      const s = cleanSong(b.song);
      if (!s.title) return send(res, 400, { error: 'A song needs a title.' });
      const i = state.songs.findIndex(x => x.id === s.id);
      if (i >= 0) state.songs[i] = s;
      else if (state.songs.length >= 500) return send(res, 400, { error: 'That is the limit of 500 songs.' });
      else state.songs.push(s);
      return ok();
    }

    case '/api/stage/song/delete':
      state.songs = state.songs.filter(s => s.id !== b.id);
      cleanLists();
      return ok();

    case '/api/stage/import': {
      const incoming = (Array.isArray(b.songs) ? b.songs : []).slice(0, 500).map(cleanSong).filter(s => s.title);
      if (b.mode === 'replace') {
        state.songs = incoming;
      } else {
        for (const s of incoming) {
          const i = state.songs.findIndex(x => x.id === s.id);
          if (i >= 0) state.songs[i] = s;
          else if (state.songs.length < 500) state.songs.push(s);
        }
      }
      cleanLists();
      return ok();
    }

    case '/api/stage/play': {
      let songId = b.songId;
      if (b.queueId) {
        const q = state.queue.find(x => x.id === b.queueId);
        if (!q) return send(res, 404, { error: 'That request is already gone.' });
        songId = q.songId;
        state.queue = state.queue.filter(x => x.id !== b.queueId);
      }
      if (!state.songs.some(s => s.id === songId)) return send(res, 404, { error: 'Song not found.' });
      startSong(songId);
      return ok();
    }

    case '/api/stage/next': {
      // Requests play first, then the setlist in order.
      const nextId = state.queue.length ? state.queue[0].songId : state.setlist[0];
      if (!nextId) return send(res, 409, { error: 'Nothing is queued and the setlist is empty.' });
      startSong(nextId);
      return ok();
    }

    case '/api/stage/current':
      if (state.songs.some(s => s.id === b.songId)) startSong(b.songId);
      else state.current = null;
      return ok();

    case '/api/stage/setlist/add': {
      if (!state.songs.some(s => s.id === b.songId)) return send(res, 404, { error: 'Song not found.' });
      if (!state.setlist.includes(b.songId)) state.setlist.push(b.songId);
      return ok();
    }

    case '/api/stage/setlist/remove':
      state.setlist = state.setlist.filter(id => id !== b.songId);
      return ok();

    case '/api/stage/setlist/move': {
      const i = state.setlist.indexOf(b.songId);
      const j = i + (b.dir === 'up' ? -1 : 1);
      if (i < 0 || j < 0 || j >= state.setlist.length) return ok();
      [state.setlist[i], state.setlist[j]] = [state.setlist[j], state.setlist[i]];
      return ok();
    }

    case '/api/stage/setlist/clear':
      state.setlist = [];
      return ok();

    case '/api/stage/remove':
      state.queue = state.queue.filter(q => q.id !== b.queueId);
      return ok();

    case '/api/stage/clear':
      state.queue = [];
      return ok();

    case '/api/stage/settings':
      if (typeof b.title === 'string') state.title = str(b.title, 60).trim() || 'Request a song';
      if (typeof b.open === 'boolean') state.open = b.open;
      return ok();

    default:
      return send(res, 404, { error: 'Not found.' });
  }
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (req.method === 'GET' && p === '/healthz') return send(res, 200, { ok: true, storage: useRedis ? (redisWritable ? 'upstash' : 'upstash-unreachable') : 'disk' });
    if (req.method === 'GET' && p === '/api/public') return send(res, 200, publicView());
    if (req.method === 'GET' && p === '/events') return openStream(req, res, pubClients, publicView());

    if (req.method === 'GET' && p === '/stage-events') {
      if (!pinOk(req, url)) return send(res, 401, { error: 'Wrong PIN.' });
      return openStream(req, res, stageClients, stageView());
    }

    if (req.method === 'POST' && p === '/api/request') {
      return handleRequest(req, res, await readBody(req, 5000));
    }

    if (req.method === 'POST' && p.startsWith('/api/stage/')) {
      if (!pinOk(req, url)) return send(res, 401, { error: 'Wrong PIN.' });
      return handleStage(res, p, await readBody(req));
    }

    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(res, p);
    send(res, 405, { error: 'Not allowed.' });
  } catch (e) {
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Server error.' });
  }
});

(async () => {
  if (useRedis) await loadRedis();
  server.listen(PORT, () => console.log(`Song requests running on port ${PORT}`));
})();
