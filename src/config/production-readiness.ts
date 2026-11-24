type Env = Record<string, string | undefined>;

/**
 * Refuse a real-money production deployment while this source tree still
 * wires mock identity/sanctions/card-issuing adapters. Environment flags
 * cannot turn a mock implementation into a licensed provider.
 */
export function productionReadinessErrors(env: Env = process.env): string[] {
  if (env.NODE_ENV !== 'production') return [];
  const errors: string[] = [];

  errors.push('KYC verification is wired to a mock provider; integrate and contract a real provider before production.');
  errors.push('Sanctions/PEP screening is wired to a mock provider; integrate and contract a real provider before production.');
  errors.push('Card issuing is wired to a mock provider; integrate a licensed issuer before production.');

  if (env.REQUIRE_SIGNUP_OTP !== 'true') {
    errors.push('REQUIRE_SIGNUP_OTP must be true in production.');
  }
  if ((env.OTP_DELIVERY_PROVIDER || 'hybrid') === 'mock') {
    errors.push('OTP_DELIVERY_PROVIDER cannot be mock in production.');
  }
  if (!env.CORS_ORIGINS?.split(',').map((value) => value.trim()).filter(Boolean).length) {
    errors.push('CORS_ORIGINS must contain the explicit admin/customer web origins in production.');
  }
  if (!env.PAYSTACK_SECRET_KEY) {
    errors.push('PAYSTACK_SECRET_KEY must be configured for signed Paystack webhook verification in production.');
  }
  if (env.STORAGE_DRIVER !== 's3') {
    errors.push('STORAGE_DRIVER must be s3 in production; local/inline storage is not durable multi-instance storage.');
  }

  return errors;
}

export function assertProductionReadiness(env: Env = process.env): void {
  const errors = productionReadinessErrors(env);
  if (errors.length) {
    throw new Error(
      `Refusing production startup: ${errors.length} production-readiness blocker(s):\n- ${errors.join('\n- ')}`,
    ); }
}
