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

The OTP is forwarded directly to Paystack and is not persisted, logged, or returned. The admin audit trail records the approval attempt and whether the result was confirmed, rejected, or uncertain; it stores only the transfer reference, admin identity, outcome and status—not the OTP or step-up code. After submitting it, the service re-queries Paystack before updating ZannyPay transaction state. If the provider result is uncertain, the customer reservation remains pending; never initiate a second payout. Generic admin transaction reversal is blocked for external bank payouts, including pending payouts; only verified Paystack terminal failure/reversal handling may release the reservation.

## Balance-ledger reconciliation

The worker imports provider ledger entries and matches rows whose `model_responsible` is `Transfer` to the exact numeric Paystack transfer ID stored on the ZannyPay transaction. Entries that do not match—including separate fee/levy/stamp-duty movements—remain `unmatched` for finance review.

This process does not post accounting journals, modify customer wallet balances, infer stamp-duty eligibility, or automatically classify unmatched charges. Finance must reconcile those movements against Paystack statements and approve their accounting treatment separately.

## Required pre-live validation

1. Run Paystack test-mode transfer initiation with OTP required.
2. Approve through the protected admin endpoint using a finance/super-admin account with 2FA and step-up authentication.
3. Verify pending, success, failed, abandoned, blocked, rejected and reversed states.
4. Exercise duplicate webhooks, delayed webhooks, network timeouts and repeated status verification.
5. Reconcile principal, `fee_charged`, separate stamp duty and other business-balance movements to the Paystack balance history.
6. Confirm available balance, business transfer approvals and the merchant's applicable fee/tax treatment.
7. Keep live feature flags off until the release has been reviewed and explicitly approved.

No production deployment, production migration, or live money movement is part of this PR.
