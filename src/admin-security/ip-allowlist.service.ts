import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';

@Injectable()
export class IpAllowlistService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  async list() {
    const [entries, envEntries] = [
      await this.prisma.adminIpAllowlistEntry.findMany({ orderBy: { createdAt: 'desc' } }),
      (process.env.ADMIN_IP_ALLOWLIST || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ];
    return {
      enforced: process.env.ADMIN_IP_ALLOWLIST_ENFORCE === 'true',
      dbEntries: entries,
      // Read-only visibility into the env-based half of the list, so an
      // admin looking at this screen isn't missing half the picture.
      envEntries,
    };
  }

  async create(actingAdminId: string, cidr: string, label?: string, ip?: string) {
    const entry = await this.prisma.adminIpAllowlistEntry.create({
      data: { cidr, label, createdBy: actingAdminId },
    });
    await this.auditLog.record({
      adminId: actingAdminId,
      action: 'ADD_IP_ALLOWLIST_ENTRY',
      targetType: 'AdminIpAllowlistEntry',
      targetId: entry.id,
      metadata: { cidr, label },
      ipAddress: ip,
    });
    return { success: true, entry };
  }

  async remove(actingAdminId: string, id: string, ip?: string) {
    const entry = await this.prisma.adminIpAllowlistEntry.findUnique({ where: { id } });
    if (!entry) throw new NotFoundException('Allowlist entry not found.');

    await this.prisma.adminIpAllowlistEntry.delete({ where: { id } });
    await this.auditLog.record({
      adminId: actingAdminId,
      action: 'REMOVE_IP_ALLOWLIST_ENTRY',
      targetType: 'AdminIpAllowlistEntry',
      targetId: id,
      metadata: { cidr: entry.cidr, label: entry.label },
      ipAddress: ip,
    });
    return { success: true };
  }
}
