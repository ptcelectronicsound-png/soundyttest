// เซิร์ฟเวอร์ขอเพลง — ไม่ต้องติดตั้งแพ็กเกจเพิ่ม ใช้ Node.js อย่างเดียว
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public'), UP = path.join(__dirname, 'uploads');
const MAX = (+process.env.MAX_MB || 100) * 1024 * 1024; // ไฟล์อัปโหลดสูงสุด (ค่าเริ่มต้น 100 MB, ตั้งด้วย MAX_MB)
fs.mkdirSync(UP, { recursive: true });

let queue = [], chat = [];
const clients = new Set();
const mime = { '.html': 'text/html; charset=utf-8', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4' };
const clip = (s, n) => String(s || '').trim().slice(0, n);
const snapshot = () => JSON.stringify({ queue: queue.slice(-200), chat: chat.slice(-100) });
const push = () => { const d = 'data: ' + snapshot() + '\n\n'; for (const c of clients) c.write(d); };
setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 20000);

const send = (res, code, text) => { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(text); };
const json = (res, obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readJson = req => new Promise((ok, no) => {
  let b = ''; req.on('data', c => { b += c; if (b.length > 1e5) { no(new Error('big')); req.destroy(); } });
  req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch (e) { no(e); } });
  req.on('error', no);
});
const lanIps = () => Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);

function file(req, res, fp) {
  fs.stat(fp, (e, st) => {
    if (e || !st.isFile()) return send(res, 404, 'Not found');
    const type = mime[path.extname(fp).toLowerCase()] || 'application/octet-stream';
    const r = req.headers.range;
    if (r) {
      const m = /bytes=(\d*)-(\d*)/.exec(r) || [];
      let s = m[1] ? +m[1] : 0, en = m[2] ? +m[2] : st.size - 1;
      if (!m[1] && m[2]) { s = Math.max(0, st.size - +m[2]); en = st.size - 1; }
      if (en >= st.size) en = st.size - 1;
      if (s > en) { res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); return res.end(); }
      res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${s}-${en}/${st.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': en - s + 1 });
      return fs.createReadStream(fp, { start: s, end: en }).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': st.size });
    fs.createReadStream(fp).pipe(res);
  });
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), p = u.pathname;
  try {
    if (req.method === 'GET') {
      if (p === '/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write('retry: 2000\n\ndata: ' + snapshot() + '\n\n');
        clients.add(res); req.on('close', () => clients.delete(res)); return;
      }
      if (p === '/api/info') return json(res, { ips: lanIps(), port: PORT });
      if (p === '/' || p === '/remote') return file(req, res, path.join(PUB, 'app.html'));
      if (p.startsWith('/uploads/')) return file(req, res, path.join(UP, path.basename(p)));
      return send(res, 404, 'Not found');
    }
    if (req.method === 'POST') {
      if (p === '/api/song') {
        const b = await readJson(req);
        if (!/^[A-Za-z0-9_-]{11}$/.test(b.vid || '')) return send(res, 400, 'bad id');
        queue.push({ id: crypto.randomBytes(6).toString('hex'), type: 'yt', vid: b.vid, title: 'YouTube ' + b.vid, by: clip(b.by, 24) || 'ไม่ระบุชื่อ', t: Date.now(), played: false });
        push(); return json(res, { ok: true });
      }
      if (p === '/api/chat') {
        const b = await readJson(req), text = clip(b.text, 200);
        if (!text) return send(res, 400, 'empty');
        chat.push({ name: clip(b.name, 24) || 'ไม่ระบุชื่อ', text, t: Date.now() });
        push(); return json(res, { ok: true });
      }
      if (p === '/api/next') {
        const b = await readJson(req), it = queue.find(x => x.id === b.id);
        if (it) { it.played = true; push(); }
        return json(res, { ok: true });
      }
      if (p === '/api/upload') {
        const name = clip(u.searchParams.get('name'), 100), by = clip(u.searchParams.get('by'), 24) || 'ไม่ระบุชื่อ';
        const ext = path.extname(name).toLowerCase();
        if (!['.mp3', '.mp4'].includes(ext)) return send(res, 400, 'รองรับเฉพาะ mp3/mp4');
        const id = crypto.randomBytes(8).toString('hex'), fn = id + ext, fp = path.join(UP, fn);
        let size = 0, over = false; const ws = fs.createWriteStream(fp);
        req.on('data', c => { size += c.length; if (size > MAX && !over) { over = true; ws.destroy(); fs.unlink(fp, () => {}); send(res, 413, 'ไฟล์ใหญ่เกินไป'); } });
        req.on('close', () => { if (!req.complete) { ws.destroy(); fs.unlink(fp, () => {}); } });
        req.pipe(ws);
        ws.on('finish', () => {
          if (over) return;
          queue.push({ id, type: 'file', url: '/uploads/' + fn, title: name.replace(/\.[^.]+$/, ''), by, t: Date.now(), played: false });
          push(); json(res, { ok: true });
        });
        return;
      }
    }
    send(res, 404, 'Not found');
  } catch (e) { if (!res.headersSent) send(res, 400, 'bad request'); }
}).listen(PORT, '0.0.0.0', () => {
  console.log('\n🎵 เปิดแล้ว!');
  console.log('   จอใหญ่ (เปิดในคอม):  http://localhost:' + PORT);
  lanIps().forEach(ip => console.log('   มือถือ (wifi เดียวกัน): http://' + ip + ':' + PORT + '/remote'));
  console.log('');
});
