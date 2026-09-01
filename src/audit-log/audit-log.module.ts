import { Global, Module } from '@nestjs/common';
import { AuditLogService } from './audit-log.service';

// @Global, same pattern as PrismaModule — audit logging is infrastructural
// and needed by admin-auth (login/2FA/session events), admin (user/KYC/
// transaction actions), fraud (automated rule triggers), and admin-security
// (IP allowlist changes). Import this once in AppModule; every other module
// can then inject AuditLogService directly without importing anything.
@Global()
@Module({
  providers: [AuditLogService],
  exports: [AuditLogService],
})
export class AuditLogModule {}
