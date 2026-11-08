/* MyBoon prototype notes. Usage: set window.PROTO_NOTES = {pages:[...], notes:[{sel,title,comp,tokens,beh,states,data,q}]} then load this file.
   Pins show only on notes whose element is visible. ?notes turns notes on at load, ?note=N also opens card N. */
(function(){
const cfg=window.PROTO_NOTES||{notes:[]},Q=new URLSearchParams(location.search),isProto=Q.has('proto'),embed=Q.has('embed');
const esc=s=>String(s==null?'':s);
if(embed&&window.parent!==window){
 document.documentElement.classList.add('mb-embed');
 const st=document.createElement('style');
 st.textContent='html.mb-embed,html.mb-embed body{height:auto!important;min-height:0!important;background:#021821}'
  +'html.mb-embed body.proto{height:auto!important;overflow:visible!important;padding:12px 0!important}'
  +'html.mb-embed .stage{min-height:0!important;height:auto!important;justify-content:flex-start!important;padding:8px 0 16px!important}'
  +'html.mb-embed .phone,html.mb-embed .ap-ph,html.mb-embed #pp{height:844px!important}'
  +'html.mb-embed #ap{width:min(390px,100%);margin:0 auto}'
  +'html.mb-embed .nav>div,html.mb-embed nav.tabs>span{cursor:pointer}';
 document.head.appendChild(st);
 if(isProto){
  document.querySelectorAll(cfg.phone||'.phone').forEach(function(ph){
   ph.querySelectorAll('.nav').forEach(function(n){
    if(getComputedStyle(n).position==='absolute'){
     n.parentElement.appendChild(n);
     Object.assign(n.style,{position:'sticky',bottom:'0',left:'auto',right:'auto',zIndex:20});
    }
   });
  });
 }
 const scrollable=function(el,axis){
  while(el&&el!==document.documentElement){
   const cs=getComputedStyle(el),ov=axis==='x'?cs.overflowX:cs.overflowY;
   const size=axis==='x'?el.scrollWidth-el.clientWidth:el.scrollHeight-el.clientHeight;
   if((ov==='auto'||ov==='scroll')&&size>2)return el;
   el=el.parentElement;
  }
  return null;
 };
 const forward=function(dy){if(dy)parent.postMessage({t:'mb-scroll',y:dy},'*')};
 const handsOff=function(t){return t.closest&&t.closest('[data-grab],[data-thumb],[data-swipe],input,textarea')};
 addEventListener('wheel',function(e){
  if(handsOff(e.target))return;
  const sc=scrollable(e.target,'y');
  if(sc){
   const atTop=sc.scrollTop<=0,atBot=sc.scrollTop+sc.clientHeight>=sc.scrollHeight-1;
   if(e.deltaY<0&&!atTop)return;
   if(e.deltaY>0&&!atBot)return;
  }
  if(!e.deltaY)return;
  e.preventDefault();
  forward(e.deltaY);
 },{passive:false,capture:true});
 let tx=0,ty=0;
 addEventListener('touchstart',function(e){tx=e.touches[0].clientX;ty=e.touches[0].clientY},{passive:true,capture:true});
 addEventListener('touchmove',function(e){
  if(handsOff(e.target))return;
  const x=e.touches[0].clientX,y=e.touches[0].clientY,dx=tx-x,dy=ty-y;tx=x;ty=y;
  if(Math.abs(dx)>Math.abs(dy)&&scrollable(e.target,'x'))return;
  const sc=scrollable(e.target,'y');
  if(sc){
   const atTop=sc.scrollTop<=0,atBot=sc.scrollTop+sc.clientHeight>=sc.scrollHeight-1;
   if(dy<0&&!atTop)return;
   if(dy>0&&!atBot)return;
  }
  if(!dy)return;
  e.preventDefault();
  forward(dy);
 },{passive:false,capture:true});
 addEventListener('click',function(e){
  const tab=e.target.closest('.nav > div, nav.tabs > span');
  if(!tab)return;
  const label=tab.textContent.replace(/[^a-z]/gi,'').toLowerCase();
  if(label!=='feed'&&label!=='apps'&&label!=='wallet')return;
  e.preventDefault();
  e.stopPropagation();
  parent.postMessage({t:'mb-nav',tab:label},'*');
 },true);
 const report=function(){parent.postMessage({t:'mb-size',h:Math.ceil(document.body.getBoundingClientRect().height)},'*')};
 addEventListener('load',report);
 requestAnimationFrame(report);
 setTimeout(report,250);
 setTimeout(report,800);
 return;
}
// index nav
const nav=document.createElement('nav');nav.className='pn-nav';
const here=location.pathname.split('/').pop();
nav.innerHTML=(cfg.pages||[]).map(([n,f])=>`<a href="${f}${isProto?'?proto':''}" class="${f===here?'on':''}">${n}</a>`).join('')+'<i></i>'+
 `<a href="${here}" class="${isProto?'':'on'}">Overview</a><a href="${here}?proto" class="${isProto?'on':''}">Prototype</a>`;
document.body.appendChild(nav);
if(!isProto)return;
document.querySelectorAll(cfg.phone||'.phone').forEach(ph=>{ph.querySelectorAll('.nav').forEach(n=>{if(getComputedStyle(n).position==='absolute'){n.parentElement.appendChild(n);Object.assign(n.style,{position:'sticky',bottom:'0',left:'auto',right:'auto',zIndex:20})}})});
const btn=document.createElement('button');btn.className='pn-btn';btn.innerHTML='? <b>Notes</b>';document.body.appendChild(btn);
const layer=document.createElement('div');layer.className='pn-layer';document.body.appendChild(layer);
let on=false,open=-1,card=null;
const vis=el=>{if(!el)return null;const r=el.getBoundingClientRect();if(!r.width||!r.height)return null;
 // clip to scrolling phone
 let p=el.parentElement;while(p&&p!==document.body){const cs=getComputedStyle(p);if(/(auto|scroll|hidden)/.test(cs.overflowY+cs.overflowX)){const pr=p.getBoundingClientRect();if(r.bottom<pr.top+4||r.top>pr.bottom-4||r.right<pr.left+4||r.left>pr.right-4)return null}p=p.parentElement}
 if(r.bottom<0||r.top>innerHeight)return null;const c=document.elementFromPoint(Math.min(innerWidth-1,Math.max(0,r.left+Math.min(12,r.width/2))),Math.min(innerHeight-1,Math.max(0,r.top+Math.min(12,r.height/2))));if(c&&!el.contains(c)&&!c.closest('.pn-pin,.pn-card')&&!c.contains(el))return null;return r};
const find=sel=>[...document.querySelectorAll(sel)].find(e=>vis(e));
function draw(){layer.innerHTML='';if(!on)return;cfg.notes.forEach((n,i)=>{const el=find(n.sel),r=vis(el);if(!r)return;
  if(i===open){const h=document.createElement('div');h.className='pn-hl';Object.assign(h.style,{left:r.left-2+'px',top:r.top-2+'px',width:r.width+4+'px',height:r.height+4+'px'});layer.appendChild(h)}
  const p=document.createElement('div');p.className='pn-pin'+(i===open?' on':'');p.textContent=i+1;p.dataset.n=i;
  p.style.left=Math.max(10,r.left+(n.dx??10))+'px';p.style.top=Math.max(10,r.top+(n.dy??10))+'px';layer.appendChild(p)});
 if(card&&open>=0){const el=find(cfg.notes[open].sel),r=vis(el);const ph=el&&(el.closest(cfg.phone||'.phone'));const pr=ph?ph.getBoundingClientRect():r;
  if(r){let x=pr.right+16;if(x+300>innerWidth)x=Math.max(8,pr.left-316);card.style.left=x+'px';card.style.top=Math.min(Math.max(48,r.top-10),innerHeight-card.offsetHeight-12)+'px'}}}
function show(i){open=i;card&&card.remove();card=null;if(i<0){draw();return}const n=cfg.notes[i];
 card=document.createElement('div');card.className='pn-card';
 const row=(k,v)=>v?`<div class="k">${k}</div><div class="v">${esc(v)}</div>`:'';
 card.innerHTML=`<h4><span>${i+1}. ${esc(n.title)}</span><button aria-label="Close">×</button></h4>${row('Component',n.comp)}${row('Tokens',n.tokens)}${row('Behaviour',n.beh)}${row('States',n.states)}${row('Route / data',n.data)}${n.q?`<div class="q"><div class="k">Open question</div>${esc(n.q)}</div>`:''}`;
 card.querySelector('button').onclick=()=>show(-1);document.body.appendChild(card);draw()}
function set(v){on=v;btn.classList.toggle('on',on);if(!on)show(-1);draw()}
btn.onclick=()=>set(!on);
layer.addEventListener('click',e=>{const p=e.target.closest('.pn-pin');if(p){const i=+p.dataset.n;show(open===i?-1:i)}});
addEventListener('scroll',draw,true);addEventListener('resize',draw);
new MutationObserver(rs=>{if(rs.every(r=>layer.contains(r.target)||(card&&card.contains(r.target))||r.target===layer))return;clearTimeout(window.__pnT);window.__pnT=setTimeout(draw,30)}).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class','style']});
window.protoNotes={set,show,draw};
if(Q.has('notes')||Q.has('note'))setTimeout(()=>{set(true);if(Q.has('note'))show(+Q.get('note')-1)},400);
})();
