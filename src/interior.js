/* Pattern-owned interiors. Architectural groups and their entrances are planned
 * before procedural infill. Traversal through rooms is navigation metadata;
 * dedicated halls exist only where the selected pattern creates them. */
(function(root){
  'use strict';
  const BR=root.BR,{Rng,hash4,clamp}=BR;
  const ROOM=0,HALL=1,BLOCK=4,SERVICE=5;
  function makeStyle(A,rng,dna){
    const mid=(v,d)=>Array.isArray(v)?(v[0]+v[1])/2:v===undefined?d:v;
    const inherited=(spec,d,mul)=>{
      let v=mid(spec,d)*mul*rng.range(.96,1.04);
      return Array.isArray(spec)?clamp(v,spec[0],spec[1]):v;
    };
    return {dna,zones:Object.keys(dna.zoneWeights).length?dna.zoneWeights:
      (A.generation&&A.generation.zones)||A.zones||{open:1},
      roomScale:inherited(A.roomScale,1,dna.roomScale),pillars:inherited(A.pillars,.5,dna.pillarDensity),
      hallW:dna.corridorWidth,pOpen:inherited(A.pOpen,.2,dna.openness),
      pLoop:inherited(A.pLoop,.25,dna.loopiness),pWide:inherited(A.pWide,.15,dna.wideness),
      doorW:1.6,pStub:.25,pBspCorr:.15,roomArea:120*dna.roomScale*dna.roomScale};
  }
  function blockRoomAt(I,bi,x,y,door){
    const b=I.blocks[bi];if(!b||b.z<0)return -1;
    const Z=I.zones[b.z],k=door?Z.doorRoomAt(x,y):Z.roomAt(x,y);
    return k<0?-1:Z.base+k;
  }
  function roomAtAccess(Z,a){return Z.doorRoomAt(a.x+a.normal[0]*.45,a.y+a.normal[1]*.45);}
  function fillSpace(W,T,b,st){
    const seed=hash4(W.seed,T.i,T.j,T.k*131+b.index*17+0x66696c),rng=new Rng(seed);
    if(b.k===HALL){
      const Z=BR.plainZone(b.q,'corridor'),nav=BR.planZoneTraversal(Z,b.access);
      if(!nav)throw new Error('Hall traversal failed: '+b.id);
      return {Z,nav,attempts:1,fallback:false};
    }
    const weights=Object.assign({},BR.programZoneWeights(b.meta.area,b.role,st.zones));
    const tried=[];
    for(let attempt=0;attempt<BR.PATTERN_LIMITS.attempts;attempt++){
      const t=BR.pickZoneType(rng,weights,b.q,tried,0,b.meta);tried.push(t);
      const Z=BR.fillZone(t,b.q,rng,st,{front:b.front,space:b.meta});
      const nav=BR.planZoneTraversal(Z,b.access);
      if(nav)return {Z,nav,attempts:attempt+1,fallback:false};
      weights[t]=(weights[t]||0)*.1;
    }
    // A bounded failure selects a clear, furnished open realization of this
    // SAME room envelope. It never creates another corridor or relocates a port.
    const Z=BR.fillZone('open',b.q,new Rng(seed^0x616363),st,{feature:'pillars'});
    const nav=BR.planZoneTraversal(Z,b.access);
    if(!nav)throw new Error('Safe infill traversal failed: '+b.id);
    W.stats.infillFallbacks++;
    return {Z,nav,attempts:BR.PATTERN_LIMITS.attempts+1,fallback:true};
  }
  function pushWall(walls,s,a,b){
    if(b-a<.05)return;
    walls.push(...(s.o==='v'?[s.c,a,s.c,b]:[a,s.c,b,s.c]));
  }
  function connectPattern(I,P){
    const links=[];
    for(const Z of I.zones)for(const l of Z.links)links.push({a:Z.base+l.a,b:Z.base+l.b,x:l.x,y:l.y,w:l.w,kind:l.kind});
    for(const c of P.connections){
      const za=I.zones[c.a],zb=I.zones[c.b];
      const aa=P.blocks[c.a].access.find(a=>a.id===c.id),ab=P.blocks[c.b].access.find(a=>a.id===c.id);
      const ra=roomAtAccess(za,aa),rb=roomAtAccess(zb,ab);
      if(ra<0||rb<0)throw new Error('Unrealized pattern doorway: '+c.id);
      links.push({a:za.base+ra,b:zb.base+rb,x:c.x,y:c.y,w:c.w,kind:c.kind,interface:c.id});
    }
    const walls=[];
    for(let i=0;i<P.blocks.length;i++)for(let j=i+1;j<P.blocks.length;j++){
      const s=BR.segBetween(P.blocks[i].q,P.blocks[j].q);if(!s)continue;
      const cs=P.connections.filter(c=>c.a===i&&c.b===j);
      if(cs.some(c=>c.full))continue;
      let start=s.s0;
      for(const c of cs.sort((a,b)=>a.s0-b.s0)){pushWall(walls,s,start,c.s0);start=c.s1;}
      pushWall(walls,s,start,s.s1);
    }
    I.links=links;I.walls=walls;I.doorCount=P.connections.filter(c=>c.kind==='door').length;
  }
  function buildInterior(W,T){
    const area=W.final(T),A=BR.AREAS[area],dna=W.architecture(T),P=W.pattern(T);
    const st=makeStyle(A,new Rng(hash4(W.seed,T.i,T.j,T.k*64+0x201)),dna);
    const I={key:T.key,area,dna,dnaKey:dna.key,pattern:P,patternKey:P.key,patternFamily:P.family,
      manifestation:W.manifestation(T),programKey:W.program(T)?.key||null,
      blocks:[],zones:[],rooms:[],links:[],walls:[],traversals:[],clearances:[],ports:P.ports,
      diagnostics:{spaces:P.blocks.length,ports:P.ports.length,attempts:0,fallbacks:0,throughRooms:0,corridors:0}};
    for(const pb of P.blocks){
      const b={x0:pb.q[0],y0:pb.q[1],x1:pb.q[2],y1:pb.q[3],k:pb.k,z:I.zones.length,
        id:pb.id,pattern:pb.pattern,programRole:pb.role,front:pb.front,space:pb.meta};
      const {Z,nav,attempts,fallback}=fillSpace(W,T,pb,st);
      b.infillFallback=fallback;I.blocks.push(b);I.zones.push(Z);
      I.diagnostics.attempts+=attempts;I.diagnostics.fallbacks+=fallback?1:0;
      I.diagnostics[pb.k===HALL?'corridors':'throughRooms']++;
      for(const r of nav.routes)I.traversals.push(Object.assign({},r,{id:pb.id+'|'+r.id,interface:r.id,
        block:pb.index,kind:pb.k===HALL?'corridor':'through-room'}));
      I.clearances.push(...nav.clearances);
    }
    let base=0;
    for(const Z of I.zones){Z.base=base;base+=Z.rooms.length;}
    for(const r of I.traversals)r.room+=I.zones[r.block].base;
    connectPattern(I,P);
    const keys=['minor','hatch','masses','voids','pools','props','rounds','pillars','stairs'];
    for(const k of keys)I[k]=[];
    for(const Z of I.zones){
      for(const r of Z.rooms)I.rooms.push({rects:r.rects,kind:r.kind,zone:Z.type});
      I.walls.push(...Z.major);
      for(const k of keys)I[k].push(...Z[k]);
    }
    // Apertures crossing a room-bank cut create a shared entrance recess. A
    // perpendicular partition cannot project into that protected approach.
    I.entranceClearances=P.ports.map(p=>{
      const n=BR.patternInward(p.side);
      return BR.traversalPathRect([p.x,p.y],[p.x+n[0]*1.8,p.y+n[1]*1.8],p.w/2);
    });
    I.walls=BR.trimTraversalLines(I.walls,I.entranceClearances);
    I.floor=P.blocks.reduce((sum,b)=>sum+(b.q[2]-b.q[0])*(b.q[3]-b.q[1]),0);
    return I;
  }
  function interiorRoomAt(I,x,y,door){
    for(let i=0;i<I.blocks.length;i++){
      const b=I.blocks[i];if(x>b.x0&&x<b.x1&&y>b.y0&&y<b.y1)return blockRoomAt(I,i,x,y,door);
    }
    // Floating-point and exact partition-cut queries can lie on a shared open
    // edge. Physical wall collision is represented by the wall primitives.
    for(let i=0;i<I.blocks.length;i++){
      const b=I.blocks[i];if(x>=b.x0&&x<=b.x1&&y>=b.y0&&y<=b.y1){
        const k=blockRoomAt(I,i,x,y,door);if(k>=0)return k;
      }
    }
    return -1;
  }
  function interiorBlockAt(I,x,y){
    for(const b of I.blocks)if(x>b.x0&&x<b.x1&&y>b.y0&&y<b.y1){
      const Z=I.zones[b.z];
      return {kind:b.k,zone:Z.type,sub:Z.sub,pattern:b.pattern,programRole:b.programRole,
        space:b.space,infillFallback:b.infillFallback};
    }
    return null;
  }
  Object.assign(BR,{buildInterior,interiorRoomAt,interiorBlockAt,BLOCK_KIND:{ROOM,HALL,BLOCK,SERVICE}});
})(typeof window!=='undefined'?window:globalThis);
