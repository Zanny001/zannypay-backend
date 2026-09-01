import { Injectable } from '@nestjs/common';

// Master audit: the only KYC surface in the entire product was
// POST /user/kyc/reveal (a PIN-gated display of already-collected BVN/
// NIN digits) — there was no endpoint or model anywhere for an actual ID
// photo or a selfie/liveness check, despite kycStatus/kycTier implying a
// real verification pipeline exists behind them. This is the pluggable
// seam for a real liveness-check vendor (Smile Identity, Youverify, or
// similar — all common in the Nigerian market specifically).
export interface LivenessResult {
  score: number; // 0–1, provider-defined confidence that the selfie is a live capture of a real person, not a photo-of-a-photo or a static image
  passed: boolean;
}

export interface KycVerificationProvider {
  readonly name: string;
  checkLiveness(selfieUrl: string): Promise<LivenessResult>;
}

// Always "passes" with a fixed score — explicitly not a real liveness
// check. A real deployment MUST set KYC_VERIFICATION_PROVIDER to an
// actual vendor before this score is used to gate anything real; it
// exists so the document-submission flow and the KycDocument.
// livenessScore column have something to populate end-to-end in the
// meantime, not so this mock result gets treated as a real signal.
@Injectable()
export class MockKycVerificationProvider implements KycVerificationProvider {
  readonly name = 'mock';

  async checkLiveness(): Promise<LivenessResult> {
    return { score: 1, passed: true };
  }
}
