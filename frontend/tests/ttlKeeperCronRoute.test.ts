import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockRpc = vi.fn();
const mockFrom = vi.fn();
const mockInsert = vi.fn();
const mockSelect = vi.fn();

vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stellar/stellar-sdk')>();
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      Server: vi.fn().mockImplementation(() => ({
        getLatestLedger: mockRpc.getLatestLedger,
        getContractData: mockRpc.getContractData,
        getAccount: mockRpc.getAccount,
        getHealth: mockRpc.getHealth,
      })),
    },
  };
});

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: mockFrom,
  }),
}));

const ORIGINAL_ENV = { ...process.env };

function makeRequest(headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/cron/ttl-keeper', {
    method: 'GET',
    headers,
  });
}

describe('TTL keeper cron route', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };

    mockFrom.mockReturnValue({
      insert: mockInsert.mockResolvedValue({ error: null }),
      select: mockSelect.mockReturnValue({
        eq: vi.fn().mockReturnValue({
          order: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({ data: [], error: null }),
          }),
        }),
      }),
    });
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('returns 503 when CRON_SECRET is not configured', async () => {
    delete process.env.CRON_SECRET;
    const { GET } = await import('@/app/api/cron/ttl-keeper/route');
    const res = await GET(makeRequest({ authorization: 'Bearer whatever' }));
    expect(res.status).toBe(503);
  });

  it('returns 401 when Authorization header is missing', async () => {
    process.env.CRON_SECRET = 'test-secret';
    const { GET } = await import('@/app/api/cron/ttl-keeper/route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it('returns 401 when bearer token is incorrect', async () => {
    process.env.CRON_SECRET = 'test-secret';
    const { GET } = await import('@/app/api/cron/ttl-keeper/route');
    const res = await GET(makeRequest({ authorization: 'Bearer wrong-secret' }));
    expect(res.status).toBe(401);
  });

  it('produces a correct summary for a mixed success/failure batch', async () => {
    process.env.CRON_SECRET = 'test-secret';

    mockRpc.getLatestLedger = vi.fn().mockResolvedValue({ sequence: 1000 });
    mockRpc.getHealth = vi.fn().mockResolvedValue({ status: 'healthy' });
    mockRpc.getAccount = vi.fn().mockResolvedValue({
      balances: [{ asset_type: 'native', balance: '100.0000000' }],
    });

    let call = 0;
    mockRpc.getContractData = vi.fn().mockImplementation(() => {
      call += 1;
      if (call === 1) {
        return Promise.resolve({
          val: { liveUntilLedgerSeq: () => 900 },
        });
      }
      return Promise.reject(new Error('rpc failure'));
    });

    mockSelect.mockReturnValue({
      eq: vi.fn().mockReturnValue({
        order: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue({
            data: [
              { contract_id: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
              { contract_id: 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' },
            ],
            error: null,
          }),
        }),
      }),
    });

    const { GET } = await import('@/app/api/cron/ttl-keeper/route');
    const res = await GET(makeRequest({ authorization: 'Bearer test-secret' }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toHaveProperty('summary');
    expect(body.summary).toMatchObject({
      total: 2,
      succeeded: 1,
      failed: 1,
    });
  });

  it('flags a low-balance alert when the keeper account is under threshold', async () => {
    process.env.CRON_SECRET = 'test-secret';

    mockRpc.getLatestLedger = vi.fn().mockResolvedValue({ sequence: 1000 });
    mockRpc.getHealth = vi.fn().mockResolvedValue({ status: 'healthy' });
    mockRpc.getAccount = vi.fn().mockResolvedValue({
      balances: [{ asset_type: 'native', balance: '0.5000000' }],
    });
    mockRpc.getContractData = vi.fn().mockResolvedValue({
      val: { liveUntilLedgerSeq: () => 900 },
    });

    mockSelect.mockReturnValue({
      eq: vi.fn().mockReturnValue({
        order: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue({
            data: [{ contract_id: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }],
            error: null,
          }),
        }),
      }),
    });

    const { GET } = await import('@/app/api/cron/ttl-keeper/route');
    const res = await GET(makeRequest({ authorization: 'Bearer test-secret' }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toHaveProperty('lowBalance', true);
  });
});
