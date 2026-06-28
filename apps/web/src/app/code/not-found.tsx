import Link from 'next/link'

export default function CodeNotFound() {
  return (
    <div className="max-w-4xl mx-auto py-24 px-6 text-center">
      <h1 className="text-6xl font-bold text-mipham-600 mb-4">404</h1>
      <h2 className="text-2xl font-semibold mb-4">Page not found</h2>
      <p className="text-gray-600 mb-8">The page you&apos;re looking for doesn&apos;t exist.</p>
      <Link
        href="/code"
        className="bg-mipham-500 hover:bg-mipham-400 text-white font-semibold py-2 px-6 rounded-lg transition-colors inline-block"
      >
        Back to Mipham Code
      </Link>
    </div>
  )
}
