import { Injectable, Inject } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export const SANCTIONS_SCREENING_PROVIDER = 'SANCTIONS_SCREENING_PROVIDER';

// Master audit: sanctions/PEP screening was entirely absent — no model,
// no service, no mention anywhere except as a documented gap. This is the
// pluggable seam for a real vendor (ComplyAdvantage, Refinitiv
// World-Check, or a Nigerian-market equivalent). SanctionsScreeningResult
// only ever stores a provider's verdict — this module never
// reimplements screening logic itself, which would be both incorrect
// (screening lists change constantly) and a compliance liability.
export interface ScreeningVerdict {
  isMatch: boolean;
  // `any`, not `unknown` — this ends up written straight into a Prisma
  // Json column (SanctionsScreeningResult.matchData), and Prisma's
  // generated InputJsonValue type isn't assignable from `unknown` even
  // when the actual shape is JSON-safe. Same reasoning as
  // NotificationsService.create()'s `metadata?: Record<string, any>`.
  matchData?: Record<string, any>;
}

export interface SanctionsScreeningProvider {
  readonly name: string;
  screen(params: {
    fullName: string;
    dateOfBirth?: string | null;
    nationality?: string | null;
  }): Promise<ScreeningVerdict>;
}

// Deliberately conservative: returns no-match for everything except a
// small, obviously-synthetic denylist, so the KYC-approval flow that
// calls this has something real to branch on (and a QA/demo path to
// actually exercise the "flagged" branch) without ever pretending to be
// a real compliance decision. A real deployment MUST set
// SANCTIONS_PROVIDER to a real vendor before approving real customers —
// see AdminService's KYC decision flow for where this is called.
@Injectable()
export class MockSanctionsScreeningProvider implements SanctionsScreeningProvider {
  readonly name = 'mock';
  private static readonly TEST_DENYLIST = [
    'sanctioned test person',
    'pep test person',
  ];

  async screen({ fullName }: { fullName: string }): Promise<ScreeningVerdict> {
    const isMatch = MockSanctionsScreeningProvider.TEST_DENYLIST.includes(
      fullName.trim().toLowerCase(),
    );
    return {
      isMatch,
      matchData: isMatch
        ? {
            note: 'Matched mock provider test denylist — not a real screening result.',
          }
        : undefined,
    };
  }
}

@Injectable()
export class SanctionsScreeningService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(SANCTIONS_SCREENING_PROVIDER)
    private readonly provider: SanctionsScreeningProvider,
  ) {}

  async screenAndRecord(
    userId: string,
    fullName: string,
    dateOfBirth?: string | null,
    nationality?: string | null,
  ) {
    const verdict = await this.provider.screen({
      fullName,
      dateOfBirth,
      nationality,
    });
    await this.prisma.sanctionsScreeningResult.create({
      data: {
        userId,
        provider: this.provider.name,
        isMatch: verdict.isMatch,
        matchData: verdict.matchData || {},
      },
    });
    return verdict;
  }

  async latestForUser(userId: string) {
    return this.prisma.sanctionsScreeningResult.findFirst({
      where: { userId },
      orderBy: { screenedAt: 'desc' },
    });
  }
}
