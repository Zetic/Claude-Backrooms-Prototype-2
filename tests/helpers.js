const path=require('node:path');
for(const f of ['core','areas','manifestation','layout','structure','spaceplan','zones','traversal','interior','boundary','world'])
  require(path.join(__dirname,'..','src',f+'.js'));
const BR=globalThis.BR;
function fingerprint(W,q,reverse=false){
  const ts=W.territoriesIn(...q).sort((a,b)=>a.key.localeCompare(b.key));if(reverse)ts.reverse();
  const data=new Map(),pairs=new Map();
  for(const T of ts){
    const I=W.interior(T);data.set(T.key,JSON.stringify({rects:T.rects,area:W.final(T),district:T.district,
      pattern:I.pattern,zones:I.zones,rooms:I.rooms,links:I.links,walls:I.walls,minor:I.minor,
      traversals:I.traversals,entranceClearances:I.entranceClearances,diagnostics:I.diagnostics}));
    for(const n of W.adj(T)){const k=BR.pairKey(T,n.U);if(!pairs.has(k))pairs.set(k,JSON.stringify(W.boundary(T,n.U)));}
  }
  const sorted=m=>[...m].sort((a,b)=>a[0].localeCompare(b[0]));return JSON.stringify([sorted(data),sorted(pairs)]);
}
function components(nodes,edges){
  const adj=new Map([...nodes].map(k=>[k,[]]));
  for(const [a,b]of edges)if(adj.has(a)&&adj.has(b)){adj.get(a).push(b);adj.get(b).push(a);}
  const labels=new Map(),sizes=[];
  for(const k of adj.keys())if(!labels.has(k)){
    const stack=[k],c=sizes.length;labels.set(k,c);let count=0;
    while(stack.length){const u=stack.pop();count++;for(const v of adj.get(u))if(!labels.has(v)){labels.set(v,c);stack.push(v);}}
    sizes.push(count);
  }
  return {labels,sizes};
}
function harness(){let failures=0;return {
  check(name,ok,detail=''){console.log((ok?'ok   ':'FAIL ')+name+(detail?' ('+detail+')':''));if(!ok)failures++;},
  finish(){console.log(failures?failures+' checks failed':'All checks passed.');process.exitCode=failures?1:0;}
};}
module.exports={BR,fingerprint,components,harness};
