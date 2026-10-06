/*
 * boundary.js - the shared wall between two adjacent territories.
 *
 * Built from the plan's pair rule (wall type, door count) and both sides'
 * interiors: a door is only placed where there is floor on both sides
 * (probed 0.6 m in from a thin wall, 1.6 m from a thick one). Door spots
 * prefer corridors, hallways and aisles on both sides, so circulation lines
 * up across territories, and avoid maintenance strips unless the boundary
 * belongs to a band. Open boundaries have no wall; every pair of rooms that
 * faces across them is linked.
 */
(function (root) {
  'use strict';
  const BR = root.BR;
  const { Rng } = BR;

  const CIRC = new Set(['corridor', 'hallway', 'aisle', 'hall', 'grand hall', 'office', 'store', 'car park', 'pool room', 'pool hall', 'courtyard', 'atrium', 'gallery']);

  function buildBoundary(W, A, B) {
    const info = BR.pairInfo(W, A, B);
    if (info.a.key !== A.key) { const t = A; A = B; B = t; }
    const IA = W.interior(A), IB = W.interior(B);
    const rng = new Rng(info.h ^ 0x5bd1e995);
    const n = BR.doorCount(W, A, B), segs = info.segs;
    const out = { key: info.key, a: A.key, b: B.key, wall: info.wall, cross: info.fa !== info.fb, walls: [], doors: [], links: [], ax: A.bbox[0], ay: A.bbox[1] };
    // point at depth d into A (or B) from the shared line
    const pt = (s, t, d, intoA) => {
      const sgA = s.side === 1 || s.side === 3 ? -1 : 1, sg = intoA ? sgA : -sgA;
      return s.o === 'h' ? [t, s.c + sg * d] : [s.c + sg * d, t];
    };
    const probe = (s, t, d) => {
      const pa = pt(s, t, d, true), pb = pt(s, t, d, false);
      const ra = BR.interiorRoomAt(IA, pa[0], pa[1], true);
      if (ra < 0) return null;
      const rb = BR.interiorRoomAt(IB, pb[0], pb[1], true);
      return rb < 0 ? null : [ra, rb];
    };
    const at = (s, t) => (s.o === 'h' ? [t, s.c] : [s.c, t]);
    const link = (r, s, t, kind, w) => {
      const p = at(s, t);
      out.links.push({ a: { key: A.key, room: r[0] }, b: { key: B.key, room: r[1] }, kind, x: p[0], y: p[1], w });
    };

    if (info.wall === 'open') {
      const seen = new Set();
      for (const s of segs) for (let t = s.s0 + 0.75; t < s.s1; t += 1.5) {
        const r = probe(s, t, 0.6);
        if (!r || seen.has(r[0] + ',' + r[1])) continue;
        seen.add(r[0] + ',' + r[1]);
        link(r, s, t, 'opening', 0);
      }
      return out;
    }

    const thick = info.wall === 'thick', d0 = thick ? 1.6 : 0.6;
    const svc = (I, k) => I.rooms[k].kind === 'service';
    const gather = (d, needSvc) => {
      const c = [];
      for (let si = 0; si < segs.length; si++) {
        const s = segs[si];
        for (let t = s.s0 + 1.3; t <= s.s1 - 1.3 + 1e-9; t += 0.5) {
          const r = probe(s, t, d);
          if (!r) continue;
          const sa = svc(IA, r[0]), sb = svc(IB, r[1]);
          if (needSvc && !sa && !sb) continue;
          let score = rng.f();
          if (CIRC.has(IA.rooms[r[0]].kind)) score += 1.5;
          if (CIRC.has(IB.rooms[r[1]].kind)) score += 1.5;
          if ((sa || sb) && !info.band) score -= 4;
          c.push({ si, t, r, score });
        }
      }
      return c.sort((p, q) => q.score - p.score || p.si - q.si || p.t - q.t);
    };
    const chosen = [];
    const pick = (cands, k, kind) => {
      for (const c of cands) {
        if (chosen.length >= k) break;
        if (chosen.some((o) => { const p = at(segs[o.si], o.t), q = at(segs[c.si], c.t); return Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) < 6; })) continue;
        c.kind = kind; chosen.push(c);
      }
    };
    if (n > 0) {
      pick(gather(d0, false), n, 'door');
      if (!chosen.length) for (const d of [1.4, 2.2, 3.2]) { pick(gather(d, false), 1, 'passage'); if (chosen.length) break; }
      if (!chosen.length) W.stats.doorFailures++;
    } else if (info.service) pick(gather(d0, true), 1, 'service');   // forbidden pair: maybe one door into the band

    // door widths, wall gaps
    const gaps = segs.map(() => []);
    for (const c of chosen) {
      const s = segs[c.si];
      let w = c.kind === 'door' && rng.f() < info.wide ? rng.range(3, 7) : rng.range(1.2, 1.8);
      w = Math.min(w, 2 * Math.min(c.t - s.s0, s.s1 - c.t) - 0.6);
      w = Math.max(w, 1);
      gaps[c.si].push([c.t - w / 2, c.t + w / 2]);
      const p = at(s, c.t);
      out.doors.push({ x: p[0], y: p[1], w, o: s.o, kind: c.kind });
      link(c.r, s, c.t, c.kind === 'door' && w > 2.5 ? 'wide' : c.kind, w);
    }
    segs.forEach((s, si) => {
      const G = gaps[si].sort((p, q) => p[0] - q[0]);
      let t = s.s0;
      const push = (a, b) => {
        if (b - a < 0.05) return;
        if (s.o === 'h') out.walls.push(a, s.c, b, s.c); else out.walls.push(s.c, a, s.c, b);
      };
      for (const g of G) { push(t, Math.max(t, g[0])); t = Math.max(t, g[1]); }
      push(t, s.s1);
    });
    return out;
  }

  BR.buildBoundary = buildBoundary;
})(typeof window !== 'undefined' ? window : globalThis);
