// Fixture for ../lint-rules.test.ts. Deliberately excluded from the repo-wide
// `eslint .` run (see the `test/integrity/fixtures/**` entry in eslint.config.js),
// because `eslint .` must stay green while this file must not pass.
//
// The floating call at the bottom is the thing under test: `returnsPromise()`
// produces a Promise that is never awaited, chained, or marked `void`.

async function returnsPromise(): Promise<number> {
  return 1
}

returnsPromise()
