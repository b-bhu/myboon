// Bounding-box layout check (UX review on #438). Gaps in px; negative = overlap. Each pair must be >= its min.
const p=require('puppeteer-core');
const vgap=(a,b)=>Math.round(b.top-a.bottom); // b below a
module.exports=async function layout(b,url,w,h){
 const pg=await b.newPage();await pg.setViewport({width:w,height:h,isMobile:w<600,hasTouch:w<600});
 await pg.goto(url,{waitUntil:'networkidle0'});
 const out={};
 for(const sec of ['hero','feed','apps','wallet']){
  await pg.evaluate(s=>document.getElementById(s).scrollIntoView({block:'start'}),sec);await new Promise(r=>setTimeout(r,1400));
  const R=await pg.evaluate(()=>{const g=e=>{if(!e)return null;const r=e.getBoundingClientRect();return {top:r.top+scrollY,bottom:r.bottom+scrollY,left:r.left,right:r.right}};const vis=[...document.querySelectorAll('[class*=tl],[class*=tile]')].filter(e=>e.offsetParent);
   const inSec=id=>vis.filter(e=>e.closest('section').id===id).map(e=>g(e.firstElementChild||e));
   return {hero:g(document.getElementById('hero')),ctas:g(document.querySelector('#hero [class*=ctas]')),heroCards:inSec('hero'),feedCards:inSec('feed'),walletCards:inSec('wallet'),
    walletWord:g(document.querySelector('#wallet h2 [class*=main]')),walletLine:g(document.querySelector('#wallet p:last-child')),
    pac:g(document.querySelector('#apps [data-node]')),apps:g(document.getElementById('apps')),vw:innerWidth}});
  Object.assign(out,{[sec]:R});
 }
 await pg.close();
 const o=out, res={};
 const hc=o.hero.heroCards, fc=o.feed.feedCards, wc=o.wallet.walletCards;
 res.heroSwapToCtas=vgap(hc[hc.length-1],o.hero.ctas);
 res.feedStoryBelowHero=Math.round(fc[0].top-o.feed.hero.bottom);
 res.walletPortfolioAboveWord=vgap(wc[0],o.wallet.walletWord);
 res.walletWordAboveMove=vgap(o.wallet.walletWord,wc[1]);
 res.walletMoveAboveLine=vgap(wc[1],o.wallet.walletLine);
 const pac=o.apps.pac,ap=o.apps.apps;
 res.pacificaInside={left:Math.round(pac.left),right:Math.round(o.apps.vw-pac.right),bottom:Math.round(ap.bottom-pac.bottom),xPct:Math.round(((pac.left+pac.right)/2)/o.apps.vw*100),yPct:Math.round(((pac.top+pac.bottom)/2-ap.top)/(ap.bottom-ap.top)*100)};
 const min={heroSwapToCtas:w<600?16:0,feedStoryBelowHero:24,walletPortfolioAboveWord:w<600?0:null,walletWordAboveMove:w<600?0:null,walletMoveAboveLine:24};
 res.fail=Object.entries(min).filter(([k,v])=>v!==null&&res[k]<v).map(([k])=>k).concat(Object.values(res.pacificaInside).slice(0,3).some(v=>v<0)?['pacificaInside']:[]);
 return res}
