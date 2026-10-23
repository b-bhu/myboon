import { Mark } from './icons'

// Light static mocks of the existing Feed and Apps designs. Scroll only.
const STORIES = [
  { img: '/wallet-mock/feed-macro-lead.jpg', tag: 'MACRO', t: 'Rate-cut bets jump after a softer inflation print', s: 'Traders now price two cuts by March. Here is what moved and why.', m: '4 updates · 2h' },
  { img: '/wallet-mock/feed-us-iran.jpg', tag: 'GEOPOLITICS', t: 'Oil swings as US–Iran talks stall', s: 'Brent gave back early gains. Prediction markets on a deal slipped to 31%.', m: '6 updates · 5h' },
  { tag: 'CRYPTO', t: 'SOL holds $150 as ETF flows turn positive', s: 'Three days of inflows after two weeks of outflows.', m: '3 updates · 7h' },
  { tag: 'EARNINGS', t: 'Chipmakers lead after a strong guidance beat', s: 'The sector added 3% into the close.', m: '2 updates · 9h' },
]
export const FeedScreen = () => (
  <main className="mock-screen">
    <h1>Today</h1>
    {STORIES.map((x) => (
      <article key={x.t} className="mock-story">
        {x.img && <img src={x.img} alt="" />}
        <div><small>{x.tag}</small><h2>{x.t}</h2><p>{x.s}</p><em>{x.m}</em></div>
      </article>
    ))}
  </main>
)

const APPS = [
  ['polymarket', 'Polymarket', 'Prediction markets'], ['pacifica', 'Pacifica', 'Perpetuals'], ['phoenix', 'Phoenix', 'Perpetuals'],
  ['meteora', 'Meteora', 'Liquidity pools'], ['drift', 'Drift', 'Perpetuals'], ['kamino', 'Kamino', 'Lending'], ['jupiter', 'Jupiter', 'Swap'], ['marginfi', 'marginfi', 'Lending'],
] as const
export const AppsScreen = () => (
  <main className="mock-screen">
    <h1>Apps</h1>
    <div className="mock-apps">
      {APPS.map(([k, n, d]) => <div key={k} className="mock-app"><Mark k={k} /><strong>{n}</strong><small>{d}</small></div>)}
    </div>
  </main>
)
