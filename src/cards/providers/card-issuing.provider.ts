import { Injectable } from '@nestjs/common';

// Master audit: "this entire service is mock/local card data — cardNumber
// and expiry are generated in-process, not issued by a real processor.
// Before this is a real product, swap this for an actual card-issuing
// integration (Stripe Issuing, Marqeta, a licensed local processor) with
// tokenized storage."
//
// This interface is that swap point. CardsService talks only to
// CardIssuingProvider — never generates a card number itself — so
// switching MockCardIssuingProvider for a real one later is a one-line
// change in cards.module.ts, not a rewrite of CardsService.
export interface IssuedCard {
  cardNumber: string | null; // full display number, ONLY for a provider that's genuinely comfortable returning it (the mock one); a real processor should return null here and populate providerRef instead
  last4: string;
  expiry: string;
  providerRef: string | null; // opaque processor token — what a real integration would actually key off of
}

export interface CardIssuingProvider {
  readonly name: string;
  issueCard(params: { userId: string; network: string }): Promise<IssuedCard>;
  // Real processors (Stripe Issuing, Marqeta) require confirming the
  // freeze/unfreeze at the network level, not just in this database — a
  // frozen-in-our-DB-but-still-live-at-the-network card is a real
  // fintech incident. The mock provider is a no-op here since there's no
  // actual network to call.
  setFrozen(providerRef: string | null, isFrozen: boolean): Promise<void>;
}

@Injectable()
export class MockCardIssuingProvider implements CardIssuingProvider {
  readonly name = 'mock';

  async issueCard({
    network,
  }: {
    userId: string;
    network: string;
  }): Promise<IssuedCard> {
    // Preserves the exact prior generation logic — same visual/behavioral
    // result as before this refactor, just now behind the interface.
    const randomDigits = Math.floor(
      10000000 + Math.random() * 90000000,
    ).toString();
    const prefix =
      network === 'VISA' ? '4532' : network === 'VERVE' ? '5061' : '54127589'; // rough network-realistic BIN prefixes for display purposes only — never real issuer BINs
    const cardNumber = `${prefix}${randomDigits}`.slice(0, 16).padEnd(16, '0');

    const now = new Date();
    const expiryMonth = String(now.getMonth() + 1).padStart(2, '0');
    const expiryYear = String(now.getFullYear() + 4).slice(-2);

    return {
      cardNumber,
      last4: cardNumber.slice(-4),
      expiry: `${expiryMonth}/${expiryYear}`,
      providerRef: null,
    };
  }

  async setFrozen(): Promise<void> {
    // No-op — nothing to call. A real provider implementation MUST call
    // out to the processor here and throw if that call fails, so a
    // freeze that didn't actually take at the network level never gets
    // recorded as successful in our own database.
  }
}
