import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { WebSessionGuard } from './web-session.guard';

function makeContext(request: any): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as any;
}

describe('WebSessionGuard', () => {
  let guard: WebSessionGuard;
  let sessions: { authenticate: jest.Mock };

  beforeEach(() => {
    sessions = { authenticate: jest.fn() };
    guard = new WebSessionGuard(sessions as any);
    process.env.CORS_ORIGINS = 'https://app.example.test,https://preview.example.test';
  });

  afterEach(() => {
    delete process.env.CORS_ORIGINS;
  });

  it('defers to the existing bearer-token guards when no browser cookie exists', async () => {
    const request = { headers: { authorization: 'Bearer native-token' }, method: 'GET' };

    await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);

    expect(request.headers.authorization).toBe('Bearer native-token');
    expect(sessions.authenticate).not.toHaveBeenCalled();
  });

  it('exchanges a valid browser cookie for the existing JWT authentication path', async () => {
    sessions.authenticate.mockResolvedValue({
      accessToken: 'server-issued-jwt',
      userId: 'user-1',
    });
    const request = {
      headers: { cookie: 'other=value; zannypay_session=opaque%2Bsecret' },
      method: 'GET',
    };

    await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);

    expect(sessions.authenticate).toHaveBeenCalledWith('opaque+secret');
    expect(request.headers.authorization).toBe('Bearer server-issued-jwt');
  });

  it('does not authenticate an invalid or expired browser cookie', async () => {
    sessions.authenticate.mockResolvedValue(null);
    const request = {
      headers: { cookie: 'zannypay_session=expired-secret' },
      method: 'GET',
    };

    await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);

    expect(request.headers.authorization).toBeUndefined();
  });

  it('rejects state-changing cookie requests without an allowed Origin', async () => {
    const request = {
      headers: { cookie: 'zannypay_session=opaque-secret', origin: 'https://evil.example' },
      method: 'POST',
    };

    await expect(guard.canActivate(makeContext(request))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(sessions.authenticate).not.toHaveBeenCalled();
  });

  it('allows state-changing cookie requests from an exact configured Origin', async () => {
    sessions.authenticate.mockResolvedValue({
      accessToken: 'server-issued-jwt',
      userId: 'user-1',
    });
    const request = {
      headers: {
        cookie: 'zannypay_session=opaque-secret',
        origin: 'https://app.example.test',
      },
      method: 'POST',
    };

    await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);

    expect(sessions.authenticate).toHaveBeenCalledWith('opaque-secret');
    expect(request.headers.authorization).toBe('Bearer server-issued-jwt');
  });

  it('does not require an Origin header for safe read-only requests', async () => {
    sessions.authenticate.mockResolvedValue({
      accessToken: 'server-issued-jwt',
      userId: 'user-1',
    });
    const request = {
      headers: { cookie: 'zannypay_session=opaque-secret' },
      method: 'GET',
    };

    await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);
    expect(request.headers.authorization).toBe('Bearer server-issued-jwt');
  });
});
