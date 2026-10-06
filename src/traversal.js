/* Actual traversal within procedural rooms. Routes use existing floor, detour
 * around permanent solids and pools, and constrain detail without creating a
 * separately rendered floor strip. All searches and retries have explicit caps. */
(function(root){
  'use strict';
  const BR=root.BR,{clamp}=BR,EPS=1e-7,RADIUS=.34;
  const contains=(q,x,y)=>x>=q[0]-EPS&&x<=q[2]+EPS&&y>=q[1]-EPS&&y<=q[3]+EPS;
  const overlap=(a,b)=>a[0]<b[2]-EPS&&a[2]>b[0]+EPS&&a[1]<b[3]-EPS&&a[3]>b[1]+EPS;
  function subtract(q,b){
    if(!overlap(q,b))return [q];
    const x0=Math.max(q[0],b[0]),y0=Math.max(q[1],b[1]),x1=Math.min(q[2],b[2]),y1=Math.min(q[3],b[3]);
    const out=[];
    if(q[0]<x0)out.push([q[0],q[1],x0,q[3]]);
    if(x1<q[2])out.push([x1,q[1],q[2],q[3]]);
    if(q[1]<y0)out.push([x0,q[1],x1,y0]);
    if(y1<q[3])out.push([x0,y1,x1,q[3]]);
    return out;
  }
  function pathRect(a,b,r){return [Math.min(a[0],b[0])-r,Math.min(a[1],b[1])-r,
    Math.max(a[0],b[0])+r,Math.max(a[1],b[1])+r];}
  function trimRects(list,protectedRects){
    const out=[];
    for(let i=0;i<list.length;i+=4){const q=list.slice(i,i+4);
      if(!protectedRects.some(p=>overlap(p,q)))out.push(...q);}
    return out;
  }
  function trimLines(list,protectedRects){
    const out=[];
    for(let i=0;i<list.length;i+=4){
      const x0=list[i],y0=list[i+1],x1=list[i+2],y1=list[i+3],vertical=Math.abs(x1-x0)<EPS;
      if(!vertical&&Math.abs(y1-y0)>EPS){out.push(x0,y0,x1,y1);continue;}
      const c=vertical?x0:y0;let spans=[[Math.min(vertical?y0:x0,vertical?y1:x1),Math.max(vertical?y0:x0,vertical?y1:x1)]];
      for(const q of protectedRects){
        if(c<q[vertical?0:1]+EPS||c>q[vertical?2:3]-EPS)continue;
        const a=q[vertical?1:0],b=q[vertical?3:2],next=[];
        for(const [s0,s1] of spans){if(b<=s0||a>=s1)next.push([s0,s1]);
          else {if(a>s0)next.push([s0,a]);if(b<s1)next.push([b,s1]);}}
        spans=next;
      }
      for(const [a,b] of spans)if(b-a>.05)out.push(...(vertical?[c,a,c,b]:[a,c,b,c]));
    }
    return out;
  }
  function clearDetail(Z,rects){
    Z.props=trimRects(Z.props,rects);
    const out=[];
    for(let i=0;i<Z.pillars.length;i+=4){const [x,y,shape,size]=Z.pillars.slice(i,i+4),h=size/2;
      if(!rects.some(q=>overlap(q,[x-h,y-h,x+h,y+h])))out.push(x,y,shape,size);}
    Z.pillars=out;
    Z.minor=trimLines(Z.minor,rects);Z.major=trimLines(Z.major,rects);
  }
  function floorRects(Z,room){
    let floor=room.rects.map(q=>q.slice());
    for(const list of [Z.masses,Z.voids,Z.pools])for(let i=0;i<list.length;i+=4){
      const q=[list[i]-RADIUS,list[i+1]-RADIUS,list[i+2]+RADIUS,list[i+3]+RADIUS];
      floor=floor.flatMap(r=>subtract(r,q));
      if(floor.length>BR.PATTERN_LIMITS.navRects)return null;
    }
    return floor.filter(q=>q[2]-q[0]>=.7&&q[3]-q[1]>=.7);
  }
  function passage(a,b){
    const x0=Math.max(a[0],b[0]),x1=Math.min(a[2],b[2]),y0=Math.max(a[1],b[1]),y1=Math.min(a[3],b[3]);
    if(x1-x0>=.68&&y1-y0>=-EPS)return [(x0+x1)/2,(y0+y1)/2];
    if(y1-y0>=.68&&x1-x0>=-EPS)return [(x0+x1)/2,(y0+y1)/2];
    return null;
  }
  function nearestInterior(room,x,y){
    let best=null,d=Infinity;
    for(const q of room.rects){
      if(!contains(q,x,y))continue;
      const m=Math.min(.45,(q[2]-q[0])/3,(q[3]-q[1])/3);
      const p=[clamp(x,q[0]+m,q[2]-m),clamp(y,q[1]+m,q[3]-m)];
      const score=Math.abs(x-p[0])+Math.abs(y-p[1]);if(score<d){best=p;d=score;}
    }
    return best;
  }
  function planZoneTraversal(Z,access){
    if(Z.rounds.length||!Z.rooms.length)return null;
    const endpoints=Z.rooms.map(()=>[]),approaches=[];
    for(const a of access){
      const n=a.normal,p=[a.x+n[0]*.45,a.y+n[1]*.45];
      approaches.push(pathRect([a.x,a.y],[a.x+n[0]*1.8,a.y+n[1]*1.8],Math.max(.4,a.w/2)));
    }
    // Furniture and decorative fragments cannot occupy specified entrances.
    clearDetail(Z,approaches);
    for(const a of access){
      const n=a.normal,x=a.x+n[0]*.45,y=a.y+n[1]*.45,k=Z.doorRoomAt(x,y);
      if(k<0)return null;
      if(!Z.rooms[k].rects.some(q=>contains(q,a.x,a.y)))return null;
      const tangent=[-n[1],n[0]];
      for(const t of [-1,0,1]){
        const offset=t*Math.max(0,a.w/2-.1);
        if(Z.doorRoomAt(x+tangent[0]*offset,y+tangent[1]*offset)<0)return null;
      }
      // A tiny overlap at the end of a wide aperture protects its floor, but
      // cannot itself carry a player-sized crossing. The adjacent wide owner
      // provides the crossing; this room retains its normal internal access.
      if(!a.clearanceOnly)endpoints[k].push({id:a.id,point:[x,y],door:[a.x,a.y],width:a.w,external:a.external});
    }
    const uf=BR.makeUF(Z.rooms.length);
    for(let i=0;i<Z.links.length;i++){
      const l=Z.links[i];if(l.w<.68)return null;
      for(const k of [l.a,l.b]){
        const p=nearestInterior(Z.rooms[k],l.x,l.y);if(!p)return null;
        endpoints[k].push({id:'room-door:'+i,point:p,door:[l.x,l.y],width:l.w});
      }
      uf.union(l.a,l.b);
    }
    if(Z.rooms.some((_,i)=>uf.find(i)!==uf.find(0)))return null;
    const routes=[],clearances=[];
    for(let ri=0;ri<Z.rooms.length;ri++){
      const floor=floorRects(Z,Z.rooms[ri]);if(!floor||!floor.length)return null;
      const adjacency=floor.map(()=>[]);
      for(let i=0;i<floor.length;i++)for(let j=i+1;j<floor.length;j++){
        const p=passage(floor[i],floor[j]);if(p){adjacency[i].push({to:j,p});adjacency[j].push({to:i,p});}
      }
      let root=0;
      for(let i=1;i<floor.length;i++)if((floor[i][2]-floor[i][0])*(floor[i][3]-floor[i][1])>
        (floor[root][2]-floor[root][0])*(floor[root][3]-floor[root][1]))root=i;
      const prev=floor.map(()=>null),queue=[root];prev[root]={to:root,p:null};
      for(let h=0;h<queue.length;h++)for(const e of adjacency[queue[h]])if(!prev[e.to]){
        prev[e.to]={to:queue[h],p:e.p};queue.push(e.to);
      }
      if(queue.length!==floor.length)return null;
      const r=floor[root],hub=[(r[0]+r[2])/2,(r[1]+r[3])/2];
      for(const endpoint of endpoints[ri]){
        const target=floor.findIndex(q=>contains(q,...endpoint.point));if(target<0||!prev[target])return null;
        const portals=[];let i=target;
        while(i!==root){portals.push(prev[i].p);i=prev[i].to;}
        portals.reverse();const points=[hub.slice()];
        for(const p of portals.concat([endpoint.point,endpoint.door])){
          const a=points[points.length-1];
          const approach=p===endpoint.point&&Math.abs(endpoint.point[1]-endpoint.door[1])>
            Math.abs(endpoint.point[0]-endpoint.door[0]);
          if(Math.abs(a[0]-p[0])>EPS&&Math.abs(a[1]-p[1])>EPS)points.push(approach?[a[0],p[1]]:[p[0],a[1]]);
          if(Math.abs(points[points.length-1][0]-p[0])>EPS||Math.abs(points[points.length-1][1]-p[1])>EPS)points.push(p.slice());
        }
        for(let j=1;j<points.length;j++)clearances.push(pathRect(points[j-1],points[j],.32));
        routes.push({id:endpoint.id,room:ri,points,width:.64,aperture:endpoint.width,
          external:!!endpoint.external,kind:'through-room'});
      }
    }
    clearDetail(Z,clearances);
    return {routes,clearances,rooms:Z.rooms.length};
  }
  Object.assign(BR,{planZoneTraversal,subtractRect:subtract,traversalPathRect:pathRect,
    traversalOverlap:overlap,trimTraversalLines:trimLines});
})(typeof window!=='undefined'?window:globalThis);
