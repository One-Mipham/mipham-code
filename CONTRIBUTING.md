# Contributing to Mipham Code

Thank you for your interest in contributing to Mipham Code!

## Code of Conduct

Please read our [Code of Conduct](./CODE_OF_CONDUCT.md) before contributing.

## Development Process

1. **Fork** the repository
2. **Create a feature branch**: `git checkout -b feat/your-feature`
3. **Make your changes**: Follow the Conventional Commits specification
4. **Run tests and linting**: `pnpm typecheck && pnpm lint && pnpm test`
5. **Submit a Pull Request** to the `master` branch

## Commit Convention

We follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` — New feature
- `fix:` — Bug fix
- `chore:` — Maintenance
- `docs:` — Documentation
- `test:` — Tests
- `refactor:` — Code restructuring
- `ci:` — CI/CD changes
- `perf:` — Performance improvements

## Code Style

- TypeScript strict mode
- ESM modules only
- Prettier for formatting (no semicolons, single quotes)
- ESLint for linting
- Run `pnpm format` and `pnpm lint` before committing

## Testing

- Write tests for new features
- Ensure existing tests pass
- Use Vitest for unit and integration tests

## Pull Request Process

1. Ensure CI checks pass (typecheck, lint, format, build, test)
2. Update documentation if needed
3. Add a changelog entry if applicable
4. Request review from a maintainer

## Security

See [SECURITY.md](./SECURITY.md) for our security policy and reporting process.
