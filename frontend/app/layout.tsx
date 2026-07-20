import type { Metadata } from 'next'
import { EB_Garamond, Barlow } from 'next/font/google'
import '@rainbow-me/rainbowkit/styles.css'
import '../styles/pari/tokens.css'
import '../styles/pari/components.css'
import '../styles/pari/docs.css'
import './globals.css'
import { Providers } from '@/components/Providers'
import { Header } from '@/components/Header'

const ebGaramond = EB_Garamond({
  subsets: ['latin'],
  weight: ['400', '500', '700'],
  style: ['normal', 'italic'],
  variable: '--font-eb-garamond',
})

const barlow = Barlow({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700'],
  variable: '--font-barlow',
})

export const metadata: Metadata = {
  title: 'Pari — Tradable Credit For All',
  description: 'Will MicroStrategy have a credit event in the next 12 months?',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className={`${ebGaramond.variable} ${barlow.variable}`}>
      <body className="min-h-screen antialiased">
        <Providers>
          <Header />
          <main>{children}</main>
        </Providers>
      </body>
    </html>
  )
}
