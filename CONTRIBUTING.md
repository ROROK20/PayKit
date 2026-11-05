# Contributing to PayKit

Thanks for your interest in contributing to PayKit! This document explains how to
set up the project, run the test suite, and submit changes. PayKit is payments
infrastructure, so correctness and test coverage matter — please read this guide
before opening a pull request.

By participating in this project you agree to abide by our
[Code of Conduct](CODE_OF_CONDUCT.md).

## Prerequisites

- **Node.js 18+** (the CI matrix runs on Node 18 and 20)
- **npm** (ships with Node; the repo uses a committed `package-lock.json`)
- The frontend playground also requires **Node.js 18+**

Check your version:

```bash
node --version   # should be >= 18
```

## Getting Started

Clone the repo and install dependencies:

```bash
git clone https://github.com/ROROK20/PayKit.git
cd PayKit
npm install
```

Build the SDK to confirm your toolchain works:

```bash
npm run build      # bundles src/index.ts to dist/ (cjs + esm + .d.ts) via tsup
```

## Running the Test Suite

PayKit uses Jest (via `ts-jest`). The suite runs entirely in-memory using the
built-in `MockProvider` — no network access or real credentials required.

```bash
npm test                 # run all tests
npm run test:coverage    # run with coverage report
```

Coverage thresholds are enforced in `package.json` (70% branches, 80% functions,
80% lines). New code should keep coverage at or above these thresholds.

## Linting & Type Checking

```bash
npm run lint        # ESLint over src/ and tests/
npm run typecheck   # tsc --noEmit (strict type checking, no emit)
```

Both must pass before a PR can be merged. CI runs them, the test suite with coverage,
the built-package test and the frontend lint and build on every push to `main` or
`develop` and every pull request to `main`.

## Running the Web Demo / Frontend

The `frontend/` directory contains a Next.js 15 playground that demonstrates the
SDK interactively (payments, webhooks, fraud scoring) entirely in the browser.
It links the SDK as `file:..`, so install the root first (npm runs the SDK's
build through that link, and needs its toolchain):

```bash
npm install        # from the repo root, if you have not already
cd frontend
npm install
npm run dev
# open http://localhost:3005
```

To produce a production build of the frontend:

```bash
cd frontend
npm run build
```

## Running the Examples

The `examples/` directory contains runnable TypeScript demos:

```bash
npm run example   # bundles examples/basic_payment.ts with tsup, runs it with node
```

## Code Style

- **TypeScript, strict mode.** No `any` in public APIs; prefer the shared types
  in `src/types/index.ts`.
- Follow the existing formatting (2-space indentation, double quotes, trailing
  commas in multiline literals). Run `npm run lint` before committing.
- Keep modules small and focused — one concern per file under `src/`.
- Add or update JSDoc on exported classes and methods. Public APIs in PayKit are
  documented with `@example` blocks; please keep that convention.
- Every behavioral change must ship with tests under `tests/`.

## Branch & Pull Request Workflow

1. Fork the repository and create a feature branch off `main`:
   ```bash
   git checkout -b feat/short-description
   ```
2. Make your change, including tests and docs.
3. Run the full local check before pushing:
   ```bash
   npm run lint && npm run typecheck && npm run test:coverage && npm run build
   ```
4. Push your branch and open a pull request against `main`.
5. Fill out the pull request template, link any related issue, and make sure CI
   is green.

Keep pull requests focused — one logical change per PR is much easier to review.

## Commit Message Convention

PayKit follows [Conventional Commits](https://www.conventionalcommits.org/).
Format your commit subjects as `<type>(optional scope): <description>`:

| Type       | Use for                                          |
| ---------- | ------------------------------------------------ |
| `feat`     | A new feature                                    |
| `fix`      | A bug fix                                         |
| `docs`     | Documentation only changes                       |
| `test`     | Adding or updating tests                         |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `perf`     | A performance improvement                        |
| `chore`    | Tooling, build, or maintenance changes           |
| `ci`       | CI configuration changes                         |

Examples:

```
feat(webhooks): add Plaid signature verification
fix(idempotency): expire keys on TTL boundary
docs(readme): clarify Redis store example
```

## Reporting Bugs & Requesting Features

Use the [issue templates](.github/ISSUE_TEMPLATE/) when opening an issue. For
**security vulnerabilities**, do **not** open a public issue — follow the process
in [SECURITY.md](SECURITY.md) instead.

Thank you for contributing! 🙌
