// Fake Daoliyu (道理鱼) server for integration-testing the negative-screen music page
// before the real server address is available. No dependencies.
//   node tools/fake-daoliyu.js [port]
// Endpoints mirror the real API family (verified against daoliyu.cchong.cc v1.0.5):
//   POST /api/auth/login            {email,username,password} -> {token,user}
//   GET  /api/playlists/web/mine    -> [ {id,name,trackCount,coverArtPath,coverArtUrl} ]
//   GET  /api/playlists/{id}/tracks -> {items:[{order,track}],total}
//   GET  /api/cover?path=&size=     -> SVG cover (needs Authorization, like the real server)
//   GET  /api/tracks/{id}/stream    -> audio (checks ?token=)
//   GET  /api/tracks/{id}/transcode -> audio (real server transcodes FLAC to mp3; here we have
//           no encoder, so we hand back WAV — the player decodes it fine)
const http = require('http');
const PORT = Number(process.argv[2] || 8099);
const TOKEN = 'tok-test-123';

const PLAYLISTS = [
  { id: 'pl-1', name: '夜里常放的几张', trackCount: 3, coverArtPath: '/covers/night', coverArtUrl: '/api/cover?path=%2Fcovers%2Fnight&size=300' },
  { id: 'pl-2', name: '客厅 · 轻爵士', trackCount: 2, coverArtPath: '/covers/jazz', coverArtUrl: '/api/cover?path=%2Fcovers%2Fjazz&size=300' }
];

const ALBUM_NIGHT = { id: 'al1', title: '夜航', coverArtPath: '/covers/night', coverArtUrl: '/api/cover?path=%2Fcovers%2Fnight&size=300' };
const ALBUM_JAZZ = { id: 'al2', title: 'Living Room', coverArtPath: '/covers/jazz', coverArtUrl: '/api/cover?path=%2Fcovers%2Fjazz&size=300' };

const TRACKS = {
  'pl-1': [
    { id: 'tr-1', title: '晚安，客厅', artistName: 'Demo', artistLabel: 'Demo', artists: [{ artist: { id: 'a1', name: 'Demo' } }], album: ALBUM_NIGHT, durationSeconds: 6, fileFormat: 'flac' },
    { id: 'tr-2', title: '暖光', artistName: 'Demo Band', artistLabel: 'Demo Band', artists: [{ artist: { id: 'a2', name: 'Demo Band' } }], album: ALBUM_NIGHT, durationSeconds: 5, fileFormat: 'flac' },
    { id: 'tr-3', title: '慢一点回家', artistName: 'Demo', artistLabel: 'Demo', artists: [{ artist: { id: 'a1', name: 'Demo' } }], album: ALBUM_NIGHT, durationSeconds: 7, fileFormat: 'flac' }
  ],
  'pl-2': [
    { id: 'tr-4', title: 'Afternoon', artistName: 'Trio', artistLabel: 'Trio', artists: [{ artist: { id: 'a3', name: 'Trio' } }], album: ALBUM_JAZZ, durationSeconds: 6, fileFormat: 'mp3' },
    { id: 'tr-5', title: 'Blue Chair', artistName: 'Trio', artistLabel: 'Trio', artists: [{ artist: { id: 'a3', name: 'Trio' } }], album: ALBUM_JAZZ, durationSeconds: 6, fileFormat: 'mp3' }
  ]
};

function wav(seconds, freq) {
  const rate = 22050, n = Math.floor(rate * seconds), buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const env = Math.min(1, t * 4) * Math.min(1, (seconds - t) * 2);
    const v = Math.sin(2 * Math.PI * freq * t) * 0.28 * env;
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

const COVER = (hue, label) => Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300">` +
  `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
  `<stop offset="0" stop-color="hsl(${hue},60%,32%)"/><stop offset="1" stop-color="hsl(${hue + 40},55%,16%)"/>` +
  `</linearGradient></defs><rect width="300" height="300" fill="url(#g)"/>` +
  `<circle cx="150" cy="150" r="52" fill="none" stroke="rgba(255,255,255,.55)" stroke-width="3"/>` +
  `<circle cx="150" cy="150" r="12" fill="rgba(255,255,255,.75)"/>` +
  `<text x="150" y="252" font-family="sans-serif" font-size="20" fill="rgba(255,255,255,.8)" text-anchor="middle">${label}</text></svg>`);

function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}
const json = (res, code, obj) => send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj));

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  console.log('REQ', req.method, req.url);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST'
    });
    return res.end();
  }

  if (p === '/api/auth/login' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let o = {};
      try { o = JSON.parse(body || '{}'); } catch (e) { }
      if (!o.password) return json(res, 400, { error: 'BAD_REQUEST' });
      console.log('login', o.email || o.username);
      json(res, 200, { token: TOKEN, user: { id: 'u1', username: o.username || o.email, role: 'ADMIN' } });
    });
    return;
  }

  const auth = req.headers.authorization || '';
  if (p.startsWith('/api/') && !p.includes('/stream') && !p.includes('/transcode') && p !== '/api/auth/login') {
    if (auth !== 'Bearer ' + TOKEN) return json(res, 401, { error: 'UNAUTHORIZED' });
  }

  if (p === '/api/playlists/web/mine') {
    return json(res, 200, PLAYLISTS);
  }

  let m = p.match(/^\/api\/playlists\/([^/]+)\/tracks$/);
  if (m) {
    const list = TRACKS[m[1]] || [];
    return json(res, 200, {
      items: list.map((t, i) => ({ order: i, track: t })),
      total: list.length
    });
  }

  if (p === '/api/cover') {
    const path = u.searchParams.get('path') || '';
    const hue = path.includes('night') ? 222 : path.includes('jazz') ? 268 : 12;
    return send(res, 200, 'image/svg+xml', COVER(hue, path.split('/').pop() || 'cover'));
  }

  m = p.match(/^\/api\/tracks\/([^/]+)\/(stream|transcode)$/);
  if (m) {
    if (u.searchParams.get('token') !== TOKEN) return json(res, 401, { error: 'UNAUTHORIZED' });
    const id = m[1];
    const freq = 220 + (parseInt(id.replace(/\D/g, ''), 10) || 1) * 40;
    const buf = wav(6, freq);
    console.log(m[2], id, u.searchParams.get('format') || '', buf.length);
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': buf.length, 'Accept-Ranges': 'bytes' });
    return res.end(buf);
  }

  json(res, 404, { error: 'NOT_FOUND', path: p });
});

server.listen(PORT, '0.0.0.0', () => console.log('fake daoliyu on http://0.0.0.0:' + PORT));
