/* World-space ownership regressions: node tests/circulation.test.js [seed] */
const assert = require('node:assert/strict');
for(const f of ['core','areas','manifestation','layout','structure','spaceplan','zones','interior','boundary','world'])
  require('../src/'+f+'.js');
const BR=globalThis.BR,seed=+(process.argv[2]||31337);
const area=(q)=>(q[2]-q[0])*(q[3]-q[1]);
const overlap=(a,b)=>Math.min(a[2],b[2])-Math.max(a[0],b[0])>1e-7 && Math.min(a[3],b[3])-Math.max(a[1],b[1])>1e-7;
const wallHit=(flat,q)=>{
  for(let k=0;k<flat.length;k+=4){const [x0,y0,x1,y1]=flat.slice(k,k+4);
    if(x0===x1&&x0>q[0]+1e-7&&x0<q[2]-1e-7&&Math.min(y1,q[3])-Math.max(y0,q[1])>1e-7)return true;
    if(y0===y1&&y0>q[1]+1e-7&&y0<q[3]-1e-7&&Math.min(x1,q[2])-Math.max(x0,q[0])>1e-7)return true;
  }return false;
};

// Planning must succeed while all territory/interior access is forbidden.
const independent=new BR.World(seed);
independent.plan=()=>{throw Error('route planner queried a territory');};
independent.interior=()=>{throw Error('route planner queried an interior');};
const plans=independent.structuresIn(-1100,-1100,1100,1100);
assert(plans.length>10);
assert.equal(independent.plans.size,0);assert.equal(independent.interiors.size,0);
let local=0,loops=0;
const hierarchies=new Set();
for(const P of plans){
  assert(P.routes.length<=BR.ROUTE_LIMITS.segments);
  assert(P.demands.length<=BR.ROUTE_LIMITS.demands);
  assert(P.diagnostics.localRoutes<=BR.ROUTE_LIMITS.localRoutes);
  for(const N of P.nodes){
    if(N.kind==='turn'){assert.equal(N.routes.length,1);assert(N.segments.length>=2);}
    if(N.kind==='junction')assert(N.routes.length>=2);
  }
  for(const R of P.routes){
    hierarchies.add(R.hierarchy);
    assert(R.rect.every(Number.isFinite));assert(area(R.rect)>0);
    assert(!R.id.includes('|rect|'));assert(!R.id.includes('|territory|'));
    if(R.hierarchy==='local'){
      local++;assert(R.parent);assert(P.demands.some((d)=>d.id===R.source));
      assert(P.routes.some((p)=>p.id===R.parent));
    }
    if(R.role==='loop')loops++;
  }
}
assert(local>0);assert(loops>0);
assert.deepEqual([...hierarchies].sort(),['local','primary','secondary','service']);
const W=new BR.World(seed),items=W.collect(-650,-550,650,550,Infinity,{interiors:true});
let reservations=0,crossArea=0,parallelSeams=0;
const routeOwners=new Map();
for(const T of items.territories){
  const I=W.interior(T);
  assert(Math.abs(I.floor-T.rects.reduce((n,q)=>n+area(q),0))<1e-5,'floor coverage '+T.key);
  assert.equal(I.spacePlan.localRoutes.length,0,'territory invented a hall');
  const expected=W.routesIn(...T.bbox);
  for(const R of expected)for(let ri=0;ri<T.rects.length;ri++){
    const q=BR.routeRectClip(R.rect,T.rects[ri]);if(!q)continue;reservations++;
    const o=I.obligations.find((o)=>o.segmentId===R.segmentId&&o.rectIndex===ri);
    assert(o,'missing physical route '+R.segmentId+' in '+T.key);assert.deepEqual(o.rect,q);
    let owners=routeOwners.get(R.id);if(!owners){owners=new Set();routeOwners.set(R.id,owners);}owners.add(T.key);
    for(const b of I.blocks)if(!b.flow)assert(!overlap([b.x0,b.y0,b.x1,b.y1],q),'room overlaps route '+T.key);
    for(const primitive of ['masses','voids','pools','props'])for(let k=0;k<I[primitive].length;k+=4)
      assert(!overlap(I[primitive].slice(k,k+4),q),primitive+' overlaps route '+T.key);
    for(let k=0;k<I.pillars.length;k+=4){const [x,y,,size]=I.pillars.slice(k,k+4);
      assert(!overlap([x-size/2,y-size/2,x+size/2,y+size/2],q),'pillar overlaps route '+T.key);
    }
    for(const primitive of ['walls','minor','hatch'])assert(!wallHit(I[primitive],q),primitive+' crosses route '+T.key);
    for(let k=0;k<I.rounds.length;k+=7)assert(!overlap(I.rounds.slice(k+3,k+7),q),'round-room solid overlaps route '+T.key);
  }
  for(const r of I.realizations){assert.equal(r.status,'exact');assert.equal(r.shift,0);}
}
for(const B of items.boundaries){
  if(B.cross)crossArea+=B.continuations.length;
  for(const c of B.continuations){
    const A=W.interior(W.terr(B.a));
    if(A.obligations.some((o)=>o.routeId===c.flow&&((c.o==='v'&&o.axis==='y')||(c.o==='h'&&o.axis==='x'))))parallelSeams++;
    for(const T of [W.terr(B.a),W.terr(B.b)])for(const q of W.interior(T).routeSpace)
      assert(!wallHit(B.walls,q),'boundary crosses physical route');
    assert(B.links.some((l)=>l.kind==='continuation'&&(c.o==='v'?Math.abs(l.x-c.x)<1e-6&&l.y>=c.s0&&l.y<=c.s1:Math.abs(l.y-c.y)<1e-6&&l.x>=c.s0&&l.x<=c.s1)));
  }
}
assert(reservations>100);assert(crossArea>0,'routes never cross semantic ownership');
const multi=[...routeOwners.values()].filter((owners)=>owners.size>=3).length;
assert(multi>10,'routes do not span multiple territories');

// Arbitrary render/query order, tiny caches and tiled queries must produce the
// same canonical physical network, including far negative coordinates.
for(const rect of [[-650,-550,650,550],[1e6-120,-1e6-120,1e6+120,-1e6+120]]){
  const canonical=(routes)=>JSON.stringify(routes.slice().sort((a,b)=>a.segmentId<b.segmentId?-1:1));
  const base=canonical(W.routesIn(...rect));
  const evicted=new BR.World(seed,{limits:{manifests:2,programs:1,dna:1,structures:1}});
  evicted.routesIn(3000,3000,3600,3600);
  assert.equal(canonical(evicted.routesIn(...rect)),base);
  const [x0,y0,x1,y1]=rect,xm=(x0+x1)/2,ym=(y0+y1)/2,union=new Map();
  for(const q of [[xm,ym,x1,y1],[x0,ym,xm,y1],[xm,y0,x1,ym],[x0,y0,xm,ym]])
    for(const R of evicted.routesIn(...q))union.set(R.segmentId,R);
  assert.equal(canonical([...union.values()]),base);
}

// Saturation must leave explicit support floor rather than drop residuals or
// grow local halls. This fixture exceeds the per-part parcel cap deliberately.
const realized=[];
for(let i=0;i<12;i++)for(const axis of ['x','y'])realized.push({routeId:axis+i,hierarchy:'local',role:'fixture',status:'exact',
  flow:{key:axis+i,axis},rects:[axis==='x'?[0,5+i*8,100,7+i*8]:[5+i*8,0,7+i*8,100]]});
const saturated=BR.planLocalSpace([0,0,100,100],realized,'offices',null,'cap-fixture');
assert(saturated.diagnostics.capHit);assert(saturated.parcels.length<=64);assert(saturated.remainders.length>0);
const covered=[...saturated.districtRoutes.map((r)=>r.q),...saturated.parcels.map((p)=>p.q),...saturated.remainders.map((p)=>p.q)];
assert(Math.abs(covered.reduce((sum,q)=>sum+area(q),0)-10000)<1e-5);
for(let i=0;i<covered.length;i++)for(let j=i+1;j<covered.length;j++)assert(!overlap(covered[i],covered[j]));
console.log(`seed ${seed}: ${plans.length} independent networks; ${local} local segments; ${loops} loop segments; ${reservations} exact reservations; ${multi} routes across 3+ territories; ${crossArea} cross-area continuations; ${parallelSeams} parallel seam slices. All circulation checks passed.`);
