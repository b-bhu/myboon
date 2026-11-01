/* MyBoon prototype notes. Usage: set window.PROTO_NOTES = {pages:[...], notes:[{sel,title,comp,tokens,beh,states,data,q}]} then load this file.
   Pins show only on notes whose element is visible. ?notes turns notes on at load, ?note=N also opens card N. */
(function(){
const cfg=window.PROTO_NOTES||{notes:[]},Q=new URLSearchParams(location.search),isProto=Q.has('proto');
const esc=s=>String(s==null?'':s);
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
