import { VtpassClient } from './vtpass.client';

describe('VtpassClient', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      VTPASS_API_KEY: 'test-api-key',
      VTPASS_PUBLIC_KEY: 'test-public-key',
      VTPASS_SECRET_KEY: 'test-secret-key',
    };
    global.fetch = jest.fn() as jest.Mock;
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  it('uses the sandbox base URL and public key for GET catalogue calls', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ response_description: '000', content: [] }),
    });
    await new VtpassClient().getServices('data');
    expect(global.fetch).toHaveBeenCalledWith(
      'https://sandbox.vtpass.com/api/services?identifier=data',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          'api-key': 'test-api-key',
          'public-key': 'test-public-key',
        }),
      }),
    );
  });

  it('uses the secret key for POST requests', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ code: '000' }),
    });
    await new VtpassClient().requery('202611241925ABCDEF1234');
    expect(global.fetch).toHaveBeenCalledWith(
      'https://sandbox.vtpass.com/api/requery',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'api-key': 'test-api-key',
          'secret-key': 'test-secret-key',
        }),
        body: JSON.stringify({ request_id: '202611241925ABCDEF1234' }),
      }),
    );
  });

  it('fails closed when credentials are missing', async () => {
    delete process.env.VTPASS_PUBLIC_KEY;
    await expect(new VtpassClient().getServices('data')).rejects.toThrow(
      'VTpass sandbox credentials for this request are not fully configured.',
    );
  });

  it('does not require the POST secret key for read-only catalogue requests', async () => {
    delete process.env.VTPASS_SECRET_KEY;
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ response_description: '000', content: [] }),
    });
    await expect(new VtpassClient().getServices('airtime')).resolves.toBeDefined();
  });

  it('rejects malformed service identifiers before making a request', async () => {
    expect(() => new VtpassClient().getServices('../pay')).toThrow(
      'Invalid VTpass service category.',
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('loads product variations from the documented service-variations endpoint', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ response_description: '000', content: { variations: [] } }),
    });
    await new VtpassClient().getServiceVariations('gotv');
    expect(global.fetch).toHaveBeenCalledWith(
      'https://sandbox.vtpass.com/api/service-variations?serviceID=gotv',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('generates a request ID with a Lagos timestamp prefix and unique suffix', () => {
    const id = new VtpassClient().createRequestId(new Date('2026-11-24T18:25:00.000Z'));
    expect(id).toMatch(/^202611241925[A-F0-9]{10}$/);
  });
});
