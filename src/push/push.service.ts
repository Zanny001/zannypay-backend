import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// Master audit, Section 4/9: "There is no push notification system.
// NotificationsScreen only shows what's already loaded when the screen is
// open — a fraud hold, a large incoming transfer, a KYC rejection all sit
// silently until the user happens to open the app... For a money app,
// this isn't a nice-to-have; a fraud hold a user doesn't find out about
// for six hours is a support ticket and a trust problem, not a missed
// feature."
//
// This adapter targets Expo's push service (expo-server-sdk-equivalent
// HTTP API) since the mobile app is built with Expo (see
// mobile/app.json / expo-notifications usage) — Expo's push endpoint
// fans a single request out to both APNs and FCM depending on each
// token's platform, so this service doesn't need to talk to Apple/Google
// directly. Swapping to bare FCM/APNs later (e.g. after an Expo eject)
// only means changing this one file.
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private readonly expoPushUrl = 'https://exp.host/--/api/v2/push/send';

  constructor(private readonly prisma: PrismaService) {}

  async registerToken(userId: string, token: string, platform?: string) {
    return this.prisma.pushToken.upsert({
      where: { token },
      update: { userId, platform, lastSeenAt: new Date() },
      create: { userId, token, platform },
    });
  }

  async unregisterToken(token: string) {
    await this.prisma.pushToken.deleteMany({ where: { token } });
    return { success: true };
  }

  /**
   * Best-effort by design — called from NotificationsService.create()
   * right after the in-app Notification row is written, and must never
   * throw back into that call chain. A push failure (bad token, Expo
   * outage, no tokens registered yet) should never fail the request that
   * triggered it — a fund transfer completing must not roll back, or even
   * slow down, because a push send failed.
   */
  async sendToUser(
    userId: string,
    title: string,
    body: string,
    data?: Record<string, unknown>,
  ) {
    try {
      const tokens = await this.prisma.pushToken.findMany({
        where: { userId },
        select: { id: true, token: true },
      });
      if (tokens.length === 0) return;

      const messages = tokens.map((t) => ({
        to: t.token,
        sound: 'default',
        title,
        body,
        data: data || {},
      }));

      const response = await fetch(this.expoPushUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(messages),
      });

      if (!response.ok) {
        this.logger.warn(
          `Expo push send failed with status ${response.status}`,
        );
        return;
      }

      const result = await response.json().catch(() => null);
      await this.pruneDeadTokens(tokens, result);
    } catch (error) {
      // Network hiccup, Expo outage, etc. — logged, never rethrown.
      this.logger.warn(
        `Push send failed, continuing: ${error?.message || error}`,
      );
    }
  }

  /** Expo reports DeviceNotRegistered for uninstalled apps / stale tokens — clean those up so future sends don't keep paying for a dead token. */
  private async pruneDeadTokens(
    tokens: { id: string; token: string }[],
    expoResult: any,
  ) {
    const tickets: any[] = expoResult?.data;
    if (!Array.isArray(tickets)) return;

    const deadTokenIds = tickets
      .map((ticket, index) =>
        ticket?.details?.error === 'DeviceNotRegistered'
          ? tokens[index]?.id
          : null,
      )
      .filter((id): id is string => !!id);

    if (deadTokenIds.length > 0) {
      await this.prisma.pushToken
        .deleteMany({ where: { id: { in: deadTokenIds } } })
        .catch(() => undefined);
    }
  }
}
