'use client'

import { ConnectButton } from '@rainbow-me/rainbowkit'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { PariLogo } from '@/components/PariLogo'
import { MarketsMenu } from '@/components/MarketsMenu'

const navLinks: { href: string; label: string; also?: string }[] = [
  { href: '/', label: 'Markets', also: '/market' },
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
          const isActive =
            link.href === '/'
              ? pathname === '/' || !!pathname?.startsWith(link.also ?? '/market')
              : pathname?.startsWith(link.href)
          if (link.href === '/') return <MarketsMenu key={link.href} isActive={!!isActive} />
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
