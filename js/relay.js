// When two players' networks won't let their browsers link up directly (a phone on mobile data and a computer on
// home WiFi often won't), the game goes through a relay instead: HiveMQ's free public message service (an MQTT
// broker). Each browser connects out to it the way it opens a website, so it gets through from any network.
// Messages take about a fifth of a second each way through it, which is why multiplayer.js tries a direct link first.
// Only the game goes through it, the bricks and where everyone is looking, no names; still, like anything sent
// through a public service, someone who knew where to look could watch it.

const BROKER = 'wss://broker.hivemq.com:8884/mqtt';
const topic = (code, to) => `brickyard-game/${code}/${to}`; // "h": to the host, "g": from the host to its guests
const newId = () => Math.random().toString(36).slice(2, 10);
// Each message starts "from to kind\n", then the game's own text. to: a player's id, or * for all of them.
// kind: j asks to join, m is a message for the game, p says "still here", x says "gone".

/* ───────── Host: hear the guests who come through the relay ───────── */
// Each guest becomes a link that works like a direct one: open, send(text), close(), and 'data' and 'close'
// events; onLink gets it before its first message. The room says 'open' once it's listening and 'close' when its
// connection drops. room.everyone sends to all its guests at once; room.size is how many there are.
export function relayRoom(code, onLink) {
  const hid = newId(), links = new Map(); // guest id → link
  const room = events({ open: false, get size() { return links.size; } });
  const say = (to, kind, text = '') => mq.publish(topic(code, 'g'), `${hid} ${to} ${kind}\n${text}`);
  function drop(gid, tell) {
    const l = links.get(gid);
    if (!l) return;
    links.delete(gid); l.open = false;
    if (tell) say(gid, 'x');
    l.emit('close');
  }
  const mq = mqtt(topic(code, 'h'), { topic: topic(code, 'g'), text: `${hid} * x\n` }, {
    open() { room.open = true; room.emit('open'); },
    message(text) {
      const nl = text.indexOf('\n'), [gid, to, kind] = text.slice(0, nl).split(' ');
      if (to !== '*' && to !== hid) return; // for whoever hosted this code before us
      let l = links.get(gid);
      if (!l) {
        if (kind !== 'j') return; // someone from an earlier game with this code
        l = events({ relay: true, open: true, send: s => { if (l.open) say(gid, 'm', s); }, close: () => drop(gid, true) });
        links.set(gid, l);
        onLink(l);
      }
      l.heard = performance.now();
      if (kind === 'x') drop(gid, false);
      else if (kind === 'j' || kind === 'm') l.emit('data', text.slice(nl + 1));
    },
    end() {
      clearInterval(sweep);
      room.open = false;
      for (const gid of [...links.keys()]) drop(gid, false);
      room.emit('close');
    },
  });
  // A guest that stops saying it's still here (a phone locked, a browser closed in a hurry) has gone.
  const sweep = setInterval(() => { for (const [gid, l] of links) if (performance.now() - l.heard > 20000) drop(gid, true); }, 4000);
  room.everyone = { get open() { return room.open; }, send: s => say('*', 'm', s) };
  room.close = () => { if (room.open) say('*', 'x'); mq.close(); };
  return room;
}

/* ───────── Guest: a link to the host through the relay ───────── */
// Works like a direct link: 'open' once it's ready, then send(text), close(), and 'data' and 'close' events;
// done is true once it has closed. Until the host first answers, what we send asks to join, and that answer tells
// us which host is ours.
export function relayLink(code) {
  const gid = newId(), l = events({ relay: true, open: false, done: false });
  let host = '';
  const say = (kind, text = '') => mq.publish(topic(code, 'h'), `${gid} ${host || '*'} ${kind}\n${text}`);
  function end(tell) {
    if (l.done) return;
    clearInterval(ping);
    if (tell && l.open) say('x');
    l.open = false; l.done = true;
    mq.close();
    l.emit('close');
  }
  const mq = mqtt(topic(code, 'g'), { topic: topic(code, 'h'), text: `${gid} * x\n` }, {
    open() { l.open = true; l.emit('open'); },
    message(text) {
      const nl = text.indexOf('\n'), [from, to, kind] = text.slice(0, nl).split(' ');
      if (to === gid && !host) host = from;
      if (!host || from !== host || (to !== gid && to !== '*')) return;
      if (kind === 'x') end(false);
      else if (kind === 'm') l.emit('data', text.slice(nl + 1));
    },
    end: () => end(false),
  });
  const ping = setInterval(() => { if (l.open && host) say('p'); }, 4000);
  l.send = s => { if (l.open) say(host ? 'm' : 'j', s); };
  l.close = () => end(true);
  return l;
}

// A tiny event emitter: on(name, fn) and emit(name, value).
function events(o) {
  const fns = {};
  o.on = (name, fn) => { (fns[name] ||= []).push(fn); };
  o.emit = (name, v) => { for (const fn of fns[name] || []) fn(v); };
  return o;
}

/* ───────── Just enough MQTT (version 3.1.1, over a WebSocket) ───────── */
// Connects, listens on one topic and publishes. Everything goes at QoS 0, which over one connection arrives
// whole and in order, or not at all once the connection drops. `will` is what the broker says for us if we vanish.
// on.open: listening; on.message(text); on.end: the connection is gone, or never came up.
const enc = new TextEncoder(), dec = new TextDecoder();
const str = s => { const b = enc.encode(s), out = new Uint8Array(b.length + 2); out[0] = b.length >> 8; out[1] = b.length & 255; out.set(b, 2); return out; };
function packet(type, ...parts) {
  const n = parts.reduce((sum, p) => sum + p.length, 0), head = [type];
  let x = n;
  do { head.push((x % 128) | (x >= 128 ? 128 : 0)); x = Math.floor(x / 128); } while (x);
  const out = new Uint8Array(head.length + n);
  out.set(head);
  let at = head.length;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
function mqtt(listen, will, on) {
  let ws = null, buf = new Uint8Array(0), up = false, ended = false, pingAt = 0, heardAt = 0;
  const send = bytes => { if (ws && ws.readyState === 1) ws.send(bytes); };
  function end() {
    if (ended) return;
    ended = true; up = false;
    clearTimeout(slow); clearInterval(beat);
    if (ws && ws.readyState === 0) ws.onopen = () => ws.close(); // still connecting: hang up once through, without an error
    else if (ws) try { ws.close(); } catch (e) { /* gone */ }
    on.end();
  }
  const slow = setTimeout(end, 20000); // couldn't get through
  // Ping now and then so the broker keeps us, and notice a connection that died without a word (a phone that
  // changed networks): nothing heard back by the next ping.
  const beat = setInterval(() => {
    if (!up) return;
    if (heardAt < pingAt && performance.now() - pingAt > 10000) { end(); return; }
    pingAt = performance.now(); send(Uint8Array.of(0xc0, 0));
  }, 15000);
  try { ws = new WebSocket(BROKER, 'mqtt'); } catch (e) { setTimeout(end); }
  if (ws) {
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => send(packet(0x10, Uint8Array.of(0, 4, 77, 81, 84, 84, 4, 0x06, 0, 60), // MQTT 3.1.1, a clean session with a will, 60 s keep-alive
      str(`brickyard-${newId()}${newId()}`), str(will.topic), str(will.text)));
    ws.onmessage = e => {
      heardAt = performance.now();
      const bytes = new Uint8Array(e.data);
      if (buf.length) { const all = new Uint8Array(buf.length + bytes.length); all.set(buf); all.set(bytes, buf.length); buf = all; } else buf = bytes;
      for (;;) { // a packet can come split over several messages, or several in one
        if (ended) return; // a message just now hung up
        let len = 0, mul = 1, i = 1, b;
        do { if (i >= buf.length) return; b = buf[i++]; len += (b & 127) * mul; mul *= 128; } while (b & 128);
        if (buf.length < i + len) return;
        const type = buf[0] >> 4, body = buf.subarray(i, i + len);
        buf = buf.subarray(i + len);
        if (type === 2) { if (body[1]) { end(); return; } send(packet(0x82, Uint8Array.of(0, 1), str(listen), Uint8Array.of(0))); } // let in: listen
        else if (type === 9) { if (body[2] & 0x80) { end(); return; } clearTimeout(slow); up = true; on.open(); }                 // listening
        else if (type === 3) on.message(dec.decode(body.subarray(2 + ((body[0] << 8) | body[1]))));                                // a message
      }
    };
    ws.onclose = ws.onerror = end;
  }
  return {
    publish(t, text) { if (up) send(packet(0x30, str(t), enc.encode(text))); },
    close() { if (!ended) { send(Uint8Array.of(0xe0, 0)); end(); } }, // a goodbye, so the broker keeps our will to itself
  };
}
