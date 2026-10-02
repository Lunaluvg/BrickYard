// Two players, two ways to link up:
//  • On your own network with play-together.bat: server.js serves the game and passes messages along.
//  • Anywhere, with the game on a website: one player taps Start and gets a 4-digit code, the other joins
//    with it, and the two browsers then talk directly (WebRTC). A free public service, PeerJS, introduces them.
// Either way the first player hosts: their browser runs the physics and sends every change to the world as
// an "op", while the other player's actions go to the host as commands. Both screens show the same world.
// brickyard.html loads this only over http(s); opened as a plain file, the game is solo.

const TINT = { 1: '#F2CD37', 2: '#36AEBF' };
const PEERJS = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js';
const ROOM_ID = code => `brickyard-game-${code}`; // what a hosted game is called on the PeerJS service
const CHUNK = 16000; // characters per WebRTC message; Safari takes 64 KB at most
const nameOf = slot => `Player ${slot}`;
const r2 = v => Math.round(v * 100) / 100, r3 = v => Math.round(v * 1e3) / 1e3, r4 = v => Math.round(v * 1e4) / 1e4;
const nums = (a, n) => Array.isArray(a) && a.length === n && a.every(Number.isFinite);

export function start(g) {
  fetch('/mp-info', { cache: 'no-store' })
    .then(r => (r.ok ? r.json() : null))
    .then(info => run(g, info && Array.isArray(info.addresses) ? info : null), () => run(g, null));
}

let peerjs = null;
function loadPeerJS() {
  if (!peerjs) {
    peerjs = new Promise((resolve, reject) => {
      if (window.Peer) { resolve(window.Peer); return; }
      const s = Object.assign(document.createElement('script'), { src: PEERJS, async: true });
      s.onload = () => (window.Peer ? resolve(window.Peer) : reject(new Error('PeerJS loaded without Peer')));
      s.onerror = () => { s.remove(); reject(new Error('PeerJS failed to load')); };
      document.head.appendChild(s);
    }).catch(err => { peerjs = null; throw err; });
  }
  return peerjs;
}

function run(g, info) {
  const { THREE, net } = g, $ = id => document.getElementById(id), lan = !!info;
  let link = null, me = 0, peer = 0, mode = '', seen = null;
  let out = [], queued = false, lastHist = '', lastMe = '', meAt = 0, poseAt = 0, sent = new WeakMap();
  let tries = 0;                                                    // home WiFi: reconnect backoff
  let pj = null, conn = null, role = '', code = '', gen = 0, retries = 0, retryTimer = 0, msgId = 0, pieces = {}; // online
  const gliding = new Set(), vA = new THREE.Vector3(), vB = new THREE.Vector3(), qA = new THREE.Quaternion();
  const sendText = s => { if (link) link.send(s); };
  const send = m => sendText(JSON.stringify(m));
  function deliver(text) { let m; try { m = JSON.parse(text); } catch (e) { return; } receive(m); }

  function receive(m) {
    switch (m.t) {
      case 'hello': me = m.slot; becomeHost(m.host); setPeer(m.peer || 0); break;
      case 'peer':
        if (m.on) { setPeer(m.slot); if (!net.guest) sendWorld(); g.toast(`${nameOf(m.slot)} joined`); }
        else { setPeer(0); g.toast(`${nameOf(m.slot)} left`); }
        break;
      case 'host': becomeHost(true); break;
      case 'full': if (lan) show('full'); else giveUp('That game already has two players'); break;
      case 'ops': if (net.guest) applyOps(m.o); break;
      case 'xf': if (net.guest) poses(m.d); break;
      case 'cmd': if (!net.guest) command(m); break;
      case 'me': seen = m; break;
      case 'say': if (peer && typeof m.m === 'string') g.toast(`${nameOf(peer)} ${m.m}`); break;
    }
  }
  function becomeHost(host) {
    if (net.guest === !host) return;
    net.guest = !host;
    if (net.guest) { // the host's world and history are the ones that count now
      g.undoStack.length = g.redoStack.length = 0;
      net.canUndo = net.canRedo = false;
    } else {
      net.remoteSlow = false;
      gliding.clear();
      for (const c of g.chunks.values()) { c.group.position.copy(c.body.position); c.group.quaternion.copy(c.body.quaternion); }
    }
    g.updateSlow(); g.changed();
  }
  function setPeer(slot) {
    peer = slot; seen = null; lastHist = ''; lastMe = ''; out = []; sent = new WeakMap();
    hidePeer();
    if (slot) { tag.textContent = nameOf(slot); tag.style.setProperty('--c', TINT[slot]); head.skin.color.set(TINT[slot]); pBox.material.color.set(TINT[slot]); }
    show(slot ? 'together' : lan ? 'alone' : role === 'host' ? 'waiting' : 'idle');
  }
  // The link to the other player dropped: carry on alone with the world as it is.
  function lost() {
    const had = peer;
    link = null; setPeer(0); becomeHost(true);
    return had;
  }

  /* ───────── Hooks the game calls (see `net` in brickyard.html) ───────── */
  net.op = (...op) => {
    if (net.guest || !peer) return;
    if (op[0] === 'hist') { const h = `${op[1]},${op[2]}`; if (h === lastHist) return; lastHist = h; }
    out.push(op);
    if (!queued) { queued = true; queueMicrotask(flush); }
  };
  function flush() { queued = false; if (out.length) { send({ t: 'ops', o: out }); out = []; } }
  net.cmd = (c, data) => send({ t: 'cmd', c, ...data });
  net.say = text => { if (peer) send({ t: 'say', m: text }); };
  net.frame = (dt, now) => {
    if (!peer) return;
    if (net.guest) glide(dt);
    else if (now - poseAt > 33) { poseAt = now; sendPoses(); }
    if (now - meAt > 80) { meAt = now; sendMe(); }
    drawPeer(dt);
  };

  /* ───────── Host: the whole world for a new player, then their commands ───────── */
  function sendWorld() {
    flush();
    const o = [['reset']];
    for (const b of g.bricks.values()) o.push(['+b', b.data, 0]);
    for (const k of g.brokenLinks) o.push(['L', k]);
    for (const c of g.chunks.values()) o.push(g.chunkOp(c));
    for (const [id, f] of g.fuses) o.push(['f', id, r4(Math.max(0, f.at - g.simTime())), f.show ? 1 : 0]);
    const hist = [g.undoStack.length > 0, g.redoStack.length > 0];
    lastHist = hist.join(',');
    o.push(['base', g.state.base], ['clutch', g.state.clutch], ['ts', g.timeScale()], ['hist', ...hist]);
    send({ t: 'ops', o });
    sent = new WeakMap();
  }
  function command(m) {
    const T = g.TYPE_BY_ID, okColor = c => Number.isInteger(c) && !!g.COLORS[c];
    switch (m.c) {
      case 'add': {
        const b = m.brick || {}, t = T[b.type], rot = b.rot & 3;
        if (t && okColor(b.color) && [b.x, b.y, b.z].every(Number.isInteger) && g.fits(t, rot, b.x, b.y, b.z)) {
          g.commit({ kind: 'add', brick: { id: g.newId(), type: b.type, color: b.color, x: b.x, y: b.y, z: b.z, rot } });
          g.sfx('add');
        }
        break;
      }
      case 'eraseGrid': if (g.bricks.has(m.id)) g.eraseGrid(m.id); break;
      case 'eraseDebris': if (g.debrisParts.has(m.id)) g.eraseDebris(m.id); break;
      case 'paint': {
        const info = g.partInfo(m.id);
        if (info && okColor(m.color) && info.color !== m.color) { g.commit({ kind: 'paint', id: m.id, from: info.color, to: m.color }); g.sfx('paint'); }
        break;
      }
      case 'throw': {
        const p = m.params;
        if (p && T[p.type] && okColor(p.color) && nums(p.pos, 3) && nums(p.quat, 4) && nums(p.vel, 3) && nums(p.ang, 3))
          g.throwWith({ type: p.type, color: p.color, pos: p.pos, quat: p.quat, vel: p.vel, ang: p.ang, s0: Number.isFinite(p.s0) ? Math.min(1, Math.max(0.05, p.s0)) : 1 });
        break;
      }
      case 'detonate': if (g.unlitTNT().length) g.lightUp(); break;
      case 'undo': g.undo(); break;
      case 'redo': g.redo(); break;
      case 'sweep': if (g.debris.size) g.sweepLoose(); break;
      case 'clear': if (g.bricks.size || g.debris.size) g.clearAll(); break;
      case 'load': try { g.openModel(m.model); } catch (err) { /* not a model; the sender already checked */ } break;
      case 'base': if (Number.isInteger(m.i) && g.BASES[m.i]) { g.setBase(m.i); g.scheduleSave(); } break;
      case 'clutch': if (Number.isInteger(m.i) && g.CLUTCH[m.i]) g.setClutch(m.i); break;
      case 'slow': net.remoteSlow = !!m.on; g.updateSlow(); break;
      case 'resync': sendWorld(); break;
    }
  }

  /* ───────── Guest: mirror the host's changes ───────── */
  function applyOps(ops) {
    if (!Array.isArray(ops)) return;
    for (const o of ops) {
      try { applyOp(o); } catch (err) {
        console.warn('Brickyard: out of step with the host, asking for the whole world again.', err);
        send({ t: 'cmd', c: 'resync' });
        break;
      }
    }
    g.changed();
  }
  function applyOp(o) {
    switch (o[0]) {
      case 'reset': g.restoreWorld({ bricks: [], broken: [], debris: [] }); gliding.clear(); break;
      case '+b': if (g.bricks.has(o[1].id)) g.detachGrid(o[1].id); g.addBrick({ ...o[1] }, !!o[2], false); break;
      case '-b': o[2] ? g.removeBrick(o[1], true, false) : g.detachGrid(o[1]); break;
      case 'p': g.recolor(o[1], o[2]); break;
      case 'L': g.brokenLinks.add(o[1]); break;
      case 'Lc': g.brokenLinks.clear(); break;
      case '+c': {
        const [, nid, parts, links, p, q, asleep] = o, old = g.chunks.get(nid);
        if (old) g.removeCompound(old);
        g.buildCompound(parts.map(([id, type, color, rot, x, y, z]) => ({ id, type, color, rot, local: new THREE.Vector3(x, y, z) })),
          links.map(([a, b, u]) => ({ a, b, u })), new THREE.Vector3(...p), new THREE.Quaternion(...q), null, null, !!asleep, nid);
        break;
      }
      case '-c': { const c = g.chunks.get(o[1]); if (c) { gliding.delete(c); g.removeCompound(c); } break; }
      case 'pop': { const part = g.debrisParts.get(o[1]); if (part) g.popMesh(part.mesh); break; }
      case 'grow': { const c = g.chunks.get(o[1]); if (c) g.grow(c.parts[0].mesh, o[2]); break; }
      case 'f': g.ignite(o[1], o[2], !!o[3]); break;
      case 'fc': g.fuses.clear(); break;
      case 'fx': g.boomFx(new THREE.Vector3(o[1], o[2], o[3]), o[4]); break;
      case 's': g.sfx(o[1], o[2]); break;
      case 'base': g.setBase(o[1]); break;
      case 'clutch': g.setClutch(o[1]); break;
      case 'ts': g.setTimeScale(o[1]); break;
      case 'hist': net.canUndo = !!o[1]; net.canRedo = !!o[2]; break;
    }
  }

  /* ───────── Loose pieces: the host streams where they are, the guest glides them there ───────── */
  function sendPoses() {
    flush(); // a piece's "+c" op always goes out before its first position
    const d = [];
    for (const [nid, c] of g.chunks) {
      const p = c.body.position, q = c.body.quaternion, v = [r3(p.x), r3(p.y), r3(p.z), r4(q.x), r4(q.y), r4(q.z), r4(q.w)];
      const was = sent.get(c);
      if (was && was.every((x, i) => x === v[i])) continue;
      sent.set(c, v); d.push(nid, ...v);
    }
    if (d.length) send({ t: 'xf', d });
  }
  function poses(d) {
    if (!Array.isArray(d)) return;
    for (let i = 0; i + 7 < d.length; i += 8) {
      const c = g.chunks.get(d[i]); if (!c) continue;
      c.body.position.set(d[i + 1], d[i + 2], d[i + 3]);
      c.body.quaternion.set(d[i + 4], d[i + 5], d[i + 6], d[i + 7]);
      gliding.add(c);
    }
    g.markHover();
  }
  function glide(dt) {
    const k = 1 - Math.exp(-dt * 30);
    for (const c of gliding) {
      if (c.body.__dead) { gliding.delete(c); continue; }
      const b = c.body, gp = c.group.position, gq = c.group.quaternion;
      vA.set(b.position.x, b.position.y, b.position.z); qA.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
      gp.lerp(vA, k); gq.slerp(qA, k);
      if (gp.distanceToSquared(vA) < 1e-6 && Math.abs(gq.dot(qA)) > 0.99999) { gp.copy(vA); gq.copy(qA); gliding.delete(c); }
    }
  }

  /* ───────── Seeing each other: a minifig head at their camera, and the part they're about to place ───────── */
  const head = minifigHead(THREE);
  const pGhostMat = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.45, depthWrite: false, roughness: 0.35 });
  const pGhost = new THREE.Mesh(new THREE.BufferGeometry(), pGhostMat);
  const pBox = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ transparent: true }));
  pGhost.renderOrder = 9; pBox.renderOrder = 19;
  for (const o of [pGhost, pBox]) o.raycast = () => {};
  g.scene.add(head, pGhost, pBox);
  const tag = document.createElement('div');
  tag.className = 'peer-tag';
  document.body.appendChild(tag);
  hidePeer();

  function sendMe() {
    const c = g.camera.position, l = g.controls.target, at = g.ghostAt(), s = g.state;
    const m = JSON.stringify({ t: 'me', c: [r2(c.x), r2(c.y), r2(c.z)], l: [r2(l.x), r2(l.y), r2(l.z)], g: at ? [s.type.id, s.color, at.x, at.y, at.z, s.rot] : 0 });
    if (m !== lastMe && link) { lastMe = m; sendText(m); }
  }
  function drawPeer(dt) {
    const m = seen;
    if (!m || !nums(m.c, 3) || !nums(m.l, 3)) return;
    vA.fromArray(m.c);
    if (!head.visible) { head.position.copy(vA); head.visible = true; } else head.position.lerp(vA, 1 - Math.exp(-dt * 12));
    head.lookAt(vB.fromArray(m.l));
    const gh = Array.isArray(m.g) && m.g.length === 6 ? m.g : null, t = gh && g.TYPE_BY_ID[gh[0]];
    if (t && g.COLORS[gh[1]] && nums(gh.slice(2), 4)) {
      const [, color, x, y, z, rot] = gh, [ew, ed] = g.dims(t, rot & 3), H = t.h * g.PLATE;
      vA.set(x + ew / 2, y * g.PLATE, z + ed / 2);
      pGhost.geometry = g.getGeo(t);
      pGhostMat.color.set(g.COLORS[color].hex);
      if (pGhost.visible) pGhost.position.lerp(vA, Math.min(1, dt * 22)); else pGhost.position.copy(vA);
      pGhost.rotation.y = -(rot & 3) * Math.PI / 2;
      pBox.position.set(pGhost.position.x, pGhost.position.y + H / 2, pGhost.position.z);
      pBox.scale.set(ew + 0.08, H + 0.08, ed + 0.08);
      pGhost.visible = pBox.visible = true;
    } else pGhost.visible = pBox.visible = false;
    vA.copy(head.position); vA.y += 1.5; vA.project(g.camera); // name tag just above their head
    const onScreen = vA.z < 1 && Math.abs(vA.x) < 1.05 && Math.abs(vA.y) < 1.05;
    tag.hidden = !onScreen;
    if (onScreen) tag.style.transform = `translate(${((vA.x + 1) / 2) * innerWidth}px, ${((1 - vA.y) / 2) * innerHeight}px) translate(-50%, -100%)`;
  }
  function hidePeer() { head.visible = pGhost.visible = pBox.visible = false; tag.hidden = true; }

  /* ───────── Home WiFi: through server.js ───────── */
  function connectLan() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/mp`);
    ws.onopen = () => { tries = 0; link = { send: s => { if (ws.readyState === 1) ws.send(s); } }; };
    ws.onmessage = e => deliver(e.data);
    ws.onclose = () => {
      const wasFull = mode === 'full';
      if (lost()) g.toast('Lost the connection. Playing on your own');
      show(wasFull ? 'full' : 'offline');
      setTimeout(connectLan, wasFull ? 5000 : Math.min(8000, 1000 * 2 ** tries++));
    };
  }

  /* ───────── Online: a 4-digit game code, then a direct link between the two browsers ───────── */
  const keep = { // per tab, so a reload carries on with the same game
    get: k => { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set: (k, v) => { try { sessionStorage.setItem(k, v); } catch (e) { /* fine */ } },
    del: k => { try { sessionStorage.removeItem(k); } catch (e) { /* fine */ } },
  };
  function useConn(c, onClose) {
    conn = c;
    link = { send: s => sendChunks(c, s) };
    c.on('data', d => { if (conn === c) onData(d); });
    const done = () => { if (conn !== c) return; conn = null; link = null; onClose(); };
    c.on('close', done);
    c.on('error', done);
  }
  // Big messages (a whole world) go in pieces; the channel is reliable and in order, so they arrive whole.
  function sendChunks(c, s) {
    if (!c.open) return;
    if (s.length <= CHUNK) { c.send(s); return; }
    const id = ++msgId, n = Math.ceil(s.length / CHUNK);
    for (let i = 0; i < n; i++) c.send(`\u0001${id},${i},${n},${s.slice(i * CHUNK, (i + 1) * CHUNK)}`);
  }
  function onData(d) {
    if (typeof d !== 'string') return;
    if (d.charCodeAt(0) !== 1) { deliver(d); return; }
    const a = d.indexOf(','), b = d.indexOf(',', a + 1), c = d.indexOf(',', b + 1);
    const id = d.slice(1, a), i = +d.slice(a + 1, b), n = +d.slice(b + 1, c), p = pieces[id] || (pieces[id] = { got: 0, bits: [] });
    if (p.bits[i] === undefined) { p.bits[i] = d.slice(c + 1); p.got++; }
    if (p.got === n) { delete pieces[id]; deliver(p.bits.join('')); }
  }
  function teardown() {
    clearTimeout(retryTimer);
    const c = conn, p = pj;
    conn = null; pj = null; link = null; pieces = {};
    if (c) try { c.close(); } catch (e) { /* already gone */ }
    if (p) try { p.destroy(); } catch (e) { /* already gone */ }
  }
  async function hostGame(wanted, attempt = 0) {
    const my = ++gen;
    teardown();
    role = 'host'; code = wanted || String(1000 + Math.floor(Math.random() * 9000));
    show('starting');
    let Peer;
    try { Peer = await loadPeerJS(); } catch (e) { if (my === gen) giveUp("Couldn't load the online part. Is the internet on?"); return; }
    if (my !== gen) return;
    const p = pj = new Peer(ROOM_ID(code));
    p.on('open', () => { if (pj === p) { keep.set('brickyard-host', code); receive({ t: 'hello', slot: 1, host: true, peer: 0 }); } });
    p.on('connection', c => c.on('open', () => {
      if (pj !== p) { c.close(); return; }
      if (conn) { c.send(JSON.stringify({ t: 'full' })); setTimeout(() => c.close(), 500); return; }
      useConn(c, () => receive({ t: 'peer', slot: 2, on: false }));
      receive({ t: 'peer', slot: 2, on: true });
    }));
    p.on('disconnected', () => setTimeout(() => { if (pj === p && !p.destroyed) p.reconnect(); }, 2000)); // linked games carry on meanwhile
    p.on('error', err => {
      if (pj !== p) return;
      if (err.type === 'unavailable-id') { // the code is taken, or this tab's game from before a reload hasn't timed out yet
        if (attempt < 6) setTimeout(() => { if (pj === p) hostGame(wanted && attempt < 3 ? wanted : null, attempt + 1); }, wanted ? 2000 : 0);
        else giveUp("Couldn't start a game. Try again in a moment");
      } else if (!conn && !peer) giveUp(err.type === 'browser-incompatible' ? "This browser can't play together" : "Couldn't reach the online service. Is the internet on?");
    });
  }
  async function joinGame(wanted, again = false) {
    const my = ++gen;
    teardown();
    role = 'guest'; code = wanted;
    show(again ? 'rejoining' : 'joining');
    let Peer;
    try { Peer = await loadPeerJS(); } catch (e) { if (my === gen) again ? retryJoin() : giveUp("Couldn't load the online part. Is the internet on?"); return; }
    if (my !== gen) return;
    const p = pj = new Peer();
    const failed = message => { if (pj !== p || conn) return; again ? retryJoin() : giveUp(message); };
    p.on('open', () => {
      if (pj !== p) return;
      const c = p.connect(ROOM_ID(code), { reliable: true, serialization: 'raw' });
      c.on('open', () => {
        if (pj !== p) { c.close(); return; }
        retries = 0; keep.set('brickyard-join', code);
        if (new URLSearchParams(location.search).has('room')) history.replaceState(null, '', location.pathname);
        useConn(c, () => { if (lost()) g.toast(`${nameOf(1)} left. Trying to get back in…`); retryJoin(); });
        receive({ t: 'hello', slot: 2, host: false, peer: 1 });
        g.toast(`Joined game ${code}`);
      });
      setTimeout(() => failed("Couldn't connect to that game. Try again"), 15000);
    });
    p.on('error', err => failed(err.type === 'peer-unavailable' ? `There's no game ${code}. Check the number` : "Couldn't reach the online service. Is the internet on?"));
  }
  function retryJoin() {
    if (role !== 'guest') return;
    if (++retries > 20) { giveUp(`Couldn't get back into game ${code}`); return; }
    teardown();
    show('rejoining');
    retryTimer = setTimeout(() => joinGame(code, true), 3000);
  }
  function giveUp(message) {
    if (message) g.toast(message);
    leaveGame();
  }
  function leaveGame() {
    gen++;
    const together = peer || net.guest;
    teardown(); role = ''; code = ''; retries = 0;
    keep.del('brickyard-host'); keep.del('brickyard-join');
    if (together) { setPeer(0); becomeHost(true); }
    show('idle');
  }

  /* ───────── The "Play together" chip and its panel ───────── */
  const ui = {
    btn: $('mpBtn'), text: $('mpText'), dots: $('mpBtn').querySelectorAll('.dots i'), note: $('mpNote'), addr: $('mpAddr'), copy: $('mpCopy'),
    start: $('mpStart'), joinForm: $('mpJoinForm'), code: $('mpCode'), leave: $('mpLeave'), foot: $('mpFoot'),
  };
  // Home WiFi: the address the other device opens, on the network play-together.bat is using.
  const onThisPc = /^(localhost|127\.|\[::1\]$)/.test(location.hostname), net0 = lan && info.addresses[0];
  const lanUrl = lan && (onThisPc ? net0 && `http://${net0.address}:${info.port}` : location.origin);
  const onNet = net0 ? ` connected to ${net0.name}` : ' on the same network';
  ui.btn.hidden = false;
  ui.btn.onclick = () => g.togglePop('mp');
  ui.start.onclick = () => hostGame();
  ui.leave.onclick = () => leaveGame();
  ui.joinForm.onsubmit = e => {
    e.preventDefault();
    const c = ui.code.value.replace(/\D/g, '');
    if (c.length !== 4) { g.toast('Game codes have 4 numbers'); return; }
    ui.code.blur(); ui.code.value = '';
    joinGame(c);
  };
  ui.copy.onclick = () => {
    if (lan) { copyText(lanUrl).then(() => g.toast('Address copied'), () => g.toast("Couldn't copy. Type the address instead")); return; }
    const url = `${location.origin}${location.pathname}?room=${code}`;
    if (navigator.share) navigator.share({ title: 'Brickyard', text: `Come build with me in Brickyard. Game ${code}`, url }).catch(() => {});
    else copyText(url).then(() => g.toast('Link copied'), () => g.toast(`Couldn't copy. The code is ${code}`));
  };
  function show(m) {
    mode = m;
    ui.btn.dataset.state = m === 'waiting' ? 'alone' : m;
    ui.text.textContent = {
      connecting: 'Connecting…', alone: 'Waiting for a friend', offline: 'Offline', full: 'Game is full', together: `With ${nameOf(peer)}`,
      idle: 'Play together', starting: 'Starting…', waiting: `Game ${code}`, joining: 'Joining…', rejoining: 'Reconnecting…',
    }[m];
    const live = m === 'alone' || m === 'waiting' || m === 'together';
    ui.dots[0].style.setProperty('--c', me && live ? TINT[me] : '');
    ui.dots[1].style.setProperty('--c', m === 'together' ? TINT[peer] : '');
    if (lan) {
      ui.note.textContent = {
        connecting: 'Connecting to the play-together window…',
        alone: `You're ${nameOf(me)}. Your friend opens this on another device${onNet}:`,
        together: `You're ${nameOf(me)}, building with ${nameOf(peer)}. To join again, open this on a device${onNet}:`,
        offline: "Can't reach the play-together window. Is it still open? Trying again…",
        full: 'Two people are already playing. You’ll join when one of them leaves.',
      }[m];
      ui.addr.hidden = false; ui.addr.textContent = lanUrl || 'Only this computer can play. Run play-together.bat again once you’re on a network.';
      ui.copy.hidden = !lanUrl; ui.copy.textContent = 'Copy address';
      ui.start.hidden = ui.joinForm.hidden = ui.leave.hidden = true;
      ui.foot.textContent = 'Keep the play-together window open while you play. Undo is shared: it takes back the last change, whoever made it.';
      return;
    }
    const hosting = role === 'host';
    ui.note.textContent = {
      idle: 'Build with someone on another iPad, phone or computer. Both need the internet. Start a game, or type a friend’s game code:',
      starting: 'Starting a game…',
      waiting: 'Your game code. On the other device, tap Play together and type it in:',
      joining: `Joining game ${code}…`,
      rejoining: `Lost the other player. Trying to get back into game ${code}…`,
      together: hosting ? `You're ${nameOf(me)}, building with ${nameOf(peer)} in game ${code}.` : `You're ${nameOf(me)}, building with ${nameOf(peer)}.`,
    }[m];
    ui.addr.hidden = m !== 'waiting'; ui.addr.textContent = code; ui.addr.classList.add('code');
    ui.copy.hidden = !(m === 'waiting' || (m === 'together' && hosting)); ui.copy.textContent = navigator.share ? 'Share link' : 'Copy link';
    ui.start.hidden = ui.joinForm.hidden = m !== 'idle';
    ui.leave.hidden = m === 'idle';
    ui.leave.textContent = m === 'together' ? 'Leave game' : m === 'waiting' ? 'End game' : 'Cancel';
    ui.foot.textContent = 'Undo is shared: it takes back the last change, whoever made it.';
  }
  function copyText(s) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(s);
    const ta = Object.assign(document.createElement('textarea'), { value: s });
    ta.style.cssText = 'position:fixed; opacity:0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove();
    return ok ? Promise.resolve() : Promise.reject(new Error('copy failed'));
  }

  if (lan) { show('connecting'); connectLan(); return; }
  // Online: a shared link (?room=1234) joins straight away; a reload rejoins or re-hosts the same game.
  const fromLink = new URLSearchParams(location.search).get('room'), hosted = keep.get('brickyard-host'), joined = keep.get('brickyard-join');
  if (/^\d{4}$/.test(fromLink || '') && fromLink !== hosted) joinGame(fromLink);
  else if (hosted) hostGame(hosted);
  else if (joined) joinGame(joined, true);
  else show('idle');
}

// A LEGO minifig head that faces where the other player is looking.
function minifigHead(THREE) {
  const head = new THREE.Group(), skin = new THREE.MeshStandardMaterial({ roughness: 0.35 }), ink = new THREE.MeshBasicMaterial({ color: 0x1b2a34 });
  const face = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.62, 32), skin);
  const stud = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.16, 24), skin);
  stud.position.y = 0.39;
  head.add(face, stud);
  const eye = new THREE.SphereGeometry(0.055, 12, 8);
  for (const x of [-0.16, 0.16]) { const e = new THREE.Mesh(eye, ink); e.position.set(x, 0.08, 0.49); e.scale.z = 0.4; head.add(e); }
  const smile = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.022, 8, 24, Math.PI), ink);
  smile.rotation.z = Math.PI; smile.position.set(0, -0.02, 0.495);
  head.add(smile);
  head.traverse(o => { o.raycast = () => {}; });
  head.scale.setScalar(2.2); // big enough to spot from across the baseplate
  head.skin = skin;
  return head;
}
