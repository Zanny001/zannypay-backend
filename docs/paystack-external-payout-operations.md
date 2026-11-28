# Paystack external payout operations

## Feature flags

Keep both flags disabled until the backend has passed sandbox lifecycle testing and finance/compliance have approved the rollout:

- `PAYSTACK_TRANSFERS_ENABLED=false`
- `PAYSTACK_BALANCE_RECONCILIATION_ENABLED=false`

The reconciliation worker is independently gated by `PAYSTACK_BALANCE_RECONCILIATION_ENABLED` and requires `PAYSTACK_SECRET_KEY`; it can remain enabled for finance review even while new payouts are disabled. It runs hourly and imports a rolling seven-day window so late-arriving balance entries are picked up. The import is duplicate-safe.

## Business-owner OTP approval

Paystack transfer OTP is a merchant/business-owner approval code. It is not a customer authentication code and must never be requested from a ZannyPay customer or placed in the mobile app.

The protected admin endpoint is:

`POST /admin/paystack/transfers/:reference/finalize`

The request body contains `otp` plus the admin step-up field required by the existing `StepUpGuard` (`stepUpCode`). Access is restricted to `SUPER_ADMIN` and `FINANCE_OFFICER`, requires enabled admin 2FA, fresh step-up TOTP, the existing admin IP policy, and is rate-limited to five requests per minute.

The OTP is forwarded directly to Paystack and is not persisted, logged, or returned. The admin audit trail records the approval attempt and whether the result was confirmed, rejected, or uncertain; it stores only the transfer reference, admin identity, outcome and status—not the OTP or step-up code. After submitting it, the service re-queries Paystack before updating ZannyPay transaction state. If the provider result is uncertain, the customer reservation remains pending; never initiate a second payout. Generic admin transaction reversal is blocked for external bank payouts, including pending payouts. A pending payout may be refunded only after a verified terminal failure; once Paystack has confirmed success, only an explicit verified `reversed` status may refund it. Stale or contradictory `failed`, `abandoned`, `blocked` or `rejected` events must never reverse a completed payout.

## Balance-ledger reconciliation

The worker imports provider ledger entries and matches rows whose `model_responsible` is `Transfer` to the exact numeric Paystack transfer ID stored on the ZannyPay transaction. Entries that do not match—including separate fee/levy/stamp-duty movements—remain `unmatched` for finance review.

This process does not post accounting journals, modify customer wallet balances, infer stamp-duty eligibility, or automatically classify unmatched charges. Finance must reconcile those movements against Paystack statements and approve their accounting treatment separately.


## Local validation before sandbox testing

Run these checks from clean feature-branch worktrees. Do not copy production `.env` files into local test runs.

Backend:

```bash
npm ci
npx prisma generate
npm test -- --runInBand
npm run build
npm run lint
```

Admin dashboard:

```bash
corepack enable
yarn install --immutable
yarn lint
yarn typecheck
yarn test --runInBand
yarn build
```

Mobile app:

```bash
npm ci
npm test -- --runInBand
npx expo export --platform android
npx expo export --platform web
```

For the first local pass, keep both payout feature flags set to `false`. Run mocked provider lifecycle tests before connecting any Paystack test credentials. Never paste API secrets, merchant OTPs, customer PINs or step-up codes into chat or terminal transcripts shared for review. When a real sandbox approval is required, enter the merchant OTP only in the protected local admin approval screen.

## Required pre-live validation

1. Use the Paystack test-mode transfer fixture (Zenith Bank account `1000000001`, bank code `057`) to validate account resolution, recipient creation, transfer initiation and final status. Paystack's current getting-started guide says standard test transfers complete immediately.
2. Exercise the OTP-required provider response using the controlled mocked Paystack responses in the backend tests. If Paystack explicitly enables OTP challenges for the test integration, also run the protected admin approval flow end-to-end; do not assume the standard test transfer will produce an OTP.
3. Approve a mocked OTP-pending transfer through the protected admin dashboard/API using a finance/super-admin account with mandatory 2FA and fresh step-up authentication.
4. Verify pending, success, failed, abandoned, blocked, rejected and reversed states through provider fixtures/webhooks and confirm the resulting wallet and ledger movements.
5. Exercise duplicate webhooks, delayed webhooks, network timeouts and repeated status verification.
6. Reconcile principal, `fee_charged`, separate stamp duty and other business-balance movements to the Paystack balance history.
7. Confirm available balance, business transfer approvals and the merchant's applicable fee/tax treatment.
8. Keep live feature flags off until the release has been reviewed and explicitly approved.

No production deployment, production migration, or live money movement is part of this PR.
