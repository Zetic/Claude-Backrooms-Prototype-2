/*
 * World-space circulation. This planner never reads territories or interiors.
 * Program destinations select a connected rectilinear network; bounded depth
 * demands from manifestation lobes extend that same network with local access.
 * Route footprints are canonical architecture, clipped (never moved) by owners.
 */
(function (root) {
  'use strict';
  const BR = root.BR;
  const { Rng, hash4, clamp } = BR;
  const PLANNED = new Set(Object.keys(BR.AREAS).filter((k) => BR.AREAS[k].role === 'district'));
  const PRI = { primary:0, secondary:1, local:2, service:3 };
  const cmp=(a,b)=>a<b?-1:a>b?1:0;
  const LIMITS = Object.freeze({ segments:96, localRoutes:24, demands:80 });
  const overlap = (a,b) => a[0]<b[2] && a[2]>b[0] && a[1]<b[3] && a[3]>b[1];
  const clip = (a,b) => {
    const q=[Math.max(a[0],b[0]),Math.max(a[1],b[1]),Math.min(a[2],b[2]),Math.min(a[3],b[3])];
    return q[2]>q[0] && q[3]>q[1] ? q : null;
  };
  function routeFootprint(R) {
    const h=R.width/2;
    return R.axis==='x' ? [R.s0,R.line-h,R.s1,R.line+h] : [R.line-h,R.s0,R.line+h,R.s1];
  }
  function nearestRoute(routes,x,y,exclude) {
    let best=null;
    for(const R of routes){
      if(exclude && exclude(R))continue;
      const px=R.axis==='x'?clamp(x,R.s0,R.s1):R.line;
      const py=R.axis==='y'?clamp(y,R.s0,R.s1):R.line;
      const distance=Math.abs(x-px)+Math.abs(y-py);
      if(!best || distance<best.distance || (distance===best.distance && R.segmentId<best.route.segmentId))
        best={route:R,x:px,y:py,distance};
    }
    return best;
  }

  function buildDistrictStructure(W,area,district) {
    if(!PLANNED.has(area)||!district)return null;
    const [a,b]=district.split(',').map(Number), M=BR.districtSeed(W.seed,a,b);
    if(!M.exists||M.type!==area)return null;
    const dna=BR.architectureDNA(W,{district,cx:M.cx,cy:M.cy,base:area},area);
    const program=W.programBy(area,district), key='structure:'+area+':'+district;
    const rng=new Rng(hash4(W.seed,a,b,0x5a72)), routes=[], candidates=[], demands=[];
    const policy=BR.spacePolicy(area,dna), core=program.regions.find((r)=>r.role==='core');
    let serial=0, capHit=false;

    // Each path retains one ID through turns, territory seams and area changes.
    // Segments carry their own ID for queries and diagnostic provenance.
    function path(from,to,hierarchy,role,source,axis,parent) {
      const bounded=(p)=>[clamp(Math.round(p[0]),Math.round(M.bounds[0]),Math.round(M.bounds[2])),clamp(Math.round(p[1]),Math.round(M.bounds[1]),Math.round(M.bounds[3]))];
      const A=bounded(from),B=bounded(to),id=key+'|route|'+serial++;
      const turn=axis==='x'?[B[0],A[1]]:[A[0],B[1]];
      const points=[A,turn,B], width=hierarchy==='primary'?dna.corridorWidth+1:dna.corridorWidth;
      const added=[];
      for(let i=0;i<2;i++){
        const p=points[i],q=points[i+1];if(p[0]===q[0]&&p[1]===q[1])continue;
        if(routes.length>=LIMITS.segments){capHit=true;break;}
        const horizontal=p[1]===q[1],s0=Math.min(horizontal?p[0]:p[1],horizontal?q[0]:q[1]),
          s1=Math.max(horizontal?p[0]:p[1],horizontal?q[0]:q[1]);
        const R={id,segmentId:id+'|segment|'+i,hierarchy,role,source,parent:parent||null,
          axis:horizontal?'x':'y',line:horizontal?p[1]:p[0],s0,s1,width};
        R.rect=routeFootprint(R);routes.push(R);added.push(R);
      }
      return added;
    }
    const C=[core.x,core.y],destinations=program.regions.filter((r)=>r.role!=='void'&&r!==core);
    const far=destinations.slice().sort((u,v)=>Math.hypot(v.x-C[0],v.y-C[1])-Math.hypot(u.x-C[0],u.y-C[1])||cmp(u.id,v.id))[0];
    if(far)path(C,[far.x,far.y],'primary','trunk',far.id,dna.majorAxis);
    if(!routes.length) {
      const L=M.lobes[0],span=Math.round((dna.majorAxis==='x'?L.rx:L.ry)*.65);
      path(dna.majorAxis==='x'?[C[0]-span,C[1]]:[C[0],C[1]-span],
        dna.majorAxis==='x'?[C[0]+span,C[1]]:[C[0],C[1]+span],'primary','trunk',core.id,dna.majorAxis);
    }
    // Stable destination order. Service regions attach to the same network.
    const rank={connector:0,branch:1,repeating:2,landmark:3,open:4,service:5,terminal:6};
    for(const R of destinations.slice().sort((u,v)=>(rank[u.role]-rank[v.role])||cmp(u.id,v.id))){
      const N=nearestRoute(routes,R.x,R.y);if(!N||N.distance<dna.corridorWidth)continue;
      const axis=N.route.axis==='x'?'y':'x';
      path([N.x,N.y],[R.x,R.y],R.role==='service'?'service':'secondary',R.role,R.id,axis,N.route.id);
    }
    // A second approach to a destination can form a loop. The selected program
    // and DNA control occurrence; no global corridor lattice is instantiated.
    if(far&&M.scale!=='small'&&rng.f()<clamp(dna.loopiness*program.routeDensity*.32,0,.6)){
      const opposite=dna.majorAxis==='x'?'y':'x';
      if(far.x!==C[0]&&far.y!==C[1])path(C,[far.x,far.y],'secondary','loop',far.id,opposite,routes[0].id);
    }

    // Access need is sampled in architectural lobes, independent of streaming
    // ownership. Jittered sites propose demands, not mandatory spaced halls.
    // Open/void regions permit greater depth; dense roles request closer access.
    for(let li=0;li<M.lobes.length&&demands.length<LIMITS.demands;li++){
      const L=M.lobes[li],spacing=Math.max(18,policy.maxDepth*2.5);
      const nx=Math.min(5,Math.max(2,Math.ceil(L.rx*1.5/spacing)));
      const ny=Math.min(5,Math.max(2,Math.ceil(L.ry*1.5/spacing)));
      for(let iy=0;iy<ny&&demands.length<LIMITS.demands;iy++)for(let ix=0;ix<nx&&demands.length<LIMITS.demands;ix++){
        const x=Math.round(L.cx+(((ix+.25+rng.f()*.5)/nx)*2-1)*L.rx*.8);
        const y=Math.round(L.cy+(((iy+.25+rng.f()*.5)/ny)*2-1)*L.ry*.8);
        if(BR.manifestationDistance(M,x,y)>=1)continue;
        const role=BR.programRoleAt(program,x,y);if(role==='void')continue;
        const threshold=policy.maxDepth*(role==='open'||role==='landmark'?3:1.65)/Math.max(.6,program.routeDensity);
        demands.push({id:key+'|demand|'+demands.length,x,y,role,lobe:li,maxDepth:threshold,status:'pending',servedBy:null});
      }
    }
    let localCount=0;
    while(localCount<LIMITS.localRoutes&&routes.length<LIMITS.segments-1){
      let worst=null;
      for(const D of demands){
        const N=nearestRoute(routes,D.x,D.y),excess=N.distance-D.maxDepth;
        if(excess>0&&(!worst||excess>worst.excess))worst={demand:D,near:N,excess};
      }
      if(!worst)break;
      const D=worst.demand,N=worst.near;
      const added=path([N.x,N.y],[D.x,D.y],'local','access-depth',D.id,N.route.axis==='x'?'y':'x',N.route.id);
      if(!added.length)break;localCount++;
    }
    for(const D of demands){
      const N=nearestRoute(routes,D.x,D.y);
      D.distance=N.distance;D.servedBy=N.route.id;D.status=N.distance<=D.maxDepth?'served':'support';
      if(D.status==='support')capHit=true;
      candidates.push({id:D.id,kind:'access-demand',axis:N.route.axis==='x'?'y':'x',
        line:N.route.axis==='x'?D.x:D.y,s0:Math.min(N.route.axis==='x'?N.y:N.x,N.route.axis==='x'?D.y:D.x),
        s1:Math.max(N.route.axis==='x'?N.y:N.x,N.route.axis==='x'?D.y:D.x)});
    }
    const nodes=[],point=(x,y,kind,id)=>{
      let N=nodes.find((n)=>n.x===x&&n.y===y);
      if(!N){N={x,y,kind,routes:[]};nodes.push(N);}
      if(!N.routes.includes(id))N.routes.push(id);
      if(N.routes.length>1)N.kind='junction';
    };
    for(const R of routes){
      point(R.axis==='x'?R.s0:R.line,R.axis==='y'?R.s0:R.line,'terminus',R.id);
      point(R.axis==='x'?R.s1:R.line,R.axis==='y'?R.s1:R.line,'terminus',R.id);
    }
    for(let i=0;i<routes.length;i++)for(let j=i+1;j<routes.length;j++){
      const H=routes[i].axis==='x'?routes[i]:routes[j],V=H===routes[i]?routes[j]:routes[i];
      if(H.axis===V.axis)continue;
      if(V.line>=H.s0&&V.line<=H.s1&&H.line>=V.s0&&H.line<=V.s1){
        point(V.line,H.line,'junction',H.id);point(V.line,H.line,'junction',V.id);
      }
    }
    // A turn is not a termination. Include collinear attachments too, whose
    // parent centreline may pass through a child endpoint without ending there.
    for(const N of nodes){
      const incident=routes.filter((R)=>R.axis==='x' ? N.y===R.line&&N.x>=R.s0&&N.x<=R.s1 :
        N.x===R.line&&N.y>=R.s0&&N.y<=R.s1);
      N.routes=[...new Set(incident.map((R)=>R.id))];
      N.segments=incident.map((R)=>R.segmentId);
      N.kind=N.routes.length>1?'junction':incident.length>1?'turn':'terminus';
    }
    const anchors=program.regions.filter((r)=>['core','landmark','open','terminal'].includes(r.role)).slice(0,M.scale==='small'?1:3)
      .map((r,i)=>({id:key+'|anchor|'+i,x:r.x,y:r.y,kind:r.role,zone:BR.programPreferredZone(area,r.role),programRegion:r.id}));
    // Query bounds include width, every connector, and fragmented lobe bridges.
    const bounds=routes.reduce((B,R)=>[Math.min(B[0],R.rect[0]),Math.min(B[1],R.rect[1]),Math.max(B[2],R.rect[2]),Math.max(B[3],R.rect[3])],M.bounds.slice());
    return {key,area,district,manifestation:M,programKey:program.key,program,dnaKey:dna.key,dna,
      districtSeed:M,bounds,candidates,routes,nodes,anchors,demands,
      diagnostics:{segments:routes.length,localRoutes:localCount,demands:demands.length,
        unserved:demands.filter((d)=>d.status==='support').length,capHit}};
  }

  function territoryStructure(W,T,rects) {
    rects=rects||T.rects;
    const area=W.final(T),own=W.structureBy(area,T.district),plans=W.structuresIn(...T.bbox),routes=[];
    // Membership in a semantic area never filters a physical route. Substrate
    // and pockets reserve connectors exactly like the originating manifestation.
    for(const P of plans)for(const R of P.routes)for(let ri=0;ri<rects.length;ri++){
      const q=clip(R.rect,rects[ri]);if(!q)continue;
      routes.push({routeId:R.id,segmentId:R.segmentId,networkKey:P.key,dnaKey:P.dnaKey,
        hierarchy:R.hierarchy,role:R.role,axis:R.axis,line:R.line,width:R.width,
        s0:R.axis==='x'?q[0]:q[1],s1:R.axis==='x'?q[2]:q[3],
        globalS0:R.s0,globalS1:R.s1,rectIndex:ri,rect:q});
    }
    routes.sort((u,v)=>(PRI[u.hierarchy]-PRI[v.hierarchy])||cmp(u.segmentId,v.segmentId)||u.rectIndex-v.rectIndex);
    const anchors=own?own.anchors.filter((p)=>rects.some((q)=>p.x>=q[0]&&p.x<q[2]&&p.y>=q[1]&&p.y<q[3])):[];
    return {plan:own,plans,routes,anchors};
  }
  Object.assign(BR,{STRUCTURE_AREAS:PLANNED,STRUCTURE_PRIORITY:PRI,ROUTE_LIMITS:LIMITS,
    routeFootprint,routeRectClip:clip,routeRectsOverlap:overlap,nearestRoute,buildDistrictStructure,territoryStructure});
})(typeof window!=='undefined'?window:globalThis);
