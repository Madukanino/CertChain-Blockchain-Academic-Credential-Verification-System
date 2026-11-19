import { config as loadEnv } from 'dotenv';
loadEnv({ quiet: true }); // Load .env if running directly
import { rpc, scValToNative } from '@stellar/stellar-sdk';
import { createClient } from '@supabase/supabase-js';

const RPC_URL = process.env.NEXT_PUBLIC_SOROBAN_RPC_URL;
const CONTRACT_ID = process.env.NEXT_PUBLIC_CREDENTIAL_NFT_CONTRACT_ID;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!RPC_URL || !CONTRACT_ID || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Missing required environment variables');
    process.exit(1);
}

// Narrowed after the env guard above so nested closures see a definite string.
const contractId: string = CONTRACT_ID;

const server = new rpc.Server(RPC_URL);
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
});

const EVENT_BATCH_SIZE = 1000;
const POLL_INTERVAL_MS = 5000;
const MAX_LEDGER_RANGE = 10000;
const MAX_PAGINATION_PAGES = 500;

function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

/** Thrown when a processEvent call fails; holds the event id for quarantine logging. */
class EventProcessingError extends Error {
    constructor(public readonly eventId: string, cause: unknown) {
        super(`Failed to process event ${eventId}: ${cause instanceof Error ? cause.message : String(cause)}`);
        this.cause = cause;
    }
}

async function processEvent(event: rpc.Api.EventResponse) {
    // The getEvents filter already restricts results to our contract, so we only
    // need to guard the event kind here.
    if (event.type !== 'contract') return;

    try {
        // In @stellar/stellar-sdk v15, getEvents already decodes topic/value to
        // xdr.ScVal — pass them straight to scValToNative (no base64 fromXDR).
        const topics = event.topic.map((val) => scValToNative(val));
        const eventName = topics[0]?.toString();
        const data = scValToNative(event.value);

        console.log(`Processing event: ${eventName} at ledger ${event.ledger}`);

        if (eventName === 'cred_iss') {
            const tokenId = topics[1]?.toString();
            // Data is (student, issuer, credential_hash, ipfs_uri)
            const student = data[0]?.toString();
            const issuer = data[1]?.toString();
            const credentialHash = bytesToHex(data[2]);
            const ipfsUri = data[3]?.toString();
            // ipfsUri is 'ipfs://<hash>'
            const ipfsHash = ipfsUri?.replace('ipfs://', '') || '';

            // Ensure institution exists (or we just map by wallet_address)
            const { data: instData } = await supabase
                .from('institutions')
                .select('id')
                .eq('wallet_address', issuer)
                .maybeSingle();

            const institutionId = instData?.id || null;

            // Ensure student exists
            const { data: stuData } = await supabase
                .from('students')
                .select('id')
                .eq('wallet_address', student)
                .maybeSingle();
            
            const studentId = stuData?.id || null;

            const { error } = await supabase
                .from('credentials')
                .upsert({
                    token_id: tokenId,
                    student_id: studentId,
                    student_wallet_address: student,
                    institution_id: institutionId,
                    issuer_wallet_address: issuer,
                    ipfs_hash: ipfsHash,
                    blockchain_hash: credentialHash,
                    metadata: {}, // Empty for indexed-only ones if not known
                    issued_at: new Date(event.ledgerClosedAt).toISOString(),
                    revoked: false
                }, { onConflict: 'token_id' });
            
            if (error) console.error('Error inserting credential:', error);
        } else if (eventName === 'cred_rev') {
            const tokenId = topics[1]?.toString();
            const { error } = await supabase
                .from('credentials')
                .update({
                    revoked: true,
                    revoked_at: new Date(event.ledgerClosedAt).toISOString(),
                    revocation_source: 'issuer',
                })
                .eq('token_id', tokenId);

            if (error) console.error('Error revoking credential:', error);
        } else if (eventName === 'cred_rev_owner') {
            const tokenId = topics[1]?.toString();
            const { error } = await supabase
                .from('credentials')
                .update({
                    revoked: true,
                    revoked_at: new Date(event.ledgerClosedAt).toISOString(),
                    revocation_source: 'platform',
                })
                .eq('token_id', tokenId);

            if (error) console.error('Error revoking credential (platform override):', error);
        } else if (eventName === 'iss_auth') {
            const issuer = data?.toString();
            const { error } = await supabase
                .from('institutions')
                .update({ verified: true, status: 'verified' })
                .eq('wallet_address', issuer);
            
            if (error) console.error('Error authorizing issuer:', error);
        } else if (eventName === 'iss_rev') {
            const issuer = data?.toString();
            const { error } = await supabase
                .from('institutions')
                .update({ verified: false, status: 'suspended' })
                .eq('wallet_address', issuer);
            
            if (error) console.error('Error revoking issuer:', error);
        }
    } catch (e) {
        console.error('Error decoding/processing event:', e);
    }
}

async function run() {
    console.log('Starting Acredia off-chain indexer...');

    while (true) {
        try {
            // Get latest network ledger
            const latestLedgerResponse = await server.getLatestLedger();
            const networkLatestLedger = latestLedgerResponse.sequence;

            // Get last synced ledger
            let { data: stateData } = await supabase
                .from('indexer_state')
                .select('last_ledger')
                .eq('id', 'main')
                .maybeSingle();

            if (!stateData) {
                // Initialize if not present, starting from current ledger
                await supabase.from('indexer_state').insert({ id: 'main', last_ledger: networkLatestLedger });
                stateData = { last_ledger: networkLatestLedger };
            }

            let startLedger = stateData.last_ledger + 1;

            if (startLedger > networkLatestLedger) {
                // Up to date
                await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
                continue;
            }

            // Fetch events in batches
            let endLedger = Math.min(startLedger + MAX_LEDGER_RANGE, networkLatestLedger);
            console.log(`Syncing ledgers ${startLedger} to ${endLedger}`);

            let cursor: string | undefined = undefined;
            let eventsProcessed = 0;
            let hasMore = true;
            let pageCount = 0;
            const failedEventIds: string[] = [];
            let lastSuccessfulLedger = startLedger - 1;

            while (hasMore) {
                if (pageCount >= MAX_PAGINATION_PAGES) {
                    throw new Error(
                        `Pagination safety limit reached (${MAX_PAGINATION_PAGES} pages) while syncing ledgers ${startLedger}–${endLedger}. Aborting to avoid infinite loop.`,
                    );
                }

                const filters = [{ type: 'contract' as const, contractIds: [contractId] }];
                // The RPC accepts exactly one of startLedger / cursor — use the
                // cursor for pagination once we have one, else the start ledger.
                const eventsResponse = await server.getEvents(
                    cursor
                        ? { filters, limit: EVENT_BATCH_SIZE, cursor }
                        : { startLedger, filters, limit: EVENT_BATCH_SIZE },
                );

                const nextCursor = eventsResponse.cursor;
                if (nextCursor !== undefined && nextCursor === cursor) {
                    throw new Error(
                        `Indexer received a repeated pagination cursor ("${cursor}") — aborting to prevent an infinite loop.`,
                    );
                }

                const events = eventsResponse.events;
                for (const event of events) {
                    try {
                        await processEvent(event);
                        eventsProcessed++;
                        // Track the highest ledger we successfully processed.
                        if (event.ledger > lastSuccessfulLedger) {
                            lastSuccessfulLedger = event.ledger;
                        }
                    } catch (err) {
                        const eventId = (event as any).id ?? `ledger:${event.ledger}`;
                        console.error(`Quarantining event ${eventId}:`, err);
                        failedEventIds.push(eventId);
                        // Do NOT advance lastSuccessfulLedger past a failed event.
                    }
                }

                pageCount++;

                if (events.length > 0 && nextCursor !== undefined) {
                    cursor = nextCursor;
                } else {
                    hasMore = false;
                }
            }

            if (failedEventIds.length > 0) {
                console.error(
                    `Indexer quarantined ${failedEventIds.length} event(s): ${failedEventIds.join(', ')}`,
                );
            }

            // Only advance the checkpoint to the ledger we actually finished
            // processing. If events failed we stop at the last successful ledger
            // so the next run re-attempts the failed range.
            const committedLedger = failedEventIds.length === 0
                ? endLedger
                : lastSuccessfulLedger;

            if (committedLedger >= startLedger) {
                await supabase
                    .from('indexer_state')
                    .update({ last_ledger: committedLedger, updated_at: new Date().toISOString() })
                    .eq('id', 'main');
            }

            console.log(`Successfully processed ${eventsProcessed} events up to ledger ${committedLedger}`);

            // Delay next iteration
            await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

        } catch (error) {
            console.error('Indexer encountered an error:', error);
            // Wait before retrying on error
            await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
        }
    }
}

run().catch(console.error);
