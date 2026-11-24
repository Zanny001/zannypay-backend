import { Injectable, ServiceUnavailableException } from '@nestjs/common';

// A real liveness adapter must replace this development-only implementation
// before KYC selfie checks can be used for production identity decisions.
export interface LivenessResult {
  score: number;
  passed: boolean;
}

export interface KycVerificationProvider {
  readonly name: string;
  checkLiveness(selfieUrl: string): Promise<LivenessResult>;
}

@Injectable()
export class MockKycVerificationProvider implements KycVerificationProvider {
  readonly name = 'mock';

  async checkLiveness(): Promise<LivenessResult> {
    // Never turn a synthetic "pass" into a real customer's KYC approval.
    if (process.env.NODE_ENV === 'production') {
      throw new ServiceUnavailableException(
        'Selfie liveness verification is not configured. Please try again later.',
      );
    }

    return { score: 1, passed: true };
  }
}
