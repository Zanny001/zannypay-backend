import { Injectable, Inject } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { KYC_VERIFICATION_PROVIDER } from './kyc.tokens';
// import type — see the identical comment in cards/cards.service.ts;
// same isolatedModules + emitDecoratorMetadata interaction.
import type { KycVerificationProvider } from './kyc-verification.provider';
import { SubmitKycDocumentDto } from './dto/submit-kyc-document.dto';
import {
  AnalyticsService,
  ANALYTICS_EVENTS,
} from '../analytics/analytics.service';

@Injectable()
export class KycDocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService,
    @Inject(KYC_VERIFICATION_PROVIDER)
    private readonly verificationProvider: KycVerificationProvider,
    private readonly analyticsService: AnalyticsService,
  ) {}

  async submit(userId: string, dto: SubmitKycDocumentDto) {
    const fileUrl = await this.storageService.storeImage(
      dto.file,
      `kyc-documents/${userId}`,
    );

    const livenessScore =
      dto.type === 'selfie'
        ? (await this.verificationProvider.checkLiveness(fileUrl)).score
        : null;

    const document = await this.prisma.kycDocument.create({
      data: {
        userId,
        type: dto.type,
        fileUrl,
        livenessScore,
        status: 'pending',
      },
    });

    await this.analyticsService.track(ANALYTICS_EVENTS.KYC_SUBMITTED, {
      userId,
      properties: { documentType: dto.type },
    });

    return document;
  }

  async listForUser(userId: string) {
    return this.prisma.kycDocument.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  // Admin-side review queue — surfaced alongside AdminService.getKycQueue
  // so a compliance officer sees the submitted document images, not just
  // the BVN/NIN digits and biodata fields that queue already returned.
  async listForAdminReview(userId: string) {
    return this.prisma.kycDocument.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async setStatus(
    documentId: string,
    status: 'verified' | 'rejected',
    reviewedByAdminId: string,
  ) {
    return this.prisma.kycDocument.update({
      where: { id: documentId },
      data: { status, reviewedByAdminId },
    });
  }
}
