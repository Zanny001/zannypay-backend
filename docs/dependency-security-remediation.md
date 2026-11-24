# Dependency security remediation

This branch upgrades the direct bcrypt and Nodemailer dependencies and refreshes the npm lockfile using the repository's non-forced `npm audit fix` workflow. The workflow must complete `npm ci`, the full Jest suite, the NestJS build, formatting, and ESLint before its generated lockfile is considered ready for review. No dependency changes are applied to `main` until the pull request is approved and merged.
