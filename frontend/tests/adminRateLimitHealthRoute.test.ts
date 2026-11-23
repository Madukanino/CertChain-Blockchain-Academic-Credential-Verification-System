import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* ── Hoisted mocks ───────────────────────────────────────────────────────────── */

const {
    mockRequireAdminRequest,
    mockGetRateLimiterMode,
    mockIsRateLimiterHealthy,
} = vi.hoisted(() => ({
    mockRequireAdminRequest: vi.fn(),
    mockGetRateLimiterMode: vi.fn(),
    mockIsRateLimiterHealthy: vi.fn(),
}));

vi.mock('@/lib/serverAuth', () => ({
    requireAdminRequest: mockRequireAdminRequest,
}));

vi.mock('@/lib/rateLimit', () => ({
    getRateLimiterMode: mockGetRateLimiterMode,
    isRateLimiterHealthy: mockIsRateLimiterHealthy,
}));

import { GET } from '../src/app/api/admin/rate-limit-health/route';

/* ── Helpers ─────────────────────────────────────────────────────────────────── */

function rateLimitHealthRequest(): NextRequest {
    return new NextRequest('http://localhost:3000/api/admin/rate-limit-health', {
        method: 'GET',
    });
}

/* ── Tests ───────────────────────────────────────────────────────────────────── */

describe('GET /api/admin/rate-limit-health', () => {
    const originalNetwork = process.env.NEXT_PUBLIC_STELLAR_NETWORK;

    beforeEach(() => {
        vi.clearAllMocks();
        process.env.NEXT_PUBLIC_STELLAR_NETWORK = 'testnet';
        mockRequireAdminRequest.mockResolvedValue({ ok: true, userId: 'admin-1' });
        mockGetRateLimiterMode.mockReturnValue('distributed');
        mockIsRateLimiterHealthy.mockReturnValue(true);
    });

    afterEach(() => {
        if (originalNetwork === undefined) {
            delete process.env.NEXT_PUBLIC_STELLAR_NETWORK;
        } else {
            process.env.NEXT_PUBLIC_STELLAR_NETWORK = originalNetwork;
        }
    });

    /* ─── Auth edge cases ─────────────────────────────────────────────────── */

    it('returns 401 for unauthenticated requests', async () => {
        mockRequireAdminRequest.mockResolvedValue({
            ok: false,
            status: 401,
            error: 'Missing access token',
        });

        const response = await GET(rateLimitHealthRequest());

        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({
            success: false,
            error: 'Missing access token',
        });
        expect(mockGetRateLimiterMode).not.toHaveBeenCalled();
        expect(mockIsRateLimiterHealthy).not.toHaveBeenCalled();
    });

    it('returns 403 for non-admin authenticated users', async () => {
        mockRequireAdminRequest.mockResolvedValue({
            ok: false,
            status: 403,
            error: 'Admin access required',
        });

        const response = await GET(rateLimitHealthRequest());

        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({
            success: false,
            error: 'Admin access required',
        });
        expect(mockGetRateLimiterMode).not.toHaveBeenCalled();
        expect(mockIsRateLimiterHealthy).not.toHaveBeenCalled();
    });

    it('propagates 500 when admin auth verification fails internally', async () => {
        mockRequireAdminRequest.mockResolvedValue({
            ok: false,
            status: 500,
            error: 'Server configuration error',
        });

        const response = await GET(rateLimitHealthRequest());

        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({
            success: false,
            error: 'Server configuration error',
        });
    });

    /* ─── Redis (distributed) mode ────────────────────────────────────────── */

    it('returns 200 and healthy Redis payload when distributed mode is active on testnet', async () => {
        const response = await GET(rateLimitHealthRequest());

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            success: true,
            rateLimiter: {
                mode: 'distributed',
                healthy: true,
                degraded: false,
                unconfigured: false,
                actionRequired: false,
                network: 'testnet',
            },
        });
    });

    it('returns 200 and healthy Redis payload when distributed mode is active on mainnet', async () => {
        process.env.NEXT_PUBLIC_STELLAR_NETWORK = 'mainnet';

        const response = await GET(rateLimitHealthRequest());

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            success: true,
            rateLimiter: {
                mode: 'distributed',
                healthy: true,
                degraded: false,
                unconfigured: false,
                actionRequired: false,
                network: 'mainnet',
            },
        });
    });

    /* ─── In-memory modes ─────────────────────────────────────────────────── */

    it('returns 200 with degraded=true for in-memory-fallback on testnet', async () => {
        mockGetRateLimiterMode.mockReturnValue('in-memory-fallback');
        mockIsRateLimiterHealthy.mockReturnValue(false);

        const response = await GET(rateLimitHealthRequest());

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            success: true,
            rateLimiter: {
                mode: 'in-memory-fallback',
                healthy: false,
                degraded: true,
                unconfigured: false,
                actionRequired: false,
                network: 'testnet',
            },
        });
    });

    it('returns 503 with actionRequired=true for in-memory-fallback on mainnet', async () => {
        process.env.NEXT_PUBLIC_STELLAR_NETWORK = 'MAINNET';
        mockGetRateLimiterMode.mockReturnValue('in-memory-fallback');
        mockIsRateLimiterHealthy.mockReturnValue(false);

        const response = await GET(rateLimitHealthRequest());

        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({
            success: true,
            rateLimiter: {
                mode: 'in-memory-fallback',
                healthy: false,
                degraded: true,
                unconfigured: false,
                actionRequired: true,
                network: 'MAINNET',
            },
        });
    });

    it('returns 200 with unconfigured=true for in-memory-unconfigured on testnet', async () => {
        mockGetRateLimiterMode.mockReturnValue('in-memory-unconfigured');
        mockIsRateLimiterHealthy.mockReturnValue(false);

        const response = await GET(rateLimitHealthRequest());

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            success: true,
            rateLimiter: {
                mode: 'in-memory-unconfigured',
                healthy: false,
                degraded: false,
                unconfigured: true,
                actionRequired: false,
                network: 'testnet',
            },
        });
    });

    it('returns 503 with actionRequired=true for in-memory-unconfigured on mainnet', async () => {
        process.env.NEXT_PUBLIC_STELLAR_NETWORK = 'mainnet';
        mockGetRateLimiterMode.mockReturnValue('in-memory-unconfigured');
        mockIsRateLimiterHealthy.mockReturnValue(false);

        const response = await GET(rateLimitHealthRequest());

        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({
            success: true,
            rateLimiter: {
                mode: 'in-memory-unconfigured',
                healthy: false,
                degraded: false,
                unconfigured: true,
                actionRequired: true,
                network: 'mainnet',
            },
        });
    });

    it('reports network as unknown when NEXT_PUBLIC_STELLAR_NETWORK is unset', async () => {
        delete process.env.NEXT_PUBLIC_STELLAR_NETWORK;
        mockGetRateLimiterMode.mockReturnValue('in-memory-unconfigured');
        mockIsRateLimiterHealthy.mockReturnValue(false);

        const response = await GET(rateLimitHealthRequest());

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            success: true,
            rateLimiter: {
                mode: 'in-memory-unconfigured',
                healthy: false,
                degraded: false,
                unconfigured: true,
                actionRequired: false,
                network: 'unknown',
            },
        });
    });
});
