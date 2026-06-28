/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  basePath: '/mipham-code',
  images: { unoptimized: true },
  eslint: { ignoreDuringBuilds: true }, // ESLint 10 incompatibility with Next.js 14 built-in config
}

module.exports = nextConfig
