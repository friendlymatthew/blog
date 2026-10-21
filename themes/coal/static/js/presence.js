// Readers on the same page see each other's cursors as little hands. Wave your cursor side to side
// near someone who's also waving to high five; both circle around the same spot to hug.
//
// Positions are in page coordinates: x from the middle of the page (the column is centered, so this
// lines up across window sizes), y from the top of the page. The presence server (presence/ in this
// repo) passes them between readers of the same page and decides when two people meet.
(function () {
  const script = document.currentScript;
  const SERVER = script && script.dataset.server;
  if (!SERVER || !window.WebSocket) return;

  // --- Wave detection tuning ---
  const SWING_MIN = 10;       // px a swing must travel before a change of direction counts
  const WAVE_WINDOWS = [600, 850, 1100, 1500]; // ms of recent movement to try; slow waves need the longest
  const WAVE_MAX_TILT = 50;   // degrees from horizontal a wave can lean; steeper is more of a nod
  const WAVE_MAX_ASPECT = 0.3; // how wide the back-and-forth can be, as short side / long side
  const HOLD_MS = 700;        // keep waving this long after the last qualifying swing
  const SEND_EVERY_MS = 33;

  // --- Circle detection tuning ---
  const CIRCLE_WINDOWS = [700, 1000, 1400, 1900, 2500, 3200]; // ms of recent movement to try, so slow loops count too
  const CIRCLE_TURN = 1;       // full turns needed
  const CIRCLE_R = [25, 250];  // allowed loop radius, px
  const CIRCLE_ROUND = 0.9;    // fraction of points that must sit near the average radius
  const CIRCLE_MIN_ASPECT = 0.45; // narrowest loop allowed, as short side / long side
  const CIRCLE_STEADY = 0.85;  // fraction of movement that must keep turning the same way
  const SWEEP_STEP = 4;        // px between points when measuring how a path turns
  const CIRCLE_HOLD_MS = 600;

  const INK = '#241b2f';

  document.head.insertAdjacentHTML('beforeend', `<style>
  html.hf-hand, html.hf-hand * { cursor: none !important; }
  #hf-layer {
    position: fixed;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
    z-index: 2147483000;
    --ink: ${INK};
  }
  #hf-stage { position: absolute; left: 0; top: 0; will-change: transform; }
  #hf-stage > * { position: absolute; left: 0; top: 0; pointer-events: none; }
  .hf-cursor { will-change: transform; }
  .hf-cursor.hf-in-scene, .hf-cursor.hf-off { visibility: hidden; }

  /* The hand is drawn with its palm centered on the pointer. */
  .hf-hand-art {
    position: absolute;
    left: 0;
    top: 0;
    width: 60px;
    height: 61px;
    margin: -40px 0 0 -34px;
    overflow: visible;
  }
  /* Everyone's cursor is their hand; it swings from the wrist while they wave. */
  .hf-cursor .hf-hand-art { transform-origin: 57% 89%; }
  .hf-cursor.hf-waving .hf-hand-art { animation: hf-wave 0.32s ease-in-out infinite alternate; }
  @keyframes hf-wave {
    from { transform: rotate(-20deg); }
    to   { transform: rotate(16deg); }
  }
  .hf-hand-art.hf-side {
    width: 34px;
    height: 65px;
    margin: -40px 0 0 -15px;
  }

  /* The loop someone is drawing while they circle. */
  .hf-loop {
    border: 3px dashed currentColor;
    border-radius: 50%;
    opacity: 0.45;
    display: none;
  }
  .hf-loop.hf-on { display: block; }

  /* Markers at the edge of the window pointing to readers elsewhere on the page. Click to go there. */
  .hf-marker {
    position: fixed;
    left: 0;
    top: 0;
    width: 18px;
    height: 18px;
    margin: -9px 0 0 -9px;
    border-radius: 50%;
    border: 3px solid var(--ink);
    background: currentColor;
    pointer-events: auto;
    display: none;
  }
  .hf-marker::after {
    content: "";
    position: absolute;
    left: 13px;
    top: 2px;
    border: 4px solid transparent;
    border-left: 6px solid var(--ink);
  }

  /* Top right: show or hide everyone's hands, including your own. */
  #hf-toggle {
    position: fixed;
    top: 16px;
    right: 16px;
    z-index: 2147482999;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 12px 3px 8px;
    border: 1px solid #d6d3d1;
    border-radius: 999px;
    background: #FBFBFD;
    color: #57534e;
    font: 13px/1.5 'Inter', sans-serif;
    cursor: pointer;
  }
  #hf-toggle:hover { border-color: #a8a29e; color: #1c1917; }
  #hf-toggle:focus-visible { outline: 2px solid #3366cc; outline-offset: 2px; }
  #hf-toggle svg { width: 18px; height: 18px; overflow: visible; color: #d6d3d1; }
  #hf-toggle[aria-pressed="true"] svg { color: var(--me, #f59e0b); }
  html.hf-hidden #hf-layer, html.hf-hidden #hf-here { display: none !important; }

  #hf-here {
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 2147482998;
    padding: 4px 12px;
    border: 1px solid #d6d3d1;
    border-radius: 999px;
    background: #FBFBFD;
    color: #57534e;
    font: 13px/1.5 'Inter', sans-serif;
    pointer-events: none;
    display: none;
  }
  #hf-here.hf-on { display: block; }

  .hf-impact { position: absolute; left: 0; top: 0; overflow: visible; }
  .hf-shake { animation: hf-shake 0.3s; }
  @keyframes hf-shake {
    0%, 100% { transform: translate(0, 0); }
    25% { transform: translate(-6px, 3px); }
    50% { transform: translate(5px, -4px); }
    75% { transform: translate(-3px, 2px); }
  }
  </style>`);

  // The hand. Drawn once and reused: a thick ink silhouette underneath, then the colored hand on top
  // with thin lines between the fingers.
  document.body.insertAdjacentHTML('beforeend', `
  <svg width="0" height="0" style="position:absolute" aria-hidden="true">
    <defs>
      <rect id="hf-thumb-shape" x="17" y="46" width="15" height="42" rx="7.5" transform="rotate(-38 25 86)"/>
      <g id="hf-finger-shapes">
        <use href="#hf-thumb-shape"/>
        <rect x="23" y="14" width="14" height="50" rx="7"/>
        <rect x="38" y="5" width="14" height="56" rx="7"/>
        <rect x="53" y="9" width="14" height="52" rx="7"/>
        <rect x="68" y="22" width="13" height="42" rx="6.5"/>
      </g>
      <rect id="hf-palm-shape" x="22" y="48" width="59" height="58" rx="22"/>
      <g id="hf-hand">
        <g fill="var(--ink)" stroke="var(--ink)" stroke-width="10" stroke-linejoin="round">
          <use href="#hf-finger-shapes"/>
          <use href="#hf-palm-shape"/>
        </g>
        <use href="#hf-finger-shapes" fill="currentColor" stroke="var(--ink)" stroke-width="3"/>
        <use href="#hf-palm-shape" fill="currentColor"/>
        <path d="M36 86 Q50 96 66 87" fill="none" stroke="var(--ink)" stroke-width="3"
              stroke-linecap="round" opacity="0.45"/>
        <path d="M43 17 v14" stroke="white" stroke-width="3.5" stroke-linecap="round" opacity="0.5"/>
      </g>
      <!-- The hand seen from the side, palm facing right: one slim silhouette with the middle
           fingertip peeking over the index, and the thumb angled out in front. -->
      <rect id="hf-middle-shape" x="34" y="-4" width="15" height="40" rx="7.5"/>
      <path id="hf-side-shape" d="M30 118 C28 100 27 80 28 64 C29 56 33 50 34 42 L34 14 C34 6 38 2 42 2
                                  C46 2 50 6 50 14 L50 106 C50 114 46 118 40 118 Z"/>
      <rect id="hf-side-thumb-shape" x="44" y="50" width="12" height="34" rx="6" transform="rotate(16 50 84)"/>
      <g id="hf-hand-side-body">
        <g fill="var(--ink)" stroke="var(--ink)" stroke-width="10" stroke-linejoin="round">
          <use href="#hf-middle-shape"/>
          <use href="#hf-side-shape"/>
        </g>
        <use href="#hf-middle-shape" fill="currentColor" stroke="var(--ink)" stroke-width="3"/>
        <use href="#hf-side-shape" fill="currentColor" stroke="var(--ink)" stroke-width="3"/>
        <path d="M38 24 q4 1.2 8 0 M38 36 q4 1.2 8 0" fill="none" stroke="var(--ink)" stroke-width="2.5"
              stroke-linecap="round" opacity="0.35"/>
        <path d="M38 8 v10" stroke="white" stroke-width="3" stroke-linecap="round" opacity="0.5"/>
      </g>
      <!-- With its thumb; in a hug, the thumb becomes a little arm instead. -->
      <g id="hf-hand-side">
        <g fill="var(--ink)" stroke="var(--ink)" stroke-width="10" stroke-linejoin="round">
          <use href="#hf-side-thumb-shape"/>
        </g>
        <use href="#hf-hand-side-body"/>
        <use href="#hf-side-thumb-shape" fill="currentColor" stroke="var(--ink)" stroke-width="3"/>
      </g>
      <!-- A heart, split down the middle into two people's colors (--a and --b). -->
      <path id="hf-heart-shape" d="M50 86 C20 64 4 46 4 28 C4 14 15 4 28 4 C38 4 46 10 50 18
                                   C54 10 62 4 72 4 C85 4 96 14 96 28 C96 46 80 64 50 86 Z"/>
      <clipPath id="hf-left-half"><rect x="-10" y="-10" width="60" height="110"/></clipPath>
      <clipPath id="hf-right-half"><rect x="50" y="-10" width="60" height="110"/></clipPath>
      <g id="hf-heart">
        <use href="#hf-heart-shape" fill="var(--ink)" stroke="var(--ink)" stroke-width="10" stroke-linejoin="round"/>
        <use href="#hf-heart-shape" fill="var(--a)" clip-path="url(#hf-left-half)"/>
        <use href="#hf-heart-shape" fill="var(--b)" clip-path="url(#hf-right-half)"/>
        <path d="M20 24 q4 -9 13 -9" fill="none" stroke="white" stroke-width="5" stroke-linecap="round" opacity="0.55"/>
      </g>
    </defs>
  </svg>
  <div id="hf-layer" aria-hidden="true"><div id="hf-stage"></div><div id="hf-markers"></div></div>
  <div id="hf-here" aria-live="polite"></div>
  <button id="hf-toggle" type="button" style="--ink:${INK}">
    <svg viewBox="-18 -4 122 124" aria-hidden="true"><use href="#hf-hand"/></svg><span></span>
  </button>`);

  const layer = document.getElementById('hf-layer');
  const stage = document.getElementById('hf-stage');
  const markersEl = document.getElementById('hf-markers');
  const hereEl = document.getElementById('hf-here');
  const toggleEl = document.getElementById('hf-toggle');

  // Whether hands are shown, remembered for next time. While hidden, nobody sees yours either.
  let shown = true;
  try { shown = localStorage.getItem('hf-hands') !== 'hidden'; } catch { /* storage is optional */ }
  function setShown(on) {
    shown = on;
    try { localStorage.setItem('hf-hands', on ? 'shown' : 'hidden'); } catch { /* storage is optional */ }
    document.documentElement.classList.toggle('hf-hidden', !on);
    document.documentElement.classList.toggle('hf-hand', on && hasHand);
    toggleEl.setAttribute('aria-pressed', on);
    toggleEl.querySelector('span').textContent = on ? 'Hide hands' : 'Show hands';
    samples.length = 0;
    wavingUntil = circleUntil = 0;
    me.waving = false;
    me.circle = null;
  }
  toggleEl.addEventListener('click', () => setShown(!shown));

  // The camera is the page point at the top-left of the window.
  const OFF = -1e9; // where someone is while their pointer isn't over the page
  const isOff = p => p.x < -1e8;
  const cam = { x: 0, y: 0 };
  function placeCamera() {
    cam.x = scrollX - document.documentElement.clientWidth / 2;
    cam.y = scrollY;
  }
  placeCamera();

  // Only a mouse (or pen) gets a hand; on touch screens you can still see everyone else.
  const pointer = { x: 0, y: 0, inside: false }; // in window coordinates

  let myId = null;
  let myColor = '#888';
  const cursors = new Map(); // id -> { el, loop, color, x, y, tx, ty, circle, marker }

  const HAND_SVG = `<svg class="hf-hand-art" viewBox="-18 -4 122 124"><use href="#hf-hand"/></svg>`;
  const HAND_SIDE_SVG = `<svg class="hf-hand-art hf-side" viewBox="14 -10 70 134"><use href="#hf-hand-side"/></svg>`;

  function makeCursor(color) {
    const el = document.createElement('div');
    el.className = 'hf-cursor';
    el.style.color = color;
    el.innerHTML = HAND_SVG;
    stage.appendChild(el);
    return el;
  }

  function makeLoop(color) {
    const el = document.createElement('div');
    el.className = 'hf-loop';
    el.style.color = color;
    stage.appendChild(el);
    return el;
  }

  function placeLoop(el, circle, hidden) {
    el.classList.toggle('hf-on', !!circle && !hidden);
    if (!circle) return;
    el.style.width = el.style.height = circle.r * 2 + 'px';
    el.style.transform = `translate(${circle.x - circle.r}px, ${circle.y - circle.r}px)`;
  }

  function getCursor(id, color) {
    let c = cursors.get(id);
    if (!c) {
      c = { el: makeCursor(color), loop: makeLoop(color), color, circle: null, x: OFF, y: OFF, tx: OFF, ty: OFF, fresh: true, marker: null };
      cursors.set(id, c);
      updateHere();
    }
    return c;
  }

  function removeCursor(id) {
    const c = cursors.get(id);
    if (!c) return;
    c.el.remove();
    c.loop.remove();
    c.marker?.remove();
    cursors.delete(id);
    updateHere();
  }

  // A little note in the corner when someone else is reading too, saying what you can do.
  function updateHere() {
    const n = cursors.size;
    hereEl.classList.toggle('hf-on', n > 0);
    if (!n) return;
    const who = n === 1 ? '1 other reader is here' : `${n} other readers are here`;
    hereEl.textContent = hasHand
      ? `${who}. Wave your cursor to high five, or circle to hug.`
      : `${who}.`;
  }

  // --- My own cursor (drawn locally, no network lag) ---
  const me = { x: OFF, y: OFF, waving: false, circle: null };
  const myEl = makeCursor(myColor);
  myEl.classList.add('hf-off');
  const myLoop = makeLoop(myColor);
  const samples = []; // recent { x, y, t }, for circle and wave shape checks
  let hasHand = false;

  let wavingUntil = 0;

  // A wave: the recent path is a narrow back-and-forth along one line, tilted no more than
  // WAVE_MAX_TILT from horizontal, with two swings of similar size that go back over the same spot.
  function findWave(pts) {
    if (pts.length < 6) return false;
    let cx = 0, cy = 0;
    for (const p of pts) { cx += p.x; cy += p.y; }
    cx /= pts.length;
    cy /= pts.length;
    if (flatness(pts, cx, cy) > WAVE_MAX_ASPECT) return false;

    // The line the hand swings along.
    let xx = 0, yy = 0, xy = 0;
    for (const p of pts) {
      const dx = p.x - cx, dy = p.y - cy;
      xx += dx * dx; yy += dy * dy; xy += dx * dy;
    }
    const axis = Math.atan2(2 * xy, xx - yy) / 2; // between -90° and 90° from horizontal
    if (Math.abs(axis) > WAVE_MAX_TILT * Math.PI / 180) return false;

    // Turning points along that line; v is the distance across it.
    const [ux, uy] = [Math.cos(axis), Math.sin(axis)];
    const proj = pts.map(p => ({ u: (p.x - cx) * ux + (p.y - cy) * uy, v: (p.y - cy) * ux - (p.x - cx) * uy, i: 0 }));
    proj.forEach((q, i) => { q.i = i; });
    const turns = [proj[0]];
    let dir = 0, extreme = proj[0];
    for (const q of proj) {
      const d = q.u - extreme.u;
      if (dir === 0) {
        if (Math.abs(d) >= SWING_MIN) { dir = Math.sign(d); extreme = q; }
      } else if (Math.sign(d) === dir) {
        extreme = q;
      } else if (Math.abs(d) >= SWING_MIN) {
        turns.push(extreme);
        dir = -dir;
        extreme = q;
      }
    }
    // Both swings must turn back at each end; the first point is just where the window starts,
    // which could be the middle of moving over, so it doesn't count as a turn.
    if (turns.length < 4) return false;
    const [t0, t1, t2] = turns.slice(-3);
    const a = Math.abs(t1.u - t0.u), b = Math.abs(t2.u - t1.u);
    const big = Math.max(a, b), small = Math.min(a, b);
    if (small < SWING_MIN || big > small * 3) return false;
    // Back over the same spot: near where it started, and not drifting off to one side of the line.
    if (Math.abs(t2.u - t0.u) > big * 0.6) return false;
    const vs = [t0.v, t1.v, t2.v];
    if (Math.max(...vs) - Math.min(...vs) > big * 0.4 + 6) return false;
    // Each swing is a fairly straight stroke; wandering curves travel much further than they reach.
    for (const [from, to] of [[t0, t1], [t1, t2]]) {
      let travelled = 0;
      for (let i = from.i + 1; i <= to.i; i++) {
        travelled += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      }
      if (travelled > Math.abs(to.u - from.u) * 1.35 + 6) return false;
    }
    // A flat ellipse also passes all of the above, but keeps sweeping around; a wave doesn't.
    return Math.abs(sweep(pts, cx, cy)) < Math.PI;
  }

  let lastSent = 0;
  let sentWaving = false;
  let sentCircling = false;
  let sent = { x: null, y: null };

  function placeMe() {
    if (!pointer.inside || document.hidden || !shown) { me.x = me.y = OFF; return; }
    me.x = pointer.x + cam.x;
    me.y = pointer.y + cam.y;
  }

  // Samples are in window coordinates, so scrolling the page doesn't look like a gesture.
  window.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    if (!hasHand) {
      hasHand = true;
      document.documentElement.classList.toggle('hf-hand', shown);
      myEl.classList.remove('hf-off');
      updateHere();
    }
    Object.assign(pointer, { x: e.clientX, y: e.clientY, inside: true });
    placeMe();
    samples.push({ x: e.clientX, y: e.clientY, t: performance.now() });
  }, { passive: true });
  window.addEventListener('scroll', () => { placeCamera(); placeMe(); }, { passive: true });
  window.addEventListener('resize', () => { placeCamera(); placeMe(); });
  document.documentElement.addEventListener('mouseleave', () => { pointer.inside = false; placeMe(); });
  document.addEventListener('visibilitychange', placeMe);

  // After a high five or hug, ignore gestures until the animation is over, and forget the movement
  // that led up to it, so the next one needs a fresh wave or circle.
  let gesturesPausedUntil = 0;
  function pauseGestures(ms) {
    gesturesPausedUntil = performance.now() + ms;
  }

  function gesturesPaused(now) {
    if (now >= gesturesPausedUntil) return false;
    samples.length = 0;
    wavingUntil = circleUntil = 0;
    me.waving = false;
    me.circle = null;
    return true;
  }

  function tickWave(now) {
    if (gesturesPaused(now)) return;
    if (!me.circle && WAVE_WINDOWS.some(ms => findWave(samples.filter(p => now - p.t <= ms)))) {
      wavingUntil = now + HOLD_MS;
    }
    me.waving = now < wavingUntil && !isOff(me);
  }

  // How round a cloud of points is: 1 for a circle, near 0 for a straight line.
  // Measured along its own main axis, so tilted loops count too.
  function flatness(pts, cx, cy) {
    let xx = 0, yy = 0, xy = 0;
    for (const p of pts) {
      const dx = p.x - cx, dy = p.y - cy;
      xx += dx * dx; yy += dy * dy; xy += dx * dy;
    }
    const mid = (xx + yy) / 2;
    const spread = Math.sqrt(((xx - yy) / 2) ** 2 + xy * xy);
    return Math.sqrt(Math.max(0, mid - spread) / (mid + spread || 1));
  }

  // Total signed angle the path turns through around a center point. Points passing right by
  // the center are skipped: their angle flips at random and would add up to fake turning.
  function sweep(pts, cx, cy) {
    return sweepDetail(pts, cx, cy).turn;
  }

  // The total turn, how steady it is (the share of turning that goes the same way as the total),
  // and how many big jumps in angle there were (moves that cut across the middle).
  function sweepDetail(pts, cx, cy) {
    const dist = p => Math.hypot(p.x - cx, p.y - cy);
    const near = pts.reduce((sum, p) => sum + dist(p), 0) / pts.length * 0.3;
    let turn = 0, forward = 0, back = 0, jumps = 0;
    let prev = null, last = null;
    for (const p of pts) {
      if (dist(p) < near) continue;
      // Skip tiny moves: at high sample rates they're mostly jitter, which reads as turning back.
      if (last && Math.hypot(p.x - last.x, p.y - last.y) < SWEEP_STEP) continue;
      last = p;
      const a = Math.atan2(p.y - cy, p.x - cx);
      if (prev === null) { prev = a; continue; }
      let d = a - prev;
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      turn += d;
      if (d > 0) forward += d; else back -= d;
      if (Math.abs(d) > 0.8) jumps++;
      prev = a;
    }
    const steady = Math.max(forward, back) / ((forward + back) || 1);
    return { turn, steady, jumps };
  }

  // Circling: the recent path sweeps most of a full turn around its center, at a steady radius.
  let circleUntil = 0;
  let lastCircle = null; // in window coordinates
  function tickCircle(now) {
    if (gesturesPaused(now)) return;
    while (samples.length && now - samples[0].t > CIRCLE_WINDOWS.at(-1)) samples.shift();
    let found = null;
    for (const ms of CIRCLE_WINDOWS) {
      found = findCircle(samples.filter(p => now - p.t <= ms));
      if (found) break;
    }
    if (found) {
      lastCircle = found;
      circleUntil = now + CIRCLE_HOLD_MS;
    }
    me.circle = now < circleUntil && !isOff(me)
      ? { x: Math.round(lastCircle.x + cam.x), y: Math.round(lastCircle.y + cam.y), r: lastCircle.r }
      : null;
    if (me.circle) me.waving = false, wavingUntil = 0;
  }

  function findCircle(pts) {
    if (pts.length < 10) return null;
    let cx = 0, cy = 0;
    for (const p of pts) { cx += p.x; cy += p.y; }
    cx /= pts.length;
    cy /= pts.length;

    const radii = pts.map(p => Math.hypot(p.x - cx, p.y - cy));
    const r = radii.reduce((sum, d) => sum + d, 0) / radii.length;
    if (r < CIRCLE_R[0] || r > CIRCLE_R[1]) return null;
    // Hand-drawn loops wobble; allow a few stray points.
    const round = radii.filter(d => d > r * 0.5 && d < r * 1.6).length;
    if (round < pts.length * CIRCLE_ROUND) return null;
    // A loop has width and height; a back-and-forth line (a wave) is flat.
    if (flatness(pts, cx, cy) < CIRCLE_MIN_ASPECT) return null;

    const { turn, steady, jumps } = sweepDetail(pts, cx, cy);
    if (Math.abs(turn) < CIRCLE_TURN * 2 * Math.PI) return null;
    // Wandering paths curve one way, then the other; a real circle keeps going around.
    if (steady < CIRCLE_STEADY) return null;
    // A circle sweeps around smoothly; a scribble cuts across the middle in big jumps.
    if (jumps > 0) return null;
    return { x: cx, y: cy, r: Math.round(r) };
  }

  // --- Networking ---
  // The server may be asleep or down; keep trying, slowly, without bothering the reader.
  let ws;
  let retryMs = 1000;
  function connect() {
    ws = new WebSocket(`${SERVER}?room=${encodeURIComponent(location.pathname)}`);
    ws.onopen = () => { retryMs = 1000; };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      switch (msg.t) {
        case 'hello':
          myId = msg.id;
          myColor = msg.color;
          myEl.style.color = myColor;
          myLoop.style.color = myColor;
          toggleEl.style.setProperty('--me', myColor);
          sent = { x: null, y: null }; // tell the server where we are right away
          break;
        case 'cursor': {
          if (msg.id === myId) break;
          const c = getCursor(msg.id, msg.color);
          c.tx = msg.x;
          c.ty = msg.y;
          if (c.fresh || isOff(c) !== isOff({ x: msg.x })) { c.x = msg.x; c.y = msg.y; c.fresh = false; }
          c.el.classList.toggle('hf-waving', msg.waving);
          c.el.classList.toggle('hf-off', isOff(c));
          c.circle = msg.circle;
          break;
        }
        case 'bye':
          removeCursor(msg.id);
          break;
        case 'five':
          highFive(msg);
          break;
        case 'hug':
          hug(msg);
          break;
      }
    };
    ws.onclose = () => {
      for (const id of [...cursors.keys()]) removeCursor(id);
      myId = null;
      setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 30000);
    };
  }
  connect();

  function send(now) {
    if (!ws || ws.readyState !== WebSocket.OPEN || myId === null) return;
    const changed = me.waving !== sentWaving || !!me.circle !== sentCircling;
    if (!changed && now - lastSent < SEND_EVERY_MS) return;
    if (!changed && me.x === sent.x && me.y === sent.y) return;
    ws.send(JSON.stringify({ t: 'move', x: me.x, y: me.y, waving: me.waving, circle: me.circle }));
    lastSent = now;
    sentWaving = me.waving;
    sentCircling = !!me.circle;
    sent = { x: me.x, y: me.y };
  }

  // --- High five effect ---
  let audio;
  function clap() {
    try {
      audio ??= new AudioContext();
      const len = audio.sampleRate * 0.15;
      const buf = audio.createBuffer(1, len, audio.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 4);
      const src = audio.createBufferSource();
      src.buffer = buf;
      const filter = audio.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 1500;
      src.connect(filter).connect(audio.destination);
      src.start();
    } catch { /* audio is optional */ }
  }

  const FIVE_MS = 900;
  const CONTACT_AT = 0.42; // fraction of FIVE_MS when the palms meet
  const SCENE_SCALE = 1.35;
  // How far each hand's center sits from the midpoint when the palms press together.
  const PALM_OFFSET = 7;
  const TURN = [0.12, 0.24]; // when the hands turn from facing you to side-on

  function participant(id) {
    if (id === myId) return { el: myEl, color: myColor, x: me.x, y: me.y };
    const c = cursors.get(id);
    return c && { el: c.el, color: c.color, x: c.x, y: c.y };
  }

  // Both hands wind up, swing in and slap palm to palm at the midpoint, then bounce apart.
  // As they wind up, the hands turn side-on so the palms face each other.
  function highFive({ a, b, x, y }) {
    const mine = a === myId || b === myId;
    if (mine) pauseGestures(FIVE_MS + 300);
    let [left, right] = [participant(a), participant(b)];
    if (!left || !right) return;
    if (left.x > right.x) [left, right] = [right, left];

    const scene = document.createElement('div');
    scene.style.transform = `translate(${x}px, ${y}px)`;
    stage.appendChild(scene);

    for (const [p, side] of [[left, -1], [right, 1]]) {
      p.el.classList.add('hf-in-scene');
      const wrap = document.createElement('div');
      wrap.style.position = 'absolute';
      wrap.style.transformOrigin = `0 ${19 * SCENE_SCALE / 1.35}px`; // the wrist
      wrap.style.color = p.color;
      // Mirror the right hand so both thumbs point outward and the palms face each other.
      wrap.innerHTML = `<div style="transform: scale(${SCENE_SCALE * -side}, ${SCENE_SCALE})">
        <div class="hf-front">${HAND_SVG}</div><div class="hf-side-on">${HAND_SIDE_SVG}</div></div>`;
      scene.appendChild(wrap);
      // Turn: the front view narrows to nothing, then the side view widens in its place.
      const turn = { duration: FIVE_MS, fill: 'forwards' };
      wrap.querySelector('.hf-front').animate([
        { transform: 'scaleX(1)', offset: 0 },
        { transform: 'scaleX(0)', offset: TURN[0] },
        { transform: 'scaleX(0)', offset: 1 },
      ], turn);
      wrap.querySelector('.hf-side-on').animate([
        { transform: 'scaleX(0)', offset: 0 },
        { transform: 'scaleX(0)', offset: TURN[0] },
        { transform: 'scaleX(1)', offset: TURN[1] },
        { transform: 'scaleX(1)', offset: 1 },
      ], turn);

      const pose = (dx, dy, deg, sx = 1, sy = 1) =>
        `translate(${dx}px, ${dy}px) rotate(${deg * -side}deg) scale(${sx}, ${sy})`;
      const startX = Math.max(-80, Math.min(80, p.x - x));
      const startY = Math.max(-80, Math.min(80, p.y - y));
      wrap.animate([
        { transform: pose(startX, startY, 0), offset: 0 },
        { transform: pose(64 * side, -6, -38), offset: 0.26, easing: 'cubic-bezier(.6,0,.9,.4)' },
        // Palms meet flat, then squash against each other.
        { transform: pose(PALM_OFFSET * side, -10, 4), offset: CONTACT_AT },
        { transform: pose(PALM_OFFSET * 0.9 * side, -10, 6, 0.9, 1.04), offset: CONTACT_AT + 0.06 },
        { transform: pose(44 * side, -4, 2), opacity: 1, offset: 0.75, easing: 'ease-out' },
        { transform: pose(50 * side, 0, 0), opacity: 0, offset: 1 },
      ], { duration: FIVE_MS, fill: 'forwards' });
    }

    setTimeout(() => {
      impact(scene, left.color, right.color);
      confetti(x, y - 60, [left.color, right.color]);
      if (mine) {
        clap();
        // Shake the layer, not the stage: the stage's own transform keeps it lined up with the page.
        layer.classList.remove('hf-shake');
        void layer.offsetWidth; // restart the animation
        layer.classList.add('hf-shake');
      }
    }, FIVE_MS * CONTACT_AT);

    setTimeout(() => {
      scene.remove();
      left.el.classList.remove('hf-in-scene');
      right.el.classList.remove('hf-in-scene');
    }, FIVE_MS);
  }

  // Slap lines fanning out above where the palms meet, in both people's colors.
  function impact(scene, colorA, colorB) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'hf-impact');
    svg.setAttribute('width', 1);
    svg.setAttribute('height', 1);
    svg.style.top = '-58px';
    scene.appendChild(svg);

    const count = 7;
    for (let i = 0; i < count; i++) {
      const angle = Math.PI + (i / (count - 1)) * Math.PI;
      const [cx, cy] = [Math.cos(angle), Math.sin(angle)];
      const line = document.createElementNS(ns, 'line');
      line.setAttribute('x1', cx * 4);
      line.setAttribute('y1', cy * 4);
      line.setAttribute('x2', cx * 18);
      line.setAttribute('y2', cy * 18);
      line.setAttribute('stroke', cx < 0 ? colorA : colorB);
      line.setAttribute('stroke-width', 5);
      line.setAttribute('stroke-linecap', 'round');
      svg.appendChild(line);
      line.animate([
        { transform: 'translate(0, 0)', opacity: 1 },
        { transform: `translate(${cx * 44}px, ${cy * 44}px)`, opacity: 0 },
      ], { duration: 380, easing: 'cubic-bezier(.1,.7,.3,1)', fill: 'forwards' });
    }
    setTimeout(() => svg.remove(), 400);
  }

  const CONFETTI_COLORS = ['#f59e0b', '#10b981', '#8b5cf6', '#ec4899'];

  // Pieces pop up from the top of the high five, then tumble down under gravity.
  function confetti(x, y, colors) {
    const palette = [...colors, ...colors, ...CONFETTI_COLORS];
    for (let i = 0; i < 26; i++) {
      const piece = document.createElement('div');
      const w = 5 + Math.random() * 4;
      piece.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${w * 0.55}px;
        border-radius:1px;background:${palette[i % palette.length]}`;
      stage.appendChild(piece);

      const angle = -Math.PI / 2 + (Math.random() - 0.5) * 2.2;
      const speed = 260 + Math.random() * 220; // px/s
      const [vx, vy] = [Math.cos(angle) * speed, Math.sin(angle) * speed];
      const spin = (Math.random() - 0.5) * 1440;
      const duration = 1100 + Math.random() * 500;
      const frames = [];
      for (let f = 0; f <= 10; f++) {
        const t = (f / 10) * duration / 1000;
        frames.push({
          transform: `translate(${vx * t * (1 - t * 0.35)}px, ${vy * t + 900 * t * t / 2}px) rotate(${spin * t}deg) rotateX(${spin * t * 1.5}deg)`,
          opacity: f > 7 ? 1 - (f - 7) / 3 : 1,
        });
      }
      piece.animate(frames, { duration, easing: 'linear', fill: 'forwards' }).onfinish = () => piece.remove();
    }
  }

  // --- Hug effect ---
  const HUG_MS = 2200;
  const HUG_LEAN = 9;   // degrees each hand leans in, resting its head on the other's shoulder
  const HUG_UNIT = 0.86 * SCENE_SCALE / 1.35; // px per unit of the side-view hand art
  // Key moments, as fractions of HUG_MS.
  const HUG = { turned: 0.24, sideOn: 0.32, leaned: 0.4, hugging: 0.48, letGo: 0.8, apart: 0.88 };

  const HEART_SVG = (a, b) =>
    `<svg viewBox="-6 -6 112 102" style="--a:${a};--b:${b};overflow:visible;display:block;width:100%;height:100%"><use href="#hf-heart"/></svg>`;

  function chime() {
    try {
      audio ??= new AudioContext();
      const t0 = audio.currentTime;
      [659.25, 880].forEach((freq, i) => {
        const osc = audio.createOscillator();
        const gain = audio.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        const t = t0 + i * 0.12;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.18, t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
        osc.connect(gain).connect(audio.destination);
        osc.start(t);
        osc.stop(t + 0.65);
      });
    } catch { /* audio is optional */ }
  }

  // The hands come together, turn side-on, rest their heads on each other's shoulders and put
  // their little arms (the thumbs) around each other: one over the shoulder, one around the waist.
  function hug({ a, b, x, y }) {
    const mine = a === myId || b === myId;
    if (mine) pauseGestures(HUG_MS + 300);
    let [left, right] = [participant(a), participant(b)];
    if (!left || !right) return;
    if (left.x > right.x) [left, right] = [right, left];

    const scene = document.createElement('div');
    scene.style.transform = `translate(${x}px, ${y}px)`;
    stage.appendChild(scene);
    const timing = { duration: HUG_MS, fill: 'forwards' };

    // 1. The open hands drift in from the cursors and turn edge-on.
    for (const [p, side] of [[left, -1], [right, 1]]) {
      p.el.classList.add('hf-in-scene');
      const open = document.createElement('div');
      open.style.cssText = `position:absolute;color:${p.color}`;
      open.innerHTML = `<div style="transform: scale(${SCENE_SCALE * -side}, ${SCENE_SCALE})">
        <div class="hf-flip">${HAND_SVG}</div></div>`;
      scene.appendChild(open);
      // Start from where the hand really is: it may be a whole loop's width away.
      const startX = Math.max(-400, Math.min(400, p.x - x));
      const startY = Math.max(-400, Math.min(400, p.y - y));
      open.animate([
        { transform: `translate(${startX}px, ${startY}px)`, easing: 'cubic-bezier(.3,.7,.4,1)' },
        { transform: `translate(${20 * side}px, 4px)`, offset: HUG.turned },
        { transform: `translate(${20 * side}px, 4px)` },
      ], timing);
      open.querySelector('.hf-flip').animate([
        { transform: 'scaleX(1)' },
        { transform: 'scaleX(1)', offset: HUG.turned - 0.08, easing: 'ease-in' },
        { transform: 'scaleX(0)', offset: HUG.turned },
        { transform: 'scaleX(0)' },
      ], timing);
    }

    // 2. The side-on pair, drawn in the side-view hand's own units. The left hand faces right;
    //    the right hand is its mirror image. Arms are drawn last so they rest in front.
    const U = HUG_UNIT;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 -16 150 150');
    svg.setAttribute('width', 150 * U);
    svg.setAttribute('height', 150 * U);
    svg.style.cssText = `position:absolute;left:${-75 * U}px;top:${-76 * U}px;overflow:visible;transform-origin:50% 89%`;
    const person = (color, placeAt) => `
      <g transform="${placeAt}"><g class="hf-drift"><g class="hf-lean"><g class="hf-turn" style="color:${color}">
        <use href="#hf-hand-side-body"/></g></g></g></g>`;
    const armPath = (color, d) => `<g class="hf-arm" fill="none" stroke-linecap="round" opacity="0">
      <path d="${d}" pathLength="1" stroke="var(--ink)" stroke-width="20" stroke-dasharray="1 2"/>
      <path d="${d}" pathLength="1" stroke="${color}" stroke-width="11" stroke-dasharray="1 2"/></g>`;
    svg.innerHTML =
      person(right.color, 'translate(128 0) scale(-1 1)') +
      person(left.color, 'translate(22 0)') +
      armPath(right.color, 'M78 86 C72 78 64 77 59 82') +  // right hand's arm around the left's waist
      armPath(left.color, 'M72 62 C78 54 87 53 93 58');    // left hand's arm over the right's shoulder
    scene.appendChild(svg);

    // Turn in from edge-on, around the middle of the hand.
    const turn = k => `translate(40px, 0) scaleX(${k}) translate(-40px, 0)`;
    // Lean around the wrist; inside the mirror, so both lean toward each other.
    const lean = deg => `translate(40px, 118px) rotate(${deg}deg) translate(-40px, -118px)`;
    for (const g of svg.querySelectorAll('.hf-turn')) {
      g.animate([
        { transform: turn(0) },
        { transform: turn(0), offset: HUG.turned, easing: 'ease-out' },
        { transform: turn(1), offset: HUG.sideOn },
        { transform: turn(1) },
      ], timing);
    }
    for (const g of svg.querySelectorAll('.hf-lean')) {
      g.animate([
        { transform: lean(0) },
        { transform: lean(0), offset: HUG.sideOn, easing: 'cubic-bezier(.4,0,.3,1.5)' },
        { transform: lean(HUG_LEAN), offset: HUG.leaned },
        { transform: lean(HUG_LEAN), offset: HUG.letGo, easing: 'ease-in-out' },
        { transform: lean(0), offset: HUG.apart },
        { transform: lean(0) },
      ], timing);
    }
    for (const g of svg.querySelectorAll('.hf-drift')) {
      g.animate([
        { transform: 'translate(0, 0)', opacity: 1 },
        { transform: 'translate(0, 0)', opacity: 1, offset: HUG.apart, easing: 'ease-in' },
        { transform: 'translate(-40px, 6px)', opacity: 0 },
      ], timing);
    }
    // The arms grow out from the body, rest there through the hug, then tuck back in.
    for (const g of svg.querySelectorAll('.hf-arm')) {
      g.animate([
        { opacity: 0 },
        { opacity: 0, offset: HUG.leaned - 0.01 },
        { opacity: 1, offset: HUG.leaned },
        { opacity: 1, offset: HUG.letGo + 0.06 },
        { opacity: 0, offset: HUG.letGo + 0.061 },
        { opacity: 0 },
      ], timing);
      for (const path of g.querySelectorAll('path')) {
        path.animate([
          { strokeDashoffset: 1 },
          { strokeDashoffset: 1, offset: HUG.leaned, easing: 'cubic-bezier(.3,.8,.4,1.2)' },
          { strokeDashoffset: 0, offset: HUG.hugging },
          { strokeDashoffset: 0, offset: HUG.letGo, easing: 'ease-in' },
          { strokeDashoffset: 1, offset: HUG.letGo + 0.06 },
          { strokeDashoffset: 1 },
        ], timing);
      }
    }

    // 3. Squeeze and rock together.
    svg.animate([
      { transform: 'rotate(0deg) scale(1)' },
      { transform: 'rotate(0deg) scale(1)', offset: HUG.hugging - 0.03 },
      { transform: 'rotate(0deg) scale(1.06, 0.97)', offset: HUG.hugging + 0.02 },
      { transform: 'rotate(-6deg) scale(1.02)', offset: 0.59 },
      { transform: 'rotate(6deg) scale(1.02)', offset: 0.7 },
      { transform: 'rotate(0deg) scale(1)', offset: HUG.letGo },
      { transform: 'rotate(0deg) scale(1)' },
    ], { ...timing, easing: 'ease-in-out' });

    setTimeout(() => {
      hearts(x, y, left.color, right.color);
      if (mine) chime();
    }, HUG_MS * HUG.hugging);

    setTimeout(() => {
      scene.remove();
      left.el.classList.remove('hf-in-scene');
      right.el.classList.remove('hf-in-scene');
    }, HUG_MS);
  }

  // One big two-tone heart pops up over the hug, and small hearts drift up around it.
  function hearts(x, y, colorA, colorB) {
    const big = document.createElement('div');
    big.style.cssText = `left:${x - 30}px;top:${y - 128}px;width:60px;height:54px`;
    big.innerHTML = HEART_SVG(colorA, colorB);
    stage.appendChild(big);
    big.animate([
      { transform: 'translateY(30px) scale(0)', opacity: 1 },
      { transform: 'translateY(0) scale(1.25)', opacity: 1, offset: 0.18 },
      { transform: 'translateY(-6px) scale(0.95)', opacity: 1, offset: 0.3 },
      { transform: 'translateY(-10px) scale(1.05)', opacity: 1, offset: 0.42 },
      { transform: 'translateY(-14px) scale(1)', opacity: 1, offset: 0.75 },
      { transform: 'translateY(-40px) scale(0.9)', opacity: 0 },
    ], { duration: 1500, easing: 'ease-out', fill: 'forwards' }).onfinish = () => big.remove();

    for (let i = 0; i < 9; i++) {
      const color = i % 2 ? colorB : colorA;
      const size = 14 + Math.random() * 10;
      const heart = document.createElement('div');
      const startX = x + (Math.random() - 0.5) * 90;
      heart.style.cssText = `left:${startX - size / 2}px;top:${y - 70}px;
        width:${size}px;height:${size * 0.9}px;opacity:0`;
      heart.innerHTML = HEART_SVG(color, color);
      stage.appendChild(heart);

      const rise = 110 + Math.random() * 90;
      const sway = 10 + Math.random() * 12;
      const dir = Math.random() < 0.5 ? -1 : 1;
      const frames = [];
      for (let f = 0; f <= 8; f++) {
        const t = f / 8;
        frames.push({
          transform: `translate(${Math.sin(t * Math.PI * 2) * sway * dir}px, ${-rise * t}px)
                      rotate(${Math.sin(t * Math.PI * 2) * 12 * dir}deg) scale(${Math.min(1, t * 5)})`,
          opacity: t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3,
        });
      }
      heart.animate(frames, {
        duration: 1300 + Math.random() * 500,
        delay: i * 70,
        easing: 'linear',
        fill: 'forwards',
      }).onfinish = () => heart.remove();
    }
  }

  // --- Render loop ---
  function frame(now) {
    placeCamera();
    placeMe();
    stage.style.transform = `translate(${-cam.x}px, ${-cam.y}px)`;

    if (hasHand && shown) {
      tickCircle(now);
      tickWave(now);
    }
    send(now);

    myEl.style.transform = `translate(${me.x}px, ${me.y}px)`;
    myEl.classList.toggle('hf-waving', me.waving);
    myEl.classList.toggle('hf-off', !hasHand || isOff(me));
    placeLoop(myLoop, me.circle, myEl.classList.contains('hf-in-scene'));

    for (const c of cursors.values()) {
      c.x += (c.tx - c.x) * 0.35;
      c.y += (c.ty - c.y) * 0.35;
      c.el.style.transform = `translate(${c.x}px, ${c.y}px)`;
      placeLoop(c.loop, c.circle, c.el.classList.contains('hf-in-scene'));
      placeMarker(c);
    }
    requestAnimationFrame(frame);
  }

  // Point to someone elsewhere on the page from the edge of the window, along the line from its
  // center. Clicking the marker scrolls to them.
  const MARKER_INSET = 22;
  function placeMarker(c) {
    const sx = c.x - cam.x, sy = c.y - cam.y;
    const [w, h] = [layer.clientWidth, layer.clientHeight];
    const onScreen = sx > 0 && sx < w && sy > 0 && sy < h;
    if (isOff(c) || onScreen) {
      if (c.marker) c.marker.style.display = 'none';
      return;
    }
    if (!c.marker) {
      c.marker = document.createElement('div');
      c.marker.className = 'hf-marker';
      c.marker.style.color = c.color;
      c.marker.title = 'Go to this reader';
      c.marker.addEventListener('click', () => {
        window.scrollTo({ top: c.y - innerHeight / 2, left: scrollX + (c.x - cam.x) - w / 2, behavior: 'smooth' });
      });
      markersEl.appendChild(c.marker);
    }
    const [cx, cy] = [w / 2, h / 2];
    const [dx, dy] = [sx - cx, sy - cy];
    const k = Math.min((cx - MARKER_INSET) / Math.abs(dx || 1e-9), (cy - MARKER_INSET) / Math.abs(dy || 1e-9));
    c.marker.style.display = 'block';
    c.marker.style.transform = `translate(${cx + dx * k}px, ${cy + dy * k}px) rotate(${Math.atan2(dy, dx)}rad)`;
  }
  setShown(shown);
  requestAnimationFrame(frame);
})();
