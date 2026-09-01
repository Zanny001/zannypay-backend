import { Injectable, BadRequestException } from '@nestjs/common';

// Separate seam from CardIssuingProvider on purpose: issuing a NEW
// ZannyPay-branded card and linking an EXISTING external bank card are
// different products with different processor relationships (a card
// issuer like Stripe Issuing/Marqeta vs. a payment gateway's saved-card/
// tokenized-authorization API like Paystack, which ZannyPay already
// integrates with for wallet funding — see PAYSTACK_SECRET_KEY in
// .env.example). Conflating them into one interface would leak one
// product's assumptions into the other.
export interface LinkedExternalCard {
  last4: string;
  network: string; // 'VISA' | 'MASTERCARD' | 'VERVE'
  expiry: string;
  providerRef: string; // the processor's tokenized-authorization reference — never a raw PAN
}

export interface ExternalCardLinkingProvider {
  readonly name: string;
  // `authorizationCode` is whatever the client-side card-collection SDK
  // hands back after the user enters their card details directly with the
  // processor (e.g. Paystack Inline) — this backend never receives, sees,
  // or stores a raw PAN/CVV at any point, which is the entire point of
  // using a processor for this instead of a custom form.
  linkCard(params: { userId: string; authorizationCode: string }): Promise<LinkedExternalCard>;
}

// Deliberately fails clearly rather than fabricating a "linked" card with
// fake data — this project's pattern throughout has been to be honest
// about what's real vs. mocked, and a linked payment card is not
// something that's safe to fake even in a demo/mock adapter the way a
// ZannyPay-issued virtual card's cosmetic number can be.
@Injectable()
export class MockExternalCardLinkingProvider implements ExternalCardLinkingProvider {
  readonly name = 'mock';

  async linkCard(): Promise<LinkedExternalCard> {
    throw new BadRequestException(
      'Linking an external card requires a real card-tokenization processor to be configured (set CARD_LINKING_PROVIDER=paystack and PAYSTACK_SECRET_KEY). Not available in this environment.',
    );
  }
}

// Real-shaped but not wired by default — selected via
// CARD_LINKING_PROVIDER=paystack in cards.module.ts. Sketches the actual
// integration: Paystack's charge-authorization flow returns an
// `authorization_code` after a customer completes a card charge (even a
// ₦50 verification charge), which can then be reused for future charges
// without re-collecting card details — that authorization_code is exactly
// what `linkCard`'s `authorizationCode` param expects to receive.
@Injectable()
export class PaystackExternalCardLinkingProvider implements ExternalCardLinkingProvider {
  readonly name = 'paystack';

  async linkCard({ authorizationCode }: { userId: string; authorizationCode: string }): Promise<LinkedExternalCard> {
    const secretKey = process.env.PAYSTACK_SECRET_KEY;
    if (!secretKey) {
      throw new BadRequestException('PAYSTACK_SECRET_KEY is not configured on this deployment.');
    }

    // Paystack doesn't expose a standalone "look up this authorization"
    // endpoint — in practice this comes from the /transaction/verify
    // response for the charge that produced it (see TransactionsService.
    // fundWallet for the existing Paystack integration pattern this
    // mirrors). The mobile client is expected to complete that charge via
    // Paystack Inline/Popup and pass this backend the resulting
    // authorization object, not just a bare code — wire that handoff here
    // once card linking moves from "designed" to "built."
    const response = await fetch('https://api.paystack.co/transaction/verify/' + encodeURIComponent(authorizationCode), {
      headers: { Authorization: `Bearer ${secretKey}` },
    });
    const data = await response.json();
    if (!response.ok || !data?.status || !data?.data?.authorization) {
      throw new BadRequestException(data?.message || 'Could not verify this card with Paystack.');
    }

    const auth = data.data.authorization;
    return {
      last4: auth.last4,
      network: (auth.card_type || auth.brand || 'VISA').toUpperCase().includes('VERVE') ? 'VERVE' : (auth.card_type || 'VISA').toUpperCase(),
      expiry: `${auth.exp_month}/${String(auth.exp_year).slice(-2)}`,
      providerRef: auth.authorization_code,
    };
  }
}
