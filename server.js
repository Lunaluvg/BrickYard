// Brickyard play-together server. Serves the game to devices on one network you pick, and passes
// messages between up to five players. No installs: only Node's built-in modules.
// Start it with play-together.bat, or: node server.js [--network NAME] [--choose] [--port 8080] [--no-open]
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const readline = require('readline');
const { exec, execSync, spawn } = require('child_process');

const ROOT = __dirname, SAVED = path.join(ROOT, '.play-together.json');
const args = process.argv.slice(2), arg = name => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const START_PORT = +arg('--port') || +process.env.PORT || 8080;
const OPEN = !args.includes('--no-open');
const MAX_MESSAGE = 16 * 1024 * 1024;
const MAX_PLAYERS = 5;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

/* ───────────── Which network ───────────── */
// Every network this computer is on, named the way you know it: the WiFi's name, or the connection's
// name for other links (a phone plugged in by USB shows up as the phone's name).
function networks() {
  const list = [];
  for (const [iface, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal && !a.address.startsWith('169.254.')) list.push({ iface, address: a.address, name: iface });
    }
  }
  if (process.platform === 'win32' && list.length) {
    const names = new Map(), run = cmd => execSync(cmd, { encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      const out = run('powershell -NoProfile -Command "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-NetConnectionProfile | ForEach-Object { $_.InterfaceAlias + [char]9 + $_.Name }"');
      for (const line of out.split(/\r?\n/)) { const [alias, name] = line.split('\t'); if (alias && name) names.set(alias.trim(), name.trim()); }
    } catch (e) { /* no names; interface names will do */ }
    try {
      let iface = null;
      for (const line of run('netsh wlan show interfaces').split(/\r?\n/)) {
        const m = line.match(/^\s*(Name|SSID)\s*:\s*(.+?)\s*$/);
        if (m && m[1] === 'Name') iface = m[2];
        else if (m && iface) names.set(iface, m[2]); // the WiFi's own name beats the connection profile's
      }
    } catch (e) { /* no WiFi */ }
    for (const n of list) n.name = names.get(n.iface) || n.iface;
  }
  return list;
}
function remembered() { try { return JSON.parse(fs.readFileSync(SAVED, 'utf8')).network; } catch (e) { return null; } }
function remember(name) { try { fs.writeFileSync(SAVED, JSON.stringify({ network: name })); } catch (e) { /* fine, we'll ask again */ } }
function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(question, a => { rl.close(); res(a.trim()); }));
}
async function chooseNetwork(nets) {
  const byName = name => name && nets.find(n => n.name.toLowerCase() === String(name).toLowerCase());
  const wanted = arg('--network');
  if (wanted) {
    if (byName(wanted)) return byName(wanted);
    console.log(`\n  There's no network called "${wanted}" right now.`);
  } else {
    if (nets.length === 1) return nets[0];
    if (!args.includes('--choose') && byName(remembered())) return byName(remembered());
  }
  if (!nets.length || !process.stdin.isTTY) return null;
  console.log('\n  Which network will you play on? The other device has to be on the same one.\n');
  nets.forEach((n, i) => console.log(`    ${i + 1}) ${n.name}   (${n.address})`));
  for (;;) {
    const n = nets[parseInt(await ask('\n  Type its number and press Enter: '), 10) - 1];
    if (n) { remember(n.name); return n; }
  }
}

/* ───────────── Files ───────────── */
let chosen = null;
function serve(req, res) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/mp-info') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ port: req.socket.localPort, addresses: chosen ? [{ name: chosen.name, address: chosen.address }] : [] }));
    return;
  }
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch (e) { res.writeHead(400).end(); return; }
  if (rel === '/') rel = '/brickyard.html';
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep) || rel.split(/[\\/]/).some(s => s.startsWith('.'))) { res.writeHead(403).end('Forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

/* ───────────── WebSocket (RFC 6455, just what the browsers need) ───────────── */
function frame(op, payload = Buffer.alloc(0)) {
  const n = payload.length;
  let head;
  if (n < 126) head = Buffer.from([0x80 | op, n]);
  else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(n, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([head, payload]);
}
// Collects incoming bytes and hands back whole messages; frames can arrive split or several at once.
function reader(p) {
  let buf = Buffer.alloc(0), parts = [];
  return chunk => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > MAX_MESSAGE) { leave(p); return; }
      const maskAt = off;
      if (masked) off += 4;
      if (buf.length < off + len) return;
      const data = Buffer.from(buf.subarray(off, off + len));
      if (masked) for (let i = 0; i < len; i++) data[i] ^= buf[maskAt + (i & 3)];
      buf = buf.subarray(off + len);
      p.alive = true;
      if (op === 8) { p.sock.end(frame(8)); leave(p); return; }   // close
      if (op === 9) { p.sock.write(frame(10, data)); continue; }  // ping → pong
      if (op === 10) continue;                                    // pong
      if (op === 1 || op === 2) parts = [data];
      else if (op === 0) parts.push(data);
      else continue;
      if (fin) { relay(p, Buffer.concat(parts)); parts = []; }
    }
  };
}

/* ───────────── The game: up to five players, the first one in hosts ───────────── */
// The host's browser runs the game. A guest's messages go to the host, marked "@slot\n" so it knows who sent
// them; the host's go to every guest, or to just one when they start with "@slot\n".
const players = [], turnedAway = new Set();
const hostOf = () => players.find(q => q.host);
const tell = (p, msg) => { if (!p.sock.destroyed) p.sock.write(frame(1, Buffer.from(JSON.stringify(msg)))); };
function relay(from, data) {
  if (!from.host) {
    const h = hostOf();
    if (h && !h.sock.destroyed) h.sock.write(frame(1, Buffer.concat([Buffer.from(`@${from.slot}\n`), data])));
    return;
  }
  if (data[0] === 0x40) { // "@slot\n…"
    const nl = data.indexOf(0x0a), to = nl > 1 && players.find(q => q.slot === +data.subarray(1, nl).toString());
    if (to && to !== from && !to.sock.destroyed) to.sock.write(frame(1, data.subarray(nl + 1)));
    return;
  }
  const f = frame(1, data);
  for (const q of players) if (q !== from && !q.sock.destroyed) q.sock.write(f);
}

function upgrade(req, sock) {
  const key = req.headers['sec-websocket-key'], url = new URL(req.url, 'http://x');
  if (url.pathname !== '/mp' || !key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { sock.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  sock.setNoDelay(true);
  const from = String(sock.remoteAddress || '').replace(/^::ffff:/, '');
  if (players.length >= MAX_PLAYERS) {
    sock.end(frame(1, Buffer.from(JSON.stringify({ t: 'full' }))));
    if (!turnedAway.has(from)) { turnedAway.add(from); console.log(`  Someone else (${from}) is waiting: the game is full with ${MAX_PLAYERS} players`); }
    return;
  }
  turnedAway.delete(from);
  // A player who reloads asks for their old number back.
  const used = new Set(players.map(q => q.slot)), want = +url.searchParams.get('want');
  let slot = want >= 1 && want <= MAX_PLAYERS && !used.has(want) ? want : 1;
  while (used.has(slot)) slot++;
  const p = { sock, slot, host: !hostOf(), alive: true };
  players.push(p);
  sock.on('data', reader(p));
  sock.on('close', () => leave(p));
  sock.on('error', () => leave(p));
  tell(p, { t: 'hello', slot: p.slot, hostSlot: hostOf().slot, roster: players.map(q => q.slot) });
  for (const q of players) if (q !== p) tell(q, { t: 'peer', slot: p.slot, on: true });
  console.log(`  Player ${p.slot} joined from ${from}${p.host ? ' (hosting)' : ''}. Players: ${players.length} of ${MAX_PLAYERS}`);
}
function leave(p) {
  const i = players.indexOf(p);
  if (i < 0) return;
  players.splice(i, 1);
  p.sock.destroy();
  console.log(`  Player ${p.slot} left`);
  for (const q of players) tell(q, { t: 'peer', slot: p.slot, on: false });
  if (p.host && players.length) { // the next player takes over and sends everyone its copy of the world
    const h = players.reduce((a, b) => (b.slot < a.slot ? b : a));
    h.host = true;
    for (const q of players) tell(q, { t: 'host', slot: h.slot });
    console.log(`  Player ${h.slot} is hosting now`);
  }
}
// A phone that falls asleep never says goodbye, so ping now and then and drop anyone who stops answering.
setInterval(() => {
  for (const p of [...players]) {
    if (!p.alive) { leave(p); continue; }
    p.alive = false;
    if (!p.sock.destroyed) p.sock.write(frame(9));
  }
}, 15000).unref();

/* ───────────── Start: listen on this computer and the chosen network only ───────────── */
function listenAll(port, hosts, done, tries = 0) {
  let up = 0, failed = false;
  const servers = hosts.map(host => {
    const s = http.createServer(serve);
    s.on('upgrade', upgrade);
    s.once('error', err => {
      if (failed) return;
      failed = true;
      servers.forEach(x => x.close(() => {}));
      if (err.code === 'EADDRINUSE' && tries < 10) listenAll(port + 1, hosts, done, tries + 1);
      else { console.error(`\n  Couldn't start: ${err.message}`); process.exit(1); }
    });
    s.listen(port, host, () => { if (++up === hosts.length && !failed) done(port); });
    return s;
  });
}

// Open the game in Chrome when it's installed, otherwise in the default browser. Returns which one.
function openBrowser(url) {
  if (process.platform !== 'win32') {
    exec(process.platform === 'darwin' ? `open -a "Google Chrome" "${url}" || open "${url}"` : `google-chrome "${url}" || xdg-open "${url}"`, () => {});
    return 'your browser';
  }
  const chrome = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
    .filter(Boolean).map(dir => path.join(dir, 'Google', 'Chrome', 'Application', 'chrome.exe')).find(f => fs.existsSync(f));
  if (chrome) { spawn(chrome, [url], { detached: true, stdio: 'ignore' }).unref(); return 'Chrome'; }
  exec(`start "" "${url}"`, () => {});
  return 'your default browser';
}

(async () => {
  chosen = await chooseNetwork(networks());
  listenAll(START_PORT, chosen ? ['127.0.0.1', chosen.address] : ['127.0.0.1'], port => {
    const local = `http://localhost:${port}`;
    if (chosen) {
      console.log(`\n  Brickyard is ready to play together on ${chosen.name}.\n`);
      console.log(`  On this computer:     ${local}`);
      console.log(`  On other devices:     http://${chosen.address}:${port}\n`);
      console.log(`  Up to ${MAX_PLAYERS} players. The other devices have to be connected to ${chosen.name}. Keep this window open while you play.`);
      console.log('  To play on a different network: play-together.bat --choose');
      console.log("  If the other devices can't connect: when Windows asks, let Node.js use Public networks too.\n");
    } else {
      console.log(`\n  No network picked, so only this computer can play: ${local}`);
      console.log('  Connect to a WiFi or plug in your phone, then run play-together.bat again.\n');
    }
    if (OPEN) console.log(`  Opening the game in ${openBrowser(local)}...\n`);
  });
})();
