// Battles. When two or more players are in a game, the host can start one. Everyone gets a figure of their own in
// an area of the board, and first builds a fort around it with a few bricks. Then everyone gets a few throws to
// knock the others' figures out: a hard hit costs a heart, TNT going off right next to one costs two. The last figure standing
// wins, or the one with the most hearts once the throws or the time run out.
// The host keeps the score and the rules and sends them to everyone as "bt" messages; multiplayer.js makes one of
// these and passes the messages along.

const HEARTS = 3, THROWS = 10, BRICKS = 30;
const BUILD_TIME = 60000, FIGHT_TIME = 240000; // ms
const RING = 19, AREA = 7; // figures stand this far from the middle of the board, each in an area this far each way
const HURT_GAP = 450;      // ms: one knock is one hit, however many corners touch
const AWAY_TIME = 20000;   // ms a player who dropped out has to come back before their figure is out

// mp: me(), roster(), host(), send(m) to every guest, sendTo(slot, m), toHost(m), nameOf(slot), tint(slot), updated()
export function makeBattle(g, mp) {
  const { THREE } = g, T = g.TYPE_BY_ID, $ = id => document.getElementById(id);
  // phase: off, build, fight or over. ps: slot → { fig, hp, th, br, rd, out, away }, the player's figure (a brick id),
  // hearts, throws and bricks left, whether they're ready, out, or dropped out for now. areas: slot → its middle.
  let phase = 'off', ends = 0, areas = {}, ps = {}, winners = [];
  let before = null; // host: the world from before the battle, to go back to afterwards
  let lastThrow = 0, quietSince = 0, clockAt = 0;
  const lastHurt = {}, awaySince = {};
  const ui = {
    box: $('battle'), title: $('btTitle'), time: $('btTime'), hearts: $('btHearts'), throws: $('btThrows'), bricks: $('btBricks'),
    ready: $('btReady'), again: $('btAgain'), end: $('btEnd'),
  };
  ui.ready.onclick = () => { if (mp.host()) ready(mp.me()); else mp.toHost({ t: 'cmd', c: 'ready' }); };
  ui.again.onclick = () => start();
  ui.end.onclick = () => end();

  const players = () => Object.keys(ps).map(Number);
  const standing = () => players().filter(s => !ps[s].out);
  const colorOf = slot => g.COLORS.findIndex(c => c.hex.toLowerCase() === mp.tint(slot).toLowerCase());
  const facing = (x, z) => Math.abs(z) >= Math.abs(x) ? (z > 0 ? 2 : 0) : (x > 0 ? 1 : 3); // a figure's turn, to face the middle
  function inArea(slot, d) { // is every cell of this part inside the player's area?
    const a = areas[slot], t = T[d.type];
    if (!a || !t || ![d.x, d.z].every(Number.isInteger)) return false;
    const [ew, ed] = g.dims(t, d.rot & 3);
    return d.x >= a.x - AREA && d.x + ew <= a.x + AREA && d.z >= a.z - AREA && d.z + ed <= a.z + AREA;
  }

  /* ───────── Host: the rules ───────── */
  function start() {
    const who = [...mp.roster()].sort((a, b) => a - b);
    if (who.length < 2) { g.toast('A battle needs at least 2 players'); return; }
    if (!before) before = { world: g.worldSnapshot(), base: g.state.base };
    areas = {}; ps = {}; winners = [];
    const figs = who.map((s, i) => { // around a circle, everyone facing the middle
      const a = -Math.PI / 2 + 2 * Math.PI * i / who.length, x = Math.round(RING * Math.cos(a)), z = Math.round(RING * Math.sin(a)), id = g.newId();
      areas[s] = { x, z };
      ps[s] = { fig: id, hp: HEARTS, th: THROWS, br: BRICKS, rd: false, out: false, away: false };
      return { id, type: 'fig', color: colorOf(s), x: x - 1, y: 0, z: z - 1, rot: facing(x, z) };
    });
    g.commit({ kind: 'world', before: g.worldSnapshot(), after: { bricks: figs, broken: [], debris: [] } });
    phase = 'build'; ends = performance.now() + BUILD_TIME;
    changed();
  }
  function ready(slot) {
    const p = ps[slot];
    if (phase !== 'build' || !p || p.out) return;
    p.rd = !p.rd;
    if (standing().every(s => ps[s].rd)) fight(); else changed();
  }
  function fight() {
    phase = 'fight'; ends = performance.now() + FIGHT_TIME; lastThrow = performance.now(); quietSince = 0;
    for (const s of players()) ps[s].rd = false;
    g.sfx('fight');
    changed();
  }
  // A figure was hit (see figHit and blast in brickyard.html). Figures can't be hurt while everyone's still building.
  function hurt(id, n) {
    if (phase !== 'fight' || !n) return;
    const slot = players().find(s => ps[s].fig === id), p = ps[slot];
    if (!p || p.out) return;
    const now = performance.now();
    if (now - (lastHurt[slot] || 0) < HURT_GAP) return;
    lastHurt[slot] = now;
    p.hp = Math.max(0, p.hp - n);
    if (p.hp) g.sfx('hurt'); else { p.out = true; g.knockOut(id); g.sfx('out'); }
    changed();
    settle();
  }
  function settle() { // one figure (or none) left standing: that's the winner
    if (phase !== 'build' && phase !== 'fight') return;
    const left = standing();
    if (left.length <= 1) over(left);
  }
  function over(ws) { phase = 'over'; winners = ws; g.sfx('win'); changed(); }
  const mostHearts = () => { const left = standing(), top = Math.max(0, ...left.map(s => ps[s].hp)); return left.filter(s => ps[s].hp === top); };
  function tick(now) {
    for (const s of players()) { // someone who dropped out and didn't come back is out
      const p = ps[s];
      if (!p.away || p.out) continue;
      awaySince[s] ??= now; // (a new host only knows they're away)
      if (now - awaySince[s] > AWAY_TIME) { p.out = true; if (g.bricks.has(p.fig)) g.knockOut(p.fig); changed(); settle(); }
    }
    if (phase === 'build' && now >= ends) fight();
    else if (phase === 'fight') {
      if (now >= ends) { over(mostHearts()); return; }
      if (standing().some(s => ps[s].th)) { quietSince = 0; return; }
      // Nobody has a throw left: once everything has landed (or after a while), most hearts wins.
      const busy = [...g.debris.values()].some(c => c.body.sleepState !== 2);
      if (busy && now - lastThrow < 12000) quietSince = 0;
      else if (!quietSince) quietSince = now;
      else if (now - quietSince > 1500) over(mostHearts());
    }
  }
  function end() { // back to building: the world from before the battle
    if (before) { g.commit({ kind: 'world', before: g.worldSnapshot(), after: before.world }); g.setBase(before.base); }
    before = null; phase = 'off'; areas = {}; ps = {}; winners = [];
    changed();
  }
  function left(slot) {
    const p = ps[slot];
    if (!p || p.out || phase === 'off' || phase === 'over') return;
    p.away = true; awaySince[slot] = performance.now();
    changed();
  }
  function back(slot) { const p = ps[slot]; if (p && p.away) { p.away = false; delete awaySince[slot]; changed(); } }
  // May this player do this now? Returns why not, or '' when they may. spend: take a brick or a throw for it
  // (the host does; a guest only checks before asking the host).
  function allow(slot, what, info, spend) {
    if (phase === 'off' || what === 'paint') return '';
    if (what === 'undo' || what === 'world' || what === 'detonate') return 'Not during a battle';
    if (phase === 'over') return 'The battle is over';
    const p = ps[slot];
    if (!p) return 'You’re watching this battle';
    if (p.out) return 'You’re out. Watch the others';
    if (what === 'build') {
      const t = T[info.type];
      if (!t || t.kind === 'fig') return 'You can’t build that';
      if (t.kind === 'hole') return 'No black holes in a battle';
      if (!p.br) return 'No bricks left';
      if (!inArea(slot, info)) return 'Build inside your area';
      if (spend) { p.br--; changed(); }
    } else if (what === 'throw') {
      if (phase === 'build') return 'Throwing starts when the fight does';
      if (!p.th) return 'No throws left';
      if (spend) { p.th--; lastThrow = performance.now(); changed(); }
    } else if (what === 'erase') {
      const b = g.bricks.get(info.id);
      if (phase !== 'build') return 'No removing during the fight';
      if (!b || b.data.type === 'fig' || !inArea(slot, b.data)) return 'You can only remove bricks in your area';
      if (spend) { p.br = Math.min(BRICKS, p.br + 1); changed(); }
    }
    return '';
  }
  // Where this player's throws start: above their own figure and over the top of their fort.
  function launchPoint(slot) {
    const p = ps[slot], a = areas[slot];
    if ((phase !== 'build' && phase !== 'fight') || !p || p.out || !a) return null;
    let top = 0;
    for (const b of g.bricks.values()) if (inArea(slot, b.data)) top = Math.max(top, (b.data.y + T[b.data.type].h) * g.PLATE);
    return new THREE.Vector3(a.x, Math.max(top + 2.5, 7), a.z);
  }

  /* ───────── Everyone: the score, and how it looks ───────── */
  const snap = () => ({ p: phase, l: Math.max(0, Math.round(ends - performance.now())), a: areas, s: ps, w: winners });
  function changed() { if (mp.host()) mp.send({ t: 'bt', b: snap() }); show(); }
  function sendTo(slot) { if (phase !== 'off') mp.sendTo(slot, { t: 'bt', b: snap() }); }
  function load(b) { // guest: the host's latest
    if (!b || typeof b !== 'object') return;
    phase = ['build', 'fight', 'over'].includes(b.p) ? b.p : 'off';
    ends = performance.now() + (Number(b.l) || 0);
    areas = b.a && typeof b.a === 'object' ? b.a : {};
    ps = b.s && typeof b.s === 'object' ? b.s : {};
    winners = Array.isArray(b.w) ? b.w.map(Number) : [];
    show();
  }
  function stop() { // we've left the game, or lost it: no battle here any more
    phase = 'off'; areas = {}; ps = {}; winners = []; before = null;
    show();
  }
  const name = s => (s === mp.me() ? 'You' : mp.nameOf(s));
  function result() {
    if (winners.length !== 1) return 'It’s a draw!';
    return winners[0] === mp.me() ? 'You win! \u{1F3C6}' : `${mp.nameOf(winners[0])} wins! \u{1F3C6}`;
  }
  let shown = { phase: 'off', ps: {} }; // what the screen showed last, to notice what's new
  function show() {
    const me = mp.me(), mine = ps[me];
    for (const s of players()) { // news about each player
      const was = shown.ps[s], now = ps[s];
      if (!was) continue;
      if (now.hp < was.hp) popHurt(s, was.hp - now.hp);
      if (now.out && !was.out) g.toast(s === me ? 'You’re out! Watch the others' : `${mp.nameOf(s)} is out!`);
    }
    if (phase !== shown.phase) {
      if (phase === 'build' && mine) lookHome();
      if (phase === 'build') g.toast(mine ? `Battle! Build a fort around your figure: ${BRICKS} bricks, inside your area` : 'A battle is starting. You’re watching this one');
      else if (phase === 'fight') g.toast(mine ? `Fight! You have ${THROWS} throws` : 'Fight!');
      else if (phase === 'over') g.toast(result());
    }
    shown = { phase, ps: JSON.parse(JSON.stringify(ps)) };
    document.body.classList.toggle('battling', phase !== 'off');
    ui.box.hidden = phase === 'off';
    if (phase !== 'off') {
      const fighting = phase === 'fight' && mine && !mine.out;
      ui.title.textContent = phase === 'build' ? (mine ? 'Build your fort' : 'Battle starting') : phase === 'over' ? result() : mine && mine.out ? 'You’re out' : 'Fight!';
      ui.time.hidden = phase === 'over';
      ui.hearts.hidden = !mine || phase === 'over';
      if (mine) ui.hearts.innerHTML = '♥'.repeat(mine.hp) + `<i>${'♥'.repeat(HEARTS - mine.hp)}</i>`;
      ui.throws.hidden = !fighting;
      if (mine) ui.throws.innerHTML = `${mine.th}<small>throws</small>`;
      ui.bricks.hidden = !mine || mine.out || phase === 'over';
      if (mine) ui.bricks.innerHTML = `${mine.br}<small>bricks</small>`;
      ui.ready.hidden = !mine || mine.out || phase !== 'build';
      if (mine) ui.ready.textContent = mine.rd ? 'Ready ✓' : 'Ready';
      ui.again.hidden = ui.end.hidden = phase !== 'over' || !mp.host();
    }
    clockAt = 0;
    drawAreas();
    if (phase === 'off') for (const [s, tag] of tags) { tag.remove(); tags.delete(s); }
    mp.updated();
  }
  function lookHome() { // a battle starts: look at our own area from behind our figure, toward the others
    const a = areas[mp.me()], L = a && Math.hypot(a.x, a.z);
    if (!a) return;
    g.controls.target.set(a.x, 1, a.z);
    g.camera.position.set(a.x + a.x / (L || 1) * 13, 14, a.z + a.z / (L || 1) * 13);
    g.controls.update();
  }
  const clock = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

  // Each player's area, outlined on the board in their color; ours is tinted too.
  let areaGroup = null, areaKey = '';
  function drawAreas() {
    const key = phase === 'off' ? '' : JSON.stringify(areas) + mp.me();
    if (key === areaKey) return;
    areaKey = key;
    if (areaGroup) { g.scene.remove(areaGroup); areaGroup.traverse(o => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } }); areaGroup = null; }
    if (!key) return;
    areaGroup = new THREE.Group();
    for (const [s, a] of Object.entries(areas)) {
      const color = mp.tint(+s), side = 2 * AREA, line = new THREE.MeshBasicMaterial({ color });
      for (const [w, d, x, z] of [[side, 0.16, a.x, a.z - AREA], [side, 0.16, a.x, a.z + AREA], [0.16, side, a.x - AREA, a.z], [0.16, side, a.x + AREA, a.z]]) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(w, 0.26, d), line);
        bar.position.set(x, 0.1, z); bar.raycast = () => {};
        areaGroup.add(bar);
      }
      if (+s === mp.me()) {
        const fill = new THREE.Mesh(new THREE.PlaneGeometry(side, side).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.18, depthWrite: false }));
        fill.position.set(a.x, 0.02, a.z); fill.raycast = () => {};
        areaGroup.add(fill);
      }
    }
    g.scene.add(areaGroup);
  }

  // Name tags with hearts over the figures still standing, and a red "−1 ♥" when one is hit.
  const tags = new Map(), v = new THREE.Vector3();
  function screenAt(slot, out) { // where a figure's head is on screen, or null
    const f = g.bricks.get(ps[slot] && ps[slot].fig);
    if (!f) return null;
    v.set(f.data.x + 1, (f.data.y + T.fig.h) * g.PLATE + 0.7, f.data.z + 1).project(g.camera);
    if (v.z > 1 || Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05) return null;
    out.x = (v.x + 1) / 2 * innerWidth; out.y = (1 - v.y) / 2 * innerHeight;
    return out;
  }
  function placeTags() {
    for (const [s, tag] of tags) if (!ps[s] || phase === 'off') { tag.remove(); tags.delete(s); }
    const at = { x: 0, y: 0 };
    for (const s of players()) {
      let tag = tags.get(s);
      if (!tag) {
        tag = document.createElement('div'); tag.className = 'fig-tag'; tag.style.setProperty('--c', mp.tint(s));
        document.body.appendChild(tag); tags.set(s, tag);
      }
      const p = ps[s], text = `${name(s)} <span class="hearts">${'♥'.repeat(p.hp)}<i>${'♥'.repeat(HEARTS - p.hp)}</i></span>${p.away ? ' · away' : ''}`;
      if (tag.dataset.text !== text) { tag.dataset.text = text; tag.innerHTML = text; }
      const ok = !p.out && screenAt(s, at);
      tag.hidden = !ok;
      if (ok) tag.style.transform = `translate(${at.x}px, ${at.y}px) translate(-50%, -100%)`;
    }
  }
  function popHurt(slot, n) {
    const at = screenAt(slot, { x: 0, y: 0 }) || (() => { // a figure just knocked out: where it stood
      const a = areas[slot]; if (!a) return null;
      v.set(a.x, 4, a.z).project(g.camera);
      return v.z < 1 ? { x: (v.x + 1) / 2 * innerWidth, y: (1 - v.y) / 2 * innerHeight } : null;
    })();
    if (!at) return;
    const el = document.createElement('div');
    el.className = 'hurt-pop'; el.textContent = `−${n} ♥`;
    el.style.left = at.x + 'px'; el.style.top = at.y + 'px';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1100);
  }

  function frame(dt, now) {
    if (phase === 'off') return;
    if (mp.host()) tick(now);
    if (now - clockAt > 200) { clockAt = now; ui.time.textContent = clock(ends - now); }
    placeTags();
  }

  return {
    start, ready, end, hurt, allow, launchPoint, load, sendTo, left, back, stop, frame,
    get on() { return phase !== 'off'; },
  };
}
