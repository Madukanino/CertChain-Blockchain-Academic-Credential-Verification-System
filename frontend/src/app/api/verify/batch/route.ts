import { NextRequest, NextResponse } from 'next/server';
import { getServiceRoleClient } from '@/lib/serverAuth';
import { enforceRateLimit, getRateLimiterMode } from '@/lib/rateLimit';
import { captureException } from '@/lib/debug';
import {
    VERIFY_RATE_LIMIT,
    VERIFY_API_KEY_RATE_LIMIT,
    resolveApiKeyContext,
    verifySingleToken,
    logVerificationAttempt,
    type SingleTokenVerificationResult,
} from '@/lib/verifyCredential';

export const dynamic = 'force-dynamic';

export const MAX_BATCH_SIZE = 20;

export async function POST(request: NextRequest) {
    const requestId = request.headers.get('x-request-id') || 'unknown';

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json(
            { success: false, error: 'Invalid JSON request body' },
            { status: 400 },
        );
    }

    const rawTokens =
        body && typeof body === 'object' && 'tokens' in body
            ? (body as { tokens?: unknown }).tokens
            : undefined;

    if (!Array.isArray(rawTokens) || rawTokens.length === 0) {
        return NextResponse.json(
            { success: false, error: 'tokens must be a non-empty array' },
            { status: 400 },
        );
    }

    if (rawTokens.length > MAX_BATCH_SIZE) {
        return NextResponse.json(
            {
                success: false,
                error: `Batch size exceeds maximum of ${MAX_BATCH_SIZE} tokens`,
                maxBatchSize: MAX_BATCH_SIZE,
            },
            { status: 400 },
        );
    }

    let supabase: ReturnType<typeof getServiceRoleClient> | null = null;
    try {
        supabase = getServiceRoleClient();
    } catch {
        supabase = null;
    }

    if (!supabase) {
        return NextResponse.json(
            { success: false, error: 'Server configuration error' },
            { status: 500 },
        );
    }

    try {
        const apiKeyResult = await resolveApiKeyContext(request, supabase);
        if (!apiKeyResult.ok) {
            return NextResponse.json(
                { success: false, error: apiKeyResult.error },
                { status: apiKeyResult.status },
            );
        }

        const { apiKeyContext } = apiKeyResult;

        // Fail closed in production if Upstash is not configured.
        if (
            process.env.NODE_ENV === 'production' &&
            getRateLimiterMode() === 'in-memory-unconfigured'
        ) {
            await logVerificationAttempt(supabase, request, 'batch', 'server_error', 500, {
                errorCategory: 'rate_limiter_unconfigured',
                apiKeyContext,
            });
            return NextResponse.json(
                { success: false, error: 'Server configuration error' },
                { status: 500 },
            );
        }

        // Charge rate-limit quota proportionally to the number of tokens in the batch.
        const rateLimitResponse = await enforceRateLimit(
            request,
            apiKeyContext
                ? {
                      ...VERIFY_API_KEY_RATE_LIMIT,
                      identifier: apiKeyContext.id,
                      cost: rawTokens.length,
                  }
                : {
                      ...VERIFY_RATE_LIMIT,
                      cost: rawTokens.length,
                  },
        );

        if (rateLimitResponse) {
            return rateLimitResponse;
        }

        const results: SingleTokenVerificationResult[] = await Promise.all(
            rawTokens.map((rawToken) =>
                verifySingleToken({
                    supabase,
                    request,
                    rawToken,
                    requestId,
                    contextLabel: 'POST /api/verify/batch',
                    apiKeyContext,
                }),
            ),
        );

        const summary = {
            verified: 0,
            revoked: 0,
            mismatch: 0,
            notFound: 0,
            failed: 0,
        };

        for (const item of results) {
            if (item.status === 'verified') {
                summary.verified += 1;
            } else if (item.status === 'revoked') {
                summary.revoked += 1;
            } else if (item.status === 'mismatch') {
                summary.mismatch += 1;
            } else if (item.status === 'not_found') {
                summary.notFound += 1;
            } else {
                summary.failed += 1;
            }
        }

        return NextResponse.json(
            {
                success: true,
                total: results.length,
                summary,
                results,
            },
            {
                status: 200,
                headers: { 'Cache-Control': 'no-store' },
            },
        );
    } catch (err: unknown) {
        captureException(err, { requestId, context: 'POST /api/verify/batch' });
        return NextResponse.json(
            { success: false, error: 'Internal server error' },
            { status: 500 },
        );
    }
}
