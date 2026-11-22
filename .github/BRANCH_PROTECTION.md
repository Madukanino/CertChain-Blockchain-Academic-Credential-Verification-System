# Branch protection checklist

Protected branches (`main`, `master`) should require these checks to pass before merging.

## Required status checks (blocking)

| Check name | Workflow file | Blocking? |
|---|---|---|
| Frontend Lint, Tests & Coverage | `ci.yml` | **Required** |
| Frontend Build | `ci.yml` | **Required** |
| Soroban Contract Checks | `ci.yml` | **Required** |
| Browser E2E | `ci.yml` | **Required** |
| CodeQL | `codeql.yml` | **Required** |
| Dependency Review | `dependency-review.yml` | **Required** |
| Secret Scan | `secret-scan.yml` | **Required** |

## Advisory checks (non-blocking)

None — all checks above are required. Future experimental workflows should
be added as advisory until they demonstrate stable pass rates.

## How to enforce

In **Settings → Branches → Branch protection rules** for `main`/`master`:

1. ✅ Require a pull request before merging
2. ✅ Require status checks to pass before merging
   - Add every check from the "Required" table above
3. ✅ Require branches to be up to date before merging
4. ✅ Require review from Code Owners (see `CODEOWNERS`)
5. ✅ Do not allow bypassing the above settings

## Notes

- `dependency-review.yml` requires the GitHub Dependency Graph to be enabled
  in **Settings → Security → Code security and analysis → Dependency graph**.
- `codeql.yml` runs on push to main and on PRs; it must pass before merge.
- `secret-scan.yml` runs on every PR; a detected secret blocks merge.

## Settings-applied audit log

| Date | Applied by | Changes |
|---|---|---|
| _(pending)_ | repo maintainer | Apply all checks above in Settings → Branches |

Maintainer: after applying the rules, record the date and your GitHub handle in the table
above and merge this update to main. A test PR that fails a required check confirms the
rules are live.
