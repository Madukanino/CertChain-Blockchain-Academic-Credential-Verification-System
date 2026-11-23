import { NextRequest } from 'next/server';
import { getServiceRoleClient } from '@/lib/serverAuth';
import {
    getCredential,
    isAuthorizedIssuer,
    isRevoked,
    ContractConfigurationError,
    BlockchainUnavailableError,
} from '@/lib/contractReads';
import { deriveCredentialHash } from '@/lib/credentialHash';
import { fetchJsonFromIpfs } from '@/lib/ipfsServer';
import {
    writeVerificationAuditLog,
    type VerificationResultType,
} from '@/lib/verificationAudit';
import { captureException, recordMetric } from '@/lib/debug';
import { hashApiKey } from '@/lib/apiKey';
import {
    getCachedImmutableData,
    setCachedImmutableData,
    getCachedRevocationStatus,
    setCachedRevocationStatus,
} from '@/lib/verificationCache';

export type IntegrityStatus = 'match' | 'mismatch' | 'unavailable';

export interface IntegrityResult {
    status: IntegrityStatus;
    cidResolved: boolean;
}

export const MAX_TOKEN_LENGTH = 128;

export const VERIFY_RATE_LIMIT = {
    windowSeconds: 60,
    maxRequests: 60,
    prefix: 'verify',
} as const;

export const VERIFY_API_KEY_RATE_LIMIT = {
    windowSeconds: 60,
    maxRequests: 600,
    prefix: 'verify-apikey',
} as const;

export type ServiceRoleClient = ReturnType<typeof getServiceRoleClient>;
export type ApiKeyContext = { id: string; name: string } | null;

type ChainChecks = {
    issuerMatch: boolean | null;
    studentMatch: boolean | null;
    hashMatch: boolean | null;
    uriMatch: boolean | null;
    notRevoked: boolean;
};

export interface VerifiedCredentialPayload {
    tokenId: string;
    issuedAt: string;
    revoked: boolean;
    revokedAt: string | null;
    revocationSource: 'issuer' | 'platform' | null;
    institutionName: string | null;
    credentialType: string | null;
    degree: string | null;
    major: string | null;
    issueDate: string | null;
    studentWallet: string | null;
    institutionWallet: string | null;
    metadataSchemaVersion: number | null;
    hashAlgorithm: string | null;
    onChainHash: string | null;
    blockchainHash: string | null;
    ipfsHash: string | null;
}

export interface VerificationOutcomePayload {
    verified: boolean;
    revoked: boolean;
    revocationSource: 'issuer' | 'platform' | null;
    onChainMatch: boolean;
    onChainFound: boolean;
    issuerAuthorized: boolean;
    issuerStatus: 'active' | 'revoked';
    integrity: IntegrityResult;
}

export type SingleTokenVerificationStatus =
    | 'verified'
    | 'revoked'
    | 'mismatch'
    | 'not_found'
    | 'invalid'
    | 'unavailable'
    | 'error';

export type SingleTokenVerificationResult =
    | {
          token: string;
          success: true;
          status: 'verified' | 'revoked' | 'mismatch';
          statusCode: 200;
          credential: VerifiedCredentialPayload;
          verification: VerificationOutcomePayload;
      }
    | {
          token: string;
          success: false;
          status: 'not_found' | 'invalid' | 'unavailable' | 'error';
          statusCode: 400 | 404 | 500 | 503;
          error: string;
      };

function getMismatchReasons(checks: ChainChecks | null) {
    if (!checks) {
        return ['missing_on_chain'];
    }

    const reasons: string[] = [];
    if (checks.issuerMatch !== true) reasons.push('issuer');
    if (checks.studentMatch !== true) reasons.push('student');
    if (checks.hashMatch !== true) reasons.push('hash');
    if (checks.uriMatch !== true) reasons.push('uri');
    if (!checks.notRevoked) reasons.push('revocation');
    return reasons;
}

function getResultType(verified: boolean, revoked: boolean): VerificationResultType {
    if (verified) {
        return 'verified';
    }

    if (revoked) {
        return 'revoked';
    }

    return 'mismatch';
}

async function checkIntegrity(
    onChainUri: string | null | undefined,
    onChainHash: string | null | undefined,
    metadataSchemaVersion: number | null | undefined,
    hashAlgorithm: string | null | undefined,
): Promise<IntegrityResult> {
    if (!onChainUri || !onChainHash) {
        return { status: 'unavailable', cidResolved: false };
    }

    const fetched = await fetchJsonFromIpfs(onChainUri);
    if (!fetched.ok) {
        return { status: 'unavailable', cidResolved: false };
    }

    try {
        const fetchedHash = await deriveCredentialHash(
            fetched.content,
            metadataSchemaVersion,
            hashAlgorithm,
        );
        return {
            status: fetchedHash === onChainHash ? 'match' : 'mismatch',
            cidResolved: true,
        };
    } catch {
        return { status: 'unavailable', cidResolved: true };
    }
}

export async function logVerificationAttempt(
    supabase: ServiceRoleClient | null,
    request: NextRequest,
    token: string | null,
    resultType: VerificationResultType,
    statusCode: number,
    options: {
        credentialId?: string | null;
        chain?: {
            found?: boolean;
            revoked?: boolean;
            match?: boolean;
        };
        integrity?: IntegrityResult;
        mismatchReasons?: string[];
        errorCategory?: string;
        apiKeyContext?: ApiKeyContext;
    } = {},
) {
    recordMetric('verification.attempt', 1, {
        resultType,
        statusCode,
        credentialId: options.credentialId,
        chain: options.chain,
        integrityStatus: options.integrity?.status,
        errorCategory: options.errorCategory,
    });

    if (!supabase || !token) {
        return;
    }

    await writeVerificationAuditLog(supabase, {
        request,
        token,
        resultType,
        statusCode,
        credentialId: options.credentialId,
        chain: options.chain,
        integrity: options.integrity,
        mismatchReasons: options.mismatchReasons,
        errorCategory: options.errorCategory,
        apiKeyContext: options.apiKeyContext,
    });
}

export async function resolveApiKeyContext(
    request: NextRequest,
    supabase: ServiceRoleClient,
): Promise<
    | { ok: true; apiKeyContext: ApiKeyContext }
    | { ok: false; status: 401 | 500; error: string }
> {
    const authHeader = request.headers.get('authorization');
    const xApiKey = request.headers.get('x-api-key');
    let providedKey = xApiKey?.trim();
    if (!providedKey && authHeader?.toLowerCase().startsWith('bearer ')) {
        providedKey = authHeader.substring(7).trim();
    }

    if (!providedKey) {
        return { ok: true, apiKeyContext: null };
    }

    const keyHash = await hashApiKey(providedKey);
    const { data: keyData, error: keyError } = await supabase
        .from('api_keys')
        .select('id, name, revoked')
        .eq('key_hash', keyHash)
        .maybeSingle();

    if (keyError) {
        return { ok: false, status: 500, error: 'Database error validating API key' };
    }

    if (!keyData || keyData.revoked) {
        return { ok: false, status: 401, error: 'Invalid or revoked API key' };
    }

    return { ok: true, apiKeyContext: { id: keyData.id, name: keyData.name } };
}

export async function verifySingleToken(params: {
    supabase: ServiceRoleClient;
    request: NextRequest;
    rawToken: unknown;
    requestId: string;
    contextLabel: string;
    apiKeyContext: ApiKeyContext;
}): Promise<SingleTokenVerificationResult> {
    const { supabase, request, rawToken, requestId, contextLabel, apiKeyContext } = params;
    const token = typeof rawToken === 'string' ? rawToken.trim() : '';
    let credentialId: string | null = null;

    if (!token || token.length > MAX_TOKEN_LENGTH) {
        if (token) {
            await logVerificationAttempt(supabase, request, token, 'invalid_request', 400, {
                errorCategory: 'token_too_long',
                apiKeyContext,
            });
        }
        return {
            token: typeof rawToken === 'string' ? rawToken : '',
            success: false,
            status: 'invalid',
            statusCode: 400,
            error: 'Invalid token',
        };
    }

    try {
        const { data, error } = await supabase
            .from('credentials')
            .select(
                `
                id,
                token_id,
                issued_at,
                revoked,
                revoked_at,
                revocation_source,
                metadata,
                metadata_schema_version,
                hash_algorithm,
                ipfs_hash,
                blockchain_hash,
                student_wallet_address,
                issuer_wallet_address,
                institution:institutions!credentials_institution_id_fkey (
                    name
                )
            `,
            )
            .eq('token_id', token)
            .maybeSingle();

        if (error) {
            await logVerificationAttempt(supabase, request, token, 'server_error', 500, {
                errorCategory: 'database_query_failed',
                apiKeyContext,
            });

            return {
                token,
                success: false,
                status: 'error',
                statusCode: 500,
                error: 'Failed to query credential',
            };
        }

        const tokenId = token;

        const cachedImmutable = await getCachedImmutableData(tokenId);
        let onChain = cachedImmutable?.onChain ?? null;
        let integrity = cachedImmutable?.integrity ?? null;
        const immutableCacheHit = cachedImmutable !== null;

        if (!immutableCacheHit) {
            onChain = await getCredential(tokenId);
        }

        if (!data && !onChain) {
            await logVerificationAttempt(supabase, request, token, 'not_found', 404, {
                apiKeyContext,
            });

            return {
                token,
                success: false,
                status: 'not_found',
                statusCode: 404,
                error: 'Credential not found',
            };
        }

        const credentialRecord = data ?? {
            id: undefined,
            token_id: tokenId,
            issued_at: onChain?.issued_at
                ? new Date(Number(onChain.issued_at)).toISOString()
                : new Date().toISOString(),
            revoked: onChain?.revoked ?? false,
            revoked_at: null,
            revocation_source: null,
            metadata: null,
            metadata_schema_version: 1,
            hash_algorithm: 'sha256:canonical-json:v1',
            ipfs_hash: onChain?.uri ? onChain.uri.replace(/^ipfs:\/\//, '') : '',
            blockchain_hash: onChain?.hash ?? '',
            student_wallet_address: onChain?.student ?? null,
            issuer_wallet_address: onChain?.issuer ?? null,
            institution: null,
        };

        credentialId = credentialRecord.id;

        if (!immutableCacheHit) {
            integrity = await checkIntegrity(
                onChain?.uri,
                onChain?.hash,
                credentialRecord.metadata_schema_version,
                credentialRecord.hash_algorithm,
            );
            void setCachedImmutableData(tokenId, {
                onChain,
                integrity: integrity ?? { status: 'unavailable', cidResolved: false },
            });
        }

        let cachedRevoked = await getCachedRevocationStatus(tokenId);
        const revocationCacheHit = cachedRevoked !== null;

        if (!revocationCacheHit) {
            cachedRevoked = await isRevoked(tokenId);
            void setCachedRevocationStatus(tokenId, cachedRevoked);
        }
        const onChainRevoked = cachedRevoked ?? false;

        const issuerWallet = credentialRecord.issuer_wallet_address || onChain?.issuer;
        const issuerAuthorized =
            issuerWallet && typeof isAuthorizedIssuer === 'function'
                ? await isAuthorizedIssuer(issuerWallet)
                : false;

        recordMetric('verification.cache.status', 1, {
            immutableHit: immutableCacheHit,
            revocationHit: revocationCacheHit,
            tokenId,
        });

        const dbHash = credentialRecord.metadata
            ? await deriveCredentialHash(
                  credentialRecord.metadata,
                  credentialRecord.metadata_schema_version,
                  credentialRecord.hash_algorithm,
              )
            : null;
        const expectedUri = credentialRecord.ipfs_hash
            ? `ipfs://${credentialRecord.ipfs_hash}`
            : (onChain?.uri ?? null);

        const safeIntegrity: IntegrityResult = integrity ?? {
            status: 'unavailable',
            cidResolved: false,
        };

        const checks: ChainChecks | null = onChain
            ? {
                  issuerMatch: credentialRecord.issuer_wallet_address
                      ? onChain.issuer.toLowerCase() ===
                        credentialRecord.issuer_wallet_address.toLowerCase()
                      : true,
                  studentMatch: credentialRecord.student_wallet_address
                      ? onChain.student.toLowerCase() ===
                        credentialRecord.student_wallet_address.toLowerCase()
                      : true,
                  hashMatch: dbHash ? onChain.hash === dbHash : true,
                  uriMatch: expectedUri ? onChain.uri === expectedUri : true,
                  notRevoked: !onChainRevoked,
              }
            : null;

        const onChainMatch =
            checks !== null &&
            checks.issuerMatch === true &&
            checks.studentMatch === true &&
            checks.hashMatch === true &&
            checks.uriMatch === true;

        const revoked = Boolean(onChainRevoked || credentialRecord.revoked);
        const revocationSource: 'issuer' | 'platform' | null = revoked
            ? credentialRecord.revocation_source === 'issuer' ||
              credentialRecord.revocation_source === 'platform'
                ? credentialRecord.revocation_source
                : null
            : null;
        const verified = onChain !== null && onChainMatch && !revoked;
        const resultType = getResultType(verified, revoked);

        const mismatchReasons = [
            ...(resultType === 'mismatch' ? getMismatchReasons(checks) : []),
            ...(safeIntegrity.status === 'mismatch' ? ['ipfs_integrity'] : []),
        ];

        await logVerificationAttempt(supabase, request, token, resultType, 200, {
            credentialId,
            chain: {
                found: onChain !== null,
                revoked,
                match: onChainMatch,
            },
            integrity: safeIntegrity,
            mismatchReasons,
            apiKeyContext,
        });

        const institution = Array.isArray(credentialRecord.institution)
            ? credentialRecord.institution[0]
            : credentialRecord.institution;

        const credentialData = credentialRecord.metadata?.credentialData ?? {};

        const status: 'verified' | 'revoked' | 'mismatch' = verified
            ? 'verified'
            : revoked
              ? 'revoked'
              : 'mismatch';

        return {
            token,
            success: true,
            status,
            statusCode: 200,
            credential: {
                tokenId: credentialRecord.token_id,
                issuedAt: credentialRecord.issued_at,
                revoked,
                revokedAt: credentialRecord.revoked_at,
                revocationSource,
                institutionName: institution?.name ?? credentialData.institutionName ?? null,
                credentialType: credentialData.credentialType ?? null,
                degree: credentialData.degree ?? null,
                major: credentialData.major ?? null,
                issueDate: credentialData.issueDate ?? null,
                studentWallet: onChain?.student ?? credentialRecord.student_wallet_address ?? null,
                institutionWallet:
                    onChain?.issuer ?? credentialRecord.issuer_wallet_address ?? null,
                metadataSchemaVersion: credentialRecord.metadata_schema_version ?? null,
                hashAlgorithm: credentialRecord.hash_algorithm ?? null,
                onChainHash: onChain?.hash ?? null,
                blockchainHash: credentialRecord.blockchain_hash ?? onChain?.hash ?? null,
                ipfsHash:
                    credentialRecord.ipfs_hash ??
                    (onChain?.uri ? onChain.uri.replace(/^ipfs:\/\//, '') : null),
            },
            verification: {
                verified,
                revoked,
                revocationSource,
                onChainMatch,
                onChainFound: onChain !== null,
                issuerAuthorized,
                issuerStatus: issuerAuthorized ? 'active' : 'revoked',
                integrity: safeIntegrity,
            },
        };
    } catch (err: unknown) {
        if (err instanceof ContractConfigurationError) {
            captureException(err, { requestId, context: contextLabel });
            await logVerificationAttempt(supabase, request, token, 'chain_unavailable', 500, {
                credentialId,
                errorCategory: 'contract_configuration',
                apiKeyContext,
            });

            return {
                token,
                success: false,
                status: 'error',
                statusCode: 500,
                error: 'Server configuration error',
            };
        }

        if (err instanceof BlockchainUnavailableError) {
            captureException(err, { requestId, context: contextLabel });
            await logVerificationAttempt(supabase, request, token, 'chain_unavailable', 503, {
                credentialId,
                errorCategory: 'contract_read_failed',
                apiKeyContext,
            });

            return {
                token,
                success: false,
                status: 'unavailable',
                statusCode: 503,
                error: 'Blockchain verification unavailable',
            };
        }

        await logVerificationAttempt(supabase, request, token, 'server_error', 500, {
            credentialId,
            errorCategory: 'unexpected_error',
            apiKeyContext,
        });
        captureException(err, { requestId, context: contextLabel });

        return {
            token,
            success: false,
            status: 'error',
            statusCode: 500,
            error: 'Internal server error',
        };
    }
}
