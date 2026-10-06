/* Reusable architectural patterns. Rooms and circulation are composed together;
 * every piece has an internal traversal graph, including pieces without halls.
 * Area names never select geometry algorithms. Profiles and shared DNA do. */
(function(root){
  'use strict';
  const BR=root.BR,{Rng,hash4,clamp,makeUF}=BR;
  const LIMITS=Object.freeze({blocks:96,attempts:4,navRects:384});
  const HALL=1,BLOCK=4;
  const PATTERNS={loop:{minSide:16},elbow:{minSide:12},cross:{minSide:18},
    wing:{minSide:12},enfilade:{minSide:10},open:{minSide:0}};
  const PROFILE={patterns:{loop:1,elbow:1,cross:1,wing:1,enfilade:2,open:3},
    roomFront:[6,12],maxRoomAspect:2.6,roomDepth:[4,16]};
  function profile(areaName){return Object.assign({},PROFILE,BR.AREAS[areaName].generation||{});}
  function block(q,role,pattern){return {q,role,pattern,k:role==='corridor'?HALL:BLOCK,access:[]};}
  function frame(q,axis,flip){
    const swap=axis==='y',U=swap?q[3]-q[1]:q[2]-q[0],V=swap?q[2]-q[0]:q[3]-q[1];
    return {U,V,local:(x,y)=>{
      let u=swap?y-q[1]:x-q[0],v=swap?x-q[0]:y-q[1];
      if(flip){u=U-u;v=V-v;}return [u,v];
    },rect:(u0,v0,u1,v1)=>{
      if(flip){const a=U-u1,b=U-u0;u0=a;u1=b;const c=V-v1,d=V-v0;v0=c;v1=d;}
      return swap?[q[0]+v0,q[1]+u0,q[0]+v1,q[1]+u1]:[q[0]+u0,q[1]+v0,q[0]+u1,q[1]+v1];
    }};
  }
  function generatePattern(name,q,dna,cfg,rng,ports){
    const F=frame(q,dna.majorAxis,rng.f()<.5),{U,V}=F;
    const c=Math.min(dna.corridorWidth+.5,Math.min(U,V)/5),out=[];
    const add=(u0,v0,u1,v1,role)=>{
      if(u1<=u0||v1<=v0)return;
      if(out.length>=LIMITS.blocks)throw new Error('Architectural block cap exceeded');
      out.push(block(F.rect(u0,v0,u1,v1),role,name));
    };
    // Room-bank cuts avoid external apertures. These cuts belong to this
    // architectural group; there are no district-wide corridor lines.
    function bank(u0,v0,u1,v1,front){
      const depth=v1-v0,len=u1-u0,target=Math.max(cfg.roomFront[0],dna.module,depth/cfg.maxRoomAspect);
      const n=Math.max(1,Math.min(12,Math.floor(len/Math.min(cfg.roomFront[1],target))));
      let last=u0;
      for(let i=1;i<=n;i++){
        let cut=i===n?u1:u0+len*i/n;
        if(i<n){
          const lo=last+cfg.roomFront[0],hi=u1-(n-i)*cfg.roomFront[0];
          const ideal=clamp(cut,lo,hi);
          for(const delta of [0,1,-1,2,-2,3,-3,4,-4]){
            const candidate=clamp(ideal+delta,lo,hi),line=F.rect(candidate,v0,candidate,v1),vertical=line[0]===line[2];
            const bad=ports.some(p=>p.o===(vertical?'h':'v')&&
              (vertical?line[0]:line[1])>p.s0-.4&&(vertical?line[0]:line[1])<p.s1+.4);
            cut=candidate;if(!bad)break;
          }
        }
        add(last,v0,cut,v1,'room');
        const b=out[out.length-1],r=F.rect(last,front,cut,front);
        b.front=r[0]===r[2]?(r[0]===b.q[0]?'x0':'x1'):(r[1]===b.q[1]?'y0':'y1');
        last=cut;
      }
    }
    if(name==='loop'){
      add(0,0,U,c,'corridor');add(0,V-c,U,V,'corridor');
      add(0,c,c,V-c,'corridor');add(U-c,c,U,V-c,'corridor');
      add(c,c,U-c,V-c,'core');
    }else if(name==='elbow'){
      add(0,0,U,c,'corridor');add(0,c,c,V,'corridor');add(c,c,U,V,'core');
    }else if(name==='cross'){
      const u=clamp(Math.round(U*rng.range(.38,.62)/dna.module)*dna.module,c+5,U-c-5);
      const v=clamp(Math.round(V*rng.range(.38,.62)/dna.module)*dna.module,c+5,V-c-5);
      add(u,v,u+c,v+c,'corridor');add(u,0,u+c,v,'corridor');add(u,v+c,u+c,V,'corridor');
      add(0,v,u,v+c,'corridor');add(u+c,v,U,v+c,'corridor');
      add(0,0,u,v,'room');add(u+c,0,U,v,'room');add(0,v+c,u,V,'room');add(u+c,v+c,U,V,'room');
    }else if(name==='wing'){
      // Deep envelopes contain several connected wings, each with dimensionally
      // suitable room banks. A shared end bay joins them within this piece.
      const rows=Math.max(1,Math.ceil(V/(2*cfg.roomDepth[1]+c))),u0=rows>1?c:0;
      if(rows>1)add(0,0,c,V,'corridor');
      for(let row=0;row<rows;row++){
        const v0=V*row/rows,v1=V*(row+1)/rows;
        let v=clamp(v0+(v1-v0-c)*rng.range(.46,.54),v0+4,v1-c-4);
        const approaches=ports.map(p=>F.local(p.x,p.y)).filter(([u,pv])=>
          (Math.abs(u)<1e-6||Math.abs(u-U)<1e-6)&&pv>=v0+4+c/2&&pv<=v1-4-c/2);
        if(approaches.length)v=approaches[0][1]-c/2;
        add(u0,v,U,v+c,'corridor');bank(u0,v0,U,v,v);bank(u0,v+c,U,v1,v+c);
      }
    }else if(name==='enfilade'){
      const n=Math.max(2,Math.min(4,Math.round(U/Math.max(10,dna.module*2))));
      for(let i=0;i<n;i++)add(U*i/n,0,U*(i+1)/n,V,i===0?'entry':i===n-1?'destination':'room');
    }else add(0,0,U,V,'open');
    return out;
  }
  function inward(side){return side===0?[0,1]:side===1?[0,-1]:side===2?[1,0]:[-1,0];}
  function accessFor(b,p){
    const q=b.q,axis=p.o==='v'?1:0,lo=Math.max(p.s0,q[axis]),hi=Math.min(p.s1,q[axis+2]);
    if(hi-lo<.05)return null;
    const edge=p.o==='v'?(p.c===q[0]?2:p.c===q[2]?3:-1):(p.c===q[1]?0:p.c===q[3]?1:-1);
    if(edge<0)return null;
    const t=(lo+hi)/2;
    return {id:p.id,x:p.o==='v'?p.c:t,y:p.o==='h'?p.c:t,w:hi-lo,side:edge,
      normal:inward(edge),kind:p.kind||'door',external:!!p.neighbor,
      clearanceOnly:!!p.neighbor&&hi-lo<.7};
  }
  function buildPatternPlan(W,T,forced){
    const areaName=W.final(T),dna=W.architecture(T),cfg=profile(areaName),ports=BR.territoryPorts(W,T);
    const rng=new Rng(hash4(W.seed,T.i,T.j,T.k*97+0x706174)),program=W.program(T);
    const role=program?BR.programRoleAt(program,T.cx,T.cy):'open',blocks=[],parts=[];
    T.rects.forEach((q,ri)=>{
      const weights={};
      for(const name of Object.keys(PATTERNS)){
        if(Math.min(q[2]-q[0],q[3]-q[1])<PATTERNS[name].minSide)continue;
        let w=cfg.patterns[name]||0;
        if(name===dna.patternFamily)w*=2.8;
        if(['open','landmark','void'].includes(role)&&['open','enfilade'].includes(name))w*=2;
        if(role==='repeating'&&name==='wing')w*=2;
        if(role==='branch'&&['elbow','cross'].includes(name))w*=1.7;
        if(w>0)weights[name]=w;
      }
      const name=forced&&ri===0?forced:ri>0?'open':rng.weighted(weights)||'open';
      if(!PATTERNS[name])throw new Error('Unknown architectural pattern: '+name);
      const generated=generatePattern(name,q,dna,cfg,rng,ports.filter(p=>p.rectIndex===ri));
      parts.push({id:T.key+'|part|'+ri,pattern:name,q,first:blocks.length,count:generated.length});
      blocks.push(...generated);
    });
    if(blocks.length>LIMITS.blocks)throw new Error('Architectural block cap exceeded: '+T.key);
    blocks.forEach((b,i)=>{b.id=T.key+'|space|'+i;b.index=i;});
    const edges=[];
    for(let i=0;i<blocks.length;i++)for(let j=i+1;j<blocks.length;j++){
      const a=blocks[i],b=blocks[j],s=BR.segBetween(a.q,b.q);if(!s||s.s1-s.s0<.8)continue;
      const halls=a.k===HALL&&b.k===HALL,front=a.front||b.front;
      let rank=halls?-10:a.k===HALL||b.k===HALL?-5:0;
      if(front&&front===(s.o==='v'?(s.c===a.q[0]?'x0':'x1'):(s.c===a.q[1]?'y0':'y1')))rank-=1;
      edges.push({a:i,b:j,s,rank:rank+rng.f(),halls});
    }
    const uf=makeUF(blocks.length),connections=[];
    for(const e of edges.slice().sort((a,b)=>a.rank-b.rank||a.a-b.a||a.b-b.b)){
      const tree=uf.union(e.a,e.b);if(!tree&&!e.halls)continue;
      const len=e.s.s1-e.s.s0,chain=blocks[e.a].pattern==='enfilade';
      const w=e.halls?len:Math.min(chain?4:1.8,len-.2);
      // Frontage doors sit toward one end of a room, leaving usable corners for
      // interior services and furnishings. Through-room connections stay central.
      const frontage=!e.halls&&(blocks[e.a].k===HALL||blocks[e.b].k===HALL);
      const t=clamp(e.s.s0+len*(frontage?.74:.5),e.s.s0+w/2+.1,e.s.s1-w/2-.1),
        id=T.key+'|interface|'+connections.length;
      const p={id,o:e.s.o,c:e.s.c,s0:t-w/2,s1:t+w/2,kind:e.halls?'continuation':chain?'opening':'door'};
      const aa=accessFor(blocks[e.a],p),bb=accessFor(blocks[e.b],p);
      if(!aa||!bb)throw new Error('Invalid pattern interface: '+id);
      blocks[e.a].access.push(aa);blocks[e.b].access.push(bb);
      connections.push(Object.assign({},p,{a:e.a,b:e.b,x:e.s.o==='v'?e.s.c:t,y:e.s.o==='h'?e.s.c:t,w,full:e.halls,s:e.s}));
    }
    if(blocks.some((_,i)=>uf.find(i)!==uf.find(0)))throw new Error('Disconnected architectural pattern: '+T.key);
    for(const p of ports){
      const owners=[];
      for(const b of blocks){const a=accessFor(b,p);if(a){b.access.push(a);owners.push(b.index);}}
      if(!owners.length)throw new Error('Unattached external entrance: '+p.id);
      p.spaces=owners;
    }
    for(const b of blocks){
      const entry=b.access.find(a=>!a.external)||b.access[0];
      if(!b.front&&entry)b.front=({0:'y0',1:'y1',2:'x0',3:'x1'})[entry.side];
      const q=b.q,hz=b.front&&b.front[0]==='y';
      b.meta={area:areaName,role:b.role,access:'pattern',frontSide:b.front||null,
        frontage:hz?q[2]-q[0]:q[3]-q[1],depth:hz?q[3]-q[1]:q[2]-q[0],entrances:b.access.length,violations:[]};
    }
    return {key:'pattern:'+T.key,territory:T.key,area:areaName,dnaKey:dna.key,role,
      family:parts[0].pattern,parts,blocks,ports,connections,bounds:T.bbox.slice(),limits:LIMITS};
  }
  // Small-cell archetypes consume suitable room envelopes, independently of
  // semantic names. No unserved residuals or support-parcel substitutions exist.
  function spaceTypeCompatible(areaName,type,meta,U,V){
    if(type!=='guest')return true;
    const cfg=profile(areaName),front=meta.frontage,depth=meta.depth;
    return meta.entrances<=1&&!!meta.frontSide&&front>=3.2&&front<=12&&depth>=cfg.roomDepth[0]&&
      depth<=cfg.roomDepth[1]&&Math.max(front/depth,depth/front)<=cfg.maxRoomAspect;
  }
  Object.assign(BR,{PATTERNS,PATTERN_LIMITS:LIMITS,generationProfile:profile,
    buildPatternPlan,spaceTypeCompatible,patternAccess:accessFor,patternInward:inward});
})(typeof window!=='undefined'?window:globalThis);
