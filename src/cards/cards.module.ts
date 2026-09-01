import { Module } from '@nestjs/common';
import { CardsService } from './cards.service';
import { CardsController } from './cards.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { CARD_ISSUING_PROVIDER, CARD_LINKING_PROVIDER } from './cards.tokens';
import { MockCardIssuingProvider } from './providers/card-issuing.provider';
import { MockExternalCardLinkingProvider, PaystackExternalCardLinkingProvider } from './providers/card-linking.provider';

// Provider selection is env-driven, not a code change — a real deploy
// flips CARD_LINKING_PROVIDER=paystack once PAYSTACK_SECRET_KEY is set;
// card issuing has no real-processor option wired yet (see
// providers/card-issuing.provider.ts), so it always resolves to the mock
// implementation today.
@Module({
  imports: [PrismaModule],
  controllers: [CardsController],
  providers: [
    CardsService,
    MockCardIssuingProvider,
    MockExternalCardLinkingProvider,
    PaystackExternalCardLinkingProvider,
    { provide: CARD_ISSUING_PROVIDER, useExisting: MockCardIssuingProvider },
    {
      provide: CARD_LINKING_PROVIDER,
      useFactory: (mock: MockExternalCardLinkingProvider, paystack: PaystackExternalCardLinkingProvider) =>
        process.env.CARD_LINKING_PROVIDER === 'paystack' ? paystack : mock,
      inject: [MockExternalCardLinkingProvider, PaystackExternalCardLinkingProvider],
    },
  ],
  exports: [CardsService],
})
export class CardsModule {}
