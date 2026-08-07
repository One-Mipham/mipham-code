'use client'

import { PACKAGE_NAME, PACKAGE_VERSION, GITHUB_REPO } from '@mipham/shared'
import { useI18n } from '@/i18n/context'

const REL_DL = `${GITHUB_REPO}/releases/latest/download`

export default function InstallPage() {
  const { t } = useI18n()
  return (
    <div className="max-w-3xl mx-auto py-16 px-6">
      <h1 className="text-4xl font-bold mb-4">{t('web.install_page.title')}</h1>
      <p className="text-gray-500 mb-4">
        {t('web.install_page.current_version')} <strong>v{PACKAGE_VERSION}</strong>.{' '}
        {t('web.install_page.choose_platform')}
      </p>
      <p className="text-gray-500 mb-8">{t('web.install_page.all_methods_same')}</p>

      {/* Prerequisites */}
      <h2 className="text-2xl font-semibold mb-4">{t('web.install_page.prerequisites')}</h2>
      <ul className="list-disc pl-6 mb-8 space-y-2">
        <li>
          <strong>{t('web.install_page.prereq_bun')}</strong>
        </li>
        <li>{t('web.install_page.prereq_os')}</li>
        <li>{t('web.install_page.prereq_api_key')}</li>
      </ul>

      {/* npm */}
      <h2 className="text-2xl font-semibold mb-4">{t('web.install_page.npm_title')}</h2>
      <p className="mb-2 text-gray-600">{t('web.install_page.npm_desc')}</p>
      <pre className="bg-gray-100 dark:bg-gray-800 p-4 rounded-lg mb-8 overflow-x-auto">
        npm install -g {PACKAGE_NAME}
      </pre>

      {/* curl macOS/Linux */}
      <h2 className="text-2xl font-semibold mb-4">{t('web.install_page.curl_title')}</h2>
      <div className="mb-6">
        <h3 className="font-semibold mb-1">{t('web.install_page.international')}</h3>
        <pre className="bg-gray-100 dark:bg-gray-800 p-4 rounded-lg mb-2 overflow-x-auto">
          curl -fsSL https://mipham.ai/install.sh | bash
        </pre>
      </div>
      <div className="mb-8">
        <h3 className="font-semibold mb-1">{t('web.install_page.china_mainland')}</h3>
        <pre className="bg-gray-100 dark:bg-gray-800 p-4 rounded-lg mb-2 overflow-x-auto">
          curl -fsSL https://onemipham.com/install.sh | bash
        </pre>
      </div>

      {/* PowerShell Windows */}
      <h2 className="text-2xl font-semibold mb-4">{t('web.install_page.powershell_title')}</h2>
      <div className="mb-6">
        <h3 className="font-semibold mb-1">{t('web.install_page.international')}</h3>
        <pre className="bg-gray-100 dark:bg-gray-800 p-4 rounded-lg mb-2 overflow-x-auto">
          irm https://mipham.ai/install.ps1 | iex
        </pre>
      </div>
      <div className="mb-8">
        <h3 className="font-semibold mb-1">{t('web.install_page.china_mainland')}</h3>
        <pre className="bg-gray-100 dark:bg-gray-800 p-4 rounded-lg mb-2 overflow-x-auto">
          irm https://onemipham.com/install.ps1 | iex
        </pre>
      </div>

      {/* Direct Download */}
      <h2 className="text-2xl font-semibold mb-4">{t('web.install_page.direct_download')}</h2>
      <div className="overflow-x-auto mb-8">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b">
              <th className="py-2 pr-4">{t('web.install_page.table_platform')}</th>
              <th className="py-2">{t('web.install_page.table_download')}</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b">
              <td className="py-2 pr-4">{t('web.install_page.platform_mac_arm')}</td>
              <td className="py-2">
                <a
                  href={`${REL_DL}/mipham-darwin-arm64`}
                  className="text-mipham-600 hover:underline font-mono text-sm"
                >
                  mipham-darwin-arm64 &darr;
                </a>
              </td>
            </tr>
            <tr className="border-b">
              <td className="py-2 pr-4">{t('web.install_page.platform_mac_intel')}</td>
              <td className="py-2">
                <a
                  href={`${REL_DL}/mipham-darwin-x64`}
                  className="text-mipham-600 hover:underline font-mono text-sm"
                >
                  mipham-darwin-x64 &darr;
                </a>
              </td>
            </tr>
            <tr className="border-b">
              <td className="py-2 pr-4">{t('web.install_page.platform_linux')}</td>
              <td className="py-2">
                <a
                  href={`${REL_DL}/mipham-linux-x64`}
                  className="text-mipham-600 hover:underline font-mono text-sm"
                >
                  mipham-linux-x64 &darr;
                </a>
              </td>
            </tr>
            <tr className="border-b">
              <td className="py-2 pr-4">{t('web.install_page.platform_windows')}</td>
              <td className="py-2">
                <a
                  href={`${REL_DL}/mipham-win-x64.exe`}
                  className="text-mipham-600 hover:underline font-mono text-sm"
                >
                  mipham-win-x64.exe &darr;
                </a>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Verify */}
      <h2 className="text-2xl font-semibold mb-4">{t('web.install_page.verify_title')}</h2>
      <pre className="bg-gray-100 dark:bg-gray-800 p-4 rounded-lg mb-8 overflow-x-auto">
        mipham --version
      </pre>

      {/* Start */}
      <h2 className="text-2xl font-semibold mb-4">{t('web.install_page.start_title')}</h2>
      <pre className="bg-gray-100 dark:bg-gray-800 p-4 rounded-lg mb-8 overflow-x-auto">mipham</pre>
      <p className="text-gray-600 mb-8">{t('web.install_page.first_launch')}</p>

      {/* API Keys */}
      <h2 className="text-2xl font-semibold mb-4">{t('web.install_page.api_keys_title')}</h2>
      <p className="mb-2 text-gray-600">{t('web.install_page.api_keys_desc')}</p>
      <pre className="bg-gray-100 dark:bg-gray-800 p-4 rounded-lg overflow-x-auto">
        {`export ANTHROPIC_API_KEY="sk-ant-..."
export OPENAI_API_KEY="sk-..."
export DEEPSEEK_API_KEY="sk-..."
export QWEN_API_KEY="sk-..."
export DOUBAO_API_KEY="..."
export HUNYUAN_API_KEY="..."
export GEMINI_API_KEY="..."`}
      </pre>
    </div>
  )
}
