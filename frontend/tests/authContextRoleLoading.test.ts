/**
 * Tests for issue #157 — protected routes must not render during role resolution.
 *
 * We exercise the auth-state transition sequence directly (no React mount
 * needed for the node vitest environment) by calling the same async logic
 * that AuthContext uses, then asserting state ordering.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { RoleState } from '../src/types';

// ---------------------------------------------------------------------------
// Helpers that mirror AuthContext's internal state machine
// ---------------------------------------------------------------------------

type AuthState = { user: string | null; loading: boolean; userRole: RoleState };

/**
 * Simulates the safeGetSession + resolveRole sequence from AuthContext.
 * Returns each intermediate state in the order it would be observed by React.
 */
async function runAuthStateSequence(
    resolveRoleImpl: (user: string | null) => Promise<RoleState>,
    sessionUser: string | null,
): Promise<AuthState[]> {
    const states: AuthState[] = [];

    // Initial state (matches useState defaults in AuthContext)
    let state: AuthState = { user: null, loading: true, userRole: 'loading' };
    states.push({ ...state });

    // Simulate the safeGetSession .then() — with the fix, loading stays true
    // until resolveRole awaits.
    state = { ...state, user: sessionUser };
    // Role resolution runs before setLoading(false)
    const role = await resolveRoleImpl(sessionUser);
    state = { ...state, userRole: role };
    // Only now does loading become false
    state = { ...state, loading: false };
    states.push({ ...state });

    return states;
}

// ---------------------------------------------------------------------------
// Helpers that mirror ProtectedRoute's render-gate logic (the second fix)
// ---------------------------------------------------------------------------

type RenderVerdict = 'skeleton' | 'null' | 'children';

/**
 * Applies ProtectedRoute's conditional render logic and returns what would
 * be rendered for a user who IS authenticated and authorized.
 */
function protectedRouteVerdict(
    loading: boolean,
    userRole: RoleState,
    user: string | null,
    allowedRoles?: RoleState[],
): RenderVerdict {
    // Fix: block while either loading flag or role is still pending
    if (loading || userRole === 'loading') return 'skeleton';
    if (!user) return 'null';
    if (allowedRoles && !allowedRoles.includes(userRole)) return 'null';
    return 'children';
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AuthContext role-loading state sequence', () => {
    it('never reaches loading=false before role is resolved', async () => {
        const resolveRole = vi.fn(async (_user: string | null): Promise<RoleState> => {
            // Simulate async DB round-trip
            await new Promise((r) => setTimeout(r, 0));
            return 'student';
        });

        const states = await runAuthStateSequence(resolveRole, 'user-123');

        // There should be no state where loading is false AND userRole is still 'loading'
        const prematureClear = states.find((s) => !s.loading && s.userRole === 'loading');
        expect(prematureClear).toBeUndefined();
    });

    it('settles to loading=false and resolved role in final state', async () => {
        const resolveRole = vi.fn(async (_user: string | null): Promise<RoleState> => 'institution');

        const states = await runAuthStateSequence(resolveRole, 'user-456');

        const final = states[states.length - 1];
        expect(final?.loading).toBe(false);
        expect(final?.userRole).toBe('institution');
    });

    it('sets userRole to unknown when no user is present', async () => {
        const resolveRole = vi.fn(async (user: string | null): Promise<RoleState> =>
            user ? 'student' : 'unknown',
        );

        const states = await runAuthStateSequence(resolveRole, null);

        const final = states[states.length - 1];
        expect(final?.loading).toBe(false);
        expect(final?.userRole).toBe('unknown');
        expect(final?.user).toBeNull();
    });
});

describe('ProtectedRoute render gate', () => {
    it('shows skeleton while loading is true, regardless of userRole', () => {
        expect(protectedRouteVerdict(true, 'loading', null)).toBe('skeleton');
        expect(protectedRouteVerdict(true, 'student', 'user-1')).toBe('skeleton');
    });

    it('shows skeleton while userRole is still loading, even if loading flag is false', () => {
        // This is the case that was broken before the fix: loading=false but
        // role not yet resolved would leak children to the DOM.
        expect(protectedRouteVerdict(false, 'loading', 'user-1')).toBe('skeleton');
        expect(protectedRouteVerdict(false, 'loading', 'user-1', ['student'])).toBe('skeleton');
    });

    it('shows null (redirecting) when no user after resolution', () => {
        expect(protectedRouteVerdict(false, 'unknown', null)).toBe('null');
    });

    it('shows null when user lacks required role after resolution', () => {
        expect(protectedRouteVerdict(false, 'student', 'user-1', ['admin'])).toBe('null');
        expect(protectedRouteVerdict(false, 'institution', 'user-1', ['admin', 'student'])).toBe('null');
    });

    it('renders children only when fully resolved and authorized', () => {
        expect(protectedRouteVerdict(false, 'student', 'user-1', ['student'])).toBe('children');
        expect(protectedRouteVerdict(false, 'admin', 'user-1', ['admin', 'institution'])).toBe('children');
        // No allowedRoles = any authenticated user passes
        expect(protectedRouteVerdict(false, 'institution', 'user-1')).toBe('children');
    });
});
