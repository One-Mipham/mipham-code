import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Mipham Code — AI Coding Terminal',
  description:
    'Multi-model open-core intelligent coding terminal. Powered by One Mipham Corporation.',
}

export default function CodeLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-white text-gray-900 antialiased">{children}</body>
    </html>
  )
}
