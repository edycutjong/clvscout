# Security Policy

## Supported Versions
| Version | Supported |
|---|---|
| latest (`main`) | ✅ |

## Reporting a Vulnerability
Please **do not** open a public issue for security vulnerabilities. Instead,
report them privately:

- Email **edy.cu@live.com**, or
- Use GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) (Security → Report a vulnerability).

You'll get an acknowledgment within 48 hours and a resolution timeline after
triage. Please give us a reasonable window to patch before public disclosure.

## Scope notes specific to this service
- `OKX_API_KEY` / `OKX_SECRET_KEY` / `OKX_PASSPHRASE` are Facilitator
  credentials — never commit real values (`.env` is git-ignored; only
  `.env.example` is tracked).
- Payment verification (`api/rails/okx.ts`) does real EIP-3009/EIP-712
  signature checks offline via `viem`; report any bypass of that check as a
  critical finding.
- Known non-blocking issue: `vitest`'s transitive dev-dependency chain
  (`esbuild`/`vite`) currently reports moderate/high/critical advisories in
  `npm audit`. These are dev-only (test runner), not shipped in the running
  service, and are tracked via Dependabot rather than force-upgraded
  mid-hackathon to avoid destabilizing the test suite.
