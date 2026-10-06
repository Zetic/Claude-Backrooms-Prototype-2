/*
 * zones.js - what goes INSIDE a building block.
 *
 * A cluster's footprint is built from big "blocks". Each block becomes a ZONE
 * with a type picked from a catalogue (weighted by theme, avoiding the type of
 * its neighbours), and the type decides the interior: an open hall with
 * pillars, a ring corridor around a solid core, rows of stalls, an office with
 * partial partitions, a warren of small rooms, a store with shelves, an
 * enfilade gallery, a hotel corridor, a courtyard, a stairwell, a round room,
 * a pool... Large blocks are often SPLIT by one long wall into two zones of
 * different types first, which gives the big-to-small hierarchy.
 *
 * A zone records, in its part's integer grid:
 *   rooms   - walkable rooms ({ rects, kind }), the nodes of the room graph
 *   links   - openings between its rooms ({ a, b, x, y, w, kind })
 *   major / minor / hatch - wall segments (structural, partitions, stair treads)
 *   masses, voids, pools, props - solid rects (wall-coloured block, light well /
 *            courtyard hole, water, furniture)
 *   rounds  - rect minus a disc (round rooms)
 *   pillars - x, y, shape (0 square, 1 cross), size
 *   stairs  - x0, y0, x1, y1, axis: hooks for multi-floor connections
 *
 * Generators are written in a canonical frame (u along the long side, v across)
 * and mapped to the block with a random flip, so every layout appears in all
 * orientations. Everything is driven by the cluster's PRNG -> deterministic.
 */
(function (root) {
  'use strict';
  const BR = root.BR;

  // ------------------------------------------------------------ zone record
  class Zone {
    constructor(type, q) {
      this.type = type;
      this.q = q;                 // [x0, y0, x1, y1]
      this.base = 0;              // index of rooms[0] in the part's room list
      this.rooms = [];
      this.links = [];
      this.major = []; this.minor = []; this.hatch = [];
      this.masses = []; this.voids = []; this.pools = []; this.props = [];
      this.rounds = []; this.pillars = []; this.stairs = [];
      this.sub = [];              // nested zone types (split)
      this.noDoor = [];           // flat rects no outside door may open into (en-suites)
    }
    room(rects, kind) { this.rooms.push({ rects, kind }); return this.rooms.length - 1; }
    link(a, b, x, y, w, kind) { if (a >= 0 && b >= 0 && a !== b) this.links.push({ a, b, x, y, w, kind }); }
    /** Is (x,y) blocked by something solid (margin m)? */
    solidAt(x, y, m) {
      const L = [this.masses, this.voids, this.pools, this.props];
      for (let t = 0; t < 4; t++) {
        const A = L[t];
        for (let k = 0; k < A.length; k += 4)
          if (x > A[k] - m && x < A[k + 2] + m && y > A[k + 1] - m && y < A[k + 3] + m) return true;
      }
      const R = this.rounds;
      for (let k = 0; k < R.length; k += 7) {
        if (x < R[k + 3] || x > R[k + 5] || y < R[k + 4] || y > R[k + 6]) continue;
        const dx = x - R[k], dy = y - R[k + 1], rr = R[k + 2] - m;
        if (dx * dx + dy * dy > rr * rr) return true;
      }
      const P = this.pillars;
      for (let k = 0; k < P.length; k += 4) {
        const h = P[k + 3] / 2 + m;
        if (Math.abs(x - P[k]) < h && Math.abs(y - P[k + 1]) < h) return true;
      }
      return false;
    }
    /** Zone-local room containing (x,y), or -1 if outside / blocked. */
    roomAt(x, y) {
      if (this.solidAt(x, y, 0.3)) return -1;
      for (let i = 0; i < this.rooms.length; i++) {
        const R = this.rooms[i].rects;
        for (let k = 0; k < R.length; k++) {
          const q = R[k];
          if (x >= q[0] && x <= q[2] && y >= q[1] && y <= q[3]) return i;
        }
      }
      return -1;
    }
    /** Like roomAt, but -1 where an outside door must not land. */
    doorRoomAt(x, y) {
      const N = this.noDoor;
      for (let k = 0; k < N.length; k += 4) if (x > N[k] && x < N[k + 2] && y > N[k + 1] && y < N[k + 3]) return -1;
      return this.roomAt(x, y);
    }
  }

  // ---------------------------------------------------------------- frames
  /** Canonical (u,v) frame for a block: U = long side, V = short side, random flips. */
  function frame(q, rng) {
    const x0 = q[0], y0 = q[1], w = q[2] - q[0], h = q[3] - q[1];
    const swap = h > w, U = swap ? h : w, V = swap ? w : h;
    const fu = rng.f() < 0.5, fv = rng.f() < 0.5;
    const X = (u, v) => x0 + (swap ? (fv ? V - v : v) : (fu ? U - u : u));
    const Y = (u, v) => y0 + (swap ? (fu ? U - u : u) : (fv ? V - v : v));
    const rect = (u0, v0, u1, v1) => {
      const a = X(u0, v0), b = Y(u0, v0), c = X(u1, v1), d = Y(u1, v1);
      return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
    };
    return { U, V, X, Y, rect, swap };
  }
  function seg(F, list, u0, v0, u1, v1) { list.push(F.X(u0, v0), F.Y(u0, v0), F.X(u1, v1), F.Y(u1, v1)); }
  function box(F, list, u0, v0, u1, v1) { const r = F.rect(u0, v0, u1, v1); list.push(r[0], r[1], r[2], r[3]); }
  /**
   * Wall along a line with gaps. alongU: wall runs in u at v = c (else in v at
   * u = c) from s0 to s1; gaps = [[g0, g1], ...] in the running coordinate.
   */
  function wallGaps(F, list, alongU, c, s0, s1, gaps) {
    const G = gaps.slice().sort((a, b) => a[0] - b[0]);
    let s = s0;
    const out = (a, b) => {
      if (b - a < 0.05) return;
      if (alongU) seg(F, list, a, c, b, c); else seg(F, list, c, a, c, b);
    };
    for (const g of G) { out(s, Math.max(s, g[0])); s = Math.max(s, g[1]); }
    out(s, s1);
  }
  function overlaps(boxes, b, m) {
    for (const o of boxes) if (b[0] < o[2] + m && o[0] < b[2] + m && b[1] < o[3] + m && o[1] < b[3] + m) return true;
    return false;
  }

  // ------------------------------------------------------- shared features
  function pillarGrid(F, Z, rng, u0, v0, u1, v1, cross, sp) {
    const U = u1 - u0, V = v1 - v0;
    sp = sp || rng.int(4, 8);
    const size = cross ? rng.range(1.5, 2.3) : rng.range(0.6, 1.2);
    const m = Math.max(2.2, size / 2 + 1.7);
    const nu = Math.floor((U - 2 * m) / sp) + 1, nv = Math.floor((V - 2 * m) / sp) + 1;
    if (U - 2 * m < 0 || V - 2 * m < 0) return 0;
    const su = u0 + (U - (nu - 1) * sp) / 2, sv = v0 + (V - (nv - 1) * sp) / 2;
    for (let a = 0; a < nu; a++) for (let b = 0; b < nv; b++)
      Z.pillars.push(F.X(su + a * sp, sv + b * sp), F.Y(su + a * sp, sv + b * sp), cross ? 1 : 0, size);
    return nu * nv;
  }

  /** Free-standing wall glyphs (I, L, T, U) inside [u0,v0,u1,v1]. */
  function fragments(F, Z, rng, u0, v0, u1, v1, list, boxes) {
    const U = u1 - u0, V = v1 - v0;
    boxes = boxes || [];
    const n = rng.int(1, Math.max(1, Math.min(6, 1 + Math.floor(U * V / 160))));
    for (let k = 0, tries = 0; k < n && tries < n * 8; tries++) {
      const shape = rng.weighted({ I: 2, L: 2.5, T: 1.5, U: 0.8 });
      const a = rng.int(3, Math.max(3, Math.min(10, Math.floor(U * 0.45))));
      const b = shape === 'I' ? 0 : rng.int(2, Math.max(2, Math.min(5, Math.floor(V * 0.4))));
      const rot = rng.f() < 0.5, bw = rot ? b : a, bh = rot ? a : b;
      if (bw > U - 4 || bh > V - 4) continue;
      const pu = u0 + 2 + rng.int(0, Math.max(0, Math.floor(U - 4 - bw)));
      const pv = v0 + 2 + rng.int(0, Math.max(0, Math.floor(V - 4 - bh)));
      const bb = [pu, pv, pu + bw, pv + bh];
      if (overlaps(boxes, bb, 2)) continue;
      boxes.push(bb);
      const fx = rng.f() < 0.5, fy = rng.f() < 0.5;
      const S = (s, t) => [pu + (fx ? bw - s : s), pv + (fy ? bh - t : t)];
      const W = (s0, t0, s1, t1) => { const p = S(s0, t0), q = S(s1, t1); seg(F, list || Z.major, p[0], p[1], q[0], q[1]); };
      if (shape === 'I') { if (bw >= bh) W(0, 0, bw, 0); else W(0, 0, 0, bh); }
      else if (shape === 'L') { W(0, 0, bw, 0); W(0, 0, 0, bh); }
      else if (shape === 'T') { if (bw >= bh) { W(0, 0, bw, 0); W(bw / 2, 0, bw / 2, bh); } else { W(0, 0, 0, bh); W(0, bh / 2, bw, bh / 2); } }
      else { W(0, 0, 0, bh); W(0, bh, bw, bh); W(bw, 0, bw, bh); }
      k++;
    }
    return boxes;
  }

  function smallMasses(F, Z, rng, u0, v0, u1, v1, boxes) {
    boxes = boxes || [];
    const n = rng.int(1, 4);
    for (let k = 0, t = 0; k < n && t < 20; t++) {
      const a = rng.int(1, 2), b = rng.int(1, 3);
      if (u1 - u0 < a + 5 || v1 - v0 < b + 5) return boxes;
      const pu = u0 + 2.5 + rng.int(0, Math.floor(u1 - u0 - a - 5)), pv = v0 + 2.5 + rng.int(0, Math.floor(v1 - v0 - b - 5));
      const bb = [pu, pv, pu + a, pv + b];
      if (overlaps(boxes, bb, 2)) continue;
      boxes.push(bb); box(F, Z.masses, bb[0], bb[1], bb[2], bb[3]); k++;
    }
    return boxes;
  }

  function stairsIn(F, Z, rng, u0, v0, u1, v1) {
    const U = u1 - u0, V = v1 - v0;
    const L = Math.min(Math.floor(U - 2), rng.int(5, 9)), Wd = Math.min(Math.floor(V - 2), rng.int(2, 3));
    if (L < 4 || Wd < 2) return false;
    const su = u0 + 1 + rng.int(0, Math.max(0, Math.floor(U - 2 - L)));
    const sv = rng.f() < 0.5 ? v0 + 1 : v1 - 1 - Wd;
    for (let t = 0.6; t < L; t += 0.7) seg(F, Z.hatch, su + t, sv, su + t, sv + Wd);
    seg(F, Z.minor, su, sv, su + L, sv); seg(F, Z.minor, su, sv + Wd, su + L, sv + Wd);
    const r = F.rect(su, sv, su + L, sv + Wd);
    Z.stairs.push(r[0], r[1], r[2], r[3], F.swap ? 1 : 0);
    return true;
  }

  // ----------------------------------------------------------- BSP helper
  function bsp(q, rng, target, pCorr, hallW) {
    const minSide = 3, leaves = [];
    const split = (x0, y0, x1, y1, depth) => {
      const w = x1 - x0, h = y1 - y0;
      const stop = w * h < target * (0.6 + 0.8 * rng.f()) || (w < 2 * minSide + 1 && h < 2 * minSide + 1) || depth > 8;
      if (stop) { leaves.push({ q: [x0, y0, x1, y1], hall: false }); return; }
      let vert = w > h ? rng.f() < 0.85 : rng.f() < 0.15;
      if (w < 2 * minSide + 1) vert = false;
      if (h < 2 * minSide + 1) vert = true;
      const cw = w * h > 240 && rng.f() < pCorr ? hallW : 0;
      const L = vert ? w : h;
      if (L - cw < 2 * minSide) { leaves.push({ q: [x0, y0, x1, y1], hall: false }); return; }
      const k = rng.int(minSide, L - minSide - cw);
      if (vert) {
        split(x0, y0, x0 + k, y1, depth + 1);
        if (cw) leaves.push({ q: [x0 + k, y0, x0 + k + cw, y1], hall: true });
        split(x0 + k + cw, y0, x1, y1, depth + 1);
      } else {
        split(x0, y0, x1, y0 + k, depth + 1);
        if (cw) leaves.push({ q: [x0, y0 + k, x1, y0 + k + cw], hall: true });
        split(x0, y0 + k + cw, x1, y1, depth + 1);
      }
    };
    split(q[0], q[1], q[2], q[3], 0);
    return leaves;
  }

  function shared(a, b) {
    if (a[2] === b[0] || b[2] === a[0]) {
      const s0 = Math.max(a[1], b[1]), s1 = Math.min(a[3], b[3]);
      if (s1 > s0) return { v: true, c: a[2] === b[0] ? a[2] : a[0], s0, s1, len: s1 - s0 };
    }
    if (a[3] === b[1] || b[3] === a[1]) {
      const s0 = Math.max(a[0], b[0]), s1 = Math.min(a[2], b[2]);
      if (s1 > s0) return { v: false, c: a[3] === b[1] ? a[3] : a[1], s0, s1, len: s1 - s0 };
    }
    return null;
  }
  function makeUF(n) {
    const p = new Int32Array(n);
    for (let i = 0; i < n; i++) p[i] = i;
    const find = (x) => { while (p[x] !== x) { p[x] = p[p[x]]; x = p[x]; } return x; };
    const union = (a, b) => { a = find(a); b = find(b); if (a === b) return false; if (a < b) p[b] = a; else p[a] = b; return true; };
    return { find, union };
  }

  /**
   * Doors between tiled cells: random spanning tree (+ loops), some walls
   * removed entirely, every other shared edge a wall with a doorway or a wall.
   */
  function connectCells(Z, cells, rng, st, o) {
    const out = o.major ? Z.major : Z.minor, n = cells.length, adj = [];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const e = shared(cells[i].q, cells[j].q);
      if (e) { e.a = i; e.b = j; e.w = rng.f(); adj.push(e); }
    }
    adj.sort((p, q) => p.w - q.w);
    const uf = makeUF(n);
    for (const e of adj) {
      if (e.len < 1.4) continue;
      const tree = uf.union(e.a, e.b);
      if (!tree && rng.f() > o.pLoop) continue;
      const mid = (e.s0 + e.s1) / 2;
      if (rng.f() < o.pOpen) {
        e.open = true;
        Z.link(cells[e.a].room, cells[e.b].room, e.v ? e.c : mid, e.v ? mid : e.c, e.len, 'opening');
        continue;
      }
      const dw = rng.f() < st.pWide ? e.len * rng.range(0.45, 0.85) : Math.min(st.doorW, e.len - 0.6);
      const c = e.s0 + dw / 2 + 0.3 + rng.f() * Math.max(0, e.len - dw - 0.6);
      e.door = [c - dw / 2, c + dw / 2];
      Z.link(cells[e.a].room, cells[e.b].room, e.v ? e.c : c, e.v ? c : e.c, dw, 'door');
    }
    for (const e of adj) {
      if (e.open) continue;
      const push = (a, b) => { if (b - a < 0.05) return; if (e.v) out.push(e.c, a, e.c, b); else out.push(a, e.c, b, e.c); };
      if (e.door) { push(e.s0, e.door[0]); push(e.door[1], e.s1); } else push(e.s0, e.s1);
    }
  }

  // ------------------------------------------------------------ generators
  const GEN = {};

  /** Open hall: one room; pillars, free-standing wall glyphs, small solids or a solid core. */
  GEN.open = (Z, q, rng, st, o) => {
    const F = frame(q, rng), U = F.U, V = F.V;
    Z.room([q.slice()], o.landmark ? 'grand hall' : 'hall');
    const feat = o.feature || rng.weighted(V >= 10
      ? { pillars: 0.4 + 1.6 * st.pillars, fragments: 1.3, masses: 0.6, core: U * V > 360 ? 0.6 : 0, none: 0.8 }
      : { fragments: 1, masses: 0.5, none: 1.6 });
    if (feat === 'pillars') pillarGrid(F, Z, rng, 0, 0, U, V, o.cross !== undefined ? o.cross : rng.f() < 0.3, o.sp);
    else if (feat === 'fragments') fragments(F, Z, rng, 0, 0, U, V);
    else if (feat === 'masses') smallMasses(F, Z, rng, 0, 0, U, V);
    else if (feat === 'core') {
      const cu = Math.max(2, Math.round(U * rng.range(0.2, 0.42))), cv = Math.max(2, Math.round(V * rng.range(0.2, 0.45)));
      const u0 = Math.max(3, Math.min(U - 3 - cu, Math.round((U - cu) / 2 + rng.range(-0.25, 0.25) * U)));
      const v0 = Math.max(3, Math.min(V - 3 - cv, Math.round((V - cv) / 2)));
      if (u0 + cu <= U - 3 && v0 + cv <= V - 3) box(F, Z.masses, u0, v0, u0 + cu, v0 + cv);
    }
    if (V >= 8 && feat !== 'pillars' && rng.f() < 0.08) stairsIn(F, Z, rng, 0, 0, U, V);
  };

  /** One long wall splits the block into two zones of different types. */
  GEN.split = (Z, q, rng, st, o) => {
    const F = frame(q, rng), U = F.U, V = F.V, depth = o.depth || 0;
    if (U < 12) return GEN.open(Z, q, rng, st, o);
    const t = Math.round(U * rng.range(0.34, 0.66));
    const A = F.rect(0, 0, t, V), B = F.rect(t, 0, U, V);
    const ta = pickZoneType(rng, st.zones, A, null, depth + 1);
    const tb = pickZoneType(rng, st.zones, B, [ta], depth + 1);
    fill(Z, ta, A, rng, st, { depth: depth + 1 });
    fill(Z, tb, B, rng, st, { depth: depth + 1 });
    // openings where both sides are walkable
    const wide = rng.f() < 0.4;
    const ow = wide ? rng.range(3, Math.max(3.2, Math.min(8, V * 0.45))) : rng.range(1.4, 2.2);
    const cand = [];
    for (let v = 0.6 + ow / 2; v <= V - 0.6 - ow / 2 + 1e-9; v += 0.5) {
      const ra = Z.roomAt(F.X(t - 0.6, v), F.Y(t - 0.6, v)), rb = Z.roomAt(F.X(t + 0.6, v), F.Y(t + 0.6, v));
      if (ra >= 0 && rb >= 0) cand.push([v, ra, rb]);
    }
    const gaps = [];
    if (cand.length) {
      const first = cand[Math.floor(rng.f() * cand.length)];
      const picks = [first];
      if (V > 14 && rng.f() < 0.5) {
        const far = cand.filter((c) => Math.abs(c[0] - first[0]) > V / 3);
        if (far.length) picks.push(far[Math.floor(rng.f() * far.length)]);
      }
      for (const [v, ra, rb] of picks) {
        gaps.push([v - ow / 2, v + ow / 2]);
        Z.link(ra, rb, F.X(t, v), F.Y(t, v), ow, wide ? 'opening' : 'door');
      }
      wallGaps(F, Z.major, false, t, 0, V, gaps);
      return;
    }
    // no walkable pair right at the seam: leave it open (no wall) and link the
    // nearest walkable points a little further in
    for (const d of [1.2, 2, 3, 4.5]) for (let v = 0.5; v < V; v += 0.5) {
      const ra = Z.roomAt(F.X(t - d, v), F.Y(t - d, v)), rb = Z.roomAt(F.X(t + d, v), F.Y(t + d, v));
      if (ra >= 0 && rb >= 0) { Z.link(ra, rb, F.X(t, v), F.Y(t, v), V, 'opening'); return; }
    }
  };

  /** Ring corridor around a core (solid block, light well, room, warren or pillar hall). */
  GEN.ring = (Z, q, rng, st, o) => {
    const F = frame(q, rng), U = F.U, V = F.V;
    const cw = rng.f() < 0.6 ? 2 : 3;
    if (V < 2 * cw + 5 || U < 2 * cw + 6) return GEN.open(Z, q, rng, st, o);
    Z.room([F.rect(0, 0, U, cw), F.rect(0, V - cw, U, V), F.rect(0, cw, cw, V - cw), F.rect(U - cw, cw, U, V - cw)], 'corridor');
    const cq = F.rect(cw, cw, U - cw, V - cw);
    const kind = o.core || rng.weighted({ mass: 1.3, void: 0.3, room: 1, warren: (U - 2 * cw) * (V - 2 * cw) > 90 ? 0.9 : 0, pillars: 0.5 });
    if (kind === 'mass') { Z.masses.push(cq[0], cq[1], cq[2], cq[3]); return; }
    if (kind === 'void') { Z.voids.push(cq[0], cq[1], cq[2], cq[3]); return; }
    if (kind === 'warren') GEN.warren(Z, cq, rng, st, o);
    else if (kind === 'pillars') { Z.room([cq.slice()], 'hall'); pillarGrid(frame(cq, rng), Z, rng, 0, 0, Math.max(cq[2] - cq[0], cq[3] - cq[1]), Math.min(cq[2] - cq[0], cq[3] - cq[1]), false); }
    else Z.room([cq.slice()], 'room');
    // core walls with 1-3 doors
    const sides = [[true, cw, cw, U - cw], [true, V - cw, cw, U - cw], [false, cw, cw, V - cw], [false, U - cw, cw, V - cw]];
    const nd = Math.min(4, rng.int(1, 2) + (U * V > 500 ? 1 : 0));
    const chosen = new Set();
    while (chosen.size < nd) chosen.add(rng.int(0, 3));
    sides.forEach(([alongU, c, s0, s1], k) => {
      const gaps = [];
      if (chosen.has(k) && s1 - s0 >= 3) {
        const dw = Math.min(st.doorW, s1 - s0 - 1.2);
        for (let t = 0; t < 8; t++) {
          const s = s0 + 0.6 + dw / 2 + rng.f() * Math.max(0, s1 - s0 - 1.2 - dw);
          const inner = c === cw ? c + 0.6 : c - 0.6, outer = c === cw ? c - 0.6 : c + 0.6;
          const pi = alongU ? [s, inner] : [inner, s], po = alongU ? [s, outer] : [outer, s];
          const ri = Z.roomAt(F.X(pi[0], pi[1]), F.Y(pi[0], pi[1])), ro = Z.roomAt(F.X(po[0], po[1]), F.Y(po[0], po[1]));
          if (ri < 0 || ro < 0) continue;
          gaps.push([s - dw / 2, s + dw / 2]);
          const pc = alongU ? [s, c] : [c, s];
          Z.link(ro, ri, F.X(pc[0], pc[1]), F.Y(pc[0], pc[1]), dw, 'door');
          break;
        }
      }
      wallGaps(F, Z.major, alongU, c, s0, s1, gaps);
    });
  };

  /** Rows of stalls / cubicles / cells off an aisle. */
  GEN.stalls = (Z, q, rng, st, o) => {
    const F = frame(q, rng), U = F.U, V = F.V;
    const cells = rng.f() < 0.35;
    const sw = cells ? rng.int(3, 5) : rng.int(2, 3), sd = Math.min(V - 3, cells ? rng.int(4, 6) : rng.int(3, 4));
    if (V < 6 || U < 8 || sd < 3) return GEN.open(Z, q, rng, st, o);
    const both = V >= 2 * sd + 3 && rng.f() < 0.65;
    const fronts = rng.f() < 0.5;
    const e0 = rng.int(0, 3), e1 = rng.int(0, 3);
    const n = Math.floor((U - e0 - e1) / sw);
    if (n < 2) return GEN.open(Z, q, rng, st, o);
    const s0 = e0 + Math.floor((U - e0 - e1 - n * sw) / 2), s1 = s0 + n * sw;
    const rows = both ? [[0, sd, sd], [V - sd, V, V - sd]] : [[0, sd, sd]];
    const aisleRects = [F.rect(0, sd, U, both ? V - sd : V)];
    for (const [va, vb] of rows) {
      if (s0 > 0) aisleRects.push(F.rect(0, va, s0, vb));
      if (s1 < U) aisleRects.push(F.rect(s1, va, U, vb));
    }
    const aisle = Z.room(aisleRects, 'aisle');
    for (const [va, vb, front] of rows) {
      for (let k = 0; k <= n; k++) seg(F, Z.minor, s0 + k * sw, va, s0 + k * sw, vb);
      for (let k = 0; k < n; k++) {
        const u = s0 + k * sw, r = Z.room([F.rect(u, va, u + sw, vb)], cells ? 'cell' : 'stall');
        const g = Math.min(1.3, sw - 0.8);
        if (fronts) wallGaps(F, Z.minor, true, front, u, u + sw, [[u + sw / 2 - g / 2, u + sw / 2 + g / 2]]);
        Z.link(aisle, r, F.X(u + sw / 2, front), F.Y(u + sw / 2, front), fronts ? g : sw, fronts ? 'door' : 'opening');
      }
    }
    // a big leftover aisle gets something in it
    const free = both ? V - 2 * sd : V - sd;
    if (free >= 9 && rng.f() < 0.6) fragments(F, Z, rng, 0, sd + 1, U, sd + free - 1);
  };

  /** Open-plan office: closets with doors along one wall, partial partitions, desks or pods. */
  GEN.office = (Z, q, rng, st, o) => {
    const F = frame(q, rng), U = F.U, V = F.V;
    if (V < 7 || U < 9) return GEN.open(Z, q, rng, st, o);
    let cd = 0;
    const closets = [], extra = [];
    if (V >= 12 && rng.f() < 0.7) {
      cd = rng.int(3, 5);
      for (let u = 0; u < U;) {
        if (U - u < 3) { extra.push([u, U]); break; }
        if (rng.f() < 0.22) { const g = Math.min(U - u, rng.int(2, 5)); extra.push([u, u + g]); u += g; continue; }
        let w = Math.min(rng.int(3, 7), U - u);
        if (U - u - w < 3) w = U - u;
        closets.push([u, u + w]); u += w;
      }
    }
    const mainRects = [F.rect(0, cd, U, V)];
    for (const [a, b] of extra) mainRects.push(F.rect(a, 0, b, cd));
    const main = Z.room(mainRects, 'office');
    for (const [a, b] of closets) {
      const r = Z.room([F.rect(a, 0, b, cd)], 'closet');
      seg(F, Z.minor, a, 0, a, cd); seg(F, Z.minor, b, 0, b, cd);
      const dw = Math.min(st.doorW, b - a - 1), c = a + 0.5 + dw / 2 + rng.f() * Math.max(0, b - a - 1 - dw);
      wallGaps(F, Z.minor, true, cd, a, b, [[c - dw / 2, c + dw / 2]]);
      Z.link(main, r, F.X(c, cd), F.Y(c, cd), dw, 'door');
    }
    const v0 = cd, D = V - cd;
    const feat = rng.weighted({ partitions: 1.4, pods: D >= 10 && U >= 14 ? 1 : 0, desks: 1, mixed: D >= 10 ? 0.8 : 0 });
    const stubs = (maxFrac) => {
      const k = rng.int(1, 3), used = [];
      for (let i = 0, t = 0; i < k && t < 12; t++) {
        if (rng.f() < 0.6 || D < 9) {            // stub from the far wall
          const u = rng.int(3, Math.max(3, U - 3));
          if (used.some((x) => Math.abs(x - u) < 3)) continue;
          used.push(u);
          seg(F, Z.minor, u, V, u, V - Math.max(2, D * rng.range(0.3, maxFrac)));
        } else {                                  // long wall parallel to the closets, open at one end
          const v = v0 + rng.int(3, Math.max(3, D - 3));
          const gap = rng.int(3, Math.max(3, Math.floor(U * 0.3)));
          if (rng.f() < 0.5) seg(F, Z.minor, 0, v, U - gap, v); else seg(F, Z.minor, gap, v, U, v);
          i += 1;                                 // long walls count double
        }
        i++;
      }
    };
    const desks = (va, vb) => {
      const big = rng.f() < 0.4, dw = big ? 3 : 2, dd = big ? 2 : 1, pu = dw + rng.int(1, 2), pv = dd + rng.int(2, 3);
      for (let u = 2.5; u + dw <= U - 2.5; u += pu) for (let v = va + 2.5; v + dd <= vb - 2.5; v += pv) box(F, Z.props, u, v, u + dw, v + dd);
    };
    if (feat === 'partitions') stubs(0.7);
    else if (feat === 'desks') desks(v0, V);
    else if (feat === 'pods') {
      const sp = rng.int(6, 7), arm = 2.2;
      for (let u = 3 + arm; u <= U - 3 - arm; u += sp) for (let v = v0 + 3 + arm; v <= V - 3 - arm; v += sp) {
        seg(F, Z.minor, u - arm, v, u + arm, v); seg(F, Z.minor, u, v - arm, u, v + arm);
      }
    } else { stubs(0.42); desks(v0, v0 + D * 0.5); }
  };

  /** Warren of small rooms (BSP) with doors. */
  GEN.warren = (Z, q, rng, st, o) => {
    const leaves = bsp(q, rng, st.roomArea * rng.range(0.6, 1.25), st.pBspCorr, st.hallW);
    const cells = leaves.map((l) => ({ room: Z.room([l.q], l.hall ? 'corridor' : 'room'), q: l.q }));
    connectCells(Z, cells, rng, st, { pOpen: st.pOpen * 0.5, pLoop: st.pLoop, major: false });
  };

  /** Store: shelving aisles, or thick walls with counters, or a big empty box with columns. */
  GEN.store = (Z, q, rng, st, o) => {
    const F = frame(q, rng), U = F.U, V = F.V;
    Z.room([q.slice()], 'store');
    const kind = rng.weighted({ shelves: V >= 9 && U >= 11 ? 1.5 : 0, thick: 1.2, columns: U * V > 200 ? 0.8 : 0 });
    if (kind === 'shelves') {
      const pitch = rng.int(3, 4), cross = U > 22 && rng.f() < 0.5, mid = Math.round(U / 2);
      for (let v = 3; v + 1 <= V - 3; v += pitch) {
        if (cross) { box(F, Z.props, 3, v, mid - 1, v + 1); box(F, Z.props, mid + 1, v, U - 3, v + 1); }
        else box(F, Z.props, 3, v, U - 3, v + 1);
      }
    } else if (kind === 'thick') {
      for (const [va, vb] of [[0, 1], [V - 1, V]]) {
        const gaps = [];
        const ng = rng.int(1, 2);
        for (let g = 0; g < ng; g++) { const w = rng.int(2, 3), u = rng.int(1, Math.max(1, U - 1 - w)); gaps.push([u, u + w]); }
        gaps.sort((a, b) => a[0] - b[0]);
        let s = 0;
        for (const [a, b] of gaps) { if (a - s >= 1) box(F, Z.masses, s, va, a, vb); s = Math.max(s, b); }
        if (U - s >= 1) box(F, Z.masses, s, va, U, vb);
      }
      if (U >= 10) { const cu = rng.f() < 0.5 ? 2.5 : U - 3.5; box(F, Z.props, cu, 2.5, cu + 1, Math.max(3.5, V - 2.5)); }
    } else {
      const sp = rng.int(5, 7);
      for (let u = sp / 2 + 1.5; u <= U - 2.5; u += sp) for (let v = sp / 2 + 1.5; v <= V - 2.5; v += sp) box(F, Z.masses, u - 0.5, v - 0.5, u + 0.5, v + 0.5);
    }
  };

  /** Long block: an enfilade of rooms in a row, or rooms off a side corridor. */
  GEN.gallery = (Z, q, rng, st, o) => {
    const F = frame(q, rng), U = F.U, V = F.V;
    if (U < 10) return GEN.open(Z, q, rng, st, o);
    const side = V >= 7 && rng.f() < 0.45 && !o.landmark;
    const cuts = [0];
    const lmin = o.landmark ? 8 : 4, lmax = o.landmark ? 16 : 11;
    while (U - cuts[cuts.length - 1] > lmax) cuts.push(cuts[cuts.length - 1] + rng.int(lmin, lmax));
    cuts.push(U);
    if (side) {
      const cw = rng.int(2, 3);
      const cor = Z.room([F.rect(0, 0, U, cw)], 'corridor');
      for (let k = 0; k + 1 < cuts.length; k++) {
        const a = cuts[k], b = cuts[k + 1], r = Z.room([F.rect(a, cw, b, V)], 'room');
        if (k > 0) seg(F, Z.minor, a, cw, a, V);
        const dw = Math.min(st.doorW, b - a - 1), c = a + 0.5 + dw / 2 + rng.f() * Math.max(0, b - a - 1 - dw);
        wallGaps(F, Z.minor, true, cw, a, b, [[c - dw / 2, c + dw / 2]]);
        Z.link(cor, r, F.X(c, cw), F.Y(c, cw), dw, 'door');
      }
    } else {
      const rooms = [];
      for (let k = 0; k + 1 < cuts.length; k++) rooms.push(Z.room([F.rect(cuts[k], 0, cuts[k + 1], V)], o.landmark ? 'gallery' : 'room'));
      const off = rng.f() < 0.3;
      for (let k = 1; k + 1 < cuts.length; k++) {
        const dw = o.landmark ? Math.min(V * 0.5, rng.range(2, 4)) : Math.min(st.doorW + 0.4, V - 1.2);
        const v = off ? (k % 2 ? V * 0.28 : V * 0.72) : V / 2;
        wallGaps(F, Z.major, false, cuts[k], 0, V, [[v - dw / 2, v + dw / 2]]);
        Z.link(rooms[k - 1], rooms[k], F.X(cuts[k], v), F.Y(cuts[k], v), dw, 'door');
      }
      if (V >= 8 && (o.landmark || rng.f() < 0.35)) {
        // colonnade down each long room
        for (let k = 0; k + 1 < cuts.length; k++) {
          const a = cuts[k], b = cuts[k + 1];
          for (let u = a + 2.5; u <= b - 2.5; u += 3.5) {
            Z.pillars.push(F.X(u, 2), F.Y(u, 2), 0, 0.8, F.X(u, V - 2), F.Y(u, V - 2), 0, 0.8);
          }
        }
      }
    }
  };

  /** Hotel corridor: a central corridor with rooms on one or both sides, each with a door. */
  GEN.corridorRooms = (Z, q, rng, st, o) => {
    const F = frame(q, rng), U = F.U, V = F.V;
    const cw = rng.int(2, 3);
    if (V < cw + 3 || U < 8) return GEN.open(Z, q, rng, st, o);
    const both = V >= cw + 6;
    let ca = both ? Math.floor((V - cw) / 2) + rng.int(-1, 1) : (rng.f() < 0.5 ? 0 : V - cw);
    if (both) ca = Math.max(3, Math.min(V - cw - 3, ca));
    const cor = Z.room([F.rect(0, ca, U, ca + cw)], 'corridor');
    const bands = [];
    if (ca >= 3) bands.push([0, ca, ca]);
    if (V - ca - cw >= 3) bands.push([ca + cw, V, ca + cw]);
    for (const [b0, b1, front] of bands) {
      for (let u = 0; u < U;) {
        let w = Math.max(3, Math.round(rng.range(3, 7) * Math.min(1.3, st.roomScale)));
        if (U - u - w < 3) w = U - u;
        const r = Z.room([F.rect(u, b0, u + w, b1)], 'room');
        if (u > 0) seg(F, Z.minor, u, b0, u, b1);
        const dw = Math.min(st.doorW, w - 1), c = u + 0.5 + dw / 2 + rng.f() * Math.max(0, w - 1 - dw);
        wallGaps(F, Z.minor, true, front, u, u + w, [[c - dw / 2, c + dw / 2]]);
        Z.link(cor, r, F.X(c, front), F.Y(c, front), dw, 'door');
        u += w;
      }
    }
  };

  /** Courtyard: a walkway around a light well, often with an arcade of pillars. */
  GEN.courtyard = (Z, q, rng, st, o) => {
    const F = frame(q, rng), U = F.U, V = F.V;
    const ww = o.landmark ? rng.int(4, 6) : rng.int(3, 5);
    if (V < 2 * ww + 4) return GEN.open(Z, q, rng, st, o);
    const ring = Z.room([F.rect(0, 0, U, ww), F.rect(0, V - ww, U, V), F.rect(0, ww, ww, V - ww), F.rect(U - ww, ww, U, V - ww)], o.landmark ? 'atrium' : 'courtyard');
    if (o.landmark || rng.f() < (o.garden ? 0.15 : 0.4)) box(F, Z.voids, ww, ww, U - ww, V - ww);   // light well
    else {
      // planted garden in the middle, low walls with a few gaps
      const g = Z.room([F.rect(ww, ww, U - ww, V - ww)], 'garden');
      const sides = [[true, ww, ww, U - ww], [true, V - ww, ww, U - ww], [false, ww, ww, V - ww], [false, U - ww, ww, V - ww]];
      const nOpen = rng.int(1, 4), first = rng.int(0, 3);
      sides.forEach((sd, k) => {
        const [alongU, c, s0, s1] = sd, open = (k - first + 4) % 4 < nOpen, m = (s0 + s1) / 2, gw = Math.min(s1 - s0 - 1, rng.range(1.6, 3));
        wallGaps(F, Z.minor, alongU, c, s0, s1, open ? [[m - gw / 2, m + gw / 2]] : []);
        if (open) Z.link(ring, g, alongU ? F.X(m, c) : F.X(c, m), alongU ? F.Y(m, c) : F.Y(c, m), gw, 'opening');
      });
      const iu = U - 2 * ww, iv = V - 2 * ww, placed = [];
      for (let k = 0, tries = 0; k < Math.max(1, Math.round(iu * iv / 50)) && tries < 30; tries++) {
        const s = rng.range(0.8, 1.6), pu = ww + 1 + rng.f() * Math.max(0, iu - 2 - s), pv = ww + 1 + rng.f() * Math.max(0, iv - 2 - s);
        const bb = [pu, pv, pu + s, pv + s];
        if (overlaps(placed, bb, 1.4)) continue;
        placed.push(bb); box(F, Z.props, bb[0], bb[1], bb[2], bb[3]); k++;
      }
    }
    if (o.landmark || rng.f() < 0.55) {
      const sp = rng.range(3, 4.2), d = Math.min(1.4, ww - 1.6);
      for (let u = ww - d; u <= U - ww + d + 1e-9; u += sp) Z.pillars.push(F.X(u, ww - d), F.Y(u, ww - d), 0, 0.7, F.X(u, V - ww + d), F.Y(u, V - ww + d), 0, 0.7);
      for (let v = ww - d + sp; v < V - ww + d - 0.5; v += sp) Z.pillars.push(F.X(ww - d, v), F.Y(ww - d, v), 0, 0.7, F.X(U - ww + d, v), F.Y(U - ww + d, v), 0, 0.7);
    }
  };

  GEN.stairs = (Z, q, rng, st, o) => {
    const F = frame(q, rng);
    Z.room([q.slice()], 'stairs');
    stairsIn(F, Z, rng, 0, 0, F.U, F.V);
  };

  /** Round room in a square block (the corners are solid). */
  GEN.round = (Z, q, rng, st, o) => {
    const w = q[2] - q[0], h = q[3] - q[1], m = Math.min(w, h);
    if (m < 8 || Math.max(w, h) / m > 1.15) return GEN.open(Z, q, rng, st, o);
    Z.room([q.slice()], o.landmark ? 'theatre' : 'round room');
    const cx = (q[0] + q[2]) / 2, cy = (q[1] + q[3]) / 2, R = m / 2;
    Z.rounds.push(cx, cy, R, q[0], q[1], q[2], q[3]);
    if (o.landmark) {
      // rows of seats facing a stage
      const sx = rng.f() < 0.5 ? 1 : -1;
      Z.props.push(cx - R * 0.45, cy - sx * R * 0.72 - 1, cx + R * 0.45, cy - sx * R * 0.72 + 1);
      for (let k = 0; k < 6; k++) {
        const y = cy + sx * (k * 1.7 - R * 0.15), half = Math.sqrt(Math.max(0, (R - 2) * (R - 2) - (y - cy) * (y - cy))) - 1.5;
        if (half < 1.5) continue;
        Z.props.push(cx - half, y - 0.35, cx - 0.9, y + 0.35, cx + 0.9, y - 0.35, cx + half, y + 0.35);
      }
    } else if (rng.f() < 0.45) Z.pillars.push(cx, cy, 0, Math.min(3, R * 0.35));
  };

  GEN.pool = (Z, q, rng, st, o) => {
    const F = frame(q, rng), U = F.U, V = F.V;
    if (V < 9 || U < 10) return GEN.open(Z, q, rng, st, o);
    Z.room([q.slice()], 'pool');
    const m = o.landmark ? rng.int(3, 5) : rng.int(2, 3);
    box(F, Z.pools, m, m, U - m, V - m);
    if (o.landmark) pillarGrid(F, Z, rng, 0, 0, U, m * 2, false, 4);
  };

  /**
   * House (Home pockets): a hallway with rooms off it - living room, kitchen,
   * bedrooms, bathroom, closets - each with a door and a little furniture.
   */
  GEN.house = (Z, q, rng, st, o) => {
    const F = frame(q, rng), U = F.U, V = F.V;
    if (V < 7 || U < 9) { Z.room([q.slice()], 'studio'); return; }
    const hw = 2;
    let hv;
    if (V >= 13) hv = Math.max(3, Math.min(V - hw - 3, Math.round(V * rng.range(0.38, 0.6)) - 1));
    else hv = rng.f() < 0.5 ? 0 : V - hw;
    const hall = Z.room([F.rect(0, hv, U, hv + hw)], 'hallway');
    const bands = [];
    if (hv >= 3) bands.push([0, hv, hv, 0]);
    if (V - hv - hw >= 3) bands.push([hv + hw, V, hv + hw, V]);
    const SIZE = { living: [5, 9], kitchen: [3.5, 5], bedroom: [3.5, 5.5], bathroom: [2.5, 3.5], closet: [1.6, 2.4], dining: [3.5, 5], study: [3, 4.5] };
    let living = false;
    // one row of rooms between v0 and v1; each opens through the wall at v = front
    // into whatever `opener(u0, u1)` returns ({ room, lo, hi } along u)
    const row = (v0, v1, front, back, opener, deep) => {
      const D = v1 - v0, made = [];
      let prev = -1, prevKind = null;
      for (let u = 0; u < U - 0.01;) {
        let kind = !living && D >= 4 ? 'living' : rng.weighted({ bedroom: 3, bathroom: 1.4, kitchen: living ? 1 : 0.3, closet: D <= 5 ? 1.2 : 0.6, dining: 0.5, study: deep ? 0.8 : 0.3 });
        if (kind === 'living') living = true;
        let w = Math.round(rng.range(SIZE[kind][0], SIZE[kind][1]) * 2) / 2;
        if (U - u - w < 2.5) w = U - u;
        const r = Z.room([F.rect(u, v0, u + w, v1)], kind);
        made.push({ r, u0: u, u1: u + w });
        const op = opener(u, u + w);
        let sideOpen = false;
        if (u > 0) {
          // living + kitchen / dining: open to each other; a back room with no
          // way to the front opens into its neighbour instead
          const open = (kind === 'kitchen' || kind === 'dining') && prevKind === 'living' && D >= 4;
          if (open || !op) {
            const g = open ? Math.min(D - 1.2, rng.range(1.8, 3)) : Math.min(1.1, D - 0.8), c = v0 + D / 2;
            wallGaps(F, Z.major, false, u, v0, v1, [[c - g / 2, c + g / 2]]);
            Z.link(prev, r, F.X(u, c), F.Y(u, c), g, open ? 'opening' : 'door');
            sideOpen = true;
          } else seg(F, Z.major, u, v0, u, v1);
        }
        if (op) {
          const dw = Math.min(1.1, op.hi - op.lo - 0.6), c = op.lo + 0.3 + dw / 2 + rng.f() * Math.max(0, op.hi - op.lo - 0.6 - dw);
          wallGaps(F, Z.major, true, front, u, u + w, [[c - dw / 2, c + dw / 2]]);
          Z.link(op.room, r, F.X(c, front), F.Y(c, front), dw, 'door');
        } else seg(F, Z.major, u, front, u + w, front);
        // furniture against the back wall
        const dir = back > front ? 1 : -1, bv = back - dir * 0.2;
        const fur = (u0, u1, depth) => { if (u1 - u0 > 0.4 && depth < D - 1) box(F, Z.props, u0, Math.min(bv, bv - dir * depth), u1, Math.max(bv, bv - dir * depth)); };
        if (kind === 'bedroom' && w >= 3) fur(u + w / 2 - 0.8, u + w / 2 + 0.8, 2);
        else if (kind === 'living' && w >= 4) { fur(u + 0.6, u + Math.min(w - 0.6, 3), 0.9); }
        else if (kind === 'kitchen') fur(u + 0.2, u + w - 0.2, 0.6);
        else if (kind === 'bathroom' && w >= 2.4) fur(u + 0.2, u + 1, 1.7);
        else if (kind === 'study' && w >= 3) fur(u + 0.4, u + 1.8, 0.8);
        prev = r; prevKind = kind;
        u += w;
      }
      return made;
    };
    const viaHall = (u0, u1) => ({ room: hall, lo: u0, hi: u1 });
    for (const [b0, b1, front, back] of bands) {
      const D = b1 - b0;
      if (D < 8.5) { row(b0, b1, front, back, viaHall, false); continue; }
      // deep band: a front row on the hallway, a back row behind it
      const df = Math.round(Math.max(3.5, Math.min(D - 4, D * rng.range(0.45, 0.6))) * 2) / 2;
      const mid = front === b0 ? b0 + df : b1 - df;
      const fr = front === b0 ? row(b0, mid, front, mid, viaHall, true) : row(mid, b1, front, mid, viaHall, true);
      const behind = (u0, u1) => {
        let best = null;
        for (const f of fr) {
          const lo = Math.max(u0, f.u0), hi = Math.min(u1, f.u1);
          if (hi - lo >= (u0 === 0 ? 1.2 : 1.6) && (!best || hi - lo > best.hi - best.lo)) best = { room: f.r, lo, hi };
        }
        return best;
      };
      if (front === b0) row(mid, b1, mid, back, behind, true); else row(b0, mid, mid, back, behind, true);
    }
  };

  /** Garden / yard: open ground with a few planters, sometimes a path. */
  GEN.yard = (Z, q, rng, st, o) => {
    const F = frame(q, rng), U = F.U, V = F.V;
    Z.room([q.slice()], 'garden');
    const placed = [], n = Math.max(1, Math.round(U * V / rng.range(40, 90)));
    for (let k = 0, tries = 0; k < n && tries < 40; tries++) {
      const s = rng.range(0.8, 1.8), pu = 1 + rng.f() * Math.max(0, U - 2 - s), pv = 1 + rng.f() * Math.max(0, V - 2 - s);
      const bb = [pu, pv, pu + s, pv + s];
      if (overlaps(placed, bb, 1.5)) continue;
      placed.push(bb); box(F, Z.props, bb[0], bb[1], bb[2], bb[3]); k++;
    }
    if (V >= 6 && rng.f() < 0.5) { const c = V * rng.range(0.35, 0.65); seg(F, Z.hatch, 0, c - 0.6, U, c - 0.6); seg(F, Z.hatch, 0, c + 0.6, U, c + 0.6); }
  };

  /**
   * Hotel guest room / suite. o.front ('x0'|'x1'|'y0'|'y1') is the corridor
   * side: an en-suite bathroom sits in one front corner with the entry beside
   * it, the bed against the back wall. No outside door may open into the
   * bathroom (Z.noDoor).
   */
  GEN.guest = (Z, q, rng, st, o) => {
    // The owning generation profile supplies room-envelope constraints. This
    // archetype is reusable in any semantic area with suitable geometry/access.
    if (o && o.space && BR.spaceTypeCompatible && !BR.spaceTypeCompatible(o.space.area, 'guest', o.space,
      Math.max(q[2]-q[0], q[3]-q[1]), Math.min(q[2]-q[0], q[3]-q[1]))) return GEN.open(Z, q, rng, st, o);
    const [x0, y0, x1, y1] = q, f = o.front || 'y0', hz = f[0] === 'y';
    const Wd = hz ? x1 - x0 : y1 - y0, D = hz ? y1 - y0 : x1 - x0, mir = rng.f() < 0.5;
    const X = (u, v) => (hz ? x0 + (mir ? Wd - u : u) : f === 'x0' ? x0 + v : x1 - v);
    const Y = (u, v) => (hz ? (f === 'y0' ? y0 + v : y1 - v) : y0 + (mir ? Wd - u : u));
    const F = { X, Y, rect: (u0, v0, u1, v1) => { const a = X(u0, v0), b = Y(u0, v0), c = X(u1, v1), d = Y(u1, v1); return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)]; } };
    const suite = Wd >= 7.5;
    if (Wd < 3.2 || D < 4.5) { Z.room([q.slice()], 'guest room'); return; }
    const bw = Math.min(Wd - 1.4, rng.range(1.8, 2.4)), bd = Math.min(D - 2.6, rng.range(2, 2.6));
    const main = Z.room([F.rect(bw, 0, Wd, bd), F.rect(0, bd, Wd, D)], suite ? 'suite' : 'guest room');
    const bath = Z.room([F.rect(0, 0, bw, bd)], 'bathroom');
    const br = F.rect(0, 0, bw, bd);
    Z.noDoor.push(br[0] - 0.05, br[1] - 0.05, br[2] + 0.05, br[3] + 0.05);
    const dw = Math.min(0.8, bw - 0.5), dc = 0.3 + dw / 2 + rng.f() * Math.max(0, bw - 0.6 - dw);
    wallGaps(F, Z.minor, true, bd, 0, bw, [[dc - dw / 2, dc + dw / 2]]);
    seg(F, Z.minor, bw, 0, bw, bd);
    Z.link(main, bath, X(dc, bd), Y(dc, bd), dw, 'door');
    // bed against the back wall, a wardrobe in the entry
    if (D >= 6) {
      const bu = suite ? Wd * 0.72 : Wd / 2 + (rng.f() - 0.5) * Math.max(0, Wd - 4);
      box(F, Z.props, bu - 0.8, D - 2.1, bu + 0.8, D - 0.15);
    }
    if (Wd - bw >= 3.4) box(F, Z.props, Wd - 0.65, 0.3, Wd - 0.1, Math.min(bd, 1.6));
    if (suite) seg(F, Z.minor, Wd * 0.48, D * rng.range(0.35, 0.5), Wd * 0.48, D);
  };

  /** Pool hall: one to four basins of different sizes, columns where they fit. */
  GEN.pools = (Z, q, rng, st, o) => {
    const F = frame(q, rng), U = F.U, V = F.V;
    if (V < 8 || U < 10) return GEN.open(Z, q, rng, st, o);
    Z.room([q.slice()], o.landmark ? 'pool hall' : 'pool room');
    const placed = [];
    const n = U * V > 900 ? rng.int(2, 4) : rng.int(1, 2);
    for (let k = 0, tries = 0; k < n && tries < 30; tries++) {
      const big = k === 0;
      const bw = Math.max(3, Math.round((big ? rng.range(0.35, 0.7) : rng.range(0.12, 0.3)) * U));
      const bh = Math.max(3, Math.round((big ? rng.range(0.3, 0.6) : rng.range(0.15, 0.35)) * V));
      if (bw > U - 5 || bh > V - 5) continue;
      const pu = 2.5 + rng.int(0, Math.floor(U - 5 - bw)), pv = 2.5 + rng.int(0, Math.floor(V - 5 - bh));
      const bb = [pu, pv, pu + bw, pv + bh];
      if (overlaps(placed, bb, 2.5)) continue;
      placed.push(bb); box(F, Z.pools, bb[0], bb[1], bb[2], bb[3]); k++;
    }
    if (U * V > 300 && rng.f() < 0.6) {
      const before = Z.pillars.length;
      pillarGrid(F, Z, rng, 0, 0, U, V, false, rng.int(5, 7));
      const P = Z.pillars, keep = P.slice(0, before);
      for (let k = before; k < P.length; k += 4) {
        let inPool = false;
        for (let m = 0; m < Z.pools.length; m += 4)
          if (P[k] > Z.pools[m] - 1.2 && P[k] < Z.pools[m + 2] + 1.2 && P[k + 1] > Z.pools[m + 1] - 1.2 && P[k + 1] < Z.pools[m + 3] + 1.2) { inPool = true; break; }
        if (!inPool) keep.push(P[k], P[k + 1], P[k + 2], P[k + 3]);
      }
      Z.pillars = keep;
    }
  };

  /** Car park: bays painted either side of driving aisles, a column grid, sometimes a ramp. */
  GEN.parking = (Z, q, rng, st, o) => {
    const F = frame(q, rng), U = F.U, V = F.V;
    const bay = 2.5, depth = 5, aisle = 6, mod = 2 * depth + aisle;
    // One complete module plus its edge margin must fit before bay/column
    // placement. Forcing a row into a 12-17 m parcel made v00 negative and
    // emitted geometry outside the buildable floor, into reserved routes.
    if (V < mod + 2 || U < 16) return GEN.open(Z, q, rng, st, o);
    Z.room([q.slice()], 'car park');
    const rows = Math.max(1, Math.floor((V - 2) / mod)), v00 = (V - rows * mod) / 2;
    const u0 = 2, u1 = U - 2;
    for (let r = 0; r < rows; r++) {
      const v0 = v00 + r * mod;
      for (let u = u0; u <= u1 + 1e-9; u += bay) {
        seg(F, Z.hatch, u, v0, u, v0 + depth);
        seg(F, Z.hatch, u, v0 + depth + aisle, u, v0 + mod);
      }
      // columns between bay rows of neighbouring modules
      if (r > 0 || v0 > 1.5) for (let u = u0 + bay * 2; u < u1; u += bay * 3) Z.pillars.push(F.X(u, v0), F.Y(u, v0), 0, 0.8);
    }
    for (let u = u0 + bay * 2; u < u1; u += bay * 3) Z.pillars.push(F.X(u, v00 + rows * mod), F.Y(u, v00 + rows * mod), 0, 0.8);
    if (rng.f() < 0.35 && U >= 24) stairsIn(F, Z, rng, 0, 0, Math.min(U, 14), V);
  };

  /** Utility rooms: small rooms full of machinery, pipes along the walls. */
  GEN.machinery = (Z, q, rng, st, o) => {
    const leaves = bsp(q, rng, rng.range(20, 50), 0.3, 2);
    const cells = leaves.map((l) => ({ room: Z.room([l.q], l.hall ? 'corridor' : 'plant room'), q: l.q }));
    connectCells(Z, cells, rng, st, { pOpen: 0.1, pLoop: 0.1, major: true });
    for (const c of cells) {
      const [x0, y0, x1, y1] = c.q, w = x1 - x0, h = y1 - y0;
      if (w < 4 || h < 4) continue;
      const F = frame(c.q, rng);
      if (rng.f() < 0.75) {
        const mw = Math.min(F.U - 3, rng.range(1.5, 3.5)), mh = Math.min(F.V - 2.5, rng.range(1.2, 2.5));
        const pu = 1.2 + rng.f() * Math.max(0, F.U - 2.4 - mw), pv = 1.2 + rng.f() * Math.max(0, F.V - 2.4 - mh);
        box(F, Z.props, pu, pv, pu + mw, pv + mh);
      }
      // two pipes along one wall
      seg(F, Z.hatch, 0.4, 0.45, F.U - 0.4, 0.45); seg(F, Z.hatch, 0.4, 0.8, F.U - 0.4, 0.8);
    }
  };

  // ------------------------------------------------------------- selection
  const FITS = {
    open: () => true,
    split: (U, V) => U >= 14 && V >= 6,
    ring: (U, V) => U >= 12 && V >= 10,
    stalls: (U, V) => U >= 9 && V >= 6,
    office: (U, V) => U >= 10 && V >= 8,
    warren: (U, V) => U * V >= 60 && V >= 6,
    store: (U, V) => U >= 9 && V >= 7,
    gallery: (U, V) => U >= 12 && U >= 1.8 * V,
    corridorRooms: (U, V) => U >= 10 && V >= 6,
    courtyard: (U, V) => V >= 14,
    stairs: (U, V) => U >= 7 && V >= 4 && U * V <= 160,
    round: (U, V) => V >= 8 && U <= 1.15 * V && V <= 30,
    pool: (U, V) => U >= 12 && V >= 9,
    house: (U, V) => U >= 6 && V >= 5,
    yard: () => true,
    guest: (U, V, meta) => meta ? BR.spaceTypeCompatible(meta.area, 'guest', meta, U, V) :
      U <= 12 && V >= 4.5 && V <= 9.5,
    pools: (U, V) => U >= 10 && V >= 8,
    parking: (U, V) => U >= 16 && V >= 12,
    machinery: (U, V) => U * V >= 30
  };
  const LANDMARK_GEN = {
    grandHall: ['open', { feature: 'pillars', cross: true, sp: 6 }],
    atrium: ['courtyard', {}],
    poolHall: ['pools', {}],
    theatre: ['round', {}],
    longGallery: ['gallery', {}]
  };

  /** Pick a zone type for block q: theme weights, size rules, contrast with neighbours. */
  function pickZoneType(rng, weights, q, avoid, depth, meta) {
    const w = q[2] - q[0], h = q[3] - q[1], U = Math.max(w, h), V = Math.min(w, h), A = U * V;
    const out = {};
    let any = false;
    for (const t in weights) {
      if (!FITS[t] || !FITS[t](U, V, meta)) continue;
      if (meta && BR.spaceTypeCompatible && !BR.spaceTypeCompatible(meta.area, t, meta, U, V)) continue;
      let k = weights[t];
      if (t === 'split') k *= depth > 0 ? (depth === 1 && A > 900 ? 0.3 : 0) : 0.35 + A / 1000;
      if (t === 'open' && A > 250) k *= 1.3;              // big blocks: favour big spaces
      if (avoid && avoid.indexOf(t) >= 0) k *= 0.22;
      if (k > 0) { out[t] = k; any = true; }
    }
    return any ? rng.weighted(out) : 'open';
  }

  function fill(Z, type, q, rng, st, o) {
    Z.sub.push(type);
    GEN[type](Z, q, rng, st, o || {});
  }

  /** Build a zone of the given type (or landmark) over block q. */
  function fillZone(type, q, rng, st, o) {
    o = o || {};
    if (o.space && BR.spaceTypeCompatible) {
      const w=q[2]-q[0],h=q[3]-q[1],U=Math.max(w,h),V=Math.min(w,h);
      if (!BR.spaceTypeCompatible(o.space.area, type, o.space, U, V)) type='open';
    }
    if (LANDMARK_GEN[type]) {
      const [g, opt] = LANDMARK_GEN[type];
      const Z = new Zone(type, q);
      fill(Z, g, q, rng, st, Object.assign({ landmark: true }, opt));
      return Z;
    }
    const Z = new Zone(type, q);
    fill(Z, type, q, rng, st, o);
    return Z;
  }
  function plainZone(q, kind) {
    const Z = new Zone('room', q);
    Z.room([q.slice()], kind);
    return Z;
  }

  Object.assign(BR, { Zone, fillZone, plainZone, pickZoneType, ZONE_FITS: FITS, ZONE_TYPES: Object.keys(FITS), LANDMARK_TYPES: Object.keys(LANDMARK_GEN) });
})(typeof window !== 'undefined' ? window : globalThis);
