import { Controller, Get, Post, Patch, Body, Param, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminJwtAuthGuard } from '../admin-auth/admin-jwt-auth.guard';
import { RolesGuard } from '../admin-auth/roles.guard';
import { Roles } from '../admin-auth/roles.decorator';
import { AdminIpAllowlistGuard } from '../admin-security/admin-ip-allowlist.guard';
import { KycDocumentsService } from './kyc-documents.service';
import { SubmitKycDocumentDto } from './dto/submit-kyc-document.dto';

@Controller('kyc-documents')
export class KycDocumentsController {
  constructor(private readonly kycDocumentsService: KycDocumentsService) {}

  @UseGuards(JwtAuthGuard)
  @Post()
  async submit(@Req() req, @Body() dto: SubmitKycDocumentDto) {
    const userId = req.user.sub || req.user.userId;
    return this.kycDocumentsService.submit(userId, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Get('mine')
  async listMine(@Req() req) {
    const userId = req.user.sub || req.user.userId;
    return this.kycDocumentsService.listForUser(userId);
  }

  // Compliance officers review the actual document/selfie images
  // alongside the biodata fields AdminService.getKycQueue already
  // returns — separate endpoint rather than folding into that queue
  // response so image data is only fetched when an officer opens a
  // specific user's review, not on every queue page load.
  @UseGuards(AdminIpAllowlistGuard, AdminJwtAuthGuard, RolesGuard)
  @Roles('SUPER_ADMIN', 'COMPLIANCE_OFFICER')
  @Get('admin/:userId')
  async listForAdminReview(@Param('userId') userId: string) {
    return this.kycDocumentsService.listForAdminReview(userId);
  }

  @UseGuards(AdminIpAllowlistGuard, AdminJwtAuthGuard, RolesGuard)
  @Roles('SUPER_ADMIN', 'COMPLIANCE_OFFICER')
  @Patch('admin/:documentId/status')
  async setStatus(@Req() req, @Param('documentId') documentId: string, @Body('status') status: 'verified' | 'rejected') {
    return this.kycDocumentsService.setStatus(documentId, status, req.user.adminId);
  }
}
