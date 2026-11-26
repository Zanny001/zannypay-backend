import { Injectable, NestMiddleware, ForbiddenException } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { WebSessionService, WEB_SESSION_COOKIE } from './web-session.service';

function readCookie(header: string | undefined, name: string) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) {
      try { return decodeURIComponent(part.slice(index + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

@Injectable()
export class WebSessionMiddleware implements NestMiddleware {
  constructor(private readonly sessions: WebSessionService) {}

  async use(req: Request, _res: Response, next: NextFunction) {
    const token = readCookie(req.headers.cookie, WEB_SESSION_COOKIE);
    if (!token) return next();

    // Cookie-authenticated state changes require an explicit, configured Origin.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase())) {
      const origin = req.headers.origin;
      const allowed = (process.env.CORS_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean);
      if (!origin || !allowed.includes(origin)) {
        return next(new ForbiddenException('Untrusted browser origin.'));
      }
    }

    try {
      const session = await this.sessions.authenticate(token);
      if (session) {
        req.headers.authorization = `Bearer ${session.accessToken}`;
      }
      return next();
    } catch (error) {
      return next(error);
    }
  }
}
