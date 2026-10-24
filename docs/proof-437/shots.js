const p=require('puppeteer-core');const OUT='/workspace/proof-437';
const sizes=[['1440',1440,900],['390',390,844]];
async function scrollAll(pg){await pg.evaluate(async()=>{for(let y=0;y<document.body.scrollHeight;y+=300){scrollTo(0,y);await new Promise(r=>setTimeout(r,60))}scrollTo(0,0);await new Promise(r=>setTimeout(r,1200))})}
(async()=>{const b=await p.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--hide-scrollbars']});
for(const [src,url] of [['app','http://localhost:3437/'],['mock','http://localhost:3438/index.html?static=1']]){
 for(const [n,w,h] of sizes){
  for(const mode of ['normal','reduced','nojs']){
   if(src==='mock'&&mode!=='normal')continue;
   const pg=await b.newPage();await pg.setViewport({width:w,height:h,isMobile:w<600,hasTouch:w<600});
   if(mode==='reduced')await pg.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
   if(mode==='nojs')await pg.setJavaScriptEnabled(false);
   await pg.goto(url,{waitUntil:'networkidle0'});await new Promise(r=>setTimeout(r,1500));
   const tag=`${src}-${n}${mode==='normal'?'':'-'+mode}`;
   await pg.screenshot({path:`${OUT}/${tag}-fold.png`});
   if(mode!=='nojs')await scrollAll(pg);
   await pg.screenshot({path:`${OUT}/${tag}-full.png`,fullPage:true});
   await pg.close();
  }}}
await b.close()})();
