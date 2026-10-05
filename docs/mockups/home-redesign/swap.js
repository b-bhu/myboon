/* Bencho Asset swap visual reference: https://bencho.dev/blocks/asset-swap
   The supplied reference is MIT licensed. This offline, vanilla-JS preview
   uses MyBoon tokens and Solana fixtures; it does not connect a swap engine. */
(() => {
  const tokens = [
    {symbol:'SOL', name:'Solana', decimals:9, balance:'23.417', price:157420000n},
    {symbol:'USDC', name:'USD Coin', decimals:6, balance:'1260.50', price:1000000n},
    {symbol:'JUP', name:'Jupiter', decimals:6, balance:'600', price:880000n},
    {symbol:'BONK', name:'Bonk', decimals:5, balance:'2100000', price:26n},
    {symbol:'WIF', name:'dogwifhat', decimals:6, balance:'120', price:1730000n}
  ];
  const bySymbol = Object.fromEntries(tokens.map(token => [token.symbol,token]));
  const model = {pay:'SOL', receive:'USDC', amount:'2', turns:0, pick:null, query:'', slippage:'auto', custom:'0.5', acknowledgement:'', review:null, closing:false, lastPicked:null};
  let root = null, settleTimer;
  const scale = decimals => 10n ** BigInt(decimals);
  const dollars = value => value.toLocaleString('en-US',{style:'currency',currency:'USD'});
  function atomic(value,decimals) {
    if (!/^\d+(?:\.\d*)?$/.test(value)) throw new Error('Enter an amount using digits and one decimal point.');
    const [whole,fraction=''] = value.split('.');
    if (fraction.length > decimals) throw new Error(`This token supports at most ${decimals} decimal places.`);
    return BigInt(whole + fraction.padEnd(decimals,'0'));
  }
  function units(value,decimals,maxDigits=decimals) {
    const whole = value / scale(decimals);
    const fraction = (value % scale(decimals)).toString().padStart(decimals,'0').slice(0,maxDigits).replace(/0+$/,'');
    return whole.toString() + (fraction ? '.' + fraction : '');
  }
  function spendable(token) {
    const balance = atomic(token.balance,token.decimals);
    // Native SwapScreen keeps 5,000,000 lamports available for SOL fees.
    return token.symbol === 'SOL' ? (balance > 5000000n ? balance - 5000000n : 0n) : balance;
  }
  function slippageBps() {
    if (model.slippage !== 'custom') return 50;
    if (!/^\d+(?:\.\d{0,2})?$/.test(model.custom)) throw new Error('Enter slippage with up to two decimal places.');
    const bps = Number(atomic(model.custom,2));
    if (bps > 5000) throw new Error('Slippage must be between 0% and 50%.');
    return bps;
  }
  function quote() {
    const pay = bySymbol[model.pay], receive = bySymbol[model.receive];
    try {
      if (!model.amount) return {error:'Enter an amount to continue.'};
      const input = atomic(model.amount,pay.decimals), bps = slippageBps();
      if (input <= 0n) return {error:'Enter an amount greater than zero.'};
      if (input > atomic(pay.balance,pay.decimals)) return {error:`Insufficient ${pay.symbol} balance.`};
      if (input > spendable(pay)) return {error:'Leave 0.005 SOL for network fees.'};
      // Fixed sample prices are integer microdollars. Display fiat uses Number;
      // token conversion and minimum received use integer arithmetic.
      const output = input * pay.price * scale(receive.decimals) / (scale(pay.decimals) * receive.price);
      if (output <= 0n) return {error:'Amount too small for this sample pair.'};
      return {error:'', pay:pay.symbol, receive:receive.symbol, input, output, minimum:output * BigInt(10000-bps) / 10000n, bps, fiat:Number(input)/10**pay.decimals*Number(pay.price)/1e6};
    } catch (error) { return {error:error.message}; }
  }
  function logo(symbol) {
    const shapes = {
      SOL:'<circle cx="16" cy="16" r="16" fill="#20163E"/><path fill="#9FE8D9" d="M9 7h17l-3 4H6zm-3 7h17l3 4H9zm3 7h17l-3 4H6z"/>',
      USDC:'<circle cx="16" cy="16" r="16" fill="#2775CA"/><path d="M8 8a11 11 0 0 0 0 16M24 8a11 11 0 0 1 0 16" fill="none" stroke="#FFF" stroke-width="1.5"/><text x="16" y="23" text-anchor="middle" fill="#FFF" font-family="Arial" font-size="21">$</text>',
      JUP:'<circle cx="16" cy="16" r="16" fill="#192B21"/><circle cx="16" cy="16" r="7" fill="#C9F795"/><ellipse cx="16" cy="16" rx="13" ry="4" transform="rotate(-25 16 16)" fill="none" stroke="#92D5BC" stroke-width="2"/>',
      BONK:'<circle cx="16" cy="16" r="16" fill="#C47B21"/><text x="16" y="22" text-anchor="middle" fill="#FFF4E8" font-family="Arial" font-size="18" font-weight="700">B</text>',
      WIF:'<circle cx="16" cy="16" r="16" fill="#705347"/><text x="16" y="22" text-anchor="middle" fill="#F5EAE2" font-family="Arial" font-size="16" font-weight="700">W</text>'
    };
    return `<svg class="swap-logo" viewBox="0 0 32 32" aria-hidden="true">${shapes[symbol]}</svg>`;
  }
  function panel(side) {
    const role = side === 'pay' ? 'You pay' : 'You receive';
    return `<div class="swap-panel" data-side="${side}"><div class="swap-face" data-swap-face="${side}"><span class="swap-panel-label">${role}</span><span class="swap-balance" data-swap-balance="${side}"></span><div class="swap-amount-wrap">${side === 'pay' ? '<input class="swap-amount" id="swap-amount" inputmode="decimal" autocomplete="off" aria-label="Amount you pay" placeholder="0">' : '<output class="swap-amount swap-output" id="swap-output" aria-label="Amount you receive">0</output>'}<span class="swap-fiat" data-swap-fiat="${side}">—</span></div><button class="swap-coin" data-swap-pick="${side}"></button></div>
      <div class="swap-picker" data-swap-picker="${side}" hidden><div class="swap-picker-head"><span>${role} · Choose a token</span><button class="swap-picker-close" data-swap-close-picker aria-label="Close token picker">${icon('close')}</button></div><input class="swap-search" data-swap-search="${side}" type="search" autocomplete="off" placeholder="Search tokens" aria-label="Search tokens to ${side === 'pay' ? 'pay' : 'receive'}"><div class="swap-picker-list" data-swap-list="${side}"></div></div></div>`;
  }
  function render() {
    return `<section class="swap-preview" id="swap-preview"><div class="swap-heading"><h1 id="swap-title">Swap</h1><div class="swap-heading-actions"><span class="swap-sample">Sample quote</span><button class="swap-sheet-close" id="close-swap-sheet" aria-label="Close Swap">${icon('close')}</button></div></div><div id="swap-compose"><div class="asset-swap" id="asset-swap">
      ${panel('pay')}${panel('receive')}<button class="swap-reverse" data-swap-reverse aria-label="Reverse assets"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4v16m-4-4 4 4 4-4M17 20V4m-4 4 4-4 4 4"/></svg></button></div>
      <div id="swap-outside"><div class="swap-quick"><span class="swap-quick-label">Use balance</span><div class="swap-percentages">${[25,50,100].map(percent => `<button data-swap-percent="${percent}">${percent}%</button>`).join('')}</div></div>
      <div class="swap-quote"><div class="swap-metric"><span>Rate</span><strong id="swap-rate">—</strong></div><div class="swap-metric"><span>Minimum received</span><strong id="swap-minimum">—</strong></div><div class="swap-slippage"><span>Slippage</span><div class="swap-slippage-options">${[['auto','Auto'],['fixed','0.5%'],['custom','Custom']].map(([value,label]) => `<button data-swap-slippage="${value}" aria-pressed="${model.slippage === value}">${label}</button>`).join('')}</div></div>
      <label class="swap-custom" id="swap-custom" hidden>Slippage %<input id="swap-custom-input" inputmode="decimal" aria-label="Custom slippage percentage"></label><div class="swap-ack" id="swap-ack" hidden><p>Type CONFIRM to use slippage above 15%.</p><input id="swap-ack-input" autocomplete="off" aria-label="High slippage acknowledgement" placeholder="CONFIRM"></div></div>
      <p class="swap-error" id="swap-error" role="status"></p><button class="swap-review-button" data-swap-review>Review swap</button><p class="swap-disclosure">Illustrative prices and balances. No live quote or transaction.</p></div></div><div class="swap-review" id="swap-review" hidden></div></section>`;
  }
  function pickerRows(side) {
    const query = model.query.toLowerCase().trim();
    const filtered = tokens.filter(token => (token.symbol+' '+token.name).toLowerCase().includes(query));
    return filtered.length ? filtered.map(token => `<button class="swap-picker-row" data-swap-choose="${token.symbol}" aria-label="Choose ${token.name}"><span>${logo(token.symbol)}</span><span class="swap-picker-token"><span class="swap-picker-symbol">${token.symbol}</span><span class="swap-picker-name">${token.name}</span></span><span class="swap-picker-balance">${token.balance}<small>${dollars(Number(token.balance)*Number(token.price)/1e6)}</small></span><span class="swap-picker-check">${model[side] === token.symbol ? '✓' : ''}</span></button>`).join('') : '<p class="swap-picker-empty">No matching tokens.</p>';
  }
  function reviewMarkup(snapshot) {
    return `<h2>Review swap</h2><div class="swap-review-summary">${[['pay',snapshot.input,'You pay'],['receive',snapshot.output,'You receive']].map(([side,amount,label],index) => `${index ? '<div class="swap-review-divider"></div>' : ''}<div class="swap-review-asset">${logo(snapshot[side])}<div><small>${label}</small><strong>${units(amount,bySymbol[snapshot[side]].decimals)} ${snapshot[side]}</strong></div></div>`).join('')}</div><div class="swap-metric"><span>Minimum received</span><strong>${units(snapshot.minimum,bySymbol[snapshot.receive].decimals)} ${snapshot.receive}</strong></div><div class="swap-metric"><span>Slippage</span><strong>${snapshot.bps/100}% · sample</strong></div><p class="swap-disclosure">This is a design preview. No wallet approval or transaction will occur.</p><button class="swap-review-button" data-swap-edit>Back to swap</button>`;
  }
  function sync() {
    if (!root) return;
    const find = selector => root.querySelector(selector);
    const current = quote(), busy = Boolean(model.pick || model.closing);
    const composer = find('#asset-swap');
    composer.dataset.pick = model.pick || '';
    composer.dataset.lifted = model.pick || (model.closing ? model.lastPicked : '');
    for (const side of ['pay','receive']) {
      const token = bySymbol[model[side]], face = find(`[data-swap-face="${side}"]`), panel = find(`[data-side="${side}"]`);
      face.inert = busy; face.setAttribute('aria-hidden',String(busy));
      panel.inert = Boolean(model.pick && model.pick !== side);
      if (model.pick === side) { panel.setAttribute('role','dialog'); panel.setAttribute('aria-label',`${side === 'pay' ? 'You pay' : 'You receive'}: choose a token`); }
      else { panel.removeAttribute('role'); panel.removeAttribute('aria-label'); }
      find(`[data-swap-picker="${side}"]`).hidden = model.pick !== side;
      find(`[data-swap-list="${side}"]`).innerHTML = pickerRows(side);
      const coin = find(`[data-swap-pick="${side}"]`);
      coin.innerHTML = logo(token.symbol) + token.symbol + icon('chevron');
      coin.setAttribute('aria-label',`${token.name}. Choose another token to ${side}.`);
      find(`[data-swap-balance="${side}"]`).textContent = 'Balance: ' + token.balance;
      find(`[data-swap-fiat="${side}"]`).textContent = current.output ? '≈ ' + dollars(current.fiat) : '—';
    }
    if (document.activeElement !== find('#swap-amount')) find('#swap-amount').value = model.amount;
    const output = current.output ? units(current.output,bySymbol[model.receive].decimals) : '0';
    find('#swap-output').textContent = output; find('#swap-output').title = output;
    find('#swap-output').dataset.long = String(output.length > 9);
    const reverse = find('[data-swap-reverse]');
    reverse.hidden = busy; reverse.querySelector('svg').style.transform = `rotate(${model.turns*180}deg)`;
    find('#swap-outside').inert = busy;
    find('#swap-rate').textContent = `1 ${model.pay} ≈ ${(Number(bySymbol[model.pay].price)/Number(bySymbol[model.receive].price)).toLocaleString('en-US',{maximumSignificantDigits:6})} ${model.receive}`;
    find('#swap-minimum').textContent = current.output ? units(current.minimum,bySymbol[model.receive].decimals)+' '+model.receive : '—';
    root.querySelectorAll('[data-swap-slippage]').forEach(button => button.setAttribute('aria-pressed',String(button.dataset.swapSlippage === model.slippage)));
    find('#swap-custom').hidden = model.slippage !== 'custom';
    if (document.activeElement !== find('#swap-custom-input')) find('#swap-custom-input').value = model.custom;
    find('#swap-ack').hidden = !(current.bps > 1500);
    if (document.activeElement !== find('#swap-ack-input')) find('#swap-ack-input').value = model.acknowledgement;
    const needsAcknowledgement = current.bps > 1500 && model.acknowledgement !== 'CONFIRM';
    find('#swap-error').textContent = current.error || (needsAcknowledgement ? 'Confirm your slippage setting to continue.' : '');
    find('[data-swap-review]').disabled = Boolean(current.error || needsAcknowledgement);
    find('#swap-compose').hidden = Boolean(model.review);
    find('#swap-review').hidden = !model.review;
    if (model.review) find('#swap-review').innerHTML = reviewMarkup(model.review);
  }
  function settle() {
    clearTimeout(settleTimer); model.closing = false; sync();
    root?.querySelector(`[data-swap-pick="${model.lastPicked}"]`)?.focus({preventScroll:true});
  }
  function closePicker() {
    if (!model.pick) return false;
    model.lastPicked = model.pick; model.pick = null; model.closing = true; sync();
    // Lower the selected slab only after its shrink lands. The timer also
    // covers very fast open/close gestures that produce no transition event.
    clearTimeout(settleTimer);
    if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) settle();
    else settleTimer = setTimeout(settle,460);
    return true;
  }
  function mount() {
    const next = document.querySelector('#swap-preview');
    if (next === root) { sync(); return; }
    clearTimeout(settleTimer); model.pick = null; model.closing = false; model.review = null; root = next;
    if (!root) return;
    root.addEventListener('transitionend',event => { if (model.closing && event.propertyName === 'height' && event.target.dataset.side === model.lastPicked) settle(); });
    root.addEventListener('input',event => {
      const field = event.target;
      if (field.dataset.swapSearch) { model.query = field.value; root.querySelector(`[data-swap-list="${model.pick}"]`).innerHTML = pickerRows(model.pick); return; }
      if (field.id === 'swap-amount') model.amount = field.value.trim();
      else if (field.id === 'swap-custom-input') { model.custom = field.value; model.acknowledgement = ''; }
      else if (field.id === 'swap-ack-input') model.acknowledgement = field.value;
      else return;
      model.review = null; sync();
    });
    root.addEventListener('keydown',event => {
      if (event.key !== 'Tab' || !model.pick) return;
      const controls = [...root.querySelector(`[data-swap-picker="${model.pick}"]`).querySelectorAll('button,input')];
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    sync();
  }
  function handleClick(button) {
    const data = button.dataset;
    if (data.swapPick) {
      clearTimeout(settleTimer); model.closing = false; model.pick = data.swapPick; model.query = ''; sync();
      const search = root?.querySelector(`[data-swap-search="${model.pick}"]`);
      if (search) { search.value = ''; search.focus({preventScroll:true}); }
      return true;
    }
    if ('swapClosePicker' in data) { closePicker(); return true; }
    if (data.swapChoose) {
      if (!model.pick || !bySymbol[data.swapChoose]) return true;
      const other = model.pick === 'pay' ? 'receive' : 'pay';
      if (model[other] === data.swapChoose) model[other] = model[model.pick];
      model[model.pick] = data.swapChoose; model.amount = ''; model.review = null; closePicker(); return true;
    }
    if (!Object.keys(data).some(key => key.startsWith('swap'))) return false;
    if (model.pick || model.closing) return true;
    // THE ARROW KEEPS TURNING ONE WAY: count half-turns instead of toggling
    // 0/180. Pay stays above Receive; the assets themselves trade places.
    if ('swapReverse' in data) { [model.pay,model.receive] = [model.receive,model.pay]; model.turns++; model.amount = ''; model.review = null; sync(); return true; }
    if (data.swapPercent) { model.amount = units(spendable(bySymbol[model.pay])*BigInt(data.swapPercent)/100n,bySymbol[model.pay].decimals); model.review = null; sync(); return true; }
    if (data.swapSlippage) { model.slippage = data.swapSlippage; model.acknowledgement = ''; model.review = null; sync(); return true; }
    if ('swapReview' in data) {
      const current = quote();
      if (!current.error && !(current.bps > 1500 && model.acknowledgement !== 'CONFIRM')) { model.review = {...current}; sync(); root?.querySelector('[data-swap-edit]')?.focus({preventScroll:true}); }
      return true;
    }
    if ('swapEdit' in data) { model.review = null; sync(); root?.querySelector('#swap-amount')?.focus({preventScroll:true}); return true; }
    return false;
  }
  function back() {
    if (!root) return false;
    if (closePicker()) return true;
    if (model.review) { model.review = null; sync(); root.querySelector('#swap-amount').focus({preventScroll:true}); return true; }
    return false;
  }
  globalThis.SwapMock = {render,mount,handleClick,back,quote,model,tokens};
})();
