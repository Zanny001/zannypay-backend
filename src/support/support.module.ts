import { Module } from '@nestjs/common';
import { SupportController } from './support.controller';
import { AdminSupportController } from './admin-support.controller';
import { SupportService } from './support.service';
import { AdminSecurityModule } from '../admin-security/admin-security.module';

@Module({
  imports: [AdminSecurityModule], // for AdminIpAllowlistGuard on the admin-facing controller
  controllers: [SupportController, AdminSupportController],
  providers: [SupportService],
})
export class SupportModule {}
