// Up to five players, two ways to link up:
//  • On your own network with play-together.bat: server.js serves the game and passes messages along.
//  • Anywhere with internet, with the game on a website: one player taps Start and gets a 4-digit code, and
//    friends join with the code or an invite link, from any WiFi or mobile data. PeerJS, a free public service,
//    introduces each friend's browser to the host's so they can talk directly (WebRTC). When their networks
//    won't allow that (a phone on mobile data and a computer on home WiFi often won't), that friend's messages
//    go through the relay instead (relay.js), a little slower but from anywhere.
// Either way one player hosts: their browser runs the physics and sends every change to the world as an "op"
// to everyone, while the others' actions go to the host as commands. Every screen shows the same world.
// If the host leaves, the player with the lowest number takes the game over and the others follow.
// brickyard.html loads this only over http(s); opened as a plain file, the game is solo.

import { relayRoom, relayLink } from './relay.js';

const MAX_PLAYERS = 5;
const PROTOCOL = 3; // copies of the game on different versions can't play together; bump when the messages change
const TINT = { 1: '#F2CD37', 2: '#36AEBF', 3: '#FE8A18', 4: '#AC78BA', 5: '#BBE90B' };
const PEERJS = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js';
// STUN servers tell each browser its public address, so two browsers can find a direct way to each other.
const PEER_OPTIONS = { config: { iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }] } };
const ROOM_ID = code => `brickyard-game-${code}`; // what a hosted game is called on the PeerJS service
const DIRECT_WAIT = 5000; // how long a direct link gets to open before a guest goes through the relay instead
const CHUNK = 16000; // characters per WebRTC message; Safari takes 64 KB at most
const nameOf = slot => `Player ${slot}`;
const r2 = v => Math.round(v * 100) / 100, r3 = v => Math.round(v * 1e3) / 1e3, r4 = v => Math.round(v * 1e4) / 1e4;
const nums = (a, n) => Array.isArray(a) && a.length === n && a.every(Number.isFinite);
const isSlot = s => Number.isInteger(s) && s >= 1 && s <= MAX_PLAYERS;
const wait = ms => new Promise(res => setTimeout(res, ms));

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
  const keep = { // per tab, so a reload carries on in the same game as the same player
    get: k => { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set: (k, v) => { try { sessionStorage.setItem(k, v); } catch (e) { /* fine */ } },
    del: k => { try { sessionStorage.removeItem(k); } catch (e) { /* fine */ } },
  };
  const tab = keep.get('brickyard-tab') || Math.random().toString(36).slice(2, 10); // tells the host it's still us after a reconnect
  keep.set('brickyard-tab', tab);
  let me = 0, hostSlot = 0, mode = '', leaving = false;
  const roster = new Set(); // everyone in the game, us included
  const seen = new Map();   // slot → what that player is up to: their camera and the part in their hand
  const looks = new Map();  // slot → how we draw them: { head, ghost, box, tag }
  // Who we talk to: a guest only to the host, the host to each guest.
  let hostSend = null, hostConn = null;
  const guestSends = new Map(), guestConns = new Map(), guestTabs = new Map(), slowSlots = new Set();
  let out = [], queued = false, lastHist = '', lastMe = '', meAt = 0, poseAt = 0, sent = new WeakMap();
  let lanSend = null, tries = 0;                // home WiFi
  let pj = null, relay = null, rl = null, code = '', gen = 0, msgId = 0, heardAt = 0; // online: PeerJS, the relay room we host, our relay link as a guest
  const gliding = new Set(), vA = new THREE.Vector3(), vB = new THREE.Vector3(), qA = new THREE.Quaternion();

  const toHost = m => { if (hostSend) hostSend(JSON.stringify(m)); };
  const toGuest = (slot, m) => { const send = guestSends.get(slot); if (send) send(JSON.stringify(m)); };
  function toGuests(m, except = 0) {
    if (!guestSends.size) return;
    const text = JSON.stringify(m);
    if (lan && !except) { if (lanSend) lanSend(text); return; } // the play-together server hands it to every guest
    let relayed = false;
    for (const [slot, send] of guestSends) if (slot !== except) { if (send.relayed) relayed = true; else send(text); }
    if (relayed && relay) sendChunks(relay.everyone, text); // once for everyone on the relay; a guest ignores news about itself
  }
  function deliver(text, from) { let m; try { m = JSON.parse(text); } catch (e) { return; } if (m && typeof m === 'object') receive(m, from); }

  // `from` is the guest a message came from when we host; 0 means the host, or the play-together server.
  function receive(m, from) {
    if (from) {
      if (net.guest || !roster.has(from)) return;
      if (m.t === 'cmd') command(m, from);
      else if (m.t === 'me') { seen.set(from, m); toGuests({ ...m, s: from }, from); }
      else if (m.t === 'say' && typeof m.m === 'string') { g.toast(`${nameOf(from)} ${m.m}`); toGuests({ t: 'say', s: from, m: m.m }, from); }
      return;
    }
    switch (m.t) {
      case 'hello': welcome(m); break;
      case 'peer': if (isSlot(m.slot) && m.slot !== me) { if (m.on) joined(m.slot, !!m.back); else left(m.slot); } break;
      case 'host': if (lan && isSlot(m.slot)) newHost(m.slot); break;
      case 'full': if (lan) { alone(); show('full'); } break;
      case 'ops': if (net.guest) applyOps(m.o); break;
      case 'xf': if (net.guest) poses(m.d); break;
      case 'me': if (net.guest && isSlot(m.s) && m.s !== me) seen.set(m.s, m); break;
      case 'say': if (isSlot(m.s) && m.s !== me && typeof m.m === 'string') g.toast(`${nameOf(m.s)} ${m.m}`); break;
    }
  }

  /* ───────── Who's in the game ───────── */
  // We're in: the play-together server (home WiFi) or the host (online) says who we are and who else is here.
  function welcome(m) {
    if (!isSlot(m.slot)) return;
    me = m.slot; hostSlot = isSlot(m.hostSlot) ? m.hostSlot : me;
    roster.clear(); roster.add(me);
    for (const s of Array.isArray(m.roster) ? m.roster : []) if (isSlot(s)) roster.add(s);
    for (const s of [...looks.keys()]) if (!roster.has(s)) dropLook(s);
    keep.set('brickyard-slot', String(me));
    if (!lan) { keep.set('brickyard-join', code); keep.del('brickyard-host'); }
    if (lan && me === hostSlot) for (const s of roster) if (s !== me) addLanGuest(s);
    becomeHost(me === hostSlot);
    lastMe = '';
    show('in');
  }
  // Someone came in. When we host, they get the whole world and what everyone is doing.
  function joined(slot, back) {
    roster.add(slot);
    if (!net.guest) {
      if (lan) addLanGuest(slot);
      else toGuests({ t: 'peer', slot, on: true, back }, slot);
      sendWorld(slot);
      for (const [s, m] of seen) if (s !== slot) toGuest(slot, { ...m, s });
      lastMe = ''; // and us
    }
    if (!back) g.toast(`${nameOf(slot)} joined`);
    updateUi();
  }
  function left(slot) {
    if (!roster.delete(slot)) return;
    seen.delete(slot); dropLook(slot);
    if (!net.guest) {
      guestSends.delete(slot); guestConns.delete(slot); guestTabs.delete(slot);
      if (slowSlots.delete(slot)) { net.remoteSlow = slowSlots.size > 0; g.updateSlow(); }
      if (!lan) toGuests({ t: 'peer', slot, on: false });
    }
    g.toast(`${nameOf(slot)} left`);
    updateUi();
  }
  // Home WiFi: the host left and the play-together server picked the next player.
  function newHost(slot) {
    hostSlot = slot;
    if (slot === me) {
      for (const s of roster) if (s !== me) addLanGuest(s);
      becomeHost(true);
      sendWorld(); // so every screen matches ours again
    }
    updateUi();
  }
  const addLanGuest = s => guestSends.set(s, text => { if (lanSend) lanSend(`@${s}\n${text}`); });
  function becomeHost(host) {
    if (net.guest === !host) return;
    net.guest = !host;
    if (net.guest) { // the host's world and history are the ones that count now
      g.undoStack.length = g.redoStack.length = 0;
      net.canUndo = net.canRedo = false;
    } else {
      net.remoteSlow = false; slowSlots.clear();
      gliding.clear();
      for (const c of g.chunks.values()) { c.group.position.copy(c.body.position); c.group.quaternion.copy(c.body.quaternion); }
    }
    g.updateSlow(); g.changed();
  }
  // The link dropped: carry on alone with the world as it is.
  function alone() {
    hostSend = null; hostConn = null;
    guestSends.clear(); guestConns.clear(); guestTabs.clear(); slowSlots.clear();
    roster.clear(); if (me) roster.add(me);
    seen.clear(); for (const s of [...looks.keys()]) dropLook(s);
    becomeHost(true);
  }

  /* ───────── Hooks the game calls (see `net` in brickyard.html) ───────── */
  net.op = (...op) => {
    if (net.guest || !guestSends.size) return;
    if (op[0] === 'hist') { const h = `${op[1]},${op[2]}`; if (h === lastHist) return; lastHist = h; }
    out.push(op);
    if (!queued) { queued = true; queueMicrotask(flush); }
  };
  function flush() { queued = false; if (out.length) { toGuests({ t: 'ops', o: out }); out = []; } }
  net.cmd = (c, data) => toHost({ t: 'cmd', c, ...data });
  net.say = text => { if (roster.size > 1) net.guest ? toHost({ t: 'say', m: text }) : toGuests({ t: 'say', s: me, m: text }); };
  net.frame = (dt, now) => {
    if (roster.size < 2) return;
    if (net.guest) glide(dt);
    else if (now - poseAt > (relay && relay.size ? 66 : 33)) { poseAt = now; sendPoses(); } // half as often when someone's on the relay
    if (now - meAt > 80) { meAt = now; sendMe(); }
    drawPeers(dt);
  };

  /* ───────── Host: the whole world for a newcomer, then everyone's commands ───────── */
  function sendWorld(to = 0) {
    flush();
    const o = [['reset']];
    for (const b of g.bricks.values()) o.push(['+b', b.data, 0]);
    for (const k of g.brokenLinks) o.push(['L', k]);
    for (const c of g.chunks.values()) o.push(g.chunkOp(c));
    for (const [id, f] of g.fuses) o.push(['f', id, r4(Math.max(0, f.at - g.simTime())), f.show ? 1 : 0]);
    const hist = [g.undoStack.length > 0, g.redoStack.length > 0];
    lastHist = hist.join(',');
    o.push(['base', g.state.base], ['clutch', g.state.clutch], ['ts', g.timeScale()], ['hist', ...hist]);
    if (to) toGuest(to, { t: 'ops', o }); else toGuests({ t: 'ops', o });
    sent = new WeakMap();
  }
  function command(m, from) {
    const T = g.TYPE_BY_ID, okColor = c => Number.isInteger(c) && !!g.COLORS[c];
    switch (m.c) {
      case 'add': {
        const b = m.brick || {}, t = T[b.type], rot = b.rot & 3;
        if (t && okColor(b.color) && [b.x, b.y, b.z].every(Number.isInteger) && g.fits(t, rot, b.x, b.y, b.z)) {
          g.placeBrick({ id: g.newId(), type: b.type, color: b.color, x: b.x, y: b.y, z: b.z, rot });
          g.sfx('add');
        }
        break;
      }
      case 'eraseGrid': if (g.bricks.has(m.id)) g.eraseGrid(m.id); break;
      case 'eraseDebris': if (g.debrisParts.has(m.id)) g.eraseDebris(m.id); break;
      case 'paint': {
        const info = g.partInfo(m.id);
        if (info && g.paintable(m.id) && okColor(m.color) && info.color !== m.color) { g.commit({ kind: 'paint', id: m.id, from: info.color, to: m.color }); g.sfx('paint'); }
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
      case 'slow': if (m.on) slowSlots.add(from); else slowSlots.delete(from); net.remoteSlow = slowSlots.size > 0; g.updateSlow(); break;
      case 'resync': sendWorld(from); break;
    }
  }

  /* ───────── Guest: mirror the host's changes ───────── */
  function applyOps(ops) {
    if (!Array.isArray(ops)) return;
    for (const o of ops) {
      try { applyOp(o); } catch (err) {
        console.warn('Brickyard: out of step with the host, asking for the whole world again.', err);
        toHost({ t: 'cmd', c: 'resync' });
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
      case 'w': g.weirdFx(o[1], o[2], o[3], o[4], o[5]); break; // weird parts: a swallow, a melt, a splash, steam…
      case 's': g.sfx(o[1], o[2]); break;
      case 'base': g.setBase(o[1]); break;
      case 'clutch': g.setClutch(o[1]); break;
      case 'ts': g.setTimeScale(o[1]); break;
      case 'hist': net.canUndo = !!o[1]; net.canRedo = !!o[2]; break;
    }
  }

  /* ───────── Loose pieces: the host streams where they are, guests glide them there ───────── */
  function sendPoses() {
    flush(); // a piece's "+c" op always goes out before its first position
    const d = [];
    for (const [nid, c] of g.chunks) {
      const p = c.body.position, q = c.body.quaternion, v = [r3(p.x), r3(p.y), r3(p.z), r4(q.x), r4(q.y), r4(q.z), r4(q.w)];
      const was = sent.get(c);
      if (was && was.every((x, i) => x === v[i])) continue;
      sent.set(c, v); d.push(nid, ...v);
    }
    if (d.length) toGuests({ t: 'xf', d });
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

  /* ───────── Seeing each other: a minifig head at each player's camera, and the part they're about to place ───────── */
  const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), noGeo = new THREE.BufferGeometry();
  function lookFor(slot) {
    let L = looks.get(slot);
    if (L) return L;
    const tint = TINT[slot], head = minifigHead(THREE, tint);
    const ghost = new THREE.Mesh(noGeo, new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.45, depthWrite: false, roughness: 0.35 }));
    const box = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: tint, transparent: true }));
    ghost.renderOrder = 9; box.renderOrder = 19;
    ghost.raycast = box.raycast = () => {};
    head.visible = ghost.visible = box.visible = false;
    g.scene.add(head, ghost, box);
    const tag = document.createElement('div');
    tag.className = 'peer-tag'; tag.textContent = nameOf(slot); tag.style.setProperty('--c', tint); tag.hidden = true;
    document.body.appendChild(tag);
    L = { head, ghost, box, tag };
    looks.set(slot, L);
    return L;
  }
  function dropLook(slot) {
    const L = looks.get(slot);
    if (!L) return;
    g.scene.remove(L.head, L.ghost, L.box);
    L.head.dispose(); L.ghost.material.dispose(); L.box.material.dispose(); L.tag.remove();
    looks.delete(slot);
  }
  function sendMe() {
    const c = g.camera.position, l = g.controls.target, at = g.ghostAt(), s = g.state;
    const m = { t: 'me', c: [r2(c.x), r2(c.y), r2(c.z)], l: [r2(l.x), r2(l.y), r2(l.z)], g: at ? [s.type.id, s.color, at.x, at.y, at.z, s.rot] : 0 };
    const text = JSON.stringify(m);
    if (text === lastMe) return;
    lastMe = text;
    if (net.guest) toHost(m); else toGuests({ ...m, s: me });
  }
  function drawPeers(dt) {
    for (const [slot, m] of seen) if (slot !== me && roster.has(slot)) drawPeer(lookFor(slot), m, dt);
  }
  function drawPeer(L, m, dt) {
    if (!nums(m.c, 3) || !nums(m.l, 3)) return;
    const { head, ghost, box, tag } = L;
    vA.fromArray(m.c);
    if (!L.placed) { head.position.copy(vA); L.placed = true; } else head.position.lerp(vA, 1 - Math.exp(-dt * 12));
    head.lookAt(vB.fromArray(m.l));
    head.visible = head.position.distanceToSquared(g.camera.position) > 16; // not when they look from right where we are
    const gh = Array.isArray(m.g) && m.g.length === 6 ? m.g : null, t = gh && g.TYPE_BY_ID[gh[0]];
    if (t && g.COLORS[gh[1]] && nums(gh.slice(2), 4)) {
      const [, color, x, y, z, rot] = gh, [ew, ed] = g.dims(t, rot & 3), H = t.h * g.PLATE;
      vA.set(x + ew / 2, y * g.PLATE, z + ed / 2);
      ghost.geometry = g.getGeo(t);
      ghost.material.color.set(g.COLORS[color].hex);
      if (ghost.visible) ghost.position.lerp(vA, Math.min(1, dt * 22)); else ghost.position.copy(vA);
      ghost.rotation.y = -(rot & 3) * Math.PI / 2;
      box.position.set(ghost.position.x, ghost.position.y + H / 2, ghost.position.z);
      box.scale.set(ew + 0.08, H + 0.08, ed + 0.08);
      ghost.visible = box.visible = true;
    } else ghost.visible = box.visible = false;
    vA.copy(head.position); vA.y += 1.5; vA.project(g.camera); // name tag just above their head
    const onScreen = head.visible && vA.z < 1 && Math.abs(vA.x) < 1.05 && Math.abs(vA.y) < 1.05;
    tag.hidden = !onScreen;
    if (onScreen) tag.style.transform = `translate(${((vA.x + 1) / 2) * innerWidth}px, ${((1 - vA.y) / 2) * innerHeight}px) translate(-50%, -100%)`;
  }

  /* ───────── Home WiFi: through server.js ───────── */
  function connectLan() {
    const want = +keep.get('brickyard-slot') || 0; // the same player number as before a reload, if it's free
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/mp${want ? `?want=${want}` : ''}`);
    const send = s => { if (ws.readyState === 1) ws.send(s); };
    ws.onopen = () => { tries = 0; lanSend = hostSend = send; };
    ws.onmessage = e => {
      const s = String(e.data);
      if (s.charCodeAt(0) === 64) { const nl = s.indexOf('\n'); deliver(s.slice(nl + 1), +s.slice(1, nl)); } // "@slot\n…": a guest's message for us, the host
      else deliver(s, 0);
    };
    ws.onclose = () => {
      const wasFull = mode === 'full', had = roster.size > 1;
      lanSend = null; alone();
      if (had) g.toast('Lost the connection. Playing on your own');
      show(wasFull ? 'full' : 'offline');
      setTimeout(connectLan, wasFull ? 5000 : Math.min(8000, 1000 * 2 ** tries++));
    };
  }

  /* ───────── Online: a 4-digit game code, then a link from each guest to the host, direct or through the relay ───────── */
  // Big messages (a whole world) go in pieces; each link is reliable and in order, so they arrive whole.
  function sendChunks(c, s) {
    if (!c.open) return;
    if (s.length <= CHUNK) { c.send(s); return; }
    const id = ++msgId, n = Math.ceil(s.length / CHUNK);
    for (let i = 0; i < n; i++) c.send(`\u0001${id},${i},${n},${s.slice(i * CHUNK, (i + 1) * CHUNK)}`);
  }
  function chunkReader(take) {
    const pieces = {};
    return d => {
      if (typeof d !== 'string') return;
      if (d.charCodeAt(0) !== 1) { take(d); return; }
      const a = d.indexOf(','), b = d.indexOf(',', a + 1), c = d.indexOf(',', b + 1);
      const id = d.slice(1, a), i = +d.slice(a + 1, b), n = +d.slice(b + 1, c), p = pieces[id] || (pieces[id] = { got: 0, bits: [] });
      if (p.bits[i] === undefined) { p.bits[i] = d.slice(c + 1); p.got++; }
      if (p.got === n) { delete pieces[id]; take(p.bits.join('')); }
    };
  }
  function teardown() {
    const p = pj, r = relay, links = [hostConn, rl, ...guestConns.values()];
    pj = null; relay = null; rl = null; hostConn = null; hostSend = null;
    guestConns.clear(); guestSends.clear(); guestTabs.clear();
    for (const c of links) if (c) try { c.close(); } catch (e) { /* already gone */ }
    if (r) r.close();
    if (p) try { p.destroy(); } catch (e) { /* already gone */ }
  }
  // Take the game's name on the PeerJS service so friends can find us. Resolves 'ok', 'taken' or 'error'.
  async function tryHost(c, my) {
    let Peer;
    try { Peer = await loadPeerJS(); } catch (e) { return 'error'; }
    if (my !== gen) return 'stale';
    return new Promise(resolve => {
      const p = pj = new Peer(ROOM_ID(c), PEER_OPTIONS);
      let opened = false;
      const fail = r => { clearTimeout(timer); if (pj === p) pj = null; try { p.destroy(); } catch (e) { /* gone */ } resolve(r); };
      const timer = setTimeout(() => { if (!opened) fail('error'); }, 20000);
      p.on('open', () => { if (pj !== p || opened) return; opened = true; clearTimeout(timer); listen(c, p); resolve('ok'); });
      p.on('connection', conn => acceptGuest(p, conn));
      p.on('disconnected', () => setTimeout(() => { if (pj === p && !p.destroyed) p.reconnect(); }, 2000)); // linked players carry on meanwhile
      p.on('error', err => {
        if (pj !== p) return;
        if (!opened) fail(err.type === 'unavailable-id' ? 'taken' : 'error');
        else if (err.type === 'unavailable-id') rejoin(c, { canHost: true }); // away so long the game went to another player: join them
      });
    });
  }
  // Friends whose networks can't reach ours come in through the relay, so listen there for as long as we host.
  function listen(c, p, tries = 0) {
    const r = relay = relayRoom(c, link => acceptGuest(p, link));
    r.on('open', () => { tries = 0; });
    r.on('close', () => {
      if (relay !== r) return; // we've stopped hosting
      relay = null;
      setTimeout(() => { if (pj === p && !relay) listen(c, p, tries + 1); }, Math.min(60000, 2000 * 2 ** tries));
    });
  }
  // A browser asks to come into our game, directly or through the relay: check its version, give it a player
  // number, send it everything.
  function acceptGuest(p, c) {
    let slot = 0;
    const refuse = (m, ms = 800) => {
      try { c.send(JSON.stringify(m)); } catch (e) { /* gone */ }
      setTimeout(() => { try { c.close(); } catch (e) { /* gone */ } }, ms);
    };
    const older = () => refuse({ t: 'say', m: 'has a newer version of Brickyard. Refresh this page to join' }, 2500);
    c.on('data', chunkReader(text => {
      let m; try { m = JSON.parse(text); } catch (e) { return; }
      if (slot) { if (guestConns.get(slot) === c && m) receive(m, slot); return; }
      if (pj !== p || net.guest || !m) return;
      if (m.t !== 'join') { older(); return; } // an older copy of the game, which doesn't introduce itself
      if (m.v !== PROTOCOL) { refuse({ t: 'old', v: PROTOCOL }); return; }
      const want = isSlot(m.want) ? m.want : 0, same = !!want && typeof m.tab === 'string' && guestTabs.get(want) === m.tab;
      slot = same ? want : freeSlot(want);
      if (!slot) { refuse({ t: 'full' }); return; }
      if (same) { const stale = guestConns.get(slot); guestConns.delete(slot); try { stale.close(); } catch (e) { /* gone */ } } // the same player on a fresh link
      guestConns.set(slot, c); guestTabs.set(slot, m.tab);
      guestSends.set(slot, Object.assign(s => sendChunks(c, s), { relayed: !!c.relay }));
      c.send(JSON.stringify({ t: 'hello', slot, hostSlot: me, roster: [...roster, slot] }));
      joined(slot, !!m.back || same);
    }));
    const gone = () => { if (slot && guestConns.get(slot) === c) left(slot); };
    c.on('close', gone);
    c.on('error', gone);
    setTimeout(() => { if (!slot && c.open) older(); }, 10000);
  }
  function freeSlot(want) {
    if (want && !roster.has(want)) return want;
    for (let s = 1; s <= MAX_PLAYERS; s++) if (!roster.has(s)) return s;
    return 0;
  }
  // Ask the game's host to let us in: over a direct link when our two networks allow one, otherwise through the
  // relay. Resolves 'ok', 'missing', 'full', 'old', 'oldhost', 'timeout' or 'nolink'.
  async function tryJoin(c, my, back) {
    let Peer = null;
    try { Peer = await loadPeerJS(); } catch (e) { /* no direct link then, but the relay can still get us in */ }
    if (my !== gen) return 'stale';
    return new Promise(resolve => {
      const p = pj = Peer && new Peer(undefined, PEER_OPTIONS), r = rl = relayLink(c); // the relay takes a moment to connect, so start now
      let settled = false, link = null, conn = null, wait = 0, again = 0;
      const timer = setTimeout(() => settle(conn ? 'nolink' : 'timeout'), 20000); // found the game but no way through, or no answer at all
      wait = setTimeout(viaRelay, p ? 8000 : 0); // PeerJS isn't answering
      const join = () => JSON.stringify({ t: 'join', v: PROTOCOL, want: +keep.get('brickyard-slot') || 0, tab, back: !!back });
      function settle(res, hello) {
        if (settled) return;
        settled = true; clearTimeout(timer); clearTimeout(wait); clearInterval(again);
        if (res === 'ok' && (link === r ? rl === r : pj === p)) {
          hostConn = link; hostSend = s => sendChunks(link, s); heardAt = performance.now();
          if (link === r) { if (pj === p) pj = null; if (p) try { p.destroy(); } catch (e) { /* gone */ } } // no direct link to keep
          else { rl = null; r.close(); }
          if (new URLSearchParams(location.search).has('room')) history.replaceState(null, '', location.pathname);
          welcome(hello);
          resolve('ok');
          return;
        }
        if (pj === p) pj = null;
        if (rl === r) rl = null;
        if (p) try { p.destroy(); } catch (e) { /* gone */ }
        r.close();
        resolve(res === 'ok' ? 'stale' : res);
      }
      // Hear the host's answer on link l, direct or through the relay.
      function use(l) {
        link = l;
        const read = chunkReader(text => {
          let m; try { m = JSON.parse(text); } catch (e) { return; }
          if (!m) return;
          if (settled) { if (hostConn === l) receive(m, 0); return; }
          if (link !== l) return;
          if (m.t === 'hello') settle('ok', m);
          else if (m.t === 'full') settle('full');
          else if (m.t === 'old') settle(m.v > PROTOCOL ? 'old' : 'oldhost');
          else if (m.t === 'ops' || m.t === 'xf') settle('oldhost'); // an older copy of the game sends the world without a hello
        });
        l.on('data', d => { if (hostConn === l) heardAt = performance.now(); read(d); }); // each piece of a big world counts
        const gone = () => {
          if (settled) { if (hostConn === l) hostLost(); }
          else if (link === l) { if (l === r) settle(conn ? 'nolink' : 'timeout'); else viaRelay(); }
        };
        l.on('close', gone);
        l.on('error', gone);
      }
      // No direct link: ask through the relay instead, and again every few seconds in case the host is between
      // connections to it.
      function viaRelay() {
        if (settled || link === r) return;
        clearTimeout(wait);
        if (conn) try { conn.close(); } catch (e) { /* gone */ } // so the host never gets a second request from us
        use(r);
        if (r.done) { settle(conn ? 'nolink' : 'timeout'); return; }
        const ask = () => r.send(join());
        if (r.open) ask(); else r.on('open', ask);
        again = setInterval(ask, 2500);
      }
      if (!p) return;
      p.on('open', () => {
        if (pj !== p || settled || link) return;
        conn = p.connect(ROOM_ID(c), { reliable: true, serialization: 'raw' });
        use(conn);
        conn.on('open', () => { if (link === conn) try { conn.send(join()); } catch (e) { /* closed again */ } });
        clearTimeout(wait);
        wait = setTimeout(() => { if (!conn.open) viaRelay(); }, DIRECT_WAIT);
      });
      p.on('error', err => { // no such game; or PeerJS can't be reached, or found no way through
        if (settled) return;
        if (err.type === 'peer-unavailable') settle('missing');
        else if (!(conn && conn.open)) viaRelay(); // an open direct link no longer needs PeerJS
      });
    });
  }
  const failText = (r, c) => ({
    missing: `There's no game ${c}. Check the number`,
    full: 'That game is full: it has 5 players already',
    old: 'That game has a newer version of Brickyard. Refresh this page, then join again',
    oldhost: 'That game has an older version of Brickyard. Ask the others to refresh their page',
    timeout: "Couldn't connect to that game. Try again",
    nolink: `Found game ${c} but couldn't link up with it. Try again`,
  })[r] || "Couldn't reach the online service. Is the internet on?";

  async function startGame() {
    const my = ++gen;
    teardown(); show('starting');
    for (let i = 0; i < 6; i++) {
      code = String(1000 + Math.floor(Math.random() * 9000));
      const r = await tryHost(code, my); if (my !== gen) return;
      if (r === 'ok') { nowHosting(1); return; }
      if (r !== 'taken') { giveUp(failText(r, code)); return; }
    }
    giveUp("Couldn't start a game. Try again in a moment");
  }
  function nowHosting(slot) {
    me = slot; hostSlot = slot;
    roster.clear(); roster.add(slot);
    keep.set('brickyard-host', code); keep.del('brickyard-join'); keep.set('brickyard-slot', String(slot));
    becomeHost(true);
    lastMe = '';
    show('in');
  }
  async function joinGame(c) {
    const my = ++gen;
    teardown();
    code = c; show('joining');
    keep.del('brickyard-slot'); // a different game: take whichever player number is free
    const r = await tryJoin(c, my, false); if (my !== gen) return;
    if (r === 'ok') g.toast(`Joined game ${c}`);
    else giveUp(failText(r, c));
  }
  // Our link to the host broke: they left, or a network hiccuped. Play on alone for a moment, then find the
  // game again. The host may still be there; if not, the player with the lowest number starts the game again
  // under the same code (waiting least) and the others join them.
  function hostLost() {
    if (leaving) return;
    const order = [...roster].filter(s => s !== hostSlot).sort((a, b) => a - b), rank = Math.max(0, order.indexOf(me));
    alone();
    g.toast(`Lost touch with game ${code}. Reconnecting…`);
    rejoin(code, { canHost: true, delay: 300 + rank * 1500 });
  }
  // Get back into game `c` after a reload or a lost link. canHost: if nobody has the game any more, start it
  // again under the same code (the host left, or it was ours before a reload); hostFirst: try that first.
  async function rejoin(c, { canHost = false, hostFirst = false, delay = 0 } = {}) {
    const my = ++gen;
    teardown();
    code = c; show('rejoining');
    if (delay) { await wait(delay); if (my !== gen) return; }
    let hostNext = hostFirst;
    for (let i = 0; i < 24; i++) {
      if (hostNext) {
        const r = await tryHost(c, my); if (my !== gen) return;
        if (r === 'ok') { nowHosting(me || +keep.get('brickyard-slot') || 1); g.toast(`Back in game ${c}`); return; }
        hostNext = false; // someone has it: join them
        await wait(r === 'taken' ? 400 : 2500); if (my !== gen) return;
        continue;
      }
      const r = await tryJoin(c, my, true); if (my !== gen) return;
      if (r === 'ok') { g.toast(`Back in game ${c}`); return; }
      if (r === 'full' || r === 'old' || r === 'oldhost') { giveUp(failText(r, c)); return; }
      if (r === 'missing' && canHost) { hostNext = true; continue; }
      await wait(2500); if (my !== gen) return;
    }
    giveUp(`Couldn't get back into game ${c}`);
  }
  function giveUp(message) {
    if (message) g.toast(message);
    leaveGame();
  }
  function leaveGame() {
    gen++;
    teardown();
    code = ''; me = 0; hostSlot = 0;
    alone();
    keep.del('brickyard-host'); keep.del('brickyard-join'); keep.del('brickyard-slot');
    show('idle');
  }
  // Pick up where this tab left off: a shared link (?room=1234) joins, a reload rejoins or re-hosts its game.
  function resume() {
    const fromLink = new URLSearchParams(location.search).get('room'), hosted = keep.get('brickyard-host'), was = keep.get('brickyard-join');
    if (/^\d{4}$/.test(fromLink || '') && fromLink !== hosted && fromLink !== was) joinGame(fromLink);
    else if (hosted) rejoin(hosted, { canHost: true, hostFirst: true });
    else if (was) rejoin(was);
    else show('idle');
  }
  // A host that vanishes without a goodbye (a phone locked, a browser closed in a hurry) leaves its links open
  // for a long time, so the host says something every 2 seconds and guests take 10 silent seconds as gone.
  setInterval(() => {
    if (lan) return; // play-together.bat's server keeps watch there
    if (!net.guest && guestConns.size) toGuests({ t: 'hb' });
    else if (net.guest && hostConn && performance.now() - heardAt > 10000) hostLost();
  }, 2000);
  // Leaving the page: say goodbye at once, so the others don't wait to notice. (Back/forward can bring it back.)
  addEventListener('pagehide', () => { leaving = true; if (!lan) teardown(); });
  addEventListener('pageshow', e => { leaving = false; if (e.persisted && !lan) { alone(); resume(); } });

  /* ───────── The "Play together" chip and its panel ───────── */
  const ui = {
    btn: $('mpBtn'), text: $('mpText'), dots: $('mpBtn').querySelector('.dots'), note: $('mpNote'), addr: $('mpAddr'), who: $('mpWho'),
    copy: $('mpCopy'), start: $('mpStart'), joinForm: $('mpJoinForm'), code: $('mpCode'), leave: $('mpLeave'), foot: $('mpFoot'),
  };
  // Home WiFi: the address other devices open, on the network play-together.bat is using.
  const onThisPc = /^(localhost|127\.|\[::1\]$)/.test(location.hostname), net0 = lan && info.addresses[0];
  const lanUrl = lan && (onThisPc ? net0 && `http://${net0.address}:${info.port}` : location.origin);
  const onNet = net0 ? ` connected to ${net0.name}` : ' on the same network';
  ui.btn.hidden = false;
  ui.btn.onclick = () => g.togglePop('mp');
  ui.start.onclick = () => startGame();
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
    if (navigator.share) navigator.share({ title: 'Brickyard', text: `Come build with me in Brickyard! Game ${code}`, url }).catch(() => {});
    else copyText(url).then(() => g.toast('Invite link copied. Send it to your friends'), () => g.toast(`Couldn't copy. The code is ${code}`));
  };
  function show(m) { mode = m; updateUi(); }
  function updateUi() {
    const n = roster.size, inGame = mode === 'in', together = inGame && n > 1, room = n < MAX_PLAYERS;
    const slots = [...roster].sort((a, b) => a - b);
    ui.btn.dataset.state = inGame ? (together ? 'together' : 'alone') : mode;
    ui.text.textContent = together ? `${n} players` : inGame ? (lan ? 'Waiting for friends' : `Game ${code}`) : {
      connecting: 'Connecting…', offline: 'Offline', full: 'Game is full', idle: 'Play together', starting: 'Starting…', joining: 'Joining…', rejoining: 'Reconnecting…',
    }[mode] || '';
    ui.dots.replaceChildren(...(inGame ? slots : [0, 0]).map(s => { const i = document.createElement('i'); if (s) i.style.setProperty('--c', TINT[s]); return i; }));
    ui.who.hidden = !inGame;
    ui.who.replaceChildren(...(inGame ? slots : []).map(s => {
      const b = document.createElement('span');
      b.style.setProperty('--c', TINT[s]); b.textContent = s === me ? `${nameOf(s)} (you)` : nameOf(s);
      return b;
    }));
    if (lan) {
      ui.note.textContent = inGame
        ? (room ? `You're ${nameOf(me)}. ${together ? 'More friends' : 'Up to 4 friends'} can join: they open this on a device${onNet}:` : `You're ${nameOf(me)}. The game is full: 5 players.`)
        : {
          connecting: 'Connecting to the play-together window…',
          offline: "Can't reach the play-together window. Is it still open? Trying again…",
          full: 'Five people are already playing. You’ll join when one of them leaves.',
        }[mode] || '';
      ui.addr.hidden = !(inGame && room); ui.addr.textContent = lanUrl || 'Only this computer can play. Run play-together.bat again once you’re on a network.';
      ui.copy.hidden = !(inGame && room && lanUrl); ui.copy.textContent = 'Copy address';
      ui.start.hidden = ui.joinForm.hidden = ui.leave.hidden = true;
      ui.foot.textContent = 'Keep the play-together window open while you play. Undo is shared: it takes back the last change, whoever made it.';
      return;
    }
    ui.note.textContent = inGame
      ? (!together ? 'Your game is ready. Friends can join from anywhere, on any WiFi or mobile data: send them an invite, or they tap Play together and type this code:'
        : room ? `You're ${nameOf(me)}. More friends can join with this code, up to 5 players:` : `You're ${nameOf(me)}. The game is full: 5 players.`)
      : {
        idle: 'Build with up to 4 friends on any iPad, phone or computer. They can be anywhere: everyone just needs the internet. Start a game, or type a friend’s game code:',
        starting: 'Starting a game…', joining: `Joining game ${code}…`, rejoining: `Getting back into game ${code}…`,
      }[mode] || '';
    ui.addr.hidden = !inGame; ui.addr.textContent = code; ui.addr.classList.add('code');
    ui.copy.hidden = !(inGame && room); ui.copy.textContent = navigator.share ? 'Invite friends' : 'Copy invite link';
    ui.start.hidden = ui.joinForm.hidden = mode !== 'idle';
    ui.leave.hidden = mode === 'idle';
    ui.leave.textContent = inGame ? (together ? 'Leave game' : 'End game') : 'Cancel';
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
  resume();
}

// A LEGO minifig head in a player's color, facing where they're looking.
let headParts = null;
function minifigHead(THREE, tint) {
  headParts ||= {
    face: new THREE.CylinderGeometry(0.5, 0.5, 0.62, 32), stud: new THREE.CylinderGeometry(0.26, 0.26, 0.16, 24),
    eye: new THREE.SphereGeometry(0.055, 12, 8), smile: new THREE.TorusGeometry(0.17, 0.022, 8, 24, Math.PI),
  };
  const head = new THREE.Group(), skin = new THREE.MeshStandardMaterial({ color: tint, roughness: 0.35 }), ink = new THREE.MeshBasicMaterial({ color: 0x1b2a34 });
  const stud = new THREE.Mesh(headParts.stud, skin);
  stud.position.y = 0.39;
  head.add(new THREE.Mesh(headParts.face, skin), stud);
  for (const x of [-0.16, 0.16]) { const e = new THREE.Mesh(headParts.eye, ink); e.position.set(x, 0.08, 0.49); e.scale.z = 0.4; head.add(e); }
  const smile = new THREE.Mesh(headParts.smile, ink);
  smile.rotation.z = Math.PI; smile.position.set(0, -0.02, 0.495);
  head.add(smile);
  head.traverse(o => { o.raycast = () => {}; });
  head.scale.setScalar(2.2); // big enough to spot from across the baseplate
  head.dispose = () => { skin.dispose(); ink.dispose(); };
  return head;
}
