import {
  Controller,
  Get,
  INestApplication,
  Req,
  UseGuards,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { AuthGuard, PassportModule } from '@nestjs/passport';
import request from 'supertest';
import { AuthService } from './auth.service';
import { WebAuthController } from './web-auth.controller';
import { WebSessionGuard } from './web-session.guard';
import { WebSessionService } from './web-session.service';
import { JwtStrategy } from './jwt.strategy';
import { AdminJwtStrategy } from '../admin-auth/admin-jwt.strategy';
import { AdminJwtAuthGuard } from '../admin-auth/admin-jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';

@Controller('customer-probe')
class CustomerProbeController {
  @Get()
  @UseGuards(AuthGuard('jwt'))
  getProfile(@Req() request: any) {
    return request.user;
  }
}

@Controller('admin-probe')
class AdminProbeController {
  @Get()
  @UseGuards(AdminJwtAuthGuard)
  getProfile(@Req() request: any) {
    return request.user;
  }
}

describe('Customer browser session HTTP integration', () => {
  let app: INestApplication;
  let jwt: JwtService;
  let sessions: {
    create: jest.Mock;
    authenticate: jest.Mock;
    getUser: jest.Mock;
    revoke: jest.Mock;
  };
  let authService: { login: jest.Mock; signup: jest.Mock };
  const previousEnv = {
    jwt: process.env.JWT_SECRET,
    adminJwt: process.env.ADMIN_JWT_SECRET,
    origins: process.env.CORS_ORIGINS,
  };
  const allowedOrigin = 'https://zannypay.example.test';
  const browserCookie = 'zannypay_session=opaque-browser-token';

  beforeAll(async () => {
    process.env.JWT_SECRET = 'customer-integration-secret';
    process.env.ADMIN_JWT_SECRET = 'admin-integration-secret';
    process.env.CORS_ORIGINS = allowedOrigin;

    authService = {
      login: jest.fn().mockResolvedValue({
        user: { id: 'customer-1', name: 'Test Customer' },
      }),
      signup: jest.fn(),
    };
    sessions = {
      create: jest.fn().mockResolvedValue({
        token: 'opaque-browser-token',
        expiresAt: new Date(Date.now() + 60_000),
      }),
      authenticate: jest.fn(),
      getUser: jest.fn().mockResolvedValue({
        id: 'customer-1',
        name: 'Test Customer',
        balance: 1000,
      }),
      revoke: jest.fn().mockResolvedValue(undefined),
    };

    const prisma = {
      adminUser: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'admin-1',
          isActive: true,
          name: 'Test Admin',
          email: 'admin@example.test',
          role: 'SUPER_ADMIN',
        }),
      },
      adminSession: { findUnique: jest.fn() },
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        PassportModule,
        JwtModule.register({
          secret: process.env.JWT_SECRET,
          signOptions: { expiresIn: '5m' },
        }),
      ],
      controllers: [
        WebAuthController,
        CustomerProbeController,
        AdminProbeController,
      ],
      providers: [
        JwtStrategy,
        AdminJwtStrategy,
        AdminJwtAuthGuard,
        { provide: AuthService, useValue: authService },
        { provide: PrismaService, useValue: prisma },
        {
          provide: WebSessionService,
          useFactory: (jwtService: JwtService) => {
            sessions.authenticate.mockImplementation(async (token: string) => {
              if (token !== 'opaque-browser-token') return null;
              return {
                accessToken: await jwtService.signAsync({
                  sub: 'customer-1',
                  phone: '+2348000000000',
                }),
                userId: 'customer-1',
              };
            });
            return sessions;
          },
          inject: [JwtService],
        },
        { provide: APP_GUARD, useClass: WebSessionGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
    jwt = moduleRef.get(JwtService);
  });

  afterAll(async () => {
    await app?.close();
    if (previousEnv.jwt === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousEnv.jwt;
    if (previousEnv.adminJwt === undefined)
      delete process.env.ADMIN_JWT_SECRET;
    else process.env.ADMIN_JWT_SECRET = previousEnv.adminJwt;
    if (previousEnv.origins === undefined) delete process.env.CORS_ORIGINS;
    else process.env.CORS_ORIGINS = previousEnv.origins;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    authService.login.mockResolvedValue({
      user: { id: 'customer-1', name: 'Test Customer' },
    });
    sessions.create.mockResolvedValue({
      token: 'opaque-browser-token',
      expiresAt: new Date(Date.now() + 60_000),
    });
    sessions.getUser.mockResolvedValue({
      id: 'customer-1',
      name: 'Test Customer',
      balance: 1000,
    });
    sessions.authenticate.mockImplementation(async (token: string) => {
      if (token !== 'opaque-browser-token') return null;
      return {
        accessToken: await jwt.signAsync({
          sub: 'customer-1',
          phone: '+2348000000000',
        }),
        userId: 'customer-1',
      };
    });
  });

  it('logs in through the browser endpoint and issues a protected cookie', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/web/login')
      .set('Origin', allowedOrigin)
      .send({ phone: '+2348000000000', pin: '1234' })
      .expect(200);

    expect(response.body.user.id).toBe('customer-1');
    expect(response.body.access_token).toBeUndefined();
    const setCookie = response.headers['set-cookie'] as string[];
    expect(setCookie[0]).toContain('zannypay_session=opaque-browser-token');
    expect(setCookie[0]).toContain('HttpOnly');
    expect(setCookie[0]).toContain('Secure');
    expect(setCookie[0]).toContain('SameSite=Lax');
    expect(setCookie[0]).toContain('Path=/api/v1');
  });

  it('restores the customer session after a browser reload', async () => {
    const response = await request(app.getHttpServer())
      .get('/auth/web/session')
      .set('Cookie', browserCookie)
      .expect(200);

    expect(response.body).toEqual({
      authenticated: true,
      user: {
        id: 'customer-1',
        name: 'Test Customer',
        balance: 1000,
      },
    });
    expect(sessions.getUser).toHaveBeenCalledWith('opaque-browser-token');
  });

  it('authorizes customer API routes through the cookie without exposing a JWT', async () => {
    const response = await request(app.getHttpServer())
      .get('/customer-probe')
      .set('Cookie', browserCookie)
      .expect(200);

    expect(response.body).toEqual({
      userId: 'customer-1',
      phone: '+2348000000000',
    });
  });

  it('preserves native bearer-token authentication when no browser cookie exists', async () => {
    const nativeToken = await jwt.signAsync({
      sub: 'native-customer',
      phone: '+2348111111111',
    });

    const response = await request(app.getHttpServer())
      .get('/customer-probe')
      .set('Authorization', `Bearer ${nativeToken}`)
      .expect(200);

    expect(response.body).toEqual({
      userId: 'native-customer',
      phone: '+2348111111111',
    });
  });

  it('does not allow a customer browser session to authenticate an admin route', async () => {
    await request(app.getHttpServer())
      .get('/admin-probe')
      .set('Cookie', browserCookie)
      .expect(401);
  });

  it('rejects browser login from an unconfigured origin', async () => {
    await request(app.getHttpServer())
      .post('/auth/web/login')
      .set('Origin', 'https://attacker.example')
      .send({ phone: '+2348000000000', pin: '1234' })
      .expect(403);

    expect(authService.login).not.toHaveBeenCalled();
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it('revokes the browser session and clears its cookie on logout', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/web/logout')
      .set('Origin', allowedOrigin)
      .set('Cookie', browserCookie)
      .expect(200);

    expect(response.body).toEqual({ success: true });
    expect(sessions.revoke).toHaveBeenCalledWith('opaque-browser-token');
    expect(response.headers['set-cookie'][0]).toContain(
      'zannypay_session=;',
    );
  });
});
