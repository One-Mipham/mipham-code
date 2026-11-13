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
  // `uid` goes inside a CSS attribute selector. A quote — or an escape that
  // decodes to one — closes the string early and hands the rest of the value to
  // Playwright's selector parser as new CSS, which is a model-supplied value
  // reaching a different layer than the page node it names. Every uid we emit is
  // alphanumeric, so anything else is a respelling error: say what shape is
  // expected rather than trying to escape it.
  if (!/^[A-Za-z0-9_-]+$/.test(uid)) {
    throw new Error(
      `Invalid element uid ${JSON.stringify(uid)}: expected a plain element id ` +
        '([A-Za-z0-9_-]), not a JSON string or an escaped selector. ' +
        'Take the uid from browser_snapshot and pass it unquoted.',
    )
  }
  const page = (await getPage()) as {
    locator: (s: string) => { click: () => Promise<void> }
  }
  await page.locator(`[uid="${uid}"]`).click()
  return `Clicked: ${uid}`
}
