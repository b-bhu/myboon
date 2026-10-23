import { Icon, Mark } from './icons'

// Static port of apps/hybrid-expo/features/feed (FeedHeader, FeedList, FeedCard). Example data, scroll only.
type Story = { cat: string; date: string; t: string; s: string; src?: string; img?: string }
const LEAD: Story = { cat: 'Macro', date: '2h ago', img: '/wallet-mock/feed-macro-lead.jpg', t: 'Rate-cut bets jump after a softer inflation print', s: 'Traders now price two cuts by March. Bond yields fell and the dollar slipped as the core reading came in below forecasts.', src: 'MyBoon Research' }
const STORIES: Story[] = [
  { cat: 'Geopolitics', date: '5h ago', img: '/wallet-mock/feed-us-iran.jpg', t: 'Oil swings as US–Iran talks stall', s: 'Brent gave back early gains. Prediction markets on a deal slipped to 31%.', src: 'MyBoon Research' },
  { cat: 'Crypto', date: '7h ago', t: 'SOL holds $150 as ETF flows turn positive', s: 'Three days of inflows after two weeks of outflows.', src: 'MyBoon Research' },
  { cat: 'Earnings', date: '9h ago', t: 'Chipmakers lead after a strong guidance beat', s: 'The sector added 3% into the close as data-centre demand stayed firm.' },
  { cat: 'Latest', date: '11h ago', t: 'Jobless claims edge lower for a second week', s: 'The labour market keeps cooling slowly, not sharply.', src: 'MyBoon Research' },
  { cat: 'Markets', date: '1d ago', t: 'Gold steadies near its record as real yields dip', s: 'Central-bank buying remains the main support.' },
]
export const FeedScreen = () => (
  <main className="fd">
    <header className="fd-head">
      <span className="fd-back" aria-hidden="true"><Icon name="back" w={2} /></span>
      <h1>All updates</h1>
      <span className="fd-cal" aria-hidden="true"><Icon name="cal" w={2} /></span>
    </header>
    <div className="fd-list">
      <p className="fd-ctx">Published reports · Newest first</p>
      <article className="fd-lead">
        <img src={LEAD.img} alt="" />
        <div className="fd-lc">
          <div className="fd-meta"><small>{LEAD.cat}</small><time>{LEAD.date}</time></div>
          <h2>{LEAD.t}</h2><p>{LEAD.s}</p>
          <div className="fd-lf"><span>{LEAD.src}</span><b>Read more →</b></div>
        </div>
      </article>
      {STORIES.map((x) => (
        <article key={x.t} className="fd-card">
          <div className="fd-cc">
            <div className="fd-meta"><small>{x.cat}</small><time>{x.date}</time></div>
            <h2>{x.t}</h2><p>{x.s}</p>
            {x.src && <div className="fd-cf"><span>{x.src}</span></div>}
          </div>
          {x.img && <img src={x.img} alt="" />}
        </article>
      ))}
    </div>
  </main>
)

const APPS = [
  ['polymarket', 'Polymarket', 'Prediction markets'], ['pacifica', 'Pacifica', 'Perpetuals'], ['phoenix', 'Phoenix', 'Perpetuals'],
  ['meteora', 'Meteora', 'Liquidity pools'],
] as const
export const AppsScreen = () => (
  <main className="mock-screen">
    <h1>Apps</h1>
    <div className="mock-apps">
      {APPS.map(([k, n, d]) => <div key={k} className="mock-app"><Mark k={k} /><strong>{n}</strong><small>{d}</small></div>)}
    </div>
  </main>
)
