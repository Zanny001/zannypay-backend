import { assertProductionReadiness, productionReadinessErrors } from './production-readiness';

const productionEnv = () => ({
  NODE_ENV: 'production',
  REQUIRE_SIGNUP_OTP: 'true',
  OTP_DELIVERY_PROVIDER: 'hybrid',
  CORS_ORIGINS: 'https://admin.example.com',
  STORAGE_DRIVER: 's3',
});

describe('production readiness guard', () => {
  it('allows non-production environments without production-only settings', () => {
    expect(productionReadinessErrors({ NODE_ENV: 'development' })).toEqual([]);
  });

  it('blocks production while mock-only KYC, screening and card issuing adapters remain', () => {
    const errors = productionReadinessErrors(productionEnv());
    expect(errors.join(' ')).toMatch(/KYC verification is wired to a mock provider/);
    expect(errors.join(' ')).toMatch(/Sanctions\/PEP screening is wired to a mock provider/);
    expect(errors.join(' ')).toMatch(/Card issuing is wired to a mock provider/);
    expect(() => assertProductionReadiness(productionEnv())).toThrow(/Refusing production startup/);
  });

  it('requires signup OTP, real OTP delivery, explicit CORS and durable object storage', () => {
    const errors = productionReadinessErrors({
      ...productionEnv(),
      REQUIRE_SIGNUP_OTP: 'false',
      OTP_DELIVERY_PROVIDER: 'mock',
      CORS_ORIGINS: '',
      STORAGE_DRIVER: 'local',
    });
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining('REQUIRE_SIGNUP_OTP'),
      expect.stringContaining('OTP_DELIVERY_PROVIDER'),
      expect.stringContaining('CORS_ORIGINS'),
      expect.stringContaining('STORAGE_DRIVER'),
    ]));
  });
});
