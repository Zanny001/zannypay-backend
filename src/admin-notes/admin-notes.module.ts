import { Module } from '@nestjs/common';
import { AdminNotesController } from './admin-notes.controller';
import { AdminNotesService } from './admin-notes.service';
import { AdminSecurityModule } from '../admin-security/admin-security.module';

@Module({
  imports: [AdminSecurityModule], // for AdminIpAllowlistGuard
  controllers: [AdminNotesController],
  providers: [AdminNotesService],
})
export class AdminNotesModule {}
