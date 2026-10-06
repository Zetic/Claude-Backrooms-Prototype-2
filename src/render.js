/*
 * render.js - Canvas2D presentation of the generated data (no generation here).
 *
 * The world is completely filled, so the dark background only shows through
 * where something is solid: thick walls, solid blocks, light wells.
 *
 *   area map (far zoom, or the Area map toggle): territories as flat area
 *     colours, territory outlines, heavier lines where areas meet, area names
 *   detail (zoom >= 1.1): floors, internal service circulation, structure (pools,
 *     solids, round rooms, light wells), then by zoom: walls, pillars,
 *     furniture, partitions, stair treads / bay lines; territory boundaries
 *     drawn as one shared wall each - thin, heavier between areas, thick 2 m
 *     walls as solid strips - with their doorways cut out
 *
 * Paths are cached per territory relative to its bbox corner, so canvas
 * coordinates stay small even millions of metres from the origin.
 */
(function (root) {
  'use strict';
  const BR = root.BR;
  const { rgbToCss, scaleRgb, mixRgb, clamp } = BR;

  const BG = '#4e4c49';
  const LOD = { interiors: 1.1, pillars: 1.8, props: 2.2, minor: 2.4, hatch: 3 };
  const CROSS_WALL = '#5f584f', THICK_WALL = '#45423e', WATER = [124, 189, 234];

  // -------------------------------------------------------------- caches
  function rectsPath(list, ax, ay) {
    const p = new Path2D();
    for (const r of list) p.rect(r[0] - ax, r[1] - ay, r[2] - r[0], r[3] - r[1]);
    return p;
  }
  function flatPath(A, ax, ay) {
    const p = new Path2D();
    for (let k = 0; k < A.length; k += 4) p.rect(A[k] - ax, A[k + 1] - ay, A[k + 2] - A[k], A[k + 3] - A[k + 1]);
    return p;
  }
  function segPath(A, ax, ay) {
    const p = new Path2D();
    for (let k = 0; k < A.length; k += 4) { p.moveTo(A[k] - ax, A[k + 1] - ay); p.lineTo(A[k + 2] - ax, A[k + 3] - ay); }
    return p;
  }
  function segsPath(segs, ax, ay) {
    const p = new Path2D();
    for (const s of segs) {
      if (s.o === 'h') { p.moveTo(s.s0 - ax, s.c - ay); p.lineTo(s.s1 - ax, s.c - ay); }
      else { p.moveTo(s.c - ax, s.s0 - ay); p.lineTo(s.c - ax, s.s1 - ay); }
    }
    return p;
  }

  function planGfx(W, T) {
    if (T._gfx) return T._gfx;
    const ax = T.bbox[0], ay = T.bbox[1], rgb = W.color(T);
    T._gfx = { ax, ay, all: rectsPath(T.rects, ax, ay),
      fill: rgbToCss(rgb), line: rgbToCss(scaleRgb(rgb, 0.84)) };
    return T._gfx;
  }

  /** Heavy lines along the segments where T meets a different area. */
  function areaEdgeGfx(W, T) {
    if (T._edges) return T._edges;
    const fa = W.final(T), segs = [];
    for (const n of W.adj(T)) if (W.final(n.U) !== fa && n.U.key > T.key) for (const s of n.segs) segs.push(s);
    T._edges = { path: segsPath(segs, T.bbox[0], T.bbox[1]), any: segs.length > 0 };
    return T._edges;
  }

  function interiorGfx(W, T, I) {
    if (I._gfx) return I._gfx;
    const ax = T.bbox[0], ay = T.bbox[1], rgb = W.color(T);
    const SV = BR.BLOCK_KIND.SERVICE;
    const floor = [], svc = [];
    for (const b of I.blocks) (b.k === SV ? svc : floor).push([b.x0, b.y0, b.x1, b.y1]);
    const rounds = new Path2D(), arcs = new Path2D(), R = I.rounds;
    for (let k = 0; k < R.length; k += 7) {
      rounds.rect(R[k + 3] - ax, R[k + 4] - ay, R[k + 5] - R[k + 3], R[k + 6] - R[k + 4]);
      rounds.moveTo(R[k] - ax + R[k + 2], R[k + 1] - ay); rounds.arc(R[k] - ax, R[k + 1] - ay, R[k + 2], 0, Math.PI * 2);
      arcs.moveTo(R[k] - ax + R[k + 2], R[k + 1] - ay); arcs.arc(R[k] - ax, R[k + 1] - ay, R[k + 2], 0, Math.PI * 2);
    }
    const pillars = new Path2D(), Pl = I.pillars;
    for (let k = 0; k < Pl.length; k += 4) {
      const x = Pl[k] - ax, y = Pl[k + 1] - ay, sz = Pl[k + 3];
      if (Pl[k + 2] === 1) { const t = sz / 3; pillars.rect(x - sz / 2, y - t / 2, sz, t); pillars.rect(x - t / 2, y - sz / 2, t, sz); }
      else pillars.rect(x - sz / 2, y - sz / 2, sz, sz);
    }
    const wallRgb = scaleRgb(rgb, 0.72), serviceRgb = scaleRgb(rgb, 0.90);
    I._gfx = {
      ax, ay,
      floor: rectsPath(floor, ax, ay), svc: rectsPath(svc, ax, ay), hasSvc: svc.length > 0,
      walls: segPath(I.walls, ax, ay), minor: segPath(I.minor, ax, ay), hatch: segPath(I.hatch, ax, ay),
      masses: flatPath(I.masses, ax, ay), voids: flatPath(I.voids, ax, ay), pools: flatPath(I.pools, ax, ay), props: flatPath(I.props, ax, ay),
      rounds, arcs, pillars,
      has: { masses: I.masses.length > 0, voids: I.voids.length > 0, pools: I.pools.length > 0, props: I.props.length > 0, rounds: R.length > 0, pillars: Pl.length > 0, minor: I.minor.length > 0, hatch: I.hatch.length > 0 },
      fill: rgbToCss(rgb), service: rgbToCss(serviceRgb),
      wall: rgbToCss(wallRgb), minorC: rgbToCss(mixRgb(wallRgb, rgb, 0.3)), prop: rgbToCss(scaleRgb(rgb, 0.86)),
      water: rgbToCss(mixRgb(WATER, rgb, 0.12))
    };
    return I._gfx;
  }

  function boundaryGfx(W, B) {
    if (B._gfx) return B._gfx;
    const A = W.terr(B.a);
    // same-area walls look like any interior wall, so the territory tiling does not show
    B._gfx = { walls: segPath(B.walls, B.ax, B.ay), color: B.wall === 'thick' ? THICK_WALL : B.cross ? CROSS_WALL : rgbToCss(scaleRgb(W.color(A), 0.7)) };
    return B._gfx;
  }

  /**
   * view: { cx, cy, zoom (css px per metre), w, h (css px), dpr }
   * opts: base map toggles plus generation-debug overlays and hover
   */
  function drawWorld(ctx, W, view, opts, budgetMs) {
    const { cx, cy, zoom, w, h, dpr } = view;
    const hw = w / 2 / zoom, hh = h / 2 / zoom;
    const detail = !opts.areaMap && zoom >= LOD.interiors;
    const pad = 4 / zoom;                                // strokes bleeding in from just outside
    const items = W.collect(cx - hw - pad, cy - hh - pad, cx + hw + pad, cy + hh + pad, budgetMs, { interiors: detail });

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, w, h);
    const z = zoom * dpr;
    const sx = (x) => ((x - cx) * zoom + w / 2) * dpr, sy = (y) => ((y - cy) * zoom + h / 2) * dpr;
    const anchor = (ax, ay) => ctx.setTransform(z, 0, 0, z, sx(ax), sy(ay));
    const px = (p) => p / zoom;                       // pixels -> metres
    ctx.lineJoin = 'miter'; ctx.miterLimit = 2;

    // ---- floors (flat plan colours where no interior exists yet)
    const built = new Map();
    for (const T of items.territories) {
      const I = detail ? W.interiors.get(T.key) : null;
      if (I) { built.set(T.key, I); continue; }
      const g = planGfx(W, T);
      anchor(g.ax, g.ay);
      ctx.fillStyle = g.fill; ctx.fill(g.all);
    }
    for (const T of items.territories) {
      const I = built.get(T.key);
      if (!I) continue;
      const g = interiorGfx(W, T, I), H = g.has;
      anchor(g.ax, g.ay);
      ctx.fillStyle = g.fill; ctx.fill(g.floor);
      if (g.hasSvc) { ctx.fillStyle = g.service; ctx.fill(g.svc); }
      if (H.pools) { ctx.fillStyle = g.water; ctx.fill(g.pools); }
      ctx.fillStyle = g.wall;
      if (H.masses) ctx.fill(g.masses);
      if (H.rounds) ctx.fill(g.rounds, 'evenodd');
      if (H.voids) { ctx.fillStyle = BG; ctx.fill(g.voids); ctx.strokeStyle = g.wall; ctx.lineWidth = px(1.5); ctx.stroke(g.voids); }
    }

    // Physical circulation has one floor treatment across semantic and technical
    // ownership changes. This is rendered floor, independent of debug overlays.
    const routeFloor={primary:'#f2e8cf',secondary:'#eee2c5',local:'#e8dbba',service:'#d4cbb2'};
    for(const T of items.territories){const I=built.get(T.key);if(!I)continue;
      anchor(T.bbox[0],T.bbox[1]);
      for(const b of I.blocks)if(b.flow){ctx.fillStyle=routeFloor[b.routeHierarchy];
        ctx.fillRect(b.x0-T.bbox[0],b.y0-T.bbox[1],b.x1-b.x0,b.y1-b.y0);}
    }

    // ---- interior detail by zoom
    if (detail && opts.walls !== false) {
      const wallW = px(clamp(0.3 * zoom, 0.8, 3)), minorW = wallW * 0.7, hatchW = Math.max(0.1, wallW * 0.4);
      ctx.lineCap = 'square';
      for (const T of items.territories) {
        const I = built.get(T.key);
        if (!I) continue;
        const g = interiorGfx(W, T, I), H = g.has;
        anchor(g.ax, g.ay);
        if (zoom >= LOD.props && H.props) { ctx.fillStyle = g.prop; ctx.fill(g.props); }
        if (zoom >= LOD.hatch && H.hatch) { ctx.strokeStyle = g.minorC; ctx.lineWidth = hatchW; ctx.stroke(g.hatch); }
        if (zoom >= LOD.minor && H.minor) { ctx.strokeStyle = g.minorC; ctx.lineWidth = minorW; ctx.stroke(g.minor); }
        ctx.strokeStyle = g.wall; ctx.lineWidth = wallW; ctx.stroke(g.walls);
        if (H.rounds) ctx.stroke(g.arcs);
        if (zoom >= LOD.pillars && H.pillars) { ctx.fillStyle = g.wall; ctx.fill(g.pillars); }
      }
    }

    // ---- territory boundaries
    if (detail) {
      ctx.lineCap = 'butt';
      const thinW = px(clamp(0.32 * zoom, 0.8, 3.2)), crossW = px(clamp(0.7 * zoom, 1.4, 6)), thickW = Math.max(2, px(2));
      const done = new Set();
      for (const B of items.boundaries) {
        done.add(B.key);
        if (B.wall === 'open' || !B.walls.length) continue;
        const g = boundaryGfx(W, B);
        anchor(B.ax, B.ay);
        ctx.strokeStyle = g.color;
        ctx.lineWidth = B.wall === 'thick' ? thickW : B.cross ? crossW : thinW;
        ctx.stroke(g.walls);
      }
      // walls not built yet (neighbour still generating): a plain line for now
      ctx.strokeStyle = CROSS_WALL; ctx.lineWidth = thinW;
      for (const T of items.territories) {
        if (!built.has(T.key)) continue;
        for (const n of W.adj(T)) {
          if (done.has(BR.pairKey(T, n.U))) continue;
          anchor(T.bbox[0], T.bbox[1]);
          ctx.stroke(segsPath(n.segs, T.bbox[0], T.bbox[1]));
        }
      }
    } else {
      // area map: territory outlines, heavier where areas meet
      if (zoom >= 0.22) {
        ctx.lineWidth = px(1);
        for (const T of items.territories) { const g = planGfx(W, T); anchor(g.ax, g.ay); ctx.strokeStyle = g.line; ctx.stroke(g.all); }
      }
      ctx.strokeStyle = CROSS_WALL; ctx.lineWidth = px(zoom >= 0.5 ? 2.5 : 1.6); ctx.lineCap = 'square';
      for (const T of items.territories) {
        const e = areaEdgeGfx(W, T);
        if (!e.any) continue;
        anchor(T.bbox[0], T.bbox[1]); ctx.stroke(e.path);
      }
    }

    // ---- overlays
    if (opts.territories) {
      ctx.strokeStyle = 'rgba(255,255,255,0.65)';
      for (const T of items.territories) { const g = planGfx(W, T); anchor(g.ax, g.ay); ctx.lineWidth = px(1.2); ctx.stroke(g.all); }
    }
    if (opts.cells) {
      const seen = new Set();
      ctx.strokeStyle = 'rgba(255,90,170,0.9)';
      for (const T of items.territories) {
        const k = T.i + ',' + T.j;
        if (seen.has(k)) continue;
        seen.add(k);
        const c = BR.superCell(W.seed, T.i, T.j);
        anchor(c.core[0], c.core[1]); ctx.lineWidth = px(2);
        ctx.stroke(rectsPath([c.core].concat(c.ears), c.core[0], c.core[1]));
      }
    }
    if (opts.rooms && detail) {
      const G = BR.roomGraph(W, items);
      const X = (x) => (x - cx) * zoom + w / 2, Y = (y) => (y - cy) * zoom + h / 2;
      // an edge's far end may be a room of a territory outside this tile
      const node = (k) => {
        let n = G.nodes.get(k);
        if (n) return n;
        const c = k.lastIndexOf(':'), I = W.interiors.get(k.slice(0, c)), r = I && I.rooms[+k.slice(c + 1)];
        if (!r) return null;
        const q = r.rects[0];
        n = { x: (q[0] + q[2]) / 2, y: (q[1] + q[3]) / 2 };
        G.nodes.set(k, n);
        return n;
      };
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      for (const [a, b, , ext] of G.edges) {
        const A = node(a), B = node(b);
        if (!A || !B) continue;
        ctx.strokeStyle = ext ? 'rgba(255,150,60,0.95)' : 'rgba(80,200,255,0.7)';
        ctx.lineWidth = ext ? 2.2 : 1;
        ctx.beginPath(); ctx.moveTo(X(A.x), Y(A.y)); ctx.lineTo(X(B.x), Y(B.y)); ctx.stroke();
      }
      ctx.fillStyle = 'rgba(80,200,255,0.95)';
      for (const n of G.nodes.values()) { ctx.beginPath(); ctx.arc(X(n.x), Y(n.y), 2, 0, Math.PI * 2); ctx.fill(); }
    }
    return items;
  }


  // ---------------------------------------------------- generation debugger
  function drawGenerationDebug(ctx, W, view, opts) {
    const any = opts.manifestations || opts.programRegions || opts.dnaDebug || opts.candidateRoutes || opts.selectedRoutes || opts.structureNodes ||
      opts.routeSpace || opts.buildableSpace || opts.obligations || opts.realizedRoutes || opts.continuations || opts.routeFailures ||
      opts.spaceParcels || opts.spaceAccess || opts.localCirculation || opts.spaceViolations;
    if (!any) return;
    const { cx, cy, zoom, w, h, dpr } = view, hw=w/2/zoom, hh=h/2/zoom;
    const X=(x)=>(x-cx)*zoom+w/2, Y=(y)=>(y-cy)*zoom+h/2;
    ctx.setTransform(dpr,0,0,dpr,0,0); ctx.lineCap='round'; ctx.lineJoin='round';
    const seg=(axis,line,s0,s1)=>{
      ctx.beginPath();
      if(axis==='x'){ctx.moveTo(X(s0),Y(line));ctx.lineTo(X(s1),Y(line));}
      else{ctx.moveTo(X(line),Y(s0));ctx.lineTo(X(line),Y(s1));}
      ctx.stroke();
    };
    const rect=(q)=>{ctx.strokeRect(X(q[0]),Y(q[1]),(q[2]-q[0])*zoom,(q[3]-q[1])*zoom);};
    const ellipse=(L)=>{ctx.beginPath();ctx.ellipse(X(L.cx),Y(L.cy),L.rx*zoom,L.ry*zoom,0,0,Math.PI*2);ctx.stroke();};
    const plans=W.structuresIn(cx-hw-80,cy-hh-80,cx+hw+80,cy+hh+80);
    const manifests=(opts.manifestations||opts.programRegions)?W.manifestationsIn(cx-hw-80,cy-hh-80,cx+hw+80,cy+hh+80):[];

    if(opts.manifestations){
      ctx.lineWidth=1.5;ctx.strokeStyle='rgba(255,235,100,.92)';ctx.fillStyle='rgba(255,245,170,.96)';
      ctx.font='11px ui-monospace, monospace';
      for(const M of manifests){
        ctx.setLineDash([]);
        for(const L of M.lobes)ellipse(L);
        ctx.setLineDash([4,3]);ctx.strokeStyle='rgba(255,120,120,.9)';
        for(const H of M.holes)ellipse(H);
        ctx.setLineDash([]);ctx.strokeStyle='rgba(255,235,100,.92)';
        if(zoom>=0.55)ctx.fillText(M.type+' · '+M.form+' · '+M.scale,X(M.cx)+5,Y(M.cy)-5);
      }
    }
    if(opts.programRegions){
      ctx.font='10px ui-monospace, monospace';
      for(const M of manifests){
        const P=W.programBy(M.type,M.id);if(!P)continue;
        for(const R of P.regions){
          const x=X(R.x),y=Y(R.y),rr=Math.max(3,Math.min(9,R.radius*zoom*.14));
          ctx.beginPath();ctx.arc(x,y,rr,0,Math.PI*2);
          ctx.fillStyle=R.role==='core'?'rgba(255,255,255,.95)':R.role==='void'?'rgba(255,95,95,.92)':'rgba(90,220,255,.9)';ctx.fill();
          if(zoom>=.8){ctx.fillStyle='rgba(230,250,255,.95)';ctx.fillText(R.role,x+rr+3,y-rr);}
        }
      }
    }

    if(opts.dnaDebug){
      ctx.setLineDash([7,5]);ctx.lineWidth=1.4;ctx.strokeStyle='rgba(210,120,255,.85)';
      ctx.fillStyle='rgba(235,190,255,.95)';ctx.font='11px ui-monospace, monospace';
      for(const P of plans){
        rect(P.bounds);
        if(zoom>=0.7)ctx.fillText(P.dnaKey,X(P.bounds[0])+4,Y(P.bounds[1])+13);
      }
      ctx.setLineDash([]);
    }
    if(opts.candidateRoutes){
      ctx.setLineDash([4,5]);ctx.lineWidth=1;ctx.strokeStyle='rgba(235,235,235,.38)';
      for(const P of plans)for(const D of P.demands){
        ctx.beginPath();ctx.arc(X(D.x),Y(D.y),3,0,Math.PI*2);ctx.stroke();
        if(zoom>=1.5){ctx.fillStyle='rgba(255,255,255,.85)';ctx.font='9px monospace';ctx.fillText(D.role+' '+Math.round(D.distance)+'m',X(D.x)+5,Y(D.y)-4);}
      }
      ctx.setLineDash([]);
    }
    if(opts.selectedRoutes){
      const col={primary:'rgba(255,70,210,.95)',secondary:'rgba(70,220,255,.95)',local:'rgba(150,245,120,.95)',service:'rgba(255,170,55,.95)'};
      const lw={primary:3.2,secondary:2.2,local:1.6,service:1.8};
      for(const P of plans)for(const R of P.routes){
        ctx.strokeStyle=col[R.hierarchy];ctx.lineWidth=lw[R.hierarchy];ctx.setLineDash(R.hierarchy==='service'?[5,3]:[]);
        seg(R.axis,R.line,R.s0,R.s1);
      }
      ctx.setLineDash([]);
    }
    if(opts.routeSpace){
      // Draw full canonical footprints without generating a single interior.
      // No territory clipping or route movement occurs in this stage.
      ctx.fillStyle='rgba(90,255,155,.32)';ctx.strokeStyle='rgba(90,255,155,.85)';ctx.lineWidth=1;
      for(const P of plans)for(const R of P.routes){const q=R.rect;
        ctx.fillRect(X(q[0]),Y(q[1]),(q[2]-q[0])*zoom,(q[3]-q[1])*zoom);rect(q);
      }
    }
    if(opts.structureNodes){
      for(const P of plans){
        for(const n of P.nodes){
          ctx.beginPath();ctx.arc(X(n.x),Y(n.y),n.kind==='junction'?4:3,0,Math.PI*2);
          ctx.fillStyle=n.kind==='junction'?'rgba(255,255,255,.95)':n.kind==='turn'?'rgba(110,220,255,.95)':'rgba(255,100,220,.95)';ctx.fill();
        }
        for(const a of P.anchors){
          const x=X(a.x),y=Y(a.y);ctx.fillStyle='rgba(255,225,80,.95)';ctx.fillRect(x-5,y-5,10,10);
          if(zoom>=1.1){ctx.fillStyle='rgba(255,245,180,.95)';ctx.font='11px ui-monospace, monospace';ctx.fillText(a.kind,x+7,y-7);}
        }
      }
    }

    const terrs=W.territoriesIn(cx-hw-20,cy-hh-20,cx+hw+20,cy+hh+20);
    if(opts.buildableSpace){
      ctx.fillStyle='rgba(100,180,255,.12)';ctx.strokeStyle='rgba(100,180,255,.8)';ctx.lineWidth=1;
      for(const T of terrs){const I=W.interiors.get(T.key);if(!I)continue;
        for(const q of I.buildableSpace||[]){ctx.fillRect(X(q[0]),Y(q[1]),(q[2]-q[0])*zoom,(q[3]-q[1])*zoom);rect(q);}
      }
    }
    if(opts.obligations){
      ctx.setLineDash([3,2]);ctx.lineWidth=2.4;ctx.strokeStyle='rgba(255,235,70,.9)';
      for(const T of terrs){const I=W.interiors.get(T.key);if(!I)continue;for(const o of I.obligations||[])seg(o.axis,o.line,o.s0,o.s1);}
      ctx.setLineDash([]);
    }
    if(opts.realizedRoutes||opts.routeFailures){
      for(const T of terrs){
        const I=W.interiors.get(T.key);if(!I)continue;
        for(const R of I.realizations||[]){
          if(R.status==='failed'){
            if(!opts.routeFailures)continue;
            const x=R.axis==='x'?(R.s0+R.s1)/2:R.line,y=R.axis==='x'?R.line:(R.s0+R.s1)/2,X0=X(x),Y0=Y(y);
            ctx.strokeStyle='rgba(255,65,65,.98)';ctx.lineWidth=2.5;ctx.beginPath();ctx.moveTo(X0-6,Y0-6);ctx.lineTo(X0+6,Y0+6);ctx.moveTo(X0+6,Y0-6);ctx.lineTo(X0-6,Y0+6);ctx.stroke();
            if(zoom>=1.5){ctx.fillStyle='rgba(255,170,170,.98)';ctx.font='10px ui-monospace, monospace';ctx.fillText(R.reason||'failed',X0+8,Y0-7);}
            continue;
          }
          if(!opts.realizedRoutes&&!opts.routeFailures)continue;
          if(opts.realizedRoutes){
            ctx.strokeStyle=R.status==='adapted'?'rgba(255,185,60,.98)':'rgba(80,255,130,.9)';
            ctx.lineWidth=R.status==='adapted'?2.6:1.8;ctx.setLineDash(R.status==='adapted'?[5,2]:[]);
            for(const q of R.rects)rect(q);
          }
          if(opts.routeFailures&&R.status==='adapted'){
            const x=R.axis==='x'?(R.s0+R.s1)/2:R.line,y=R.axis==='x'?R.line:(R.s0+R.s1)/2;
            ctx.fillStyle='rgba(255,190,70,.98)';ctx.beginPath();ctx.arc(X(x),Y(y),4,0,Math.PI*2);ctx.fill();
          }
        }
      }
      ctx.setLineDash([]);
    }
    if(opts.spaceParcels||opts.spaceAccess||opts.localCirculation||opts.spaceViolations){
      for(const T of terrs){
        const I=W.interiors.get(T.key);if(!I||!I.spacePlan)continue;
        if(opts.localCirculation){
          ctx.setLineDash([6,3]);ctx.lineWidth=2.5;ctx.strokeStyle='rgba(150,245,120,.95)';
          for(const R of I.realizations||[])if(R.hierarchy==='local')for(const q of R.rects)rect(q);
          ctx.setLineDash([]);
        }
        for(const p of I.spacePlan.parcels||[]){
          const q=p.q,m=p.meta||{},cxp=(q[0]+q[2])/2,cyp=(q[1]+q[3])/2;
          if(opts.spaceParcels){
            ctx.lineWidth=1.2;ctx.setLineDash(m.role==='support'?[3,2]:[]);
            ctx.strokeStyle=m.role==='support'?'rgba(255,190,90,.9)':'rgba(130,255,205,.82)';rect(q);ctx.setLineDash([]);
          }
          if(opts.spaceAccess&&m.frontSide){
            let tx=cxp,ty=cyp;
            if(m.frontSide==='x0')tx=q[0];else if(m.frontSide==='x1')tx=q[2];
            else if(m.frontSide==='y0')ty=q[1];else if(m.frontSide==='y1')ty=q[3];
            ctx.strokeStyle='rgba(90,210,255,.85)';ctx.lineWidth=1.2;ctx.beginPath();ctx.moveTo(X(cxp),Y(cyp));ctx.lineTo(X(tx),Y(ty));ctx.stroke();
          }
          if(opts.spaceViolations&&m.violations&&m.violations.length){
            const x=X(cxp),y=Y(cyp);ctx.strokeStyle='rgba(255,65,65,.98)';ctx.lineWidth=2;
            ctx.beginPath();ctx.moveTo(x-4,y-4);ctx.lineTo(x+4,y+4);ctx.moveTo(x+4,y-4);ctx.lineTo(x-4,y+4);ctx.stroke();
            if(zoom>=1.4){ctx.fillStyle='rgba(255,175,175,.98)';ctx.font='10px ui-monospace, monospace';ctx.fillText(m.violations.join(','),x+6,y-5);}
          }
        }
      }
    }
    if(opts.continuations){
      const seen=new Set();ctx.lineWidth=5;ctx.strokeStyle='rgba(80,255,120,.98)';
      for(const T of terrs)for(const n of W.adj(T)){
        const k=BR.pairKey(T,n.U);if(seen.has(k))continue;seen.add(k);
        const B=W.boundaries.get(k);if(!B)continue;
        for(const c of B.continuations||[]){
          ctx.beginPath();
          if(c.o==='v'){ctx.moveTo(X(c.x),Y(c.s0));ctx.lineTo(X(c.x),Y(c.s1));}
          else{ctx.moveTo(X(c.s0),Y(c.y));ctx.lineTo(X(c.s1),Y(c.y));}
          ctx.stroke();
        }
      }
    }
  }

  // ------------------------------------------------------------ far raster
  /**
   * Very far zoom: no territories at all, just the base area field sampled
   * every few device pixels (pockets are sub-pixel there anyway), with a
   * darker edge where the area changes.
   */
  const EDGE_RGB = BR.hexToRgb(CROSS_WALL);
  function drawRaster(ctx, W, view) {
    const { cx, cy, zoom, w, h, dpr } = view;
    const PW = Math.round(w * dpr), PH = Math.round(h * dpr), st = 4, m = zoom * dpr;
    const nx = Math.ceil(PW / st) + 1, ny = Math.ceil(PH / st) + 1;
    const x0 = cx - w / 2 / zoom, y0 = cy - h / 2 / zoom;
    const area = new Array(nx * ny), col = new Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const x = x0 + (i * st + st / 2) / m, y = y0 + (j * st + st / 2) / m, a = BR.areaAt(W, x, y).area;
      area[j * nx + i] = a; col[j * nx + i] = BR.areaColor(W.seed, a, x, y, 0.5);
    }
    const img = ctx.createImageData(PW, PH), D = img.data;
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const k = j * nx + i, edge = area[k] !== area[k + 1] || area[k] !== area[k + nx];
      const c = edge ? mixRgb(col[k], EDGE_RGB, 0.65) : col[k];
      for (let y = j * st; y < Math.min(PH, j * st + st); y++) for (let x = i * st; x < Math.min(PW, i * st + st); x++) {
        const o = (y * PW + x) * 4;
        D[o] = c[0]; D[o + 1] = c[1]; D[o + 2] = c[2]; D[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  // --------------------------------------------------------------- tiles
  /**
   * The world is drawn into cached 256 px tiles at zoom levels 2^(k/2) (the
   * level at or above the view zoom, so tiles are only ever scaled down), and
   * each frame just blits them. A tile whose generation ran out of time is
   * kept as a draft and redrawn later. Hover and labels are drawn on top per
   * frame.
   */
  const TILE = 256, RASTER_BELOW = 0.4, MAX_TILES = 220;
  function tileCache(W) {
    if (!W._tiles) W._tiles = { map: new Map(), pool: [] };
    return W._tiles;
  }
  function getCanvas(TC) {
    const c = TC.pool.pop();
    if (c) return c;
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(TILE, TILE);
    const e = document.createElement('canvas'); e.width = TILE; e.height = TILE;
    return e;
  }
  function levelFor(zoom, dpr) {
    const lv = Math.ceil(2 * Math.log2(zoom * dpr) - 1e-9) / 2;
    return { lv, tz: Math.pow(2, lv) };                 // device px per metre
  }

  function draw(ctx, W, view, opts, budgetMs) {
    const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
    const now = () => (typeof performance !== 'undefined' ? performance : Date).now() - t0;
    const { cx, cy, zoom, w, h, dpr } = view;
    const { lv, tz } = levelFor(zoom, dpr), zl = tz / dpr, S = TILE / tz;     // tile size in metres
    const raster = zl < RASTER_BELOW;
    const detail = !raster && !opts.areaMap && zl >= LOD.interiors;
    const flags = [raster ? 'r' : detail ? 'd' : 'p', opts.walls === false ? 0 : 1, opts.areaMap ? 1 : 0,
      opts.territories && !raster ? 1 : 0, opts.cells && !raster ? 1 : 0, opts.rooms && detail ? 1 : 0].join('');
    const TC = tileCache(W);
    const hw = w / 2 / zoom, hh = h / 2 / zoom;
    const tx0 = Math.floor((cx - hw) / S), tx1 = Math.floor((cx + hw) / S), ty0 = Math.floor((cy - hh) / S), ty1 = Math.floor((cy + hh) / S);
    const list = [];
    for (let tx = tx0; tx <= tx1; tx++) for (let ty = ty0; ty <= ty1; ty++) {
      const dx = (tx + 0.5) * S - cx, dy = (ty + 0.5) * S - cy;
      list.push({ tx, ty, d: dx * dx + dy * dy });
    }
    list.sort((a, b) => a.d - b.d || a.tx - b.tx || a.ty - b.ty);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, Math.round(w * dpr), Math.round(h * dpr));
    ctx.imageSmoothingEnabled = true;
    const m = zoom * dpr, X = (x) => Math.round((x - cx) * m + w * dpr / 2), Y = (y) => Math.round((y - cy) * m + h * dpr / 2);
    let done = true, built = 0;
    const blit = (c, wx0, wy0, wx1, wy1, sx, sy, sw, sh) => {
      const a = X(wx0), b = Y(wy0);
      ctx.drawImage(c, sx, sy, sw, sh, a, b, X(wx1) - a, Y(wy1) - b);
    };
    for (const t of list) {
      const key = lv + '|' + t.tx + '|' + t.ty + '|' + flags;
      let e = TC.map.get(key);
      if (e) { TC.map.delete(key); TC.map.set(key, e); }
      if ((!e || !e.complete) && now() < budgetMs) {
        const c = e ? e.canvas : getCanvas(TC), g = c.getContext('2d');
        const tv = { cx: (t.tx + 0.5) * S, cy: (t.ty + 0.5) * S, zoom: zl, w: TILE / dpr, h: TILE / dpr, dpr };
        let complete = true;
        if (raster) drawRaster(g, W, tv);
        else complete = drawWorld(g, W, tv, opts, Math.max(1, budgetMs - now())).done;
        if (!e) { e = { canvas: c }; TC.map.set(key, e); }
        e.complete = complete;
        built++;
        while (TC.map.size > MAX_TILES) {
          const k0 = TC.map.keys().next().value;
          TC.pool.push(TC.map.get(k0).canvas); TC.map.delete(k0);
        }
      }
      const wx0 = t.tx * S, wy0 = t.ty * S;
      if (e) { blit(e.canvas, wx0, wy0, wx0 + S, wy0 + S, 0, 0, TILE, TILE); if (!e.complete) done = false; continue; }
      done = false;
      // not drawn yet: borrow from a coarser cached level if there is one
      for (let up = 1; up <= 6; up++) {
        const L = lv - up / 2, f = Math.pow(2, up / 2), Sp = S * f;
        if (Math.abs(f - Math.round(f)) > 1e-9) continue;            // only whole-ratio parents line up
        const px = Math.floor(t.tx / f), py = Math.floor(t.ty / f), pe = TC.map.get(L + '|' + px + '|' + py + '|' + flags);
        if (!pe) continue;
        const sx = ((wx0 - px * Sp) / Sp) * TILE, sy = ((wy0 - py * Sp) / Sp) * TILE;
        blit(pe.canvas, wx0, wy0, wx0 + S, wy0 + S, sx, sy, TILE / f, TILE / f);
        e = pe;
        break;
      }
      // ... or from the finer level just zoomed out of
      if (!e) for (let q = 0; q < 4; q++) {
        const cx2 = 2 * t.tx + (q & 1), cy2 = 2 * t.ty + (q >> 1), ce = TC.map.get((lv + 1) + '|' + cx2 + '|' + cy2 + '|' + flags);
        if (ce) blit(ce.canvas, cx2 * S / 2, cy2 * S / 2, (cx2 + 1) * S / 2, (cy2 + 1) * S / 2, 0, 0, TILE, TILE);
      }
    }

    // ---- per-frame generation diagnostics are deliberately not tile-cached.
    // They expose live planner/interior/boundary state without rebuilding tiles.
    drawGenerationDebug(ctx, W, view, opts);

    // ---- per frame: hover outline, area names
    const px = (p) => p / zoom;
    const anchor = (ax, ay) => ctx.setTransform(m, 0, 0, m, ((ax - cx) * zoom + w / 2) * dpr, ((ay - cy) * zoom + h / 2) * dpr);
    if (opts.hover && !raster) {
      const T = W.terr(opts.hover);
      if (T) { const g = planGfx(W, T); anchor(g.ax, g.ay); ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.lineWidth = px(2.5); ctx.lineJoin = 'miter'; ctx.stroke(g.all); }
    }
    if (!detail) drawLabels(ctx, W, view);
    return { done, tiles: list.length, built, mode: raster ? 'raster' : detail ? 'detail' : 'plan', level: zl };
  }

  /** Area names: one per district (at its centre), and 'Backrooms' in district-free lattice cells. */
  function drawLabels(ctx, W, view) {
    const { cx, cy, zoom, w, h, dpr } = view;
    const C = BR.AREA_CFG.districtCell, hw = w / 2 / zoom, hh = h / 2 / zoom;
    if (C * zoom < 70) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    const put = (label, x, y, r) => {
      const X = (x - cx) * zoom + w / 2, Y = (y - cy) * zoom + h / 2;
      if (X < -100 || X > w + 100 || Y < -40 || Y > h + 40) return;
      const size = Math.round(clamp(r * zoom / 7, 11, 22));
      ctx.font = '600 ' + size + 'px ui-sans-serif, system-ui, sans-serif';
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(30,28,25,0.75)'; ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.strokeText(label, X, Y); ctx.fillText(label, X, Y);
    };
    for (let a = Math.floor((cx - hw) / C) - 1; a <= Math.floor((cx + hw) / C) + 1; a++)
      for (let b = Math.floor((cy - hh) / C) - 1; b <= Math.floor((cy + hh) / C) + 1; b++) {
        const d = BR.districtSeed(W.seed, a, b);
        if (d.exists) {
          if (BR.areaAt(W, d.cx, d.cy).district === d.id) put(BR.AREAS[d.type].name, d.cx, d.cy, Math.min(d.rx, d.ry));
        } else {
          // a few scattered 'Backrooms' labels in district-free cells
          const h = BR.hash4(W.seed, a, b, 0x1abe1);
          if ((h & 255) > 100) continue;
          const x = (a + 0.2 + 0.6 * ((h >>> 8) & 255) / 255) * C, y = (b + 0.2 + 0.6 * ((h >>> 16) & 255) / 255) * C;
          if (BR.areaAt(W, x, y).area === 'backrooms') put(BR.AREAS.backrooms.name, x, y, C * 0.3);
        }
      }
  }

  BR.draw = draw;
  BR.drawWorld = drawWorld;
  BR.BG = BG;
  BR.LOD = LOD;
})(typeof window !== 'undefined' ? window : globalThis);
