import {
  Body, Controller, ForbiddenException, Get, HttpCode, HttpStatus,
  Post, Req, Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { SignupDto } from './dto/signup.dto';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { WebSessionService, WEB_SESSION_COOKIE, WEB_SESSION_TTL_MS } from './web-session.service';

@Controller('auth/web')
export class WebAuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly sessions: WebSessionService,
  ) {}

  private assertTrustedOrigin(request: Request) {
    const origin = request.headers.origin;
    const allowed = (process.env.CORS_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean);
    if (!origin || !allowed.includes(origin)) {
      throw new ForbiddenException('Browser sign-in is not enabled for this origin. Configure CORS_ORIGINS first.');
    }
  }

  private setCookie(response: Response, token: string) {
    response.cookie(WEB_SESSION_COOKIE, token, {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      path: '/api/v1',
      maxAge: WEB_SESSION_TTL_MS,
    });
  }

  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() body: { phone: string; pin: string },
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.assertTrustedOrigin(request);
    const result = await this.authService.login(body.phone, body.pin);
    const session = await this.sessions.create(result.user.id, request);
    this.setCookie(response, session.token);
    response.setHeader('Cache-Control', 'no-store');
    return { user: result.user, expiresAt: session.expiresAt };
  }

  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('signup')
  @HttpCode(HttpStatus.CREATED)
  async signup(
    @Body() body: SignupDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.assertTrustedOrigin(request);
    const result = await this.authService.signup(body);
    const session = await this.sessions.create(result.user.id, request);
    this.setCookie(response, session.token);
    response.setHeader('Cache-Control', 'no-store');
    return { user: result.user, expiresAt: session.expiresAt };
  }

  @Get('session')
  @HttpCode(HttpStatus.OK)
  async session(@Req() request: Request) {
    const token = this.readSessionCookie(request.headers.cookie);
    const user = await this.sessions.getUser(token || '');
    if (!user) return { authenticated: false, user: null };
    return { authenticated: true, user };
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.assertTrustedOrigin(request);
    const token = this.readSessionCookie(request.headers.cookie);
    await this.sessions.revoke(token || '');
    response.clearCookie(WEB_SESSION_COOKIE, {
      httpOnly: true, secure: true, sameSite: 'none', path: '/api/v1',
    });
    return { success: true };
  }

  private readSessionCookie(header: string | undefined) {
    if (!header) return null;
    for (const part of header.split(';')) {
      const index = part.indexOf('=');
      if (index >= 0 && part.slice(0, index).trim() === WEB_SESSION_COOKIE) {
        try { return decodeURIComponent(part.slice(index + 1).trim()); } catch { return null; }
      }
    }
    return null;
  }
}
