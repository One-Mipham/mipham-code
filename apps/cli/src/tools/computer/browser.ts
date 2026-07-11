let browserPromise: Promise<unknown> | null = null

async function getPage(): Promise<unknown> {
  if (!browserPromise) {
    // Dynamic import — Playwright is optional
    let playwrightModule: { chromium: unknown }
    try {
      playwrightModule = await import('playwright')
    } catch {
      throw new Error('Playwright is not installed. Install it with: npm install playwright')
    }
    const { chromium } = playwrightModule as {
      chromium: {
        launch: (opts?: Record<string, unknown>) => Promise<{
          newPage: () => Promise<unknown>
        }>
      }
    }
    const browser = await chromium.launch({ headless: false })
    browserPromise = browser.newPage()
  }
  return browserPromise
}

export async function browserNavigate(url: string): Promise<string> {
  const page = (await getPage()) as {
    goto: (u: string) => Promise<void>
    url: () => string
  }
  await page.goto(url)
  return `Navigated to: ${page.url()}`
}

export async function browserSnapshot(): Promise<string> {
  const page = (await getPage()) as {
    accessibility: { snapshot: () => Promise<unknown> }
  }
  const snapshot = await page.accessibility.snapshot()
  return JSON.stringify(snapshot, null, 2)
}

export async function browserClick(uid: string): Promise<string> {
  const page = (await getPage()) as {
    locator: (s: string) => { click: () => Promise<void> }
  }
  await page.locator(`[uid="${uid}"]`).click()
  return `Clicked: ${uid}`
}
