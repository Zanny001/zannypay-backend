# ZannyPay Paystack payout local validation

This runbook is for local development and Paystack test mode only. It does not authorize production deployment, live transfers, production migrations, or enabling payout flags in Render.

## Safety setup

- Use a dedicated local/test database and Paystack **test** secret key only.
- Never paste API keys, passwords, customer PINs, TOTP codes, recovery codes, or Paystack business OTPs into chat, terminal transcripts, test fixtures, screenshots, or Git.
- Keep `PAYSTACK_TRANSFERS_ENABLED=false` and `PAYSTACK_BALANCE_RECONCILIATION_ENABLED=false` until the relevant test stage explicitly requires them in a disposable local environment.
- Do not point local code at production Supabase or a live Paystack secret.
- Copy `.env.example` to `.env`, then generate fresh local-only values for `JWT_SECRET`, `ADMIN_JWT_SECRET`, `ADMIN_BOOTSTRAP_SECRET`, `ADMIN_2FA_ENCRYPTION_KEY`, and `CUSTOMER_PII_ENCRYPTION_KEY`. The admin 2FA and customer PII encryption keys must be different. Generate 32-byte random values locally (for the two encryption keys, use 64 hex characters); never commit the generated `.env`.
- The example file previously contained static sample admin secrets. They have now been replaced with placeholders. If any of those old sample values were ever used in a real environment, rotate the affected secret/key there through the approved secret-management process; changing the example file does not erase Git history.
- Use a non-production admin account with mandatory 2FA for protected approval testing. Enter any provider OTP directly into the local protected admin form; do not share it.
- The standard Paystack test transfer may complete immediately and may not trigger a business OTP. OTP approval is therefore covered by controlled provider mocks unless Paystack explicitly enables the challenge for the test integration.

## 1. Backend

From the backend repository root:

```bash
npm ci
npx prisma generate
npm test -- --runInBand
npm run build
npm run lint
```

The automated suite covers payout idempotency, provider amount/currency/fee validation, pending and terminal states, wallet refunds, ledger journals, duplicate success notifications, stale failure notifications after success, and protected business-OTP finalization.

Optional isolated database/E2E checks (only after configuring a disposable local test database):

```bash
npx prisma migrate status
npm run test:e2e -- --runInBand
```

Do not run `prisma migrate deploy` against any shared or production database as part of local testing.

## 2. Admin dashboard

From the admin repository root:

```bash
corepack enable
yarn install --frozen-lockfile
yarn lint
yarn typecheck
yarn test --ci
ADMIN_API_BASE_URL=http://localhost:10000/api/v1 yarn build
```

Run the backend locally before exercising the UI. Confirm that the approval action is visible only for a pending external bank transfer whose provider status is `otp`, and only to an authorized finance/super-admin with mandatory 2FA enabled. Confirm the modal clears both entered codes after success and failure.

## 3. Mobile app

From the mobile repository root:

```bash
npm install
npm test -- --runInBand
npx expo export --platform android
npx expo export --platform web
```

Point the local app only at the local backend or a dedicated test backend. For an Android phone on the same Wi-Fi, set `EXPO_PUBLIC_API_URL=http://<your-computer-LAN-IP>:10000/api/v1` when starting Expo (use the computer's LAN IP, not `localhost`, because localhost on the phone refers to the phone itself). For an emulator, use the emulator's host-loopback address as appropriate for that emulator. Confirm that an unresolved attempt retains the same idempotency key after a timeout/restart, a different transfer cannot overwrite it, and a definitive rejection clears it. Confirm the customer app never requests or stores the merchant/business OTP.

## 4. Paystack sandbox lifecycle

Only after all automated checks pass, and only with a dedicated Paystack test integration:

1. Confirm test-mode bank directory and account resolution.
2. Use Paystack's documented test recipient/account fixture and confirm the resolved account name.
3. Initiate one small test transfer with a unique idempotency key.
4. Confirm pending response handling, transaction reference persistence, and no second payout on retry.
5. Verify final success and compare principal, provider fee, and provider balance-history rows.
6. Exercise definitive failure and reversal scenarios using provider fixtures/webhooks; verify wallet and ledger changes exactly once.
7. Deliver duplicate and delayed webhooks; confirm no duplicate debit, credit, refund, or journal.
8. Exercise network timeout and status re-query behavior.
9. Exercise the OTP flow with controlled mocks. If the test integration supports a real OTP challenge, approve only through the local protected admin UI with a non-production admin account.
10. Import test balance history and reconcile unmatched levies/stamp-duty rows manually. No automatic wallet adjustment is expected.

Record test references and redacted outcomes only. Never record credentials or OTPs.

## 5. Release gates

Do not enable either feature flag or deploy until:

- Backend, admin, and mobile local checks pass.
- Paystack sandbox lifecycle and webhook signature tests pass.
- Finance reconciles provider fees, levies, stamp duty, and business-balance movements.
- Business transfer permissions, funding float, limits, and compliance controls are confirmed.
- The three related pull requests have been reviewed and explicitly approved for merge/deployment.

A green CI run validates code and automated tests; it is not evidence that a real Paystack sandbox transfer or production payout has been completed.
