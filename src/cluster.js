/*
 * cluster.js - the micro layer: rooms inside one cluster.
 *
 * A cluster is a set of PARTS. Each part has its own frame (rotation + origin
 * relative to the cluster frame) and an integer grid, so rooms are rectilinear
 * within a part. Part 0 is the main body; extra parts are "wings" that branch
 * off an outside wall at an arbitrary angle (and can branch again), which is
 * what produces the reference's rooms-at-odd-angles chains. Clusters themselves
 * also sit at arbitrary angles. Together that hides any global grid.
 *
 * Pipeline (all driven by one PRNG seeded from the site):
 *   1. style     - theme + dice pick a core motif and growth parameters
 *   2. reach     - the allowed footprint: a union of oriented boxes (a central
 *                  block plus skeleton "arms"), so blobs grow as buildings and
 *                  bands rather than tell-tale circles
 *   3. arms      - bands of rooms grown toward graph neighbours, up to the
 *                  territory edge, so neighbouring clusters reach for each other
 *   4. core      - block | bsp | hall | comb | maze  (seed geometry)
 *   5. accrete   - repeatedly attach blocks / rooms / halls / alcoves to free
 *                  faces, scoring candidates by contact (compactness) and
 *                  snapping to existing wall lines (architectural alignment)
 *   6. subdivide - blocks become BSP room layouts (interior walls)
 *   7. finalize  - shared-wall adjacency, keep the connected piece, merge some
 *                  rects into irregular rooms, spanning-tree doors + loops,
 *                  walls with door gaps, partial wall stubs, pillars
 *   8. wings     - rotated sub-parts grown off outside walls (diagonal arms
 *                  become wings too), each finalized on its own grid
 *   9. ports     - for every corridor edge, an exterior door + stub facing the
 *                  neighbour, chosen deterministically in neighbour order
 *
 * Constraints during placement: territory half-planes (never overlap another
 * cluster), the reach boxes, other parts (SAT), and "lanes" (straight corridor
 * lines between other sites) so nothing is built over someone else's corridor.
 */
(function (root) {
  'use strict';
  const BR = root.BR;
  const { Rng, hash4, segHitsRect, ROTS } = BR;

  const ROOM = 0, HALL = 1, BIG = 2, ALCOVE = 3, BLOCK = 4;
  const LANE_BUF = 2.4;
  const EPS = 1e-7;

  // ----------------------------------------------------------- SAT helpers
  /** corners (cluster frame) of a part-local rect, as [x0,y0,x1,y1,x2,y2,x3,y3] */
  function quad(P, x0, y0, x1, y1) {
    const c = P.c, s = P.s, ox = P.ox, oy = P.oy;
    return [
      ox + c * x0 - s * y0, oy + s * x0 + c * y0,
      ox + c * x1 - s * y0, oy + s * x1 + c * y0,
      ox + c * x1 - s * y1, oy + s * x1 + c * y1,
      ox + c * x0 - s * y1, oy + s * x0 + c * y1
    ];
  }
  function sepAxis(a, b, ax, ay) {
    let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
    for (let k = 0; k < 8; k += 2) {
      const pa = a[k] * ax + a[k + 1] * ay, pb = b[k] * ax + b[k + 1] * ay;
      if (pa < amin) amin = pa; if (pa > amax) amax = pa;
      if (pb < bmin) bmin = pb; if (pb > bmax) bmax = pb;
    }
    return amax <= bmin + EPS || bmax <= amin + EPS;
  }
  /** strict interior overlap of two convex quads (touching is allowed) */
  function quadsOverlap(a, b) {
    for (const q of [a, b]) for (let k = 0; k < 4; k += 2) {
      const ex = q[k + 2] - q[k], ey = q[k + 3] - q[k + 1];
      if (sepAxis(a, b, -ey, ex)) return false;
    }
    return true;
  }
  function quadCircle(q) {
    const cx = (q[0] + q[4]) / 2, cy = (q[1] + q[5]) / 2;
    const dx = q[0] - cx, dy = q[1] - cy;
    return [cx, cy, Math.sqrt(dx * dx + dy * dy)];
  }

  /**
   * Squared normalised distance to the reach shape (<= 1 means inside).
   * The reach is a union of oriented boxes: a central block plus "arms" along
   * a random skeleton. Boxes (not circles/ellipses) keep the grown outline
   * architectural - no tell-tale round blobs.
   */
  function lobeDist(E, X, Y) {
    let best = Infinity;
    for (const L of E.lobes) {
      const dx = X - L.cx, dy = Y - L.cy;
      const a = (dx * L.ux + dy * L.uy) / L.hl, b = (dy * L.ux - dx * L.uy) / L.hw;
      const d = Math.max(a * a, b * b);
      if (d < best) best = d;
    }
    return best;
  }

  // ------------------------------------------------------------------- part
  class Part {
    /**
     * env: shared cluster context { R, ia2, ib2, planes, lanes, parts } (cluster frame)
     * (c,s,ox,oy): this part's frame inside the cluster frame.
     * joint: {part, rect} that this part's first rect may overlap (wing attachment).
     */
    constructor(env, c, s, ox, oy, joint) {
      this.env = env; this.c = c; this.s = s; this.ox = ox; this.oy = oy;
      this.ident = c === 1 && s === 0 && ox === 0 && oy === 0;
      this.chain = false;   // chain parts skip the reach lobes
      this.joint = joint || null;
      this.R = env.R;
      this.planes = env.planes.map((p) => ({ ux: c * p.ux + s * p.uy, uy: -s * p.ux + c * p.uy, t: p.t - (p.ux * ox + p.uy * oy) }));
      this.lanes = env.lanes.map((l) => {
        const a = this.toLocal(l.x0, l.y0), b = this.toLocal(l.x1, l.y1);
        return { x0: a[0], y0: a[1], x1: b[0], y1: b[1] };
      });
      this.rects = []; this.area = 0;
      this.xs = new Set(); this.ys = new Set();      // wall lines in use (for snapping)
      this.walls = []; this.pillars = []; this.rooms = []; this.doorCount = 0;
    }
    toCluster(x, y) { return [this.ox + this.c * x - this.s * y, this.oy + this.s * x + this.c * y]; }
    toLocal(x, y) { const dx = x - this.ox, dy = y - this.oy; return [this.c * dx + this.s * dy, -this.s * dx + this.c * dy]; }
    rectQuad(r) {
      if (!r.q) { r.q = quad(this, r.x0, r.y0, r.x1, r.y1); r.bc = quadCircle(r.q); }
      return r.q;
    }

    fits(x0, y0, x1, y1) {
      const E = this.env;
      // every corner must lie inside some lobe of the reach (free parts - room
      // chains - only have to stay within maxReach; the territory shapes them)
      const q = this.ident ? [x0, y0, x1, y0, x1, y1, x0, y1] : quad(this, x0, y0, x1, y1);
      // hard limit for everyone: maxReach (this is what makes the fixed
      // neighbour windows in sites.js sufficient for non-overlap)
      const M = BR.CFG.maxReach - 0.5;
      for (let k = 0; k < 8; k += 2) if (q[k] * q[k] + q[k + 1] * q[k + 1] > M * M) return false;
      if (!this.chain) for (let k = 0; k < 8; k += 2) if (lobeDist(E, q[k], q[k + 1]) > 1) return false;
      const P = this.planes;
      for (let k = 0; k < P.length; k++) {
        const p = P[k];
        const v = (p.ux > 0 ? p.ux * x1 : p.ux * x0) + (p.uy > 0 ? p.uy * y1 : p.uy * y0);
        if (v > p.t) return false;
      }
      const L = this.lanes, b = LANE_BUF;
      for (let k = 0; k < L.length; k++) {
        const l = L[k];
        if (segHitsRect(l.x0, l.y0, l.x1, l.y1, x0 - b, y0 - b, x1 + b, y1 + b)) return false;
      }
      return E.parts.length < 2 || this.crossFree(x0, y0, x1, y1);
    }
    /** no overlap with rects of the other parts */
    crossFree(x0, y0, x1, y1) {
      const q = quad(this, x0, y0, x1, y1), bc = quadCircle(q);
      const isRoot = this.rects.length === 0;
      for (const P of this.env.parts) {
        if (P === this) continue;
        for (let i = 0; i < P.rects.length; i++) {
          if (isRoot && this.joint && this.joint.part === P && this.joint.rect === i) continue;
          const r = P.rects[i], rq = P.rectQuad(r);
          const dx = r.bc[0] - bc[0], dy = r.bc[1] - bc[1], rr = r.bc[2] + bc[2];
          if (dx * dx + dy * dy >= rr * rr) continue;
          if (quadsOverlap(q, rq)) return false;
        }
      }
      return true;
    }
    free(x0, y0, x1, y1) {
      const R = this.rects;
      for (let k = 0; k < R.length; k++) {
        const r = R[k];
        if (x0 < r.x1 && r.x0 < x1 && y0 < r.y1 && r.y0 < y1) return false;
      }
      return true;
    }
    ok(x0, y0, x1, y1) { return x1 > x0 && y1 > y0 && this.free(x0, y0, x1, y1) && this.fits(x0, y0, x1, y1); }
    add(x0, y0, x1, y1, k, parent) {
      this.rects.push({ x0, y0, x1, y1, k, parent: parent === undefined ? -1 : parent });
      this.area += (x1 - x0) * (y1 - y0);
      this.xs.add(x0); this.xs.add(x1); this.ys.add(y0); this.ys.add(y1);
      return this.rects.length - 1;
    }
    attach(pi, dir, l0, l1, depth, minDepth, k, align) {
      const r = this.probe(pi, dir, l0, l1, depth, minDepth, align);
      return r ? this.add(r[0], r[1], r[2], r[3], k, pi) : -1;
    }
    /**
     * Rect against face `dir` of rect pi (0:+x 1:+y 2:-x 3:-y), lateral span
     * [l0,l1], outward `depth` - shrunk to fit whatever is already there and the
     * territory. Returns [x0,y0,x1,y1] or null.
     */
    probe(pi, dir, l0, l1, depth, minDepth, align) {
      const P = this.rects[pi], R = this.rects;
      const face = dir === 0 ? P.x1 : dir === 1 ? P.y1 : dir === 2 ? P.x0 : P.y0;
      let avail = depth;
      for (let n = 0; n < R.length; n++) {
        const r = R[n];
        let gap;
        if (dir === 0) { if (!(r.y0 < l1 && r.y1 > l0) || r.x1 <= face) continue; gap = r.x0 - face; }
        else if (dir === 2) { if (!(r.y0 < l1 && r.y1 > l0) || r.x0 >= face) continue; gap = face - r.x1; }
        else if (dir === 1) { if (!(r.x0 < l1 && r.x1 > l0) || r.y1 <= face) continue; gap = r.y0 - face; }
        else { if (!(r.x0 < l1 && r.x1 > l0) || r.y0 >= face) continue; gap = face - r.y1; }
        if (gap < avail) { avail = gap; if (avail < minDepth) return null; }
      }
      const at = (d) => {
        if (dir === 0) return [face, l0, face + d, l1];
        if (dir === 2) return [face - d, l0, face, l1];
        if (dir === 1) return [l0, face, l1, face + d];
        return [l0, face - d, l1, face];
      };
      if (align) {
        // prefer a depth whose far edge lands on a wall line already in use
        const lines = dir % 2 === 0 ? this.xs : this.ys;
        for (let d = avail; d >= minDepth; d--) {
          if (!lines.has(dir < 2 ? face + d : face - d)) continue;
          const r = at(d);
          if (this.fits(r[0], r[1], r[2], r[3])) return r;
        }
      }
      for (let d = avail; d >= minDepth; d--) {
        const r = at(d);
        if (this.fits(r[0], r[1], r[2], r[3])) return r;
      }
      return null;
    }
    /** boundary length a candidate would share with existing rects */
    contact(x0, y0, x1, y1) {
      let c = 0;
      for (const r of this.rects) {
        if (r.x1 === x0 || r.x0 === x1) c += Math.max(0, Math.min(y1, r.y1) - Math.max(y0, r.y0));
        if (r.y1 === y0 || r.y0 === y1) c += Math.max(0, Math.min(x1, r.x1) - Math.max(x0, r.x0));
      }
      return c;
    }
    /** elliptical distance of a local point from the cluster centre (1 = edge of reach) */
    reachDist(x, y) {
      const [X, Y] = this.ident ? [x, y] : this.toCluster(x, y);
      return Math.sqrt(lobeDist(this.env, X, Y));
    }
    placeNear(cx, cy, w, h, k) {
      for (let t = 0; t < 8; t++) {
        const x0 = Math.round(cx - w / 2), y0 = Math.round(cy - h / 2);
        if (this.ok(x0, y0, x0 + w, y0 + h)) return this.add(x0, y0, x0 + w, y0 + h, k);
        w = Math.max(2, Math.round(w * 0.8)); h = Math.max(2, Math.round(h * 0.8));
      }
      return -1;
    }
  }

  // ------------------------------------------------------------------ style
  function makeStyle(site, rng) {
    const th = BR.THEMES[site.theme] || BR.THEMES.base;
    const rs = th.roomScale || [0.95, 1.5];
    const st = {
      core: rng.weighted(th.cores),
      zones: th.zones || BR.THEMES.base.zones,
      firstZone: null,
      roomScale: rng.range(rs[0], rs[1]),
      pHall: th.pHall ? rng.range(th.pHall[0], th.pHall[1]) : rng.range(0.04, 0.22),
      hallW: th.hallW || (rng.f() < 0.75 ? 2 : 3),
      pChain: rng.f() < 0.3 ? rng.range(0.55, 0.9) : rng.range(0.03, 0.3),
      pOut: rng.range(0, 0.3),
      snap: rng.range(0.8, 1),
      pOpen: rng.range(0.1, 0.35),
      pLoop: rng.range(0.08, 0.4),
      doorW: rng.range(1.2, 1.8),
      pWide: rng.range(0.05, 0.3),
      pAlcove: rng.f() < 0.75 ? 0 : rng.range(0.01, 0.03),
      pBig: rng.range(0, 0.05),
      fill: rng.range(0.45, 0.85),
      pillars: th.pillars !== undefined ? th.pillars : 0.45,
      pBspCorr: rng.range(0.05, 0.4),
      pRemove: rng.range(0.04, 0.28),
      pStub: rng.range(0.15, 0.6),
      tries: rng.f() < 0.3 ? 1 : rng.int(2, 5),     // 1 = sprawling, high = compact
      mode: rng.f() < 0.88 ? 'blocks' : 'rooms',    // grow whole buildings (zones), or room by room
      blockScale: Math.min(2.1, Math.max(0.85, site.r / 30)),
      wings: 0,
      roomArea: 0
    };
    const ra = rng.f();
    st.roomArea = (55 + 220 * ra * ra) * st.roomScale * st.roomScale;
    const wu = rng.f();
    st.wings = wu < 0.42 ? 0 : wu < 0.7 ? 1 : wu < 0.88 ? 2 : rng.int(3, 5);
    if (site.r < 15 && st.core !== 'maze') st.core = 'none';
    if (site.cx) {                    // complex member: fill the territory, fewer bolt-on wings
      st.fill = rng.range(0.42, 0.68) + 0.22 * site.solid;
      st.wings = Math.min(st.wings, rng.int(0, 2));
      if (rng.f() < 0.45 + 0.4 * site.solid) st.mode = 'blocks';
      if (site.solid < 0.4) { st.tries = 1; st.pChain = rng.range(0.35, 0.8); }   // webby: sprawl
    }
    if (site.r > 40) {                // big complexes: buildings, sprawling, few bolt-ons
      if (rng.f() < 0.8) st.mode = 'blocks';
      st.tries = Math.min(st.tries, rng.int(1, 2));
      st.pAlcove *= 0.3;
    }
    st.firstZone = { none: null, hall: 'open', bsp: 'split', comb: 'corridorRooms', maze: 'warren' }[st.core] || null;
    if (site.landmark) st.mode = 'blocks';
    if (st.firstZone) st.mode = 'blocks';
    return st;
  }

  function roomSize(rng, st) {
    const u1 = rng.f(), u2 = rng.f();
    let w = 5 + 14 * u1 * u1, h = 5 + 14 * u2 * u2;
    if (rng.f() < 0.22) { if (rng.f() < 0.5) w *= 1.5 + rng.f(); else h *= 1.5 + rng.f(); }
    return [Math.max(3, Math.round(w * st.roomScale)), Math.max(3, Math.round(h * st.roomScale))];
  }
  function blockSize(rng, st) {
    const u1 = rng.f(), u2 = rng.f();
    let w = 9 + 28 * u1 * u1, h = 7 + 22 * u2 * u2;
    if (rng.f() < 0.3) { if (rng.f() < 0.5) w *= 1.4 + 0.8 * rng.f(); else h *= 1.4 + 0.8 * rng.f(); }
    const k = st.roomScale * st.blockScale;     // big complexes are built from bigger buildings
    return [Math.max(4, Math.round(w * k)), Math.max(4, Math.round(h * k))];
  }

  // ------------------------------------------------------------ core motifs
  function coreNone(B, rng, st) {
    if (st.mode === 'blocks') {
      const [w, h] = blockSize(rng, st);
      if (B.placeNear(0, 0, w, h, BLOCK) >= 0) return;
    }
    const [w, h] = roomSize(rng, st);
    B.placeNear(0, 0, Math.max(w, 4), Math.max(h, 4), ROOM);
  }

  /** Landmark footprints (w, h) before shrinking to fit. */
  const LANDMARK_SIZE = {
    grandHall: (rng) => [rng.int(34, 50), rng.int(22, 32)],
    atrium: (rng) => [rng.int(28, 40), rng.int(24, 32)],
    poolHall: (rng) => [rng.int(24, 34), rng.int(16, 24)],
    theatre: (rng) => { const a = rng.int(18, 26); return [a, a]; },
    longGallery: (rng) => [rng.int(46, 64), rng.int(7, 10)]
  };

  /**
   * First block of a cluster. Its zone type comes from the theme's core motif
   * (hall -> open hall, bsp -> split, comb -> hotel corridor, maze -> warren)
   * or from the site's landmark.
   */
  function coreBlock(B, rng, st, site) {
    let w, h;
    if (site.landmark) [w, h] = LANDMARK_SIZE[site.landmark](rng);
    else {
      [w, h] = blockSize(rng, st);
      if (st.firstZone) { w = Math.round(w * 1.25); h = Math.round(h * 1.2); }
    }
    if (rng.f() < 0.5) { const t = w; w = h; h = t; }
    let i = -1;
    if (site.landmark) {
      // landmarks try harder to fit: both orientations, nudged off-centre, shrinking slowly
      for (let k = 0; k < 7 && i < 0; k++) {
        const f = 1 - 0.08 * k, lw = Math.round(w * f), lh = Math.round(h * f);
        for (const [a, b] of [[lw, lh], [lh, lw]]) for (const [ox, oy] of [[0, 0], [6, 0], [-6, 0], [0, 6], [0, -6], [10, 10], [-10, -10], [10, -10], [-10, 10]]) {
          if (i >= 0) break;
          const x0 = Math.round(ox - a / 2), y0 = Math.round(oy - b / 2);
          if (B.ok(x0, y0, x0 + a, y0 + b)) i = B.add(x0, y0, x0 + a, y0 + b, BLOCK);
        }
      }
    }
    if (i < 0) i = B.placeNear(0, 0, w, h, BLOCK);
    if (i < 0) return coreNone(B, rng, st);
    const r = B.rects[i];
    if (site.landmark) {
      const ww = r.x1 - r.x0, hh = r.y1 - r.y0;
      // a landmark that had to shrink a lot is just a big room
      if (ww * hh >= 0.45 * w * h) { r.zt = site.landmark; r.lm = true; }
    } else if (st.firstZone) r.zt = st.firstZone;
  }

  // -------------------------------------------------------------- accretion
  /** Nearest value in `set` within +-tol of v (ties -> smaller), else v. Order independent. */
  function snapTo(set, v, tol) {
    if (Number.isInteger(v) && tol <= 3) {       // fast path: grid coords are integers
      if (set.has(v)) return v;
      for (let d = 1; d <= tol; d++) {
        if (set.has(v - d)) return v - d;
        if (set.has(v + d)) return v + d;
      }
      return v;
    }
    let best = v, bd = tol + 1;
    for (const x of set) {
      const d = Math.abs(x - v);
      if (d < bd || (d === bd && x < best)) { bd = d; best = x; }
    }
    return best;
  }

  /** Roll one candidate piece: parent, face, lateral span, size, kind. */
  function rollPiece(B, rng, st, phase) {
    const n = B.rects.length;
    const pi = rng.f() < st.pChain ? n - 1 - Math.floor(rng.f() * Math.min(n, 3)) : Math.floor(rng.f() * n);
    const P = B.rects[pi];
    if (P.k === ALCOVE) return null;
    let dir = rng.int(0, 3);
    if (rng.f() < st.pOut) {           // bias growth away from the centre
      const cx = (P.x0 + P.x1) / 2, cy = (P.y0 + P.y1) / 2;
      dir = Math.abs(cx) > Math.abs(cy) ? (cx > 0 ? 0 : 2) : (cy > 0 ? 1 : 3);
    }
    let lat, depth, kind, minD, minShared = 2;
    const t = rng.f();
    if (t < st.pAlcove) {
      kind = ALCOVE; lat = rng.int(2, 4); depth = rng.int(1, 3); minD = 1; minShared = lat;
    } else if (t < st.pAlcove + st.pHall) {
      kind = HALL;
      if (rng.f() < 0.8) { lat = st.hallW; depth = rng.int(4, 16); minD = 3; }
      else { lat = rng.int(6, 18); depth = st.hallW; minD = st.hallW; }
    } else if (t < st.pAlcove + st.pHall + st.pBig) {
      kind = BIG; lat = Math.round(rng.range(12, 26) * st.roomScale); depth = Math.round(rng.range(10, 22) * st.roomScale); minD = 8;
    } else if (phase === 'block') {
      kind = BLOCK; [lat, depth] = blockSize(rng, st); minD = Math.max(4, Math.round(depth * 0.6));
    } else {
      kind = ROOM; [lat, depth] = roomSize(rng, st); minD = Math.max(3, Math.round(depth * 0.55));
    }
    const span0 = dir % 2 === 0 ? P.y0 : P.x0, span1 = dir % 2 === 0 ? P.y1 : P.x1;
    const plen = span1 - span0;
    minShared = Math.min(minShared, plen, lat);
    if (kind === ALCOVE && plen < lat + 2) return null;
    let l0;
    const a = rng.f();
    if (kind === ALCOVE) l0 = rng.int(span0 + 1, span1 - lat - 1);
    else if (a < 0.35) l0 = span0;
    else if (a < 0.7) l0 = span1 - lat;
    else l0 = rng.int(span0 - lat + minShared, span1 - minShared);
    let l1 = l0 + lat;
    if (kind !== ALCOVE && rng.f() < st.snap) {
      // Snap to wall lines already in use nearby so edges line up architecturally.
      const lines = dir % 2 === 0 ? B.ys : B.xs;
      const s0 = snapTo(lines, l0, 3), s1 = snapTo(lines, l1, 3);
      if (s1 - s0 >= Math.max(2, minShared) && Math.min(s1, span1) - Math.max(s0, span0) >= minShared) { l0 = s0; l1 = s1; }
      const face = dir === 0 ? P.x1 : dir === 1 ? P.y1 : dir === 2 ? P.x0 : P.y0;
      const far = snapTo(dir % 2 === 0 ? B.xs : B.ys, face + (dir < 2 ? depth : -depth), 3);
      const nd = Math.abs(far - face);
      if (nd >= minD) depth = nd;
    }
    const r = B.probe(pi, dir, l0, l1, depth, minD, rng.f() < st.snap);
    return r ? { pi, dir, kind, lat: l1 - l0, r } : null;
  }

  /**
   * Grow a part. Each step rolls `tries` candidates and keeps the best by
   * contact with existing rooms (compact masses, filled concavities) minus
   * distance from the centre, plus noise. tries = 1 gives sprawling dendrites.
   */
  function accrete(B, rng, st, targetArea, phase) {
    const maxAttempts = 100 + Math.round(targetArea / 3);
    let fails = 0, streak = 0;
    for (let att = 0; att < maxAttempts && B.area < targetArea; att++) {
      if (!B.rects.length) return;
      if (fails >= 10) {                 // stuck: try smaller buildings
        fails = 0;
        if (phase === 'block') st.blockScale = Math.max(0.6, st.blockScale * 0.85);
      }
      if (streak >= 80) return;          // nothing fits any more: the footprint is full
      let best = null, bestS = -Infinity;
      for (let k = 0; k < st.tries; k++) {
        const c = rollPiece(B, rng, st, phase);
        if (!c) continue;
        const [x0, y0, x1, y1] = c.r;
        const per = 2 * (x1 - x0 + y1 - y0);
        const score = 1.6 * B.contact(x0, y0, x1, y1) / per - 0.15 * B.reachDist((x0 + x1) / 2, (y0 + y1) / 2) + rng.f() * 0.22;
        if (score > bestS) { bestS = score; best = c; }
      }
      if (!best) { fails++; streak++; continue; }
      fails = 0; streak = 0;
      const [x0, y0, x1, y1] = best.r;
      const ni = B.add(x0, y0, x1, y1, best.kind, best.pi);
      if (best.kind === HALL && best.lat === st.hallW) {
        // a hall has to lead somewhere: put a room at its far end, or undo it
        const [w2, h2] = phase === 'block' ? blockSize(rng, st) : roomSize(rng, st);
        const H = B.rects[ni], dir = best.dir;
        const s0 = dir % 2 === 0 ? H.y0 : H.x0;
        const off = rng.int(-(w2 - best.lat), 0);
        const ri = B.attach(ni, dir, s0 + off, s0 + off + w2, h2, Math.max(3, Math.round(h2 * 0.55)), phase === 'block' ? BLOCK : ROOM);
        if (ri < 0) { B.rects.pop(); B.area -= (H.x1 - H.x0) * (H.y1 - H.y0); }
      }
    }
  }

  /**
   * Grow outward faces all the way to the territory edge (complex members), so
   * neighbouring buildings meet along the seam instead of leaving a moat.
   */
  function infill(B, rng, st, frac, kind) {
    const n = B.rects.length;
    for (let i = 0; i < n; i++) {
      const R0 = B.rects[i];
      if (R0.k === ALCOVE) continue;
      for (let dir = 0; dir < 4; dir++) {
        if (rng.f() > frac) continue;
        const lo = dir % 2 === 0 ? R0.y0 : R0.x0, hi = dir % 2 === 0 ? R0.y1 : R0.x1;
        if (hi - lo < 3) continue;
        let l0 = lo, l1 = hi;
        if (hi - lo > 10 && rng.f() < 0.5) {         // sometimes only part of the face
          const w = rng.int(5, hi - lo - 2); l0 = rng.int(lo, hi - w); l1 = l0 + w;
        }
        const r = B.probe(i, dir, l0, l1, 40, 2);
        if (!r) continue;
        const A = (r[2] - r[0]) * (r[3] - r[1]);
        B.add(r[0], r[1], r[2], r[3], kind === BLOCK && A > st.roomArea * 1.25 ? BLOCK : ROOM, i);
      }
    }
  }

  // --------------------------------------------------------------- finalize
  function sharedSeg(a, b) {
    if (a.x1 === b.x0 || b.x1 === a.x0) {
      const s0 = Math.max(a.y0, b.y0), s1 = Math.min(a.y1, b.y1);
      if (s1 > s0) return { v: true, c: a.x1 === b.x0 ? a.x1 : a.x0, s0, s1, len: s1 - s0 };
    }
    if (a.y1 === b.y0 || b.y1 === a.y0) {
      const s0 = Math.max(a.x0, b.x0), s1 = Math.min(a.x1, b.x1);
      if (s1 > s0) return { v: false, c: a.y1 === b.y0 ? a.y1 : a.y0, s0, s1, len: s1 - s0 };
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

  function pushSeg(out, e, s0, s1) {
    if (s1 - s0 < 0.05) return;
    if (e.v) out.push(e.c, s0, e.c, s1); else out.push(s0, e.c, s1, e.c);
  }

  /**
   * Outline cleanup before zoning: close slits of 1-2 m between rects that face
   * each other (extend one of them across), and drop tiny bumps that only make
   * jagged outlines.
   */
  function cleanupOutline(B) {
    const R = B.rects;
    const tryExtend = (i, side, to) => {
      const r = R[i];
      const q = side === 'y1' ? [r.x0, r.y1, r.x1, to] : side === 'y0' ? [r.x0, to, r.x1, r.y0]
        : side === 'x1' ? [r.x1, r.y0, to, r.y1] : [to, r.y0, r.x0, r.y1];
      if (!(q[2] > q[0] && q[3] > q[1]) || !B.free(q[0], q[1], q[2], q[3]) || !B.fits(q[0], q[1], q[2], q[3])) return false;
      B.area += (q[2] - q[0]) * (q[3] - q[1]);
      r[side] = to; r.q = null;
      B.xs.add(r.x0); B.xs.add(r.x1); B.ys.add(r.y0); B.ys.add(r.y1);
      return true;
    };
    for (let i = 0; i < R.length; i++) for (let j = 0; j < R.length; j++) {
      if (i === j) continue;
      const a = R[i], b = R[j];
      const gy = b.y0 - a.y1, ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
      if (gy > 0 && gy <= 2 && ox >= 2) { if (!tryExtend(i, 'y1', b.y0)) tryExtend(j, 'y0', a.y1); }
      const gx = b.x0 - a.x1, oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
      if (gx > 0 && gx <= 2 && oy >= 2) { if (!tryExtend(i, 'x1', b.x0)) tryExtend(j, 'x0', a.x1); }
    }
    if (R.length > 1) for (const r of R) {
      const w = r.x1 - r.x0, h = r.y1 - r.y0;
      if (r.k === HALL || r.k === BLOCK || Math.min(w, h) > 2 || w * h > 8) continue;
      let contacts = 0;
      for (const o of R) if (o !== r && sharedSeg(r, o)) contacts++;
      if (contacts <= 1) r.dead = true;
    }
  }

  /**
   * Keep one connected (door-capable) piece of a part. keep = index of a rect
   * whose piece must survive (wings keep their root), or -1 for "largest".
   */
  function prune(B, keep) {
    const R = B.rects;
    const uf = makeUF(R.length);
    for (let i = 0; i < R.length; i++) for (let j = i + 1; j < R.length; j++) {
      if (R[i].dead || R[j].dead) continue;
      const e = sharedSeg(R[i], R[j]);
      if (e && e.len >= 1) uf.union(i, j);
    }
    let best = keep >= 0 && keep < R.length && !R[keep].dead ? uf.find(keep) : -1;
    if (best < 0) {
      const area = new Map();
      for (let i = 0; i < R.length; i++) {
        if (R[i].dead) continue;
        const r = uf.find(i), A = (R[i].x1 - R[i].x0) * (R[i].y1 - R[i].y0);
        area.set(r, (area.get(r) || 0) + A);
      }
      let bestA = -1;
      for (const [k, v] of area) if (v > bestA) { bestA = v; best = k; }
    }
    const remap = new Int32Array(R.length).fill(-1), kept = [];
    for (let i = 0; i < R.length; i++) if (!R[i].dead && uf.find(i) === best) { remap[i] = kept.length; kept.push(R[i]); }
    for (const r of kept) r.parent = r.parent >= 0 ? remap[r.parent] : -1;
    B.rects = kept;
    B.area = 0;
    for (const r of kept) B.area += (r.x1 - r.x0) * (r.y1 - r.y0);
  }

  // ---------------------------------------------------------------- zones
  /**
   * Give every rect of the main part a zone. Blocks (and big rooms) get a type
   * from the theme's catalogue, avoiding the types of blocks they touch; other
   * rects are plain single rooms.
   */
  function assignZones(B, rng, st) {
    const R = B.rects, n = R.length;
    B.zones = [];
    const nb = R.map(() => []);
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (sharedSeg(R[i], R[j])) { nb[i].push(j); nb[j].push(i); }
    for (let i = 0; i < n; i++) {
      const r = R[i], q = [r.x0, r.y0, r.x1, r.y1], A = (r.x1 - r.x0) * (r.y1 - r.y0);
      let Z;
      if ((r.k === BLOCK || r.k === BIG) && A >= 45) {
        let type = r.zt;
        if (!type) {
          const avoid = [];
          for (const j of nb[i]) if (R[j].z !== undefined) avoid.push(B.zones[R[j].z].type);
          type = BR.pickZoneType(rng, st.zones, q, avoid, 0);
        }
        Z = BR.fillZone(type, q, rng, st, {});
      } else Z = BR.plainZone(q, r.k === HALL ? 'corridor' : 'room');
      r.z = B.zones.length;
      B.zones.push(Z);
    }
  }
  function plainZones(P) {
    P.zones = [];
    for (const r of P.rects) { r.z = P.zones.length; P.zones.push(BR.plainZone([r.x0, r.y0, r.x1, r.y1], r.k === HALL ? 'corridor' : 'room')); }
  }

  /** Part-level room at (x,y) inside rect ri (part coords), or -1 if blocked / outside. */
  function roomAt(P, ri, x, y) {
    const r = P.rects[ri];
    if (!r || r.z === undefined) return -1;
    const Z = P.zones[r.z], k = Z.roomAt(x, y);
    return k < 0 ? -1 : Z.base + k;
  }

  /**
   * Connections between the rects (zones) of a part: some shared walls open up
   * completely (plain rooms, or two open halls), then a random spanning tree
   * plus loops of doors. Doors are only placed where both sides are walkable
   * (not inside a solid, a shelf or a round room's corner). Every opening is
   * recorded as a link between two rooms: that's the room graph.
   */
  function connect(B, rng, st) {
    const R = B.rects, n = R.length, Zs = B.zones;
    let base = 0;
    for (const Z of Zs) { Z.base = base; base += Z.rooms.length; }
    const links = [], walls = [];
    for (const Z of Zs) for (const L of Z.links) links.push({ a: Z.base + L.a, b: Z.base + L.b, x: L.x, y: L.y, w: L.w, kind: L.kind });
    const adj = [];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const e = sharedSeg(R[i], R[j]);
      if (e) { e.a = i; e.b = j; adj.push(e); }
    }
    const type = (i) => Zs[R[i].z].type;
    const plain = (i) => type(i) === 'room';
    const rooms = (e, s) => {
      const a = R[e.a];
      let pa, pb;
      if (e.v) { const L = a.x1 === e.c ? -0.6 : 0.6; pa = [e.c + L, s]; pb = [e.c - L, s]; }
      else { const L = a.y1 === e.c ? -0.6 : 0.6; pa = [s, e.c + L]; pb = [s, e.c - L]; }
      const ra = roomAt(B, e.a, pa[0], pa[1]), rb = roomAt(B, e.b, pb[0], pb[1]);
      return ra >= 0 && rb >= 0 ? [ra, rb] : null;
    };
    const spots = (e, lo, hi) => {
      const out = [];
      if (hi < lo) { const s = (e.s0 + e.s1) / 2, r = rooms(e, s); if (r) out.push([s, r]); return out; }
      for (let s = lo; s <= hi + 1e-9; s += 0.5) { const r = rooms(e, s); if (r) out.push([s, r]); }
      return out;
    };
    const P = (e, s) => (e.v ? [e.c, s] : [s, e.c]);
    // 1. walls that open up entirely (or into a wide opening)
    const uf = makeUF(n);
    for (const e of adj) {
      if (e.len < 2) continue;
      const a = R[e.a], b = R[e.b];
      let p = 0;
      if (a.k === ALCOVE || b.k === ALCOVE) p = a.parent === e.b || b.parent === e.a ? 1 : 0;
      else if (plain(e.a) && plain(e.b)) p = a.k === HALL && b.k === HALL ? 0.85 : (a.k === HALL || b.k === HALL) ? st.pOpen * 0.4 : st.pOpen;
      else if (type(e.a) === 'open' && type(e.b) === 'open') p = 0.5;
      if (p <= 0 || rng.f() >= p) continue;
      const cand = spots(e, e.s0 + 0.6, e.s1 - 0.6);
      if (!cand.length) continue;
      const [s, rr] = cand[Math.floor(cand.length / 2)];
      uf.union(e.a, e.b);
      if (!(plain(e.a) && plain(e.b)) && e.len > 6 && rng.f() < 0.6) {
        const ow = e.len * rng.range(0.5, 0.85), c = Math.max(e.s0 + ow / 2, Math.min(e.s1 - ow / 2, s));
        e.door = [c - ow / 2, c + ow / 2]; e.wide = true;
        const pc = P(e, c);
        links.push({ a: rr[0], b: rr[1], x: pc[0], y: pc[1], w: ow, kind: 'opening' });
      } else {
        e.open = true;
        const pc = P(e, s);
        links.push({ a: rr[0], b: rr[1], x: pc[0], y: pc[1], w: e.len, kind: 'opening' });
      }
    }
    // 2. doors: random spanning tree over the rects + loops
    const groups = new Map();
    for (const e of adj) {
      if (e.open || e.wide) continue;
      const ra = uf.find(e.a), rb = uf.find(e.b);
      if (ra === rb) continue;
      const key = ra < rb ? ra * n + rb : rb * n + ra;
      let g = groups.get(key);
      if (!g) { g = { ra: Math.min(ra, rb), rb: Math.max(ra, rb), segs: [], w: rng.f() }; groups.set(key, g); }
      g.segs.push(e);
    }
    const order = [...groups.values()].sort((x, y) => x.w - y.w);
    const tree = makeUF(n);
    for (let i = 0; i < n; i++) tree.union(i, uf.find(i));
    let doors = 0;
    for (const g of order) {
      const joined = tree.find(g.ra) === tree.find(g.rb);
      if (joined && rng.f() > st.pLoop) continue;
      const wide = rng.f() < st.pWide;
      const segs = g.segs.slice().sort((x, y) => y.len - x.len || x.s0 - y.s0);
      for (const e of segs) {
        if (e.len < 1.4) break;
        const dw = wide ? e.len * rng.range(0.4, 0.8) : Math.min(st.doorW, e.len - 0.6);
        const cand = spots(e, e.s0 + dw / 2 + 0.3, e.s1 - dw / 2 - 0.3);
        if (!cand.length) continue;
        const [s, rr] = cand[Math.floor(rng.f() * cand.length)];
        if (e.len <= dw + 0.9) e.open = true; else e.door = [s - dw / 2, s + dw / 2];
        tree.union(g.ra, g.rb);
        const pc = P(e, s);
        links.push({ a: rr[0], b: rr[1], x: pc[0], y: pc[1], w: dw, kind: wide ? 'wide' : 'door' });
        doors++;
        break;
      }
    }
    // 2b. anything still cut off: carve a doorway through a solid (thick store
    //     wall, mass) where a shared wall exists; this keeps every part connected
    for (const g of order) {
      if (tree.find(g.ra) === tree.find(g.rb)) continue;
      for (const e of g.segs.slice().sort((x, y) => y.len - x.len || x.s0 - y.s0)) {
        if (e.len < 1.4 || e.door || e.open) continue;
        const dw = Math.min(st.doorW, e.len - 0.6), s = (e.s0 + e.s1) / 2;
        carve(Zs[R[e.a].z], e, s, dw); carve(Zs[R[e.b].z], e, s, dw);
        const rr = rooms(e, s);
        if (!rr) continue;
        e.door = [s - dw / 2, s + dw / 2];
        tree.union(g.ra, g.rb);
        const pc = P(e, s);
        links.push({ a: rr[0], b: rr[1], x: pc[0], y: pc[1], w: dw, kind: 'door' });
        doors++;
        break;
      }
    }
    // 3. walls
    for (const e of adj) {
      if (e.open) continue;
      const same = uf.find(e.a) === uf.find(e.b);
      if (same && !e.wide && plain(e.a) && plain(e.b)) {
        // same room: usually no wall, sometimes a partial stub sticking out
        if (R[e.a].k === ALCOVE || R[e.b].k === ALCOVE || e.len < 3 || rng.f() > st.pStub) continue;
        const f = rng.range(0.2, 0.6) * e.len;
        if (rng.f() < 0.5) pushSeg(walls, e, e.s0, e.s0 + f); else pushSeg(walls, e, e.s1 - f, e.s1);
        continue;
      }
      if (e.door) { pushSeg(walls, e, e.s0, e.door[0]); pushSeg(walls, e, e.door[1], e.s1); }
      else pushSeg(walls, e, e.s0, e.s1);
    }
    B.walls = walls; B.links = links; B.doorCount = doors;
  }

  /** Cut a doorway-sized gap (along a shared wall at position s) out of a zone's masses. */
  function carve(Z, e, s, dw) {
    const M = Z.masses, out = [];
    const g0 = s - dw / 2 - 0.3, g1 = s + dw / 2 + 0.3;
    for (let k = 0; k < M.length; k += 4) {
      const x0 = M[k], y0 = M[k + 1], x1 = M[k + 2], y1 = M[k + 3];
      // only masses touching this wall line (within 1.6 units)
      const near = e.v ? (Math.min(Math.abs(x0 - e.c), Math.abs(x1 - e.c)) <= 1.6 && y1 > g0 && y0 < g1)
        : (Math.min(Math.abs(y0 - e.c), Math.abs(y1 - e.c)) <= 1.6 && x1 > g0 && x0 < g1);
      if (!near) { out.push(x0, y0, x1, y1); continue; }
      if (e.v) { if (y0 < g0) out.push(x0, y0, x1, g0); if (y1 > g1) out.push(x0, g1, x1, y1); }
      else { if (x0 < g0) out.push(x0, y0, g0, y1); if (x1 > g1) out.push(g1, y0, x1, y1); }
    }
    Z.masses = out;
  }

  /** Wings and room chains: plain rooms, connected. */
  function finishPlain(P, rng, st) {
    prune(P, 0);
    plainZones(P);
    connect(P, rng, st);
  }

  // ------------------------------------------------------------------ wings
  /**
   * Grow rotated wings off outside walls. The wing's frame is the parent wall's
   * outward normal turned by 8-50 degrees; its first room overlaps the parent
   * room slightly so the two fuse into one floor (an opening, no wall).
   */
  function growWings(env, rng, st) {
    const parts = env.parts;
    for (let w = 0; w < st.wings; w++) {
      for (let attempt = 0; attempt < 14; attempt++) {
        const P = parts.length > 1 && rng.f() < 0.4 ? parts[1 + Math.floor(rng.f() * (parts.length - 1))] : parts[0];
        if (!P.rects.length) continue;
        const pr = Math.floor(rng.f() * P.rects.length), R = P.rects[pr];
        if (R.k === ALCOVE) continue;
        const dir = rng.int(0, 3);
        const lo = dir % 2 === 0 ? R.y0 : R.x0, hi = dir % 2 === 0 ? R.y1 : R.x1;
        if (hi - lo < 4) continue;
        const t = lo + 1.5 + rng.f() * (hi - lo - 3);
        const nx = dir === 0 ? 1 : dir === 2 ? -1 : 0, ny = dir === 1 ? 1 : dir === 3 ? -1 : 0;
        const face = dir === 0 ? R.x1 : dir === 1 ? R.y1 : dir === 2 ? R.x0 : R.y0;
        const pen = 0.9;
        const fx = nx ? face - nx * pen : t, fy = nx ? t : face - ny * pen;
        const pRoom = roomAt(P, pr, nx ? face - nx * 0.6 : t, nx ? t : face - ny * 0.6);
        if (pRoom < 0) continue;
        // just outside the face must be outside the part (an exterior wall)
        let interior = false;
        const ex = nx ? face + nx * 0.5 : t, ey = nx ? t : face + ny * 0.5;
        for (const o of P.rects) if (ex > o.x0 && ex < o.x1 && ey > o.y0 && ey < o.y1) { interior = true; break; }
        if (interior) continue;
        // wing +y axis = parent normal turned by phi (exact rational turn from ROTS)
        const rt = ROTS[rng.int(3, 18)], sg = rng.f() < 0.5 ? 1 : -1;
        const yx = rt.c * nx - sg * rt.s * ny, yy = sg * rt.s * nx + rt.c * ny;
        const wc = yy, ws = -yx;                                  // wing x axis in parent frame
        const c = P.c * wc - P.s * ws, s = P.s * wc + P.c * ws;   // in cluster frame
        const [ox, oy] = P.toCluster(fx, fy);
        const Wg = new Part(env, c, s, ox, oy, { part: P, rect: pr });
        parts.push(Wg);
        // root: a corridor running out, or a room
        let rw, rh, kind;
        if (rng.f() < 0.4) { rw = st.hallW; rh = rng.int(6, 16); kind = HALL; }
        else { [rw, rh] = roomSize(rng, st); rw = Math.max(4, Math.min(rw, hi - lo + 4)); kind = ROOM; }
        let placed = -1;
        for (let k = 0; k < 4 && placed < 0; k++) {
          const x0 = -Math.floor(rw / 2);
          if (Wg.ok(x0, 0, x0 + rw, rh)) placed = Wg.add(x0, 0, x0 + rw, rh, kind);
          rh = Math.max(3, Math.round(rh * 0.75));
        }
        if (placed < 0) { parts.pop(); continue; }
        const wst = Object.assign({}, st, { tries: rng.f() < 0.6 ? 1 : 2, pChain: rng.range(0.4, 0.85), pHall: Math.max(st.pHall, 0.15) });
        const n = rng.f();
        accrete(Wg, rng, wst, Wg.area + (n * n * 4 + 0.3) * st.roomArea, 'room');
        finishPlain(Wg, rng, st);
        const [JX, JY] = P.toCluster(nx ? face : t, nx ? t : face);
        env.joints.push({ pa: parts.indexOf(P), ra: pRoom, pb: parts.length - 1, rb: roomAt(Wg, 0, 0, Math.min(1.5, Wg.rects[0].y1 - 0.3)), x: JX, y: JY, kind: 'joint' });
        break;
      }
    }
  }

  // ------------------------------------------------------------------ ports
  function makePorts(W, site, env, rng) {
    const ports = new Map();
    const nb = BR.neighbours(W, site);
    const c = site.rot.c, s = site.rot.s;
    const blocked = [], used = [];
    const toWorld = (X, Y) => ({ x: site.x + c * X - s * Y, y: site.y + s * X + c * Y });
    const SIDES = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    const parts = env.parts;
    for (const T of nb) {
      const dxw = T.x - site.x, dyw = T.y - site.y;
      const L = Math.sqrt(dxw * dxw + dyw * dyw) || 1;
      const dx = (c * dxw + s * dyw) / L, dy = (-s * dxw + c * dyw) / L;     // cluster frame
      const cw = BR.corridorWidth(site, T);
      // Neighbours in roughly the same direction share one exit: the corridors
      // fork outside instead of leaving through two doors and crossing.
      let shared = null;
      for (const q of used) if (q.dx * dx + q.dy * dy > 0.86) { shared = q.port; break; }
      if (shared) { ports.set(T.key, shared); continue; }
      const cands = [];
      for (let pi = 0; pi < parts.length; pi++) {
        const P = parts[pi];
        for (let k = 0; k < P.rects.length; k++) {
          const r = P.rects[k];
          if (r.k === ALCOVE) continue;
          for (let sd = 0; sd < 4; sd++) {
            const [nx, ny] = SIDES[sd];
            const Nx = P.c * nx - P.s * ny, Ny = P.s * nx + P.c * ny;
            const nd = Nx * dx + Ny * dy;
            if (nd < 0.2) continue;
            const lo = nx ? r.y0 : r.x0, hi = nx ? r.y1 : r.x1;
            if (hi - lo < cw + 1) continue;
            const mx = nx > 0 ? r.x1 : nx < 0 ? r.x0 : (r.x0 + r.x1) / 2;
            const my = ny > 0 ? r.y1 : ny < 0 ? r.y0 : (r.y0 + r.y1) / 2;
            const [MX, MY] = P.toCluster(mx, my);
            cands.push({ pi, k, sd, score: MX * dx + MY * dy + 3 * nd + rng.f() * 1.5 });
          }
        }
      }
      cands.sort((a, b) => b.score - a.score);
      let port = null;
      for (let pass = 0; pass < 3 && !port; pass++) {
        if (pass === 2) {
          // last resort: any exterior face at all, best-facing first
          cands.length = 0;
          for (let pi = 0; pi < parts.length; pi++) for (let k = 0; k < parts[pi].rects.length; k++) for (let sd = 0; sd < 4; sd++) {
            const P = parts[pi], r = P.rects[k], [nx, ny] = SIDES[sd];
            const Nx = P.c * nx - P.s * ny, Ny = P.s * nx + P.c * ny;
            const lo = nx ? r.y0 : r.x0, hi = nx ? r.y1 : r.x1;
            if (hi - lo < cw + 1) continue;
            cands.push({ pi, k, sd, score: Nx * dx + Ny * dy + rng.f() * 0.1 });
          }
          cands.sort((a, b) => b.score - a.score);
        }
        for (let q = 0; q < Math.min(cands.length, pass === 2 ? 400 : 40) && !port; q++) {
          const cd = cands[q], P = parts[cd.pi], r = P.rects[cd.k], [nx, ny] = SIDES[cd.sd];
          const lo = nx ? r.y0 : r.x0, hi = nx ? r.y1 : r.x1;
          const a0 = lo + cw / 2 + 0.5, a1 = hi - cw / 2 - 0.5;
          const t = a0 + rng.f() * Math.max(0, a1 - a0);
          const face = nx > 0 ? r.x1 : nx < 0 ? r.x0 : ny > 0 ? r.y1 : r.y0;
          const sl = 1.6 + rng.f() * 1.8, hw = cw / 2 + 0.45;
          let fx0, fy0, fx1, fy1;
          if (nx) { fx0 = nx > 0 ? face : face - sl - 0.6; fx1 = nx > 0 ? face + sl + 0.6 : face; fy0 = t - hw; fy1 = t + hw; }
          else { fy0 = ny > 0 ? face : face - sl - 0.6; fy1 = ny > 0 ? face + sl + 0.6 : face; fx0 = t - hw; fx1 = t + hw; }
          let okp = true;
          for (let m = 0; m < P.rects.length && okp; m++) {
            const o = P.rects[m];
            if (fx0 < o.x1 - EPS && o.x0 < fx1 - EPS && fy0 < o.y1 - EPS && o.y0 < fy1 - EPS) okp = false;
          }
          const fq = quad(P, fx0, fy0, fx1, fy1);
          if (okp && parts.length > 1) {
            for (const O of parts) {
              if (O === P || !okp) continue;
              for (const o of O.rects) if (quadsOverlap(fq, O.rectQuad(o))) { okp = false; break; }
            }
          }
          if (okp && pass === 0) for (const b of blocked) if (quadsOverlap(fq, b)) { okp = false; break; }
          if (okp && pass === 2) {
            // the exit must be on an outside wall
            const ex = nx ? face + nx * 0.5 : t, ey = nx ? t : face + ny * 0.5;
            for (const o of P.rects) if (ex > o.x0 && ex < o.x1 && ey > o.y0 && ey < o.y1) { okp = false; break; }
          }
          if (!okp) continue;
          const inset0 = Math.min(1.4, (nx ? r.x1 - r.x0 : r.y1 - r.y0) * 0.5);
          const room = roomAt(P, cd.k, nx ? face - nx * Math.min(inset0, 0.8) : t, nx ? t : face - ny * Math.min(inset0, 0.8));
          if (room < 0) continue;
          blocked.push(quad(P, fx0 - 0.5, fy0 - 0.5, fx1 + 0.5, fy1 + 0.5));
          const inset = Math.min(1.4, (nx ? r.x1 - r.x0 : r.y1 - r.y0) * 0.5);  // hides the corridor's end cap
          const ix = nx ? face - nx * inset : t, iy = nx ? t : face - ny * inset;
          const ox = nx ? face + nx * sl : t, oy = nx ? t : face + ny * sl;
          const [IX, IY] = P.toCluster(ix, iy), [OX, OY] = P.toCluster(ox, oy);
          const Nx = P.c * nx - P.s * ny, Ny = P.s * nx + P.c * ny;
          port = { inner: toWorld(IX, IY), outer: toWorld(OX, OY), nx: c * Nx - s * Ny, ny: s * Nx + c * Ny, part: cd.pi, rect: cd.k, room };
        }
      }
      if (!port) port = { inner: { x: site.x, y: site.y }, outer: { x: site.x, y: site.y }, nx: dxw / L, ny: dyw / L, part: -1, rect: -1, room: -1 };
      used.push({ dx, dy, port });
      ports.set(T.key, port);
    }
    return ports;
  }

  // ------------------------------------------------------------------ reach
  /**
   * Small clusters: one ellipse (a pod). Bigger ones: a pocket at the centre
   * plus a branching skeleton of mostly axis-aligned arms, each a capsule.
   */
  function makeReach(R, rng) {
    const squash = rng.f() < 0.4 ? 1 : rng.range(0.45, 0.9);
    const lobes = [];
    /** add a box if its corners stay inside radius R (shrinking it if needed) */
    const box = (cx, cy, ux, uy, hl, hw) => {
      for (let it = 0; it < 8; it++) {
        let far = 0;
        for (const [p, q] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          const x = cx + ux * hl * p - uy * hw * q, y = cy + uy * hl * p + ux * hw * q;
          far = Math.max(far, x * x + y * y);
        }
        if (far <= R * R) { lobes.push({ cx, cy, ux, uy, hl, hw }); return true; }
        hl *= 0.8; hw *= 0.92;
        if (hl < 2.5 || hw < 2.5) return false;
      }
      return false;
    };
    if (R <= 22 || rng.f() < 0.12) {
      const a = R * rng.range(0.55, 0.8);
      box(0, 0, 1, 0, a, Math.min(a * squash * rng.range(0.7, 1.3), Math.sqrt(Math.max(1, R * R - a * a))));
      if (!lobes.length) lobes.push({ cx: 0, cy: 0, ux: 1, uy: 0, hl: 3, hw: 3 });
      return { lobes, lobeArea: 4 * lobes[0].hl * lobes[0].hw, squash };
    }
    const a0 = R * rng.range(0.28, 0.5);
    if (!box(0, 0, 1, 0, a0, a0 * squash * rng.range(0.7, 1.3))) lobes.push({ cx: 0, cy: 0, ux: 1, uy: 0, hl: 5, hw: 5 });
    const nodes = [[0, 0]];
    const arms = rng.int(2, 2 + Math.floor(R / 15));
    let lastDir = rng.int(0, 3);
    for (let k = 0; k < arms; k++) {
      const from = rng.f() < 0.55 ? nodes[nodes.length - 1] : nodes[Math.floor(rng.f() * nodes.length)];
      let dx, dy;
      if (rng.f() < 0.82) {                      // axis-aligned arm (turns mostly by 90)
        lastDir = (lastDir + (rng.f() < 0.5 ? 1 : 3) + (rng.f() < 0.2 ? 1 : 0)) & 3;
        dx = lastDir === 0 ? 1 : lastDir === 2 ? -1 : 0; dy = lastDir === 1 ? 1 : lastDir === 3 ? -1 : 0;
      } else {                                   // diagonal arm
        dx = rng.range(-1, 1); dy = rng.range(-1, 1);
        const l = Math.sqrt(dx * dx + dy * dy) || 1; dx /= l; dy /= l;
      }
      const hw = Math.max(3.5, R * rng.range(0.1, 0.3));
      const L = R * rng.range(0.35, 0.9);
      const hl = L / 2 + hw * 0.5;
      if (box(from[0] + dx * L / 2, from[1] + dy * L / 2, dx, dy, hl, hw)) {
        const B = lobes[lobes.length - 1];
        nodes.push([B.cx + dx * (B.hl - B.hw * 0.5), B.cy + dy * (B.hl - B.hw * 0.5)]);
      }
    }
    let area = 0;
    for (const L of lobes) area += 4 * L.hl * L.hw;
    return { lobes, lobeArea: area * 0.85, squash };
  }

  // ------------------------------------------------------------------- arms
  /**
   * Arms: chains of rooms that grow from the body toward graph neighbours.
   * Inside a complex every door-connected (fused) neighbour gets an arm that
   * runs all the way to the shared seam, so the two buildings meet; elsewhere
   * arms are optional and stop short (a corridor finishes the trip).
   */
  function planArms(W, site, env, rng, st) {
    const c = site.rot.c, s = site.rot.s, arms = [];
    const p = site.cx ? 0.5 : Math.min(0.85, 0.35 + 0.5 * site.D);
    const M = BR.CFG.maxReach;
    for (const T of BR.neighbours(W, site)) {
      const fused = BR.isFused(site, T);
      if (!fused && rng.f() > (T.kind === 'junction' ? p * 0.7 : p)) continue;
      const dxw = T.x - site.x, dyw = T.y - site.y, L = Math.sqrt(dxw * dxw + dyw * dyw);
      const dx = (c * dxw + s * dyw) / L, dy = (-s * dxw + c * dyw) / L;
      // distance to the territory boundary along the arm
      let reach = M - 4;
      for (const P of env.planes) {
        const k = P.ux * dx + P.uy * dy;
        if (k > 1e-6) reach = Math.min(reach, P.t / k);
      }
      reach -= fused ? 0.2 : rng.range(1, 6);
      if (reach < 8) continue;
      const hw = Math.min(8, Math.max(2.5, rng.range(2.5, 6.5) * st.roomScale));
      arms.push({ dx, dy, reach, hw, fused });
    }
    return arms;
  }

  const SIDES = [[1, 0], [0, 1], [-1, 0], [0, -1]];

  /** Outside face of part P that best faces cluster-frame direction (dx,dy), far along it. */
  function bestFace(P, dx, dy, minLen) {
    let best = null, bs = -Infinity;
    for (let i = 0; i < P.rects.length; i++) {
      const r = P.rects[i];
      if (r.k === ALCOVE) continue;
      for (let sd = 0; sd < 4; sd++) {
        const [nx, ny] = SIDES[sd];
        const Nx = P.c * nx - P.s * ny, Ny = P.s * nx + P.c * ny;     // cluster frame
        const nd = Nx * dx + Ny * dy;
        if (nd < 0.35) continue;
        const lo = nx ? r.y0 : r.x0, hi = nx ? r.y1 : r.x1;
        if (hi - lo < minLen) continue;
        const face = nx > 0 ? r.x1 : nx < 0 ? r.x0 : ny > 0 ? r.y1 : r.y0;
        const t = (lo + hi) / 2;
        const lx = nx ? face : t, ly = nx ? t : face;
        // must be an outside face here: just beyond it is not inside another rect of P
        const ox = lx + nx * 0.5, oy = ly + ny * 0.5;
        let inside = false;
        for (const o of P.rects) if (ox > o.x0 && ox < o.x1 && oy > o.y0 && oy < o.y1) { inside = true; break; }
        if (inside) continue;
        const [X, Y] = P.toCluster(lx, ly);
        const score = X * dx + Y * dy - 0.5 * Math.abs(X * dy - Y * dx) + 3 * nd;
        if (score > bs) { bs = score; best = { i, sd, lo, hi, face }; }
      }
    }
    return best;
  }

  /**
   * Wall with a doorway where a child part joins its parent's face. Pushed into
   * the parent's (already finalized) wall list, in the parent's frame.
   */
  function jointWall(P, f, child, rng, st, at) {
    const r0 = child.rects[0];
    if (!r0) return;
    const q = child.rectQuad(r0), [nx] = SIDES[f.sd];
    let s0 = Infinity, s1 = -Infinity;
    for (let k = 0; k < 8; k += 2) {
      const [lx, ly] = P.toLocal(q[k], q[k + 1]);
      const v = nx ? ly : lx;
      s0 = Math.min(s0, v); s1 = Math.max(s1, v);
    }
    s0 = Math.max(s0, f.lo); s1 = Math.min(s1, f.hi);
    if (s1 - s0 < 1) return;
    if (rng.f() < st.pOpen * 0.5) return;                 // sometimes a full-width opening
    const dw = Math.min(st.doorW, s1 - s0 - 0.6);
    const c = Math.max(s0 + dw / 2 + 0.3, Math.min(s1 - dw / 2 - 0.3, at));
    const seg = (a, b) => {
      if (b - a < 0.05) return;
      if (nx) P.walls.push(f.face, a, f.face, b); else P.walls.push(a, f.face, b, f.face);
    };
    seg(s0, c - dw / 2); seg(c + dw / 2, s1);
  }

  /**
   * A chain of rooms that drifts: every one to three rooms it starts a new part
   * turned by a few degrees (exact rational turns), steering back toward its
   * target. Each joint gets a wall with a doorway. This is what makes long
   * room bands look hand-surveyed instead of ruled.
   */
  function growDriftChain(env, rng, st, arm) {
    const { dx, dy, hw } = arm;
    const tx = dx * arm.reach, ty = dy * arm.reach;
    const reached = (Q) => {
      for (const r of Q.rects) {
        const q = Q.rectQuad(r);
        for (let k = 0; k < 8; k += 2) if (q[k] * dx + q[k + 1] * dy >= arm.reach - 0.3) return true;
      }
      return false;
    };
    let P = env.parts[0];
    let f = bestFace(P, dx, dy, 4);
    if (!f) return;
    {   // already there? (some room within 3 units of the target point on the seam)
      for (const r of P.rects) {
        const q = P.rectQuad(r);
        let inside = true, m = Infinity;
        for (let k = 0; k < 8; k += 2) {
          const ax = q[k], ay = q[k + 1], bx = q[(k + 2) % 8], by = q[(k + 3) % 8];
          if ((bx - ax) * (ty - ay) - (by - ay) * (tx - ax) < 0) inside = false;
          m = Math.min(m, BR.distSegSq(tx, ty, ax, ay, bx, by));
        }
        if (inside || m <= 2.25) return;
      }
    }
    for (let seg = 0; seg < 12; seg++) {
      const [nx, ny] = SIDES[f.sd];
      const Nx = P.c * nx - P.s * ny, Ny = P.s * nx + P.c * ny;
      const fl = f.hi - f.lo;
      const lat = Math.max(3, Math.min(Math.round(2 * hw * rng.range(0.7, 1.15)), Math.floor(fl - 1)));
      // attach point: toward the target line, kept clear of the face ends
      const m = lat / 2 + 0.5;
      let at = (f.lo + f.hi) / 2;
      {
        const A0 = P.toCluster(nx ? f.face : f.lo, nx ? f.lo : f.face), A1 = P.toCluster(nx ? f.face : f.hi, nx ? f.hi : f.face);
        // pick the point along the face closest to the target ray
        const cross = (X, Y) => X * dy - Y * dx;
        const c0 = cross(A0[0], A0[1]), c1 = cross(A1[0], A1[1]);
        if (c0 !== c1) at = f.lo + (f.hi - f.lo) * Math.max(0, Math.min(1, c0 / (c0 - c1)));
        at += rng.range(-1, 1) * fl * 0.15;
      }
      if (f.hi - f.lo < 2 * m) at = (f.lo + f.hi) / 2; else at = Math.max(f.lo + m, Math.min(f.hi - m, at));
      // the doorway must open onto floor on the parent's side (not a solid, shelf...)
      const inside = (t) => (nx ? [f.face - nx * 0.6, t] : [t, f.face - ny * 0.6]);
      const pin = (t) => { const q = inside(t); return roomAt(P, f.i, q[0], q[1]); };
      let pRoom = pin(at);
      if (pRoom < 0) {
        let best = null;
        for (let t = f.lo + 0.8; t <= f.hi - 0.8; t += 0.5) { const r = pin(t); if (r >= 0 && (!best || Math.abs(t - at) < Math.abs(best[0] - at))) best = [t, r]; }
        if (!best) return;
        [at, pRoom] = best;
      }
      const pen = 0.9;
      const [AX, AY] = P.toCluster(nx ? f.face : at, nx ? at : f.face);
      // heading: parent normal, maybe turned a little toward the target
      let hx = Nx, hy = Ny;
      if (rng.f() < 0.72) {
        let gx = tx - AX, gy = ty - AY;
        const gl = Math.sqrt(gx * gx + gy * gy) || 1; gx /= gl; gy /= gl;
        const cr = hx * gy - hy * gx, dot = hx * gx + hy * gy;
        let sg = rng.f() < 0.75 ? (cr >= 0 ? 1 : -1) : (rng.f() < 0.5 ? 1 : -1);
        let k = rng.int(0, BR.DRIFT.length - 1);
        if (dot < 0.9 && sg === (cr >= 0 ? 1 : -1)) k = BR.DRIFT.length - 1 - rng.int(0, 1);   // off course: bigger turn
        const t = BR.DRIFT[k];
        const h2x = t.c * hx - sg * t.s * hy, h2y = sg * t.s * hx + t.c * hy;
        hx = h2x; hy = h2y;
      }
      const C = env.parts.length;
      const child = new Part(env, hy, -hx, AX - Nx * pen, AY - Ny * pen, { part: P, rect: f.i });
      child.chain = true;
      env.parts.push(child);
      // root room
      let w = lat, d = Math.max(3, Math.round(rng.range(4, 11) * st.roomScale)), placed = -1;
      const off = rng.int(-1, 1);
      for (let k = 0; k < 4 && placed < 0; k++) {
        const x0 = -Math.floor(w / 2) + off;
        if (child.ok(x0, 0, x0 + w, d)) placed = child.add(x0, 0, x0 + w, d, ROOM);
        d = Math.max(2, Math.round(d * 0.7)); if (k >= 1) w = Math.max(3, w - 1);
      }
      if (placed < 0) { env.parts.length = C; return; }
      // one or two more rooms straight on, sometimes a hall, sometimes a side room
      let cur = 0;
      const more = rng.int(0, 2);
      for (let k = 0; k < more && !reached(child); k++) {
        const R0 = child.rects[cur];
        const hall = rng.f() < 0.18;
        const lw = hall ? st.hallW : Math.max(3, Math.round(2 * hw * rng.range(0.65, 1.15)));
        const dep = hall ? rng.int(4, 9) : Math.max(3, Math.round(rng.range(4, 11) * st.roomScale));
        let l0 = Math.round((R0.x0 + R0.x1) / 2 - lw / 2 + rng.range(-1, 1) * Math.min(lw, R0.x1 - R0.x0) * 0.3);
        l0 = Math.max(R0.x0 - lw + 2, Math.min(R0.x1 - 2, l0));
        const ni = child.attach(cur, 1, l0, l0 + lw, dep, 2, hall ? HALL : ROOM);
        if (ni < 0) break;
        cur = ni;
      }
      if (rng.f() < 0.25) {
        const R0 = child.rects[rng.int(0, child.rects.length - 1)], ri = child.rects.indexOf(R0);
        const dir = rng.f() < 0.5 ? 0 : 2, sl = Math.min(R0.y1 - R0.y0, rng.int(3, 8)), sw = Math.max(3, Math.round(rng.range(3, 8) * st.roomScale));
        const y0 = R0.y0 + rng.int(0, Math.max(0, R0.y1 - R0.y0 - sl));
        child.attach(ri, dir, y0, y0 + sl, sw, 3, ROOM);
      }
      finishPlain(child, rng, st);
      jointWall(P, f, child, rng, st, at);
      {
        const r0 = child.rects[0], lx = Math.max(r0.x0 + 0.5, Math.min(r0.x1 - 0.5, 0)), ly = Math.min(1.5, r0.y1 - 0.3);
        const [JX, JY] = P.toCluster(nx ? f.face : at, nx ? at : f.face);
        env.joints.push({ pa: env.parts.indexOf(P), ra: pRoom, pb: C, rb: roomAt(child, 0, lx, ly), x: JX, y: JY, kind: 'joint' });
      }
      if (reached(child)) return;
      // continue from the far face of the chain's last room
      let li = 0;
      for (let i = 1; i < child.rects.length; i++) if (child.rects[i].y1 > child.rects[li].y1) li = i;
      const L = child.rects[li];
      if (L.x1 - L.x0 < 3) return;
      P = child;
      f = { i: li, sd: 1, lo: L.x0, hi: L.x1, face: L.y1 };
    }
  }

  /** Territory polygon (cluster frame): a square of half-size R clipped by every half-plane. */
  function territoryPoly(planes, R) {
    let poly = [[-R, -R], [R, -R], [R, R], [-R, R]];
    for (const P of planes) {
      const out = [], n = poly.length;
      for (let k = 0; k < n; k++) {
        const a = poly[k], b = poly[(k + 1) % n];
        const da = P.ux * a[0] + P.uy * a[1] - P.t, db = P.ux * b[0] + P.uy * b[1] - P.t;
        if (da <= 0) out.push(a);
        if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
          const t = da / (da - db);
          out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        }
      }
      poly = out;
      if (!poly.length) break;
    }
    return poly;
  }
  function polyArea(poly) {
    let a = 0;
    for (let k = 0; k < poly.length; k++) { const p = poly[k], q = poly[(k + 1) % poly.length]; a += p[0] * q[1] - q[0] * p[1]; }
    return Math.abs(a) / 2;
  }
  function territoryArea(planes, R) { return polyArea(territoryPoly(planes, R)); }

  // ------------------------------------------------------------------ build
  function buildCluster(W, site) {
    const rng = new Rng(hash4(W.seed, site.i, site.j, BR.SALT.CLUSTER));
    const st = makeStyle(site, rng);
    const c = site.rot.c, s = site.rot.s;
    // territory planes & lanes into the cluster frame
    const planes = BR.territoryPlanes(W, site).map((p) => ({ ux: c * p.ux + s * p.uy, uy: -s * p.ux + c * p.uy, t: p.t }));
    const lanes = BR.lanes(W, site).map((l) => ({
      x0: c * l.x0 + s * l.y0, y0: -s * l.x0 + c * l.y0,
      x1: c * l.x1 + s * l.y1, y1: -s * l.x1 + c * l.y1
    }));
    // Complex members build out to their territory (the neighbours' seams);
    // everyone else stays within their own reach.
    const R = site.cx ? Math.min(BR.CFG.maxReach - 2, Math.max(site.r, rng.range(26, 46))) : site.r;
    let { lobes, lobeArea, squash } = makeReach(R, rng);
    const full = (site.cx && rng.f() < 0.2 + 0.75 * site.solid) || !!site.landmark;
    if (full) {
      // solid complex members fill their territory polygon, so they meet their
      // neighbours along the seams (dense, A24-style packing)
      lobes = [{ cx: 0, cy: 0, ux: 1, uy: 0, hl: R, hw: R }];
      lobeArea = 4 * R * R;
      st.fill = rng.range(0.62, 0.8) + 0.18 * site.solid;
    }
    const env = { R, lobes, planes, lanes, parts: [], joints: [] };
    const B = new Part(env, 1, 0, site.goff[0], site.goff[1], null);   // on the shared lattice
    env.parts.push(B);

    const arms = planArms(W, site, env, rng, st);
    if (st.mode === 'blocks') coreBlock(B, rng, st, site); else coreNone(B, rng, st);
    if (!B.rects.length) B.placeNear(0, 0, 3, 3, ROOM);
    if (!B.rects.length) B.add(-1, -1, 2, 2, ROOM); // degenerate fallback, always inside min core
    const target = site.cx
      ? Math.max(B.area * 1.05, st.fill * Math.min(lobeArea, territoryArea(planes, R)))
      : Math.max(B.area * 1.05, st.fill * Math.min(lobeArea, Math.PI * R * R * squash) * (0.8 + 0.2 * site.D));
    const fillFrac = !site.cx ? 0 : full ? 0.35 + 0.6 * site.solid : 0.1 + 0.3 * site.solid;
    if (st.mode === 'blocks') {
      accrete(B, rng, st, target, 'block');
      if (fillFrac) infill(B, rng, st, fillFrac, BLOCK);
      // a few small rooms around the blocks (closets, vestibules)
      accrete(B, rng, st, B.area * rng.range(1.0, 1.06), 'room');
    } else {
      accrete(B, rng, st, target, 'room');
      if (fillFrac) infill(B, rng, st, fillFrac, ROOM);
    }
    cleanupOutline(B);
    prune(B, -1);
    assignZones(B, rng, st);
    connect(B, rng, st);
    for (const a of arms) growDriftChain(env, rng, st, a);
    growWings(env, rng, st);

    const ports = makePorts(W, site, env, rng);
    let bound = 0, rectCount = 0, roomCount = 0, doorCount = 0;
    for (const P of env.parts) {
      for (const r of P.rects) {
        const q = P.rectQuad(r);
        for (let k = 0; k < 8; k += 2) bound = Math.max(bound, q[k] * q[k] + q[k + 1] * q[k + 1]);
      }
      rectCount += P.rects.length; doorCount += P.doorCount;
    }
    // Public shape: parts with frames (relative to the cluster frame), their
    // footprint rects, zones, rooms + links (room graph) and drawing primitives.
    const KEYS = ['minor', 'hatch', 'masses', 'voids', 'pools', 'props', 'rounds', 'pillars', 'stairs'];
    const parts = env.parts.map((P) => {
      const out = { c: P.c, s: P.s, ox: P.ox, oy: P.oy, rects: P.rects, zones: P.zones, links: P.links, walls: P.walls.slice(), rooms: [] };
      for (const k of KEYS) out[k] = [];
      for (const Z of P.zones) {
        for (const r of Z.rooms) out.rooms.push({ rects: r.rects, kind: r.kind, zone: Z.type });
        for (let i = 0; i < Z.major.length; i++) out.walls.push(Z.major[i]);
        for (const k of KEYS) { const A = Z[k], O = out[k]; for (let i = 0; i < A.length; i++) O.push(A[i]); }
      }
      roomCount += out.rooms.length;
      return out;
    });
    let floor = 0;
    for (const P of env.parts) floor += P.area;
    const territory = territoryPoly(planes, BR.CFG.maxReach);   // debug overlay / stats
    return { site, style: st, parts, joints: env.joints, ports, territory, floor, bound: Math.sqrt(bound) + 1, rectCount, roomCount, doorCount, render: null };
  }

  BR.buildCluster = buildCluster;
  BR.roomAt = roomAt;
  BR.RECT_KIND = { ROOM, HALL, BIG, ALCOVE };
})(typeof window !== 'undefined' ? window : globalThis);
