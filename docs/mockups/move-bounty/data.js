// Example data. Balances are illustrative. Apps beyond the first three are placeholders for scale.
const IMG={polymarket:1,phoenix:1,pacifica:1,meteora:1};
const COL={polymarket:'#7FA8FF',phoenix:'#FF8D2A',pacifica:'#61D7EF',solana:'#B98AFF',base:'#5B8CFF',ethereum:'#C9D2FF',robinhood:'#CCFF00'};
const APPS=[['polymarket','Polymarket',412.5,'Polygon'],['phoenix','Phoenix',350,'Solana'],['pacifica','Pacifica',200,'Solana'],['meteora','Meteora',0,'Solana'],['drift','Drift',0,'Solana'],['kamino','Kamino',0,'Solana'],['jupiter','Jupiter',0,'Solana'],['hyperliquid','Hyperliquid',0,'HyperEVM'],['marginfi','marginfi',0,'Solana'],['aave','Aave',0,'Base'],['morpho','Morpho',0,'Base'],['limitless','Limitless',0,'Base']];
const CHAINS=[['solana','Solana',4743.6],['base','Base',58.2],['ethereum','Ethereum',0],['robinhood','Robinhood Chain',0],['arbitrum','Arbitrum',0],['polygon','Polygon',0],['optimism','Optimism',0],['hyperevm','HyperEVM',0],['bnb','BNB Chain',0],['avalanche','Avalanche',0]];
const ALL=[...APPS.map(a=>({k:a[0],n:a[1],b:a[2],g:'app',ch:a[3]})),...CHAINS.map(c=>({k:c[0],n:c[1],b:c[2],g:'chain',ch:c[1]}))];
const BY=Object.fromEntries(ALL.map(x=>[x.k,x]));
const f2=n=>Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
function mk(k){const x=BY[k];const inner=IMG[k]?`<img src="assets/${k}.svg" alt="">`:(k==='solana'?'◎':x.n[0]);return `<span class="mk ${x.g==='chain'?'c':''}" style="color:${COL[k]||'var(--dim)'}" aria-hidden="true">${inner}</span>`;}
// Route: From → one chain hop → To (2–3 nodes). Polymarket exits to Solana through its own bridge.
function hop(f,t){const F=BY[f],T=BY[t];const land=F.g==='chain'?F.ch:(f==='polymarket'?'Solana':F.ch);const h=T.g==='chain'?land:T.ch;const hk=ALL.find(x=>x.g==='chain'&&x.n===h)?.k;return hk&&hk!==f&&hk!==t?hk:null;}
function route(f,t){const h=hop(f,t);return `<div class="route" aria-label="Route">${mk(f)}<i></i>${h?`${mk(h)}<i></i>`:''}${mk(t)}<span>${h?`via ${BY[h].n}`:'direct'}</span></div>`;}
const Q=new URLSearchParams(location.search);
const shell=(mid,cta,dis)=>`<div class="phone"><header class="mast"><span class="wm" role="img" aria-label="MyBoon"></span><span class="av">b</span></header><div class="zone"><div class="ah"><h1>Move <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="m6 9 6 6 6-6"/></svg></h1><small>Example data</small></div><div class="card"><div class="mid">${mid}</div><button class="cta" ${dis?'disabled':''}>${cta}</button></div></div><nav class="nav"><span>Feed</span><span>Apps</span><span class="on">Wallet</span></nav></div>`;
// Tokens each endpoint accepts (example). First is the default. Balances per token are example data.
const TOKS={solana:['USDC','SOL'],base:['USDC','ETH'],ethereum:['USDC','ETH'],robinhood:['USDC','ETH'],arbitrum:['USDC','ETH'],optimism:['USDC','ETH'],polymarket:['USDC'],phoenix:['USDC','SOL'],pacifica:['USDC']};
const toks=k=>TOKS[k]||['USDC'];
const TBAL={solana:{SOL:12.4},base:{ETH:0.04},phoenix:{SOL:2.1}};
const bal=(k,t)=>t==='USDC'?BY[k].b:((TBAL[k]||{})[t]||0);
const hasBal=k=>toks(k).some(t=>bal(k,t)>0);
const PX={USDC:1,USDT:1,SOL:180,ETH:3200};
const TCOL={USDC:'#5B9BFF',USDT:'#26C59A',SOL:'#B98AFF',ETH:'#C9D2FF'},TGL={USDC:'$',USDT:'₮',SOL:'◎',ETH:'Ξ'};
const dec=t=>PX[t]>10?4:2;
const fT=(n,t)=>Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:dec(t)});
const tk=t=>`<span class="tk" style="color:${TCOL[t]}" aria-hidden="true">${TGL[t]}</span>`;
