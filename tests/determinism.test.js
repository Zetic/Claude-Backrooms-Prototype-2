/*
 * Generator checks (run: node tests/determinism.test.js [seed])
 *
 * Determinism - the same seed + region gives byte-identical output no matter
 *   - what was generated before (visit order),
 *   - whether caches were evicted mid-way (tiny cache limits),
 *   - which order territories are requested in,
 *   - how far from the origin the region is.
 * Structure
 *   - semantic identity is separated from deterministic spatial manifestation,
 *   - manifestation footprints/programs are deterministic and structurally diverse,
 *   - territories tile the plane exactly (no gaps, no overlaps),
 *   - mixed-area transitions never inject maintenance bands; pockets remain
 *     independent Maintenance/Home territories with normal front-door logic,
 *   - manifestation structure plans are connected and deterministic,
 *   - route obligations are explicitly realized/adapted/failed,
 *   - structural continuations remove only their seam interval,
 *   - every room in a large region is reachable from every other.
 */
const path = require('path');
for (const f of ['core', 'areas', 'manifestation', 'layout', 'structure', 'spaceplan', 'zones', 'interior', 'boundary', 'world'])
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
    P[T.key] = [T.rects, W.final(T), T.base, T.district, T.manifestationForm, T.manifestationScale].map(String).join(';');
    I[T.key] = JSON.stringify({
      manifestation: it.manifestation ? [it.manifestation.id,it.manifestation.form,it.manifestation.scale,it.manifestation.lobes.length,it.manifestation.holes.length] : null,
      program: it.programKey || null,
      structure: it.structureKey || null,
      obligations: (it.obligations || []).map((o) => [o.routeId,o.hierarchy,o.axis,r6(o.line),r6(o.s0),r6(o.s1),r6(o.width)]),
      realizations: (it.realizations || []).map((r) => [r.routeId,r.status,r.reason,r6(r.shift),r.rects.map((q)=>q.map(r6))]),
      space: (it.spacePlan && it.spacePlan.parts || []).map((p) => ({
        key:p.key,
        local:(p.localRoutes||[]).map((r)=>[r.routeId,r.q.map(r6)]),
        parcels:(p.parcels||[]).map((x)=>[x.q.map(r6),x.meta.frontSide,x.meta.access,x.meta.role,
          r6(x.meta.frontage),r6(x.meta.depth),x.meta.violations.slice()])
      })),
      blocks: it.blocks.map((b) => [b.x0, b.y0, b.x1, b.y1, b.k, it.zones[b.z].type,
        (b.flows || (b.flow ? [b.flow] : [])).map((f) => f.key).sort(), b.programRole || null,
        b.space ? [b.space.frontSide,b.space.access,b.space.role,r6(b.space.frontage),r6(b.space.depth),b.space.violations.slice()] : null]),
      rooms: it.rooms.map((r) => r.kind + ':' + r.rects.map((q) => q.map(r6).join(',')).join('/')),
      links: it.links.map((l) => [l.a, l.b, r6(l.x), r6(l.y), r6(l.w), l.kind]),
      geo: ['walls', 'minor', 'hatch', 'masses', 'voids', 'pools', 'props', 'rounds', 'pillars'].map((k) => it[k].map(r6))
    });
    for (const n of W.adj(T)) {
      const k = BR.pairKey(T, n.U);
      if (B[k]) continue;
      const b = W.boundary(T, n.U);
      B[k] = JSON.stringify([b.wall, b.semantic, b.walls.map(r6), b.doors.map((d) => [r6(d.x), r6(d.y), r6(d.w), d.o, d.kind]),
        (b.continuations || []).map((c) => [c.flow,c.kind,c.o,r6(c.s0),r6(c.s1)]),
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
  const W = new BR.World(SEED, { limits: { plans: 12, interiors: 8, boundaries: 16, pairs: 40, dna: 4, programs: 2, structures: 2 } });
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
  const W = new BR.World(SEED, { limits: { plans: 12, interiors: 8, boundaries: 16, pairs: 40, dna: 4, programs: 2, structures: 2 } });
  W.collect(0, 0, 100, 100, Infinity, { interiors: true });
  check('far from the origin (1e6 m) still deterministic', snapshot(W, ...F) === a);
}
check('different seeds differ', snapshot(new BR.World(SEED + 1), ...R) !== base);

// ------------------------------------------------ manifestations & programs

{
  const W = new BR.World(SEED);
  const manifests = W.manifestationsIn(-1800,-1800,1800,1800);
  const forms = new Set(manifests.map((m)=>m.form)), scales = new Set(manifests.map((m)=>m.scale));
  const multi = manifests.filter((m)=>m.lobes.length>1).length;
  const porous = manifests.filter((m)=>m.holes.length>0).length;
  const byArea = new Map();
  for(const M of manifests){
    if(!byArea.has(M.type))byArea.set(M.type,new Set());
    byArea.get(M.type).add(M.form);
  }
  const variedAreas=[...byArea.values()].filter((x)=>x.size>=2).length;
  check('manifestation field uses multiple generic footprint grammars', forms.size>=4&&multi>0,
    `${manifests.length} manifestations, ${forms.size} forms, ${multi} multi-lobe`);
  check('manifestation scale is independent of semantic identity', scales.size>=2&&variedAreas>=2,
    `${scales.size} scales, ${variedAreas} semantic areas with multiple forms`);
  check('substrate can intrude into manifestations', porous>0, `${porous} manifestations with substrate cuts`);

  let stable=manifests.length>0, programStable=manifests.length>0, roles=new Set(), programAreas=new Set(), coreMissing=0;
  if(manifests.length){
    const M0=manifests[0], direct=BR.manifestationSeed(SEED,M0.a,M0.b);
    stable=JSON.stringify(direct)===JSON.stringify(M0);
    const P0=W.programBy(M0.type,M0.id);
    const W2=new BR.World(SEED,{limits:{plans:12,interiors:8,boundaries:16,pairs:40,dna:2,programs:1,structures:1}});
    for(const M of manifests.slice(1,6))W2.programBy(M.type,M.id);
    programStable=JSON.stringify(W2.programBy(M0.type,M0.id))===JSON.stringify(P0);
  }
  for(const M of manifests){
    const P=W.programBy(M.type,M.id);if(!P)continue;programAreas.add(M.type);
    if(!P.regions.some((r)=>r.role==='core'))coreMissing++;
    for(const R of P.regions)roles.add(R.role);
  }
  check('manifestations are deterministic independent of caches', stable&&programStable);
  check('generic structural programs span semantic areas and roles', programAreas.size>=3&&roles.size>=6&&coreMissing===0,
    `${programAreas.size} areas, ${roles.size} roles, ${coreMissing} missing cores`);
}

// ---------------------------------------------------- architecture DNA

{
  const W = new BR.World(SEED);
  const terrs = W.territoriesIn(-1600, -1600, 1600, 1600);
  const groups = new Map();
  for (const T of terrs) {
    const a = W.final(T);
    if (!T.district || !BR.AREAS[a] || BR.AREAS[a].role !== 'district') continue;
    const k = a + ':' + T.district;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(T);
  }
  const same = [...groups.values()].find((g) => g.length >= 3);
  let shared = false, stable = false;
  if (same) {
    const ds = same.slice(0, 3).map((T) => W.architecture(T));
    shared = ds.every((d) => d.key === ds[0].key && JSON.stringify(d) === JSON.stringify(ds[0]));
    const W2 = new BR.World(SEED, { limits: { plans: 12, interiors: 8, boundaries: 16, pairs: 40, dna: 1 } });
    stable = JSON.stringify(W2.architecture(W2.terr(same[0].key))) === JSON.stringify(ds[0]);
  }
  check('district architecture DNA persists across territories', !!same && shared);
  check('architecture DNA survives cache eviction', !!same && stable);

  const distinct = [];
  for (const g of groups.values()) {
    if (!g.length) continue;
    const d = W.architecture(g[0]);
    if (!distinct.some((x) => x.key === d.key)) distinct.push(d);
    if (distinct.length >= 6) break;
  }
  const signatures = new Set(distinct.map((d) => [d.majorAxis, d.corridorWidth, d.module, d.spineSpacing, d.spinePhase, d.crossSpacing, d.crossPhase].join(':')));
  check('different districts can have different architecture DNA', distinct.length >= 2 && signatures.size >= 2, `${distinct.length} districts, ${signatures.size} DNA signatures`);

  // ------------------------------------------------ district structure
  const plannedGroups = [...groups.values()].filter((g) => g.length && BR.AREAS[W.final(g[0])].role === 'district');
  const plans = [];
  for (const g of plannedGroups) {
    const P = W.structure(g[0]);
    if (P && !plans.some((x) => x.key === P.key)) plans.push(P);
    if (plans.length >= 8) break;
  }
  const canonPlan = (P) => JSON.stringify({
    key:P.key,dna:P.dnaKey,manifest:[P.manifestation.form,P.manifestation.scale],
    program:P.program.regions.map((r)=>[r.role,r.x,r.y,r.radius]),bounds:P.bounds.map(r6),
    candidates:P.candidates.map((r)=>[r.kind,r.axis,r6(r.line),r6(r.s0),r6(r.s1)]),
    routes:P.routes.map((r)=>[r.id,r.hierarchy,r.role,r.axis,r6(r.line),r6(r.s0),r6(r.s1),r.width]),
    nodes:P.nodes.map((n)=>[r6(n.x),r6(n.y),n.kind]),anchors:P.anchors.map((a)=>[a.id,r6(a.x),r6(a.y),a.kind,a.zone])
  });
  let planStable = plans.length > 0;
  if (plans.length) {
    const P0 = plans[0], W2 = new BR.World(SEED, { limits:{ plans:12, interiors:8, boundaries:16, pairs:40, dna:2, programs:1, structures:1 } });
    // Force unrelated structure cache churn before rebuilding the target.
    for (const P of plans.slice(1,5)) W2.structureBy(P.area,P.district);
    planStable = canonPlan(W2.structureBy(P0.area,P0.district)) === canonPlan(P0);
  }
  check('district structure plan survives cache eviction', planStable, `${plans.length} sampled plans`);

  const crosses = (A,B) => {
    if (A.axis === B.axis) return A.line === B.line && Math.min(A.s1,B.s1) >= Math.max(A.s0,B.s0);
    const H=A.axis==='x'?A:B,V=A.axis==='y'?A:B;
    return V.line>=H.s0&&V.line<=H.s1&&H.line>=V.s0&&H.line<=V.s1;
  };
  let disconnectedPlans=0, major=0, secondary=0, service=0, plannedAnchors=0;
  for (const P of plans) {
    major += P.routes.filter((r)=>r.hierarchy==='major').length;
    secondary += P.routes.filter((r)=>r.hierarchy==='secondary').length;
    service += P.routes.filter((r)=>r.hierarchy==='service').length;
    plannedAnchors += P.anchors.length;
    if (!P.routes.length) { disconnectedPlans++; continue; }
    const seenR=new Set([0]), stack=[0];
    while(stack.length){const a=stack.pop();for(let b=0;b<P.routes.length;b++)if(!seenR.has(b)&&crosses(P.routes[a],P.routes[b])){seenR.add(b);stack.push(b);}}
    if(seenR.size!==P.routes.length)disconnectedPlans++;
  }
  check('district route plans are connected', plans.length >= 2 && disconnectedPlans === 0, `${plans.length} plans, ${disconnectedPlans} disconnected`);
  check('plans contain major, secondary and service circulation', major>0&&secondary>0&&service>0, `major ${major}, secondary ${secondary}, service ${service}`);
  check('special-space anchors are attached to structure topology', plannedAnchors >= plans.length, `${plannedAnchors} anchors`);

  let obligations=0, exact=0, adapted=0, failed=0, badFlows=0, anchorObs=0, anchorAttached=0;
  for (const T of terrs) {
    const a=W.final(T); if(!BR.AREAS[a]||BR.AREAS[a].role!=='district')continue;
    const I=W.interior(T); if(!I.structureKey)continue;
    obligations += I.realizations.length;
    anchorObs += I.anchors.length; anchorAttached += I.blocks.filter((b)=>b.anchor).length;
    const routeIds=new Set(I.obligations.map((o)=>o.routeId));
    for(const r of I.realizations){
      if(r.status==='exact')exact++; else if(r.status==='adapted')adapted++; else failed++;
      if(r.status!=='failed'&&!I.blocks.some((b)=>(b.flows||(b.flow?[b.flow]:[])).some((f)=>f.key===r.routeId)))badFlows++;
      if(!routeIds.has(r.routeId))badFlows++;
    }
  }
  const realized=exact+adapted;
  check('territories realize district route obligations', obligations >= 200 && realized / obligations > 0.85 && badFlows===0,
    `${realized}/${obligations} realized; exact ${exact}, adapted ${adapted}, failed ${failed}`);
  check('route adaptation is exercised and explicit', adapted > 0 && failed >= 0, `${adapted} adapted, ${failed} failed`);
  check('planned anchors become local special spaces', anchorObs > 0 && anchorAttached / anchorObs > 0.8, `${anchorAttached}/${anchorObs} attached`);

  // ------------------------------------------------ local space planning
  const denseTypes=new Set(Object.keys(BR.SPACE_ARCHETYPES||{}));
  let plannedTerr=0,spaceParcels=0,localHalls=0,supportParcels=0,badParcel=0,badDense=0,guarded=0,badGuarded=0,capViolations=0;
  for(const T of terrs){
    const a=W.final(T); if(!BR.AREAS[a]||BR.AREAS[a].role!=='district')continue;
    const I=W.interior(T); if(!I.structureKey)continue; plannedTerr++;
    const SP=I.spacePlan;
    spaceParcels+=SP.diagnostics.parcels;localHalls+=SP.diagnostics.localRoutes;supportParcels+=SP.diagnostics.support;
    for(const part of SP.parts){
      if(part.parcels.length>64||part.localRoutes.length>4)capViolations++;
      for(const p of part.parcels){
        const m=p.meta;
        if(m.role==='occupiable'&&m.violations.length)badParcel++;
      }
    }
    for(const b of I.blocks){
      if(b.z<0)continue;const type=I.zones[b.z].type,m=b.space;
      if(m&&m.access==='unserved'&&denseTypes.has(type))badDense++;
      if(denseTypes.has(type)){
        guarded++;
        const U=Math.max(b.x1-b.x0,b.y1-b.y0),V=Math.min(b.x1-b.x0,b.y1-b.y0);
        if(!m||!BR.spaceTypeCompatible(a,type,m,U,V))badGuarded++;
      }
    }
  }
  check('local space planner subdivides structured floor', plannedTerr>100&&spaceParcels>1000&&localHalls>100,
    `${plannedTerr} territories, ${spaceParcels} parcels, ${localHalls} local halls`);
  check('local planning respects hard complexity caps', capViolations===0, `${capViolations} cap violations`);
  check('occupiable parcels satisfy geometry/access constraints', badParcel===0, `${badParcel} invalid occupiable parcels; ${supportParcels} support parcels`);
  check('unserved floor never receives dense cellular archetypes', badDense===0, `${badDense} dense unserved blocks`);
  check('guarded archetypes cannot stretch outside parcel envelopes', guarded>100&&badGuarded===0,
    `${guarded} guarded blocks, ${badGuarded} invalid`);

  // Boundary reconciliation must preserve realized route identity, remove the
  // seam wall only across that route, and never add a redundant normal door.
  const wallHits = (B,c) => {
    for(let k=0;k<B.walls.length;k+=4){
      const x0=B.walls[k],y0=B.walls[k+1],x1=B.walls[k+2],y1=B.walls[k+3];
      if(c.o==='v'&&x0===x1&&x0===c.x&&Math.min(y1,c.s1)-Math.max(y0,c.s0)>0.05)return true;
      if(c.o==='h'&&y0===y1&&y0===c.y&&Math.min(x1,c.s1)-Math.max(x0,c.s0)>0.05)return true;
    }
    return false;
  };
  let continuations=0, continuationWalls=0, redundantDoors=0, missingLinks=0;
  const seenPairs=new Set(), terrKeys=new Set(terrs.map((T)=>T.key));
  for(const T of terrs){
    const ta=W.final(T);if(!BR.AREAS[ta]||BR.AREAS[ta].role!=='district')continue;
    for(const n of W.adj(T)){
      const k=BR.pairKey(T,n.U);if(seenPairs.has(k)||!terrKeys.has(n.U.key))continue;seenPairs.add(k);
      const B=W.boundary(T,n.U);if(!B.continuations.length)continue;
      continuations+=B.continuations.length;redundantDoors+=B.doors.length;
      if(B.semantic!=='continuation')missingLinks++;
      for(const c of B.continuations){if(wallHits(B,c))continuationWalls++;
        const linked=B.links.some((L)=>L.kind==='continuation'&&(
          c.o==='v' ? Math.abs(L.x-c.x)<1e-6&&L.y>=c.s0-1e-6&&L.y<=c.s1+1e-6 :
                      Math.abs(L.y-c.y)<1e-6&&L.x>=c.s0-1e-6&&L.x<=c.s1+1e-6));
        if(!linked)missingLinks++;}
    }
  }
  check('planned circulation crosses technical territory seams', continuations >= 40, `${continuations} continuations`);
  check('continuation openings contain no seam wall', continuationWalls===0, `${continuationWalls} wall overlaps`);
  check('continuations suppress redundant normal doors', redundantDoors===0, `${redundantDoors} doors`);
  check('continuations are direct room-graph links', missingLinks===0, `${missingLinks} missing/misclassified links`);
}

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
  const formerBands=new Set(['offices|poolrooms','parking|poolrooms','hotel|parking']);
  let transitions=0,badTransitions=[],legacyBandFlags=0,pockets=0,badPockets=[],seenPairs=new Set();
  for (const T of it.territories) {
    if (!inner(T)) continue;
    const fa = W.final(T);
    for (const n of W.adj(T)) {
      const k = BR.pairKey(T, n.U);
      if (seenPairs.has(k)) continue;
      seenPairs.add(k);
      const fb = W.final(n.U), info = BR.pairInfo(W, T, n.U);
      if(Object.prototype.hasOwnProperty.call(info,'band')||Object.prototype.hasOwnProperty.call(info,'service')) legacyBandFlags++;
      const pairName=fa<fb?fa+'|'+fb:fb+'|'+fa;
      if(!BR.isPocket(fa)&&!BR.isPocket(fb)&&formerBands.has(pairName)){
        transitions++;
        const b=W.boundary(T,n.U);
        if(BR.rule(fa,fb)==='band'||info.band||info.service||info.wall!=='thick'||b.semantic!=='transition'||b.doors.some((d)=>d.kind==='service'))
          badTransitions.push(k);
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
  check('former maintenance-band pairs use direct strong transitions', badTransitions.length===0,
    `${transitions} sampled pairs`+(badTransitions.length?', bad: '+badTransitions.slice(0,4).join(' '):''));
  check('maintenance-band machinery is absent from pair decisions', legacyBandFlags===0 && !BR.bands && !BR.carveBands, `${legacyBandFlags} legacy pair flags`);
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
