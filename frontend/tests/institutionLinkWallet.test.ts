/**
 * Tests for issue #158 — wallet linking must require explicit confirmation.
 *
 * We test the API route in isolation using the same mock pattern used by
 * institution-route-rate-limit.test.ts and serverAuth.institution.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/institution/link-wallet/route';
import { resetRateLimitStore } from '@/lib/rateLimit';

// ---------------------------------------------------------------------------
// Shared state that individual tests can override
// ---------------------------------------------------------------------------

const state = {
    userId: 'user-inst-1',
    institutionId: 'inst-1',
    existingWallet: 'GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37',
    /** Wallet address that will be in the POST body */
    newWallet: 'GBKFJXENTE23JLKEVLJP7SYAAWDZ5P5EVLRPXGHQ2QLHZS2RJYB57R7',
    memberRole: 'owner' as string,
    auditInserted: null as Record<string, unknown> | null,
    institutionUpdateArgs: null as Record<string, unknown> | null,
};

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('@/lib/serverAuth', () => ({
    requireAuthenticatedRequest: vi.fn(async () => ({
        ok: true,
        userId: state.userId,
        user: { id: state.userId },
        accessToken: 'tok',
    })),
    hasServiceRoleEnv: () => true,
    getServiceRoleClient: () => buildSupabaseStub(),
    createUserScopedServerClient: () => buildSupabaseStub(),
}));

vi.mock('@/lib/rateLimit', () => ({
    enforceRateLimit: vi.fn(async () => null),
    resetRateLimitStore: vi.fn(),
}));

vi.mock('@/lib/institutionMembership', () => ({
    resolveInstitutionForUser: vi.fn(async () => ({
        institutionId: state.institutionId,
        role: state.memberRole,
        status: 'active',
    })),
    canWrite: vi.fn((role: string) => role === 'owner' || role === 'member'),
}));

vi.mock('@stellar/stellar-sdk', () => ({
    StrKey: {
        isValidEd25519PublicKey: vi.fn((key: string) =>
            // Accept our two test keys; reject obviously bad ones
            key === state.existingWallet || key === state.newWallet,
        ),
    },
}));

function buildSupabaseStub() {
    const updatedRow = { id: state.institutionId, wallet_address: state.newWallet };

    return {
        from: (table: string) => {
            if (table === 'institutions') {
                return {
                    select: () => ({
                        eq: () => ({
                            maybeSingle: async () => ({
                                data: {
                                    id: state.institutionId,
                                    wallet_address: state.existingWallet,
                                },
                                error: null,
                            }),
                        }),
                    }),
                    update: (fields: Record<string, unknown>) => {
                        state.institutionUpdateArgs = fields;
                        return {
                            eq: () => ({
                                select: () => ({
                                    single: async () => ({
                                        data: updatedRow,
                                        error: null,
                                    }),
                                }),
                            }),
                        };
                    },
                };
            }

            if (table === 'admin_audit_logs') {
                return {
                    insert: async (row: Record<string, unknown>) => {
                        state.auditInserted = row;
                        return { error: null };
                    },
                };
            }

            return {};
        },
    };
}

function makeRequest(body: Record<string, unknown>, headers: Record<string, string> = {}) {
    return {
        headers: {
            get: (name: string) => {
                const h: Record<string, string> = {
                    authorization: 'Bearer tok',
                    'x-request-id': 'req-test',
                    ...headers,
                };
                return h[name.toLowerCase()] ?? null;
            },
        },
        json: async () => body,
    } as unknown as import('next/server').NextRequest;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
    state.auditInserted = null;
    state.institutionUpdateArgs = null;
    state.memberRole = 'owner';
});

describe('POST /api/institution/link-wallet — confirmation guard', () => {
    it('rejects a request that omits the confirmed flag', async () => {
        const req = makeRequest({ walletAddress: state.newWallet });
        const res = await POST(req);
        const body = await res.json();

        expect(res.status).toBe(400);
        expect(body.success).toBe(false);
        expect(body.error).toMatch(/confirmation/i);
    });

    it('rejects a request where confirmed is explicitly false', async () => {
        const req = makeRequest({ walletAddress: state.newWallet, confirmed: false });
        const res = await POST(req);
        const body = await res.json();

        expect(res.status).toBe(400);
        expect(body.success).toBe(false);
    });

    it('accepts and links the wallet when confirmed is true', async () => {
        const req = makeRequest({ walletAddress: state.newWallet, confirmed: true });
        const res = await POST(req);
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.changed).toBe(true);
        expect(body.walletAddress).toBe(state.newWallet);
    });

    it('does not mutate the institution row when confirmation is missing', async () => {
        const req = makeRequest({ walletAddress: state.newWallet });
        await POST(req);

        expect(state.institutionUpdateArgs).toBeNull();
    });
});

describe('POST /api/institution/link-wallet — audit event', () => {
    it('writes an audit log row on a successful confirmed link', async () => {
        const req = makeRequest({ walletAddress: state.newWallet, confirmed: true });
        await POST(req);

        expect(state.auditInserted).not.toBeNull();
        expect(state.auditInserted?.action).toBe('link_institution_wallet');
        expect(state.auditInserted?.target_institution_id).toBe(state.institutionId);
        expect((state.auditInserted?.details as Record<string, unknown>)?.newWalletAddress).toBe(
            state.newWallet,
        );
        expect((state.auditInserted?.details as Record<string, unknown>)?.verificationReset).toBe(
            true,
        );
    });

    it('does not write an audit log when confirmation is missing', async () => {
        const req = makeRequest({ walletAddress: state.newWallet });
        await POST(req);

        expect(state.auditInserted).toBeNull();
    });
});

describe('POST /api/institution/link-wallet — same-wallet no-op', () => {
    it('returns changed=false and skips the update when wallet already matches', async () => {
        // Point the new wallet to the same value already stored
        const req = makeRequest({ walletAddress: state.existingWallet, confirmed: true });
        const res = await POST(req);
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.changed).toBe(false);
        // No DB mutation on a no-op
        expect(state.institutionUpdateArgs).toBeNull();
    });
});
