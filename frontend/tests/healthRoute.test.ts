import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* ── Hoisted mocks ───────────────────────────────────────────────────────────── */

const {
    mockSimulateTransaction,
    mockScValToNative,
    mockRuntimeConfig,
} = vi.hoisted(() => ({
    mockSimulateTransaction: vi.fn(),
    mockScValToNative: vi.fn(),
    mockRuntimeConfig: {
        contracts: {
            CREDENTIAL_NFT: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
        },
        stellar: {
            sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
            networkPassphrase: 'Test SDF Network ; September 2015',
            networkName: 'testnet',
        },
        supabase: {
            url: 'https://example.supabase.co',
            anonKey: 'test-anon-key',
        },
        ipfs: {
            gatewayUrl: 'https://gateway.pinata.cloud',
        },
    },
}));

vi.mock('@stellar/stellar-sdk', () => {
    class MockServer {
        simulateTransaction = mockSimulateTransaction;
    }

    class MockContract {
        call = vi.fn(() => ({ type: 'invokeHostFunction' }));
    }

    class MockAccount {
        constructor(
            public accountId: string,
            public sequence: string,
        ) {}
    }

    class MockTransactionBuilder {
        addOperation() {
            return this;
        }
        setTimeout() {
            return this;
        }
        build() {
            return { built: true };
        }
    }

    return {
        rpc: { Server: MockServer },
        Contract: MockContract,
        Account: MockAccount,
        TransactionBuilder: MockTransactionBuilder,
        TimeoutInfinite: 0,
        scValToNative: mockScValToNative,
        xdr: {
            ScVal: {
                fromXDR: vi.fn((val: string) => ({ xdr: val })),
            },
        },
    };
});

vi.mock('@/lib/runtimeConfig', () => ({
    runtimeConfig: mockRuntimeConfig,
}));

import { GET } from '../src/app/api/health/route';

/* ── Helpers ─────────────────────────────────────────────────────────────────── */

function resetDefaultConfig() {
    mockRuntimeConfig.contracts.CREDENTIAL_NFT =
        'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
    mockRuntimeConfig.stellar.sorobanRpcUrl = 'https://soroban-testnet.stellar.org';
    mockRuntimeConfig.stellar.networkPassphrase = 'Test SDF Network ; September 2015';
    mockRuntimeConfig.stellar.networkName = 'testnet';
    mockRuntimeConfig.supabase.url = 'https://example.supabase.co';
    mockRuntimeConfig.supabase.anonKey = 'test-anon-key';
    mockRuntimeConfig.ipfs.gatewayUrl = 'https://gateway.pinata.cloud';
}

function mockHealthyProbes() {
    mockSimulateTransaction.mockResolvedValue({
        result: { retval: 'base64-scval' },
    });
    mockScValToNative.mockReturnValue({ name: 'CertChainNFT', version: '2.0.0' });

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL) => {
            const url = String(input);
            if (url.includes('/rest/v1/')) {
                return new Response(null, { status: 200, statusText: 'OK' });
            }
            if (url.includes('/ipfs/')) {
                return new Response(null, { status: 200, statusText: 'OK' });
            }
            return new Response(null, { status: 404, statusText: 'Not Found' });
        }),
    );
}

/* ── Tests ───────────────────────────────────────────────────────────────────── */

describe('GET /api/health', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetDefaultConfig();
        mockHealthyProbes();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('returns 200 with status healthy when all dependencies are healthy', async () => {
        const response = await GET();

        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.status).toBe('healthy');
        expect(body.network).toBe('testnet');
        expect(body.contractId).toBe(mockRuntimeConfig.contracts.CREDENTIAL_NFT);
        expect(typeof body.timestamp).toBe('string');
        expect(body.dependencies.sorobanRpc).toMatchObject({
            status: 'healthy',
            detail: 'CertChainNFT @ 2.0.0',
        });
        expect(body.dependencies.supabase).toMatchObject({
            status: 'healthy',
            detail: 'HTTP 200',
        });
        expect(body.dependencies.ipfsGateway).toMatchObject({
            status: 'healthy',
            detail: 'HTTP 200',
        });
    });

    it('treats Supabase 404 as healthy and returns 200 when other probes are healthy', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: string | URL) => {
                const url = String(input);
                if (url.includes('/rest/v1/')) {
                    return new Response(null, { status: 404, statusText: 'Not Found' });
                }
                return new Response(null, { status: 200, statusText: 'OK' });
            }),
        );

        const response = await GET();

        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.status).toBe('healthy');
        expect(body.dependencies.supabase).toMatchObject({
            status: 'healthy',
            detail: 'HTTP 404',
        });
    });

    it('returns 207 with status degraded when one dependency is degraded', async () => {
        mockSimulateTransaction.mockResolvedValue({
            error: 'HostError: contract not found',
        });

        const response = await GET();

        expect(response.status).toBe(207);
        const body = await response.json();
        expect(body.status).toBe('degraded');
        expect(body.dependencies.sorobanRpc).toMatchObject({
            status: 'degraded',
            detail: 'Simulation error: HostError: contract not found',
        });
        expect(body.dependencies.supabase.status).toBe('healthy');
        expect(body.dependencies.ipfsGateway.status).toBe('healthy');
    });

    it('returns 207 with status degraded when one dependency is unreachable and others are healthy', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: string | URL) => {
                const url = String(input);
                if (url.includes('/ipfs/')) {
                    throw new Error('ECONNREFUSED');
                }
                return new Response(null, { status: 200, statusText: 'OK' });
            }),
        );

        const response = await GET();

        expect(response.status).toBe(207);
        const body = await response.json();
        expect(body.status).toBe('degraded');
        expect(body.dependencies.sorobanRpc.status).toBe('healthy');
        expect(body.dependencies.supabase.status).toBe('healthy');
        expect(body.dependencies.ipfsGateway).toMatchObject({
            status: 'unreachable',
            detail: 'ECONNREFUSED',
        });
    });

    it('returns 207 with status degraded when dependencies are unconfigured', async () => {
        mockRuntimeConfig.contracts.CREDENTIAL_NFT = '';
        mockRuntimeConfig.supabase.url = '';
        mockRuntimeConfig.ipfs.gatewayUrl = '';

        const response = await GET();

        expect(response.status).toBe(207);
        const body = await response.json();
        expect(body.status).toBe('degraded');
        expect(body.dependencies.sorobanRpc.status).toBe('degraded');
        expect(body.dependencies.supabase.status).toBe('degraded');
        expect(body.dependencies.ipfsGateway.status).toBe('degraded');
    });

    it('returns 503 with status unhealthy when all dependencies are unreachable', async () => {
        mockSimulateTransaction.mockRejectedValue(new Error('RPC unreachable'));
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                throw new Error('Network down');
            }),
        );

        const response = await GET();

        expect(response.status).toBe(503);
        const body = await response.json();
        expect(body.status).toBe('unhealthy');
        expect(body.dependencies.sorobanRpc).toMatchObject({
            status: 'unreachable',
            detail: 'RPC unreachable',
        });
        expect(body.dependencies.supabase).toMatchObject({
            status: 'unreachable',
            detail: 'Network down',
        });
        expect(body.dependencies.ipfsGateway).toMatchObject({
            status: 'unreachable',
            detail: 'Network down',
        });
    });
});
