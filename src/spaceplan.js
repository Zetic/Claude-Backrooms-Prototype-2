/*
 * spaceplan.js - bounded local architectural planning.
 *
 * District structure decides which major routes exist. This layer decides how
 * the remaining floor mass is served by circulation and divided into usable
 * architectural parcels before semantic zone generators are chosen.
 *
 * It operates only on rectangles/segments and bounded small graphs. There is
 * no raster field, flood fill, unbounded search, or regenerate-until-good loop.
 */
(function (root) {
  'use strict';
  const BR = root.BR;

  const BASE = {
    minDepth: 3.5, maxDepth: 12, minFrontage: 3.5, targetFrontage: 8,
    maxFrontage: 14, maxAspect: 3.5, localWidth: 2,
    maxParcels: 64, maxLocalRoutes: 4, maxServeDepth: 4
  };
  const POLICY = {
    hotel:   { minDepth: 4.5, maxDepth: 9,  minFrontage: 3.2, targetFrontage: 5,  maxFrontage: 8.5, maxAspect: 2.5, localWidth: 2 },
    offices: { minDepth: 4,   maxDepth: 13, minFrontage: 4,   targetFrontage: 10, maxFrontage: 16,  maxAspect: 4,   localWidth: 2 },
    backrooms:{ minDepth: 3,  maxDepth: 15, minFrontage: 3,   targetFrontage: 8,  maxFrontage: 16,  maxAspect: 5,   localWidth: 2 },
    poolrooms:{ minDepth: 5,  maxDepth: 18, minFrontage: 5,   targetFrontage: 12, maxFrontage: 24,  maxAspect: 5,   localWidth: 3 },
    parking: { minDepth: 6,   maxDepth: 22, minFrontage: 6,   targetFrontage: 16, maxFrontage: 28,  maxAspect: 5,   localWidth: 4 },
    home:    { minDepth: 4,   maxDepth: 10, minFrontage: 3.5, targetFrontage: 7,  maxFrontage: 12,  maxAspect: 3,   localWidth: 1.5 },
    maintenance:{ minDepth: 3,maxDepth: 10, minFrontage: 3,   targetFrontage: 7,  maxFrontage: 14,  maxAspect: 4,   localWidth: 2 }
  };
  const PRI = { major: 0, secondary: 1, service: 2, local: 3 };

  const clamp = (x,a,b) => Math.max(a,Math.min(b,x));
  const qArea = (q) => Math.max(0,q[2]-q[0]) * Math.max(0,q[3]-q[1]);

  function policy(area, dna) {
    const p = Object.assign({}, BASE, POLICY[area] || {});
    if (dna) {
      if (area === 'hotel') p.targetFrontage = clamp(dna.module, 4, 6);
      else if (area === 'offices') p.targetFrontage = clamp(dna.module * 2, 8, 14);
      p.localWidth = Math.max(p.localWidth, dna.corridorWidth || 0);
    }
    return p;
  }

  function frame(q, side) {
    const [x0,y0,x1,y1]=q, w=x1-x0, h=y1-y0;
    if (side === 'top') return { U:w,V:h,rect:(u0,v0,u1,v1)=>[x0+u0,y0+v0,x0+u1,y0+v1], front:'y0' };
    if (side === 'bottom') return { U:w,V:h,rect:(u0,v0,u1,v1)=>[x0+u0,y1-v1,x0+u1,y1-v0], front:'y1' };
    if (side === 'left') return { U:h,V:w,rect:(u0,v0,u1,v1)=>[x0+v0,y0+u0,x0+v1,y0+u1], front:'x0' };
    return { U:h,V:w,rect:(u0,v0,u1,v1)=>[x1-v1,y0+u0,x1-v0,y0+u1], front:'x1' };
  }

  /** Shared edge, with side named from rectangle a's point of view. */
  function shared(a,b) {
    if (Math.abs(a[2]-b[0])<1e-9 || Math.abs(b[2]-a[0])<1e-9) {
      const s0=Math.max(a[1],b[1]),s1=Math.min(a[3],b[3]);
      if(s1-s0>0.05)return {o:'v',c:Math.abs(a[2]-b[0])<1e-9?a[2]:a[0],s0,s1,len:s1-s0,side:Math.abs(a[2]-b[0])<1e-9?'right':'left'};
    }
    if (Math.abs(a[3]-b[1])<1e-9 || Math.abs(b[3]-a[1])<1e-9) {
      const s0=Math.max(a[0],b[0]),s1=Math.min(a[2],b[2]);
      if(s1-s0>0.05)return {o:'h',c:Math.abs(a[3]-b[1])<1e-9?a[3]:a[1],s0,s1,len:s1-s0,side:Math.abs(a[3]-b[1])<1e-9?'bottom':'top'};
    }
    return null;
  }

  function routeArrangement(q, realized) {
    const xs=new Set([q[0],q[2]]),ys=new Set([q[1],q[3]]),pieces=[];
    for(const r of realized)for(const c of r.rects||[]){
      const x0=Math.max(q[0],c[0]),y0=Math.max(q[1],c[1]),x1=Math.min(q[2],c[2]),y1=Math.min(q[3],c[3]);
      if(x1-x0<0.05||y1-y0<0.05)continue;
      xs.add(x0);xs.add(x1);ys.add(y0);ys.add(y1);pieces.push({q:[x0,y0,x1,y1],r});
    }
    const X=[...xs].sort((a,b)=>a-b),Y=[...ys].sort((a,b)=>a-b),cells=[];
    for(let yi=0;yi<Y.length-1;yi++)for(let xi=0;xi<X.length-1;xi++){
      const x0=X[xi],x1=X[xi+1],y0=Y[yi],y1=Y[yi+1],cx=(x0+x1)/2,cy=(y0+y1)/2;
      const cover=pieces.filter((p)=>cx>=p.q[0]-1e-9&&cx<=p.q[2]+1e-9&&cy>=p.q[1]-1e-9&&cy<=p.q[3]+1e-9)
        .sort((a,b)=>(PRI[a.r.hierarchy]-PRI[b.r.hierarchy])||(a.r.routeId<b.r.routeId?-1:1));
      const flows=[];for(const p of cover)if(p.r.flow&&!flows.some((f)=>f.key===p.r.flow.key))flows.push(p.r.flow);
      cells.push({q:[x0,y0,x1,y1],cover,flows,flowSig:flows.map((f)=>f.key).sort().join('|')});
    }
    const routes=[],residual=[];
    for(const c of cells){
      if(!c.cover.length){residual.push(c.q);continue;}
      const r=c.cover[0].r;
      routes.push({q:c.q,kind:'route',hierarchy:r.hierarchy,role:r.role,realization:r.status,flow:r.flow,flows:c.flows,routeId:r.routeId});
    }
    return {routes,residual};
  }

  function mergeRouteCells(cells) {
    const a=cells.slice().sort((p,q)=>p.q[1]-q.q[1]||p.q[0]-q.q[0]||p.q[3]-q.q[3]);
    const out=[],used=new Set();
    const sig=(c)=>(c.hierarchy||'')+'|'+(c.realization||'')+'|'+c.flows.map((f)=>f.key).sort().join('|');
    for(let i=0;i<a.length;i++){
      if(used.has(i))continue;const c=a[i],q=c.q.slice(),S=sig(c);used.add(i);
      let changed=true;
      while(changed){changed=false;for(let j=0;j<a.length;j++){
        if(used.has(j)||sig(a[j])!==S)continue;const d=a[j].q;
        if(Math.abs(d[1]-q[1])<1e-9&&Math.abs(d[3]-q[3])<1e-9&&Math.abs(d[0]-q[2])<1e-9){
          q[2]=d[2];used.add(j);changed=true;
        }
      }}
      out.push(Object.assign({},c,{q}));
    }
    return out;
  }

  function bestAccess(q, routes) {
    let best=null;
    for(const r of routes){
      const e=shared(q,r.q); if(!e)continue;
      if(!best||e.len>best.edge.len||(e.len===best.edge.len&&r.id<best.route.id))best={edge:e,route:r};
    }
    return best;
  }

  function metrics(q, side, servedBy, p, depthLevel, accessKind) {
    const F=frame(q,side), frontage=F.U, dep=F.V, aspect=Math.max(frontage,dep)/Math.max(0.001,Math.min(frontage,dep)),violations=[];
    if(frontage<p.minFrontage-1e-9)violations.push('frontage-small');
    if(frontage>p.maxFrontage+1e-9)violations.push('frontage-large');
    if(dep<p.minDepth-1e-9)violations.push('depth-small');
    if(dep>p.maxDepth+1e-9)violations.push('depth-large');
    if(aspect>p.maxAspect+1e-9)violations.push('aspect');
    const access=accessKind||'circulation';
    if(access==='unserved')violations.push('unserved');
    return {frontSide:F.front,frontage,depth:dep,aspect,servedBy,access,
      plannerDepth:depthLevel,role:violations.length?'support':'occupiable',violations};
  }

  function parcelize(q, side, servedBy, p, depthLevel, accessKind, parcels, diag) {
    const F=frame(q,side),U=F.U,V=F.V;
    if(qArea(q)<0.1)return;
    let maxN=Math.max(1,Math.floor(U/Math.max(0.1,p.minFrontage)));
    let n=clamp(Math.round(U/Math.max(0.1,p.targetFrontage)),1,maxN);
    while(U/n>p.maxFrontage&&n<maxN)n++;
    if(parcels.length+n>p.maxParcels){
      diag.capHit=true;n=Math.max(1,p.maxParcels-parcels.length);
    }
    if(n<=0)return;
    for(let i=0;i<n;i++){
      const u0=U*i/n,u1=U*(i+1)/n,qq=F.rect(u0,0,u1,V);
      const m=metrics(qq,side,servedBy,p,depthLevel,accessKind);
      if(parcels.length>=p.maxParcels){diag.capHit=true;break;}
      const id='parcel:'+parcels.length;
      parcels.push({id,q:qq,meta:m});diag.parcels++;
      if(m.role==='support')diag.support++;
      for(const v of m.violations)diag.violations[v]=(diag.violations[v]||0)+1;
    }
  }

  function localRoute(q, id, hierarchy, role) {
    return {id,q:q.slice(),kind:'route',hierarchy:hierarchy||'local',role:role||'catchment',
      realization:'local',flow:null,flows:[],routeId:id,local:true};
  }

  function serve(q, side, servedBy, p, depthLevel, localRoutes, parcels, diag, key) {
    if(qArea(q)<0.1)return;
    const F=frame(q,side),U=F.U,V=F.V,cw=p.localWidth;
    const deep=V>p.maxDepth*1.08;
    const geometry=V>p.minDepth+cw&&U>=2*p.minFrontage+cw;
    const canAdd=deep&&geometry&&depthLevel<p.maxServeDepth&&localRoutes.length<p.maxLocalRoutes;
    if(!canAdd){
      if(deep&&(depthLevel>=p.maxServeDepth||localRoutes.length>=p.maxLocalRoutes))diag.capHit=true;
      parcelize(q,side,servedBy,p,depthLevel,'circulation',parcels,diag);return;
    }

    // A deep catchment receives a perpendicular branch starting on the
    // circulation edge that serves it. This makes local circulation a tree:
    // every derived hall physically touches its parent instead of creating
    // disconnected parallel hallways behind rows of rooms.
    let u=Math.round(U/2);
    u=clamp(u,p.minFrontage+cw/2,U-p.minFrontage-cw/2);
    const u0=u-cw/2,u1=u+cw/2,cq=F.rect(u0,0,u1,V),id=key+'|local|'+localRoutes.length;
    localRoutes.push(localRoute(cq,id,'local','catchment'));diag.localRoutes++;

    const a=F.rect(0,0,u0,V),b=F.rect(u1,0,U,V);
    // Canonical u runs left-to-right for top/bottom access and top-to-bottom
    // for left/right access. Use the side that actually touches the branch.
    const sideA=(side==='top'||side==='bottom')?'right':'bottom';
    const sideB=(side==='top'||side==='bottom')?'left':'top';
    if(qArea(a)>0.1)serve(a,sideA,id,p,depthLevel+1,localRoutes,parcels,diag,key);
    if(qArea(b)>0.1)serve(b,sideB,id,p,depthLevel+1,localRoutes,parcels,diag,key);
  }

  function fallbackServe(q,p,dna,key,localRoutes,parcels,diag) {
    const w=q[2]-q[0],h=q[3]-q[1],cw=p.localWidth;
    if(localRoutes.length>=p.maxLocalRoutes){
      diag.capHit=true;diag.unserved++;
      parcelize(q,w>=h?'top':'left',null,p,0,'unserved',parcels,diag);return;
    }
    if(Math.min(w,h)<cw+p.minDepth*1.4||qArea(q)<p.minFrontage*p.minDepth*2){
      const side=w>=h?'top':'left';parcelize(q,side,null,p,0,'unserved',parcels,diag);diag.unserved++;return;
    }
    const axis=(dna&&dna.majorAxis)|| (w>=h?'x':'y');
    if(axis==='x'){
      const line=clamp((q[1]+q[3])/2,q[1]+cw/2,q[3]-cw/2), cq=[q[0],line-cw/2,q[2],line+cw/2], id=key+'|local-root';
      localRoutes.push(localRoute(cq,id,'local','root'));diag.localRoutes++;diag.rootLocal++;
      const a=[q[0],q[1],q[2],cq[1]],b=[q[0],cq[3],q[2],q[3]];
      if(qArea(a)>0.1)serve(a,'bottom',id,p,0,localRoutes,parcels,diag,key);
      if(qArea(b)>0.1)serve(b,'top',id,p,0,localRoutes,parcels,diag,key);
    }else{
      const line=clamp((q[0]+q[2])/2,q[0]+cw/2,q[2]-cw/2), cq=[line-cw/2,q[1],line+cw/2,q[3]], id=key+'|local-root';
      localRoutes.push(localRoute(cq,id,'local','root'));diag.localRoutes++;diag.rootLocal++;
      const a=[q[0],q[1],cq[0],q[3]],b=[cq[2],q[1],q[2],q[3]];
      if(qArea(a)>0.1)serve(a,'right',id,p,0,localRoutes,parcels,diag,key);
      if(qArea(b)>0.1)serve(b,'left',id,p,0,localRoutes,parcels,diag,key);
    }
  }

  /**
   * Build a bounded local plan for one owned rectangle.
   * realized = district-route realizations already clipped to this rectangle.
   */
  function planLocalSpace(q, realized, area, dna, key) {
    const p=policy(area,dna),arr=routeArrangement(q,realized),districtRoutes=mergeRouteCells(arr.routes),
      localRoutes=[],parcels=[],diag={parcels:0,support:0,localRoutes:0,rootLocal:0,unserved:0,capHit:false,violations:{}};

    const accessRoutes=districtRoutes.map((r,i)=>Object.assign({id:r.routeId||('route:'+i)},r));
    if(!districtRoutes.length){
      fallbackServe(q,p,dna,key,localRoutes,parcels,diag);
    }else{
      // Each residual rectangle is served from an existing route when possible.
      // If a partial district route leaves an isolated residual, create a bounded
      // local root there instead of filling it with arbitrary semantic rooms.
      const ordered=arr.residual.slice().sort((a,b)=>a[1]-b[1]||a[0]-b[0]||qArea(b)-qArea(a));
      for(const cell of ordered){
        const access=bestAccess(cell,accessRoutes.concat(localRoutes));
        if(access)serve(cell,access.edge.side,access.route.id,p,0,localRoutes,parcels,diag,key);
        else{diag.unserved++;fallbackServe(cell,p,dna,key+'|u'+diag.unserved,localRoutes,parcels,diag);}
      }
    }

    return {key,area,policy:p,districtRoutes,localRoutes,parcels,diagnostics:diag};
  }

  /**
   * Generic semantic compatibility gate. Dense cellular archetypes require a
   * served, dimensionally valid parcel. Large/open archetypes remain available
   * for support or residual floor.
   */
  // Semantic generators are consumers of parcels, not owners of arbitrary
  // leftover rectangles. Envelopes stay deliberately broad; their job is to
  // reject geometrically implausible assignments, not make every room uniform.
  const ARCHETYPE = {
    guest:         { minF:3.2, maxF:8.5,  minD:4.5, maxD:9.5,  maxA:2.5, served:true },
    office:        { minF:4,   maxF:18,   minD:4,   maxD:14,   maxA:4.2, served:true },
    stalls:        { minF:4,   maxF:20,   minD:4,   maxD:12,   maxA:4.5, served:true },
    warren:        { minF:5,   maxF:24,   minD:5,   maxD:16,   maxA:4.5, served:true },
    corridorRooms: { minF:6,   maxF:30,   minD:5,   maxD:18,   maxA:5,   served:true },
    house:         { minF:6,   maxF:22,   minD:5,   maxD:14,   maxA:3.5, served:true },
    store:         { minF:5,   maxF:26,   minD:5,   maxD:18,   maxA:4.5, served:true }
  };

  function spaceTypeCompatible(area,type,meta,U,V) {
    if(!meta)return true;
    const E=ARCHETYPE[type];
    if(!E)return true; // open/landmark/support archetypes may consume residual floor.
    if(meta.role!=='occupiable')return false;
    if(E.served&&(!meta.frontSide||meta.access==='unserved'))return false;
    if(meta.frontage<E.minF||meta.frontage>E.maxF)return false;
    if(meta.depth<E.minD||meta.depth>E.maxD)return false;
    if(meta.aspect>E.maxA)return false;
    return true;
  }

  Object.assign(BR,{ SPACE_POLICIES:POLICY, SPACE_ARCHETYPES:ARCHETYPE,
    spacePolicy:policy, planLocalSpace, spaceTypeCompatible });
})(typeof window!=='undefined'?window:globalThis);
