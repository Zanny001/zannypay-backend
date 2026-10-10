import { Module } from '@nestjs/common';
import {
  SanctionsScreeningService,
  MockSanctionsScreeningProvider,
  SANCTIONS_SCREENING_PROVIDER,
} from './sanctions-screening.provider';

// SANCTIONS_PROVIDER env var picks the implementation once a real vendor
// (ComplyAdvantage, Refinitiv, etc.) is integrated — today only 'mock'
// exists, so this always resolves to it regardless of the env var's
// value, same honesty-over-convenience choice as CardsModule's linking
// provider.
@Module({
  providers: [
    MockSanctionsScreeningProvider,
    {
      provide: SANCTIONS_SCREENING_PROVIDER,
      useExisting: MockSanctionsScreeningProvider,
    },
    SanctionsScreeningService,
  ],
  exports: [SanctionsScreeningService],
})
export class ScreeningModule {}
