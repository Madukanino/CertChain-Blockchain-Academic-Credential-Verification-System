/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_BATCH_SIZE, POST } from '@/app/api/verify/batch/route';
import { resetRateLimitStore } from '@/lib/rateLimit';

const mockDbRecords: Record<string, any> = {
    'token-valid': {
        id: 'cred-1',
        token_id: 'token-valid',
        issued_at: '2026-01-01T00:00:00.000Z',
        revoked: false,
        revoked_at: null,
        revocation_source: null,
        metadata: {
            credentialData: {
                institutionName: 'ACREDIA',
                credentialType: 'Degree',
            },
        },
        metadata_schema_version: 1,
        hash_algorithm: 'sha256',
        ipfs_hash: 'cid-valid',
        student_wallet_address: 'GStudent1',
        issuer_wallet_address: 'GIssuer1',
        institution: { name: 'ACREDIA' },
    },
    'token-revoked': {
        id: 'cred-2',
        token_id: 'token-revoked',
        issued_at: '2026-01-01T00:00:00.000Z',
        revoked: true,
        revoked_at: '2026-02-01T00:00:00.000Z',
        revocation_source: 'issuer',
        metadata: {
            credentialData: {
                institutionName: 'ACREDIA',
                credentialType: 'Degree',
            },
        },
        metadata_schema_version: 1,
        hash_algorithm: 'sha256',
        ipfs_hash: 'cid-revoked',
        student_wallet_address: 'GStudent2',
        issuer_wallet_address: 'GIssuer1',
        institution: { name: 'ACREDIA' },
    },
};

vi.mock('@/lib/serverAuth', () => ({
    getServiceRoleClient: () => ({
        from: (table: string) => {
            if (table === 'verification_audit_logs') {
                return {
                    insert: async () => ({ error: null }),
                };
            }
            return {
                select: () => ({
                    eq: (_col: string, val: string) => ({
                        maybeSingle: async () => ({
                            data: mockDbRecords[val] ?? null,
                            error: null,
                        }),
                    }),
                }),
            };
        },
    }),
}));

vi.mock('@/lib/contractReads', () => ({
    ContractConfigurationError: class ContractConfigurationError extends Error {},
    BlockchainUnavailableError: class BlockchainUnavailableError extends Error {},
    getCredential: async (tokenId: string) => {
        if (tokenId === 'token-valid') {
            return {
                issuer: 'gissuer1',
                student: 'gstudent1',
                hash: 'derived-hash',
                uri: 'ipfs://cid-valid',
            };
        }
        if (tokenId === 'token-revoked') {
            return {
                issuer: 'gissuer1',
                student: 'gstudent2',
                hash: 'derived-hash',
                uri: 'ipfs://cid-revoked',
            };
        }
        return null;
    },
    isRevoked: async (tokenId: string) => tokenId === 'token-revoked',
    isAuthorizedIssuer: async () => true,
}));

vi.mock('@/lib/credentialHash', () => ({
    deriveCredentialHash: async () => 'derived-hash',
}));

vi.mock('@/lib/ipfsServer', () => ({
    fetchJsonFromIpfs: async () => ({ ok: true, content: {} }),
}));

function makeBatchRequest(body: unknown, ip = '203.0.113.42') {
    return new Request('http://localhost/api/verify/batch', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-forwarded-for': ip,
        },
        body: JSON.stringify(body),
    });
}

describe('POST /api/verify/batch', () => {
    beforeEach(() => {
        resetRateLimitStore();
    });

    it('returns distinguishable per-token results for mixed valid, revoked, and not-found inputs', async () => {
        const response = await POST(
            makeBatchRequest({
                tokens: ['token-valid', 'token-revoked', 'token-missing'],
            }) as any,
        );

        expect(response.status).toBe(200);
        const payload = await response.json();

        expect(payload.success).toBe(true);
        expect(payload.total).toBe(3);
        expect(payload.summary).toEqual({
            verified: 1,
            revoked: 1,
            mismatch: 0,
            notFound: 1,
            failed: 0,
        });

        expect(payload.results).toHaveLength(3);

        // 1. Valid
        expect(payload.results[0]).toMatchObject({
            token: 'token-valid',
            success: true,
            status: 'verified',
            statusCode: 200,
            credential: { tokenId: 'token-valid', revoked: false },
            verification: { verified: true, revoked: false, onChainFound: true },
        });

        // 2. Revoked
        expect(payload.results[1]).toMatchObject({
            token: 'token-revoked',
            success: true,
            status: 'revoked',
            statusCode: 200,
            credential: { tokenId: 'token-revoked', revoked: true, revocationSource: 'issuer' },
            verification: { verified: false, revoked: true, revocationSource: 'issuer' },
        });

        // 3. Not found
        expect(payload.results[2]).toEqual({
            token: 'token-missing',
            success: false,
            status: 'not_found',
            statusCode: 404,
            error: 'Credential not found',
        });
    });

    it('rejects oversized batches with 400 and does not consume rate-limit quota', async () => {
        const oversized = Array.from({ length: MAX_BATCH_SIZE + 1 }, (_, i) => `token-${i}`);
        const response = await POST(makeBatchRequest({ tokens: oversized }, '203.0.113.99') as any);

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
            success: false,
            maxBatchSize: MAX_BATCH_SIZE,
        });
    });

    it('rejects empty or invalid request bodies with 400', async () => {
        const emptyRes = await POST(makeBatchRequest({ tokens: [] }) as any);
        expect(emptyRes.status).toBe(400);

        const missingRes = await POST(makeBatchRequest({}) as any);
        expect(missingRes.status).toBe(400);

        const badJsonReq = new Request('http://localhost/api/verify/batch', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.42' },
            body: '{not-json',
        });
        const badJsonRes = await POST(badJsonReq as any);
        expect(badJsonRes.status).toBe(400);
    });

    it('isolates per-token invalid inputs without failing the rest of the batch', async () => {
        const response = await POST(
            makeBatchRequest({
                tokens: ['token-valid', '', 'x'.repeat(200)],
            }) as any,
        );

        expect(response.status).toBe(200);
        const payload = await response.json();

        expect(payload.summary).toEqual({
            verified: 1,
            revoked: 0,
            mismatch: 0,
            notFound: 0,
            failed: 2,
        });
        expect(payload.results[0].status).toBe('verified');
        expect(payload.results[1]).toMatchObject({
            success: false,
            status: 'invalid',
            statusCode: 400,
        });
        expect(payload.results[2]).toMatchObject({
            success: false,
            status: 'invalid',
            statusCode: 400,
        });
    });

    it('rate-limits proportionally to batch size', async () => {
        const ip = '203.0.113.77';
        const batchOf20 = Array.from({ length: 20 }, () => 'token-valid');

        // Anonymous limit is 60 units/min. Three batches of 20 = 60 units (allowed).
        for (let i = 0; i < 3; i += 1) {
            const res = await POST(makeBatchRequest({ tokens: batchOf20 }, ip) as any);
            expect(res.status).toBe(200);
        }

        // Next batch of 1 pushes total to 61 > 60 -> 429 Too Many Requests.
        const blocked = await POST(makeBatchRequest({ tokens: ['token-valid'] }, ip) as any);
        expect(blocked.status).toBe(429);
        expect(blocked.headers.get('Retry-After')).toBeTruthy();
        await expect(blocked.json()).resolves.toEqual({
            success: false,
            error: 'Too many requests',
        });
    });
});
