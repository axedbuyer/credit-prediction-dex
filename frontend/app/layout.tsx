import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import '@rainbow-me/rainbowkit/styles.css'
import './globals.css'
import { Providers } from '@/components/Providers'
import { Header } from '@/components/Header'

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' })

export const metadata: Metadata = {
  title: 'Credit Prediction DEX',
  description: 'Will MicroStrategy have a credit event in the next 12 months?',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-screen bg-slate-950 text-slate-100 antialiased">
        <Providers>
          <Header />
          <main>{children}</main>
        </Providers>
      </body>
    </html>
  )
}
