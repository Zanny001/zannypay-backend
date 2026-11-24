import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  GatewayTimeoutException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';

type VtpassPayload = Record<string, unknown>;
type VtpassResponse = Record<string, any>;

@Injectable()
export class VtpassClient {
  private readonly logger = new Logger(VtpassClient.name);
  private readonly baseUrl = 'https://sandbox.vtpass.com/api';

  private credentials(method: 'GET' | 'POST') {
    const { VTPASS_API_KEY, VTPASS_PUBLIC_KEY, VTPASS_SECRET_KEY } =
      process.env;
    const missingGetCredentials = !VTPASS_API_KEY || !VTPASS_PUBLIC_KEY;
    const missingPostCredentials =
      !VTPASS_API_KEY || !VTPASS_SECRET_KEY;
    if (method === 'GET' ? missingGetCredentials : missingPostCredentials) {
      throw new ServiceUnavailableException(
        'VTpass sandbox credentials for this request are not fully configured.',
      );
    }
    return {
      apiKey: VTPASS_API_KEY!,
      publicKey: VTPASS_PUBLIC_KEY!,
      secretKey: VTPASS_SECRET_KEY!,
    };
  }

  private async request(
    path: string,
    method: 'GET' | 'POST',
    payload?: VtpassPayload,
  ): Promise<VtpassResponse> {
    const credentials = this.credentials(method);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'api-key': credentials.apiKey,
      ...(method === 'GET'
        ? { 'public-key': credentials.publicKey }
        : { 'secret-key': credentials.secretKey }),
    };

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/${path}`, {
        method,
        headers,
        ...(payload ? { body: JSON.stringify(payload) } : {}),
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new GatewayTimeoutException(
          'VTpass did not respond in time. The transaction must be checked before retrying.',
        );
      }
      this.logger.warn(`VTpass network error on ${path}: ${error instanceof Error ? error.name : 'unknown'}`);
      throw new ServiceUnavailableException('VTpass is temporarily unreachable.');
    }

    if (!response.ok) {
      this.logger.warn(`VTpass returned HTTP ${response.status} for ${path}`);
      throw new ServiceUnavailableException('VTpass could not process the request.');
    }

    try {
      return (await response.json()) as VtpassResponse;
    } catch {
      throw new ServiceUnavailableException('VTpass returned an invalid response.');
    }
  }

  assertPurchaseConfigured() {
    this.credentials('POST');
  }

  getServices(identifier: string) {
    if (!/^[a-z][a-z0-9-]{1,30}$/i.test(identifier)) {
      throw new ServiceUnavailableException('Invalid VTpass service category.');
    }
    return this.request(
      `services?identifier=${encodeURIComponent(identifier)}`,
      'GET',
    );
  }

  getServiceVariations(serviceId: string) {
    if (!/^[a-z0-9-]{2,80}$/i.test(serviceId)) {
      throw new ServiceUnavailableException('Invalid VTpass service identifier.');
    }
    return this.request(`service-variations?serviceID=${encodeURIComponent(serviceId)}`, 'GET');
  }

  verifyCustomer(payload: VtpassPayload) {
    return this.request('merchant-verify', 'POST', payload);
  }

  purchase(payload: VtpassPayload) {
    return this.request('pay', 'POST', payload);
  }

  requery(requestId: string) {
    return this.request('requery', 'POST', { request_id: requestId });
  }

  createRequestId(now = new Date()): string {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Lagos',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const value = (type: string) =>
      parts.find((part) => part.type === type)?.value ?? '';
    const prefix =
      value('year') +
      value('month') +
      value('day') +
      value('hour') +
      value('minute');
    return prefix + randomBytes(5).toString('hex').toUpperCase();
  }
}
