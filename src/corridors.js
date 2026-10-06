/*
 * corridors.js - connections between sites, and junction hubs.
 *
 * A corridor runs   portA.inner -> portA.outer -> (styled middle) -> portB.outer -> portB.inner
 * The inner->outer stub leaves a room perpendicular to its wall, so even a
 * straight middle section kinks where it meets the building, like real ones.
 *
 * Middle styles (picked per edge from its pair hash): straight, dogleg (L / Z
 * in one cluster's grid), smooth cubic curve following both port normals, or a
 * gentle wander. Every candidate is checked against nearby clusters' rects;
 * the first that doesn't clip someone else's building wins (straight is the
 * last resort). Long corridors sometimes get a small room along the way.
 *
 * Junction sites get an optional hub: a small rotated room, a round room, a
 * ring corridor, or nothing (corridors simply meet / bend / dead-end there).
 *
 * Fused edges (neighbours inside one complex) get DOORS instead: short
 * passages through the seam where the two buildings' walls face each other.
 * Only if no facing walls are close enough does the edge fall back to a
 * corridor.
 */
(function (root) {
  'use strict';
  const BR = root.BR;
  const { Rng, hash4, clamp, segHitsRect, rotation, ROTS } = BR;

  // -------------------------------------------------------------------- hubs
  function buildHub(W, J) {
    const deg = BR.neighbours(W, J).length;
    if (!deg) return null;
    const rng = new Rng(hash4(W.seed, J.i, J.j, BR.SALT.HUB));
    const u = rng.f();
    let type = 'none';
    // corridors should mostly meet at rooms, not bend in mid-air
    if (deg >= 3) type = u < 0.66 ? 'rect' : u < 0.76 ? 'circle' : u < 0.81 ? 'ring' : 'none';
    else if (deg === 1) type = u < 0.75 ? 'rect' : 'none';
    else type = u < 0.25 ? 'rect' : u < 0.29 ? 'circle' : 'none';
    const hub = { site: J, type, rgb: J.rgb, render: null };
    if (type === 'rect') {
      const w = rng.int(5, 13), h = rng.int(4, 10), rot = rotation(rng.int(0, ROTS.length - 1), rng.int(0, 3));
      hub.poly = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]
        .map(([x, y]) => [rot.c * x - rot.s * y, rot.s * x + rot.c * y]);
    } else if (type === 'circle') hub.r = rng.range(2.4, 5.2);
    else if (type === 'ring') { hub.r = rng.range(4.6, 6.6); hub.w = 1.7; }
    return hub;
  }

  // --------------------------------------------------------------- endpoints
  function endpoint(W, S, T) {
    if (S.kind === 'cluster') {
      const cl = W.cluster(S);
      const p = cl.ports.get(T.key);
      return { inner: p.inner, outer: p.outer, nx: p.nx, ny: p.ny, site: S, part: p.part, rect: p.rect, room: p.room, junction: false };
    }
    const dx = T.x - S.x, dy = T.y - S.y, L = Math.sqrt(dx * dx + dy * dy) || 1;
    const hub = W.hub(S);
    let pt = { x: S.x, y: S.y };
    if (hub && hub.type === 'ring') pt = { x: S.x + (dx / L) * hub.r, y: S.y + (dy / L) * hub.r };
    return { inner: pt, outer: pt, nx: dx / L, ny: dy / L, site: S, part: -1, rect: -1, room: -1, junction: true };
  }

  // ------------------------------------------------------------ path styles
  function curve(P0, P1, ea, eb, len, rng) {
    const k = len * rng.range(0.25, 0.45);
    const c1 = { x: P0.x + ea.nx * k, y: P0.y + ea.ny * k };
    const c2 = { x: P1.x + eb.nx * k, y: P1.y + eb.ny * k };
    const n = Math.round(clamp(len / 3, 6, 28)), out = [];
    for (let i = 1; i < n; i++) {
      const t = i / n, m = 1 - t;
      const a = m * m * m, b = 3 * m * m * t, c = 3 * m * t * t, d = t * t * t;
      out.push({ x: a * P0.x + b * c1.x + c * c2.x + d * P1.x, y: a * P0.y + b * c1.y + c * c2.y + d * P1.y });
    }
    return out;
  }

  /** L or Z bend aligned to an axis frame (u1 = first leg direction). */
  function dogleg(P0, P1, u1x, u1y, zfrac) {
    const dx = P1.x - P0.x, dy = P1.y - P0.y;
    const a = dx * u1x + dy * u1y;                 // along u1
    if (a < 4) return null;
    const u2x = -u1y, u2y = u1x, b = dx * u2x + dy * u2y;
    if (Math.abs(b) < 3) return null;
    if (!zfrac) return [{ x: P0.x + u1x * a, y: P0.y + u1y * a }];
    const f = a * zfrac;
    return [{ x: P0.x + u1x * f, y: P0.y + u1y * f }, { x: P0.x + u1x * f + u2x * b, y: P0.y + u1y * f + u2y * b }];
  }

  /** One or two gentle kinks, bending consistently to one side (no zigzags). */
  function wander(P0, P1, len, rng) {
    const n = rng.int(1, 2), out = [];
    const dx = (P1.x - P0.x) / len, dy = (P1.y - P0.y) / len;
    const side = rng.f() < 0.5 ? -1 : 1;
    for (let i = 1; i <= n; i++) {
      const t = i / (n + 1) + rng.range(-0.08, 0.08), off = side * rng.range(0.04, 0.14) * len;
      out.push({ x: P0.x + (P1.x - P0.x) * t - dy * off, y: P0.y + (P1.y - P0.y) * t + dx * off });
    }
    return out;
  }

  // ------------------------------------------------------------- validation
  function nearbyClusterSites(W, pts, pad) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    const C = BR.CFG.cell, m = BR.CFG.maxReach + pad;
    const out = [];
    for (let i = Math.floor((x0 - m) / C); i <= Math.floor((x1 + m) / C); i++)
      for (let j = Math.floor((y0 - m) / C); j <= Math.floor((y1 + m) / C); j++) {
        const s = W.site(i, j);
        if (s.kind === 'cluster' && !BR.isAbsorbed(W, s)) out.push(s);
      }
    return out;
  }

  /** True if the polyline (world) stays clear of every cluster's rects (except the port rects, unless strict). */
  function pathClear(W, pts, w, ea, eb, strict) {
    const m = w / 2 + 0.3;
    for (const S of nearbyClusterSites(W, pts, 4)) {
      const cl = W.cluster(S);
      // quick reject on the cluster's bounding circle
      let near = false;
      const lim = (cl.bound + m) * (cl.bound + m);
      for (let k = 0; k + 1 < pts.length && !near; k++)
        if (BR.distSegSq(S.x, S.y, pts[k].x, pts[k].y, pts[k + 1].x, pts[k + 1].y) < lim) near = true;
      if (!near) continue;
      const c = S.rot.c, s = S.rot.s;
      const loc = pts.map((p) => {
        const dx = p.x - S.x, dy = p.y - S.y;
        return [c * dx + s * dy, -s * dx + c * dy];
      });
      const own = strict ? null : S.key === ea.site.key ? ea : S.key === eb.site.key ? eb : null;
      for (let pi = 0; pi < cl.parts.length; pi++) {
        const P = cl.parts[pi];
        const pl = loc.map(([x, y]) => {
          const dx = x - P.ox, dy = y - P.oy;
          return [P.c * dx + P.s * dy, -P.s * dx + P.c * dy];
        });
        for (let r = 0; r < P.rects.length; r++) {
          if (own && own.part === pi && own.rect === r) continue;
          const R = P.rects[r];
          for (let k = 0; k + 1 < pl.length; k++)
            if (segHitsRect(pl[k][0], pl[k][1], pl[k + 1][0], pl[k + 1][1], R.x0 - m, R.y0 - m, R.x1 + m, R.y1 + m)) return false;
        }
      }
    }
    return true;
  }

  /**
   * Rooms strung along a corridor path. Each room is a rectangle aligned with
   * the path segment under its centre, offset sideways a little, with door gaps
   * in its end walls where the corridor passes; rooms touch or are joined by
   * short necks, and sometimes get a side room. Anything that would overlap a
   * cluster is skipped (the bare corridor shows through instead).
   */
  function roomsAlong(W, pts, w, rng, ea, eb, mode, count) {
    const polys = [], walls = [];
    const seg = [];
    let total = 0;
    for (let k = 0; k + 1 < pts.length; k++) {
      const ex = pts[k + 1].x - pts[k].x, ey = pts[k + 1].y - pts[k].y, l = Math.sqrt(ex * ex + ey * ey);
      seg.push({ a: pts[k], ux: l ? ex / l : 1, uy: l ? ey / l : 0, l, t0: total });
      total += l;
    }
    const at = (t) => {
      let k = 0;
      while (k < seg.length - 1 && t > seg[k].t0 + seg[k].l) k++;
      const S = seg[k], d = t - S.t0;
      return { x: S.a.x + S.ux * d, y: S.a.y + S.uy * d, ux: S.ux, uy: S.uy };
    };
    const t0 = ea.junction ? 3.5 : 4.5, t1 = total - (eb.junction ? 3.5 : 4.5);
    if (t1 - t0 < 6) return { polys, walls };
    const toW = (P, x, y) => ({ x: P.cx + P.ux * x - P.uy * y, y: P.cy + P.uy * x + P.ux * y });
    const wall = (P, x0, y0, x1, y1) => { const a = toW(P, x0, y0), b = toW(P, x1, y1); walls.push(a.x, a.y, b.x, b.y); };
    const tryRoom = (P, x0, y0, x1, y1) => {
      const poly = [toW(P, x0, y0), toW(P, x1, y0), toW(P, x1, y1), toW(P, x0, y1)];
      if (!pathClear(W, [...poly, poly[0]], 0.5, ea, eb, true)) return false;
      polys.push(poly);
      return true;
    };
    const slots = [];
    if (count === 2) slots.push(t0 + (t1 - t0) * rng.range(0.2, 0.35), t0 + (t1 - t0) * rng.range(0.6, 0.75));
    else slots.push(t0 + (t1 - t0) * rng.range(0.3, 0.6));
    let t = slots.shift();
    const g = w + 0.35;
    for (let guard = 0; guard < 40 && t < t1 - 2.5; guard++) {
      const u = rng.f(), v = rng.f();
      let len = mode === 'single' ? 5 + 8 * u : 6 + 14 * u * u;
      if (t + len > t1) len = t1 - t;
      if (len < 3) break;
      const c = at(t + len / 2);
      const wid = mode === 'single' ? w + rng.range(3, 9) : Math.max(w + 2.5, 5 + 12 * v * v);
      const off = rng.range(-1, 1) * Math.max(0, (wid - w) / 2 - 0.6);
      const P = { cx: c.x - c.uy * off, cy: c.y + c.ux * off, ux: c.ux, uy: c.uy };
      const hl = len / 2, hw = wid / 2;
      if (tryRoom(P, -hl, -hw, hl, hw)) {
        // end walls with a gap where the corridor runs through (at local y = -off)
        for (const x of [-hl, hl]) { wall(P, x, -hw, x, -off - g / 2); wall(P, x, -off + g / 2, x, hw); }
        if (rng.f() < 0.2 && len > 4.5) {                  // side room
          const side = rng.f() < 0.5 ? -1 : 1, sl = rng.range(3, Math.min(8, len - 0.5)), sw = rng.range(3, 6.5);
          const sx = rng.range(-hl + sl / 2, hl - sl / 2), d = Math.min(1.6, sl - 1.2);
          const y0 = side > 0 ? hw : -hw - sw, y1 = side > 0 ? hw + sw : -hw;
          if (tryRoom(P, sx - sl / 2, y0, sx + sl / 2, y1)) {
            const ye = side > 0 ? hw : -hw;
            wall(P, sx - sl / 2, ye, sx - d / 2, ye); wall(P, sx + d / 2, ye, sx + sl / 2, ye);
          }
        }
      }
      if (mode === 'single') { if (!slots.length) break; t = Math.max(slots.shift(), t + len + 2); continue; }
      t += len + (rng.f() < 0.7 ? 0 : rng.range(1, 4));
    }
    return { polys, walls };
  }

  /** No hairpins: every turn along the path is gentler than ~110 degrees. */
  function gentle(pts) {
    let px = null, py = null;
    for (let k = 0; k + 1 < pts.length; k++) {
      const dx = pts[k + 1].x - pts[k].x, dy = pts[k + 1].y - pts[k].y;
      const L = Math.sqrt(dx * dx + dy * dy);
      if (L < 1e-6) continue;
      const ux = dx / L, uy = dy / L;
      if (px !== null && px * ux + py * uy < -0.34) return false;
      px = ux; py = uy;
    }
    return true;
  }

  // ------------------------------------------------------------------- doors
  /** World-space quads of every rect of a cluster (cached on the cluster). */
  function clusterQuads(cl) {
    if (cl._wq) return cl._wq;
    const S = cl.site, out = [];
    cl.parts.forEach((p, pi) => {
      const c = S.rot.c * p.c - S.rot.s * p.s, s = S.rot.s * p.c + S.rot.c * p.s;
      const ox = S.x + S.rot.c * p.ox - S.rot.s * p.oy, oy = S.y + S.rot.s * p.ox + S.rot.c * p.oy;
      p.rects.forEach((r, ri) => {
        const hx = (r.x1 - r.x0) / 2, hy = (r.y1 - r.y0) / 2, mx = (r.x0 + r.x1) / 2, my = (r.y0 + r.y1) / 2;
        out.push({ pi, ri, r, c, s, ox, oy, cx: ox + c * mx - s * my, cy: oy + s * mx + c * my, rad: Math.sqrt(hx * hx + hy * hy) });
      });
    });
    cl._wq = out;
    return out;
  }
  function qLocal(Q, x, y) { const dx = x - Q.ox, dy = y - Q.oy; return [Q.c * dx + Q.s * dy, -Q.s * dx + Q.c * dy]; }
  function qInside(Q, x, y, m) {
    const ex = x - Q.cx, ey = y - Q.cy;
    if (ex * ex + ey * ey > (Q.rad + m) * (Q.rad + m)) return false;
    const [lx, ly] = qLocal(Q, x, y), r = Q.r;
    return lx > r.x0 - m && lx < r.x1 + m && ly > r.y0 - m && ly < r.y1 + m;
  }
  /** Ray p + t n (world) against a rect: entry distance and where along the entered face. */
  function qRay(Q, px, py, nx, ny, tmax) {
    const [lx, ly] = qLocal(Q, px, py), r = Q.r;
    const dx = Q.c * nx + Q.s * ny, dy = -Q.s * nx + Q.c * ny;
    let t0 = -Infinity, t1 = Infinity, axis = -1;
    if (Math.abs(dx) < 1e-9) { if (lx <= r.x0 || lx >= r.x1) return null; }
    else { let a = (r.x0 - lx) / dx, b = (r.x1 - lx) / dx; if (a > b) { const t = a; a = b; b = t; } if (a > t0) { t0 = a; axis = 0; } t1 = Math.min(t1, b); }
    if (Math.abs(dy) < 1e-9) { if (ly <= r.y0 || ly >= r.y1) return null; }
    else { let a = (r.y0 - ly) / dy, b = (r.y1 - ly) / dy; if (a > b) { const t = a; a = b; b = t; } if (a > t0) { t0 = a; axis = 1; } t1 = Math.min(t1, b); }
    if (t0 > t1 || t1 <= 0 || t0 > tmax) return null;
    if (t0 <= 0) return { t: 0, ok: true };                 // starts inside: rooms overlap, open seam
    const hx = lx + dx * t0, hy = ly + dy * t0;
    const along = axis === 0 ? hy : hx, lo = axis === 0 ? r.y0 : r.x0, hi = axis === 0 ? r.y1 : r.x1;
    return { t: t0, ok: along > lo + 1.1 && along < hi - 1.1 };   // not right at a corner
  }

  const SIDES4 = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  const NOEND = { site: { key: '' }, part: -1, rect: -1 };

  /** Outside wall segments of a cluster's rects whose normal faces (dx,dy). */
  function facingEdges(Qs, dx, dy, nearFn) {
    const out = [];
    for (const Q of Qs) {
      if (!nearFn(Q)) continue;
      const r = Q.r;
      for (let sd = 0; sd < 4; sd++) {
        const [sx, sy] = SIDES4[sd];
        const nx = Q.c * sx - Q.s * sy, ny = Q.s * sx + Q.c * sy;
        if (nx * dx + ny * dy < 0.1) continue;
        const lo = sx ? r.y0 : r.x0, hi = sx ? r.y1 : r.x1, face = sx > 0 ? r.x1 : sx < 0 ? r.x0 : sy > 0 ? r.y1 : r.y0;
        const ax = sx ? face : lo, ay = sx ? lo : face, bx = sx ? face : hi, by = sx ? hi : face;
        out.push({
          Q, nx, ny, len: hi - lo,
          x0: Q.ox + Q.c * ax - Q.s * ay, y0: Q.oy + Q.s * ax + Q.c * ay,
          x1: Q.ox + Q.c * bx - Q.s * by, y1: Q.oy + Q.s * bx + Q.c * by
        });
      }
    }
    return out;
  }

  /**
   * Doors between two fused clusters: sample points along A's outside walls
   * facing B, find the nearest point on a B wall facing back, and keep short,
   * straight-across links (a doorway through a thick wall, or a short passage
   * across a slit, at most ~6 units). One door, sometimes two far apart. Null if
   * the buildings never face each other closely enough.
   */
  function roomAtW(cl, Q, x, y) {
    const [lx, ly] = qLocal(Q, x, y);
    return BR.roomAt(cl.parts[Q.pi], Q.ri, lx, ly);
  }

  /**
   * Connection between two fused clusters without a corridor. Sample points
   * along A's outside walls facing B and find the nearest wall of B straight
   * across. Both sides must open onto floor (not a solid or shelf).
   *   pass 1: up to 14 units - a doorway through a shared wall (<= 4) or a
   *           short passage across a slit
   *   pass 2: up to 30 units, a little more slanted - a LINK ROOM (a wide,
   *           room-like passage) bridging the gap
   * Null if neither works; the caller then falls back to a corridor.
   */
  function buildDoors(W, A, B) {
    const ca = W.cluster(A), cb = W.cluster(B);
    if (!ca || !cb) return null;
    const rng = new Rng(BR.pairHash(A, B, BR.SALT.DOOR));
    const QA = clusterQuads(ca), QB = clusterQuads(cb);
    const ux = B.x - A.x, uy = B.y - A.y, L = Math.sqrt(ux * ux + uy * uy), dx = ux / L, dy = uy / L;
    const M2 = 1.1;
    const outside = (Qs, self, x, y) => { for (const O of Qs) if (O !== self && qInside(O, x, y, 0)) return false; return true; };
    const blocked = (Qs, skip, px, py, vx, vy, d) => {
      for (const O of Qs) {
        if (O === skip) continue;
        const h = qRay(O, px + vx * 0.05, py + vy * 0.05, vx, vy, d - 0.1);
        if (h && h.t < d - 0.1) return true;
      }
      return false;
    };
    const search = (MAXT, kStraight, clearW) => {
      const near = (Q, others) => others.some((P) => {
        const ex = P.cx - Q.cx, ey = P.cy - Q.cy, rr = P.rad + Q.rad + MAXT + 1;
        return ex * ex + ey * ey < rr * rr;
      });
      const EA = facingEdges(QA, dx, dy, (Q) => near(Q, QB));
      if (!EA.length) return [];
      const EB = facingEdges(QB, -dx, -dy, (Q) => near(Q, QA));
      if (!EB.length) return [];
      const cands = [];
      for (const e of EA) {
        const ex = e.x1 - e.x0, ey = e.y1 - e.y0;
        for (let t = M2 + 0.2; t <= e.len - M2 - 0.2; t += 1.5) {
          const f = t / e.len, px = e.x0 + ex * f, py = e.y0 + ey * f;
          if (!outside(QA, e.Q, px + e.nx * 0.4, py + e.ny * 0.4)) continue;
          let best = null;
          for (const g of EB) {
            if (g.nx * e.nx + g.ny * e.ny > -0.5) continue;              // must face back
            const gx = g.x1 - g.x0, gy = g.y1 - g.y0;
            const u = ((px - g.x0) * gx + (py - g.y0) * gy) / (g.len * g.len);
            if (u * g.len < M2 || (1 - u) * g.len < M2) continue;        // not at a corner
            const qx = g.x0 + gx * u, qy = g.y0 + gy * u;
            const vx0 = qx - px, vy0 = qy - py, d = Math.sqrt(vx0 * vx0 + vy0 * vy0);
            if (d > MAXT || (best && d >= best.d)) continue;
            let vx = e.nx, vy = e.ny;
            if (d > 0.05) {
              vx = vx0 / d; vy = vy0 / d;
              const k = d > 6 ? kStraight : 0.8;                           // straight across
              if (vx * e.nx + vy * e.ny < k || -(vx * g.nx + vy * g.ny) < k) continue;
            }
            best = { g, qx, qy, d, vx, vy };
          }
          if (!best) continue;
          if (!outside(QB, best.g.Q, best.qx + best.g.nx * 0.4, best.qy + best.g.ny * 0.4)) continue;
          if (best.d > 0.1 && (blocked(QA, e.Q, px, py, best.vx, best.vy, best.d) || blocked(QB, best.g.Q, px, py, best.vx, best.vy, best.d))) continue;
          const ra = roomAtW(ca, e.Q, px - best.vx * 0.6, py - best.vy * 0.6);
          const rb = ra < 0 ? -1 : roomAtW(cb, best.g.Q, best.qx + best.vx * 0.6, best.qy + best.vy * 0.6);
          if (rb < 0) continue;
          // the passage's middle (clear of both walls by its own margin) must not touch any building
          const mg = clearW / 2 + 0.5;
          if (best.d > 2 * mg + 0.4 && !pathClear(W, [{ x: px + best.vx * mg, y: py + best.vy * mg }, { x: best.qx - best.vx * mg, y: best.qy - best.vy * mg }], clearW, NOEND, NOEND, true)) continue;
          const lat = Math.abs((px - A.x) * dy - (py - A.y) * dx);
          cands.push({ px, py, qx: best.qx, qy: best.qy, vx: best.vx, vy: best.vy, d: best.d, pa: e.Q.pi, ra, pb: best.g.Q.pi, rb, score: best.d + 0.04 * lat + rng.f() * 1.2 });
        }
      }
      return cands;
    };
    let kind = 'door', w, cands = search(14, 0.9, 2.2);
    if (cands.length) {
      cands.sort((a, b) => a.score - b.score);
      // a doorway through a thick wall, or a short passage across a slit
      w = cands[0].d > 4 ? BR.corridorWidth(A, B) : rng.range(1.3, 2.0);
      if (cands[0].d > 4) kind = 'passage';
    } else {
      const wl = rng.range(3.5, 7);
      cands = search(30, 0.75, wl + 0.6);
      if (!cands.length) return null;
      cands.sort((a, b) => a.score - b.score);
      kind = 'link'; w = wl;
    }
    const picks = [cands[0]];
    if (kind !== 'link' && cands.length > 6 && rng.f() < 0.4) {
      for (const c of cands) {
        const ex = c.px - cands[0].px, ey = c.py - cands[0].py;
        if (ex * ex + ey * ey > 100) { picks.push(c); break; }
      }
    }
    // butt-capped: run each passage far enough into both buildings to hide its ends
    const ext = 0.9 + (kind === 'link' ? w / 2 : 0.3);
    const paths = picks.map((c) => [
      [c.px - c.vx * ext - A.x, c.py - c.vy * ext - A.y],
      [c.qx + c.vx * ext - A.x, c.qy + c.vy * ext - A.y]
    ]);
    const conns = picks.map((c) => [{ key: A.key, part: c.pa, room: c.ra }, { key: B.key, part: c.pb, room: c.rb }]);
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (const pth of paths) for (const [x, y] of pth) {
      bx0 = Math.min(bx0, x + A.x); by0 = Math.min(by0, y + A.y); bx1 = Math.max(bx1, x + A.x); by1 = Math.max(by1, y + A.y);
    }
    return {
      a: A, b: B, w, clear: true, kind,
      ax: A.x, ay: A.y, paths, conns, polys: [], walls: [],
      rgb: A.dom >= B.dom ? A.rgb : B.rgb,
      bbox: [bx0 - w - 2, by0 - w - 2, bx1 + w + 2, by1 + w + 2],
      render: null
    };
  }

  function endRef(e) { return e.junction ? { key: e.site.key, hub: true } : { key: e.site.key, part: e.part, room: e.room }; }

  // ------------------------------------------------------------------ build
  function buildCorridor(W, A, B) {
    if (BR.isFused(A, B)) {
      const d = buildDoors(W, A, B);
      if (d) return d;
    }
    const rng = new Rng(BR.pairHash(A, B, BR.SALT.CORR));
    const w = BR.corridorWidth(A, B);
    const ea = endpoint(W, A, B), eb = endpoint(W, B, A);
    const P0 = ea.outer, P1 = eb.outer;
    const dx = P1.x - P0.x, dy = P1.y - P0.y, len = Math.sqrt(dx * dx + dy * dy);

    // frame for doglegs: the grid of whichever end is a cluster
    let fx = dx / (len || 1), fy = dy / (len || 1);
    if (!ea.junction) { fx = ea.nx; fy = ea.ny; }
    else if (!eb.junction) { fx = -eb.nx; fy = -eb.ny; }
    else { const r = rotation(rng.int(0, ROTS.length - 1), 0); const a = fx * r.c + fy * r.s; fx = r.c * (a < 0 ? -1 : 1); fy = r.s * (a < 0 ? -1 : 1); }

    const u = rng.f(), cands = [];
    if (len > 9) {
      // mostly straight or one bend; curves and wanders are rare accents
      if (u < 0.08) cands.push(curve(P0, P1, ea, eb, len, rng));
      else if (u < 0.32) cands.push(dogleg(P0, P1, fx, fy, rng.f() < 0.6 ? 0 : rng.range(0.3, 0.7)));
      else if (u < 0.36) cands.push(wander(P0, P1, len, rng));
    }
    cands.push([]);
    cands.push(dogleg(P0, P1, fx, fy, 0));
    cands.push(dogleg(P0, P1, fx, fy, 0.5));
    let mid = [], clear = false;
    for (const c of cands) {
      if (!c) continue;
      if (!gentle([ea.inner, P0, ...c, P1, eb.inner])) continue;
      if (pathClear(W, [P0, ...c, P1], w, ea, eb)) { mid = c; clear = true; break; }
    }

    // assemble, dropping duplicate points
    const raw = [ea.inner, ea.outer, ...mid, eb.outer, eb.inner], pts = [];
    for (const p of raw) {
      const q = pts[pts.length - 1];
      if (!q || Math.abs(q.x - p.x) + Math.abs(q.y - p.y) > 1e-6) pts.push(p);
    }
    // If the path doubles back right at a door stub, drop the stub and leave the
    // wall at an angle instead (avoids sliver spikes beside the building).
    const turn = (a, b, c) => {
      const ux = b.x - a.x, uy = b.y - a.y, vx = c.x - b.x, vy = c.y - b.y;
      const l = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy));
      return l > 0 ? (ux * vx + uy * vy) / l : 1;
    };
    if (pts.length >= 3 && !ea.junction && turn(pts[0], pts[1], pts[2]) < -0.2) pts.splice(1, 1);
    const n = pts.length;
    if (n >= 3 && !eb.junction && turn(pts[n - 3], pts[n - 2], pts[n - 1]) < -0.2) pts.splice(n - 2, 1);
    if (pts.length === 1) pts.push({ x: pts[0].x + 0.01, y: pts[0].y });

    // A long walk passes through something: one room on long corridors, two on
    // very long ones (no bead-chains - those read as procedural).
    const along = len > 30 && rng.f() < 0.35 ? 'single' : null;
    const { polys, walls } = along ? roomsAlong(W, pts, w, rng, ea, eb, along, len > 70 ? 2 : 1) : { polys: [], walls: [] };

    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (const p of pts.concat(...polys)) { bx0 = Math.min(bx0, p.x); by0 = Math.min(by0, p.y); bx1 = Math.max(bx1, p.x); by1 = Math.max(by1, p.y); }
    const pad = w + 1;
    return {
      a: A, b: B, w, clear, kind: 'corridor',
      conns: [[endRef(ea), endRef(eb)]],
      ax: A.x, ay: A.y,                                  // anchor (keeps canvas coords small)
      paths: [pts.map((p) => [p.x - A.x, p.y - A.y])],
      polys: polys.map((pl) => pl.map((p) => [p.x - A.x, p.y - A.y])),
      walls: walls.map((v, k) => v - (k & 1 ? A.y : A.x)),
      rgb: A.dom >= B.dom ? A.rgb : B.rgb,
      bbox: [bx0 - pad, by0 - pad, bx1 + pad, by1 + pad],
      render: null
    };
  }

  BR.buildCorridor = buildCorridor;
  BR.buildHub = buildHub;
})(typeof window !== 'undefined' ? window : globalThis);
