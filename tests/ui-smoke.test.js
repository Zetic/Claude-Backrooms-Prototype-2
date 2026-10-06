// Executes the actual HTML controller with a minimal DOM adapter. Generation
// remains real; drawing is captured. This is not a browser-engine test.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {BR,harness}=require('./helpers'),{check,finish}=harness();
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
class Element{
 constructor(tag='DIV'){this.tagName=tag.toUpperCase();this.events={};this.style={};this.value='';this.checked=false;this.innerHTML='';this.textContent='';this.children=[];
  const classes=new Set();this.classList={add:k=>classes.add(k),remove:k=>classes.delete(k),toggle:k=>classes.has(k)?classes.delete(k):classes.add(k)};}
 addEventListener(name,fn){(this.events[name]||(this.events[name]=[])).push(fn);}
 dispatch(name,extra={}){for(const fn of this.events[name]||[])fn({target:this,preventDefault(){},...extra});}
 appendChild(el){this.children.push(el);}setPointerCapture(){}getContext(){return {};}
}
const elements=new Map();for(const m of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"/gi))elements.set(m[2],new Element(m[1]));
const heading=new Element('h1'),document={getElementById:id=>elements.get(id)||null,createElement:tag=>new Element(tag),querySelector:s=>s==='#hud h1'?heading:null};
const window=new Element('window');Object.assign(window,{BR,innerWidth:900,innerHeight:600,devicePixelRatio:1});
const frames=[],timers=new Map(),location={hash:'#seed=31337&x=0&y=0&z=2'};let timerID=0,last=null,clock=0;
const history={replaceState(a,b,hash){location.hash=hash;}};
BR.draw=(ctx,W,view,opts)=>{
 last={W,view:{...view},opts:{...opts}};W.collect(view.cx-35,view.cy-35,view.cx+35,view.cy+35,Infinity,{interiors:true});
 return {tiles:1,built:1,mode:opts.areaMap?'plan':'detail',done:true};
};
const context={window,document,location,history,URLSearchParams,console,
 performance:{now:()=>++clock},requestAnimationFrame:fn=>frames.push(fn),
 setTimeout:fn=>{timers.set(++timerID,fn);return timerID;},clearTimeout:id=>timers.delete(id)};
const scripts=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m=>m[1]).filter(s=>s.trim());
vm.runInNewContext(scripts.join('\n'),context,{filename:'index.html',timeout:10000});
function flush(){for(const fn of frames.splice(0))fn(++clock);for(const [id,fn]of [...timers]){timers.delete(id);fn();}}
flush();
check('HTML controller initializes with real world generation',window.__ready&&window.__world().seed===31337&&elements.get('legend').children.length===BR.AREA_ORDER.length);
for(const stage of ['manifestations','program','dna','patterns','connections','envelopes','traversals','entrances','full','final']){
 elements.get('stage').value=stage;elements.get('stage').dispatch('change');flush();
 check('generation stage '+stage+' executes',last!==null&&window.__ready);
}
check('final stage removes all architecture debug flags',!['patterns','connections','roomEnvelopes','traversals','entrances','clearances','infillFailures'].some(k=>last.opts[k]));
elements.get('o-traversals').checked=true;elements.get('o-traversals').dispatch('change');flush();
check('individual traversal overlay reaches the renderer',last.opts.traversals&&new URLSearchParams(location.hash.slice(1)).get('traversals')==='1');
elements.get('goto').value='678,443';elements.get('goto').dispatch('change');flush();
check('coordinate navigation updates the shared view',last.view.cx===678&&last.view.cy===443);
elements.get('c').dispatch('pointermove',{clientX:450,clientY:300});flush();
check('hover inspection includes the architectural pattern',elements.get('info').innerHTML.includes('pattern '));
elements.get('c').dispatch('wheel',{clientX:450,clientY:300,deltaY:-100,deltaMode:0});flush();
check('zoom remains operational',last.view.zoom>2);
elements.get('seed').value='7';elements.get('seed').dispatch('change');flush();
check('changing seed replaces the generated world',window.__world().seed===7);
elements.get('home').dispatch('click');flush();
check('home navigation remains operational',last.view.cx===0&&last.view.cy===0);
finish();
