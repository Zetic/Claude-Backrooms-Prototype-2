/*
 * structure.js - district-scale structure between architecture DNA and local
 * territory interiors. Major architecture is selected in world space first;
 * territories only realize the portion that crosses their owned rectangles.
 */
(function (root) {
  'use strict';
  const BR = root.BR;
  const { Rng, hash4 } = BR;
  const S = { PLAN: 0x5a71 };
  // Any district-role semantic area can use the same structure pipeline.
  // Area definitions tune manifestation/program weights; structure code does
  // not branch on semantic names.
  const PLANNED = new Set(Object.keys(BR.AREAS).filter((k) => BR.AREAS[k].role === 'district'));
  const PRI = { major: 0, secondary: 1, service: 2 };

  function lineCandidates(dna, d) {
    const B=d.bounds||[d.cx-d.rx,d.cy-d.ry,d.cx+d.rx,d.cy+d.ry];
    const ix=Math.min(12,(B[2]-B[0])*.05),iy=Math.min(12,(B[3]-B[1])*.05);
    const bx=[B[0]+ix,B[2]-ix],by=[B[1]+iy,B[3]-iy],out=[];
    const add = (axis, spacing, phase, lo, hi, s0, s1, kind) => {
      for (let k = Math.ceil((lo - phase) / spacing); k <= Math.floor((hi - phase) / spacing); k++)
        out.push({ id: dna.key + '|candidate|' + kind + '|' + axis + '|' + (phase + k * spacing),
          kind, axis, line: phase + k * spacing, s0, s1 });
    };
    if (dna.majorAxis === 'x') {
      add('x', dna.spineSpacing, dna.spinePhase, by[0], by[1], bx[0], bx[1], 'spine');
      add('y', dna.crossSpacing, dna.crossPhase, bx[0], bx[1], by[0], by[1], 'cross');
    } else {
      add('y', dna.spineSpacing, dna.spinePhase, bx[0], bx[1], by[0], by[1], 'spine');
      add('x', dna.crossSpacing, dna.crossPhase, by[0], by[1], bx[0], bx[1], 'cross');
    }
    return { bounds: [bx[0], by[0], bx[1], by[1]], lines: out };
  }
  const nearest = (a, v) => a.slice().sort((x, y) => Math.abs(x.line - v) - Math.abs(y.line - v) || x.line - y.line);
  const route = (key, n, hierarchy, axis, line, s0, s1, width, role) => {
    // Territory geometry is integer-metre. Quantize finite route termini too,
    // otherwise a 0.07 m remainder at a terminus can become a meaningless
    // micro-room when the local partition is cut around the route.
    s0 = Math.round(s0); s1 = Math.round(s1);
    return { id: key + '|route|' + n, hierarchy, axis, line: Math.round(line),
      s0: Math.min(s0, s1), s1: Math.max(s0, s1), width, role };
  };
  const point = (R, start) => R.axis === 'x' ? [start ? R.s0 : R.s1, R.line] : [R.line, start ? R.s0 : R.s1];
  function intersection(A, B) {
    if (A.axis === B.axis) return null;
    const H = A.axis === 'x' ? A : B, V = A.axis === 'y' ? A : B;
    return V.line >= H.s0 && V.line <= H.s1 && H.line >= V.s0 && H.line <= V.s1 ? [V.line, H.line] : null;
  }

  function buildDistrictStructure(W, area, district) {
    if (!PLANNED.has(area) || !district) return null;
    const ij = district.split(','), a = +ij[0], b = +ij[1], d = BR.districtSeed(W.seed, a, b);
    if (!d.exists || d.type !== area) return null;
    const dna = BR.architectureDNA(W, { district, cx: d.cx, cy: d.cy, base: area }, area);
    const program = W.programBy ? W.programBy(area, district) : BR.buildManifestationProgram(W, area, district);
    if (!program) return null;
    const areaId=Math.max(1,BR.AREA_ORDER.indexOf(area)+1);
    const C = lineCandidates(dna, d), rng = new Rng(hash4(W.seed, a, b, S.PLAN ^ Math.imul(areaId,0x9e37)));
    const majors = nearest(C.lines.filter((x) => x.kind === 'spine'), dna.majorAxis === 'x' ? d.cy : d.cx);
    const crosses = nearest(C.lines.filter((x) => x.kind === 'cross'), dna.majorAxis === 'x' ? d.cx : d.cy);
    const key = 'structure:' + area + ':' + district, routes = [];
    const along0 = dna.majorAxis === 'x' ? C.bounds[0] : C.bounds[1], along1 = dna.majorAxis === 'x' ? C.bounds[2] : C.bounds[3];
    const perp0 = dna.majorAxis === 'x' ? C.bounds[1] : C.bounds[0], perp1 = dna.majorAxis === 'x' ? C.bounds[3] : C.bounds[2];
    const centerAlong = dna.majorAxis === 'x' ? d.cx : d.cy, centerPerp = dna.majorAxis === 'x' ? d.cy : d.cx;
    let rn = 0;
    const trunkLine = majors.length ? majors[0].line : centerPerp;
    const trunk = route(key, rn++, 'major', dna.majorAxis, trunkLine,
      centerAlong - (centerAlong - along0) * 0.92, centerAlong + (along1 - centerAlong) * 0.92,
      dna.corridorWidth, 'trunk');
    routes.push(trunk);

    let wing = null;
    const sideMajors = majors.filter((m) => m.line !== trunkLine);
    const perpTargets=program.regions.filter((r)=>r.role==='branch'||r.role==='repeating'||r.role==='open')
      .map((r)=>dna.majorAxis==='x'?r.y:r.x);
    if (perp1 - perp0 > dna.spineSpacing * 2.25 && sideMajors.length && d.form !== 'fragmented') {
      const target=perpTargets.length?perpTargets[Math.floor(perpTargets.length/2)]:centerPerp+(rng.f()<.5?-dna.spineSpacing:dna.spineSpacing);
      const m = nearest(sideMajors, target)[0];
      const inset = (along1 - along0) * rng.range(0.10, 0.20);
      wing = route(key, rn++, 'major', dna.majorAxis, m.line, along0 + inset, along1 - inset, dna.corridorWidth, 'wing');
      routes.push(wing);
    }

    const usable = crosses.filter((c) => c.line > along0 + 12 && c.line < along1 - 12);
    const scaleMul={small:.65,medium:1,large:1.25,regional:1.5}[d.scale]||1;
    const baseWant=Math.max(1,Math.round((along1-along0)/Math.max(85,dna.crossSpacing*1.8)));
    const want=Math.min(5,Math.max(1,Math.round(baseWant*program.routeDensity*scaleMul)));
    const selected = [];
    const alongTargets=program.regions.filter((r)=>r.role!=='void'&&r.role!=='service')
      .map((r)=>dna.majorAxis==='x'?r.x:r.y);
    for(const target of alongTargets){
      const c=nearest(usable,target).find((q)=>!selected.some((p)=>Math.abs(p.line-q.line)<Math.max(18,dna.crossSpacing*.6)));
      if(c)selected.push(c);
      if(selected.length>=want)break;
    }
    for (const c of nearest(usable, centerAlong)) {
      if (selected.length >= want) break;
      if (selected.some((q) => Math.abs(q.line - c.line) < Math.max(18, dna.crossSpacing * 0.6))) continue;
      selected.push(c);
    }
    if (!selected.length && crosses.length) selected.push(crosses[0]);
    // A bridge must cross both major routes, not merely share a candidate
    // lattice line somewhere in the manifestation bounds.
    if (wing) {
      const lo=Math.max(trunk.s0,wing.s0),hi=Math.min(trunk.s1,wing.s1);
      const bridge=nearest(usable.filter((c)=>c.line>=lo&&c.line<=hi),centerAlong)[0];
      if (bridge) {
        const j=selected.findIndex((c)=>c.line===bridge.line);
        if(j>=0)selected.splice(j,1);
        selected.unshift(bridge);
      }
    }
    for (let i = 0; i < selected.length; i++) {
      const c = selected[i], axis = dna.majorAxis === 'x' ? 'y' : 'x';
      let a0, a1, role;
      if (i === 0 && wing) { a0 = trunkLine; a1 = wing.line; role = 'bridge'; }
      else {
        const side = ((hash4(W.seed, a, b, 0x7300 + i) & 1) ? 1 : -1);
        a0 = trunkLine; a1 = side < 0 ? perp0 + rng.range(8, 20) : perp1 - rng.range(8, 20); role = 'branch';
      }
      routes.push(route(key, rn++, 'secondary', axis, c.line, a0, a1, dna.corridorWidth, role));
    }

    const hasService=program.regions.some((r)=>r.role==='service');
    if (selected.length && (perp1 - perp0) > 45 && (hasService || program.routeDensity > 0.8)) {
      const side = (hash4(W.seed, a, b, 0x51ce) & 1) ? 1 : -1;
      let serviceLine = trunkLine + side * (dna.corridorWidth + dna.module * rng.int(2, 3));
      serviceLine = Math.max(perp0 + 4, Math.min(perp1 - 4, serviceLine));
      const c = selected[0].line, halfSpan = (along1 - along0) * rng.range(0.16, 0.24);
      routes.push(route(key, rn++, 'service', dna.majorAxis, serviceLine,
        Math.max(along0 + 6, c - halfSpan), Math.min(along1 - 6, c + halfSpan), Math.max(2, dna.corridorWidth), 'service'));
      routes.push(route(key, rn++, 'service', dna.majorAxis === 'x' ? 'y' : 'x', c,
        trunkLine, serviceLine, Math.max(2, dna.corridorWidth), 'service-spur'));
    }

    const nodes = [];
    for (let i = 0; i < routes.length; i++) for (let j = i + 1; j < routes.length; j++) {
      const p = intersection(routes[i], routes[j]);
      if (p && !nodes.some((n) => Math.abs(n.x - p[0]) < 0.01 && Math.abs(n.y - p[1]) < 0.01))
        nodes.push({ x: p[0], y: p[1], kind: 'junction', routes: [routes[i].id, routes[j].id] });
    }
    for (const R of routes) for (const start of [true, false]) {
      const p = point(R, start);
      if (!nodes.some((n) => Math.hypot(n.x - p[0], n.y - p[1]) < 0.01))
        nodes.push({ x: p[0], y: p[1], kind: 'terminus', routes: [R.id] });
    }

    // Structural-region roles are semantic-neutral. A role becomes a concrete
    // zone through the area's normal zone catalogue and generic role biases.
    const anchors=[];
    const ranked=program.regions.filter((r)=>['core','open','landmark','terminal','void'].includes(r.role))
      .sort((u,v)=>{
        const p={core:0,landmark:1,open:2,terminal:3,void:4};
        return (p[u.role]-p[v.role])||((u.id<v.id)?-1:1);
      });
    const anchorLimit=d.scale==='small'?1:d.scale==='medium'?2:3;
    for(const R of ranked.slice(0,anchorLimit)){
      anchors.push({id:key+'|anchor|'+anchors.length,x:R.x,y:R.y,kind:R.role,
        zone:BR.programPreferredZone(area,R.role),programRegion:R.id});
    }

    return { key, area, district, manifestation:d, programKey:program.key, program,
      dnaKey:dna.key, dna, districtSeed:d, bounds:C.bounds, candidates:C.lines, routes, nodes, anchors };
  }

  function routePiece(R, q, ri) {
    const h=R.width/2;
    if (R.axis==='x') {
      if (R.line < q[1]-h || R.line > q[3]+h) return null;
      const s0=Math.max(R.s0,q[0]), s1=Math.min(R.s1,q[2]); if(s1-s0<0.75)return null;
      return {routeId:R.id,hierarchy:R.hierarchy,role:R.role,axis:'x',line:R.line,width:R.width,s0,s1,
        globalS0:R.s0,globalS1:R.s1,rectIndex:ri,enters:R.s0<s0+1e-9,exits:R.s1>s1-1e-9};
    }
    if (R.line < q[0]-h || R.line > q[2]+h) return null;
    const s0=Math.max(R.s0,q[1]), s1=Math.min(R.s1,q[3]); if(s1-s0<0.75)return null;
    return {routeId:R.id,hierarchy:R.hierarchy,role:R.role,axis:'y',line:R.line,width:R.width,s0,s1,
      globalS0:R.s0,globalS1:R.s1,rectIndex:ri,enters:R.s0<s0+1e-9,exits:R.s1>s1-1e-9};
  }

  function territoryStructure(W,T,rects){
    const area=W.final(T);
    if(!PLANNED.has(area)||!T.district)return {plan:null,routes:[],anchors:[]};
    const P=W.structureBy(area,T.district); if(!P)return {plan:null,routes:[],anchors:[]};
    rects=rects||T.rects; const routes=[];
    for(const R of P.routes)for(let ri=0;ri<rects.length;ri++){const p=routePiece(R,rects[ri],ri);if(p)routes.push(p);}
    const anchors=P.anchors.filter((a)=>rects.some((q)=>a.x>=q[0]&&a.x<=q[2]&&a.y>=q[1]&&a.y<=q[3]));
    routes.sort((a,b)=>(PRI[a.hierarchy]-PRI[b.hierarchy])||(a.routeId<b.routeId?-1:1)||a.rectIndex-b.rectIndex);
    return {plan:P,routes,anchors};
  }
  Object.assign(BR,{STRUCTURE_AREAS:PLANNED,STRUCTURE_PRIORITY:PRI,buildDistrictStructure,territoryStructure});
})(typeof window!=='undefined'?window:globalThis);
