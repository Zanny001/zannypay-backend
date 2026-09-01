import { Controller, Post, Get, Body, Query, Req, UseGuards, BadRequestException } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminJwtAuthGuard } from '../admin-auth/admin-jwt-auth.guard';
import { RolesGuard } from '../admin-auth/roles.guard';
import { AdminIpAllowlistGuard } from '../admin-security/admin-ip-allowlist.guard';
import { AnalyticsService, ANALYTICS_EVENTS, AnalyticsEventName } from './analytics.service';

const VALID_EVENT_NAMES = new Set<string>(Object.values(ANALYTICS_EVENTS));

// Authenticated mobile clients only — see the class-level comment on
// AnalyticsService.track for why a client-side event is always allowed
// to fail silently from the caller's perspective. This endpoint exists
// for the handful of pure-UI events server-side instrumentation can't
// see at all (e.g. "viewed savings screen"); every money-movement event
// in the curated list is fired server-side instead, at the point the
// operation actually succeeds, which can't be missed by an app crash or
// a dropped network request the way a client-fired event could be.
@UseGuards(JwtAuthGuard)
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Post('track')
  async track(@Req() req, @Body() body: { name: string; properties?: Record<string, any> }) {
    if (!VALID_EVENT_NAMES.has(body.name)) {
      throw new BadRequestException(`Unknown event name "${body.name}" — see ANALYTICS_EVENTS in analytics.service.ts for the curated list.`);
    }
    const userId = req.user.sub || req.user.userId;
    await this.analyticsService.track(body.name as AnalyticsEventName, { userId, platform: 'mobile', properties: body.properties });
    return { success: true };
  }
}

@Controller('admin/analytics/events')
@UseGuards(AdminIpAllowlistGuard, AdminJwtAuthGuard, RolesGuard)
export class AdminAnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('summary')
  async summary(@Query('days') days?: string) {
    return this.analyticsService.getEventSummary(Number(days) || 30);
  }

  @Get('recent')
  async recent(@Query('limit') limit?: string) {
    return this.analyticsService.getRecentEvents(Number(limit) || 100);
  }
}
