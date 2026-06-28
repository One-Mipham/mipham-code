---
name: github-ops
description: GitHub operations — PRs, issues, releases, CI/CD monitoring, branch management via gh CLI and git
version: 2.0.0
---

# GitHub Operations

Manage GitHub workflows using `git` and `gh` CLI.

## Commit Convention

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): description

Types: feat, fix, chore, docs, test, refactor, ci, perf, style, revert
```

Co-author AI contributions:
```
Co-Authored-By: Claude <noreply@anthropic.com>
```

## Pull Requests

### Create PR

```bash
gh pr create --title "feat: add feature X" --body "## Summary\n\n..." --base main
```

### PR Body Template

```markdown
## Summary
Brief description of changes

## Type
- [ ] feat  [ ] fix  [ ] chore  [ ] docs  [ ] refactor

## Testing
- [ ] Unit tests pass
- [ ] Manual verification performed

## Checklist
- [ ] Conventional Commits
- [ ] No unrelated changes
```

### Review & Merge

```bash
gh pr review <number> --approve
gh pr merge <number> --squash --delete-branch
```

## Issues

### Create Issue

```bash
gh issue create --title "bug: description" --body "## Steps\n1.\n\n## Expected\n\n## Actual\n" --label bug
```

### Label Taxonomy

| Label | Usage |
|-------|-------|
| `bug` | Confirmed defect |
| `enhancement` | Feature request |
| `docs` | Documentation |
| `good first issue` | Beginner-friendly |
| `help wanted` | Open to community |

## Releases

```bash
git tag -a v1.0.0 -m "Release v1.0.0"
git push origin v1.0.0
gh release create v1.0.0 --title "v1.0.0" --notes-file CHANGELOG.md
```

## CI Monitoring

```bash
gh run list --limit 5          # recent runs
gh run watch <run-id>           # follow live
gh run view <run-id> --log      # view logs
```

## Branch Management

- Feature branches: `feat/<name>` from `main`
- Bugfix branches: `fix/<name>` from `main`
- Release branches: `release/vX.Y.Z`
- Delete merged branches: `git branch -d <name>`
