# ADR 0004: Owner Credential Revocation Override

**Status:** Accepted  
**Date:** 2026-08-12  
**Deciders:** CertChain core team

---

## Context

`revoke_credential(token_id, issuer)` restricts revocation to the exact issuer address recorded on
the `Credential` (`credential.issuer == issuer`) and requires the issuer to be currently
authorized. While this preserves issuer autonomy in normal operations, it creates an incident
response gap:

- If an institution's signing key is compromised or permanently lost, the contract owner can
  deauthorize that issuer via `revoke_issuer`, stopping future mints.
- However, once an issuer key is lost or compromised, neither the platform nor the institution can
  revoke specific bad or fraudulently issued credentials already minted under that key.

Adding an owner override changes *who* can invalidate an institution's attestations, which is a
governance and trust-model trade-off that requires explicit transparency guarantees.

---

## Decision

Introduce a narrow, auditable, owner-gated override entry point `admin_revoke_credential(token_id)`
in `contracts/src/lib.rs`:

- **Authorization**: Reads `owner` from contract storage via `read_owner(&env)` and enforces
  `owner.require_auth()` (never a caller-supplied admin parameter).
- **Pause compliance**: Respects the emergency pause (`ContractError::ContractPaused`).
- **Scope**: Marks an existing, non-revoked credential (`CredentialNotFound` / `AlreadyRevoked`)
  as `revoked = true`, even if the original issuing address has already been deauthorized via
  `revoke_issuer`.
- **Monotonicity**: Shares the same `credential.revoked` flag with `revoke_credential`, so
  revocation remains strictly monotonic and cannot be re-executed or undone across either path.
- **Public auditability**: Emits a distinct `cred_rev_owner` event (`(Symbol::new(&env, "cred_rev_owner"), token_id)` with `owner` as data) instead of `cred_rev`, so off-chain indexers, the verification API, and the verification UI distinguish platform overrides (`revocation_source = platform`) from institution-initiated revocations (`revocation_source = issuer`).

---

## Consequences

**Good:**
- Compromised-issuer or lost-key incidents can be remediated on-chain by revoking affected
  credentials even after `revoke_issuer` has been called.
- Verifiers and credential holders always know whether a revocation came from the issuing
  institution (`cred_rev`) or from the platform owner (`cred_rev_owner`); the owner cannot
  silently impersonate an institution.

**Bad:**
- Introduces a privileged platform escape hatch that can invalidate credentials without the
  original issuer's signature.
- Off-chain indexers and UIs must consume and surface both `cred_rev` and `cred_rev_owner`
  events.

**Neutral:**
- Standard issuer self-revocation via `revoke_credential` is unchanged.

---

## Alternatives Considered

**Option A: Keep issuer-only revocation**  
Maximizes issuer sovereignty, but leaves compromised or fraudulent credentials permanently valid if
an issuer key is lost or stolen.

**Option B: Reuse `cred_rev` event on admin revocation**  
Simpler for indexers, but blurs the provenance of revocation and lets the platform appear as the
issuing institution.

**Option C (chosen): Owner-gated `admin_revoke_credential` with distinct `cred_rev_owner` event**  
Closes the incident-response gap while making platform intervention publicly distinguishable on-chain
and off-chain.

---

## Implementation Notes

- Implemented in `contracts/src/lib.rs` (`admin_revoke_credential`) and documented in
  `contracts/README.md` and `contracts/SECURITY_AUDIT.md` (Finding F-5).
- Covered by unit tests including `test_admin_revoke_credential`,
  `test_admin_revoke_works_after_issuer_deauthorized`,
  `test_admin_revoke_requires_owner_auth`, `test_admin_revoke_nonexistent_rejected`,
  `test_admin_revoke_already_revoked_rejected`, and `test_admin_revoke_emits_distinct_event`.
