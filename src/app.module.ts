import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { MailerModule } from '@nestjs-modules/mailer';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { PrismaModule } from './prisma/prisma.module';
import { TransactionsModule } from './transactions/transactions.module';
import { UserModule } from './user/user.module';
import { SavingsModule } from './savings/savings.module';
import { LoansModule } from './loans/loans.module';
import { CardsModule } from './cards/cards.module';       // <-- NEW
import { InvoicesModule } from './invoices/invoices.module'; // <-- NEW
import { BudgetsModule } from './budgets/budgets.module'; // <-- NEW
import { DisputesModule } from './disputes/disputes.module'; // <-- NEW
import { ReferralsModule } from './referrals/referrals.module'; // <-- NEW
import { AdminAuthModule } from './admin-auth/admin-auth.module'; // <-- ADMIN BACKEND
import { AdminModule } from './admin/admin.module'; // <-- ADMIN BACKEND
import { AuditLogModule } from './audit-log/audit-log.module'; // <-- ADMIN BACKEND: shared, global audit log
import { NotificationsModule } from './notifications/notifications.module'; // <-- NEW: real backend-driven notifications
import { SupportModule } from './support/support.module'; // <-- NEW: customer support chat
import { BusinessModule } from './business/business.module'; // <-- ZannyPay Business, Phase 1
import { RecurringTransfersModule } from './recurring-transfers/recurring-transfers.module'; // <-- ZannyPay Business, Phase 3
import { StorageModule } from './storage/storage.module'; // <-- WORLD-CLASS UPGRADE: object storage, replaces base64-in-Postgres
import { PushModule } from './push/push.module'; // <-- WORLD-CLASS UPGRADE: push notifications
import { BeneficiariesModule } from './beneficiaries/beneficiaries.module'; // <-- WORLD-CLASS UPGRADE: backend-persisted saved recipients
import { AdminNotesModule } from './admin-notes/admin-notes.module'; // <-- WORLD-CLASS UPGRADE: internal admin collaboration layer
import { KycModule } from './kyc/kyc.module'; // <-- WORLD-CLASS UPGRADE: document/liveness capture
import { ComplianceExportModule } from './compliance-export/compliance-export.module'; // <-- WORLD-CLASS UPGRADE: KYC decision record PDF
import { LedgerModule } from './ledger/ledger.module'; // <-- WORLD-CLASS UPGRADE: double-entry ledger + reconciliation
import { AnalyticsModule } from './analytics/analytics.module'; // <-- WORLD-CLASS UPGRADE: event tracking

@Module({
  imports: [
    AuthModule,
    PrismaModule,
    StorageModule, // @Global — provides StorageService to UserModule/SupportModule/AdminAuthModule
    PushModule,    // @Global — provides PushService to NotificationsModule
    LedgerModule,  // @Global — provides LedgerService/ReconciliationService to TransactionsModule, AdminModule, SavingsModule, LoansModule, RecurringTransfersModule
    AnalyticsModule, // @Global — provides AnalyticsService to AuthModule, AdminModule, TransactionsModule, SavingsModule, CardsModule, LoansModule, SupportModule
    AuditLogModule, // @Global — registers AuditLogService once for admin-auth, admin, fraud, admin-security
    NotificationsModule, // @Global — registers NotificationsService once for admin, fraud, support, transactions
    ScheduleModule.forRoot(), // <-- powers RecurringTransfersService's @Cron job
    TransactionsModule,
    UserModule,
    // Master audit, High-priority #4: "Rate limiting is one global bucket
    // (20 req/60s per IP). Login, OTP, and PIN-check endpoints share a
    // ceiling with read-only endpoints like GET /wallet/balance — exactly
    // the endpoints brute-force attempts target deserve their own
    // stricter, independent limits."
    //
    // One named throttler ('default', unchanged 20/60s ceiling for the
    // bulk of the API) rather than several stacked ones — @nestjs/throttler
    // checks EVERY configured named throttler on EVERY route by default,
    // so multiple named throttlers in forRoot() means multiple *stacked*
    // limits per request (a burst limit AND a sustained limit both
    // applying together), not "pick one bucket per route". What we
    // actually want here — auth/PIN/KYC-reveal routes getting a *stricter*
    // ceiling than everything else, with no change elsewhere — is exactly
    // what @Throttle({ default: { limit, ttl } }) does per-route: it
    // overrides the 'default' throttler's config for that specific
    // handler only. See auth.controller.ts, admin-auth.controller.ts, and
    // user.controller.ts for where that's applied.
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60000, limit: 20 }]),
    // Global Email Engine
    MailerModule.forRoot({
      transport: {
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: Number(process.env.SMTP_PORT) || 587,
        secure: false,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      },
      defaults: {
        from: '"ZannyPay Alerts" <noreply@zannypay.com>',
      },
    }),
    SavingsModule,
    LoansModule,
    CardsModule,     // <-- NEW
    InvoicesModule,  // <-- NEW
    BudgetsModule,   // <-- NEW
    DisputesModule,  // <-- NEW
    ReferralsModule, // <-- NEW
    AdminAuthModule, // <-- ADMIN BACKEND
    AdminModule,     // <-- ADMIN BACKEND
    SupportModule,   // <-- NEW: customer support chat
    BusinessModule,  // <-- ZannyPay Business, Phase 1
    RecurringTransfersModule, // <-- ZannyPay Business, Phase 3
    BeneficiariesModule, // <-- WORLD-CLASS UPGRADE
    AdminNotesModule,    // <-- WORLD-CLASS UPGRADE
    KycModule,           // <-- WORLD-CLASS UPGRADE
    ComplianceExportModule, // <-- WORLD-CLASS UPGRADE
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD, // Applies rate limiting to all endpoints automatically
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
