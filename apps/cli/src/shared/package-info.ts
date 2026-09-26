/**
 * Mipham Code — package metadata (bundled version)
 *
 * Compile-time constants (bundled into the compiled binary — no runtime
 * package.json read). Version is synced by scripts/bump-version.sh.
 */

/** npm 包全名（含 scope） */
export const PACKAGE_NAME = '@miphamai/cli' as const

/** 当前发布版本 */
export const PACKAGE_VERSION = '0.85.6' as const

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

/** AI 提交时的 Co-Authored-By 署名（品牌默认 Mipham，企业/团队可覆盖为自身名）。 */
export const COAUTHOR_TRAILER = 'Co-Authored-By: Mipham <noreply@mipham.ai>' as const

/** 公司名称（英文） */
export const COMPANY_NAME_EN = 'One Mipham Corporation' as const

/** 公司名称（中文） */
export const COMPANY_NAME_ZH = '北京华安麦逄科技有限公司' as const

/** 公司简称 */
export const COMPANY_SHORT = '华安麦逄科技' as const

/**
 * 计数类常量 —— 公开面（两个官网的产品页）与文档消费的那几个数。
 *
 * **不要手改。** 这四个数由 `apps/cli/scripts/sync-counts.ts` 从真源产出后回写：
 * 命令 / 提供商 / 工具在**进程内算出**（`getCommandNames()` / `DEFAULT_PROVIDERS` /
 * `createToolRegistry()`），测试数由**一次真套件跑**的自报总数产出。
 *
 * 为什么要有这几个槽位（2026-09-25）：两个官网的产品页把「137 命令 · 3473 测试」
 * 当**字面量**写死，没有真源 ⇒ 只能靠人记得去改，同一处**至少手改过 7 次**
 * （2262 → … → 3473），而每次手改本身还会再漂。站点侧的传播链其实一直存在 ——
 * 两站的 deploy 脚本都 `cp` 本文件覆盖自己那份 `src/config/package-info.json`
 * —— 缺的只是**槽位**。名字/版本有槽位所以不漂，计数连槽位都没有。
 *
 * 守卫：`apps/cli/test/integrity/published-counts.test.ts`（三个进程内计数与落盘值
 * 逐一对齐）；测试总数另由 CI 的 Test job 与套件自报的总数比对（硬门禁）。
 */

/** Slash 命令总数（真源：`getCommandNames().length`，`apps/cli/src/ui/commands.ts`） */
export const SLASH_COMMAND_COUNT = 137 as const

/** 内置提供商总数（真源：`DEFAULT_PROVIDERS.length`，`apps/cli/src/shared/constants.ts`） */
export const PROVIDER_COUNT = 12 as const

/** 已注册工具总数（真源：`createToolRegistry().size`，`apps/cli/src/tools/index.ts`） */
export const TOOL_COUNT = 31 as const

/**
 * 测试总数（真源：**一次真套件跑**的自报总数）。
 *
 * 取**总数**而不是 `passed`：本机（macOS）与 CI（Linux）的 passed/skipped 切分**不同**
 * —— `test/e2e/full-pipeline.test.ts` 在 Linux 上整文件 skip、在 macOS 上跑 ——
 * 但**总数相同**（两边都把被 skip 的算进去）。
 */
export const TEST_COUNT = 3506 as const
