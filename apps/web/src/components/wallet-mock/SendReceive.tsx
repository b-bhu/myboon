'use client'
import { useState } from 'react'
import { Tk } from './icons'

export const SendCard = () => (
  <div className="composer mv"><div className="mv-ph">
    <label htmlFor="mv-to">To</label><div className="fld"><input id="mv-to" placeholder="Solana or EVM address" autoComplete="off" /></div>
    <label htmlFor="mv-samt">Amount</label><div className="fld"><Tk t="USDC" /><input id="mv-samt" className="big" inputMode="decimal" placeholder="0.00" /><span style={{ color: 'var(--dim)', fontSize: 12 }}>USDC</span></div>
    <button className="btn" disabled>Send · example</button>
  </div></div>
)

const ADDR = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'
const QR = Array.from({ length: 81 }, (_, i) => { const r = (i / 9) | 0, c = i % 9, fin = (r < 3 && c < 3) || (r < 3 && c > 5) || (r > 5 && c < 3); return fin ? (r % 3 === 1 && c % 3 === 1 ? 'o' : '') : (i * 7 + r * 3) % 5 < 2 ? 'o' : '' })
export function ReceiveCard() {
  const [copied, setCopied] = useState(false)
  return (
    <div className="composer mv"><div className="mv-ph">
      <div className="mv-qr" role="img" aria-label="QR code placeholder">{QR.map((c, i) => <i key={i} className={c} />)}</div>
      <p className="addr">{ADDR}</p>
      <button className="btn" onClick={() => { navigator.clipboard?.writeText(ADDR).catch(() => {}); setCopied(true) }}>{copied ? 'Copied' : 'Copy address'}</button>
      <label style={{ textAlign: 'center' }}>Same address works on Solana. EVM: 0x4f…a91C (example)</label>
    </div></div>
  )
}
