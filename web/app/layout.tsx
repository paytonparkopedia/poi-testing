import './globals.css'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'POI Testing - Parkopedia API Validator',
  description: 'Internal tool for validating Parkopedia API endpoints at scale',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
