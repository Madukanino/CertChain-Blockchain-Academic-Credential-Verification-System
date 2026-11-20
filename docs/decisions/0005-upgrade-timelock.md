# ADR 0005: Contract Upgrade Timelock

**Status:** Accepted  
**Date:** 2026-08-12  
**Deciders:** CertChain core team

---

## Context

`upgrade(new_wasm_hash)` previously replaced the live contract WASM immediately in a single
owner-signed transaction and emitted an `upgraded` event only after the code had already changed.
In a credential-verification system, institutions, holders, and third-party verifiers rely on
deterministic on-chain rules. Instant upgrades create two risks:

- A compromised owner key—or an unexpected governance action—can swap live verification logic with
  zero advance notice.
- External observers only learn that contract code changed *after* execution, leaving no window to
  inspect the proposed WASM hash or react prior to activation.

---

## Decision

Split contract upgrades into a two-step, timelocked, owner-gated propose/execute flow in
`contracts/src/lib.rs`:

- **Timelock constant**: `UPGRADE_TIMELOCK_LEDGERS = 120_960` ledgers (~7 days at ~5 seconds per
  Stellar ledger).
- **`propose_upgrade(new_wasm_hash)`**: Owner-gated (`read_owner(&env).require_auth()`). Records
  `PendingUpgrade { wasm_hash, ready_ledger }` in instance storage (`DataKey::PendingUpgrade`),
  where `ready_ledger = current_ledger.saturating_add(UPGRADE_TIMELOCK_LEDGERS)`, and publishes an
  `upg_prop` event containing `(new_wasm_hash, ready_ledger)`.
- **`get_pending_upgrade()`**: Public read-only query returning `Option<PendingUpgrade>` so anyone
  can inspect a queued upgrade on-chain at any time.
- **`upgrade(new_wasm_hash)`**: Owner-gated. Requires `DataKey::PendingUpgrade` to exist
  (`UpgradeNotProposed`), requires `pending.wasm_hash == new_wasm_hash` (`UpgradeHashMismatch`),
  and requires `env.ledger().sequence() >= pending.ready_ledger` (`UpgradeTimelockActive`) before
  clearing `PendingUpgrade`, emitting `upgraded`, and calling
  `env.deployer().update_current_contract_wasm(new_wasm_hash)`.
- **`cancel_upgrade()`**: Owner-gated. Clears `DataKey::PendingUpgrade` (`UpgradeNotProposed` if
  none is queued) and emits `upg_cncl`.

---

## Consequences

**Good:**
- Credential holders, issuers, and verifiers gain a guaranteed ~7-day public inspection window
  between `propose_upgrade` and earliest execution.
- Hash commitment ensures the executed WASM binary matches the exact hash announced in `upg_prop`.
- Mistakes or superseded releases can be aborted cleanly via `cancel_upgrade`.

**Bad:**
- Legitimate bug fixes that require a contract WASM replacement must wait 120,960 ledgers before
  activating (incident containment relies on `pause()` / `unpause()` in the meantime).

**Neutral:**
- Pairing the `Owner` role with a multi-signature account remains recommended for production
  deployments so proposals and executions both require threshold approval.

---

## Alternatives Considered

**Option A: Immediate owner-gated `upgrade()`**  
Fastest deployment path, but provides no advance warning or verification window for ecosystem
participants.

**Option B: Immutable contract (remove `upgrade()`)**  
Eliminates upgrade risk entirely, but makes bug fixes or Soroban protocol migrations impossible
without redeploying to a new contract address and invalidating existing QR/verification links.

**Option C (chosen): 7-day (`120_960`-ledger) on-chain timelock with hash commitment**  
Balances fixability with public transparency and predictable governance.

---

## Implementation Notes

- Implemented in `contracts/src/lib.rs` (`UPGRADE_TIMELOCK_LEDGERS`, `PendingUpgrade`,
  `propose_upgrade`, `get_pending_upgrade`, `cancel_upgrade`, `upgrade`).
- Documented in `contracts/README.md` ("Upgrade Policy (on-chain timelock)") and
  `contracts/SECURITY_AUDIT.md` (Finding F-4).
- Covered by unit tests including `test_propose_upgrade_emits_event`,
  `test_propose_upgrade_records_pending`, `test_upgrade_without_proposal_rejected`,
  `test_upgrade_before_timelock_rejected`, `test_upgrade_hash_mismatch_rejected`,
  `test_cancel_upgrade_clears_pending`, and `test_cancel_upgrade_without_proposal_rejected`.
