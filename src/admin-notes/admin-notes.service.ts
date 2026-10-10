import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateInternalNoteDto } from './dto/create-internal-note.dto';

// Master audit, Section 6/8: the admin dashboard has no shared memory
// between admins looking at the same thing — a support agent who called a
// customer about a pending dispute has nowhere to leave "called them,
// waiting on their bank to confirm" for the next shift, other than a
// Slack message that isn't attached to the record at all. Deliberately
// separate from Dispute.resolutionNote (a single field filled once, at
// resolution) and from the customer-facing Conversation/ChatMessage
// models (this is never shown to the customer).
@Injectable()
export class AdminNotesService {
  constructor(private readonly prisma: PrismaService) {}

  async listForTarget(targetType: string, targetId: string) {
    return this.prisma.internalNote.findMany({
      where: { targetType, targetId },
      include: {
        admin: { select: { id: true, name: true, photoUrl: true, role: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async create(adminId: string, dto: CreateInternalNoteDto) {
    return this.prisma.internalNote.create({
      data: {
        targetType: dto.targetType,
        targetId: dto.targetId,
        adminId,
        body: dto.body,
      },
      include: {
        admin: { select: { id: true, name: true, photoUrl: true, role: true } },
      },
    });
  }
}
