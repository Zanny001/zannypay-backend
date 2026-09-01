import { Module } from '@nestjs/common';
import { KycDocumentsController } from './kyc-documents.controller';
import { KycDocumentsService } from './kyc-documents.service';
import { KYC_VERIFICATION_PROVIDER } from './kyc.tokens';
import { MockKycVerificationProvider } from './kyc-verification.provider';
import { AdminSecurityModule } from '../admin-security/admin-security.module';

@Module({
  imports: [AdminSecurityModule], // for AdminIpAllowlistGuard on the admin-review routes
  controllers: [KycDocumentsController],
  providers: [
    KycDocumentsService,
    MockKycVerificationProvider,
    { provide: KYC_VERIFICATION_PROVIDER, useExisting: MockKycVerificationProvider },
  ],
})
export class KycModule {}
