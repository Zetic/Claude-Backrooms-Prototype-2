/*
 * layout.js - level 2: the plan. A gap-free tiling of the plane into
 * TERRITORIES (blocks of 14-84 m), each with an area, plus the rules for
 * every shared boundary. Nothing here builds rooms; it is cheap, so the map
 * can show areas and territories at any zoom.
 *
 * Super-cells (pinwheel lattice)
 * ------------------------------
 * The plane is cut by a lattice of spacing SC whose edges are each shifted by
 * a random 5-34 m. Horizontal edges shift up/down and vertical edges
 * left/right in a checkerboard pattern of signs; that pattern guarantees the
 * four edges around every lattice vertex leave a small rectangular GAP (never
 * an overlap). Each gap is given to one of the four super-cells around it as
 * an "ear". So every point of the plane belongs to exactly one super-cell,
 * computed from that point's neighbourhood only, and no straight line runs
 * across the map.
 *
 * Territories
 * -----------
 * Each super-cell (core rect + ears) is split recursively. The split rules
 * come from the area at the piece's centre, so offices get regular blocks,
 * parking huge ones, hotels long wings, Backrooms anything. Small ears join
 * the territory they touch. Every leaf is a territory: it tiles its super-cell,
 * so territories tile the world and every territory borders others on all sides.
 *
 * Rules between territories
 * -------------------------
 * For every adjacent pair: the shared segments, the wall (open / thin /
 * thick), how many doors, and whether the pair is
 *   base     - always gets its doors
 *   optional - may have none, but only if the two sides can still reach each
 *              other through base pairs within a few hops (so the map stays
 *              connected; whether a pair is base never depends on another
 *              pair's outcome, so drops can't cascade)
 *   never    - no ordinary door (pocket walls).
 * Mixed-area transitions are represented directly by their wall/door contract.
 * Maintenance is never inserted automatically along territory or biome edges.
 */
(function (root) {
  'use strict';
  const BR = root.BR;
  const { hash4, hashf, mix32, Rng } = BR;

  const CFG = {
    SC: 150, JMIN: 5, JMAX: 34,      // super-cell spacing and edge shift range (m)
    earMin: 12, earArea: 240,        // smaller ears join a neighbouring territory
    bypassHops: 5
  };
  const S = { H: 0x101, V: 0x102, BOX: 0x103, SPLIT: 0x104, TERR: 0x105, FRONT: 0x107, PAIR: 0x108 };

  // ---------------------------------------------------------------- lattice
  function mag(seed, i, j, s) { return CFG.JMIN + Math.floor(hashf(seed, i, j, s) * (CFG.JMAX - CFG.JMIN + 1)); }
  /** y of horizontal lattice edge H(i,j) (from vertex (i,j) to (i+1,j)) */
  function Hy(seed, i, j) { const m = mag(seed, i, j, S.H); return j * CFG.SC + (((i + j) & 1) === 0 ? m : -m); }
  /** x of vertical lattice edge V(i,j) (from vertex (i,j) to (i,j+1)) */
  function Vx(seed, i, j) { const m = mag(seed, i, j, S.V); return i * CFG.SC + (((i + j) & 1) === 0 ? -m : m); }

  /** Gap rectangle at lattice vertex (i,j) and which neighbour owns it (0 NW, 1 NE, 2 SW, 3 SE). */
  function vertexBox(seed, i, j) {
    const yA = Hy(seed, i - 1, j), yB = Hy(seed, i, j), xC = Vx(seed, i, j - 1), xD = Vx(seed, i, j);
    return { q: [Math.min(xC, xD), Math.min(yA, yB), Math.max(xC, xD), Math.max(yA, yB)], owner: hash4(seed, i, j, S.BOX) & 3 };
  }

  /** Super-cell (i,j): core rectangle plus the gap boxes it owns. */
  function superCell(seed, i, j) {
    const core = [Vx(seed, i, j), Hy(seed, i, j), Vx(seed, i + 1, j), Hy(seed, i, j + 1)];
    const ears = [];
    for (const [a, b, who] of [[i, j, 3], [i + 1, j, 2], [i, j + 1, 1], [i + 1, j + 1, 0]]) {
      const B = vertexBox(seed, a, b);
      if (B.owner === who && B.q[2] > B.q[0] && B.q[3] > B.q[1]) ears.push(B.q);
    }
    return { core, ears };
  }

  // ------------------------------------------------------------ territories
  /** Recursive split; the area at each piece's centre decides its grain. */
  function splitRect(W, q, rng, out, depth) {
    const w = q[2] - q[0], h = q[3] - q[1], Lg = Math.max(w, h), Sh = Math.min(w, h);
    const P = BR.AREAS[BR.areaAt(W, (q[0] + q[2]) / 2, (q[1] + q[3]) / 2).area].split;
    let across = false, split = false;          // across = cut parallel to the long side
    if (P.shortMax && Sh > P.shortMax && Sh >= 2 * P.tmin) { split = true; across = true; }
    else if (Lg > P.tmax) split = true;
    else if (Lg / Sh > P.maxAspect && Lg >= 2 * P.tmin) split = true;
    else if (Lg >= 2 * P.tmin && rng.f() < P.pSplit * (Lg - 2 * P.tmin + 1) / (P.tmax - 2 * P.tmin + 1)) split = true;
    const L = across ? Sh : Lg;
    if (!split || depth > 12 || L < 2 * P.tmin) { out.push(q); return; }
    const alongX = across ? w < h : w >= h;      // cut position runs along x
    const t = P.tmin + Math.round((L - 2 * P.tmin) * 0.5 * (rng.f() + rng.f()));
    if (alongX) {
      splitRect(W, [q[0], q[1], q[0] + t, q[3]], rng, out, depth + 1);
      splitRect(W, [q[0] + t, q[1], q[2], q[3]], rng, out, depth + 1);
    } else {
      splitRect(W, [q[0], q[1], q[2], q[1] + t], rng, out, depth + 1);
      splitRect(W, [q[0], q[1] + t, q[2], q[3]], rng, out, depth + 1);
    }
  }

  function contactLen(a, b) {
    const s = segBetween(a, b);
    return s ? s.s1 - s.s0 : 0;
  }

  /** All territories of super-cell (i,j). */
  function buildPlan(W, i, j) {
    const seed = W.seed, rng = new Rng(hash4(seed, i, j, S.SPLIT));
    const { core, ears } = superCell(seed, i, j);
    const leaves = [];
    splitRect(W, core, rng, leaves, 0);
    const groups = leaves.map((q) => [q]);
    for (const e of ears) {
      const w = e[2] - e[0], h = e[3] - e[1];
      if (Math.min(w, h) >= CFG.earMin && w * h >= CFG.earArea) {
        const ls = [];
        splitRect(W, e, rng, ls, 0);
        for (const q of ls) groups.push([q]);
      } else {
        // join the core territory it shares the longest edge with
        let best = 0, bl = -1;
        for (let g = 0; g < leaves.length; g++) { const l = contactLen(e, groups[g][0]); if (l > bl) { bl = l; best = g; } }
        groups[best].push(e);
      }
    }
    const territories = groups.map((rects, k) => {
      const m = rects[0], cx = (m[0] + m[2]) / 2, cy = (m[1] + m[3]) / 2;
      const a = BR.areaAt(W, cx, cy);
      let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      for (const r of rects) { bx0 = Math.min(bx0, r[0]); by0 = Math.min(by0, r[1]); bx1 = Math.max(bx1, r[2]); by1 = Math.max(by1, r[3]); }
      return {
        key: i + ',' + j + ':' + k, i, j, k, rects, cx, cy,
        base: a.area, district: a.district, manifestation: a.manifestation || a.district,
        manifestationForm: a.form || null, manifestationScale: a.scale || null,
        h: hash4(seed, i, j, k * 16 + S.TERR),
        bbox: [bx0, by0, bx1, by1],
        _adj: null, _final: undefined, _front: undefined
      };
    });
    return { i, j, core, ears, territories };
  }

  // -------------------------------------------------------------- adjacency
  /**
   * Shared boundary of rects a and b (arrays [x0,y0,x1,y1]):
   * { o: 'v'|'h', c, s0, s1, side } where side is a's side (0 top, 1 bottom,
   * 2 left, 3 right), or null.
   */
  function segBetween(a, b) {
    if (a[2] === b[0] || b[2] === a[0]) {
      const s0 = Math.max(a[1], b[1]), s1 = Math.min(a[3], b[3]);
      if (s1 > s0) return a[2] === b[0] ? { o: 'v', c: a[2], s0, s1, side: 3 } : { o: 'v', c: a[0], s0, s1, side: 2 };
    }
    if (a[3] === b[1] || b[3] === a[1]) {
      const s0 = Math.max(a[0], b[0]), s1 = Math.min(a[2], b[2]);
      if (s1 > s0) return a[3] === b[1] ? { o: 'h', c: a[3], s0, s1, side: 1 } : { o: 'h', c: a[1], s0, s1, side: 0 };
    }
    return null;
  }

  /** Neighbours of T: [{ U, segs: [{o, c, s0, s1, side, ri, uj}], len }] sorted by key. */
  function adjacency(W, T) {
    if (T._adj) return T._adj;
    const out = [], B = T.bbox;
    for (let a = T.i - 1; a <= T.i + 1; a++) for (let b = T.j - 1; b <= T.j + 1; b++) {
      for (const U of W.plan(a, b).territories) {
        if (U.key === T.key) continue;
        const C = U.bbox;
        if (C[0] > B[2] || C[2] < B[0] || C[1] > B[3] || C[3] < B[1]) continue;
        const segs = [];
        let len = 0;
        T.rects.forEach((r, ri) => U.rects.forEach((q, uj) => {
          const s = segBetween(r, q);
          if (s) { s.ri = ri; s.uj = uj; segs.push(s); len += s.s1 - s.s0; }
        }));
        if (segs.length) out.push({ U, segs, len });
      }
    }
    out.sort((p, q) => (p.U.key < q.U.key ? -1 : 1));
    T._adj = out;
    return out;
  }
  function adjEntry(W, A, B) {
    for (const n of adjacency(W, A)) if (n.U.key === B.key) return n;
    return null;
  }

  // ---------------------------------------------------------------- pockets
  /** Final area: pockets (Home, Maintenance rooms) replace host territories fully surrounded by the same host. */
  function finalArea(W, T) {
    if (T._final !== undefined) return T._final;
    let f = T.base;
    const bw = T.bbox[2] - T.bbox[0], bh = T.bbox[3] - T.bbox[1];
    for (const name of BR.POCKETS) {
      const P = BR.AREAS[name].pocket;
      if (P.hosts.indexOf(T.base) < 0) continue;
      if (Math.min(bw, bh) < P.minDim || Math.max(bw, bh) > P.maxDim) continue;
      if (hashf(W.seed, T.i, T.j, T.k * 256 + P.salt) >= P.p) continue;
      let ok = true;
      for (const n of adjacency(W, T)) if (n.U.base !== T.base) { ok = false; break; }
      if (ok) { f = name; break; }
    }
    T._final = f;
    return f;
  }

  /** The one neighbour a pocket's front door opens onto (weighted by shared length). */
  function frontOf(W, P) {
    if (P._front !== undefined) return P._front;
    const cands = adjacency(W, P).filter((n) => !BR.isPocket(finalArea(W, n.U)) && n.segs.some((sg) => sg.s1 - sg.s0 >= 3.2));
    let tot = 0;
    for (const n of cands) tot += n.len;
    let r = hashf(W.seed, P.i, P.j, P.k * 256 + S.FRONT) * tot, f = null;
    for (const n of cands) { r -= n.len; if (r < 0) { f = n.U.key; break; } }
    if (!f && cands.length) f = cands[cands.length - 1].U.key;
    P._front = f;
    return f;
  }

  // ----------------------------------------------------------------- pairs
  function pairKey(A, B) { return A.key < B.key ? A.key + '|' + B.key : B.key + '|' + A.key; }

  /**
   * Everything about the boundary between territories A and B. Canonical:
   * computed once for (lower key, higher key) and cached on the world.
   */
  function pairInfo(W, A, B) {
    if (B.key < A.key) { const t = A; A = B; B = t; }
    const key = A.key + '|' + B.key;
    let info = W.pairs.get(key);
    if (info) return info;
    const n = adjEntry(W, A, B);
    const fa = finalArea(W, A), fb = finalArea(W, B);
    const h = mix32(A.h ^ mix32(B.h + S.PAIR));
    const rng = new Rng(h);
    info = { key, a: A, b: B, segs: n ? n.segs : [], len: n ? n.len : 0, fa, fb, h,
      wall: 'thin', doors: 0, mode: 'base', wide: 0, _dc: undefined };
    const doorable = info.segs.some((sg) => sg.s1 - sg.s0 >= 3.2);   // room for a door at all
    if (!doorable) {
      info.mode = 'never';                       // corner contact: just a wall
      if (!BR.isPocket(fa) && !BR.isPocket(fb)) {
        const R = BR.rule(fa, fb);
        if (R && R.thick >= 0.5) info.wall = 'thick';
      }
    } else if (BR.isPocket(fa) || BR.isPocket(fb)) {
      if (BR.isPocket(fa) && BR.isPocket(fb)) info.mode = 'never';
      else {
        const P = BR.isPocket(fa) ? A : B, O = P === A ? B : A;
        if (frontOf(W, P) === O.key) info.doors = 1; else info.mode = 'never';
      }
    } else {
      const R = BR.rule(fa, fb), u = rng.f();
      info.wall = u < R.open ? 'open' : u < R.open + R.thick ? 'thick' : 'thin';
      info.doors = Math.max(R.min, Math.min(R.max, Math.round(info.len / R.every)));
      info.wide = R.wide;
      // Short contacts are optional too: their one door is the likeliest to
      // land on a solid, and a bypass usually exists.
      info.mode = info.wall === 'open' ? 'base' : rng.f() < R.pNone || info.len < 8 ? 'optional' : 'base';
    }
    W.pairs.set(key, info);
    if (W.pairs.size > W.limits.pairs) W.evict(W.pairs, Math.max(1,W.limits.pairs >> 2));
    return info;
  }

  function isBase(W, A, B) { return pairInfo(W, A, B).mode === 'base'; }

  /** Can A reach B within bypassHops over base pairs, without the direct A-B pair? */
  function bypass(W, A, B) {
    let frontier = [A];
    const seen = new Set([A.key]);
    for (let h = 0; h < CFG.bypassHops && frontier.length; h++) {
      const next = [];
      for (const u of frontier) for (const n of adjacency(W, u)) {
        const v = n.U;
        if (seen.has(v.key)) continue;
        if (u.key === A.key && v.key === B.key) continue;
        if (!isBase(W, u, v)) continue;
        if (v.key === B.key) return true;
        seen.add(v.key); next.push(v);
      }
      frontier = next;
    }
    return false;
  }

  /** Doors the A-B boundary actually gets (optional pairs drop to 0 when safe). */
  function doorCount(W, A, B) {
    const info = pairInfo(W, A, B);
    if (info._dc !== undefined) return info._dc;
    let d = info.mode === 'never' ? 0 : info.doors;
    if (info.mode === 'optional' && bypass(W, info.a, info.b)) d = 0;
    info._dc = d;
    return d;
  }

  /** Territory containing world point (x,y), or null. */
  function territoryAt(W, x, y) {
    const i0 = Math.floor(x / CFG.SC), j0 = Math.floor(y / CFG.SC);
    for (let a = i0 - 1; a <= i0 + 1; a++) for (let b = j0 - 1; b <= j0 + 1; b++) {
      for (const T of W.plan(a, b).territories) {
        const B = T.bbox;
        if (x < B[0] || x >= B[2] || y < B[1] || y >= B[3]) continue;
        for (const r of T.rects) if (x >= r[0] && x < r[2] && y >= r[1] && y < r[3]) return T;
      }
    }
    return null;
  }

  Object.assign(BR, {
    LAYOUT: CFG, superCell, buildPlan, segBetween, adjacency, finalArea, frontOf,
    pairKey, pairInfo, doorCount, bypass, territoryAt
  });
})(typeof window !== 'undefined' ? window : globalThis);
