# CI remediation

The first GitHub Actions run exposed a Jest/CommonJS incompatibility with the ESM-only `@nestjs/schedule@12` package. The workflow now targets Node 24 and enables Node's experimental VM module support for Jest, as required for this ESM dependency line. Re-run the full suite on this updated branch before treating the result as verified.

The production-readiness guard also intentionally blocks startup while KYC, sanctions/PEP and card issuing are still wired to mock providers.
