import { exec } from 'node:child_process'

export interface GitPr {
  number: number
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  isDraft: boolean
  reviewDecision: string
}

export type PrColor = 'white' | 'green' | 'yellow' | 'magenta' | 'gray'

/** Parse `gh pr list --json number,state,isDraft,reviewDecision` output into the first PR.
 *  Bad input / empty list / missing number → null. */
export function parseGitPr(json: string): GitPr | null {
  try {
    const arr = JSON.parse(json)
    if (!Array.isArray(arr) || arr.length === 0) return null
    const first = arr[0]
    if (!first || typeof first.number !== 'number') return null
    return {
      number: first.number,
      state: first.state ?? 'OPEN',
      isDraft: Boolean(first.isDraft),
      reviewDecision: first.reviewDecision ?? '',
    }
  } catch {
    return null
  }
}

/** Map PR state to an Ink color — mirrors Claude Code's status-line PR badge:
 *  merged → magenta, closed/draft → gray, approved → green, changes-requested → yellow,
 *  otherwise (open, no review) → white. */
export function prColor(pr: GitPr): PrColor {
  if (pr.state === 'MERGED') return 'magenta'
  if (pr.state === 'CLOSED' || pr.isDraft) return 'gray'
  if (pr.reviewDecision === 'APPROVED') return 'green'
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'yellow'
  return 'white'
}

/** Detect the PR whose head is `branch`. gh unavailable / no PR / non-zero exit → null.
 *  Async so the status line never blocks startup. */
export function resolveGitPr(branch: string): Promise<GitPr | null> {
  return new Promise((resolve) => {
    const cmd = `gh pr list --head "${branch}" --state all --json number,state,isDraft,reviewDecision`
    exec(cmd, { timeout: 3000 }, (err, stdout) => {
      resolve(err ? null : parseGitPr(stdout))
    })
  })
}
