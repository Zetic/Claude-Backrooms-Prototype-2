/*
 * Generator checks (run: node tests/determinism.test.js [seed])
 *
 * Determinism - the same seed + region gives byte-identical output no matter
 *   - what was generated before (visit order),
 *   - whether caches were evicted mid-way (tiny cache limits),
 *   - which order territories are requested in,
 *   - how far from the origin the region is.
 * Structure
 *   - territories tile the plane exactly (no gaps, no overlaps),
 *   - pair rules hold: forbidden pairs never touch without a band or a
 *     thick wall and never get a normal door; pockets sit fully inside one
 *     host area and have a front door,
 *   - every room in a large region is reachable from every other.
 */
const path = require('path');
for (const f of ['core', 'areas', 'layout', 'zones', 'interior', 'boundary', 'world'])
  require(path.join(__dirname, '..', 'src', f + '.js'));
const BR = globalThis.BR;

const SEED = +(process.argv[2] || 31337);
const r6 = (v) => Math.round(v * 1e6) / 1e6;
let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail ? '  (' + detail + ')' : ''));
  if (!ok) failures++;
}

/** Canonical fingerprint of the territories, interiors and boundaries touching a rect. */
function snapshot(W, x0, y0, x1, y1, reverse) {
  let terrs = W.territoriesIn(x0, y0, x1, y1).slice().sort((a, b) => (a.key < b.key ? -1 : 1));
  if (reverse) terrs = terrs.reverse();
  const I = {}, B = {}, P = {};
  for (const T of terrs) {
    const it = W.interior(T);
    P[T.key] = [T.rects, W.final(T), T.base, T.district].map(String).join(';');
    I[T.key] = JSON.stringify({
      blocks: it.blocks.map((b) => [b.x0, b.y0, b.x1, b.y1, b.k, it.zones[b.z].type]),
      rooms: it.rooms.map((r) => r.kind + ':' + r.rects.map((q) => q.map(r6).join(',')).join('/')),
      links: it.links.map((l) => [l.a, l.b, r6(l.x), r6(l.y), r6(l.w), l.kind]),
      geo: ['walls', 'minor', 'hatch', 'masses', 'voids', 'pools', 'props', 'rounds', 'pillars'].map((k) => it[k].map(r6))
    });
    for (const n of W.adj(T)) {
      const k = BR.pairKey(T, n.U);
      if (B[k]) continue;
      const b = W.boundary(T, n.U);
      B[k] = JSON.stringify([b.wall, b.walls.map(r6), b.doors.map((d) => [r6(d.x), r6(d.y), r6(d.w), d.o, d.kind]),
        b.links.map((l) => [l.a.key, l.a.room, l.b.key, l.b.room, l.kind])]);
    }
  }
  const sorted = (o) => Object.keys(o).sort().map((k) => k + '=' + o[k]).join('\n');
  return sorted(P) + '\n#\n' + sorted(I) + '\n#\n' + sorted(B);
}

// ------------------------------------------------------------ determinism
const R = [-160, -120, 160, 120];
const base = snapshot(new BR.World(SEED), ...R);
{
  const W = new BR.World(SEED);
  W.collect(900, 700, 1300, 1000, Infinity, { interiors: true });     // somewhere else first
  W.collect(-500, 300, -200, 600, Infinity, { interiors: true });
  check('visit order does not matter', snapshot(W, ...R) === base);
}
{
  const W = new BR.World(SEED, { limits: { plans: 12, interiors: 8, boundaries: 16, pairs: 40 } });
  check('cache eviction does not matter', snapshot(W, ...R) === base);
}
check('request order does not matter', snapshot(new BR.World(SEED), R[0], R[1], R[2], R[3], true) === base);
{
  // the same region built in four tiles, in reverse order, on one world
  const W = new BR.World(SEED);
  const mx = (R[0] + R[2]) / 2, my = (R[1] + R[3]) / 2;
  for (const q of [[mx, my, R[2], R[3]], [R[0], my, mx, R[3]], [mx, R[1], R[2], my], [R[0], R[1], mx, my]])
    W.collect(q[0], q[1], q[2], q[3], Infinity, { interiors: true });
  check('tiled build matches one-shot build', snapshot(W, ...R) === base);
}
{
  const F = [1e6 - 120, -1e6 - 90, 1e6 + 120, -1e6 + 90];
  const a = snapshot(new BR.World(SEED), ...F);
  const W = new BR.World(SEED, { limits: { plans: 12, interiors: 8, boundaries: 16, pairs: 40 } });
  W.collect(0, 0, 100, 100, Infinity, { interiors: true });
  check('far from the origin (1e6 m) still deterministic', snapshot(W, ...F) === a);
}
check('different seeds differ', snapshot(new BR.World(SEED + 1), ...R) !== base);

// ------------------------------------------------------------ tiling
{
  const W = new BR.World(SEED), X0 = -700, Y0 = -600, X1 = 700, Y1 = 600, step = 1.37;
  const terrs = W.territoriesIn(X0, Y0, X1, Y1);
  // bucket rects for fast point queries
  const G = 20, cells = new Map();
  for (const T of terrs) for (const r of T.rects)
    for (let gx = Math.floor(r[0] / G); gx <= Math.floor(r[2] / G); gx++)
      for (let gy = Math.floor(r[1] / G); gy <= Math.floor(r[3] / G); gy++) {
        const k = gx + ',' + gy;
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(r);
      }
  let gaps = 0, overlaps = 0, n = 0;
  for (let x = X0 + 0.31; x < X1; x += step) for (let y = Y0 + 0.17; y < Y1; y += step) {
    n++;
    let c = 0;
    for (const r of cells.get(Math.floor(x / G) + ',' + Math.floor(y / G)) || []) if (x > r[0] && x < r[2] && y > r[1] && y < r[3]) c++;
    if (c === 0) gaps++; else if (c > 1) overlaps++;
  }
  check('territories tile the plane exactly', gaps === 0 && overlaps === 0, `${n} samples, ${gaps} gaps, ${overlaps} overlaps`);
  let ta = 0;
  for (const T of terrs) for (const r of T.rects) ta += Math.max(0, Math.min(r[2], X1) - Math.max(r[0], X0)) * Math.max(0, Math.min(r[3], Y1) - Math.max(r[1], Y0));
  check('territory area sums to region area', Math.abs(ta - (X1 - X0) * (Y1 - Y0)) < 1e-6, `${ta} vs ${(X1 - X0) * (Y1 - Y0)}`);
}

// ------------------------------------------------------------ rules
{
  const W = new BR.World(SEED), X = 900;
  const it = W.collect(-X, -X, X, X, Infinity, { interiors: true });
  const inner = (T) => T.bbox[0] > -X + 60 && T.bbox[1] > -X + 60 && T.bbox[2] < X - 60 && T.bbox[3] < X - 60;
  let forbidden = 0, badForbidden = [], bandLeaks = 0, pockets = 0, badPockets = [], seenPairs = new Set();
  for (const T of it.territories) {
    if (!inner(T)) continue;
    const fa = W.final(T);
    for (const n of W.adj(T)) {
      const k = BR.pairKey(T, n.U);
      if (seenPairs.has(k)) continue;
      seenPairs.add(k);
      const fb = W.final(n.U), info = BR.pairInfo(W, T, n.U);
      if (BR.isPocket(fa) || BR.isPocket(fb) || BR.rule(fa, fb) !== 'band') continue;
      forbidden++;
      const b = W.boundary(T, n.U);
      const ok = info.mode === 'never' && (info.band || info.wall === 'thick') && b.doors.every((d) => d.kind === 'service');
      if (!ok) badForbidden.push(k);
      // with a band, the owner's side of the line is maintenance floor (or solid)
      if (info.band) {
        const O = W.terr(info.band.owner), IO = W.interior(O), segs = info.band.owner === T.key ? n.segs : W.adj(n.U).find((m) => m.U.key === T.key).segs;
        for (const s of segs) for (let t = s.s0 + 0.5; t < s.s1 - 0.5; t += 1) {
          const sg = s.side === 1 || s.side === 3 ? -1 : 1, d = 0.6 * sg;
          const p = s.o === 'h' ? [t, s.c + d] : [s.c + d, t];
          const r = BR.interiorRoomAt(IO, p[0], p[1]);
          if (r >= 0 && IO.rooms[r].kind !== 'service') bandLeaks++;
        }
      }
    }
    if (BR.isPocket(fa)) {
      pockets++;
      const host = T.base, nbs = W.adj(T);
      const allHost = nbs.every((m) => m.U.base === host);
      const doors = nbs.reduce((s, m) => s + W.boundary(T, m.U).doors.length + W.boundary(T, m.U).links.length, 0);
      if (!allHost || doors < 1) badPockets.push(T.key + (allHost ? ' no door' : ' crosses areas'));
    }
  }
  check('forbidden pairs: band or thick wall, no normal door', badForbidden.length === 0, `${forbidden} pairs` + (badForbidden.length ? ', bad: ' + badForbidden.slice(0, 4).join(' ') : ''));
  check('bands are maintenance floor along the whole line', bandLeaks === 0, `${bandLeaks} leaks`);
  check('pockets sit inside one host and have a door', badPockets.length === 0, `${pockets} pockets` + (badPockets.length ? ', bad: ' + badPockets.slice(0, 4).join(' ') : ''));
  check('no door failures', W.stats.doorFailures === 0, `${W.stats.doorFailures}`);

  // ---------------------------------------------------------- reachability
  const G = BR.roomGraph(W, it), adj = new Map();
  for (const k of G.nodes.keys()) adj.set(k, []);
  for (const [a, b] of G.edges) if (adj.has(a) && adj.has(b)) { adj.get(a).push(b); adj.get(b).push(a); }
  const comp = new Map(), sizes = [];
  for (const k of adj.keys()) {
    if (comp.has(k)) continue;
    const c = sizes.length, st = [k];
    comp.set(k, c);
    let m = 0;
    while (st.length) { const u = st.pop(); m++; for (const v of adj.get(u)) if (!comp.has(v)) { comp.set(v, c); st.push(v); } }
    sizes.push(m);
  }
  const big = sizes.indexOf(Math.max(...sizes)), innerKeys = new Set(it.territories.filter(inner).map((T) => T.key));
  const lost = [...comp].filter(([k, c]) => c !== big && innerKeys.has(k.slice(0, k.lastIndexOf(':'))));
  check('every room is reachable', lost.length === 0, `${G.nodes.size} rooms, ${lost.length} unreachable` + (lost.length ? ': ' + lost.slice(0, 4).map((e) => e[0]).join(' ') : ''));
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
