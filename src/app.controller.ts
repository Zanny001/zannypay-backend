import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { AppService } from './app.service';
import { PrismaService } from './prisma/prisma.service';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  // Exempted from the global 20-req/60s throttle — uptime monitors and
  // platform health checks (Render's included) typically ping far more
  // often than that, and a healthy service shouldn't report itself as
  // down just because it's being watched closely.
  @Get('health')
  @SkipThrottle()
  async health() {
    try {
      // A trivial query is the actual check — a service that's "up" but
      // can't reach its database isn't meaningfully healthy for anything
      // this app does.
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', database: 'connected', timestamp: new Date().toISOString() };
    } catch (error) {
      throw new ServiceUnavailableException({ status: 'error', database: 'unreachable' });
    }
  }
}
