'use client'

import { ConnectButton } from '@rainbow-me/rainbowkit'
import Link from 'next/link'

export function Header() {
  return (
    <header className="border-b border-slate-800 bg-slate-900">
      <div className="mx-auto max-w-7xl px-4 py-3 flex items-center justify-between">
        <nav className="flex items-center gap-6">
          <Link href="/market/mstr" className="font-semibold text-slate-100 text-sm tracking-tight">
            Credit DEX
          </Link>
          <Link href="/market/mstr" className="text-sm text-slate-400 hover:text-slate-200 transition-colors">
            Market
          </Link>
          <Link href="/portfolio" className="text-sm text-slate-400 hover:text-slate-200 transition-colors">
            Portfolio
          </Link>
        </nav>
        <ConnectButton />
      </div>
    </header>
  )
}
