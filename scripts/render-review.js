// Optional review tooling: npm install --no-save @napi-rs/canvas
// The application and test runner remain dependency-free.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createCanvas,Path2D}=require('@napi-rs/canvas');
global.Path2D=Path2D;global.document={createElement:()=>createCanvas(1,1)};
const project=path.resolve(__dirname,'..'),source=process.argv[2]?path.resolve(process.argv[2]):project;
for(const f of ['core','areas','manifestation','layout','structure','spaceplan','zones','traversal','interior','boundary','world','render']){
 const file=path.join(source,'src',f+'.js');if(fs.existsSync(file))require(file);
}
const W=new BR.World(31337),canvas=createCanvas(1500,1100),ctx=canvas.getContext('2d'),out=path.join(project,'docs');
function render(name,cx,cy,zoom,opts={}){
 const view={cx,cy,zoom,w:1500,h:1100,dpr:1};
 const result=BR.draw(ctx,W,view,{walls:true,...opts},Infinity);assert(result.done);
 fs.writeFileSync(path.join(out,name+'.png'),canvas.toBuffer('image/png'));
 return {cx,cy,zoom};
}
if(source!==project){
 render('patterns-hotel-before',678.3766666622831,443.27501942822704,3);
 process.exit(0);
}
const coordinates={};
coordinates.hotel=render('patterns-hotel',678.3766666622831,443.27501942822704,3);
coordinates.closeup=render('patterns-closeup',678,443,9);
coordinates.traversal=render('patterns-traversal',678,443,7,{patterns:true,traversals:true,entrances:true});
coordinates.network=render('patterns-network',678,443,3,{patterns:true,connections:true,entrances:true});
const parking=W.manifestationsIn(-1800,-1800,1800,1800).filter(m=>m.type==='parking')
 .sort((a,b)=>Math.hypot(a.cx-678,a.cy-443)-Math.hypot(b.cx-678,b.cy-443))[0];
coordinates.parking=render('patterns-parking',parking.cx,parking.cy,4);
coordinates.substrate=render('patterns-substrate',0,0,5);
// The exact same final view must survive debug toggles without cached overlays.
render('patterns-closeup',678,443,9);const final=canvas.toBuffer('image/png');
BR.draw(ctx,W,{cx:678,cy:443,zoom:9,w:1500,h:1100,dpr:1},
 {walls:true,patterns:true,connections:true,traversals:true,entrances:true,clearances:true},Infinity);
BR.draw(ctx,W,{cx:678,cy:443,zoom:9,w:1500,h:1100,dpr:1},{walls:true},Infinity);
assert(final.equals(canvas.toBuffer('image/png')),'Debug overlays contaminated final architecture');
const atlas=createCanvas(1500,1000),ac=atlas.getContext('2d');
ac.fillStyle='#242628';ac.fillRect(0,0,1500,1000);const samples=[];
const ts=W.territoriesIn(-700,-700,1000,1000);
const names={loop:'Loop around a room',elbow:'L passage and corner room',cross:'Cross junction and four rooms',
 wing:'Room banks and shared access',enfilade:'Connected room sequence',open:'Traversal through open floor'};
let k=0;
for(const family of Object.keys(BR.PATTERNS)){
 const T=ts.find(t=>{const P=W.pattern(t),q=t.rects[0];return P.family===family&&t.rects.length===1&&Math.min(q[2]-q[0],q[3]-q[1])>=20;});
 assert(T,'No sample for '+family);const q=T.bbox,cx=(q[0]+q[2])/2,cy=(q[1]+q[3])/2;
 const sample=createCanvas(500,445),sc=sample.getContext('2d'),zoom=Math.min(470/(q[2]-q[0]+5),400/(q[3]-q[1]+5));
 BR.draw(sc,W,{cx,cy,zoom,w:500,h:445,dpr:1},{walls:true},Infinity);
 const x=k%3*500,y=Math.floor(k/3)*500;ac.drawImage(sample,x,y+55);
 ac.fillStyle='#edf0ee';ac.font='16px sans-serif';ac.fillText(names[family],x+12,y+23);
 ac.font='12px monospace';ac.fillStyle='#b7c5c0';ac.fillText(T.key+' / '+W.final(T),x+12,y+44);
 samples.push({family,key:T.key,area:W.final(T),cx,cy,zoom});k++;
}
fs.writeFileSync(path.join(out,'patterns-atlas.png'),atlas.toBuffer('image/png'));
fs.writeFileSync(path.join(out,'pattern-review-views.json'),JSON.stringify({seed:31337,coordinates,samples,debugToggleInvariant:true},null,2)+'\n');
console.log({debugToggleInvariant:true,coordinates,samples,stats:W.stats});
