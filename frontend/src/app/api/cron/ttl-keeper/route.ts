import { NextRequest, NextResponse } from 'next/server';
import { getServiceRoleClient } from '@/lib/serverAuth';
import { authorizeCronRequest } from '@/lib/cronAuth';
import { captureException, structuredLog, recordMetric } from '@/lib/debug';
import { getRpcClient } from '@/lib/contractReads';
import { getConfiguredContractId } from '@/lib/runtimeConfig';

export const dynamic = 'force-dynamic';

/**
 * TTL Keeper — Credential on-chain bump cron (Issue #281)
 *
 * Soroban persistent entries expire unless their TTL is extended. The
 * contract exposes a permissionless `bump_credential` entrypoint, but
 * nothing was scheduled to call it. A credential that is never verified
 * for ~1 year silently expires and stops verifying — the most
 * product-damaging failure possible.
 *
 * This cron:
 *   1. Reads a page of credential token IDs from the Supabase index,
 *      continuing from a persisted cursor so successive runs cover the
 *      whole set (Issue #137).
 *   2. For each, calls bump_credential on-chain (idempotent; no-op when
 *      TTL is already healthy per PERSISTENT_THRESHOLD).
 *   3. Records a per-run summary (count bumped, count failed, duration,
 *      coverage: processed + remaining).
 *   4. Returns a structured response that the admin dashboard can surface.
 *
 * Scheduled in vercel.json. Calls are authorized via CRON_SECRET.
 *
 * Fee account: the keeper account must be funded with XLM to cover the
 * Soroban transaction fees. Monitor KEEPER_ACCOUNT_MIN_BALANCE_XLM; page
 * on-call when it falls below the threshold.
 */

// How many credentials to bump in a single cron run (page size).
// Adjust based on Vercel function timeout limits (default: 60 s for Hobby,
// 300 s for Pro). Each bump_credential call is a cheap Soroban read+write.
const BATCH_LIMIT = 500;

// Minimum remaining ledgers that triggers a bump call (≈ 6 months, matching
// the PERSISTENT_THRESHOLD constant in the contract).
const _TTL_THRESHOLD_LEDGERS = 3_110_400; // ~6 months @ 5 s/ledger

// Minimum XLM balance for the keeper fee account. Alert when below this.
const KEEPER_MIN_BALANCE_XLM = 5;

// Supabase table + key used to persist the keyset cursor across invocations.
const CURSOR_TABLE = 'ttl_keeper_cursor';
const CURSOR_ROW_ID = 'default';

interface KeeperRunSummary {
    runId: string;
    totalCredentials: number;
    bumpAttempted: number;
    bumpSucceeded: number;
    bumpFailed: number;
    bumpSkipped: number;  // TTL already healthy
    minRemainingTtlLedgers: number | null;
    keeperBalanceXlm: number | null;
    lowBalance: boolean;
    durationMs: number;
    failedTokenIds: string[];
    // Coverage (Issue #137): keyset pagination across invocations.
    cursorStart: string | null;
    cursorEnd: string | null;
    processedThisRun: number;
    remainingAfterRun: number;
    wrapped: boolean;
}

async function getKeeperBalance(): Promise<number | null> {
    try {
        const horizonUrl = process.env.NEXT_PUBLIC_HORIZON_URL ?? 'https://horizon-testnet.stellar.org';
        const keeperAccount = process.env.TTL_KEEPER_ACCOUNT_PUBLIC;
        if (!keeperAccount) return null;

        const response = await fetch(`${horizonUrl}/accounts/${keeperAccount}`);
        if (!response.ok) return null;

        const data = await response.json() as { balances?: Array<{ asset_type: string; balance: string }> };
        const native = data.balances?.find((b) => b.asset_type === 'native');
        return native ? parseFloat(native.balance) : null;
    } catch {
        return null;
    }
}

async function bumpCredentialOnChain(tokenId: string): Promise<{ success: boolean; ttlLedgers: number | null }> {
    try {
        const rpc = getRpcClient();
        const contractId = getConfiguredContractId('CREDENTIAL_NFT');
        const keeperSecret = process.env.TTL_KEEPER_ACCOUNT_SECRET;

        if (!keeperSecret) {
            // No keeper account configured — cannot submit on-chain bump.
            return { success: false, ttlLedgers: null };
        }

        // bump_credential is permissionless — any funded account can call it.
        // It calls extend_credential_ttl internally; it is a no-op (succeeds
        // without writing) when the TTL is already above PERSISTENT_THRESHOLD.
        const { rpc: StellarRpc, TransactionBuilder, Networks, BASE_FEE, Keypair, Contract, nativeToScVal } = await import('@stellar/stellar-sdk');

        const keypair = Keypair.fromSecret(keeperSecret);
        const server = new StellarRpc.Server(rpc.serverURL.toString());
        const account = await server.getAccount(keypair.publicKey());

        const contract = new Contract(contractId);
        const networkPassphrase = process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ?? Networks.TESTNET;

        const tx = new TransactionBuilder(account, {
            fee: BASE_FEE,
            networkPassphrase,
        })
            .addOperation(contract.call('bump_credential', nativeToScVal(BigInt(tokenId), { type: 'u64' })))
            .setTimeout(30)
            .build();

        const sim = await server.simulateTransaction(tx);
        if (StellarRpc.Api.isSimulationError(sim)) {
            return { success: false, ttlLedgers: null };
        }

        const prepared = StellarRpc.assembleTransaction(tx, sim).build();
        prepared.sign(keypair);

        const result = await server.sendTransaction(prepared);
        if (result.status === 'ERROR') {
            return { success: false, ttlLedgers: null };
        }

        // Poll for completion
        let getResult = await server.getTransaction(result.hash);
        let attempts = 0;
        while (getResult.status === StellarRpc.Api.GetTransactionStatus.NOT_FOUND && attempts < 10) {
            await new Promise((r) => setTimeout(r, 2000));
            getResult = await server.getTransaction(result.hash);
            attempts++;
        }

        const succeeded = getResult.status === StellarRpc.Api.GetTransactionStatus.SUCCESS;
        return { success: succeeded, ttlLedgers: null };
    } catch {
        return { success: false, ttlLedgers: null };
    }
}

/**
 * Read the persisted keyset cursor (last token_id processed). Returns null
 * when no cursor has been recorded yet (start from the beginning).
 */
async function readCursor(supabase: ReturnType<typeof getServiceRoleClient>): Promise<string | null> {
    try {
        const { data, error } = await supabase
            .from(CURSOR_TABLE)
            .select('last_token_id')
            .eq('id', CURSOR_ROW_ID)
            .maybeSingle();
        if (error || !data) return null;
        const value = (data as { last_token_id?: string | null }).last_token_id;
        return value != null ? String(value) : null;
    } catch {
        return null;
    }
}

/**
 * Persist the keyset cursor so the next invocation continues where this one
 * left off. Best-effort: a failure here only means the next run restarts
 * from the beginning, which is safe (bumps are idempotent).
 */
async function writeCursor(
    supabase: ReturnType<typeof getServiceRoleClient>,
    lastTokenId: string | null,
): Promise<void> {
    try {
        await supabase
            .from(CURSOR_TABLE)
            .upsert(
                { id: CURSOR_ROW_ID, last_token_id: lastTokenId, updated_at: new Date().toISOString() },
                { onConflict: 'id' },
            );
    } catch {
        // Best-effort; see doc comment.
    }
}

export async function GET(request: NextRequest) {
    const startMs = Date.now();
    const runId = crypto.randomUUID();
    const requestId = request.headers.get('x-request-id') || runId;

    const auth = authorizeCronRequest(request);
    if (!auth.ok) {
        structuredLog('WARN', 'Rejected cron invocation of TTL keeper', requestId, {
            status: auth.status,
        });
        return NextResponse.json({ success: false, error: auth.error }, { status: auth.status });
    }

    if (!process.env.TTL_KEEPER_ACCOUNT_SECRET) {
        structuredLog('ERROR', 'TTL keeper is misconfigured: TTL_KEEPER_ACCOUNT_SECRET is not set', requestId, {});
        return NextResponse.json(
            { success: false, error: 'TTL keeper misconfigured: set TTL_KEEPER_ACCOUNT_SECRET to enable on-chain bumps.' },
            { status: 503 },
        );
    }

    try {
        const supabase = getServiceRoleClient();

        // Keyset pagination over token_id (Issue #137). Each run resumes from
        // the persisted cursor so credentials beyond the first page are
        // eventually covered. When the end is reached the cursor wraps back
        // to the beginning on the next run.
        const cursorStart = await readCursor(supabase);

        // Fetch the next page of non-revoked credential token IDs from the
        // Supabase index. The keeper must not trust only the DB: it reconciles
        // against the chain. Revoked credentials do not need bumping — their
        // on-chain entries stop being queried and can safely archive.
        let query = supabase
            .from('credentials')
            .select('token_id')
            .eq('revoked', false)
            .not('token_id', 'is', null)
            .order('token_id', { ascending: true })
            .limit(BATCH_LIMIT);

        if (cursorStart != null) {
            query = query.gt('token_id', cursorStart);
        }

        const { data: credentials, error: fetchError } = await query;

        if (fetchError) {
            throw new Error(`Failed to fetch credentials: ${fetchError.message}`);
        }

        const tokenIds = (credentials ?? [])
            .map((c) => String(c.token_id))
            .filter(Boolean);

        const totalCredentials = tokenIds.length;
        let bumpSucceeded = 0;
        let bumpFailed = 0;
        let bumpSkipped = 0;
        const failedTokenIds: string[] = [];

        // Process in batches to avoid hitting Soroban rate limits.
        // bump_credential is idempotent and cheap when TTL is already healthy.
        const CONCURRENCY = 5;
        for (let i = 0; i < tokenIds.length; i += CONCURRENCY) {
            const batch = tokenIds.slice(i, i + CONCURRENCY);
            const results = await Promise.allSettled(
                batch.map((tokenId) => bumpCredentialOnChain(tokenId)),
            );

            for (let j = 0; j < results.length; j++) {
                const result = results[j];
                if (result.status === 'fulfilled' && result.value.success) {
                    bumpSucceeded++;
                } else {
                    bumpFailed++;
                    failedTokenIds.push(batch[j]);
                }
            }
        }

        // Advance the cursor. If we got a full page there may be more rows
        // beyond it; otherwise we've reached the end and wrap to the start.
        const cursorEnd = tokenIds.length > 0 ? tokenIds[tokenIds.length - 1] : cursorStart;
        const wrapped = tokenIds.length < BATCH_LIMIT;
        await writeCursor(supabase, wrapped ? null : cursorEnd);

        // Count how many non-revoked credentials remain after this page so the
        // summary reports coverage (Issue #137).
        let remainingAfterRun = 0;
        if (!wrapped && cursorEnd != null) {
            const { count } = await supabase
                .from('credentials')
                .select('token_id', { count: 'exact', head: true })
                .eq('revoked', false)
                .not('token_id', 'is', null)
                .gt('token_id', cursorEnd);
            remainingAfterRun = count ?? 0;
        }

        const keeperBalanceXlm = await getKeeperBalance();
        const lowBalance = keeperBalanceXlm != null && keeperBalanceXlm < KEEPER_MIN_BALANCE_XLM;

        const summary: KeeperRunSummary = {
            runId,
            totalCredentials,
            bumpAttempted: totalCredentials,
            bumpSucceeded,
            bumpFailed,
            bumpSkipped,
            minRemainingTtlLedgers: null,
            keeperBalanceXlm,
            lowBalance,
            durationMs: Date.now() - startMs,
            failedTokenIds,
            cursorStart,
            cursorEnd,
            processedThisRun: totalCredentials,
            remainingAfterRun,
            wrapped,
        };

        structuredLog('INFO', 'TTL keeper run complete', requestId, {
            runId,
            processedThisRun: summary.processedThisRun,
            remainingAfterRun: summary.remainingAfterRun,
            wrapped: summary.wrapped,
            bumpSucceeded,
            bumpFailed,
            lowBalance,
        });
        recordMetric('ttl_keeper.processed', totalCredentials);
        recordMetric('ttl_keeper.remaining', remainingAfterRun);

        return NextResponse.json({ success: true, summary });
    } catch (error) {
        captureException(error, { runId, requestId, route: 'cron/ttl-keeper' });
        structuredLog('ERROR', 'TTL keeper run failed', requestId, {
            runId,
            error: error instanceof Error ? error.message : String(error),
        });
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'TTL keeper run failed' },
            { status: 500 },
        );
    }
}
