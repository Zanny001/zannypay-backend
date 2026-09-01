import { Global, Module } from '@nestjs/common';
import { StorageController } from './storage.controller';
import { StorageService } from './storage.service';

// @Global, same pattern as AuditLogModule/NotificationsModule — needed by
// UserModule (profile photos), SupportModule (chat attachments),
// AdminAuthModule (admin profile photos), and a future KYC documents
// module. Import once in AppModule.
@Global()
@Module({
  controllers: [StorageController],
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
