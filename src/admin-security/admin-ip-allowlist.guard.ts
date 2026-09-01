import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ipMatchesAnyCidr } from '../common/ip-match.util';

// Applied to every admin-facing controller (admin-auth AND admin). Off by
// default so a fresh deployment isn't locked out before anyone has had a
// chance to configure it — but the moment ADMIN_IP_ALLOWLIST_ENFORCE=true
// is set, this fails CLOSED: an enforced-but-empty allowlist blocks
// everyone rather than silently doing nothing, because a security control
// that quietly no-ops when misconfigured is worse than one that's visibly
// off.
//
// IMPORTANT DEPLOYMENT NOTE: this reads `req.ip`, which only reflects the
// real client IP if Express trusts the proxy in front of it. main.ts sets
// `app.set('trust proxy', ...)` for exactly this reason — if you change
// your reverse proxy setup, re-check that setting or this guard will see
// your load balancer's IP instead of the admin's.
@Injectable()
export class AdminIpAllowlistGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const enforced = process.env.ADMIN_IP_ALLOWLIST_ENFORCE === 'true';
    if (!enforced) return true;

    const request = context.switchToHttp().getRequest();
    const ip: string = request.ip || request.connection?.remoteAddress || '';

    const envList = (process.env.ADMIN_IP_ALLOWLIST || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const dbEntries = await this.prisma.adminIpAllowlistEntry.findMany({ select: { cidr: true } });
    const allCidrs = [...envList, ...dbEntries.map((e) => e.cidr)];

    if (allCidrs.length === 0) {
      throw new ForbiddenException(
        'ADMIN_IP_ALLOWLIST_ENFORCE is true but no allowlist entries are configured. Set ADMIN_IP_ALLOWLIST or add an entry from a trusted network before enabling enforcement.',
      );
    }

    if (!ip || !ipMatchesAnyCidr(ip, allCidrs)) {
      throw new ForbiddenException('Access to the admin API is not permitted from this network.');
    }

    return true;
  }
}
