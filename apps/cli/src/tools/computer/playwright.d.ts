declare module 'playwright' {
  export const chromium: {
    launch: (opts?: Record<string, unknown>) => Promise<{
      newPage: () => Promise<unknown>
    }>
  }
}
