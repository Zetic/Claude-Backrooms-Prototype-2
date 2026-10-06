/*
 * manifestation.js - separates semantic area identity from spatial extent.
 *
 * A semantic AREA no longer implies one large compact biome. A deterministic
 * manifestation chooses a scale and footprint grammar (compact, elongated,
 * branched, fragmented, interwoven or regional), then an internal structural
 * program assigns generic roles such as core, branch, open, service, landmark,
 * connector, terminal, void and repeating.
 *
 * The generator below is area-agnostic. Area definitions supply only weights.
 */
(function (root) {
  'use strict';
  const BR = root.BR;
  const { Rng, hash4, fbm, contrast } = BR;

  const S = { MANIFEST:0x6d41, PROGRAM:0x6d42, WARPX:0x6d43, WARPY:0x6d44 };
  const SCALE = {
    small:    [58, 92],
    medium:   [88, 138],
    large:    [132, 198],
    regional: [190, 262]
  };
  const DEFAULT_FORMS = { compact:1.4, elongated:1.2, branched:1.5, fragmented:0.8, interwoven:0.8, regional:0.35 };
  const DEFAULT_SCALES = { small:1.2, medium:2.5, large:1, regional:0.2 };
  const DEFAULT_ROLES = { core:1, branch:1.4, open:0.8, service:0.55, landmark:0.35, connector:0.7, terminal:0.55, void:0.25, repeating:1.7 };

  const ROLE_ZONE_BIAS = {
    core:       { open:1.9, gallery:1.5, courtyard:1.45, ring:1.25, round:1.2, pools:1.2, parking:1.15 },
    branch:     { office:1.2, guest:1.2, stalls:1.15, warren:1.15, corridorRooms:1.2, pools:1.1, parking:1.1 },
    open:       { open:2.2, gallery:1.7, courtyard:1.7, pool:1.5, pools:1.5, parking:1.35, round:1.25 },
    service:    { store:1.9, stalls:1.5, room:1.6, machinery:2, stairs:1.5, split:1.15 },
    landmark:   { open:1.7, gallery:2, courtyard:1.7, ring:1.55, round:1.5, pool:1.4, pools:1.25 },
    connector:  { corridorRooms:1.8, gallery:1.45, open:1.35, split:1.25, stairs:1.2 },
    terminal:   { gallery:1.45, open:1.35, store:1.25, split:1.3, courtyard:1.2, pool:1.2 },
    void:       { courtyard:2.4, open:2, pools:1.45, pool:1.35 },
    repeating:  { office:1.55, guest:1.55, stalls:1.35, warren:1.35, corridorRooms:1.25, pools:1.25, parking:1.4 }
  };

  const weighted = (rng, obj, fallback) => {
    if (!obj || !Object.keys(obj).length) return fallback;
    return rng.weighted(obj);
  };
  const lobe = (cx,cy,rx,ry,k) => ({cx,cy,rx:Math.max(8,rx),ry:Math.max(8,ry),k:k===undefined?0.55:k});
  function lobeDist(L,x,y) {
    const nx=Math.abs(x-L.cx)/L.rx, ny=Math.abs(y-L.cy)/L.ry;
    return (1-L.k)*Math.sqrt(nx*nx+ny*ny)+L.k*Math.max(nx,ny);
  }
  function bboxOf(lobes) {
    let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
    for(const L of lobes){x0=Math.min(x0,L.cx-L.rx);y0=Math.min(y0,L.cy-L.ry);x1=Math.max(x1,L.cx+L.rx);y1=Math.max(y1,L.cy+L.ry);}
    return [x0,y0,x1,y1];
  }

  function manifestationSeed(seed,a,b) {
    const cfg=BR.AREA_CFG, C=cfg.districtCell;
    const r=new Rng(hash4(seed,a,b,S.MANIFEST));
    const exists=r.f()<cfg.districtP;
    const cx=(a+0.15+0.7*r.f())*C, cy=(b+0.15+0.7*r.f())*C;
    const type=weighted(r,BR.MANIFEST_TYPES||{},'offices');
    const A=BR.AREAS[type]||{}, M=A.manifestation||{};
    const form=weighted(r,M.forms||DEFAULT_FORMS,'compact');
    const scale=weighted(r,M.scales||DEFAULT_SCALES,'medium');
    const sr=SCALE[scale]||SCALE.medium, factor=M.scale||1;
    const radius=r.range(sr[0],sr[1])*factor;
    const axis=r.f()<0.5?'x':'y', shape=r.range(0.25,0.8);
    const long=radius*r.range(0.95,1.18), short=radius*r.range(0.52,0.82);
    const lobes=[], holes=[];
    const add=(x,y,rx,ry,k)=>lobes.push(lobe(x,y,rx,ry,k));
    const along=(d)=>axis==='x'?[cx+d,cy]:[cx,cy+d];
    const perp=(d)=>axis==='x'?[cx,cy+d]:[cx+d,cy];

    if(form==='compact'){
      add(cx,cy,long,short,shape);
      if(r.f()<0.38){const p=perp(r.range(-0.35,0.35)*short);add(p[0],p[1],long*.48,short*.5,r.range(.25,.7));}
    } else if(form==='elongated'){
      const n=r.int(2,3), step=long*.58;
      for(let i=0;i<n;i++){const d=(i-(n-1)/2)*step,p=along(d);add(p[0],p[1],long*.58,short*.72,r.range(.25,.75));}
    } else if(form==='branched'){
      add(cx,cy,long*.58,short*.72,shape);
      const n=r.int(2,4);
      for(let i=0;i<n;i++){
        const main=(i===0||r.f()<.55), sign=(hash4(seed,a,b,0x7100+i)&1)?1:-1;
        const p=main?along(sign*r.range(.55,.9)*long):perp(sign*r.range(.55,.95)*short);
        add(p[0],p[1],long*r.range(.38,.55),short*r.range(.42,.65),r.range(.25,.72));
        const mx=(cx+p[0])/2,my=(cy+p[1])/2;add(mx,my,long*.27,short*.34,r.range(.35,.8));
      }
    } else if(form==='fragmented'){
      const n=r.int(3,5);
      for(let i=0;i<n;i++){
        const ang=(Math.PI*2*i/n)+r.range(-.45,.45), d=radius*r.range(.28,.88);
        const px=cx+Math.cos(ang)*d,py=cy+Math.sin(ang)*d;
        add(px,py,long*r.range(.28,.48),short*r.range(.38,.62),r.range(.2,.7));
      }
    } else if(form==='interwoven'){
      add(cx,cy,long*.62,short*.72,shape);
      const n=r.int(3,5);
      for(let i=0;i<n;i++){
        const ang=(Math.PI*2*i/n)+r.range(-.35,.35),d=radius*r.range(.38,.78);
        add(cx+Math.cos(ang)*d,cy+Math.sin(ang)*d,long*r.range(.3,.5),short*r.range(.38,.62),r.range(.25,.75));
      }
      const hc=r.int(1,Math.min(3,n));
      for(let i=0;i<hc;i++){
        const ang=r.range(0,Math.PI*2),d=radius*r.range(.12,.58);
        holes.push(lobe(cx+Math.cos(ang)*d,cy+Math.sin(ang)*d,radius*r.range(.09,.18),radius*r.range(.08,.16),r.range(.2,.7)));
      }
    } else { // regional
      add(cx,cy,long*.82,short*.9,shape);
      const n=r.int(2,4);
      for(let i=0;i<n;i++){
        const ang=(Math.PI*2*i/n)+r.range(-.3,.3),d=radius*r.range(.28,.62);
        add(cx+Math.cos(ang)*d,cy+Math.sin(ang)*d,long*r.range(.42,.66),short*r.range(.5,.78),r.range(.3,.8));
      }
      if(r.f()<(M.intrusion===undefined?0.28:M.intrusion)){
        const ang=r.range(0,Math.PI*2),d=radius*r.range(.12,.42);
        holes.push(lobe(cx+Math.cos(ang)*d,cy+Math.sin(ang)*d,radius*r.range(.08,.15),radius*r.range(.08,.15),r.range(.2,.7)));
      }
    }

    // Optional substrate intrusion applies to any form through data rather than
    // semantic-name checks.
    const intrusion=M.intrusion||0;
    if(form!=='interwoven'&&form!=='regional'&&r.f()<intrusion){
      const ang=r.range(0,Math.PI*2),d=radius*r.range(.18,.62);
      holes.push(lobe(cx+Math.cos(ang)*d,cy+Math.sin(ang)*d,radius*r.range(.07,.14),radius*r.range(.07,.14),r.range(.2,.7)));
    }

    const bounds=bboxOf(lobes), rx=(bounds[2]-bounds[0])/2, ry=(bounds[3]-bounds[1])/2;
    return { exists,type,id:a+','+b,a,b,cx,cy,rx,ry,k:shape,axis,form,scale,radius,lobes,holes,bounds };
  }

  function manifestationDistance(M,x,y){
    let best=Infinity;
    for(const L of M.lobes)best=Math.min(best,lobeDist(L,x,y));
    if(best>=1)return best;
    for(const H of M.holes)if(lobeDist(H,x,y)<1)return Infinity;
    return best;
  }

  function manifestationAt(W,x,y){
    const cfg=BR.AREA_CFG,seed=W.seed,C=cfg.districtCell,ws=cfg.warpScale;
    const wx=x+cfg.warp*2*(contrast(fbm(seed^S.WARPX,x/ws,y/ws,2),2)-.5);
    const wy=y+cfg.warp*2*(contrast(fbm(seed^S.WARPY,x/ws,y/ws,2),2)-.5);
    const da=Math.floor(wx/C),db=Math.floor(wy/C);
    let best=1,hit=null;
    for(let a=da-1;a<=da+1;a++)for(let b=db-1;b<=db+1;b++){
      const M=manifestationSeed(seed,a,b);if(!M.exists)continue;
      const d=manifestationDistance(M,wx,wy);
      if(d<best){best=d;hit=M;}
    }
    if(!hit)return {area:'backrooms',district:null,manifestation:null,form:'substrate',scale:'regional'};
    return {area:hit.type,district:hit.id,manifestation:hit.id,form:hit.form,scale:hit.scale};
  }

  function buildManifestationProgram(W,area,id){
    if(!id)return null;
    const ij=id.split(','),a=+ij[0],b=+ij[1],M=manifestationSeed(W.seed,a,b);
    if(!M.exists||M.type!==area)return null;
    const A=BR.AREAS[area]||{}, cfg=A.program||{}, roles=cfg.roles||DEFAULT_ROLES;
    const rng=new Rng(hash4(W.seed,a,b,S.PROGRAM));
    const key='program:'+area+':'+id, regions=[];
    const push=(role,x,y,radius,source)=>regions.push({id:key+'|region|'+regions.length,role,x:Math.round(x),y:Math.round(y),radius:Math.max(8,Math.round(radius)),source:source||'seed'});
    const core=M.lobes.slice().sort((u,v)=>((u.cx-M.cx)**2+(u.cy-M.cy)**2)-((v.cx-M.cx)**2+(v.cy-M.cy)**2))[0];
    push('core',core.cx,core.cy,Math.min(core.rx,core.ry)*.72,'core');

    const others=M.lobes.filter((L)=>L!==core);
    for(const L of others){
      const role=weighted(rng,cfg.lobeRoles||{branch:1.8,repeating:1.3,open:.65,service:.35,landmark:.25},'branch');
      push(role,L.cx,L.cy,Math.min(L.rx,L.ry)*.7,'lobe');
      push('connector',(core.cx+L.cx)/2,(core.cy+L.cy)/2,Math.max(12,Math.min(L.rx,L.ry)*.36),'connector');
    }

    if(others.length){
      const far=others.slice().sort((u,v)=>((v.cx-core.cx)**2+(v.cy-core.cy)**2)-((u.cx-core.cx)**2+(u.cy-core.cy)**2))[0];
      push('terminal',far.cx+(far.cx-core.cx)*.28,far.cy+(far.cy-core.cy)*.28,Math.min(far.rx,far.ry)*.42,'terminal');
    }

    for(const H of M.holes)push('void',H.cx,H.cy,Math.max(H.rx,H.ry),'substrate');

    const target={small:4,medium:6,large:8,regional:10}[M.scale]||6;
    let attempts=0;
    while(regions.length<target&&attempts++<target*6){
      const L=M.lobes[rng.int(0,M.lobes.length-1)];
      const x=L.cx+rng.range(-.58,.58)*L.rx,y=L.cy+rng.range(-.58,.58)*L.ry;
      if(manifestationDistance(M,x,y)>=1)continue;
      let role=weighted(rng,roles,'repeating');
      if(role==='core'||role==='connector'||role==='void')role='repeating';
      push(role,x,y,Math.min(L.rx,L.ry)*rng.range(.28,.5),'program');
    }

    const routeDensity=cfg.routeDensity===undefined?1:cfg.routeDensity;
    return {key,area,id,manifestation:M,regions,roles,routeDensity};
  }

  function programRoleAt(P,x,y){
    if(!P||!P.regions||!P.regions.length)return 'repeating';
    let best=null,score=Infinity;
    for(const R of P.regions){
      const d=Math.hypot(x-R.x,y-R.y)/Math.max(1,R.radius);
      if(d<score){score=d;best=R;}
    }
    return best?best.role:'repeating';
  }

  function programZoneWeights(area,role,base){
    const out={},bias=ROLE_ZONE_BIAS[role]||{};
    for(const k in (base||{}))out[k]=base[k]*(bias[k]||1);
    return out;
  }

  function programPreferredZone(area,role){
    const A=BR.AREAS[area]||{},base=A.zones||A.main||{},w=programZoneWeights(area,role,base);
    let best='open',bw=-Infinity;
    for(const k in w)if(w[k]>bw){bw=w[k];best=k;}
    return best;
  }

  Object.assign(BR,{
    MANIFESTATION_FORMS:Object.keys(DEFAULT_FORMS), MANIFESTATION_SCALES:SCALE,
    PROGRAM_ROLES:Object.keys(DEFAULT_ROLES), manifestationSeed, manifestationDistance,
    manifestationAt, buildManifestationProgram, programRoleAt, programZoneWeights,
    programPreferredZone
  });
})(typeof window!=='undefined'?window:globalThis);
