# ZannyPay Admin Backend — Security & Fraud Engine Additions

This documents everything added on top of the existing admin backend
(admin-auth + admin modules): TOTP 2FA, admin IP allowlisting, an automated
fraud/velocity rule engine, revocable admin sessions, and brute-force
lockout. Read this before deploying.

## 1. Setup

```bash
yarn install                 # pulls in the two new deps: otplib, qrcode
```

Add the new variables from `.env.example` to your real `.env` — at minimum
`ADMIN_2FA_ENCRYPTION_KEY` is now **required** (2FA setup will throw at
runtime without it). `ADMIN_JWT_SECRET` and `ADMIN_BOOTSTRAP_SECRET` should
already be set from the previous admin-backend delivery; rotate them if you
haven't yet, using the generator commands in `.env.example`.

```bash
npx prisma migrate deploy    # applies prisma/migrations/20260728120000_*
npx prisma generate
yarn start:dev
```

Then, if you haven't already bootstrapped your first SuperAdmin:

```bash
curl -X POST http://localhost:3000/api/v1/admin-auth/bootstrap \
  -H "Content-Type: application/json" \
  -d '{"bootstrapSecret":"...","name":"...","email":"...","password":"..."}'
```

## 2. Two-factor authentication (TOTP)

Flow for an admin turning 2FA on for their own account (all require a
normal authenticated session — `Authorization: Bearer <access_token>`):

1. `POST /admin-auth/2fa/setup` → `{ secret, qrCodeDataUrl }`. Scan the QR
   in Google Authenticator / Authy / 1Password, or type `secret` in
   manually. Not yet enabled at this point.
2. `POST /admin-auth/2fa/enable` with `{ "code": "123456" }` from the app →
   `{ recoveryCodes: [...] }`. **Recovery codes are shown exactly once** —
   store them somewhere safe. 2FA is now enforced on this account.

Login flow once 2FA is on:

1. `POST /admin-auth/login` with email/password → `{ twoFactorRequired: true, mfaToken }` instead of an access token.
2. `POST /admin-auth/2fa/verify` with `{ mfaToken, code }` (TOTP code, or one of the recovery codes) → the real `{ access_token, admin }`.

Other endpoints: `POST /admin-auth/2fa/disable` (`{ password, code }`),
`POST /admin-auth/2fa/recovery-codes/regenerate` (`{ code }`).

**Not included:** an org-wide "2FA is mandatory for everyone" switch — it's
currently opt-in per admin. If you want it mandatory (recommended for
SUPER_ADMIN/FINANCE_OFFICER/COMPLIANCE_OFFICER at minimum), the natural
place to add that check is in `AdminJwtStrategy.validate()` or a small
guard, refusing full-session tokens for those roles until
`twoFactorEnabled` is true.

## 3. Admin sessions (revocable JWTs)

Every login creates an `AdminSession` row (`jti`, IP, user agent,
expiry). `AdminJwtStrategy` checks this table on every request, so:

- `GET /admin-auth/sessions` — list your own active sessions.
- `DELETE /admin-auth/sessions/:id` — revoke one (e.g. a lost laptop).
- `POST /admin-auth/logout` — revoke the current session.

This is what makes "log out" and "revoke a compromised session" actually
work immediately, instead of waiting out the JWT's 8-hour natural expiry.

**Not included:** a SUPER_ADMIN endpoint to revoke *another* admin's
sessions (e.g. immediately kicking out an offboarded employee rather than
just deactivating their account, which the existing `deactivateAdmin` +
`isActive` check already handles on the next request). Worth adding if
instant forced-logout (not just next-request-blocked) matters to you.

## 4. Admin IP allowlisting

Off by default. Two additive sources of allowed IPs/CIDRs:
`ADMIN_IP_ALLOWLIST` (env, comma-separated) and rows in
`AdminIpAllowlistEntry` (managed via `/admin/security/ip-allowlist`,
SUPER_ADMIN only).

Set `ADMIN_IP_ALLOWLIST_ENFORCE=true` to turn it on. **This fails closed**:
if enforcement is on and the combined list is empty, every admin request
is rejected with a clear error rather than silently allowing everyone
through. Keep at least one trusted range in the list at all times —
there's a real chicken-and-egg risk (see the guard's own comments) where
locking yourself out means you can only fix it via the env var + redeploy,
not via the API.

This requires `app.set('trust proxy', 1)` (added to `main.ts`) to see the
real client IP behind your load balancer — re-check that number if your
infra adds more than one proxy hop.

## 5. Fraud / velocity engine

Six rules ship enabled by default (seeded automatically on first boot into
the `FraudRule` table): `VELOCITY_COUNT`, `VELOCITY_AMOUNT`,
`LARGE_SINGLE_TRANSACTION`, `NEW_RECIPIENT_LARGE_TRANSFER`,
`STRUCTURING_PATTERN`, `RAPID_FUND_AND_DRAIN`. See `fraud.service.ts` for
exact logic and default thresholds.

Runs automatically after `transferFunds`, `payBill`, `buyAirtime`, and
wallet-funding transactions commit — never blocks or delays the customer's
transaction itself. A rule firing: flags the transaction, creates a
`FraudAlert`, logs an audit entry, optionally auto-freezes the account
(only `STRUCTURING_PATTERN` and `RAPID_FUND_AND_DRAIN` do this by
default), and emails `COMPLIANCE_ALERT_EMAIL` for HIGH/CRITICAL severity.

Admin-facing:
- `GET /admin/fraud/alerts` (SUPER_ADMIN, COMPLIANCE_OFFICER, FINANCE_OFFICER)
- `PATCH /admin/fraud/alerts/:id` — `{ decision: "confirmed"|"dismissed", note?, unfreezeIfDismissed? }`
- `GET /admin/fraud/rules` (+ FINANCE_OFFICER excluded — view is SUPER_ADMIN/COMPLIANCE_OFFICER)
- `PATCH /admin/fraud/rules/:id` — SUPER_ADMIN only — tune `config`, `severity`, `isEnabled`, `autoFreeze` per rule, no redeploy needed.

**Honest limitation:** this is 6 concretely implemented strategies with
tunable thresholds, not a generic rules DSL — you can't invent an entirely
new detection strategy through the API, only tune the ones that exist.
Also not included: device/session fingerprinting (there's no device model
in the schema yet), IP-based anomaly detection on customer logins (this
engine only looks at transaction patterns), and sanctions/PEP list
screening — all real components of a mature AML program that would need
their own data sources.

## 6. Brute-force lockout

5 failed password attempts locks an admin account for 15 minutes
(`failedLoginAttempts` / `lockedUntil` on `AdminUser`). Resets on a
successful password check. Not currently configurable via env var — the
constants live at the top of `admin-auth.service.ts` if you want different
numbers.

## 7. Still not "globally acceptable" without more work

Carried over from the original delivery, still true:

- **No admin web dashboard was skipped this round** — see the companion
  `zannypay-admin-dashboard` Next.js app.
- **Real-time device/session fingerprinting** for the fraud engine.
- **Sanctions/PEP screening integration** (a real compliance program needs
  a data provider for this — Refinitiv World-Check, ComplyAdvantage, etc.
  — this is a paid third-party integration, not something to fabricate).
- **SIEM/central log shipping** — audit logs and fraud alerts currently
  live only in Postgres; a mature setup ships these to a separate
  log-aggregation system too, so a compromised app server can't also erase
  its own trail.
- **Per-role granular rate limits** — the existing `ThrottlerModule` is
  global (20 req/60s per IP for the whole API); admin login specifically
  could warrant its own, stricter limit independent of IP-based lockout.
- **Formal penetration test** before handling real customer money at
  scale — nothing above is a substitute for one.
