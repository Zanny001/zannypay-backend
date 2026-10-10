import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// pdfkit is required, not imported, and every call on the resulting
// document is typed `any` deliberately — pdfkit's own type definitions
// vary across versions and aren't a project dependency here, and this
// codebase has already shipped one compile break from a type mismatch on
// a Prisma-generated type. Rather than risk a second one on a third-party
// PDF library's type surface, this trades type-safety on `doc` (pdfkit's
// chainable .fontSize().text() API is stable and well-documented, so the
// runtime risk is low) for zero risk of a TS error blocking the build.

// eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate: avoids a TS-types dependency on pdfkit's chainable API for a single untyped usage
const PDFDocument = require('pdfkit');

// Master audit, Section 8: "a formal, exportable record — CSV today, a
// formatted PDF/audit-log excerpt as a near-term follow-up — is the kind
// of thing a compliance officer will ask for in week one of actually
// using this." CSV shipped earlier (AdminService.exportTransactionsCsv /
// exportAuditLogsCsv); this is the PDF half — a single customer's KYC
// decision record, reconstructed from the audit log rather than a
// separate "decisions" table, since the audit log is already the
// authoritative record of every APPROVE_KYC/REJECT_KYC action taken.
@Injectable()
export class ComplianceExportService {
  constructor(private readonly prisma: PrismaService) {}

  async generateKycDecisionPdf(userId: string): Promise<Buffer> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found.');

    const decisions = await this.prisma.auditLog.findMany({
      where: {
        targetType: 'User',
        targetId: userId,
        action: { in: ['APPROVE_KYC', 'REJECT_KYC'] },
      },
      include: { admin: { select: { name: true, email: true, role: true } } },
      orderBy: { createdAt: 'asc' },
    });

    return this.renderPdf(user, decisions);
  }

  private renderPdf(user: any, decisions: any[]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc: any = new PDFDocument({ margin: 50, size: 'A4' });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', (err: Error) => reject(err));

      doc
        .fontSize(18)
        .fillColor('#0D2261')
        .text('ZannyPay — KYC Decision Record', { align: 'left' });
      doc.moveDown(0.3);
      doc
        .fontSize(9)
        .fillColor('#666666')
        .text(
          `Generated ${new Date().toLocaleString()} — internal compliance use only`,
        );
      doc.moveDown(1.2);

      doc
        .fontSize(12)
        .fillColor('#000000')
        .text('Customer', { underline: true });
      doc.moveDown(0.4);
      doc.fontSize(10).fillColor('#333333');
      const bio: [string, string][] = [
        ['Name', user.name || '—'],
        ['Email', user.email || '—'],
        ['Phone', user.phone || '—'],
        ['Account number', user.accountNumber || '—'],
        ['Nationality', user.nationality || '—'],
        [
          'Date of birth',
          user.dateOfBirth
            ? new Date(user.dateOfBirth).toLocaleDateString()
            : '—',
        ],
        [
          'BVN (last 4)',
          user.bvnLast4 ? `•••••••${user.bvnLast4}` : 'Not provided',
        ],
        [
          'NIN (last 4)',
          user.ninLast4 ? `•••••••${user.ninLast4}` : 'Not provided',
        ],
        ['Current KYC status', `Tier ${user.kycTier} · ${user.kycStatus}`],
      ];
      for (const [label, value] of bio) {
        doc.text(`${label}: ${value}`);
      }
      doc.moveDown(1);

      doc
        .fontSize(12)
        .fillColor('#000000')
        .text('Decision History', { underline: true });
      doc.moveDown(0.4);
      doc.fontSize(10).fillColor('#333333');

      if (decisions.length === 0) {
        doc.text(
          'No KYC approve/reject decisions recorded for this customer yet.',
        );
      } else {
        for (const entry of decisions) {
          const isApproval = entry.action === 'APPROVE_KYC';
          const reason = entry.metadata?.reason;
          const sanctionsMatch = entry.metadata?.sanctionsScreeningMatch;

          doc
            .fillColor(isApproval ? '#0A7A3D' : '#B3261E')
            .text(
              `${isApproval ? 'APPROVED' : 'REJECTED'} — ${new Date(entry.createdAt).toLocaleString()}`,
            );
          doc.fillColor('#333333');
          doc.text(
            `By: ${entry.admin?.name || 'Unknown admin'} (${entry.admin?.role || 'n/a'})`,
          );
          if (reason) doc.text(`Reason: ${reason}`);
          if (sanctionsMatch !== undefined) {
            doc.text(
              `Sanctions/PEP screening: ${sanctionsMatch ? 'MATCH — see SanctionsScreeningResult for detail' : 'No match'}`,
            );
          }
          doc.moveDown(0.6);
        }
      }

      doc.moveDown(1);
      doc
        .fontSize(8)
        .fillColor('#999999')
        .text(
          'This record reflects data held by ZannyPay at the time of generation. Sanctions/PEP screening results are ' +
            'produced by an automated provider (see SanctionsScreeningResult) and should be reviewed by a compliance ' +
            'officer before being relied upon for a regulatory filing.',
          { width: 480 },
        );

      doc.end();
    });
  }
}
