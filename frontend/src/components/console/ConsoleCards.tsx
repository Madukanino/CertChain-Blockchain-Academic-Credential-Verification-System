'use client';

import type { ReactNode } from 'react';
import { AlertCircle, AlertTriangle, Shield, Wallet } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Shown when a connected wallet differs from the persisted institution wallet.
 * The user must explicitly confirm before the change is written.
 */
export function WalletLinkConfirmCard({
    pendingAddress,
    onConfirm,
    onDismiss,
    linking,
}: {
    pendingAddress: string;
    onConfirm: () => void;
    onDismiss: () => void;
    linking: boolean;
}) {
    return (
        <Card className="border-destructive/25 bg-destructive/8 p-6">
            <div className="flex items-start gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-destructive/15 text-destructive">
                    <AlertTriangle className="h-5 w-5" />
                </span>
                <div className="min-w-0 flex-1">
                    <h3 className="text-base font-semibold text-foreground">
                        Link new wallet to your institution?
                    </h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                        Linking{' '}
                        <span className="font-mono">
                            {pendingAddress.slice(0, 6)}…{pendingAddress.slice(-4)}
                        </span>{' '}
                        will reset your institution&apos;s verification status to{' '}
                        <strong>pending</strong> and clear its on-chain authorization record. An
                        administrator will need to re-approve your institution before you can issue
                        credentials.
                    </p>
                    <div className="mt-4 flex gap-3">
                        <button
                            onClick={onConfirm}
                            disabled={linking}
                            className="rounded-md bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
                        >
                            {linking ? 'Linking…' : 'Yes, link this wallet'}
                        </button>
                        <button
                            onClick={onDismiss}
                            disabled={linking}
                            className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            </div>
        </Card>
    );
}

/** Label / value pair used by the account-information cards. */
export function InfoField({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {label}
            </p>
            <p className="mt-1 font-medium text-foreground">{children}</p>
        </div>
    );
}

export function WalletStatus({ address, linking }: { address: string | null; linking?: boolean }) {
    if (!address) {
        return <span className="text-warning">Not connected</span>;
    }
    return (
        <span className="inline-flex items-center gap-2 text-success">
            <span className="flex h-2 w-2 rounded-full bg-success" />
            {linking ? 'Linking' : 'Connected'}: {address.slice(0, 6)}…{address.slice(-4)}
        </span>
    );
}

export function WalletPromptCard({ message }: { message: string }) {
    return (
        <Card className="border-warning/25 bg-warning/8 p-6">
            <div className="flex items-start gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-warning/15 text-warning">
                    <Wallet className="h-5 w-5" />
                </span>
                <div className="min-w-0">
                    <h3 className="text-base font-semibold text-foreground">Connect your wallet</h3>
                    <p className="mt-1 text-sm text-muted-foreground">{message}</p>
                </div>
            </div>
        </Card>
    );
}

/**
 * Shown instead of the issuance UI until an administrator has approved the
 * institution and authorized it on-chain.
 */
export function VerificationRequiredCard({ status }: { status: string }) {
    return (
        <Card className="border-warning/25 bg-warning/8 p-8 text-center">
            <Shield className="mx-auto mb-4 h-12 w-12 text-warning" />
            <h3 className="text-lg font-bold text-foreground">Verification Required</h3>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
                Your institution account status is currently <strong>{status}</strong>. You must be
                approved by an administrator and verified on-chain before you can issue academic
                credentials.
            </p>
        </Card>
    );
}

/** Placeholder while the institution row is being fetched. */
export function InstitutionProfileSkeleton() {
    return (
        <Card className="p-6">
            <Skeleton className="mb-4 h-7 w-48" />
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                {[0, 1, 2].map((index) => (
                    <div key={index} className="space-y-2">
                        <Skeleton className="h-4 w-16" />
                        <Skeleton className="h-5 w-32" />
                    </div>
                ))}
            </div>
        </Card>
    );
}

/**
 * Terminal state: the institution row could not be loaded.
 *
 * `unlinked` distinguishes the two ways this happens. Since Issue #239 removed
 * self-signup, an account with no institution is a half-finished provisioning
 * — the administrator has to finish it — rather than a transient load failure
 * a reload could fix. Saying "reload the page" there would be dead advice.
 */
export function InstitutionUnavailableCard({ unlinked = false }: { unlinked?: boolean }) {
    return (
        <Card className="border-destructive/25 bg-destructive/8 p-6">
            <div className="flex items-start gap-3">
                <AlertCircle className="mt-0.5 h-6 w-6 shrink-0 text-destructive" />
                <div className="min-w-0">
                    <h3 className="text-base font-semibold text-foreground">
                        {unlinked
                            ? 'Account not linked to an institution'
                            : 'Institution profile unavailable'}
                    </h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                        {unlinked
                            ? 'Your account is not linked to an institution. Contact your Acredia administrator to finish setting it up.'
                            : 'We could not load your institution profile. Reload the page, and contact support if the problem persists.'}
                    </p>
                </div>
            </div>
        </Card>
    );
}
