export function FooterSection() {
  return (
    <footer className="py-10 px-6 bg-gray-100 border-t border-gray-200">
      <div className="max-w-6xl mx-auto flex flex-col sm:flex-row justify-between items-center gap-4 text-sm text-gray-500">
        <div>
          &copy; {new Date().getFullYear()} One Mipham Corporation. All rights reserved.
        </div>
        <div className="flex gap-6">
          <a href="/code/docs" className="hover:text-mipham-600 transition-colors">
            Docs
          </a>
          <a href="/code/dashboard" className="hover:text-mipham-600 transition-colors">
            Dashboard
          </a>
          <a
            href="https://github.com/mipham-ai/mipham-code"
            className="hover:text-mipham-600 transition-colors"
            target="_blank"
            rel="noopener noreferrer"
          >
            GitHub
          </a>
        </div>
      </div>
    </footer>
  )
}
