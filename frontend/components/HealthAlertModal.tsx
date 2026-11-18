'use client'

// "Critical" health modal on connect (batch 4, design note §4): when the connected
// wallet holds an Upbet at Critical health in any market, show one modal per browser
// session pointing to Portfolio → Pay carry. On-site only; nothing is sent off-site.

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useAccount } from 'wagmi'
import { useMarkets } from '@/lib/markets'
import type { Market } from '@/lib/markets'
import { usePositionHealth } from '@/lib/positionHealth'

const DISMISS_KEY = 'pari:health-modal-dismissed'

function readDismissed(address: string): boolean {
  try { return sessionStorage.getItem(DISMISS_KEY) === address.toLowerCase() } catch { return false }
}
function writeDismissed(address: string): void {
  try { sessionStorage.setItem(DISMISS_KEY, address.toLowerCase()) } catch { /* storage blocked */ }
}

function Probe({ market, address, onCritical }: { market: Market; address: `0x${string}`; onCritical: (slug: string, critical: boolean) => void }) {
  const h = usePositionHealth(market, address)
  const critical = h.level === 'critical' && !h.claimable
  useEffect(() => { onCritical(market.slug, critical) }, [market.slug, critical, onCritical])
  return null
}

export function HealthAlertModal() {
  const { address } = useAccount()
  const { markets } = useMarkets()
  const [critical, setCritical] = useState<Record<string, boolean>>({})
  const [dismissed, setDismissed] = useState(true)

  useEffect(() => { setDismissed(address ? readDismissed(address) : true); setCritical({}) }, [address])

  const onCritical = useCallback((slug: string, c: boolean) => {
    setCritical(prev => (prev[slug] === c ? prev : { ...prev, [slug]: c }))
  }, [])

  if (!address) return null
  const names = markets.filter(m => critical[m.slug]).map(m => m.entityName)
  const close = () => { writeDismissed(address); setDismissed(true) }

  return (
    <>
      {markets.map(m => <Probe key={m.slug} market={m} address={address} onCritical={onCritical} />)}
      {!dismissed && names.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={close}>
          <div
            className="w-full max-w-md rounded border border-danger-a28 bg-surface-1 p-6 shadow-2xl"
            role="alertdialog"
            aria-labelledby="health-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="health-modal-title" className="font-serif text-lg text-danger">Your Upbet is close to liquidation</h2>
            <p className="mt-3 text-sm text-text-2">
              {names.join(', ')}: about two days of carry or less are left before your Upbet can
              be liquidated at today&rsquo;s chance, and a falling chance brings that closer at once.
              Paying carry resets the clock.
            </p>
            <div className="mt-6 flex gap-3">
              <button onClick={close} className="pari-a-btn pari-a-btn--secondary flex-1">Later</button>
              <Link href="/portfolio" onClick={close} className="pari-a-btn pari-a-btn--primary flex-1 text-center">
                Pay carry
              </Link>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
