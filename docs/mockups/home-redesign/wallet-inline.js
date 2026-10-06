(() => {
 'use strict';
 const $ = id => document.getElementById(id);
 if (new URLSearchParams(location.search).get('embed') === '1' || self !== top) document.body.classList.add('embed');
 const paths = {
  down:'<path d="m6 9 6 6 6-6"/>', right:'<path d="m9 6 6 6-6 6"/>', close:'<path d="m6 6 12 12M18 6 6 18"/>',
  swap:'<path d="M7 4v16m-4-4 4 4 4-4M17 20V4m-4 4 4-4 4 4"/>', send:'<path d="M12 20V4m-6 6 6-6 6 6"/>', receive:'<path d="M12 4v16m-6-6 6 6 6-6"/>',
  transfer:'<path d="M4 8h16m-4-4 4 4-4 4M20 16H4m4-4-4 4 4 4"/>', forward:'<path d="M4 12h16m-6-6 6 6-6 6"/>',
  bell:'<path d="M6 16h12l-2-3V9a4 4 0 0 0-8 0v4zM10 20h4"/>', feed:'<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 8h8M8 12h8M8 16h4"/>',
  apps:'<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
  wallet:'<path d="M4 8V5h14v3M4 8h16v12H4z"/><path d="M20 12h-5v4h5"/>', sol:'<path d="M6 5h13l-3 3H3zm-3 5h13l3 3H6zm3 5h13l-3 3H3z" fill="currentColor" stroke="none"/>'
 };
 const icon = (name, extra='') => `<svg class="icon ${extra}" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.wallet}</svg>`;
 const esc = text => String(text).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
 const usd = n => Number(n).toLocaleString('en-US',{style:'currency',currency:'USD'});
 const tokens = {
  SOL:{name:'Solana',balance:'20',decimals:9,price:157420000n,change:'+2.1%'},
  USDC:{name:'USD Coin',balance:'4743.6',decimals:6,price:1000000n,change:'0.0%'},
  JUP:{name:'Jupiter',balance:'600',decimals:6,price:880000n,change:'+1.3%'}
 };
 const accountCash = {Spot:'4743.6',Phoenix:'350',Pacifica:'200'};
 const names = {swap:'Swap',send:'Send',receive:'Receive',transfer:'Transfer'};
 const descriptions = {swap:'Exchange one token for another',send:'Send tokens to a wallet address',receive:'Find your receiving address',transfer:'Move funds between your accounts'};
 const sampleAddress = '7kB4zX6P9nA3wH5sQ8mD2vR4tY7cF9eJ3uL6pN8mY9a';
 const state = {
  mode:'swap',pay:'SOL',receive:'USDC',amount:'2',slippage:'0.5',recipient:'',from:'Spot',to:'Phoenix',tab:'spot',modal:null,pickerSide:null,
  drafts:{send:{pay:'SOL',receive:'USDC',amount:'',recipient:''},receive:{pay:'SOL',receive:'USDC',amount:''},transfer:{pay:'USDC',receive:'SOL',amount:'25',from:'Spot',to:'Phoenix'}}
 };
 let modalOrigin = null, reverseTimer = null, slippageDraft = '0.5';
 const scale = decimals => 10n ** BigInt(decimals);
 function atomic(value,decimals) {
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) throw Error('Enter a decimal amount.');
  const [whole='0',fraction=''] = value.split('.');
  if (fraction.length > decimals) throw Error(`Use up to ${decimals} decimal places.`);
  return BigInt((whole || '0') + fraction.padEnd(decimals,'0'));
 }
 function units(value,decimals) { const fraction=(value%scale(decimals)).toString().padStart(decimals,'0').replace(/0+$/,''); return (value/scale(decimals)).toString()+(fraction?'.'+fraction:''); }
 function tolerance(value=state.slippage) {
  if (!/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(value)) throw Error('Use up to two decimal places.');
  const result=atomic(value,2); if(result>500n) throw Error('Choose a tolerance from 0% to 5%.'); return result;
 }
 function available() {
  if(state.mode==='transfer') return atomic(accountCash[state.from],6);
  const token=tokens[state.pay]; return atomic(token.balance,token.decimals)-(state.pay==='SOL'?5000000n:0n);
 }
 function quote() {
  try {
   if(state.mode==='receive') return {error:''};
   const token=tokens[state.pay], input=atomic(state.amount,token.decimals);
   if(input===0n) throw Error('Enter an amount greater than zero.');
   if(input>available()) throw Error(state.pay==='SOL'&&input<=atomic(token.balance,token.decimals)?'Keep 0.005 SOL available for network fees.':`Amount exceeds your available ${state.pay}.`);
   if(state.mode==='send'&&!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(state.recipient.trim())) throw Error('Enter a Solana recipient address.');
   if(state.mode==='transfer'&&state.from===state.to) throw Error('Choose a different destination account.');
   const fiat=Number(input)/10**token.decimals*Number(token.price)/1e6;
   if(state.mode!=='swap') return {input,fiat,error:''};
   const target=tokens[state.receive], output=input*token.price*scale(target.decimals)/(scale(token.decimals)*target.price);
   if(!output) throw Error('This amount is too small for the selected pair.');
   return {input,output,minimum:output*(10000n-tolerance())/10000n,fiat,error:''};
  } catch(error) { return {error:state.amount?error.message:'Enter an amount to continue.'}; }
 }
 function coin(symbol) { return `<span class="coin ${symbol.toLowerCase()}" aria-hidden="true">${symbol==='SOL'?icon('sol'):symbol==='USDC'?'$':symbol==='BTC'?'₿':'J'}</span>`; }
 function tokenControl(side, editable=true) {
  const symbol=state[side],content=coin(symbol)+`<span>${symbol}</span>`;
  return editable?`<button class="token-select" data-picker="${side}" aria-label="Choose ${side==='pay'?'pay':'receive'} token">${content}${icon('down')}</button>`:`<span class="token-select">${content}</span>`;
 }
 function amountRow(side,label) {
  const editable=side==='pay';
  return `<div class="asset-row"><div><${editable?'label for="amount"':'span'} class="field-label">${label}</${editable?'label':'span'}>${tokenControl(side,state.mode!=='transfer')}</div><div class="asset-amount">${editable?`<input id="amount" class="amount" inputmode="decimal" autocomplete="off" spellcheck="false" maxlength="24" placeholder="0" value="${esc(state.amount)}" aria-describedby="inline-error">`:'<output id="receive-amount" class="amount" for="amount" aria-label="Estimated amount received"></output>'}<div class="amount-meta"><span id="${side}-meta"></span></div></div></div>`;
 }
 function seam() { return `<div class="exchange-seam"><button class="reverse" id="reverse" aria-label="Reverse tokens; double-tap to choose wallet action" title="Tap to reverse · double-tap for actions">${icon('swap')}</button></div>`; }
 function renderComposer() {
  $('action-name').textContent=names[state.mode];
  let body='';
  if(state.mode==='swap') body=amountRow('pay','You pay')+seam()+amountRow('receive','You receive');
  if(state.mode==='send') body=amountRow('pay','Send amount')+`<label class="address-field"><span class="field-label">To · Solana address</span><input id="recipient" value="${esc(state.recipient)}" placeholder="Recipient address" spellcheck="false" autocomplete="off" aria-describedby="inline-error"></label>`;
  if(state.mode==='receive') body=`<div class="receive-block"><div class="receive-heading"><span class="field-label">Receive on Solana</span>${tokenControl('pay')}</div><p class="receive-address">7kB4zX···mY9a</p><p class="receive-caption">Example wallet address · Account 1</p></div>`;
  if(state.mode==='transfer') body=amountRow('pay','Transfer amount')+['from','to'].map(side=>`<label class="account-field">${side==='from'?'From':'To'}<select id="account-${side}">${Object.keys(accountCash).map(account=>`<option${state[side]===account?' selected':''}>${account}</option>`).join('')}</select></label>`).join('');
  $('composer').innerHTML=body+`<button class="primary" id="review-action">${state.mode==='receive'?'View receive details':`Review ${state.mode}`}${icon('forward')}</button>`;
  if(state.mode==='swap') $('quote-strip').innerHTML='<div class="quote-item"><span>Exchange rate</span><strong id="rate"></strong></div><button class="quote-item" id="slippage" aria-haspopup="dialog"><span>Slippage</span><strong id="slippage-value"></strong></button><div class="quote-item"><span>Minimum received</span><strong id="minimum"></strong></div>';
  else $('quote-strip').innerHTML=state.mode==='receive'?`<div class="quote-item"><span>Network</span><strong>Solana</strong></div><div class="quote-item"><span>Asset</span><strong>${state.pay}</strong></div><div class="quote-item"><span>Account</span><strong>Account 1</strong></div>`:'<div class="quote-item"><span>Available</span><strong id="available"></strong></div><div class="quote-item"><span>Network</span><strong>Solana</strong></div><div class="quote-item"><span>Fee reserve</span><strong>0.005 SOL</strong></div>';
  syncQuote();
 }
 function syncQuote() {
  const q=quote(),token=tokens[state.pay];
  if(state.mode!=='receive') {
   $('pay-meta').textContent=q.input?usd(q.fiat):`${units(available(),token.decimals)} available`;
   const input=$('amount'); if(document.activeElement!==input)input.value=state.amount;
   input.style.fontSize=state.amount.length>12?'22px':state.amount.length>8?'26px':'';
   const showError=Boolean(q.error&&state.amount&&!(state.mode==='send'&&!state.recipient&&q.error.includes('recipient address')));
   $('inline-error').textContent=q.error||''; $('inline-error').hidden=!showError;
   input.setAttribute('aria-invalid',String(showError&&!(q.error||'').includes('address')&&!(q.error||'').includes('destination')));
   if(state.mode==='send')$('recipient').setAttribute('aria-invalid',String(Boolean(state.recipient&&(q.error||'').includes('recipient address'))));
   $('review-action').disabled=Boolean(q.error);
  } else { $('inline-error').hidden=true; $('review-action').disabled=false; }
  if(state.mode==='swap') {
   const target=tokens[state.receive],out=q.output?units(q.output,target.decimals):'—';
   $('receive-amount').textContent=out; $('receive-amount').style.fontSize=out.length>12?'20px':out.length>8?'26px':'';
   $('receive-meta').textContent=q.output?usd(q.fiat):'Estimated';
   const rate=Number(token.price)/Number(target.price);
   $('rate').textContent=`1 ${state.pay} ≈ ${rate.toLocaleString('en-US',{maximumSignificantDigits:5})} ${state.receive}`;
   $('slippage-value').textContent=state.slippage+'% ↗';
   $('minimum').textContent=q.output?`${units(q.minimum,target.decimals)} ${state.receive}`:'—';
  } else if(state.mode!=='receive') $('available').textContent=`${units(available(),token.decimals)} ${state.pay}`;
 }
 function setMode(mode) {
  if(!names[mode])return;
  cancelReverse();
  if(mode!==state.mode) {
   state.drafts[state.mode]=Object.fromEntries(['pay','receive','amount','recipient','from','to'].map(key=>[key,state[key]]));
   Object.assign(state,state.drafts[mode]||{}); state.mode=mode;
  }
  closeModal(false); renderComposer(); $('action-select').focus({preventScroll:true});
 }
 function reverse() { if(state.mode!=='swap')return; [state.pay,state.receive]=[state.receive,state.pay]; state.amount=''; renderComposer(); $('reverse').focus({preventScroll:true}); }
 function cancelReverse() { if(reverseTimer!==null){clearTimeout(reverseTimer);reverseTimer=null;} }
 function handleReverse(event) {
  if(event.detail===0){cancelReverse();reverse();return;}
  if(reverseTimer!==null){cancelReverse();openActions();return;}
  reverseTimer=setTimeout(()=>{reverseTimer=null;reverse();},300);
 }
 function openModal(type,title,content) {
  cancelReverse(); if(!state.modal)modalOrigin=document.activeElement;
  state.modal=type; $('dialog-title').textContent=title; $('dialog-body').innerHTML=content;
  $('modal-layer').hidden=false; $('app-content').inert=true; $('dialog-body').scrollTop=0; $('dialog').focus({preventScroll:true});
 }
 function closeModal(restore=true) {
  if(!state.modal)return;
  state.modal=null; state.pickerSide=null; $('modal-layer').hidden=true; $('app-content').inert=false;
  if(restore)(modalOrigin?.isConnected?modalOrigin:$('action-select')).focus({preventScroll:true});
 }
 function openActions() {
  openModal('actions','Choose an action',Object.keys(names).map(mode=>`<button class="action-option" data-mode="${mode}" aria-pressed="${mode===state.mode}"><span class="option-icon">${icon(mode)}</span><span class="option-copy"><strong>${names[mode]}</strong><small>${descriptions[mode]}</small></span><span class="selected-mark" aria-hidden="true">${state.mode===mode?'✓':''}</span></button>`).join(''));
 }
 function openPicker(side) {
  openModal('tokens','Choose token','<input class="search" id="token-search" type="search" placeholder="Search tokens" aria-label="Search tokens" autocomplete="off"><div id="token-results"></div>');
  state.pickerSide=side; renderTokens(); $('token-search').focus({preventScroll:true});
 }
 function renderTokens() {
  const search=$('token-search').value.trim().toLowerCase();
  const filtered=Object.entries(tokens).filter(([symbol,token])=>(symbol+' '+token.name).toLowerCase().includes(search));
  $('token-results').innerHTML=filtered.length?filtered.map(([symbol,token])=>`<button class="market-row" data-token="${symbol}">${coin(symbol)}<span class="row-identity"><strong>${symbol}</strong><small>${token.name}</small></span><span class="row-numbers"><strong>${Number(token.balance).toLocaleString('en-US')}</strong><small class="quiet">${usd(Number(token.balance)*Number(token.price)/1e6)}</small></span></button>`).join(''):'<p class="empty">No matching tokens. Try SOL, USDC or JUP.</p>';
 }
 function selectToken(symbol) {
  if(!tokens[symbol]||!state.pickerSide)return;
  const side=state.pickerSide,other=side==='pay'?'receive':'pay';
  if(state[side]!==symbol){if(state[other]===symbol)state[other]=state[side];state[side]=symbol;state.amount='';}
  closeModal(false);renderComposer();document.querySelector(`[data-picker="${side}"]`)?.focus({preventScroll:true});
 }
 function openSlippage() {
  slippageDraft=state.slippage;
  openModal('slippage','Slippage tolerance',`<p class="dialog-copy">The allowed difference from this sample quote. Your minimum received updates with the tolerance.</p><div class="slip-options">${['0.1','0.5','1'].map(value=>`<button data-slip="${value}" aria-pressed="${value===slippageDraft}">${value}%</button>`).join('')}</div><label class="custom-label">Custom (%)<input id="custom-slip" inputmode="decimal" value="${esc(slippageDraft)}" aria-describedby="slip-error" maxlength="6"></label><p class="sheet-error" id="slip-error" role="status"></p><button class="sheet-primary" id="save-slip">Save tolerance</button>`);
 }
 function updateSlippageDraft(value) {
  slippageDraft=value;let error='';try{tolerance(value);}catch(e){error=e.message;}
  $('slip-error').textContent=error;$('save-slip').disabled=Boolean(error);$('custom-slip').setAttribute('aria-invalid',String(Boolean(error)));
  document.querySelectorAll('[data-slip]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.slip===value)));
 }
 const line=(label,value,classes='')=>`<div class="detail-line ${classes}"><span>${label}</span><strong>${value}</strong></div>`;
 function showReview() {
  if(state.mode==='receive') {
   openModal('receive','Receive '+state.pay,`<p class="dialog-copy">Account 1 · Solana</p>${line('Asset',state.pay)}${line('Example address',sampleAddress,'address-detail')}<p class="dialog-copy">Sample address for this design preview.</p><button class="sheet-primary" data-close>Back to Wallet</button>`);return;
  }
  const q=quote();if(q.error)return;
  let summary=`<div class="review-summary"><small>${state.mode==='swap'?'You pay':names[state.mode]+' amount'}</small><strong>${units(q.input,tokens[state.pay].decimals)} ${state.pay}</strong>`;
  if(state.mode==='swap')summary+=`<div class="review-arrow" aria-hidden="true">↓</div><small>You receive · estimated</small><strong>${units(q.output,tokens[state.receive].decimals)} ${state.receive}</strong>`;
  summary+='</div>';
  const detail=state.mode==='swap'?line('Minimum received',units(q.minimum,tokens[state.receive].decimals)+' '+state.receive)+line('Slippage',state.slippage+'%'):state.mode==='send'?line('Recipient',esc(state.recipient),'address-detail'):line('From',state.from)+line('To',state.to);
  openModal('review','Review '+state.mode,summary+detail+line('Network','Solana')+'<p class="dialog-copy">Sample review only. Prices and balances are illustrative; network and routing fees are not quoted. Nothing will be signed or submitted.</p><button class="sheet-primary" data-close>Back to '+names[state.mode]+'</button>');
 }
 function renderMarkets() {
  const selected=state.tab;
  document.querySelectorAll('[data-tab]').forEach(button=>{button.setAttribute('aria-selected',String(button.dataset.tab===selected));button.tabIndex=button.dataset.tab===selected?0:-1;});
  $('market-content').setAttribute('aria-labelledby','tab-'+selected);
  if(selected==='spot') {
   const rows=[...Object.entries(tokens),['BTC',{name:'Bitcoin',balance:'0',decimals:8,price:68720000000n,change:'+1.4%'}]];
   $('market-content').innerHTML='<div class="panel-heading"><h2>Markets</h2><p>Your spot balance<strong>$8,420.00</strong></p></div>'+rows.map(([symbol,token])=>`<button class="market-row" data-market="${symbol}">${coin(symbol)}<span class="row-identity"><strong>${token.name}</strong><small>${Number(token.balance)?Number(token.balance).toLocaleString('en-US')+' '+symbol+' held':symbol+' · No holdings'}</small></span><span class="row-numbers"><strong>${usd(Number(token.price)/1e6)}</strong><small class="${token.change.startsWith('-')?'negative':token.change==='0.0%'?'quiet':'positive'}">${token.change}</small></span>${icon('right','row-arrow')}</button>`).join('');
  } else if(selected==='perps') {
   $('market-content').innerHTML='<div class="panel-heading"><h2>Your positions</h2><p>Account equity<strong>$1,650.00</strong></p></div>'+[
    ['phoenix','SOL','SOL-PERP','Long · 3× · Phoenix','950','+12.40'],['pacifica','BTC','BTC-PERP','Short · 2× · Pacifica','700','−4.12']
   ].map(([id,symbol,name,context,equity,pnl])=>`<button class="market-row" data-position="${id}">${coin(symbol)}<span class="row-identity"><strong>${name}</strong><small>${context}</small></span><span class="row-numbers"><strong>${usd(equity)}</strong><small class="${pnl.startsWith('+')?'positive':'negative'}">${pnl} PnL</small></span>${icon('right','row-arrow')}</button>`).join('')+'<p class="panel-foot">Account equity appears above each position’s unrealized PnL.</p>';
  } else {
   $('market-content').innerHTML='<div class="panel-heading"><h2>Your pools</h2><p>Liquidity value<strong>$2,412.56</strong></p></div>'+[
    ['sol-usdc','SOL','SOL / USDC','In range','1460','8.44'],['jup-usdc','JUP','JUP / USDC','Out of range','952.56','3.18']
   ].map(([id,symbol,name,range,value,fees])=>`<button class="market-row" data-pool="${id}"><span class="pool-mark">${coin(symbol)}${coin('USDC')}</span><span class="row-identity"><strong>${name}</strong><small><span class="${range==='In range'?'positive':'negative'}"><i class="range-dot" aria-hidden="true"></i>${range}</span></small></span><span class="row-numbers"><strong>${usd(value)}</strong><small class="quiet">${usd(fees)} fees</small></span>${icon('right','row-arrow')}</button>`).join('');
  }
 }
 function marketDetails(symbol) {
  const token=tokens[symbol]||{name:'Bitcoin',price:68720000000n,balance:'0'};
  openModal('market',token.name,line('Market price',usd(Number(token.price)/1e6))+line('Your holdings',token.balance+' '+symbol)+line('Holding value',usd(Number(token.balance)*Number(token.price)/1e6))+`<p class="dialog-copy">Sample Spot market and balance details.</p>${tokens[symbol]?`<button class="sheet-primary" data-swap-market="${symbol}">Swap ${symbol}</button>`:'<button class="sheet-primary" data-close>Back to markets</button>'}`);
 }
 function positionDetails(id) {
  const phoenix=id==='phoenix',name=phoenix?'Phoenix':'Pacifica';
  openModal('position',phoenix?'SOL-PERP':'BTC-PERP',line('Account',name)+line('Direction',phoenix?'Long · 3×':'Short · 2×')+line('Account equity',phoenix?'$950.00':'$700.00')+line('Unrealized PnL',phoenix?'+$12.40':'−$4.12')+'<p class="dialog-copy">Illustrative position details. Transfer opens the compact funding form above your accounts.</p>'+`<button class="sheet-primary" data-fund="${name}">Transfer to ${name}</button>`);
 }
 function poolDetails(id) {
  const sol=id==='sol-usdc';
  openModal('pool',sol?'SOL / USDC':'JUP / USDC',line('Protocol','Meteora')+line('Liquidity value',sol?'$1,460.00':'$952.56')+line('Position status',sol?'In range':'Out of range')+line('Price range',sol?'$148 – $168':'$0.92 – $1.08')+line('Unclaimed fees',sol?'$8.44':'$3.18')+'<p class="dialog-copy">Sample liquidity position. Values and ranges are illustrative.</p><button class="sheet-primary" data-close>Back to pools</button>');
 }
 function showPortfolio() {
  openModal('portfolio','Your portfolio','<div class="review-summary"><small>Combined Solana value</small><strong>$12,482.56</strong></div>'+line('Spot','$8,420.00')+line('Phoenix','$950.00')+line('Pacifica','$700.00')+line('Meteora','$2,412.56')+'<p class="dialog-copy">Sample account values. Polygon funds are separate from this Solana total.</p>'+line('Polygon','$380.00')+'<button class="sheet-primary" data-close>Back to Wallet</button>');
 }
 $('notifications').innerHTML=icon('bell');$('action-chevron').innerHTML=icon('down');$('dialog-close').innerHTML=icon('close');
 document.querySelectorAll('[data-nav-icon]').forEach(item=>item.insertAdjacentHTML('afterbegin',icon(item.dataset.navIcon)));
 document.addEventListener('click',event=>{
  const button=event.target.closest('button');if(!button||button.disabled)return;
  const d=button.dataset;
  if(button.id==='action-select'){openActions();return;}
  if(button.id==='reverse'){handleReverse(event);return;}
  if(d.mode){setMode(d.mode);return;}
  if(d.picker){openPicker(d.picker);return;}
  if(d.token){selectToken(d.token);return;}
  if(button.id==='slippage'){openSlippage();return;}
  if(d.slip){$('custom-slip').value=d.slip;updateSlippageDraft(d.slip);return;}
  if(button.id==='save-slip'){try{tolerance(slippageDraft);state.slippage=String(Number(slippageDraft));closeModal();syncQuote();}catch{}return;}
  if(button.id==='review-action'){showReview();return;}
  if(d.tab){state.tab=d.tab;renderMarkets();return;}
  if(d.market){marketDetails(d.market);return;}
  if(d.position){positionDetails(d.position);return;}
  if(d.pool){poolDetails(d.pool);return;}
  if(d.swapMarket){setMode('swap');state.pay=d.swapMarket;if(state.pay===state.receive)state.receive=state.pay==='USDC'?'SOL':'USDC';state.amount='';renderComposer();$('wallet-scroll').scrollTop=0;$('amount').focus({preventScroll:true});return;}
  if(d.fund){setMode('transfer');state.from='Spot';state.to=d.fund;renderComposer();$('wallet-scroll').scrollTop=0;$('amount').focus({preventScroll:true});return;}
  if(button.id==='portfolio'){showPortfolio();return;}
  if(button.id==='profile'){openModal('profile','Account 1',line('Solana','7kB4zX···mY9a')+line('Polygon','0x8F2a···B21c')+'<p class="dialog-copy">Connected-account preview. Both addresses are illustrative.</p><button class="sheet-primary" id="profile-portfolio">View portfolio</button>');return;}
  if(button.id==='profile-portfolio'){showPortfolio();return;}
  if(button.id==='notifications'){openModal('notifications','Notifications','<p class="empty">You’re all caught up.</p><button class="sheet-primary" data-close>Back to Wallet</button>');return;}
  if(button.id==='wallet-nav'){$('wallet-scroll').scrollTop=0;return;}
  if(button.id==='dialog-close'||button.id==='modal-backdrop'||button.hasAttribute('data-close'))closeModal();
 });
 document.addEventListener('input',event=>{
  if(event.target.id==='amount'){state.amount=event.target.value.trim();syncQuote();}
  if(event.target.id==='recipient'){state.recipient=event.target.value.trim();syncQuote();}
  if(event.target.id==='token-search')renderTokens();
  if(event.target.id==='custom-slip')updateSlippageDraft(event.target.value.trim());
 });
 document.addEventListener('change',event=>{
  if(event.target.id==='account-from'){state.from=event.target.value;syncQuote();}
  if(event.target.id==='account-to'){state.to=event.target.value;syncQuote();}
 });
 document.addEventListener('dblclick',event=>{if(event.target.closest('#reverse'))event.preventDefault();});
 document.addEventListener('keydown',event=>{
  if(event.key==='Escape'){cancelReverse();if(state.modal){event.preventDefault();closeModal();}return;}
  const tab=event.target.closest('[data-tab]');
  if(!state.modal&&tab&&['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) {
   event.preventDefault();const values=['spot','perps','meteora'],index=values.indexOf(state.tab);
   state.tab=event.key==='Home'?'spot':event.key==='End'?'meteora':values[(index+(event.key==='ArrowRight'?1:2))%3];renderMarkets();$('tab-'+state.tab).focus();return;
  }
  if(!state.modal||event.key!=='Tab')return;
  const controls=[...$('dialog').querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),a[href]')].filter(el=>el.getClientRects().length);
  const first=controls[0],last=controls.at(-1);
  if(!first){event.preventDefault();$('dialog').focus();return;}
  if(event.shiftKey&&(document.activeElement===first||!controls.includes(document.activeElement))){event.preventDefault();last.focus();}
  else if(!event.shiftKey&&(document.activeElement===last||!controls.includes(document.activeElement))){event.preventDefault();first.focus();}
 });
 renderComposer();renderMarkets();
 // Exposes only local fixture state and actions for this design prototype.
 globalThis.WalletInline={state,tokens,quote,atomic,units,available,tolerance,setMode,reverse,handleReverse,cancelReverse,openActions,openPicker,selectToken,closeModal,showReview,renderMarkets};
})();
