import {
  Injectable,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
  Inject,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CARD_ISSUING_PROVIDER, CARD_LINKING_PROVIDER } from './cards.tokens';
import * as bcrypt from 'bcrypt';
// import type — CardIssuingProvider/ExternalCardLinkingProvider are pure
// interfaces (erased at compile time). The actual runtime binding comes
// from the @Inject(TOKEN) string tokens below, not from these types — but
// under isolatedModules (each file transpiled independently, no
// cross-file type info) the compiler can't tell an interface-only import
// apart from a class import used for reflection metadata unless it's told
// explicitly. Without `type` here, tsc tries to emit a runtime reference
// to an interface that doesn't exist at runtime and fails to build.
import type { CardIssuingProvider } from './providers/card-issuing.provider';
import type { ExternalCardLinkingProvider } from './providers/card-linking.provider';
import {
  AnalyticsService,
  ANALYTICS_EVENTS,
} from '../analytics/analytics.service';

const VALID_NETWORKS = ['VISA', 'MASTERCARD', 'VERVE', 'ZANNYPAY'];

// Shares the same rate-limit fields UserService.revealKycField uses
// (kycRevealFailedAttempts/kycRevealLockedUntil on User) rather than
// adding a second, parallel lockout counter — the threat is identical
// either way (someone with a stolen unlocked session brute-forcing a PIN
// to expose sensitive data), so one shared budget of attempts across
// both KYC-field reveal and card-PAN reveal is more conservative than
// giving an attacker a fresh set of guesses per endpoint.
const REVEAL_LOCKOUT_THRESHOLD = 5;
const REVEAL_LOCKOUT_MINUTES = 15;

@Injectable()
export class CardsService {
  constructor(
    private prisma: PrismaService,
    @Inject(CARD_ISSUING_PROVIDER) private issuingProvider: CardIssuingProvider,
    @Inject(CARD_LINKING_PROVIDER)
    private linkingProvider: ExternalCardLinkingProvider,
    private analyticsService: AnalyticsService,
  ) {}

  // CVV is deliberately NOT generated or stored anywhere in this service —
  // see the schema comment on the Card model for why, and never add it
  // back. If a user needs to view their CVV, that has to come live from
  // the processor's reveal API at display time.

  // Master audit follow-up: this previously returned the raw `cardNumber`
  // column to the client on every single load (dashboard sync, this
  // screen's own fetch, anywhere `cards` gets refreshed) — the mobile
  // "Reveal" button was only ever a LOCAL display mask over data that had
  // already left the server. A device memory dump, a debugger, or a
  // careless log line could expose the full PAN without the user ever
  // tapping Reveal. The full number now never leaves the server until
  // revealCardNumber() below, gated behind the same PIN re-auth already
  // used for BVN/NIN reveal.
  async getCards(userId: string) {
    return this.prisma.card.findMany({
      where: { userId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        userId: true,
        last4: true,
        expiry: true,
        type: true,
        network: true,
        isFrozen: true,
        isDefault: true,
        isLinkedExternal: true,
        provider: true,
        dailyLimit: true,
        monthlyLimit: true,
        dailySpent: true,
        monthlySpent: true,
        spendResetAt: true,
        createdAt: true,
        updatedAt: true,
        // cardNumber and providerRef deliberately excluded — see the
        // method doc comment above.
      },
    });
  }

  /**
   * Returns the full PAN + expiry for exactly one card, only after
   * verifying the caller's PIN — mirrors UserService.revealKycField's
   * PIN-plus-lockout pattern exactly, including sharing its rate-limit
   * fields (see the module-level comment on REVEAL_LOCKOUT_THRESHOLD).
   * A linked external card has no cardNumber to reveal at all (ZannyPay
   * never holds it — see the schema comment on Card.cardNumber), so that
   * case is a plain 400, not a PIN prompt that could never succeed.
   */
  async revealCardNumber(userId: string, cardId: string, pin: string) {
    const card = await this.getOwnedCardOrThrow(userId, cardId);
    if (card.isLinkedExternal || !card.cardNumber) {
      throw new BadRequestException(
        'This card has no number on file to reveal — linked external cards are never stored by ZannyPay.',
      );
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found.');

    if (
      user.kycRevealLockedUntil &&
      user.kycRevealLockedUntil.getTime() > Date.now()
    ) {
      const minutesLeft = Math.ceil(
        (user.kycRevealLockedUntil.getTime() - Date.now()) / 60000,
      );
      throw new UnauthorizedException(
        `Too many attempts. Try again in ${minutesLeft} minute(s).`,
      );
    }

    const isPinValid = await bcrypt.compare(pin, user.pin);
    if (!isPinValid) {
      const attempts = user.kycRevealFailedAttempts + 1;
      const data: {
        kycRevealFailedAttempts: number;
        kycRevealLockedUntil?: Date;
      } = { kycRevealFailedAttempts: attempts };
      if (attempts >= REVEAL_LOCKOUT_THRESHOLD) {
        data.kycRevealLockedUntil = new Date(
          Date.now() + REVEAL_LOCKOUT_MINUTES * 60 * 1000,
        );
      }
      await this.prisma.user.update({ where: { id: userId }, data });
      throw new UnauthorizedException('Incorrect PIN.');
    }

    if (user.kycRevealFailedAttempts > 0 || user.kycRevealLockedUntil) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { kycRevealFailedAttempts: 0, kycRevealLockedUntil: null },
      });
    }

    // getOwnedCardOrThrow (unlike getCards above) runs a plain
    // findFirst() with no `select` clause, so `card.cardNumber` here is
    // the real value — that's deliberate and the only place in this
    // service it's read back out.
    return { success: true, cardNumber: card.cardNumber, expiry: card.expiry };
  }

  // Master audit, Section 5 (mobile gap): the mobile UI implies multiple
  // cards (a horizontal carousel pattern is a near-universal fintech
  // convention — see the reference boards) but the backend only ever
  // allowed exactly one card per user. That restriction is gone: a user
  // can now hold several ZannyPay-issued cards (e.g. one for
  // subscriptions, one for everyday spend) plus linked external cards,
  // same as the reference apps this redesign is benchmarked against.
  async createCard(userId: string, network?: string) {
    const resolvedNetwork =
      network && VALID_NETWORKS.includes(network) ? network : 'ZANNYPAY';
    const issued = await this.issuingProvider.issueCard({
      userId,
      network: resolvedNetwork,
    });

    const isFirstCard =
      (await this.prisma.card.count({ where: { userId } })) === 0;

    const card = await this.prisma.card.create({
      data: {
        userId,
        cardNumber: issued.cardNumber,
        last4: issued.last4,
        expiry: issued.expiry,
        network: resolvedNetwork,
        type: 'VIRTUAL ULTRA',
        isFrozen: false,
        isDefault: isFirstCard, // the very first card a user gets defaults to their default — later cards don't, so adding a second card never silently changes which one their bills/subscriptions charge to
        provider: this.issuingProvider.name,
        providerRef: issued.providerRef,
      },
    });

    await this.analyticsService.track(ANALYTICS_EVENTS.CARD_CREATED, {
      userId,
      properties: { network: resolvedNetwork, isFirstCard },
    });

    return card;
  }

  // Master audit, Section 5: linking an existing Visa/Mastercard/Verve
  // debit card as a funding source, via a real tokenization processor —
  // see providers/card-linking.provider.ts for why this backend never
  // sees a raw PAN.
  async linkExternalCard(userId: string, authorizationCode: string) {
    const linked = await this.linkingProvider.linkCard({
      userId,
      authorizationCode,
    });
    const isFirstCard =
      (await this.prisma.card.count({ where: { userId } })) === 0;

    const card = await this.prisma.card.create({
      data: {
        userId,
        cardNumber: null,
        last4: linked.last4,
        expiry: linked.expiry,
        network: linked.network,
        type: 'LINKED',
        isFrozen: false,
        isDefault: isFirstCard,
        isLinkedExternal: true,
        provider: this.linkingProvider.name,
        providerRef: linked.providerRef,
      },
    });

    await this.analyticsService.track(ANALYTICS_EVENTS.CARD_LINKED, {
      userId,
      properties: { network: linked.network },
    });

    return card;
  }

  private async getOwnedCardOrThrow(userId: string, cardId: string) {
    const card = await this.prisma.card.findFirst({
      where: { id: cardId, userId },
    });
    if (!card) throw new NotFoundException('Card not found.');
    return card;
  }

  async toggleFreeze(userId: string, cardId: string, isFrozen: boolean) {
    const card = await this.getOwnedCardOrThrow(userId, cardId);

    // Confirm at the network level first — see CardIssuingProvider.
    // setFrozen's doc comment for why a DB-only freeze that silently
    // didn't take at the processor would be a real incident, not just a
    // cosmetic bug.
    await this.issuingProvider.setFrozen(card.providerRef, isFrozen);

    return this.prisma.card.update({
      where: { id: cardId },
      data: { isFrozen },
    });
  }

  async setDefault(userId: string, cardId: string) {
    await this.getOwnedCardOrThrow(userId, cardId);

    // Exactly one default per user — clear the old one and set the new
    // one in the same transaction so there's never a moment (or a crash
    // between two separate writes) where a user has zero or two defaults.
    return this.prisma.$transaction(async (tx) => {
      await tx.card.updateMany({
        where: { userId, isDefault: true },
        data: { isDefault: false },
      });
      return tx.card.update({
        where: { id: cardId },
        data: { isDefault: true },
      });
    });
  }

  async updateLimits(
    userId: string,
    cardId: string,
    dailyLimit?: number,
    monthlyLimit?: number,
  ) {
    await this.getOwnedCardOrThrow(userId, cardId);
    if (dailyLimit !== undefined && dailyLimit <= 0)
      throw new BadRequestException('Daily limit must be greater than zero.');
    if (monthlyLimit !== undefined && monthlyLimit <= 0)
      throw new BadRequestException('Monthly limit must be greater than zero.');
    if (
      dailyLimit !== undefined &&
      monthlyLimit !== undefined &&
      dailyLimit > monthlyLimit
    ) {
      throw new BadRequestException(
        'Daily limit cannot exceed the monthly limit.',
      );
    }

    return this.prisma.card.update({
      where: { id: cardId },
      data: {
        ...(dailyLimit !== undefined && { dailyLimit }),
        ...(monthlyLimit !== undefined && { monthlyLimit }),
      },
    });
  }

  async removeCard(userId: string, cardId: string) {
    const card = await this.getOwnedCardOrThrow(userId, cardId);
    await this.prisma.card.delete({ where: { id: cardId } });

    // If the removed card was the default and other cards remain, promote
    // the next one — a user should never end up with cards but no default.
    if (card.isDefault) {
      const next = await this.prisma.card.findFirst({
        where: { userId },
        orderBy: { createdAt: 'asc' },
      });
      if (next)
        await this.prisma.card.update({
          where: { id: next.id },
          data: { isDefault: true },
        });
    }

    return { success: true };
  }

  // Card-specific transaction history for the Cards hub — Transaction
  // doesn't carry a cardId today (every purchase draws from the shared
  // wallet balance, not a per-card sub-ledger; dailyLimit/monthlyLimit
  // above govern spend *through* a given card, not a separate balance),
  // so this filters by category/title heuristically as a best-effort view
  // rather than a precise ledger. A real card-transaction feed needs the
  // issuing processor's own transaction webhook (Stripe Issuing
  // authorization events, etc.) once card issuing is a live integration
  // rather than mock/local.
  async getCardActivity(userId: string, cardId: string) {
    await this.getOwnedCardOrThrow(userId, cardId);
    return this.prisma.transaction.findMany({
      where: {
        userId,
        category: {
          in: ['subscription', 'shopping', 'bills', 'data', 'airtime'],
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 25,
    });
  }
}
