import { createHash } from 'crypto';
import { WebSessionService } from './web-session.service';

describe('WebSessionService', () => {
  const prisma = {
    webSession: {
      create: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
  };
  const jwtService = {
    signAsync: jest.fn().mockResolvedValue('short-lived-api-jwt'),
  };
  let service: WebSessionService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new WebSessionService(prisma as any, jwtService as any);
  });

  it('stores only a hash of a random browser session secret', async () => {
    prisma.webSession.create.mockResolvedValue({});
    const result = await service.create('user-1', {
      headers: { 'user-agent': 'test-browser' },
      ip: '127.0.0.1',
    });

    expect(result.token).toHaveLength(43);
    expect(prisma.webSession.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user-1',
        tokenHash: createHash('sha256').update(result.token).digest('hex'),
        userAgent: 'test-browser',
        ipAddress: '127.0.0.1',
        expiresAt: expect.any(Date),
      }),
    });
    expect(prisma.webSession.create.mock.calls[0][0].data.tokenHash).not.toBe(
      result.token,
    );
  });

  it('exchanges a valid opaque session for a server-side bearer token', async () => {
    prisma.webSession.findUnique.mockResolvedValue({
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      user: { id: 'user-1', phone: '+2348000000000', deletedAt: null },
    });

    const result = await service.authenticate('opaque-cookie-secret');

    expect(result).toEqual({
      accessToken: 'short-lived-api-jwt',
      userId: 'user-1',
    });
    expect(jwtService.signAsync).toHaveBeenCalledWith({
      sub: 'user-1',
      phone: '+2348000000000',
    });
  });

  it('rejects revoked sessions', async () => {
    prisma.webSession.findUnique.mockResolvedValue({
      revokedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      user: { id: 'user-1', phone: 'phone', deletedAt: null },
    });

    await expect(
      service.authenticate('opaque-cookie-secret'),
    ).resolves.toBeNull();
    expect(jwtService.signAsync).not.toHaveBeenCalled();
  });

  it('rejects expired sessions', async () => {
    prisma.webSession.findUnique.mockResolvedValue({
      revokedAt: null,
      expiresAt: new Date(Date.now() - 60_000),
      user: { id: 'user-1', phone: 'phone', deletedAt: null },
    });

    await expect(
      service.authenticate('opaque-cookie-secret'),
    ).resolves.toBeNull();
    expect(jwtService.signAsync).not.toHaveBeenCalled();
  });

  it('rejects sessions belonging to deleted users', async () => {
    prisma.webSession.findUnique.mockResolvedValue({
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      user: { id: 'user-1', phone: 'phone', deletedAt: new Date() },
    });

    await expect(
      service.authenticate('opaque-cookie-secret'),
    ).resolves.toBeNull();
    expect(jwtService.signAsync).not.toHaveBeenCalled();
  });

  it('revokes a session by its hash, never by the raw cookie secret', async () => {
    prisma.webSession.updateMany.mockResolvedValue({ count: 1 });
    const token = 'opaque-cookie-secret';

    await service.revoke(token);

    expect(prisma.webSession.updateMany).toHaveBeenCalledWith({
      where: {
        tokenHash: createHash('sha256').update(token).digest('hex'),
        revokedAt: null,
      },
      data: { revokedAt: expect.any(Date) },
    });
  });
});
