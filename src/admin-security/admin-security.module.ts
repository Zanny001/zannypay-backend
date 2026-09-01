import { Module } from '@nestjs/common';
import { IpAllowlistController } from './ip-allowlist.controller';
import { IpAllowlistService } from './ip-allowlist.service';
import { AdminIpAllowlistGuard } from './admin-ip-allowlist.guard';
import { Require2faGuard } from '../admin-auth/require-2fa.guard';

// Require2faGuard is provided here too (not just in AdminAuthModule) so
// IpAllowlistController can use it without AdminSecurityModule importing
// AdminAuthModule — AdminAuthModule already imports AdminSecurityModule
// (for AdminIpAllowlistGuard on its own login/bootstrap routes), and
// Nest modules can't import each other in a cycle. Require2faGuard only
// depends on the @Global PrismaService, so provided instances in each
// module are equivalent — this isn't a hack, just two modules each
// declaring the provider they use, same as any stateless guard/pipe.
@Module({
  controllers: [IpAllowlistController],
  providers: [IpAllowlistService, AdminIpAllowlistGuard, Require2faGuard],
  exports: [AdminIpAllowlistGuard],
})
export class AdminSecurityModule {}
