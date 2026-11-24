import { Injectable, ServiceUnavailableException } from '@nestjs/common';

// A real card issuer must replace this development-only provider before
// customers can receive genuine virtual cards or network-level controls.
export interface IssuedCard {
  cardNumber: string | null;
  last4: string;
  expiry: string;
  providerRef: string | null;
}

export interface CardIssuingProvider {
  readonly name: string;
  issueCard(params: { userId: string; network: string }): Promise<IssuedCard>;
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
    if (process.env.NODE_ENV === 'production') {
      throw new ServiceUnavailableException(
        'Virtual card issuing is not configured. No card has been issued.',
      );
    }

    const randomDigits = Math.floor(
      10000000 + Math.random() * 90000000,
    ).toString();
    const prefix =
      network === 'VISA' ? '4532' : network === 'VERVE' ? '5061' : '54127589';
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
    if (process.env.NODE_ENV === 'production') {
      throw new ServiceUnavailableException(
        'Virtual card controls are not connected to a card issuer.',
      );
    }
  }
}
