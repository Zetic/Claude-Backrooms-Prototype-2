const {BR,fingerprint,components,harness}=require('./helpers');
const {check,finish}=harness(),seed=+(process.argv[2]||31337),q=[-160,-120,160,120];
const baseline=fingerprint(new BR.World(seed),q);
{
 const W=new BR.World(seed);W.collect(900,700,1150,950,Infinity,{interiors:true});
 check('unrelated visit order preserves complete geometry',fingerprint(W,q)===baseline);
}
check('reverse territory requests preserve complete geometry',fingerprint(new BR.World(seed),q,true)===baseline);
const limits={plans:64,patterns:2,interiors:4,boundaries:4,pairs:32,manifests:64,dna:2,programs:1,structures:1};
{
 const W=new BR.World(seed,{limits});
 for(let i=0;i<80;i++)W.plan(100+i,100);
 check('aggressive cache eviction preserves complete geometry',fingerprint(W,q)===baseline);
 check('all generation caches remain bounded',Object.keys(limits).every(k=>W[k].size<=limits[k]));
}
{
 const W=new BR.World(seed);for(const tile of [[0,0,160,120],[-160,0,0,120],[0,-120,160,0],[-160,-120,0,0]])
  W.collect(...tile,Infinity,{interiors:true});
 check('tiled generation preserves complete geometry',fingerprint(W,q)===baseline);
}
{
 const far=[999880,-1000090,1000120,-999910],base=fingerprint(new BR.World(seed),far);
 const W=new BR.World(seed,{limits});W.collect(0,0,120,120,Infinity,{interiors:true});
 check('far negative coordinates and eviction preserve geometry',fingerprint(W,far,true)===base);
}
check('different seeds generate different architecture',fingerprint(new BR.World(seed+1),q)!==baseline);
{
 const W=new BR.World(seed),ms=W.manifestationsIn(-1800,-1800,1800,1800);
 const forms=new Set(ms.map(m=>m.form)),scales=new Set(ms.map(m=>m.scale)),roles=new Set();
 for(const M of ms){const P=W.programBy(M.type,M.id);for(const r of P.regions)roles.add(r.role);}
 check('manifestation forms, scales and program roles remain diverse',forms.size>=4&&scales.size>=2&&roles.size>=6);
 const M=ms[0],s=W.structureBy(M.type,M.id),W2=new BR.World(seed,{limits});
 for(const other of ms.slice(1,8))W2.structureBy(other.type,other.id);
 check('architectural composition survives cache eviction',JSON.stringify(s)===JSON.stringify(W2.structureBy(M.type,M.id)));
 check('global composition contains no physical corridor network',!Object.hasOwn(s,'routes'));
}
{
 const W=new BR.World(seed),ts=W.territoriesIn(-700,-600,700,600);let sum=0,overlaps=0;
 const clip=(a,b)=>Math.max(0,Math.min(a[2],b[2])-Math.max(a[0],b[0]))*Math.max(0,Math.min(a[3],b[3])-Math.max(a[1],b[1]));
 const rs=ts.flatMap(t=>t.rects);for(const r of rs)sum+=clip(r,[-700,-600,700,600]);
 // Exact rectangle intersection and exact clipped area establish tiling; no
 // raster sample can accidentally skip a small gap or overlap.
 for(let i=0;i<rs.length;i++)for(let j=i+1;j<rs.length;j++)if(clip(rs[i],rs[j])>1e-7)overlaps++;
 check('territories still tile the world exactly',overlaps===0&&Math.abs(sum-1680000)<1e-6,`${rs.length} rectangles`);
}
{
 const W=new BR.World(seed),items=W.collect(-900,-900,900,900,Infinity,{interiors:true});
 const G=BR.roomGraph(W,items),c=components(G.nodes.keys(),G.edges),big=c.sizes.indexOf(Math.max(...c.sizes));
 const inner=new Set(items.territories.filter(T=>T.bbox[0]>-800&&T.bbox[1]>-800&&T.bbox[2]<800&&T.bbox[3]<800).map(T=>T.key));
 const lost=[...c.labels].filter(([k,label])=>label!==big&&inner.has(k.slice(0,k.lastIndexOf(':'))));
 check('every interior sample room is globally reachable',lost.length===0,`${G.nodes.size} rooms, ${lost.length} unreachable`);
 check('every piece contains planned traversal interfaces',items.interiors.every(I=>I.ports.length>0));
 check('shared entrances never fail realization',W.stats.doorFailures===0);
 let pockets=0,badPockets=0,badTransitions=0;
 for(const T of items.territories){
  if(BR.isPocket(W.final(T))){pockets++;if(!W.adj(T).every(n=>n.U.base===T.base)||!W.pattern(T).ports.length)badPockets++;}
  for(const n of W.adj(T)){const p=BR.pairInfo(W,T,n.U);if('band'in p||'service'in p)badTransitions++;}
 }
 check('pockets retain host containment and planned access',badPockets===0,`${pockets} pockets`);
 check('mixed areas never acquire automatic maintenance strips',badTransitions===0);
 const zones=new Set(items.interiors.flatMap(I=>I.zones.map(Z=>Z.type)));
 check('procedural infill preserves varied architectural content',zones.size>=12&&zones.has('guest')&&zones.has('parking')&&zones.has('pools'),`${zones.size} zone types`);
}
finish();
