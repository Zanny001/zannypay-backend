import { createHash } from 'crypto';
import * as bcrypt from 'bcrypt';
import { WebSessionService } from './web-session.service';

describe('WebSessionService', () => {
  const tx = {
    $queryRaw: jest.fn(),
    webSession: { create: jest.fn() },
  };
  const prisma = {
    $transaction: jest.fn(),
    webSession: {
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
    tx.$queryRaw.mockResolvedValue([
      { id: 'user-1', pin: 'unused-hash', deletedAt: null },
    ]);
    prisma.$transaction.mockImplementation((callback) => callback(tx));
    service = new WebSessionService(prisma as any, jwtService as any);
  });

  it('stores only a hash of a random browser session secret', async () => {
    tx.webSession.create.mockResolvedValue({});
    const result = await service.create('user-1', {
      headers: { 'user-agent': 'test-browser' },
      ip: '127.0.0.1',
    });

    expect(result.token).toHaveLength(43);
    expect(tx.webSession.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user-1',
        tokenHash: createHash('sha256').update(result.token).digest('hex'),
        userAgent: 'test-browser',
        ipAddress: '127.0.0.1',
        expiresAt: expect.any(Date),
      }),
    });
    expect(tx.webSession.create.mock.calls[0][0].data.tokenHash).not.toBe(
      result.token,
    );
  });

  it('rejects browser session creation if the PIN changed after initial login verification', async () => {
    const currentPinHash = await bcrypt.hash('2468', 4);
    tx.$queryRaw.mockResolvedValue([
      { id: 'user-1', pin: currentPinHash, deletedAt: null },
    ]);

    await expect(
      service.create(
        'user-1',
        { headers: {}, ip: '127.0.0.1' },
        '1357',
      ),
    ).rejects.toThrow('Your PIN changed during sign-in. Please try again.');

    expect(tx.webSession.create).not.toHaveBeenCalled();
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
