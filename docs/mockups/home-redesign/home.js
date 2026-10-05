const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const paths = {
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
  person: '<circle cx="12" cy="8" r="3.5"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/>',
  feed: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  apps: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
  wallet: '<path d="M4 7V5h14v2M4 7h16v13H4zM20 11h-6v5h6M17 13.5h.1"/>',
  right: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  back: '<path d="M20 12H4m6-6-6 6 6 6"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  up: '<path d="M12 20V4m-6 6 6-6 6 6"/>',
  refresh: '<path d="M19 8a8 8 0 1 0 1 7M19 3v5h-5"/>',
  down: '<path d="M12 4v16m-6-6 6 6 6-6"/>',
  transfer: '<path d="M4 8h16m-4-4 4 4-4 4M20 16H4m4-4-4 4 4 4"/>',
  swap: '<path d="M18 6a8 8 0 0 0-13 6M18 2v4h-4M6 18a8 8 0 0 0 13-6M6 22v-4h4"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="1"/><path d="M16 8V4H4v12h4"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>'
};
const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>`;
const previewParameters = new URLSearchParams(location.search);
const walletPresets = {
  guest: {chains: [], session: null, sourceMode: 'resolved'},
  solana: {chains: ['solana'], session: 'external', sourceMode: 'resolved'},
  evm: {chains: ['evm'], session: 'privy', sourceMode: 'resolved'},
  both: {chains: ['solana','evm'], session: 'privy', sourceMode: 'resolved'},
  loading: {chains: ['solana'], session: 'external', sourceMode: 'loading'},
  stale: {chains: ['solana'], session: 'external', sourceMode: 'stale'},
  failed: {chains: ['solana'], session: 'external', sourceMode: 'failed'}
};
const initialWalletPreset = Object.hasOwn(walletPresets, previewParameters.get('wallet')) ? previewParameters.get('wallet') : 'both';
const initialNav = ['feed','apps','wallet'].includes(previewParameters.get('nav')) ? previewParameters.get('nav') : 'wallet';
const trails = {feed: [], apps: [], wallet: []};
const state = {
  nav: initialNav, trail: trails[initialNav], scroll: {feed: 0, apps: 0, wallet: 0},
  walletChains: [...walletPresets[initialWalletPreset].chains], walletSession: walletPresets[initialWalletPreset].session,
  walletSourceMode: walletPresets[initialWalletPreset].sourceMode, walletRepaired: [], walletFreshness: 'as of 2 min ago',
  swapOpen: false,
  coin: 'BTC', range: '24h', pending: [], applied: false, storyIndex: 0,
  calendarMode: 'week', calendarDate: '2026-10-07', savedEvents: []
};
let toastTimer;
let swapSheetOrigin;
if (new URLSearchParams(location.search).get('embed') === '1' || self !== top) document.body.classList.add('embed');
$('#notifications').innerHTML = icon('bell');
$('#profile').innerHTML = icon('person');
$('#wallet-preview').value = initialWalletPreset;
$$('[data-nav]').forEach(button => button.innerHTML = icon(button.dataset.nav) + {feed: 'Feed', apps: 'Apps', wallet: 'Wallet'}[button.dataset.nav]);

// Offline design fixtures. Token choices illustrate a small initial set, not provider support.
const coins = {
  BTC: {name: 'Bitcoin', price: '$68,720', change: '+1.4%', volume: '$18.4b', axis: ['70k','69k','68k'], cluster: '$68.5k–69k'},
  SOL: {name: 'Solana', price: '$157.42', change: '+2.1%', volume: '$2.8b', axis: ['162','158','154'], cluster: '$156–158'}
};
const appData = [
  ['polymarket','Polymarket','Prediction markets'], ['pacifica','Pacifica','Perpetual trading'],
  ['phoenix','Phoenix','Perpetual trading'], ['meteora','Meteora','Liquidity pools']
];
// Wallet fixtures reproduce the existing native overview, not live accounts.
const walletAccountData = [
  {id: 'spot', name: 'Spot', value: 8420, route: '/spot'},
  {id: 'meteora', name: 'Meteora', value: 2412.56, route: '/markets/meteora/profile'},
  {id: 'phoenix', name: 'Phoenix', value: 950, route: '/markets/phoenix/profile'},
  {id: 'pacifica', name: 'Pacifica', value: 700, route: '/markets/pacifica/profile'}
];
const walletChainData = {
  solana: {name: 'Solana', address: '7kB4zX···mY9a'},
  evm: {name: 'Polygon', address: '0x8F2a···B21c'}
};
const walletUsd = value => value.toLocaleString('en-US', {style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2});
function walletSources() {
  return walletAccountData.map(account => {
    const status = state.walletRepaired.includes(account.id) ? 'resolved' : state.walletSourceMode === 'loading' ? 'loading' : account.id === 'pacifica' ? state.walletSourceMode : 'resolved';
    return {...account, status, valueUsd: status === 'loading' || status === 'failed' ? null : account.value};
  });
}
function walletTotal(sources) {
  const known = sources.filter(source => source.valueUsd !== null);
  return known.length ? known.reduce((total, source) => total + source.valueUsd, 0) : null;
}
function setWalletPreset(preset) {
  const preview = walletPresets[preset];
  if (!preview) return;
  state.walletChains = [...preview.chains];
  state.walletSession = preview.session;
  state.walletSourceMode = preview.sourceMode;
  state.walletRepaired = [];
  state.walletFreshness = 'as of 2 min ago';
  state.scroll.wallet = 0;
  trails.wallet.length = 0;
  $('#wallet-preview').value = preset;
}
const reports = {
  flows: {title: 'Bitcoin ETFs return to net inflows', source: 'ETF flow desk', time: '3 Oct · 09:42 UTC', summary: '$214m net inflow · Latest session', body: 'The session dated 2 October recorded $214m of net inflows. The previous session, dated 1 October, recorded $85m of net outflows. These are reported session values; one positive session does not establish a longer trend.', story: 'bitcoin', image: 'feed-editorial-macro-lead.png', imageAlt: 'Illustrative market desk with price charts'},
  world: {title: 'Negotiators return to talks', source: 'World desk', time: '3 Oct · 09:34 UTC', summary: 'Meetings resume; agreement terms remain unsettled.', body: 'Negotiators have resumed meetings. The report describes renewed discussion, without a concluded agreement. The terms of further participation remain unsettled.', story: 'iran', image: 'feed-editorial-us-iran.png', imageAlt: 'Illustrative cargo ships along a coastal route'},
  shipping: {title: 'Shipping conditions remain unchanged', source: 'Maritime briefing', time: '2 Oct · 15:10 UTC', summary: 'Operators continue to review routes.', body: 'Shipping operators continue to review routes. No removal of the current restrictions has been confirmed. Route decisions and diplomatic talks remain separate observations.', story: 'iran'},
  previous: {title: 'Bitcoin ETFs record a second withdrawal session', source: 'ETF flow desk', time: '2 Oct · 09:20 UTC', summary: '$85m net outflow · Session dated 1 Oct', body: 'The session dated 1 October recorded $85m of net outflows. This earlier report is retained so the subsequent change can be understood in its original sequence.', story: 'bitcoin', image: 'feed-editorial-macro-lead.png', imageAlt: 'Illustrative market desk with price charts'},
  shippingUpdate: {title: 'Latest briefing confirms shipping restrictions remain', source: 'Maritime briefing', time: '3 Oct · 09:48 UTC', summary: 'A new briefing confirms the current conditions.', body: 'The new briefing confirms that current shipping restrictions remain in place. Negotiations continue, and no concluded agreement has been reported.', story: 'iran', image: 'feed-editorial-us-iran.png', imageAlt: 'Illustrative cargo ships along a coastal route'}
};
const transactions = {
  coast: {name: 'Coast', action: 'Bought', quantity: '25,000', token: 'PUMP', time: '3 Oct · 09:37 UTC', wallet: '9Gc3…H1qB', initial: 'C'},
  north: {name: 'North', action: 'Sold', quantity: '12', token: 'SOL', time: '3 Oct · 08:12 UTC', wallet: '6Nr2…D4pC', initial: 'N'},
  northBuy: {name: 'North', action: 'Bought', quantity: '2', token: 'SOL', time: '3 Oct · 09:47 UTC', wallet: '6Nr2…D4pC', initial: 'N'}
};
// Scheduled-event fixtures are illustrative dates, not a live economic calendar.
const calendarEvents = [
  {id: 'cpi', date: '2026-10-07', time: '14:30', title: 'US CPI', context: 'Inflation · USD', category: 'Economic release', source: 'Economic calendar', description: 'Tracks changes in prices paid by US consumers, including housing, food and energy.'},
  {id: 'earnings', date: '2026-10-08', time: '20:00', title: 'NVIDIA earnings', context: 'Quarterly results · NVDA', category: 'Company earnings', source: 'Company reporting schedule', description: 'Quarterly revenue, profit and company guidance. The report and earnings call provide context for the results.'},
  {id: 'ppi', date: '2026-10-09', time: '14:30', title: 'US PPI', context: 'Producer prices · USD', category: 'Economic release', source: 'Economic calendar', description: 'Tracks changes in prices received by US producers for their goods and services.'},
  {id: 'unlock', date: '2026-10-10', time: '12:00', title: 'JUP token unlock', context: 'Supply schedule · JUP', category: 'Token unlock', source: 'Token release schedule', description: 'A scheduled release of JUP tokens. The original schedule explains the amount and allocation.'}
];
const calendarDate = value => new Date(value + 'T12:00:00Z');
const calendarFormat = (value, options) => calendarDate(value).toLocaleDateString('en-GB', {...options, timeZone: 'UTC'});
function shiftDate(value, days) {
  const date = calendarDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
function calendarPeriod() {
  const start = state.calendarMode === 'day' ? state.calendarDate : shiftDate(state.calendarDate, -((calendarDate(state.calendarDate).getUTCDay() + 6) % 7));
  const end = state.calendarMode === 'day' ? start : shiftDate(start, 6);
  return {start, end, events: calendarEvents.filter(event => event.date >= start && event.date <= end)};
}
function calendarEventRow(event, showDate = true) {
  return `<button class="calendar-event" data-open="calendar:${event.id}" aria-label="${event.title}, ${calendarFormat(event.date, {weekday: 'long', day: 'numeric', month: 'long'})}, ${event.time} UTC. ${event.context}"><span class="calendar-event-time">${showDate ? calendarFormat(event.date, {weekday: 'short', day: '2-digit'}) + ' · ' : ''}${event.time}</span><span class="calendar-event-title">${event.title}</span><span class="calendar-event-context">${event.context}</span></button>`;
}
function heatmap(coin = state.coin, large = false) {
  const w = large ? 340 : 332, h = large ? 230 : 76;
  const left = 38, right = 12, top = large ? 18 : 8, bottom = large ? 28 : 16;
  const cols = 21, rows = large ? 18 : 7, cw = (w-left-right)/cols, ch = (h-top-bottom)/rows;
  const period = large ? state.range : '24h';
  let cells = '';
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const seed = (x*9+y*17+(period === '7d' ? 11 : period === '48h' ? 5 : 1)+(coin === 'SOL' ? 7 : 0))%23;
    const active = (y === Math.floor(rows*.57) && x > 6) || (y === Math.floor(rows*.3) && x > 12);
    const fill = active ? (seed > 8 ? 'var(--bone)' : 'var(--data)') : (seed > 18 ? 'var(--data)' : seed > 10 ? 'var(--lift)' : 'var(--ground)');
    cells += `<rect x="${left+x*cw}" y="${top+y*ch}" width="${cw-.6}" height="${ch-.6}" fill="${fill}" opacity="${active ? .85 : .75}"/>`;
  }
  const labels = coins[coin].axis;
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Illustrative ${coin} liquidation exposure by price and time">
    <rect width="${w}" height="${h}" fill="var(--core)"/>${cells}
    <g fill="var(--dim)" font-family="monospace" font-size="${large ? 10 : 9}">
      <text x="4" y="${top+8}">${labels[0]}</text><text x="4" y="${top+(h-top-bottom)*.5+3}">${labels[1]}</text><text x="4" y="${h-bottom}">${labels[2]}</text>
      <text x="${left}" y="${h-4}">${period} ago</text><text x="${w-32}" y="${h-4}">Now</text>
    </g>
    <path d="M${left} ${top+(h-top-bottom)*.65}L${w-right} ${top+(h-top-bottom)*.53}" stroke="var(--bone)" stroke-width="1" stroke-dasharray="3 3"/>
    <circle cx="${w-right}" cy="${top+(h-top-bottom)*.53}" r="2" fill="var(--bone)"/>
  </svg>`;
}
function link(id, title, desc, asset = '') {
  return `<button class="rowlink" data-open="${id}" ${asset ? `data-asset="${asset}"` : ''}><div><b>${title}</b><small>${desc}</small></div>${icon('right')}</button>`;
}
function storiesCarousel() {
  const stories = [
    {id: 'iran', name: 'US–Iran', development: 'Talks resume. Shipping restrictions remain; no agreement reported.', count: state.applied ? 4 : 3, fresh: state.applied ? 'Just updated' : '3 Oct'},
    {id: 'bitcoin', name: 'Bitcoin', development: '$214m net inflows after two withdrawal sessions.', count: 2, fresh: '3 Oct'}
  ];
  return `<section class="stories" aria-labelledby="stories-heading"><div class="stories-heading"><h2 id="stories-heading">DEVELOPING STORIES</h2><span>${stories.length} stories</span></div><div class="story-rail" id="story-rail" role="group" aria-label="Developing stories; swipe or use left and right arrow keys">
    ${stories.map((story, index) => `<button class="tile story" data-open="${story.id}" data-story-index="${index}" aria-label="${story.name}, story ${index+1} of ${stories.length}. Full story">
      <div class="story-title"><h2>${story.name}</h2><time>${story.fresh}</time></div>
      <div class="story-development"><span class="story-timeline" aria-hidden="true">${'<i></i>'.repeat(Math.min(3, story.count))}</span><p>${story.development}</p></div>
      <span class="story-footer">Full story ${icon('right')}</span>
    </button>`).join('')}
    </div></section>`;
}
function rememberStories() {
  const rail = $('#story-rail');
  if (!rail) return;
  const cards = [...rail.querySelectorAll('[data-story-index]')];
  state.storyIndex = cards.reduce((closest, card, index) => Math.abs(card.offsetLeft - rail.scrollLeft) < Math.abs(cards[closest].offsetLeft - rail.scrollLeft) ? index : closest, 0);
}
function bindStories() {
  const rail = $('#story-rail');
  if (!rail) return;
  const cards = [...rail.querySelectorAll('[data-story-index]')];
  const select = (index, focus = false) => {
    state.storyIndex = Math.max(0, Math.min(index, cards.length - 1));
    rail.scrollLeft = cards[state.storyIndex].offsetLeft;
    if (focus) cards[state.storyIndex].focus({preventScroll: true});
  };
  select(state.storyIndex);
  rail.addEventListener('scroll', () => { if (rail.isConnected) rememberStories(); }, {passive: true});
  rail.addEventListener('focusin', event => {
    const card = event.target.closest('[data-story-index]');
    if (card) select(Number(card.dataset.storyIndex));
  });
  rail.addEventListener('keydown', event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const card = event.target.closest('[data-story-index]');
    select(Number(card?.dataset.storyIndex ?? state.storyIndex) + (event.key === 'ArrowRight' ? 1 : -1), true);
  });
}
function updateCard(id, freshness, lead = false) {
  const report = reports[id];
  const image = report.image ? `<img class="${lead ? 'update-image' : 'update-thumbnail'}" src="assets/${report.image}" alt="${report.imageAlt}">` : '';
  const copy = `<div class="update-copy"><div class="meta"><time>${freshness}</time></div><h2>${report.title}</h2><p>${report.summary}</p><div class="tile-foot"><span>${report.source}</span><span class="action">Read ${icon('right')}</span></div></div>`;
  return `<button class="tile wide update${lead ? ' lead-update' : ''}" data-open="report:${id}">${lead ? image + copy : copy + image}</button>`;
}
function latestPreview() {
  return `<section class="latest-preview" aria-labelledby="latest-heading"><div class="latest-heading"><h2 id="latest-heading">Latest updates</h2><button data-open="latest">All updates ${icon('right')}</button></div>${updateCard(state.applied ? 'shippingUpdate' : 'flows', state.applied ? 'Just updated' : '3m ago', true)}</section>`;
}
function calendarCard() {
  const {start, end, events} = calendarPeriod();
  const week = state.calendarMode === 'week';
  const number = week ? `${start.slice(8)}–${end.slice(8)}` : start.slice(8);
  const month = start.slice(0, 7) === end.slice(0, 7) ? calendarFormat(start, {month: 'short', year: 'numeric'}) : `${calendarFormat(start, {month: 'short', ...(start.slice(0, 4) !== end.slice(0, 4) ? {year: 'numeric'} : {})})} / ${calendarFormat(end, {month: 'short', year: 'numeric'})}`;
  return `<section class="home-module wide calendar-module" aria-labelledby="calendar-heading"><div class="module-heading calendar-heading"><h2 id="calendar-heading">Calendar</h2><button data-open="calendar">All events ${icon('right')}</button></div><div class="calendar-card">
    <div class="calendar-period"><div class="calendar-modes" role="group" aria-label="Calendar view">${['day','week'].map(mode => `<button data-calendar-mode="${mode}" aria-pressed="${state.calendarMode === mode}">${mode === 'day' ? 'Day' : 'Week'}</button>`).join('')}</div><div class="calendar-date"><span class="calendar-date-label">${week ? 'Mon – Sun' : calendarFormat(start, {weekday: 'long'})}</span><strong class="${week ? 'week-number' : 'day-number'}">${number}</strong><span class="calendar-month">${month}</span></div><div class="calendar-period-bottom"><span>${events.length} scheduled</span><div class="calendar-step"><button data-calendar-step="-1" aria-label="Previous ${state.calendarMode}">${icon('back')}</button><button data-calendar-step="1" aria-label="Next ${state.calendarMode}">${icon('right')}</button></div></div></div>
    <div class="calendar-agenda"><div class="calendar-agenda-heading"><span>Scheduled events</span><span>UTC</span></div><div class="calendar-events" aria-live="polite">${events.length ? events.map(event => calendarEventRow(event, week)).join('') : '<div class="calendar-empty"><p>No scheduled events.</p><small>Choose another day or week.</small></div>'}</div></div>
    </div></section>`;
}
function activityCard(id = 'coast') {
  const tx = transactions[id];
  return `<button class="tile activity" data-direction="${tx.action === 'Bought' ? 'buy' : 'sell'}" data-open="activity:${id}"><div class="activity-summary"><div><div class="wallet-person"><span class="avatar">${tx.initial}</span>${tx.name}</div><h2>${tx.action} ${tx.token}</h2></div><div class="amount">${tx.quantity} <span>${tx.token}</span></div></div><div class="activity-footer"><span class="activity-source">Onchain index · ${id === 'northBuy' ? 'Just updated' : '8m ago'}</span><span>View activity ${icon('right')}</span></div></button>`;
}
function statsCard(coin = 'BTC') {
  const data = coins[coin];
  return `<button class="tile wide stats" data-open="stats" data-asset="${coin}"><div class="meta"><span>Token dataset · ${state.applied ? '8m' : '5m'}</span></div><div class="token-head"><h2>${data.name} <span style="font-size:11px;font-weight:500">${coin}</span></h2><div class="token-price">${data.price}<small>${data.change} · 24h</small></div></div><div class="chart-label">Liquidation exposure · Modeled · 24h</div><div class="plot">${heatmap(coin)}</div><div class="tile-foot"><span>Estimated exposure · Not a forecast</span><span class="action">View stats ${icon('right')}</span></div></button>`;
}
function homeModule(id, title, card, compact = false) {
  return `<section class="home-module ${compact ? 'compact' : 'wide'}" aria-labelledby="${id}-heading"><div class="module-heading"><h2 id="${id}-heading">${title}</h2></div>${card}</section>`;
}
function feed() {
  return `<section class="feed"><div class="feed-head"><h1>What’s happening</h1><time>09:${state.applied ? '48' : '45'} UTC</time></div><div class="canvas">
    ${storiesCarousel()}${latestPreview()}${calendarCard()}${homeModule('activity','Smart wallet activity',activityCard(state.applied ? 'northBuy' : 'coast'))}${homeModule('stats','Token stats',statsCard())}
    </div></section>`;
}
function apps() {
  return `<section class="detail apps-screen"><h1>Apps</h1><p class="lead">Choose where to trade or provide liquidity.</p><div class="apps-heading"><h2>Available apps</h2><span>${appData.length} apps</span></div><div class="apps-grid">${appData.map(([id,name,desc]) => `<button class="app-launcher" data-open="app:${id}" aria-label="Open ${name}, ${desc}"><img src="assets/${id}.svg" alt=""><div class="app-launcher-copy"><h2>${name}</h2><p>${desc}</p></div><span class="app-launcher-action">Open app ${icon('right')}</span></button>`).join('')}</div></section>`;
}
function wallet() {
  if (!state.walletChains.length) return `<section class="wallet-screen" aria-label="Wallet"><div class="wallet-wrap"><div class="wallet-disconnected">${icon('wallet')}<h2>Connect a wallet</h2><p>Connect a Solana wallet to see your combined balance across Spot, Meteora, Phoenix, and Pacifica.</p><button class="wallet-connect" data-open="connection">Connect wallet</button></div></div></section>`;
  const sources = walletSources(), total = walletTotal(sources);
  const hasSolana = state.walletChains.includes('solana');
  return `<section class="wallet-screen" aria-label="Wallet"><div class="wallet-wrap">
    ${hasSolana ? walletHero(sources,total) + walletActions() : ''}
    <div class="wallet-list" aria-label="Connected chains">${state.walletChains.map(chain => walletChain(chain,total)).join('')}</div>
    ${hasSolana ? `<div class="wallet-list" aria-label="Solana protocol accounts">${sources.map(walletAccount).join('')}</div>` : ''}
  </div></section>`;
}
function walletHero(sources,total) {
  return `<div class="wallet-hero" aria-label="Combined Solana value"><div class="wallet-total-top"><span class="wallet-asof" id="freshness">${total !== null ? state.walletFreshness : ''}</span><button class="wallet-refresh" id="refresh" aria-label="Refresh wallet balances">${icon('refresh')}</button></div>
    ${total !== null ? `<strong class="wallet-total">${walletUsd(total)}</strong>` : '<span class="wallet-skeleton wallet-total-skeleton" role="status" aria-label="Wallet total loading"></span>'}
    <div class="wallet-allocation" aria-label="Solana protocol allocation">${total !== null && total > 0 ? sources.filter(source => source.valueUsd !== null).map(source => `<i style="flex-grow:${source.valueUsd / total};--protocol-color:var(--${source.id})" aria-label="${source.name} ${walletUsd(source.valueUsd)}"></i>`).join('') : '<i class="wallet-mix-pending"></i>'}</div></div>`;
}
function walletActions() {
  return `<div class="wallet-actions" aria-label="Wallet actions">${[['swap','Swap','swap'],['send','Send','up'],['receive','Receive','down'],['transfer','Transfer','transfer']].map(([id,label,glyph]) => `<button class="wallet-action" data-wallet-action="${id}" ${id === 'swap' ? 'data-app-route="/swap"' : ''} aria-label="${label}" title="${id === 'swap' ? 'Open Swap' : 'Coming soon'}">${icon(glyph)}<span>${label}</span></button>`).join('')}</div>`;
}
function walletChain(chain,total) {
  const data = walletChainData[chain], value = chain === 'solana' ? total : 380;
  const solanaMark = '<svg class="wallet-solana-mark" viewBox="0 0 26 23" aria-hidden="true"><path d="m25.033 17.458-4.087 4.382a.95.95 0 0 1-.692.302H.879a.476.476 0 0 1-.348-.798l4.082-4.382a.95.95 0 0 1 .692-.302H24.68a.473.473 0 0 1 .353.798m-4.087-8.827a.96.96 0 0 0-.692-.302H.879a.475.475 0 0 0-.348.798l4.082 4.385a.96.96 0 0 0 .692.302H24.68a.476.476 0 0 0 .346-.798zM.879 5.483h19.375a.95.95 0 0 0 .692-.302L25.033.798a.475.475 0 0 0-.09-.724A.47.47 0 0 0 24.68 0H5.305a.95.95 0 0 0-.692.302L.531 4.685a.475.475 0 0 0 .348.798"/></svg>';
  return `<div class="wallet-chain" data-chain="${chain}"><div class="wallet-chain-main"><b class="wallet-chain-name">${chain === 'solana' ? solanaMark : ''}${data.name}</b><button class="wallet-address" data-copy-chain="${chain}" aria-label="Copy ${data.name} address">${data.address}${icon('copy')}</button></div><div class="wallet-chain-trailing"><span class="${value === null ? 'wallet-chain-unknown' : 'wallet-chain-value'}">${value === null ? '—' : walletUsd(value)}</span><button class="wallet-disconnect" data-open="connection" aria-label="Disconnect ${data.name}">Disconnect</button></div></div>`;
}
function walletAccount(source) {
  const known = source.valueUsd !== null;
  const signal = source.status === 'stale' ? `<span class="wallet-source-stale">stale · ${state.walletFreshness}</span>` : `<span class="wallet-sync-dot" data-failed="${source.status === 'failed'}"></span><span>${source.status === 'failed' ? "couldn't sync" : 'syncing'}</span>`;
  return `<div class="wallet-account ${known ? '' : 'wallet-account-pending'}" data-protocol="${source.id}"><button class="wallet-account-summary" data-wallet-account="${source.id}" data-app-route="${source.route}" aria-label="Open ${source.name}"><span class="wallet-account-head"><b class="wallet-account-name">${source.name}${icon('chevron')}</b>${known ? `<span class="wallet-account-value">${walletUsd(source.valueUsd)}</span>` : '<span class="wallet-skeleton" aria-label="Balance not yet synced"></span>'}</span>${known ? walletAccountSignal(source.id) : ''}</button>
    ${source.status !== 'resolved' ? `<div class="wallet-source-signal">${signal}${source.status === 'loading' ? '' : `<button class="wallet-retry" data-wallet-retry="${source.id}" aria-label="Retry syncing ${source.name} balance">Retry</button>`}</div>` : ''}</div>`;
}
function walletAccountSignal(id) {
  if (id === 'spot') return '<span class="wallet-token-stack" aria-label="SOL, USDC, JUP and 2 more holdings"><span class="wallet-token-chip" style="--chip-color:var(--spot)" title="SOL">S</span><span class="wallet-token-chip" style="--chip-color:var(--pacifica)" title="USDC">U</span><span class="wallet-token-chip" style="--chip-color:var(--meteora)" title="JUP">J</span><span class="wallet-token-chip wallet-token-overflow">+2</span></span>';
  if (id === 'meteora') return '<span class="wallet-pills"><span class="wallet-pill" data-status="positive" aria-label="SOL / USDC, in range"><i class="wallet-pill-ring"></i>SOL / USDC</span><span class="wallet-pill" data-status="negative" aria-label="JUP / SOL, out of range"><i class="wallet-pill-ring"></i>JUP / SOL</span></span><small class="wallet-fees">$24.18 fees</small>';
  const positions = id === 'phoenix' ? [['BTC','positive']] : [['SOL','positive'],['ETH','negative']];
  return `<span class="wallet-pills">${positions.map(([symbol,status]) => `<span class="wallet-pill" data-status="${status}" aria-label="${symbol}, ${status === 'positive' ? 'positive' : 'negative'} unrealized PnL">${symbol}<span class="wallet-pill-direction">${status === 'positive' ? '↑' : '↓'}</span></span>`).join('')}</span>`;
}
function walletConnectionDetail() {
  if (state.walletChains.length) return `<h1>${state.walletChains.length > 1 ? 'Wallets' : 'Wallet'}</h1>${state.walletChains.map(chain => `<p class="eyebrow">${walletChainData[chain].name}</p><button class="rowlink" data-copy-chain="${chain}"><div><b>${walletChainData[chain].address}</b><small>Tap to copy</small></div>${icon('copy')}</button><button class="wallet-disconnect-preview" data-open="disconnect:${chain}">Disconnect ${walletChainData[chain].name}</button>`).join('')}`;
  return `<h1>Connect wallet</h1><p class="lead">Sign in, or connect a Solana wallet you already use.</p><input class="wallet-email-preview" type="email" placeholder="you@email.com" aria-label="Email address" autocomplete="off"><button class="wallet-email-continue" data-auth="Continue with Email">Continue with Email</button>${['Continue with Google','Solana Wallet'].map(label => `<button class="rowlink" data-auth="${label}"><div><b>${label}</b></div>${icon('right')}</button>`).join('')}`;
}
function renderArrival() {
  const visible = state.pending.length > 0 && state.nav === 'feed' && !state.trail.length;
  $('#new-arrivals').hidden = !visible;
  $('#new-arrivals').innerHTML = icon('up') + `${state.pending.length} new updates`;
}
function render() {
  if (state.swapOpen) closeSwapSheet(false);
  rememberStories();
  clearTimeout(toastTimer);
  $('#toast').hidden = true;
  const current = state.trail.at(-1);
  $('.app').dataset.destination = state.nav;
  $$('[data-nav]').forEach(button => button.dataset.nav === state.nav ? button.setAttribute('aria-current','page') : button.removeAttribute('aria-current'));
  if (current) $('#scroll').innerHTML = `<div class="backbar"><button id="back">${icon('back')}Back</button><span>${detailName(current.id)}</span><button class="close" id="close" aria-label="Return to destination">${icon('close')}</button></div><article class="detail">${details(current.id)}</article>`;
  else if (state.nav === 'feed') $('#scroll').innerHTML = feed();
  else if (state.nav === 'wallet') $('#scroll').innerHTML = wallet();
  else $('#scroll').innerHTML = apps();
  bindStories();
  renderArrival();
  SwapMock.mount();
}
function detailName(id) {
  if (id.startsWith('disconnect:')) return 'Wallet connection';
  if (id.startsWith('report:')) return 'Latest update';
  if (id.startsWith('activity:')) return 'Smart wallet activity';
  if (id.startsWith('calendar:')) return 'Calendar event';
  return {notifications: 'Notifications', stories: 'Stories', latest: 'Latest updates', iran: 'Ongoing Story', bitcoin: 'Ongoing Story', stats: 'Token stats', calendar: 'Calendar', activity: 'Smart wallet activities', connection: 'Connection options'}[id] || 'App launcher';
}
function calendarEventDetail(id) {
  const event = calendarEvents.find(event => event.id === id);
  if (!event) throw new Error('Unknown calendar event: ' + id);
  return `<p class="eyebrow">${event.category.toUpperCase()} · UTC</p><h1>${event.title}</h1><div class="event-big"><div class="day"><b>${event.date.slice(8)}</b><small>${calendarFormat(event.date, {month: 'short'}).toUpperCase()}</small></div><div><h2>${calendarFormat(event.date, {weekday: 'long'})}</h2><p>${event.time} UTC · ${calendarFormat(event.date, {year: 'numeric'})}<br>${event.context}</p></div></div><p class="lead">${event.description}</p><button class="primary save-calendar-event" data-save-event="${event.id}" aria-pressed="${state.savedEvents.includes(event.id)}">${state.savedEvents.includes(event.id) ? 'Event saved' : 'Save this event'}</button><h2>Source</h2><div class="source"><b>${event.source}</b><p>Illustrative event and schedule for this design preview.</p></div>`;
}
function statsDetail() {
  const data = coins[state.coin];
  return `<p class="eyebrow">TOKEN STATS · ${state.coin}</p><h1>${data.name}</h1><div class="controls" aria-label="Supported sample tokens">${Object.keys(coins).map(coin => `<button data-coin="${coin}" aria-pressed="${state.coin === coin}">${coin}</button>`).join('')}</div><div class="metrics"><div><label>Price</label><b>${data.price}</b><small class="positive">${data.change} · 24h</small></div><div><label>24h volume</label><b>${data.volume}</b><small>USD · 24h</small></div></div><h2>Liquidation map</h2><p class="lead">Estimated exposure by price and time. Brighter areas represent higher modeled exposure.</p><div class="controls" aria-label="Map time window">${['24h','48h','7d'].map(range => `<button data-range="${range}" aria-pressed="${state.range === range}">${range}</button>`).join('')}</div><div class="large-plot">${heatmap(state.coin,true)}</div><div class="legend"><span>Lower estimated exposure</span><i></i><span>Higher</span></div><p class="readout">Largest modeled cluster: ${data.cluster}</p><div class="source"><b>Token dataset · 09:40 UTC</b><p>The dotted line tracks price. Exposure is estimated under model assumptions and is not a price forecast.</p></div>${state.coin === 'BTC' ? link('bitcoin','Bitcoin Story','Flow reporting, developments and original sources') : link('activity','Solana smart wallet activities','Separate observed transactions from watched wallets')}`;
}
function details(id) {
  if (id.startsWith('disconnect:')) return `<h1>Disconnect?</h1><p class="lead">${state.walletSession === 'privy' ? 'This signs you out of Privy and disconnects every wallet in this session. You can sign back in anytime.' : 'You can reconnect anytime.'}</p><button class="wallet-disconnect-preview" data-confirm-disconnect="${id.slice(11)}">Disconnect</button><button class="rowlink" id="back-connection">Cancel</button>`;
  if (id.startsWith('calendar:')) return calendarEventDetail(id.slice('calendar:'.length));
  if (id.startsWith('report:')) {
    const report = reports[id.slice(7)];
    return `<p class="eyebrow">LATEST UPDATE · REPORTED</p><h1>${report.title}</h1><p class="reading">${report.body}</p><div class="source"><b>${report.source}</b><time>${report.time}</time></div><h2>Follow the situation</h2>${link(report.story,report.story === 'bitcoin' ? 'Bitcoin Story' : 'US–Iran Story','Current state and the developments behind it')}`;
  }
  if (id.startsWith('activity:')) {
    const tx = transactions[id.slice(9)];
    return `<p class="eyebrow">SMART WALLET ACTIVITY · SOLANA</p><h1>${tx.name} ${tx.action.toLowerCase()} ${tx.token}</h1><div class="current"><label>OBSERVED TRANSACTION</label><p><strong class="${tx.action === 'Bought' ? 'positive' : 'negative'}">${tx.quantity} ${tx.token}</strong><br>${tx.action === 'Bought' ? 'Buy' : 'Sell'} · ${tx.time}</p></div><div class="source"><b>Watched wallet · ${tx.name}</b><p>${tx.wallet}</p><time>Onchain index · Confirmed observation</time></div><p class="lead">This records a watched wallet’s action. It does not explain the wallet’s motivation or full holdings.</p><h2>Keep exploring</h2>${link('activity','All smart wallet activities','Observed actions from watched wallets')}${link('stats','Solana token stats','Price, volume and separate modeled data','SOL')}`;
  }
  if (id.startsWith('app:')) {
    const [key,name,desc] = appData.find(app => app[0] === id.slice(4));
    return `<img src="assets/${key}.svg" alt="" width="56" height="56"><h1 style="margin-top:18px">${name}</h1><p class="lead">${desc}.</p><div class="current"><label>WALLET ACCESS</label><p>${key === 'polymarket' ? 'Uses a separate Email or Google-backed EVM wallet. Its funds are separate from Solana.' : 'Uses your connected Solana wallet.'}</p></div><button class="primary" id="back-app">Back to Apps</button>`;
  }
  if (id === 'notifications') return `<h1>Notifications</h1><div class="notification-empty">${icon('bell')}<h2>You’re all caught up</h2><p>Notifications will appear here when there’s something new for you.</p></div>`;
  if (id === 'stories') return `<p class="eyebrow">STORIES · ONGOING CONTEXT</p><h1>Where things stand</h1><p class="lead">Follow a situation through its developments and original reporting.</p><h2>Current Stories</h2>${link('iran','US–Iran','Talks resume; shipping restrictions remain')}${link('bitcoin','Bitcoin','ETF flows return to net inflows')}`;
  if (id === 'latest') return `<p class="eyebrow">NEWEST FIRST</p><h1>Latest updates</h1><div class="updates-list">${(state.applied ? ['shippingUpdate','flows','world','shipping','previous'] : ['flows','world','shipping','previous']).map((key,index) => updateCard(key,reports[key].time,index === 0)).join('')}</div>`;
  if (id === 'iran') return `<p class="eyebrow">STORY · GEOPOLITICS</p><h1>US–Iran</h1><p class="lead">Diplomacy, shipping and the energy supply outlook, followed through time.</p><div class="current"><label>WHERE THINGS STAND</label><p>Negotiators have returned to talks. Shipping restrictions remain in place, and no concluded agreement has been reported.</p></div><h2>How we got here</h2><ol class="timeline">${state.applied ? '<li><time>3 OCT · 09:48 UTC</time><p>A new briefing confirms shipping restrictions remain.</p><small>Maritime briefing · Reported observation</small></li>' : ''}<li><time>3 OCT · 09:34 UTC</time><p>Negotiators resume meetings.</p><small>World desk · Reported development</small></li><li><time>2 OCT · 15:10 UTC</time><p>Shipping operators review routes; restrictions remain unchanged.</p><small>Maritime briefing · Reported observation</small></li><li><time>1 OCT · 11:20 UTC</time><p>Officials discuss conditions for returning to talks.</p><small>World desk · Reported statement</small></li></ol><h2>Read the reporting</h2>${state.applied ? link('report:shippingUpdate','Latest shipping briefing','Maritime briefing · 3 Oct, 09:48 UTC') : ''}${link('report:world','Negotiators return to talks','World desk · 3 Oct')}${link('report:shipping','Shipping conditions remain unchanged','Maritime briefing · 2 Oct')}<h2>Still unresolved</h2><p class="lead">The terms of an agreement and a confirmed change to shipping restrictions.</p>`;
  if (id === 'bitcoin') return `<p class="eyebrow">STORY · BITCOIN</p><h1>Bitcoin flows turn positive</h1><div class="current"><label>WHERE THINGS STAND</label><p>The latest session recorded $214m of net inflows after two withdrawal sessions. Further sessions will show whether buying continues.</p></div><h2>What changed</h2><div class="comparison"><div><label>1 OCT · PREVIOUS</label><strong class="negative">−$85m</strong><small>Net outflow</small></div><div><label>2 OCT · LATEST</label><strong class="positive">+$214m</strong><small>Net inflow</small></div></div><p class="lead">The comparison uses session-level values from the ETF flow desk.</p><h2>Read the reporting</h2>${link('report:flows','Latest session returns to inflows','ETF flow desk · 3 Oct')}${link('report:previous','The previous withdrawal session','ETF flow desk · 2 Oct')}<h2>Other information about Bitcoin</h2><p class="lead">Token stats share the asset and provide a separate dataset.</p>${link('stats','Bitcoin token stats','Price, volume and modeled liquidation exposure','BTC')}`;
  if (id === 'stats') return statsDetail();
  if (id === 'calendar') return `<p class="eyebrow">CALENDAR · SCHEDULED EVENTS · UTC</p><h1>All events</h1><p class="lead">Economic releases, company earnings and token unlocks.</p><h2>October 2026</h2><div class="calendar-full-list">${calendarEvents.map(event => calendarEventRow(event)).join('')}</div>`;
  if (id === 'activity') return `<p class="eyebrow">WATCHED SOLANA WALLETS</p><h1>Smart wallet activities</h1><p class="lead">Observed transactions from watched Solana wallets.</p><h2>Recent activity</h2>${(state.applied ? ['northBuy','coast','north'] : ['coast','north']).map(key => {const tx = transactions[key]; return link('activity:'+key,`${tx.name} ${tx.action.toLowerCase()} ${tx.quantity} ${tx.token}`,'Onchain index · '+tx.time);}).join('')}`;
  if (id === 'connection') return walletConnectionDetail();
  throw new Error('Unknown prototype route: '+id);
}

function remember() {
  rememberStories();
  const current = state.trail.at(-1);
  if (current) current.scroll = $('#scroll').scrollTop;
  else state.scroll[state.nav] = $('#scroll').scrollTop;
}
function restore() { $('#scroll').scrollTop = state.trail.at(-1)?.scroll || (!state.trail.length ? state.scroll[state.nav] : 0) || 0; }
function open(id) {
  if (id === 'swap') { openSwapSheet(); return; }
  remember(); state.trail.push({id, scroll: 0}); render(); $('#scroll').scrollTop = 0; $('#back').focus({preventScroll: true});
}
function swapBackgroundInert(inert) {
  $$('.masthead, #scroll, .nav, #new-arrivals, #toast').forEach(element => element.inert = inert);
}
function openSwapSheet() {
  if (state.swapOpen) return;
  swapSheetOrigin = $('[data-wallet-action="swap"]') || document.activeElement;
  state.swapOpen = true;
  clearTimeout(toastTimer); $('#toast').hidden = true;
  $('#swap-sheet-content').innerHTML = SwapMock.render();
  $('#swap-sheet-content').scrollTop = 0;
  $('#swap-sheet-layer').hidden = false;
  swapBackgroundInert(true);
  SwapMock.mount();
  $('#swap-sheet').focus({preventScroll:true});
}
function closeSwapSheet(restoreFocus = true) {
  if (!state.swapOpen) return;
  state.swapOpen = false;
  $('#swap-sheet-layer').hidden = true;
  $('#swap-sheet-content').innerHTML = '';
  swapBackgroundInert(false);
  SwapMock.mount();
  if (restoreFocus) (swapSheetOrigin?.isConnected ? swapSheetOrigin : $('[data-wallet-action="swap"]') || $('#scroll')).focus({preventScroll:true});
  swapSheetOrigin = null;
}
function focusOrigin(id) {
  const origin = $$('[data-open]').find(button => button.dataset.open === id);
  (origin || $('#notifications')).focus({preventScroll: true});
}
function back() { const removed = state.trail.pop(); render(); restore(); focusOrigin(removed?.id); }
function closeAll() { const origin = state.trail[0]?.id; state.trail.length = 0; render(); restore(); focusOrigin(origin); }
function nav(next) {
  if (next === state.nav && state.trail.length) { closeAll(); return; }
  remember(); state.nav = next; state.trail = trails[next]; render(); restore();
}
function refreshDetail(selector) {
  const top = $('#scroll').scrollTop; render(); $('#scroll').scrollTop = top; $(selector).focus({preventScroll: true});
}
function toast(message) {
  clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false;
  toastTimer = setTimeout(() => $('#toast').hidden = true, 2600);
}
function queueUpdates() {
  if (state.pending.length || state.applied) return;
  state.pending = ['shippingUpdate','northBuy'];
  $('#queue-updates').disabled = true; $('#queue-updates').textContent = '2 sample updates waiting';
  renderArrival();
}
document.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.id === 'close-swap-sheet' || button.id === 'swap-sheet-backdrop') { closeSwapSheet(); return; }
  if (SwapMock.handleClick(button)) return;
  if (state.swapOpen) return;
  if (button.id === 'back' && SwapMock.back()) return;
  if (button.dataset.nav) {
    if (button.dataset.nav === 'wallet' && previewParameters.get('wallet-design') === 'inline') { location.href = 'wallet-inline.html'; return; }
    nav(button.dataset.nav); return;
  }
  if (button.dataset.open) { if (button.dataset.asset) state.coin = button.dataset.asset; open(button.dataset.open); return; }
  if (button.id === 'notifications') { if (state.trail.at(-1)?.id !== 'notifications') open('notifications'); return; }
  if (button.id === 'profile') { open('connection'); return; }
  if (button.id === 'back' || button.id === 'back-app' || button.id === 'back-connection') { back(); return; }
  if (button.id === 'close') { closeAll(); return; }
  if (button.id === 'queue-updates') { queueUpdates(); return; }
  if (button.id === 'new-arrivals') { state.pending = []; state.applied = true; state.scroll.feed = 0; render(); $('#scroll').scrollTop = 0; $('#queue-updates').textContent = 'Sample updates applied'; $('#scroll h1').setAttribute('tabindex','-1'); $('#scroll h1').focus({preventScroll: true}); return; }
  if (button.dataset.coin) { state.coin = button.dataset.coin; refreshDetail(`[data-coin="${state.coin}"]`); return; }
  if (button.dataset.range) { state.range = button.dataset.range; refreshDetail(`[data-range="${state.range}"]`); return; }
  if (button.dataset.calendarMode) { rememberStories(); state.calendarMode = button.dataset.calendarMode; refreshDetail(`[data-calendar-mode="${state.calendarMode}"]`); return; }
  if (button.dataset.calendarStep) { rememberStories(); state.calendarDate = shiftDate(state.calendarDate, Number(button.dataset.calendarStep) * (state.calendarMode === 'week' ? 7 : 1)); refreshDetail(`[data-calendar-step="${button.dataset.calendarStep}"]`); return; }
  if (button.dataset.saveEvent) { const id = button.dataset.saveEvent; if (state.savedEvents.includes(id)) state.savedEvents = state.savedEvents.filter(saved => saved !== id); else state.savedEvents.push(id); const saved = state.savedEvents.includes(id); button.setAttribute('aria-pressed',String(saved)); button.textContent = saved ? 'Event saved' : 'Save this event'; return; }
  if (button.id === 'refresh') { remember(); state.walletRepaired = walletAccountData.map(account => account.id); state.walletFreshness = 'as of just now'; render(); restore(); $('#refresh').focus({preventScroll: true}); toast('Sample wallet balances refreshed.'); return; }
  if (button.dataset.walletRetry) { remember(); state.walletRepaired.push(button.dataset.walletRetry); state.walletFreshness = 'as of just now'; render(); restore(); $(`[data-wallet-account="${button.dataset.walletRetry}"]`).focus({preventScroll: true}); return; }
  if (button.dataset.walletAction) { if (button.dataset.walletAction === 'swap') open('swap'); else toast('Coming soon'); return; }
  if (button.dataset.walletAccount) { const account = walletAccountData.find(account => account.id === button.dataset.walletAccount); toast(`${account.name} opens in the app. Its screen is outside this Wallet preview.`); return; }
  if (button.dataset.copyChain) { toast('Address copy preview. No real wallet is connected.'); return; }
  if (button.dataset.confirmDisconnect) { state.walletChains = state.walletSession === 'privy' ? [] : state.walletChains.filter(chain => chain !== button.dataset.confirmDisconnect); if (!state.walletChains.length) { state.walletSession = null; $('#wallet-preview').value = 'guest'; } closeAll(); toast('Demo wallet disconnected.'); return; }
  if (button.dataset.auth) { toast('Connection preview only. Choose a connected state in Wallet preview.'); return; }
});
document.addEventListener('change', event => {
  if (event.target.id !== 'wallet-preview') return;
  remember(); setWalletPreset(event.target.value); state.nav = 'wallet'; state.trail = trails.wallet; render(); restore();
});
document.addEventListener('keydown', event => {
  if (state.swapOpen) {
    if (event.key === 'Escape') { event.preventDefault(); if (!SwapMock.back()) closeSwapSheet(); return; }
    if (event.key === 'Tab' && !event.defaultPrevented) {
      const controls = [...$('#swap-sheet').querySelectorAll('button:not([disabled]),input:not([disabled])')].filter(control => !control.closest('[hidden],[inert]'));
      const first = controls[0], last = controls.at(-1);
      if (!first) { event.preventDefault(); $('#swap-sheet').focus(); return; }
      if (!controls.includes(document.activeElement) || (!event.shiftKey && document.activeElement === last)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    }
    return;
  }
  if (event.key === 'Escape' && SwapMock.back()) { event.preventDefault(); return; }
  if (event.key === 'Escape' && state.trail.length) { event.preventDefault(); back(); }
});
render();
