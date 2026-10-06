/*
 * interior.js - level 3: the rooms inside one territory.
 *
 *   1. obligations - selected district routes are realized first where the
 *                    area has a district structure plan
 *   2. local plan  - residual floor is divided into bounded access catchments,
 *                    local circulation and geometry-validated parcels
 *   3. blocks      - areas without district structure use their existing
 *                    irregular/hall/house/utility grammar
 *   4. zones       - semantic archetypes are selected only after geometry and
 *                    access are known; incompatible dense types are rejected
 *   5. connect     - shared walls between blocks: some open up, then a random
 *                  spanning tree of doors (circulation first) plus loops.
 *                  Doors are only placed where both sides are floor.
 *
 * The result lists rooms (graph nodes), links (graph edges inside the
 * territory) and drawing primitives, all in world coordinates.
 */
(function (root) {
  'use strict';
  const BR = root.BR;
  const { Rng, hash4, makeUF, clamp } = BR;

  const ROOM = 0, HALL = 1, BLOCK = 4, SERVICE = 5;
  const S = { INT: 0x201, LMK: 0x202 };

  function makeStyle(A, rng, dna) {
    const mid = (v, d) => (Array.isArray(v) ? (v[0] + v[1]) / 2 : v !== undefined ? v : d);
    const inherited = (spec, d, mul, jitter) => {
      let v = mid(spec, d) * (mul === undefined ? 1 : mul) * rng.range(1 - jitter, 1 + jitter);
      if (Array.isArray(spec)) v = clamp(v, spec[0], spec[1]);
      return v;
    };
    const st = {
      dna,
      zones: dna && Object.keys(dna.zoneWeights).length ? dna.zoneWeights : (A.zones || {}),
      roomScale: inherited(A.roomScale, 1, dna ? dna.roomScale : 1, 0.04),
      pillars: inherited(A.pillars, 0.5, dna ? dna.pillarDensity : 1, 0.05),
      hallW: dna ? dna.corridorWidth : (rng.f() < 0.75 ? 2 : 3),
      pOpen: inherited(A.pOpen, 0.2, dna ? dna.openness : 1, 0.06),
      pLoop: inherited(A.pLoop, 0.25, dna ? dna.loopiness : 1, 0.06),
      pWide: inherited(A.pWide, 0.15, dna ? dna.wideness : 1, 0.06),
      doorW: rng.range(1.2, 1.8), pStub: rng.range(0.15, 0.5), pBspCorr: rng.range(0.05, 0.35)
    };
    const ra = rng.f();
    st.roomArea = (40 + 180 * ra * ra) * st.roomScale * st.roomScale;
    return st;
  }

  const blk = (q, k, zt) => ({ x0: q[0], y0: q[1], x1: q[2], y1: q[3], k, zt: zt || null, z: -1 });
  const dims = (q) => [q[2] - q[0], q[3] - q[1]];

  /** Random guillotine cuts down to ~target area, sides >= minSide. */
  function guillotine(q, rng, target, minSide, out, depth) {
    const [w, h] = dims(q), A = w * h;
    const canX = w >= 2 * minSide, canY = h >= 2 * minSide;
    if (depth > 8 || (!canX && !canY) || A < target * (0.6 + 0.8 * rng.f())) { out.push(q); return; }
    const alongX = canX && (!canY || (w > h ? rng.f() < 0.8 : rng.f() < 0.2));
    const L = alongX ? w : h, t = minSide + Math.round((L - 2 * minSide) * rng.f());
    if (alongX) { guillotine([q[0], q[1], q[0] + t, q[3]], rng, target, minSide, out, depth + 1); guillotine([q[0] + t, q[1], q[2], q[3]], rng, target, minSide, out, depth + 1); }
    else { guillotine([q[0], q[1], q[2], q[1] + t], rng, target, minSide, out, depth + 1); guillotine([q[0], q[1] + t, q[2], q[3]], rng, target, minSide, out, depth + 1); }
  }

  /** (u, v) frame over rect q: u along the long side. */
  function uvFrame(q) {
    const [w, h] = dims(q), horiz = w >= h;
    return {
      horiz, U: horiz ? w : h, V: horiz ? h : w,
      R: (u0, v0, u1, v1) => (horiz ? [q[0] + u0, q[1] + v0, q[0] + u1, q[1] + v1] : [q[0] + v0, q[1] + u0, q[0] + v1, q[1] + u1])
    };
  }

  /** Frame pinned to a world axis. DNA uses this so adjacent territories can
   * continue the same architectural orientation instead of each selecting its
   * own long side independently. */
  function axisFrame(q, axis) {
    const w = q[2] - q[0], h = q[3] - q[1], horiz = axis !== 'y';
    return {
      horiz, U: horiz ? w : h, V: horiz ? h : w,
      R: (u0, v0, u1, v1) => (horiz ? [q[0] + u0, q[1] + v0, q[0] + u1, q[1] + v1] : [q[0] + v0, q[1] + u0, q[0] + v1, q[1] + u1])
    };
  }

  function preferredFrame(q, axis, minU, minV) {
    if (!axis) return uvFrame(q);
    const F = axisFrame(q, axis);
    return F.U >= minU && F.V >= minV ? F : uvFrame(q);
  }

  /** Pick the nearest district-global line that can fit inside [lo,hi]. */
  function alignedOffset(world0, lo, hi, spacing, phase) {
    if (!(spacing > 0) || hi < lo) return null;
    const target = world0 + (lo + hi) / 2;
    const k0 = Math.round((target - phase) / spacing);
    let best = null, bd = Infinity;
    for (let dk = -2; dk <= 2; dk++) {
      const local = phase + (k0 + dk) * spacing - world0;
      if (local < lo || local > hi) continue;
      const d = Math.abs(local - (lo + hi) / 2);
      if (d < bd) { bd = d; best = Math.round(local); }
    }
    return best;
  }

  /** Stable identity for a circulation line shared by multiple territories. */
  function flowContract(dna, kind, axis, start, width) {
    return {
      key: dna.key + '|' + kind + '|' + axis + '|' + start + '|' + width,
      dna: dna.key, kind, axis, start, width
    };
  }


  const flowFromObligation = (dna, o, status) => ({
    key: o.routeId, dna: dna.key, kind: o.hierarchy, axis: o.axis, start: o.line, width: o.width, status
  });

  function realizeObligation(q, o, dna) {
    const half=o.width/2,perp0=o.axis==='x'?q[1]:q[0],perp1=o.axis==='x'?q[3]:q[2];
    const along0=o.axis==='x'?q[0]:q[1],along1=o.axis==='x'?q[2]:q[3];
    const a=Math.max(o.s0,along0),b=Math.min(o.s1,along1);
    const R={routeId:o.routeId,hierarchy:o.hierarchy,role:o.role,axis:o.axis,line:o.line,width:o.width,s0:a,s1:b,status:'failed',reason:null,shift:0,rects:[],flow:null};
    if(b-a<0.75){R.reason='too-short';return R;}
    const rect=(s0,p0,s1,p1)=>o.axis==='x'?[s0,p0,s1,p1]:[p0,s0,p1,s1];
    if(o.line-half>=perp0&&o.line+half<=perp1){R.status='exact';R.rects=[rect(a,o.line-half,b,o.line+half)];R.flow=flowFromObligation(dna,o,'exact');return R;}
    const avail0=Math.max(perp0,o.line-half),avail1=Math.min(perp1,o.line+half);
    if(avail1-avail0<1||perp1-perp0<o.width){R.reason='insufficient-width';return R;}
    const shifted=Math.max(perp0+half,Math.min(perp1-half,o.line)),delta=shifted-o.line;
    if(Math.abs(delta)>Math.max(6,o.width*2.5)){R.reason='shift-too-large';return R;}
    const L=b-a,turn=Math.min(Math.max(3,o.width*1.5),L/3);
    if(L<turn*1.5){R.reason='no-turn-room';return R;}
    const pieces=[];let m0=a,m1=b;
    if(o.enters){const e=Math.min(b,a+turn),n0=avail0,n1=avail1;pieces.push(rect(a,n0,e,n1));
      const c0=Math.min(o.line,shifted)-half,c1=Math.max(o.line,shifted)+half;
      pieces.push(rect(Math.max(a,e-o.width),Math.max(perp0,c0),e,Math.min(perp1,c1)));m0=e-o.width/2;}
    if(o.exits){const e=Math.max(a,b-turn),n0=avail0,n1=avail1;pieces.push(rect(e,n0,b,n1));
      const c0=Math.min(o.line,shifted)-half,c1=Math.max(o.line,shifted)+half;
      pieces.push(rect(e,Math.max(perp0,c0),Math.min(b,e+o.width),Math.min(perp1,c1)));m1=e+o.width/2;}
    if(m1>m0)pieces.push(rect(m0,shifted-half,m1,shifted+half));
    R.status='adapted';R.shift=delta;R.rects=pieces;R.flow=flowFromObligation(dna,o,'adapted');return R;
  }

  function plannedBlocks(q, obligations, anchors, rng, st, area, out, realizations, spacePlans, planKey, program) {
    const outStart=out.length;
    const realized=[];
    for(const o of obligations){
      const r=realizeObligation(q,o,st.dna);
      realizations.push(r);
      if(r.status!=='failed')realized.push(r);
    }

    // Major routes are already decided at district scope. Local space planning
    // now determines how the residual floor is served and parcelled before any
    // semantic room/zone generator is selected.
    const P=BR.planLocalSpace(q,realized,area,st.dna,planKey);
    spacePlans.push(P);

    const roleFor=(q2)=>program?BR.programRoleAt(program,(q2[0]+q2[2])/2,(q2[1]+q2[3])/2):null;
    for(const r of P.districtRoutes){
      const b=blk(r.q,r.hierarchy==='service'?SERVICE:HALL);
      b.flow=r.flow||null;b.flows=(r.flows||[]).slice();b.routeHierarchy=r.hierarchy;
      b.realization=r.realization;b.routeId=r.routeId;b.programRole=roleFor(r.q);out.push(b);
    }
    for(const r of P.localRoutes){
      const b=blk(r.q,HALL);
      b.routeHierarchy='local';b.realization='local';b.routeId=r.routeId;b.localRoute=true;b.programRole=roleFor(r.q);
      out.push(b);
    }
    for(const p of P.parcels){
      const b=blk(p.q,BLOCK),role=roleFor(p.q);
      b.programRole=role;
      b.space=Object.assign({id:p.id,area,programRole:role},p.meta);
      b.front=b.space.frontSide||null;
      out.push(b);
    }

    // Special-space anchors attach to suitable parcels after access/catchment
    // planning, so they cannot erase required circulation.
    for(const a of anchors){
      let best=null,bd=Infinity;
      for(let bi=outStart;bi<out.length;bi++){
        const b=out[bi];
        if(b.k===HALL||b.k===SERVICE||!b.space||b.anchor)continue;
        const cx=(b.x0+b.x1)/2,cy=(b.y0+b.y1)/2,d=(cx-a.x)**2+(cy-a.y)**2;
        if(d<bd&&Math.min(b.x1-b.x0,b.y1-b.y0)>=4&&(b.x1-b.x0)*(b.y1-b.y0)>=24){bd=d;best=b;}
      }
      if(best){best.zt=a.zone;best.anchor=a.id;best.anchorKind=a.kind;}
    }
  }

  /** Cut [0,U) into chunks of length in [a,b] (last chunk absorbs a short remainder). */
  function chunks(U, rng, a, b) {
    const out = [];
    for (let u = 0; u < U;) {
      let L = rng.int(a, b);
      if (U - u - L < a) L = U - u;
      out.push([u, u + L]); u += L;
    }
    return out;
  }

  // ---------------------------------------------------------------- styles
  const LAY = {};

  LAY.irregular = (q, rng, st, A, out) => {
    const mode = rng.weighted({ hall: 1.6, few: 2.2, many: 0.7 });
    const target = mode === 'hall' ? 1e9 : mode === 'few' ? rng.range(260, 700) : rng.range(110, 260);
    const leaves = [];
    guillotine(q, rng, target, 7, leaves, 0);
    for (const l of leaves) {
      const [w, h] = dims(l), a = w * h;
      out.push(blk(l, a >= 45 && !(a < 120 && rng.f() < 0.35) ? BLOCK : ROOM));
    }
  };

  /** Corridor spine with blocks either side; optional cross corridor. */
  function spine(q, rng, st, A, out, o) {
    const cw = o.cw || rng.int(2, 3);
    const F = preferredFrame(q, o.axis, 14, o.depthMin + cw), U = F.U, V = F.V, dm = o.depthMin;
    if (U < 14 || V < dm + cw) { out.push(blk(q, BLOCK)); return; }
    const perp0 = F.horiz ? q[1] : q[0];
    let v0, mainAligned = false;
    if (V >= 2 * dm + cw) {
      if (o.align) {
        v0 = alignedOffset(perp0, dm, V - dm - cw, o.spineSpacing, o.spinePhase);
        mainAligned = v0 !== null;
      } else v0 = null;
      if (v0 === null) v0 = dm + Math.round((V - 2 * dm - cw) * rng.range(0.25, 0.75));
    } else v0 = rng.f() < 0.5 ? 0 : V - cw;
    const main = blk(F.R(0, v0, U, v0 + cw), HALL);
    if (mainAligned && st.dna) main.flow = flowContract(st.dna, 'spine', F.horiz ? 'x' : 'y', perp0 + v0, cw);
    out.push(main);

    let cross = -1, crossAligned = false;
    const along0 = F.horiz ? q[0] : q[1];
    if (U >= 46 && rng.f() < (o.crossChance === undefined ? 0.55 : o.crossChance)) {
      if (o.align) {
        cross = alignedOffset(along0, Math.round(U * 0.25), Math.round(U * 0.75) - cw, o.crossSpacing, o.crossPhase);
        crossAligned = cross !== null;
      } else cross = null;
      if (cross === null) cross = Math.round(U * rng.range(0.3, 0.7));
    }
    const bands = [];
    if (v0 > 0) bands.push([0, v0]);
    if (v0 + cw < V) bands.push([v0 + cw, V]);
    for (const [b0, b1] of bands) {
      const runs = cross < 0 ? [[0, U]] : [[0, cross], [cross + cw, U]];
      if (cross >= 0) {
        const cb = blk(F.R(cross, b0, cross + cw, b1), HALL);
        if (crossAligned && st.dna) cb.flow = flowContract(st.dna, 'cross', F.horiz ? 'y' : 'x', along0 + cross, cw);
        out.push(cb);
      }
      for (const [r0, r1] of runs) {
        if (r1 - r0 <= 0) continue;
        // which world side of these blocks faces the spine corridor
        const front = (F.horiz ? 'y' : 'x') + (b0 === 0 ? '1' : '0');
        for (const [c0, c1] of chunks(r1 - r0, rng, o.chunk[0], o.chunk[1])) {
          const b = blk(F.R(r0 + c0, b0, r0 + c1, b1), o.guest ? BLOCK : o.plain ? ROOM : BLOCK, o.guest ? 'guest' : null);
          b.front = front;
          out.push(b);
        }
      }
    }
  }

  LAY.spine = (q, rng, st, A, out) => {
    const D = st.dna;
    const chunk = D ? [Math.max(A.chunk[0], D.module * 2), Math.min(A.chunk[1], D.module * 4)] : A.chunk;
    spine(q, rng, st, A, out, {
      depthMin: A.depthMin, chunk,
      axis: D && D.majorAxis, cw: D && D.corridorWidth, align: !!D,
      spineSpacing: D && D.spineSpacing, spinePhase: D && D.spinePhase,
      crossSpacing: D && D.crossSpacing, crossPhase: D && D.crossPhase,
      crossChance: D && D.crossChance
    });
  };

  /** Hotel: mostly guest-room wings, sometimes a ballroom, garden court or a lobby at the end of a wing. */
  LAY.hotel = (q, rng, st, A, out) => {
    const D = st.dna, F = preferredFrame(q, D && D.majorAxis, 14, A.depthMin + (D ? D.corridorWidth : 2)), [w, h] = dims(q), sb = D ? D.specialBias : 1, kind = rng.weighted({ wing: 4.5 / sb, ballroom: Math.min(w, h) >= 16 ? 1.6 * sb : 0, garden: Math.min(w, h) >= 20 ? 1.1 * sb : 0 });
    if (kind === 'ballroom') { out.push(blk(q, BLOCK, rng.f() < 0.6 ? 'open' : 'gallery')); return; }
    if (kind === 'garden') { out.push(blk(q, BLOCK, 'courtyard')); return; }
    if (F.U >= 40 && rng.f() < 0.35) {
      const L = rng.int(10, 16);
      out.push(blk(F.R(0, 0, L, F.V), BLOCK, 'open'));          // lobby
      q = F.R(L, 0, F.U, F.V);
    }
    const before = out.length;
    const chunk = D ? [Math.max(A.chunk[0], D.module - 1), Math.min(A.chunk[1], D.module + 1)] : A.chunk;
    spine(q, rng, st, A, out, {
      depthMin: A.depthMin, chunk, guest: true,
      axis: D && D.majorAxis, cw: D && D.corridorWidth, align: !!D,
      spineSpacing: D && D.spineSpacing, spinePhase: D && D.spinePhase,
      crossSpacing: D && D.crossSpacing, crossPhase: D && D.crossPhase,
      crossChance: D && D.crossChance
    });
    // suites: merge some pairs of neighbouring guest rooms
    for (let i = before; i + 1 < out.length; i++) {
      const a = out[i], b = out[i + 1];
      if (a.zt !== 'guest' || b.zt !== 'guest' || a.front !== b.front || rng.f() > 0.15) continue;
      const P=BR.spacePolicy('hotel',D);
      if (a.y0 === b.y0 && a.y1 === b.y1 && a.x1 === b.x0) {
        const frontage=a.front[0]==='y'?b.x1-a.x0:a.y1-a.y0,depth=a.front[0]==='y'?a.y1-a.y0:b.x1-a.x0;
        if(frontage<=Math.max(12,P.maxFrontage*1.4)&&depth<=P.maxDepth) { a.x1 = b.x1; out.splice(i + 1, 1); }
      } else if (a.x0 === b.x0 && a.x1 === b.x1 && a.y1 === b.y0) {
        const frontage=a.front[0]==='x'?b.y1-a.y0:a.x1-a.x0,depth=a.front[0]==='x'?a.x1-a.x0:b.y1-a.y0;
        if(frontage<=Math.max(12,P.maxFrontage*1.4)&&depth<=P.maxDepth) { a.y1 = b.y1; out.splice(i + 1, 1); }
      }
    }
  };

  LAY.hall = (q, rng, st, A, out) => {
    const F = uvFrame(q), U = F.U, V = F.V;
    let m0 = 0, m1 = V;
    if (V >= 20 && rng.f() < 0.7) {
      const d = rng.int(4, 7), low = rng.f() < 0.5;
      const s0 = low ? 0 : V - d, s1 = low ? d : V;
      if (low) m0 = d; else m1 = V - d;
      for (const [c0, c1] of chunks(U, rng, 4, 9)) {
        const t = rng.weighted(A.service);
        out.push(t === 'room' ? blk(F.R(c0, s0, c1, s1), ROOM) : blk(F.R(c0, s0, c1, s1), BLOCK, t));
      }
    }
    const t1 = rng.weighted(A.main);
    if (U > 64) {
      const c = Math.round(U * rng.range(0.4, 0.6));
      let t2 = rng.weighted(A.main);
      if (t2 === t1) t2 = rng.weighted(A.main);
      out.push(blk(F.R(0, m0, c, m1), BLOCK, t1), blk(F.R(c, m0, U, m1), BLOCK, t2));
    } else out.push(blk(F.R(0, m0, U, m1), BLOCK, t1));
  };

  /**
   * Home pockets: a row of one to three houses with gardens between them, and
   * a back garden when the plot is deep.
   */
  LAY.house = (q, rng, st, A, out) => {
    const F = uvFrame(q), U = F.U, V = F.V;
    const lots = U >= 26 ? chunks(U, rng, 12, 20) : [[0, U]];
    let houses = 0;
    lots.forEach(([u0, u1], li) => {
      const last = li === lots.length - 1;
      if (lots.length > 1 && (u1 - u0 < 14 || rng.f() < 0.3) && (houses > 0 || !last)) { out.push(blk(F.R(u0, 0, u1, V), BLOCK, 'yard')); return; }
      houses++;
      if (V >= 22 && rng.f() < 0.75) {
        const d = rng.int(12, Math.min(19, V - 6)), top = rng.f() < 0.5;
        out.push(blk(top ? F.R(u0, 0, u1, d) : F.R(u0, V - d, u1, V), BLOCK, 'house'));
        out.push(blk(top ? F.R(u0, d, u1, V) : F.R(u0, 0, u1, V - d), BLOCK, 'yard'));
      } else out.push(blk(F.R(u0, 0, u1, V), BLOCK, 'house'));
    });
  };
  LAY.utility = (q, rng, st, A, out) => out.push(blk(q, BLOCK, 'machinery'));

  // --------------------------------------------------------------- connect
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
  function pushSeg(out, e, s0, s1) {
    if (s1 - s0 < 0.05) return;
    if (e.v) out.push(e.c, s0, e.c, s1); else out.push(s0, e.c, s1, e.c);
  }
  function blockRoomAt(I, bi, x, y, door) {
    const b = I.blocks[bi];
    if (!b || b.z < 0) return -1;
    const Z = I.zones[b.z], k = door ? Z.doorRoomAt(x, y) : Z.roomAt(x, y);
    return k < 0 ? -1 : Z.base + k;
  }
  /** Cut a doorway-sized gap (along a shared wall at position s) out of a zone's masses. */
  function carve(Z, e, s, dw) {
    const M = Z.masses, out = [];
    const g0 = s - dw / 2 - 0.3, g1 = s + dw / 2 + 0.3;
    for (let k = 0; k < M.length; k += 4) {
      const x0 = M[k], y0 = M[k + 1], x1 = M[k + 2], y1 = M[k + 3];
      const near = e.v ? (Math.min(Math.abs(x0 - e.c), Math.abs(x1 - e.c)) <= 1.6 && y1 > g0 && y0 < g1)
        : (Math.min(Math.abs(y0 - e.c), Math.abs(y1 - e.c)) <= 1.6 && x1 > g0 && x0 < g1);
      if (!near) { out.push(x0, y0, x1, y1); continue; }
      if (e.v) { if (y0 < g0) out.push(x0, y0, x1, g0); if (y1 > g1) out.push(x0, g1, x1, y1); }
      else { if (x0 < g0) out.push(x0, y0, g0, y1); if (x1 > g1) out.push(g1, y0, x1, y1); }
    }
    Z.masses = out;
  }

  /**
   * Openings between the blocks of a territory, recorded as links between
   * rooms (the room graph). Corridor walls are tried first and service strips
   * last, so occupied spaces preferentially open onto circulation.
   */
  function connect(I, rng, st) {
    const R = I.blocks, n = R.length, Zs = I.zones;
    const links = [], walls = [];
    for (const Z of Zs) for (const L of Z.links) links.push({ a: Z.base + L.a, b: Z.base + L.b, x: L.x, y: L.y, w: L.w, kind: L.kind });
    const adj = [];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const e = sharedSeg(R[i], R[j]);
      if (e) { e.a = i; e.b = j; adj.push(e); }
    }
    const type = (i) => Zs[R[i].z].type, plain = (i) => type(i) === 'room', svc = (i) => R[i].k === SERVICE;
    const rooms = (e, s) => {
      const a = R[e.a];
      let pa, pb;
      if (e.v) { const L = a.x1 === e.c ? -0.6 : 0.6; pa = [e.c + L, s]; pb = [e.c - L, s]; }
      else { const L = a.y1 === e.c ? -0.6 : 0.6; pa = [s, e.c + L]; pb = [s, e.c - L]; }
      const ra = blockRoomAt(I, e.a, pa[0], pa[1], true), rb = blockRoomAt(I, e.b, pb[0], pb[1], true);
      return ra >= 0 && rb >= 0 ? [ra, rb] : null;
    };
    const spots = (e, lo, hi) => {
      const out = [];
      if (hi < lo) { const s = (e.s0 + e.s1) / 2, r = rooms(e, s); if (r) out.push([s, r]); return out; }
      for (let s = lo; s <= hi + 1e-9; s += 0.5) { const r = rooms(e, s); if (r) out.push([s, r]); }
      return out;
    };
    const P = (e, s) => (e.v ? [e.c, s] : [s, e.c]);
    // 1. Planned circulation fragments meeting inside a territory are one
    // route network. This includes junctions between different selected route
    // IDs and very short dogleg edges.
    const uf = makeUF(n);
    for (const e of adj) {
      const fa = R[e.a].flow, fb = R[e.b].flow;
      if (!fa || !fb || e.len < 0.05) continue;
      const sp = (e.s0 + e.s1) / 2, rr = rooms(e, sp);
      if (!rr) continue;
      const pc = P(e, sp); uf.union(e.a, e.b); e.open = true;
      links.push({ a: rr[0], b: rr[1], x: pc[0], y: pc[1], w: e.len, kind: fa.key === fb.key ? 'route' : 'junction' });
    }
    // Sub-room geometric slivers created where a dogleg or finite route end
    // cuts the partition are absorbed topologically by opening their longest
    // available short edge. They remain ordinary floor, not fake corridors.
    for (const e of adj) {
      if (e.open || e.len < 0.35) continue;
      const a=R[e.a],b=R[e.b],amin=Math.min(a.x1-a.x0,a.y1-a.y0),bmin=Math.min(b.x1-b.x0,b.y1-b.y0);
      if (amin >= 1.4 && bmin >= 1.4) continue;
      const sp=(e.s0+e.s1)/2; let rr=rooms(e,sp);
      if(!rr){
        const centerRoom=(bi)=>{const q=R[bi],x=(q.x0+q.x1)/2,y=(q.y0+q.y1)/2;return blockRoomAt(I,bi,x,y,false);};
        const ra=centerRoom(e.a),rb=centerRoom(e.b); if(ra>=0&&rb>=0) rr=[ra,rb];
      }
      if(!rr)continue;
      const pc=P(e,sp);uf.union(e.a,e.b);e.open=true;
      links.push({a:rr[0],b:rr[1],x:pc[0],y:pc[1],w:e.len,kind:'merge'});
    }
    // 1b. walls that open up entirely (or into a wide opening)
    for (const e of adj) {
      if (e.open || e.len < 2) continue;
      const a = R[e.a], b = R[e.b];
      let p = 0;
      if (svc(e.a) || svc(e.b)) p = svc(e.a) && svc(e.b) ? 0.95 : 0;
      else if (plain(e.a) && plain(e.b)) p = a.k === HALL && b.k === HALL ? 0.9 : (a.k === HALL || b.k === HALL) ? st.pOpen * 0.3 : st.pOpen;
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
    // 2. doors: random spanning tree over the blocks + loops
    const groups = new Map();
    for (const e of adj) {
      if (e.open || e.wide) continue;
      const ra = uf.find(e.a), rb = uf.find(e.b);
      if (ra === rb) continue;
      const key = ra < rb ? ra * n + rb : rb * n + ra;
      let g = groups.get(key);
      const hall = R[e.a].k === HALL || R[e.b].k === HALL, service = svc(e.a) || svc(e.b);
      if (!g) { g = { ra: Math.min(ra, rb), rb: Math.max(ra, rb), segs: [], w: rng.f(), service: false }; groups.set(key, g); }
      if (hall) g.w = Math.min(g.w, rng.f() - 1);
      if (service) { g.service = true; g.w += 2; }
      g.segs.push(e);
    }
    const order = [...groups.values()].sort((x, y) => x.w - y.w);
    const tree = makeUF(n);
    for (let i = 0; i < n; i++) tree.union(i, uf.find(i));
    let doors = 0;
    for (const g of order) {
      const joined = tree.find(g.ra) === tree.find(g.rb);
      if (joined && (g.service || rng.f() > st.pLoop)) continue;
      const wide = !g.service && rng.f() < st.pWide;
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
        links.push({ a: rr[0], b: rr[1], x: pc[0], y: pc[1], w: dw, kind: g.service ? 'service' : wide ? 'wide' : 'door' });
        doors++;
        break;
      }
    }
    // 2b. anything still cut off: carve a doorway through a solid
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
      if (same && !e.wide && plain(e.a) && plain(e.b) && !svc(e.a) && !svc(e.b)) {
        // same room: usually no wall, sometimes a partial stub sticking out
        if (e.len < 3 || rng.f() > st.pStub) continue;
        const f = rng.range(0.2, 0.6) * e.len;
        if (rng.f() < 0.5) pushSeg(walls, e, e.s0, e.s0 + f); else pushSeg(walls, e, e.s1 - f, e.s1);
        continue;
      }
      if (e.door) { pushSeg(walls, e, e.s0, e.door[0]); pushSeg(walls, e, e.door[1], e.s1); }
      else pushSeg(walls, e, e.s0, e.s1);
    }
    I.links = links; I.walls = walls; I.doorCount = doors;
  }

  // ----------------------------------------------------------------- build
  function buildInterior(W, T) {
    const rng = new Rng(hash4(W.seed, T.i, T.j, T.k * 64 + S.INT));
    const area = W.final(T), A = BR.AREAS[area], dna = BR.architectureDNA(W, T, area);
    const st = makeStyle(A, rng, dna);
    const rects = T.rects.map((r) => r.slice());
    const structure = BR.territoryStructure(W, T, rects);
    const blocks = [], realizations = [], spacePlans = [];
    // landmark: one huge block
    const r0 = rects[0], [w0, h0] = dims(r0);
    let landmark = null;
    if (!structure.plan && A.landmarks && T.rects.length === 1 && Math.min(w0, h0) >= 24 && w0 * h0 >= 650 &&
      new Rng(hash4(W.seed, T.i, T.j, T.k * 64 + S.LMK)).f() < A.landmarkP * dna.landmarkBias) {
      landmark = new Rng(hash4(W.seed, T.i, T.j, T.k * 64 + S.LMK + 1)).weighted(A.landmarks);
      if (landmark === 'longGallery' && Math.max(w0, h0) < 2.2 * Math.min(w0, h0)) landmark = 'grandHall';
    }
    rects.forEach((q, ri) => {
      const [w, h] = dims(q);
      if (w <= 0 || h <= 0) return;
      if (landmark && ri === 0) { const b = blk(q, BLOCK, landmark); b.lm = true; blocks.push(b); return; }
      if (structure.plan) {
        const obs = structure.routes.filter((o) => o.rectIndex === ri);
        const ans = structure.anchors.filter((a) => a.x >= q[0] && a.x <= q[2] && a.y >= q[1] && a.y <= q[3]);
        plannedBlocks(q, obs, ans, rng, st, area, blocks, realizations, spacePlans,
          T.key + '|rect|' + ri, structure.plan.program || null); return;
      }
      if (ri > 0 || w * h < 60 || Math.min(w, h) < 6) { blocks.push(blk(q, ROOM)); return; }
      LAY[A.style](q, rng, st, A, blocks);
    });
    // zones, avoiding the types of neighbouring blocks
    const spacePlan = {
      parts: spacePlans,
      parcels: spacePlans.flatMap((p) => p.parcels),
      localRoutes: spacePlans.flatMap((p) => p.localRoutes),
      diagnostics: spacePlans.reduce((a,p) => {
        const d=p.diagnostics;a.parcels+=d.parcels;a.support+=d.support;a.localRoutes+=d.localRoutes;
        a.unserved+=d.unserved;if(d.capHit)a.capHit=true;
        for(const k in d.violations)a.violations[k]=(a.violations[k]||0)+d.violations[k];
        return a;
      },{parcels:0,support:0,localRoutes:0,unserved:0,capHit:false,violations:{}})
    };
    const I = { key: T.key, area, landmark, dna, dnaKey: dna.key,
      manifestation: structure.plan && structure.plan.manifestation || null,
      programKey: structure.plan && structure.plan.programKey || null,
      structureKey: structure.plan && structure.plan.key,
      obligations: structure.routes, anchors: structure.anchors, realizations, spacePlan, blocks, zones: [], rooms: [], links: [], walls: [] };
    const nb = blocks.map(() => []);
    for (let i = 0; i < blocks.length; i++) for (let j = i + 1; j < blocks.length; j++)
      if (sharedSeg(blocks[i], blocks[j])) { nb[i].push(j); nb[j].push(i); }
    blocks.forEach((b, i) => {
      const q = [b.x0, b.y0, b.x1, b.y1];
      let Z;
      if (b.k === SERVICE) {
        Z = BR.plainZone(q, 'service');
        // pipes along one long side of the strip
        const w = q[2] - q[0], h = q[3] - q[1], lo = rng.f() < 0.5;
        for (const d of [0.45, 0.8]) {
          if (w >= h) { const y = lo ? q[1] + d : q[3] - d; Z.hatch.push(q[0], y, q[2], y); }
          else { const x = lo ? q[0] + d : q[2] - d; Z.hatch.push(x, q[1], x, q[3]); }
        }
      }
      else if (b.k === HALL) Z = BR.plainZone(q, 'corridor');
      else if (b.k === ROOM) Z = BR.plainZone(q, 'room');
      else {
        let t = b.zt;
        if (!t) {
          const avoid = [];
          for (const j of nb[i]) if (blocks[j].z >= 0) avoid.push(I.zones[blocks[j].z].type);
          const roleWeights=BR.programZoneWeights?BR.programZoneWeights(area,b.programRole,st.zones):st.zones;
          t = BR.pickZoneType(rng, roleWeights, q, avoid, 0, b.space || null);
        }
        Z = BR.fillZone(t, q, rng, st, { front: b.front, space: b.space || null, garden: area === 'hotel' || area === 'home' });
      }
      b.z = I.zones.length;
      I.zones.push(Z);
    });
    let base = 0;
    for (const Z of I.zones) { Z.base = base; base += Z.rooms.length; }
    connect(I, rng, st);
    // aggregate
    const KEYS = ['minor', 'hatch', 'masses', 'voids', 'pools', 'props', 'rounds', 'pillars', 'stairs'];
    for (const k of KEYS) I[k] = [];
    for (const Z of I.zones) {
      for (const r of Z.rooms) I.rooms.push({ rects: r.rects, kind: r.kind, zone: Z.type });
      for (let i = 0; i < Z.major.length; i++) I.walls.push(Z.major[i]);
      for (const k of KEYS) { const S2 = Z[k], O = I[k]; for (let i = 0; i < S2.length; i++) O.push(S2[i]); }
    }
    let floor = 0;
    for (const b of blocks) floor += (b.x1 - b.x0) * (b.y1 - b.y0);
    I.floor = floor;
    return I;
  }

  /** Room index of interior I at (x,y), or -1 (outside, or inside a solid). door: also -1 where no outside door may land. */
  function interiorRoomAt(I, x, y, door) {
    const B = I.blocks;
    for (let i = 0; i < B.length; i++) {
      const b = B[i];
      if (x > b.x0 && x < b.x1 && y > b.y0 && y < b.y1) return blockRoomAt(I, i, x, y, door);
    }
    return -1;
  }
  function interiorBlockAt(I, x, y) {
    for (const b of I.blocks) if (x > b.x0 && x < b.x1 && y > b.y0 && y < b.y1)
      return { kind: b.k, zone: I.zones[b.z].type, sub: I.zones[b.z].sub, flow: b.flow || null,
        flows: b.flows || (b.flow ? [b.flow] : []), realization: b.realization || null,
        routeHierarchy: b.routeHierarchy || null, programRole: b.programRole || null, space: b.space || null,
        anchor: b.anchor || null, anchorKind: b.anchorKind || null };
    return null;
  }

  Object.assign(BR, { buildInterior, interiorRoomAt, interiorBlockAt, BLOCK_KIND: { ROOM, HALL, BLOCK, SERVICE } });
})(typeof window !== 'undefined' ? window : globalThis);
