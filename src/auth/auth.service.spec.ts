import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { OtpService, OTP_PURPOSES } from '../otp/otp.service';

describe('AuthService', () => {
  let service: AuthService;
  const prisma = {
    user: {
      findUnique: jest.fn(),
    },
  };
  const otp = {
    consumeVerifiedCode: jest.fn(),
    verifyCode: jest.fn(),
    requestCode: jest.fn(),
    hasVerifiedCode: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma.user.findUnique.mockResolvedValue({ id: 'user-1' });
    otp.requestCode.mockResolvedValue({ sent: true, expiresInSeconds: 600 });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: JwtService,
          useValue: { sign: jest.fn(), verify: jest.fn() },
        },
        { provide: AnalyticsService, useValue: { track: jest.fn() } },
        { provide: OtpService, useValue: otp },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('accepts a valid email address and normalizes the OTP target', async () => {
    await expect(
      service.requestOtp({
        target: 'Person@Example.com',
        purpose: OTP_PURPOSES.EMAIL_VERIFICATION,
      }),
    ).resolves.toEqual({ sent: true, expiresInSeconds: 600 });

    expect(otp.requestCode).toHaveBeenCalledWith(
      'person@example.com',
      OTP_PURPOSES.EMAIL_VERIFICATION,
    );
  });

  it('rejects malformed email addresses before requesting delivery', async () => {
    await expect(
      service.requestOtp({
        target: 'not-an-email',
        purpose: OTP_PURPOSES.EMAIL_VERIFICATION,
      }),
    ).rejects.toThrow('A valid email address is required.');

    expect(otp.requestCode).not.toHaveBeenCalled();
  });

  it('rejects email addresses submitted for phone OTP purposes', async () => {
    await expect(
      service.requestOtp({
        target: 'person@example.com',
        purpose: OTP_PURPOSES.SIGNUP_VERIFICATION,
      }),
    ).rejects.toThrow('A valid phone number is required.');

    expect(otp.requestCode).not.toHaveBeenCalled();
  });
});
