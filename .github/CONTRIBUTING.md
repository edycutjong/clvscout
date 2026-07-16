# Contributing

Thanks for your interest in improving CLV Scout!

## Getting Started
1. Fork the repo and branch from `main`: `git checkout -b feat/your-feature`
2. Install dependencies: `npm install`
3. Copy the env template: `cp .env.example .env`
4. Regenerate fixtures + run the API: `npm run gen-line-history && npm run settle && npm run dev`

## Before You Open a PR
- `npm run ci` passes (typecheck + vitest).
- `npm run test:coverage` — check coverage didn't regress on touched files.
- `npm run readiness` passes (boots an ephemeral instance and re-runs the
  listing self-check: 402 shape on both paid routes, 405 on GET, free
  endpoints 200, truth-table sums OK).
- Add or update tests for any behavior change — especially anything that
  touches the UNGRADED honesty path (`engine/grader.ts`) or the Sharp Score
  recompute invariant (`engine/dossier.ts`). Never add a synthetic-close
  fallback; a missing line-history entry must stay `UNGRADED`.
- Keep commits conventional (`feat:`, `fix:`, `docs:`, `chore:`).

## Reporting Bugs / Requesting Features
Open an issue using the provided templates. Include repro steps, expected vs.
actual behavior, and environment details.
