'use client'

import { ConnectButton } from '@rainbow-me/rainbowkit'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { PariLogo } from '@/components/PariLogo'

const navLinks = [
  { href: '/market/mstr', label: 'Market' },
  { href: '/portfolio', label: 'Portfolio' },
  { href: '/liquidate', label: 'Liquidate' },
  { href: '/docs', label: 'Docs' },
]

export function Header() {
  const pathname = usePathname()

  return (
    <header className="pari-nav">
      <Link href="/" className="pari-wordmark">
        <PariLogo size={26} />
        <span className="pari-wordmark__text">Pari</span>
      </Link>

      <nav className="flex items-center gap-6">
        {navLinks.map((link) => {
          const isActive = pathname?.startsWith(link.href)
          return (
            <Link
              key={link.href}
              href={link.href}
              className={
                isActive
                  ? 'text-sm text-teal transition-colors'
                  : 'text-sm text-text-2 hover:text-text-1 transition-colors'
              }
            >
              {link.label}
            </Link>
          )
        })}
      </nav>

      <div className="ml-auto flex items-center gap-6">
        <Link href="/admin" className="text-xs text-text-muted hover:text-text-2 transition-colors">
          Admin
        </Link>
        <ConnectButton />
      </div>
    </header>
  )
}
