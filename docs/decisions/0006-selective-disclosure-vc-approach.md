# ADR 0006 — ZK / Selective Disclosure for Verifiable Credentials

**Status:** Proposed  
**Date:** 2026-11-22  
**Issue:** #97

---

## Context

Today, sharing a CertChain credential reveals every field (student name, institution,
degree, subject grades, IPFS URI, issuer address). Verifiers typically need only one
assertion — "did this person graduate?" — but receive the whole document.

`ISSUE_DRAFTS.md` lists selective disclosure as a Phase 3 stretch goal. This ADR
records the design research so Phase 3 work can start with a clear decision.

---

## Approaches compared

### Option A — BBS+ signatures (W3C VC / Open Badges 3.0 compatible)

BBS+ is a pairing-based signature scheme that lets a holder derive a *proof* covering
only a chosen subset of signed attributes, without revealing the others or the original
signature.

**Pros:**
- W3C VC Data Integrity draft specifies a `BbsBlsSignature2020` / `Bbs2023` proof type
- Can be layered on the existing W3C VC / OBv3 document shape without changing the
  on-chain hash commitment (hash is over the *canonical full payload*; selective proofs
  are off-chain)
- No on-chain changes required: the verifier receives a derived proof and verifies it
  off-chain against the issuer's BLS12-381 public key (stored in the credential's
  `issuer.id` DID document or in Supabase)
- Reasonable performance: BBS+ verify is ~10–50 ms in WASM

**Cons:**
- BLS12-381 key management adds operational complexity for institutions
- JS/WASM library landscape is maturing but not yet stable (`@digitalbazaar/bbs-signatures`)
- The `/verify` route would need to understand two proof types: existing Ed25519/EcdsaSecp256k1
  and BBS+

### Option B — ZK proofs (e.g., SNARK over credential fields)

A SNARK circuit proves a predicate ("GPA ≥ 3.0", "degree = BSc") without revealing
the underlying values.

**Pros:**
- Maximum privacy: even the predicate's inputs are hidden
- Composable: multiple predicates can be bundled

**Cons:**
- Proof generation is expensive (minutes on mobile without a trusted setup)
- Requires a circuit per predicate, plus a trusted setup or transparent ceremony
- Far outside the existing W3C VC / OBv3 shape; would require a new proof type and
  significant verifier changes
- Not compatible with the current on-chain hash commitment without redesigning the
  contract's credential schema

---

## Decision

**Use BBS+ (Option A) for Phase 3 selective disclosure.**

Rationale:
1. No on-chain contract changes — the hash commitment stays over the full payload;
   derived proofs are purely off-chain.
2. Compatible with the existing W3C VC / OBv3 document shape.
3. The fields that can be hidden without breaking the canonical hash: any sub-set of
   `credentialSubject.*` attributes that are signed but not committed individually
   on-chain. Fields that are on-chain (token ID, issuer address, `did:stellar` student
   address, timestamp, revocation flag) must remain visible.
4. ZK predicates (Option B) are deferred to a future ADR once BBS+ is shipped and the
   use-case demand is clearer.

---

## Scope for Phase 3

- Institutions sign with a BLS12-381 key pair in addition to the existing Stellar key.
- The `/api/credentials/[token_id]/selective` route accepts a `fields[]` query param
  and returns a BBS+ derived proof document.
- The `/verify` route accepts both the full W3C VC and a BBS+ derived proof.
- The student dashboard shows a "Share selected fields" flow.
- Pilot with two fields: `credentialSubject.degree` and `credentialSubject.graduationDate`.
