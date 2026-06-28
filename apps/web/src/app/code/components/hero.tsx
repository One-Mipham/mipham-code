import { PACKAGE_VERSION } from '@mipham/shared'

export function HeroSection() {
  return (
    <section className="bg-gradient-to-b from-mipham-900 to-mipham-700 text-white py-24 px-6">
      <div className="max-w-4xl mx-auto text-center">
        <h1 className="text-3xl md:text-5xl font-bold mb-6 tracking-tight">
          Mipham Code{' '}
          <span className="text-mipham-400 text-xl align-top">v{PACKAGE_VERSION}</span>
        </h1>
        <p className="text-xl text-mipham-200 mb-4 max-w-2xl mx-auto">
          Multi-model open-core intelligent coding terminal. Built for developers who demand power,
          speed, and flexibility.
        </p>
        <p className="text-mipham-300 mb-8">
          Powered by One Mipham Corporation | 北京华安麦逄科技有限公司
        </p>
        <p className="text-mipham-400 text-sm mb-8">
          International: mipham.ai &nbsp;|&nbsp; 中国大陆: onemipham.com
        </p>
        <div className="flex gap-4 justify-center">
          <a
            href="/code/install"
            className="bg-mipham-500 hover:bg-mipham-400 text-white font-semibold py-3 px-8 rounded-lg transition-colors"
          >
            Get Started
          </a>
          <a
            href="/code/docs"
            className="border border-mipham-300 text-mipham-100 hover:bg-white/10 font-semibold py-3 px-8 rounded-lg transition-colors"
          >
            Documentation
          </a>
        </div>
      </div>
    </section>
  )
}
