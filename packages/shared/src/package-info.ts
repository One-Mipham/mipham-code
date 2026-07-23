/**
 * Mipham Code — 集中化包元数据
 *
 * **单一数据源**：所有包名、版本、安装命令和 URL 在此集中管理。
 * CLI 代码和网站页面必须从此文件导入，**严禁硬编码**。
 *
 * 当发布新版本或更改包名时，只需修改此文件。
 *
 * @packageDocumentation
 */

/** npm 包全名（含 scope） */
export const PACKAGE_NAME = '@miphamai/cli' as const

/** 当前发布版本 */
export const PACKAGE_VERSION = '0.6.0' as const

/** npm install 全局安装命令 */
export const NPM_INSTALL_COMMAND = `npm install -g ${PACKAGE_NAME}` as const

/** npm update 全局升级命令 */
export const NPM_UPDATE_COMMAND = `npm update -g ${PACKAGE_NAME}` as const

/** npm 包页面 URL */
export const NPM_URL = `https://www.npmjs.com/package/${PACKAGE_NAME}` as const

/** npm 下载量 API */
export const NPM_DOWNLOADS_API =
  `https://api.npmjs.org/downloads/point/last-month/${PACKAGE_NAME}` as const

/** 国际站 — curl 一键安装 */
export const INSTALL_CURL_INTERNATIONAL = 'curl -fsSL https://mipham.ai/install.sh | bash' as const

/** 国内站 — curl 一键安装 */
export const INSTALL_CURL_CHINA = 'curl -fsSL https://onemipham.com/install.sh | bash' as const

/** 国际站产品页 */
export const PRODUCT_URL_INTERNATIONAL = 'https://mipham.ai/mipham-code' as const

/** 国内站产品页 */
export const PRODUCT_URL_CHINA = 'https://onemipham.com/mipham-code' as const

/** GitHub 仓库 */
export const GITHUB_REPO = 'https://github.com/One-Mipham/mipham-code' as const

/** 品牌名称 */
export const BRAND_NAME = 'MiphamAI' as const

/** 产品名称 */
export const PRODUCT_NAME = 'Mipham Code' as const

/** 公司名称（英文） */
export const COMPANY_NAME_EN = 'One Mipham Corporation' as const

/** 公司名称（中文） */
export const COMPANY_NAME_ZH = '北京华安麦逄科技有限公司' as const

/** 公司简称 */
export const COMPANY_SHORT = '华安麦逄科技' as const
