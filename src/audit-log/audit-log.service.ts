import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  // Audit log writes are fire-and-forget from the caller's perspective —
  // if this insert fails, the admin's (or the system's) actual action
  // (which already happened) should not be rolled back just because
  // logging failed, but we still want the error surfaced somewhere.
  //
  // `adminId` is omitted for automated actions (e.g. the fraud engine
  // auto-freezing an account) — pass `actorType: 'SYSTEM'` for those
  // instead of a human admin's id.
  async record(params: {
    adminId?: string;
    actorType?: 'ADMIN' | 'SYSTEM';
    action: string;
    targetType: string;
    targetId: string;
    metadata?: Record<string, any>;
    ipAddress?: string;
  }) {
    try {
      await this.prisma.auditLog.create({
        data: {
          adminId: params.adminId,
          actorType: params.actorType || 'ADMIN',
          action: params.action,
          targetType: params.targetType,
          targetId: params.targetId,
          metadata: params.metadata || {},
          ipAddress: params.ipAddress,
        },
      });
    } catch (error) {
      console.error('[AuditLog] Failed to record action:', params.action, error);
    }
  }

  async list(filters: { adminId?: string; targetType?: string; targetId?: string; actorType?: string; limit?: number }) {
    return this.prisma.auditLog.findMany({
      where: {
        ...(filters.adminId && { adminId: filters.adminId }),
        ...(filters.targetType && { targetType: filters.targetType }),
        ...(filters.targetId && { targetId: filters.targetId }),
        ...(filters.actorType && { actorType: filters.actorType }),
      },
      include: { admin: { select: { name: true, email: true, role: true } } },
      orderBy: { createdAt: 'desc' },
      take: filters.limit || 100,
    });
  }
}
