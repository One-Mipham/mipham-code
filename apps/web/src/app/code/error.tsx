'use client'

export default function CodeError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div className="max-w-4xl mx-auto py-24 px-6 text-center">
      <h1 className="text-4xl font-bold mb-4">Something went wrong</h1>
      <p className="text-gray-600 mb-8">{error.message || 'An unexpected error occurred.'}</p>
      <button
        onClick={reset}
        className="bg-mipham-500 hover:bg-mipham-400 text-white font-semibold py-2 px-6 rounded-lg transition-colors"
      >
        Try again
      </button>
    </div>
  )
}
