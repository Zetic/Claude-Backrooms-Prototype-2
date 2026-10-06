const {BR,components,harness}=require('./helpers');
const {check,finish}=harness(),seed=+(process.argv[2]||31337),W=new BR.World(seed);
const ts=W.territoriesIn(-500,-500,1000,1000),families=new Map();
let floorErrors=0,overlaps=0,disconnected=0,missingPorts=0,badPorts=0,badPaths=0,blockedPaths=0,wallHits=0;
let paths=0,segments=0,throughRoom=0,hallPaths=0,exactPortCount=0,portWalls=0,explicitFallbacks=0;
const eps=1e-6;
const rectOverlap=(a,b)=>Math.min(a[2],b[2])-Math.max(a[0],b[0])>eps&&Math.min(a[3],b[3])-Math.max(a[1],b[1])>eps;
function segmentCovered(rects,a,b){
 const vertical=Math.abs(a[0]-b[0])<eps,axis=vertical?1:0,c=vertical?a[0]:a[1];
 const start=Math.min(a[axis],b[axis]),end=Math.max(a[axis],b[axis]);
 const spans=rects.filter(q=>c>=q[vertical?0:1]-eps&&c<=q[vertical?2:3]+eps)
  .map(q=>[q[axis],q[axis+2]]).sort((a,b)=>a[0]-b[0]);
 let reached=start;for(const [lo,hi]of spans){if(lo>reached+eps)break;if(hi>reached)reached=hi;}
 return reached>=end-eps;
}
const wallOverlap=(q,s)=>Math.min(s[0],s[2])<q[2]-eps&&Math.max(s[0],s[2])>q[0]+eps&&
 Math.min(s[1],s[3])<q[3]-eps&&Math.max(s[1],s[3])>q[1]+eps;
for(const T of ts){
 const I=W.interior(T),P=I.pattern;
 if(!families.has(P.family))families.set(P.family,new Set());families.get(P.family).add(I.area);
 const area=q=>(q[2]-q[0])*(q[3]-q[1]);
 if(Math.abs(P.blocks.reduce((s,b)=>s+area(b.q),0)-T.rects.reduce((s,q)=>s+area(q),0))>1e-6)floorErrors++;
 for(let a=0;a<P.blocks.length;a++)for(let b=a+1;b<P.blocks.length;b++)if(rectOverlap(P.blocks[a].q,P.blocks[b].q))overlaps++;
 const comp=components(I.rooms.keys(),I.links.map(l=>[l.a,l.b]));if(comp.sizes.length!==1)disconnected++;
 if(P.blocks.length>BR.PATTERN_LIMITS.blocks)floorErrors++;
 explicitFallbacks+=I.diagnostics.fallbacks;
 for(const p of P.ports){
  const neighbor=W.pattern(W.terr(p.neighbor)),other=neighbor.ports.find(o=>o.id===p.id);exactPortCount++;
  if(!other||p.x!==other.x||p.y!==other.y||p.w!==other.w||p.s0!==other.s0||p.s1!==other.s1)missingPorts++;
  const n=BR.patternInward(p.side);
  for(let t=p.s0+.1;t<p.s1-.1;t+=.2){
   const x=(p.o==='v'?p.c:t)+n[0]*.45,y=(p.o==='h'?p.c:t)+n[1]*.45;
   if(BR.interiorRoomAt(I,x,y,true)<0)badPorts++;
  }
  const B=W.boundary(T,W.terr(p.neighbor));if(!B.links.some(l=>l.port===p.id))missingPorts++;
  for(let k=0;k<B.walls.length;k+=4){const s=B.walls.slice(k,k+4);
   if(p.o==='v'&&s[0]===p.c&&s[2]===p.c&&Math.min(s[3],p.s1)-Math.max(s[1],p.s0)>eps)portWalls++;
   if(p.o==='h'&&s[1]===p.c&&s[3]===p.c&&Math.min(s[2],p.s1)-Math.max(s[0],p.s0)>eps)portWalls++;
  }
 }
 for(const r of I.traversals){
  paths++;r.kind==='corridor'?hallPaths++:throughRoom++;
  const room=I.rooms[r.room],Z=I.zones[r.block];
  for(let i=1;i<r.points.length;i++){
   segments++;const a=r.points[i-1],b=r.points[i],q=BR.traversalPathRect(a,b,.3);
   if(Math.abs(a[0]-b[0])>eps&&Math.abs(a[1]-b[1])>eps)badPaths++;
   if(!segmentCovered(room.rects,a,b))badPaths++;
   for(const list of [Z.masses,Z.voids,Z.pools,Z.props])for(let j=0;j<list.length;j+=4)if(rectOverlap(q,list.slice(j,j+4)))blockedPaths++;
   for(let j=0;j<Z.pillars.length;j+=4){const [x,y,shape,size]=Z.pillars.slice(j,j+4);if(rectOverlap(q,[x-size/2,y-size/2,x+size/2,y+size/2]))blockedPaths++;}
   for(const list of [I.walls,I.minor])for(let j=0;j<list.length;j+=4)if(wallOverlap(q,list.slice(j,j+4)))wallHits++;
   if(r.external){const p=P.ports.find(p=>p.id===r.interface),boundary=W.boundary(T,W.terr(p.neighbor));
    for(let j=0;j<boundary.walls.length;j+=4)if(wallOverlap(q,boundary.walls.slice(j,j+4)))wallHits++;
   }
  }
 }
}
check('architectural groups preserve exact nonoverlapping floor coverage',floorErrors===0&&overlaps===0,`${ts.length} territories`);
check('every local room and interface belongs to one traversal component',disconnected===0);
check('all six patterns occur across multiple semantic profiles',families.size===6&&[...families.values()].every(a=>a.size>=2),JSON.stringify([...families].map(([k,a])=>[k,a.size])));
check('shared entrances match before either interior is generated',missingPorts===0,`${exactPortCount} entrance sides`);
check('entire planned apertures expose actual doorable floor',badPorts===0,`${badPorts} blocked probes`);
check('boundary walls leave the exact planned entrance apertures open',portWalls===0);
check('actual paths stay within their owning rooms',badPaths===0,`${paths} paths, ${segments} segments`);
check('player clearance avoids pools, permanent solids, props and pillars',blockedPaths===0,`${blockedPaths} intersections`);
check('actual paths cross no structural or interior walls',wallHits===0,`${wallHits} intersections`);
check('through-room traversal coexists with appropriate dedicated halls',throughRoom>hallPaths&&hallPaths>0,`${throughRoom} through-room, ${hallPaths} corridor paths`);
check('bounded infill fallback remains explicit',explicitFallbacks<ts.length*.02,`${explicitFallbacks} fallback spaces`);
{
 const T=ts[0],plain=new BR.World(seed);plain.interior=()=>{throw new Error('Interior dependency');};
 plain.boundary=()=>{throw new Error('Boundary dependency');};let independent=true;
 try{plain.pattern(plain.terr(T.key));BR.connectionPorts(plain,plain.terr(T.key),plain.adj(plain.terr(T.key))[0].U);}catch(e){independent=false;}
 check('architectural planning never reads completed interiors or boundaries',independent);
}
// Fixture semantics share identical profile data. The same geometric pattern
// must work under both names: no generator branches may require a biome name.
{
 const original=BR.AREAS.fixture;BR.AREAS.fixture={generation:{patterns:{open:1},roomFront:[6,12]}};
 const fake={seed,final:()=> 'fixture',architecture:()=>({key:'fixture',majorAxis:'x',module:6,corridorWidth:3,patternFamily:'open'}),program:()=>null,adj:()=>[]};
 const T={key:'fixture',i:0,j:0,k:0,cx:20,cy:16,rects:[[0,0,40,32]],bbox:[0,0,40,32]};
 let valid=true;
 for(const name of Object.keys(BR.PATTERNS)){
  const P=BR.buildPatternPlan(fake,T,name),hall=P.blocks.filter(b=>b.k===BR.BLOCK_KIND.HALL).length;
  if(name==='cross'&&(hall!==5||P.blocks.filter(b=>b.role==='room').length!==4))valid=false;
  if(name==='elbow'&&(hall!==2||P.blocks.filter(b=>b.role==='core').length!==1))valid=false;
  if(name==='loop'&&(hall!==4||P.blocks.filter(b=>b.role==='core').length!==1))valid=false;
  if(['enfilade','open'].includes(name)&&hall!==0)valid=false;
 }
 const meta={area:'fixture',frontSide:'y0',frontage:6,depth:15,entrances:1};
 const guest=BR.fillZone('guest',[0,0,6,15],new BR.Rng(seed),{},{front:'y0',space:meta});
 check('room archetypes use their owning profile outside the original biome',guest.sub[0]==='guest'&&guest.rooms.length===2);
 let capped=false;
 try{BR.buildPatternPlan(fake,{...T,rects:[[0,0,1000,1000]],bbox:[0,0,1000,1000]},'wing');}
 catch(e){capped=e.message.includes('block cap exceeded');}
 check('excessive pattern complexity fails explicitly before losing floor',capped);
 if(original)BR.AREAS.fixture=original;else delete BR.AREAS.fixture;
 check('boxed-loop, elbow, cross and room-only profiles implement their stated arrangements',valid);
}
{
 // Permanent geometry seals this proposed room. It must be rejected rather
 // than adding a graph edge that traverses the solid.
 const Z=BR.plainZone([0,0,20,20],'room');Z.masses=[0,8,20,12];
 const a=[{id:'left',x:0,y:4,w:2,side:2,normal:[1,0]},{id:'right',x:20,y:16,w:2,side:3,normal:[-1,0]}];
 check('physically disconnected infill is rejected',BR.planZoneTraversal(Z,a)===null);
}
finish();
