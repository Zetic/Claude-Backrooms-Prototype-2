/* Realize canonical shared entrances. Both patterns already contain and protect
 * these apertures; boundary generation cannot search for or invent a doorway. */
(function(root){
  'use strict';
  const BR=root.BR;
  function buildBoundary(W,A,B){
    const info=BR.pairInfo(W,A,B);A=info.a;B=info.b;
    const IA=W.interior(A),IB=W.interior(B),ports=BR.connectionPorts(W,A,B);
    const out={key:info.key,a:A.key,b:B.key,wall:info.wall,cross:info.fa!==info.fb,
      walls:[],doors:[],continuations:[],links:[],ports,ax:A.bbox[0],ay:A.bbox[1],
      semantic:info.fa!==info.fb?'transition':info.wall==='open'?'open':ports.length?'doorway':'separation'};
    function probe(p,t){
      const s=info.segs[p.si],n=BR.patternInward(s.side);
      const x=p.o==='v'?p.c:t,y=p.o==='h'?p.c:t;
      const a=BR.interiorRoomAt(IA,x+n[0]*.45,y+n[1]*.45,true);
      const b=BR.interiorRoomAt(IB,x-n[0]*.45,y-n[1]*.45,true);
      return a>=0&&b>=0?[a,b]:null;
    }
    for(const p of ports){
      const t=(p.s0+p.s1)/2;let rr=probe(p,t),at=t;
      // A planned aperture may span two room envelopes. Probe only within that
      // exact aperture; its position/width is never changed after infill.
      if(!rr)for(let k=p.s0+.12;k<p.s1&&!rr;k+=.24){rr=probe(p,k);at=k;}
      if(!rr){W.stats.doorFailures++;throw new Error('Shared entrance not realized: '+p.id);}
      out.doors.push({x:p.x,y:p.y,w:p.w,o:p.o,kind:p.kind,id:p.id});
      out.links.push({a:{key:A.key,room:rr[0]},b:{key:B.key,room:rr[1]},
        kind:p.kind,x:p.o==='v'?p.c:at,y:p.o==='h'?p.c:at,w:p.w,port:p.id});
    }
    // An open semantic boundary retains continuous floor. Its planned ports
    // guarantee access; additional facing rooms receive their actual links.
    if(info.wall==='open'){
      const seen=new Set(out.links.map(l=>l.a.room+','+l.b.room));
      for(let si=0;si<info.segs.length;si++){
        const s=info.segs[si],p={o:s.o,c:s.c,si};
        for(let t=s.s0+.5;t<s.s1-.5;t+=1){const rr=probe(p,t);if(!rr||seen.has(rr.join(',')))continue;
          seen.add(rr.join(','));out.links.push({a:{key:A.key,room:rr[0]},b:{key:B.key,room:rr[1]},
            kind:'opening',x:s.o==='v'?s.c:t,y:s.o==='h'?s.c:t,w:0});}
      }
      return out;
    }
    info.segs.forEach((s,si)=>{
      const gaps=ports.filter(p=>p.si===si).sort((a,b)=>a.s0-b.s0);
      const push=(a,b)=>{if(b-a>.05)out.walls.push(...(s.o==='v'?[s.c,a,s.c,b]:[a,s.c,b,s.c]));};
      let t=s.s0;
      for(const p of gaps){push(t,p.s0);t=Math.max(t,p.s1);}push(t,s.s1);
    });
    return out;
  }
  BR.buildBoundary=buildBoundary;
})(typeof window!=='undefined'?window:globalThis);
