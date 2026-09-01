import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { AdminSecurityModule } from '../admin-security/admin-security.module';
import { ScreeningModule } from '../screening/screening.module';

@Module({
  // AuditLogService comes from the @Global() AuditLogModule (imported once
  // in AppModule) — no need to list it here, same as PrismaService.
  imports: [AdminAuthModule, AdminSecurityModule, ScreeningModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
