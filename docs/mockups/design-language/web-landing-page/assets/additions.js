(function(){
const A='assets/';
// 1 hero flow: number the three hero cards and light them in sequence
const cards=[...document.querySelectorAll('#hero [class*="__card"]')].slice(0,3);
const L=['Read','Why','Swap'];
cards.forEach((c,i)=>{if(getComputedStyle(c).position==='static')c.style.position='relative';c.classList.add('v2-flow');c.insertAdjacentHTML('beforeend',`<span class="v2-step">${i+1}</span><span class="v2-lbl">${L[i]}</span>`)});
// 2 app-in-motion strip between hero and feed
const strip=document.createElement('section');strip.className='v2-strip';
strip.innerHTML=`<div class="v2-phones"><div class="v2-rail"><b></b></div>${[['feed','Read'],['apps','Pick'],['wallet','Act']].map((p,i)=>`<div class="v2-ph"><div class="fr"><img src="${A}${p[0]}-phone.png" alt=""></div><div class="cap"><i>${i+1}</i>${p[1]}</div></div>`).join('')}</div>`;
document.getElementById('feed').before(strip);
// 3 labelled app tiles after the apps burst
const T=[['Polymarket','assets/73d440b504.svg','Predict','odds'],['Pacifica','assets/6b3522d43c.svg','Perps','perps'],['Phoenix','assets/6e4bc2b6f0.svg','Spot','spot'],['Meteora','assets/c0e855ab7c.svg','Earn','earn']];
const viz={odds:'<rect x="0" y="14" width="100%" height="12" rx="6" fill="#073B4C"/><rect x="0" y="14" width="62%" height="12" rx="6" fill="#06D6A0"/><text x="0" y="44" fill="#9CB8C2" font-family="monospace" font-size="11">YES 62%</text>',
perps:'<polyline points="0,38 30,30 60,34 90,18 120,22 150,8 180,12 210,4" fill="none" stroke="#06D6A0" stroke-width="2"/><text x="0" y="12" fill="#06D6A0" font-family="monospace" font-size="11">LONG 5×</text>',
spot:'<rect x="0" y="8" width="44%" height="28" rx="6" fill="#073B4C"/><rect x="56%" y="8" width="44%" height="28" rx="6" fill="#073B4C"/><text x="12" y="27" fill="#F5FAFC" font-family="monospace" font-size="12">SOL</text><text x="47%" y="27" fill="#06D6A0" font-family="monospace" font-size="13">→</text><text x="61%" y="27" fill="#F5FAFC" font-family="monospace" font-size="12">USDC</text>',
earn:'<rect x="0" y="30" width="12%" height="10" fill="#185A70"/><rect x="18%" y="24" width="12%" height="16" fill="#185A70"/><rect x="36%" y="18" width="12%" height="22" fill="#185A70"/><rect x="54%" y="12" width="12%" height="28" fill="#06D6A0"/><text x="72%" y="30" fill="#06D6A0" font-family="monospace" font-size="12">+APY</text>'};
const tiles=document.createElement('div');tiles.className='v2-tiles';
tiles.innerHTML=T.map(t=>`<div class="v2-tile"><div class="h"><img src="${t[1]}" alt="">${t[0]}</div><span class="k">${t[2]}</span><svg viewBox="0 0 220 46" preserveAspectRatio="none">${viz[t[3]]}</svg></div>`).join('');
document.getElementById('apps').after(tiles);
// motion: one shared 1.6s tick drives hero steps and strip
let k=0;const phs=[...strip.querySelectorAll('.v2-ph')],dot=strip.querySelector('.v2-rail b');
const tick=()=>{const i=k%3;cards.forEach((c,j)=>c.classList.toggle('v2-on',j===i));phs.forEach((p,j)=>p.classList.toggle('on',j===i));dot.style.left=`calc(${i*50}% - 6px)`;k++};
tick();setInterval(tick,1600);
})();(function(){
// 4 wallet: $50 chip slides Polymarket -> Pacifica, balances tick
const pf=[...document.querySelectorAll('[class*="__pf"]')].find(e=>e.offsetParent);
if(pf){const lis=[...pf.querySelectorAll('li')];const from=lis.find(l=>/Polymarket/.test(l.textContent)),to=lis.find(l=>/Pacifica/.test(l.textContent));
 const fb=from.querySelector('b'),tb=to.querySelector('b');fb.classList.add('v2-tick');tb.classList.add('v2-tick');
 const chip=document.createElement('span');chip.className='v2-chip';chip.textContent='$50';pf.appendChild(chip);
 const y=l=>l.offsetTop+(l.offsetHeight-24)/2;const fmt=n=>'$'+n.toLocaleString('en-US');
 const run=()=>{chip.style.transition='none';chip.style.top=y(from)+'px';chip.style.opacity='1';fb.textContent=fmt(1240);tb.textContent=fmt(1400);fb.className='v2-tick';tb.className='v2-tick';
  requestAnimationFrame(()=>requestAnimationFrame(()=>{chip.style.transition='';fb.textContent=fmt(1190);fb.classList.add('dn');chip.style.top=y(to)+'px'}));
  setTimeout(()=>{tb.textContent=fmt(1450);tb.classList.add('upc');},1200);setTimeout(()=>{chip.style.opacity='0'},2700)};
 const mob=matchMedia('(max-width:767px)').matches;
 if(!mob){run();setInterval(run,3200)}else{let t=null;new IntersectionObserver(es=>{es.forEach(e=>{if(e.isIntersecting&&!t){run();t=setInterval(run,3200)}else if(!e.isIntersecting&&t){clearInterval(t);t=null}})},{threshold:.4}).observe(pf)}}
// 5 sample story card (click to expand) + 6 timeline, as one row after Feed
const sec=document.createElement('section');sec.className='v2-story';
sec.innerHTML=`<div class="v2-sc open" role="button" tabindex="0" aria-expanded="true">
 <div class="top"><span>● Why it moved · Sample</span><i>+</i></div>
 <h4>SOL clears $180 as ETF inflows hit a weekly high</h4>
 <div class="more"><div>
  <div class="v2-chips"><span>ETF flows <b>+$312M</b></span><span>DEX volume <b>+41%</b></span><span>Short squeeze <b>$58M</b></span></div>
  <svg viewBox="0 0 500 90" preserveAspectRatio="none"><line x1="0" y1="70" x2="500" y2="70" stroke="#185A70" stroke-dasharray="3 5"/><polyline points="0,72 60,68 120,70 180,60 240,62 300,44 360,38 420,22 500,12" fill="none" stroke="#06D6A0" stroke-width="2.5"/><circle cx="500" cy="12" r="4" fill="#06D6A0"/></svg>
  <div class="act"><span>$178.40 ▲ 6.2%</span><button type="button">Swap SOL</button></div>
 </div></div></div>
 <div class="v2-tl">${[['09:12','News'],['09:13','Why it moved'],['09:14','Swapped']].map(x=>`<div class="s"><div class="t">${x[0]}</div><div class="l">${x[1]}</div></div>`).join('')}</div>`;
document.getElementById('feed').after(sec);
const sc=sec.querySelector('.v2-sc');const tog=()=>{sc.classList.toggle('open');sc.setAttribute('aria-expanded',sc.classList.contains('open'))};
sc.addEventListener('click',e=>{if(e.target.tagName!=='BUTTON')tog()});sc.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();tog()}});
const st=[...sec.querySelectorAll('.v2-tl .s')];let k=0;const tl=()=>{st.forEach((s,j)=>s.classList.toggle('on',j<=k%3));k++};tl();setInterval(tl,1600);
})();
(function(){
// mobile tabbed phone (shown <768px via CSS); no autoplay
const strip=document.querySelector('.v2-strip');if(!strip)return;
const S=[['feed','Read'],['apps','Pick'],['wallet','Act']];
const m=document.createElement('div');m.className='v2-mob';
m.innerHTML=`<div class="v2-tabs" role="tablist" aria-label="How MyBoon works">${S.map((s,i)=>`<button type="button" role="tab" id="v2t-${i}" aria-controls="v2p" aria-selected="${i===0}" tabindex="${i===0?0:-1}"><i>${i+1}</i>${s[1]}</button>`).join('')}</div>
<div class="v2-mfr" id="v2p" role="tabpanel" aria-labelledby="v2t-0">${S.map((s,i)=>`<img src="assets/${s[0]}-phone.png" alt="MyBoon ${s[0]} screen" class="${i===0?'on':''}">`).join('')}</div>`;
strip.appendChild(m);
const tabs=[...m.querySelectorAll('[role=tab]')],imgs=[...m.querySelectorAll('img')],panel=m.querySelector('#v2p');
const sel=(i,focus)=>{tabs.forEach((t,j)=>{t.setAttribute('aria-selected',j===i);t.tabIndex=j===i?0:-1});imgs.forEach((im,j)=>im.classList.toggle('on',j===i));panel.setAttribute('aria-labelledby','v2t-'+i);if(focus)tabs[i].focus()};
tabs.forEach((t,i)=>{t.addEventListener('click',()=>sel(i));t.addEventListener('keydown',e=>{const n={ArrowRight:(i+1)%3,ArrowLeft:(i+2)%3,Home:0,End:2}[e.key];if(n!==undefined){e.preventDefault();sel(n,true)}})});
window.__v2sel=sel;
})();
;(function(){const f=document.querySelector('.v2-flow');if(!f)return;let p=f.parentElement;while(p&&p.querySelectorAll('.v2-flow').length===p.parentElement.querySelectorAll('.v2-flow').length&&!/H1|SECTION/.test(p.parentElement.tagName)&&!p.parentElement.querySelector('h1'))p=p.parentElement;if(p)p.classList.add('v2-hcards')})();
;(function(){const c=document.querySelector('#hero [class*="__copy"]');if(!c||document.querySelector('.v2-tag'))return;c.insertAdjacentHTML('beforebegin','<p class="v2-tag">MyBoon tells you why the market moved, and lets you act in the same app.</p>')})();
