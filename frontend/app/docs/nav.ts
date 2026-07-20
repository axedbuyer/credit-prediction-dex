// Shared docs nav structure — consumed by DocsSidebar and any future index/search page.
// Single source of truth for slug → title mapping; stub pages under app/docs/<slug>/
// should keep their <h1> and metadata.title in sync with the `title` here.

export type DocPage = {
  slug: string
  title: string
}

export type DocGroup = {
  label: string
  pages: DocPage[]
}

export const DOCS_NAV: DocGroup[] = [
  {
    label: 'Getting started',
    pages: [
      { slug: 'what-is-pari', title: 'What is Pari' },
      { slug: 'core-concepts', title: 'Core concepts' },
    ],
  },
  {
    label: 'Trading',
    pages: [
      { slug: 'trading-and-fees', title: 'Trading & fees' },
      { slug: 'mark-to-market-and-carry', title: 'Mark-to-market & carry' },
    ],
  },
  {
    label: 'Risk engine',
    pages: [
      { slug: 'liquidations-and-cure', title: 'Liquidations & cure' },
      { slug: 'credit-events', title: 'Credit events' },
    ],
  },
  {
    label: 'Builders',
    pages: [
      { slug: 'market-makers', title: 'Market maker guide' },
      { slug: 'contract-addresses', title: 'Contracts & addresses' },
    ],
  },
  {
    label: 'Reference',
    pages: [
      { slug: 'faq', title: 'FAQ' },
      { slug: 'glossary', title: 'Glossary' },
      { slug: 'risks', title: 'Risk disclosures' },
    ],
  },
]

// Flat slug → title lookup, derived from DOCS_NAV.
export const DOCS_PAGES: DocPage[] = DOCS_NAV.flatMap((group) => group.pages)

export function docHref(slug: string): string {
  return `/docs/${slug}`
}
