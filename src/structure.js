/* Architectural composition and shared entrances. Global connectivity has no
 * corridor footprint. Neither entrance planning nor composition reads interiors. */
(function(root){
  'use strict';
  const BR=root.BR,{Rng,clamp}=BR;
  const PLANNED=new Set(Object.keys(BR.AREAS).filter(k=>BR.AREAS[k].role==='district'));
  function buildDistrictStructure(W,area,district){
    if(!PLANNED.has(area)||!district)return null;
    const [a,b]=district.split(',').map(Number),M=W.manifestSeed(a,b);
    if(!M.exists||M.type!==area)return null;
    const dna=BR.architectureDNA(W,{district,cx:M.cx,cy:M.cy,base:area},area);
    const program=W.programBy(area,district);
    return {key:'composition:'+area+':'+district,area,district,manifestation:M,
      program,programKey:program.key,dna,dnaKey:dna.key,bounds:M.bounds.slice()};
  }
  // Canonical pair ownership fixes the aperture before either side chooses a
  // pattern. Optional connections use the existing bounded base-edge bypass.
  function connectionPorts(W,A,B){
    const info=BR.pairInfo(W,A,B),n=BR.doorCount(W,A,B);
    if(info.mode==='never'||(info.wall!=='open'&&!n))return [];
    const segments=info.segs.map((s,si)=>({s,si})).filter(o=>o.s.s1-o.s.s0>=3.2)
      .sort((a,b)=>(b.s.s1-b.s.s0)-(a.s.s1-a.s.s0)||a.si-b.si);
    if(!segments.length)return [];
    const rng=new Rng(info.h^0x72746f70),count=Math.min(2,Math.max(1,n)),out=[];
    for(let k=0;k<count;k++){
      const {s,si}=segments[k%segments.length],len=s.s1-s.s0;
      const width=info.wall==='open'?Math.min(5,len-1.2):Math.min(2.4,len-1.2);
      let t=s.s0+len*(count>1&&segments.length===1?(k+1)/(count+1):rng.range(.35,.65));
      t=clamp(t,s.s0+width/2+.3,s.s1-width/2-.3);
      out.push({id:info.key+'|port|'+k,pairKey:info.key,a:info.a.key,b:info.b.key,
        si,o:s.o,c:s.c,s0:t-width/2,s1:t+width/2,w:width,
        x:s.o==='v'?s.c:t,y:s.o==='h'?s.c:t,sideA:s.side,ri:s.ri,uj:s.uj,
        kind:info.fa!==info.fb?'transition':info.wall==='open'?'opening':'door',
        required:info.mode==='base'||BR.isPocket(info.fa)||BR.isPocket(info.fb)});
    }
    return out;
  }
  function territoryPorts(W,T){
    const out=[];
    for(const n of W.adj(T))for(const p of connectionPorts(W,T,n.U)){
      const first=p.a===T.key,side=first?p.sideA:({0:1,1:0,2:3,3:2})[p.sideA];
      out.push(Object.assign({},p,{neighbor:n.U.key,side,rectIndex:first?p.ri:p.uj}));
    }
    return out.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  }
  Object.assign(BR,{STRUCTURE_AREAS:PLANNED,buildDistrictStructure,connectionPorts,territoryPorts});
})(typeof window!=='undefined'?window:globalThis);
