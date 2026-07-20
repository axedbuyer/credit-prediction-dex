'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { DOCS_NAV, docHref } from './nav'

export function DocsSidebar() {
  const pathname = usePathname()

  return (
    <aside className="hidden w-56 shrink-0 lg:block">
      <nav className="sticky top-20 space-y-8">
        {DOCS_NAV.map((group) => (
          <div key={group.label}>
            <p className="pari-eyebrow mb-3">{group.label}</p>
            <ul className="space-y-1">
              {group.pages.map((page) => {
                const href = docHref(page.slug)
                const isActive = pathname === href
                return (
                  <li key={page.slug}>
                    <Link
                      href={href}
                      aria-current={isActive ? 'page' : undefined}
                      className={
                        isActive
                          ? 'block rounded px-3 py-1.5 text-sm text-teal bg-teal-a10'
                          : 'block rounded px-3 py-1.5 text-sm text-text-2 transition-colors hover:bg-surface-2 hover:text-text-1'
                      }
                    >
                      {page.title}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </nav>
    </aside>
  )
}
