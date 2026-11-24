# Zannypay World-Class Engineering Audit
Audit date: 2026-11-24

## Scope and limitations
This is a source-level review of the supplied mobile v19 Ultra, admin v10 Ultra, and backend v21 Ultra archives, compared with the connected GitHub repositories. It is not a penetration test, production deployment verification, payment certification, or proof of regulatory compliance.

## Confirmed high-priority findings in the supplied archives
- Mobile `src/services/SyncEngine.js`: queue writes require serialized read/modify/write operations to prevent concurrent enqueue/cancel operations from overwriting one another. The supplied archive includes a mutation queue and concurrent-enqueue regression test.
- Mobile certificate pinning: the supplied package makes pinning optional and can fail open when native support or pins are missing. Production TLS pinning is not established by source configuration alone; integrate native support, validate primary and backup SPKI pins, and fail closed according to a tested production policy.
- Mobile virtual cards, developer console, and rewards: the supplied README/source describe demo or illustrative functionality and local rewards state. These must not be represented as issued card products, production developer tooling, or authoritative server-side rewards.
- Backend key rotation: the supplied archive's paginated rotation sweep must enforce cursor progress to avoid a non-terminating maintenance run. The supplied archive adds a strict progress check and regression test.
- Backend KYC and sanctions: the supplied modules wire mock providers; the mock KYC provider returns a passing liveness result. Production onboarding requires real contracted providers and documented manual-review handling.
- Backend card issuing: the supplied module wires a mock card issuer. No production card-issuing adapter is established by this package.
- Backend storage and OTP: the supplied environment example includes local storage and mock/rollout settings. Production startup must reject mock providers, ephemeral local storage, missing secure secrets, and disabled mandatory OTP policy.
- Admin: the BFF keeps the bearer token server-side in an httpOnly cookie; backend authorization remains the security boundary. E2E coverage is still required for login, 2FA, session revocation, role boundaries, privileged actions, reversals, exports, CSRF, and proxy allowlisting.

## Required production-readiness work
### Backend
1. Integrate licensed payment rails for funding, transfers, bills, refunds, reversals, settlement and reconciliation.
2. Verify webhook signatures, timestamps, replay protection, idempotency and settlement-file reconciliation.
3. Replace mock KYC/liveness, sanctions/PEP and card-issuing providers with real contracted integrations.
4. Prove double-entry ledger invariants, atomic posting, dispute/chargeback lifecycle, reversals and daily reconciliation.
5. Enforce production configuration at startup: no mock providers, no local ephemeral storage, mandatory OTP, strict CORS, rate-limit storage and managed secrets.
6. Complete independent penetration testing, threat modelling, incident response, backup/restore, disaster recovery and key-rotation drills.

### Mobile
1. Validate native TLS pinning with primary and backup keys and a tested certificate-rotation plan.
2. Verify secure storage, screenshot/app-switcher protection, deep-link validation, device integrity policy, privacy-safe analytics and remote session revocation.
3. Prove idempotent money movement across timeouts, offline replay, app restarts and webhook races.
4. Replace or clearly gate demo cards, local rewards and illustrative developer tooling.
5. Add device-matrix, accessibility, release-signing, SBOM and OTA-governance checks.

### Admin
1. Add E2E tests for authentication, TOTP/recovery, session revocation, role checks, step-up authentication, KYC decisions, fraud actions, reversals and exports.
2. Test CSRF, cookie attributes, proxy destination allowlisting, request timeouts and security headers.
3. Add operational views for failed actions, stale data, API latency and audit-log delivery.

## Standards baseline for external verification
- OWASP ASVS 5.0 for web/API verification.
- OWASP MASVS for mobile storage, cryptography, authentication, network, platform, code, resilience and privacy.
- OWASP API Security Top 10 (2023).
- Applicable CBN Nigeria payment-system, mobile-money, data-protection and partner-bank requirements; confirm applicability with licensed partners and qualified counsel.

## Validation status
The supplied archives were statically inspected. The local audit copies contain the mobile queue-concurrency fix and backend pagination-progress fix. Dependency installation timed out in the audit environment; therefore Jest, lint, typecheck, integration/E2E tests and production builds are not claimed as passing. The full source archives are not yet mirrored wholesale into GitHub; this branch stages targeted engineering changes and this audit report for review.
