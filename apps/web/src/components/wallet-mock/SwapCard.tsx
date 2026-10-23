'use client'
// Swap port. Visuals follow ref/wallet-inline.*, but where Expo's SwapComposer differs, SwapComposer wins (listed in the PR).
import { useEffect, useState } from 'react'
import { Icon } from './icons'
import { useSwipe } from './useSwipe'

type Sym = 'SOL' | 'USDC' | 'JUP'
const TOK: Record<Sym, { bal: number; px: number; dp: number }> = { SOL: { bal: 20, px: 157.42, dp: 9 }, USDC: { bal: 4743.6, px: 1, dp: 6 }, JUP: { bal: 600, px: 0.88, dp: 6 } }
const ORDER: Sym[] = ['SOL', 'USDC', 'JUP']
const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
const num = (n: number, d = 6) => n.toLocaleString('en-US', { maximumFractionDigits: d, useGrouping: false })
const Coin = ({ s }: { s: Sym }) => <span className={`coin ${s.toLowerCase()}`} aria-hidden="true">{s === 'SOL' ? <Icon name="sol" /> : s === 'USDC' ? '$' : 'J'}</span>

export function SwapCard() {
  const [pay, setPay] = useState<Sym>('SOL'), [rec, setRec] = useState<Sym>('USDC')
  const [amount, setAmount] = useState('2'), [pct, setPct] = useState(false)
  const [stage, setStage] = useState<'ready' | 'pending' | 'success'>('ready')
  const a = parseFloat(amount) || 0, avail = TOK[pay].bal - (pay === 'SOL' ? 0.005 : 0)
  const out = a ? (a * TOK[pay].px) / TOK[rec].px : 0, min = out * 0.995
  const error = !amount ? '' : !a ? 'Enter an amount greater than zero.' : a > avail ? (pay === 'SOL' && a <= TOK.SOL.bal ? 'Keep 0.005 SOL available for network fees.' : `Amount exceeds your available ${pay}.`) : ''
  const ok = a > 0 && !error, outTxt = out ? num(out) : '—'
  useEffect(() => { if (stage !== 'pending') return; const t = setTimeout(() => setStage('success'), 1600); return () => clearTimeout(t) }, [stage])
  const swipe = useSwipe(() => setStage('pending'), stage === 'ready' && ok)
  const busy = stage === 'pending'
  const cycle = (side: 'pay' | 'rec') => {
    const cur = side === 'pay' ? pay : rec, other = side === 'pay' ? rec : pay
    let n = ORDER[(ORDER.indexOf(cur) + 1) % 3]; if (n === other) n = ORDER[(ORDER.indexOf(n) + 1) % 3]
    side === 'pay' ? setPay(n) : setRec(n); setStage('ready')
  }
  const fraction = (f: number) => { setAmount(num(Math.floor(avail * f * 1e6) / 1e6)); setStage('ready') }
  const row = (side: 'pay' | 'rec') => {
    const s = side === 'pay' ? pay : rec
    return (
      <div className="asset-row">
        <div>
          <span className="field-label">{side === 'pay' ? 'You pay' : 'You receive'}</span>
          <button className="token-select" disabled={busy} onClick={() => cycle(side)} aria-label={`${s}, tap to switch token`}><span key={s} className="mv-fade" style={{ display: 'contents' }}><Coin s={s} /><span>{s}</span></span><Icon name="down" /></button>
        </div>
        <div className="asset-amount">
          {side === 'pay'
            ? <input className="amount" inputMode="decimal" autoComplete="off" placeholder="0" value={amount} disabled={busy} aria-label="You pay amount" aria-invalid={!!error} onChange={(e) => { setAmount(e.target.value.replace(/[^\d.]/g, '')); setStage('ready') }} />
            : <output className="amount">{outTxt}</output>}
          <div className="amount-meta"><span>{a ? usd(a * TOK[pay].px) : '—'}</span></div>
        </div>
        <div className={`balance-line ${side === 'pay' ? 'pay-balance-line' : ''}`}>
          <span className="token-balance">{TOK[s].bal.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 })}</span>
          {side === 'pay' && (
            <div className="balance-shortcuts">
              <button id="max-amount" disabled={busy} onClick={() => fraction(1)}><span>Max</span></button><span className="shortcut-separator" aria-hidden="true">·</span>
              <div className="percentage-rail">
                {!pct ? <button id="percent-toggle" onClick={() => setPct(true)} aria-label="Show percentage shortcuts"><span>%</span></button>
                  : <div className="balance-options"><button onClick={() => fraction(0.5)}>50%</button><span className="shortcut-separator" aria-hidden="true">·</span><button onClick={() => fraction(0.25)}>25%</button><button onClick={() => setPct(false)} aria-label="Close percentage shortcuts"><Icon name="close" /></button></div>}
              </div>
            </div>
          )}
        </div>
      </div>
    )
  }
  const lab = stage === 'pending' ? ['Swap in progress', 'Waiting for confirmation'] : stage === 'success' ? ['Swap complete', `Received ${outTxt} ${rec}`] : ok ? ['Do the swap to get', `${outTxt} ${rec}`] : [error || 'Enter an amount', '']
  return (
    <div className="composer" id="composer">
      {row('pay')}
      <div className="exchange-seam"><button className="reverse" disabled={busy} aria-label="Reverse pair" onClick={() => { setPay(rec); setRec(pay); setAmount(''); setStage('ready') }}><Icon name="swapVert" /></button></div>
      {row('rec')}
      {amount && (
        <>
          <div className="quote-strip">
            <div className="quote-item"><span>Exchange rate</span><strong className="compact-value"><span>1</span><Coin s={pay} /><span>= {(TOK[pay].px / TOK[rec].px).toLocaleString('en-US', { maximumSignificantDigits: 6 })}</span><Coin s={rec} /></strong></div>
            <div className="quote-item"><span>Slippage</span><strong>Auto ⌄</strong></div>
            <div className="quote-item"><span>Minimum received</span><strong className="compact-value"><span>{out ? num(min, 4) : '—'}</span><Coin s={rec} /></strong></div>
          </div>
          <div className="fee-row"><span>Fees update with quote</span><span>Details ⌄</span></div>
        </>
      )}
      <button className="swipe sw-expo" data-stage={ok || stage !== 'ready' ? stage : 'unavailable'} disabled={(!ok && stage === 'ready') || busy} {...swipe}
        onClick={(e) => { if (stage === 'success') { setStage('ready'); return } if (e.detail === 0 && ok) setStage('pending') }}>
        <span className="swipe-fill" aria-hidden="true" />
        <span className={`swipe-label ${lab[1] ? '' : 'single'}`}>{lab[0]}{lab[1] && <strong>{lab[1]}</strong>}</span>
        <span className="swipe-thumb" aria-hidden="true"><Icon name={stage === 'success' ? 'check' : stage === 'pending' ? 'spin' : 'chevR'} w={2.2} /></span>
      </button>
    </div>
  )
}
