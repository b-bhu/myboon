const p=require('puppeteer-core');const OUT='/workspace/proof-437';const res={};
(async()=>{const b=await p.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--hide-scrollbars']});
for(const [n,w,h] of [['1440',1440,900],['390',390,844]]){
 const pg=await b.newPage();await pg.setViewport({width:w,height:h,isMobile:w<600,hasTouch:w<600});
 await pg.goto('http://localhost:3437/',{waitUntil:'networkidle0'});await new Promise(r=>setTimeout(r,1500));
 const r={};
 r.ctasAboveFold=await pg.evaluate(()=>[...document.querySelectorAll('#hero a[href="#try"], #hero a[href="/downloads"]')].every(a=>{const b=a.getBoundingClientRect();return b.bottom<=innerHeight&&b.top>=0}));
 // overlap of hero cards & ctas & words lines
 r.heroOverlaps=await pg.evaluate(()=>{const els=[...document.querySelectorAll('#hero [class*=tile]'),document.querySelector('#hero [class*=ctas]')].filter(e=>e.offsetParent);const R=els.map(e=>e.getBoundingClientRect());const o=[];for(let i=0;i<R.length;i++)for(let j=i+1;j<R.length;j++){const a=R[i],c=R[j];if(a.left<c.right&&c.left<a.right&&a.top<c.bottom&&c.top<a.bottom)o.push([i,j])}return o});
 r.headingsPerSection=await pg.evaluate(()=>[...document.querySelectorAll('main > section')].map(s=>s.id+':'+s.querySelectorAll('h1,h2,h3,h4,h5,h6').length));
 r.spot=await pg.evaluate(()=>/\bspot\b/i.test(document.body.innerText));
 r.walletInHero=await pg.evaluate(()=>/wallet/i.test(document.querySelector('#hero').innerText));
 r.minFont=await pg.evaluate(()=>{let m=99,who='';const w=document.createTreeWalker(document.querySelector('main'),NodeFilter.SHOW_TEXT);while(w.nextNode()){const t=w.currentNode;if(!t.textContent.trim())continue;const e=t.parentElement;if(!e.offsetParent&&getComputedStyle(e).position!=='fixed')continue;const f=parseFloat(getComputedStyle(e).fontSize);if(f<m){m=f;who=t.textContent.trim().slice(0,30)}}return [m,who]});
 r.decorAriaHidden=await pg.evaluate(()=>[...document.querySelectorAll('[class*=echo],[class*=arcs],[class*=burst],[class*=path],svg')].every(e=>e.closest('[aria-hidden="true"]')));
 r.xLink=await pg.evaluate(()=>[...document.querySelectorAll('a[href="https://x.com/myboonapp"]')].length);
 // tooltips: none visible by default; visible on focus & hover
 r.tooltip=await pg.evaluate(async()=>{const t=[...document.querySelectorAll('[class*=gt]')].filter(e=>e.offsetParent||getComputedStyle(e).display!=='none');const op=e=>getComputedStyle(e,'::after').opacity;const before=t.map(op);t[0].scrollIntoView({block:'center'});t[0].focus();await new Promise(r=>setTimeout(r,400));const focused=op(t[0]);const fv=t[0].matches(':focus-visible');return {tiles:t.length,before,focused,fv}});
 if(w>600){const t=await pg.$$('[class*=gt]');await t[3].hover();await new Promise(r=>setTimeout(r,400));r.hoverOpacity=await t[3].evaluate(e=>getComputedStyle(e,'::after').opacity);await pg.screenshot({path:`${OUT}/app-${n}-apps-tooltip.png`});}
 else {const t=await pg.$$('[class*=gt]');await t[0].focus();await pg.keyboard.press('Tab');await pg.keyboard.down('Shift');await pg.keyboard.press('Tab');await pg.keyboard.up('Shift');await new Promise(r=>setTimeout(r,400));await pg.screenshot({path:`${OUT}/app-${n}-apps-tooltip.png`});}
 // sliders
 r.sliders=[];const knobs=await pg.$$('[role=slider]');
 for(const [i,k] of knobs.entries()){
  await k.evaluate(e=>e.scrollIntoView({block:'center'}));await new Promise(r=>setTimeout(r,900));
  const lbl=()=>k.evaluate(e=>[e.getAttribute('aria-valuenow'),e.parentElement.innerText.trim()]);
  const out={};
  await k.focus();await pg.keyboard.press('Enter');await new Promise(r=>setTimeout(r,300));out.enter=await lbl();
  if(i===0) await pg.screenshot({path:`${OUT}/app-${n}-slider-confirmed.png`});
  await new Promise(r=>setTimeout(r,2100));out.afterReset=await lbl();
  await k.focus();await pg.keyboard.press('Space');await new Promise(r=>setTimeout(r,300));out.space=await lbl();await new Promise(r=>setTimeout(r,2100));
  const bb=await k.boundingBox();const tr=await k.evaluate(e=>e.parentElement.getBoundingClientRect().width);
  await pg.mouse.move(bb.x+bb.width/2,bb.y+bb.height/2);await pg.mouse.down();await pg.mouse.move(bb.x+30,bb.y+bb.height/2,{steps:5});await pg.mouse.up();await new Promise(r=>setTimeout(r,400));out.shortDrag=await lbl();
  await pg.mouse.move(bb.x+bb.width/2,bb.y+bb.height/2);await pg.mouse.down();await pg.mouse.move(bb.x+tr,bb.y+bb.height/2,{steps:10});await pg.mouse.up();await new Promise(r=>setTimeout(r,300));out.fullDrag=await lbl();
  await new Promise(r=>setTimeout(r,2100));out.afterReset2=await lbl();r.sliders.push(out)}
 res[n]=r;await pg.close()}
// reduced motion: no animations running, all tiles opaque
{const pg=await b.newPage();await pg.setViewport({width:1440,height:900});await pg.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);await pg.goto('http://localhost:3437/',{waitUntil:'networkidle0'});await new Promise(r=>setTimeout(r,1000));
 res.reduced=await pg.evaluate(async()=>{scrollTo(0,1500);await new Promise(r=>setTimeout(r,500));return {animations:document.getAnimations().length,dots:document.querySelectorAll('circle').length,hiddenTiles:[...document.querySelectorAll('[class*=in]')].filter(e=>getComputedStyle(e).opacity!=='1').length,py:[...document.querySelectorAll('[class*=tl],[class*=gt]')].filter(e=>e.style.getPropertyValue('--py')).length}});
 await pg.close()}
// no JS
{const pg=await b.newPage();await pg.setViewport({width:1440,height:900});await pg.setJavaScriptEnabled(false);await pg.goto('http://localhost:3437/',{waitUntil:'networkidle0'});
 res.nojs=await pg.evaluate(()=>({words:[...document.querySelectorAll('h1,h2')].map(e=>e.innerText.replace(/\s+/g,' ')),tiles:document.querySelectorAll('li[tabindex]').length,hiddenCards:[...document.querySelectorAll('[class*=tl] > div')].filter(e=>getComputedStyle(e).opacity!=='1').length,line:document.querySelector('#wallet p:last-child')?.innerText}));await pg.close()}
res.layout={};for(const [n,w,h] of [['390',390,844],['1440',1440,900]])res.layout[n]=await require('./layout')(b,'http://localhost:3437/',w,h);
console.log(JSON.stringify(res,null,1));await b.close()})();
