'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { captureException, debugLog, debugWarn } from '@/lib/debug';
import { safeGetSession, supabase } from '@/lib/supabase';
import { useStellarAccount } from '@/contexts/StellarContext';
import { useAuth } from '@/contexts/AuthContext';
import { resolveInstitutionIdForUser } from '@/lib/institutionMembership';

export interface InstitutionProfile {
    /** Empty until the institution row has been loaded or created. */
    institutionId: string;
    institutionName: string;
    /** The connected wallet, which is what issuance signs with. */
    institutionWallet: string;
    /** KYB status: `pending` | `verified` | `rejected` | `suspended`. */
    status: string;
    /** Wallet address persisted on the institution row. */
    linkedWalletAddress: string | null;
    /** Currently connected wallet address, or `null`. */
    address: string | null;
    loading: boolean;
    linkingWallet: boolean;
    /**
     * When a connected wallet differs from the linked one, this holds the new
     * address waiting for explicit user confirmation. `null` means no pending
     * change (either wallets already match or no wallet is connected).
     */
    pendingWalletAddress: string | null;
    /**
     * Call this after the user confirms the wallet-link dialog. Sends the POST
     * and clears `pendingWalletAddress` on success.
     */
    confirmLinkWallet: () => Promise<void>;
    /**
     * Call this to dismiss the confirmation prompt without linking.
     */
    dismissPendingWallet: () => void;
    /**
     * True when the signed-in user has an institution role but no institution
     * record. Since Issue #239 this is a provisioning error to surface, not a
     * cue to create one.
     */
    unlinked: boolean;
}

/**
 * Loads the signed-in user's institution row and keeps the connected wallet
 * linked to it.
 *
 * Never creates the row: institutions are provisioned by an Acredia admin
 * (Issue #239), so a user with no institution is reported through `unlinked`
 * rather than silently given one.
 *
 * This used to live inline in `/dashboard`; every institution console route
 * needs it now that the tabs became real pages.
 */
export function useInstitutionProfile(): InstitutionProfile {
    const { user, userRole } = useAuth();
    const { address } = useStellarAccount();

    const [institutionId, setInstitutionId] = useState('');
    const [institutionWalletAddress, setInstitutionWalletAddress] = useState<string | null>(null);
    const [institutionStatus, setInstitutionStatus] = useState<string>('pending');
    const [loadingInstitution, setLoadingInstitution] = useState(true);
    const [unlinked, setUnlinked] = useState(false);
    const [linkingInstitutionWallet, setLinkingInstitutionWallet] = useState(false);
    const [pendingWalletAddress, setPendingWalletAddress] = useState<string | null>(null);

    useEffect(() => {
        const fetchInstitutionId = async () => {
            setUnlinked(false);

            if (!user || userRole !== 'institution') {
                setInstitutionId('');
                setInstitutionWalletAddress(null);
                setInstitutionStatus('pending');
                // A still-resolving role is not a final answer — keep the
                // loading state so callers do not flash an error card.
                setLoadingInstitution(userRole === 'loading');
                return;
            }

            try {
                const institutionId = await resolveInstitutionIdForUser(supabase, user.id);

                const { data, error } = institutionId
                    ? await supabase
                          .from('institutions')
                          .select('id, wallet_address, status')
                          .eq('id', institutionId)
                          .maybeSingle()
                    : { data: null, error: null };

                if (error) {
                    captureException(error, { context: 'fetchInstitutionId' });
                    toast.error('Failed to load institution data');
                    return;
                }

                if (data) {
                    setInstitutionId(data.id);
                    setInstitutionWalletAddress(data.wallet_address ?? null);
                    setInstitutionStatus(data.status || 'pending');
                    debugLog('Institution profile loaded for dashboard.');
                    return;
                }

                // A missing institution is an error state, never a silent
                // create (Issue #239). Accounts are provisioned by an admin, so
                // an unlinked one means the provisioning is incomplete — not
                // that we should invent a record named after an email.
                debugWarn('No institution is linked to this account.');
                setUnlinked(true);
            } catch (error) {
                captureException(error, { context: 'fetchInstitutionId_catch' });
                toast.error('An unexpected error occurred');
            } finally {
                setLoadingInstitution(false);
            }
        };

        fetchInstitutionId();
    }, [user, userRole]);

    // Detect when a newly-connected wallet differs from the persisted one and
    // surface it as `pendingWalletAddress` for the user to explicitly confirm.
    // No mutation happens here — connecting a wallet is now read-only.
    useEffect(() => {
        if (!user?.id || userRole !== 'institution' || !institutionId || !address) {
            setPendingWalletAddress(null);
            return;
        }

        if (institutionWalletAddress?.toLowerCase() === address.toLowerCase()) {
            setPendingWalletAddress(null);
            return;
        }

        setPendingWalletAddress(address);
    }, [address, institutionId, institutionWalletAddress, user?.id, userRole]);

    const confirmLinkWallet = async () => {
        if (!pendingWalletAddress || !institutionId) return;

        setLinkingInstitutionWallet(true);

        try {
            const {
                data: { session },
                error: sessionError,
            } = await safeGetSession();

            if (sessionError || !session?.access_token) {
                throw new Error('Your session expired. Please sign in again.');
            }

            const response = await fetch('/api/institution/link-wallet', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${session.access_token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ walletAddress: pendingWalletAddress, confirmed: true }),
            });
            const payload = await response.json();

            if (!response.ok || !payload?.success) {
                throw new Error(payload?.error || 'Failed to link institution wallet');
            }

            setInstitutionWalletAddress(payload.walletAddress ?? pendingWalletAddress);
            setPendingWalletAddress(null);
            debugLog('Connected wallet linked to institution profile.');
            if (payload.changed) {
                toast.success('Institution wallet linked');
            }
        } catch (error) {
            captureException(error, { context: 'confirmLinkWallet' });
            toast.error('Failed to link connected wallet to your institution');
        } finally {
            setLinkingInstitutionWallet(false);
        }
    };

    const dismissPendingWallet = () => setPendingWalletAddress(null);

    return {
        institutionId,
        institutionName: user?.user_metadata?.name || 'Institution',
        institutionWallet: address || '',
        status: institutionStatus,
        linkedWalletAddress: institutionWalletAddress,
        address,
        loading: loadingInstitution,
        linkingWallet: linkingInstitutionWallet,
        pendingWalletAddress,
        confirmLinkWallet,
        dismissPendingWallet,
        unlinked,
    };
}
