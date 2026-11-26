import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { WebSessionService, WEB_SESSION_COOKIE } from './web-session.service';

function readCookie(header: string | undefined) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index >= 0 && part.slice(0, index).trim() === WEB_SESSION_COOKIE) {
      try {
        return decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

@Injectable()
export class WebSessionGuard implements CanActivate {
  constructor(private readonly sessions: WebSessionService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    const token = readCookie(request.headers.cookie);
    if (!token) return true;

    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(
        String(request.method).toUpperCase(),
      )
    ) {
      const origin = request.headers.origin;
      const allowed = (process.env.CORS_ORIGINS || '')
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
      if (!origin || !allowed.includes(origin)) {
        throw new ForbiddenException('Untrusted browser origin.');
      }
    }

    const session = await this.sessions.authenticate(token);
    if (session) {
      request.headers.authorization = `Bearer ${session.accessToken}`;
    }
    return true;
  }
}
