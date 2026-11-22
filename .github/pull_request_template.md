## Summary
- What changed?
- Why is this needed?

## Testing
- [ ] Lint (`npm run lint`)
- [ ] Unit tests (`npm test`)
- [ ] Build (`npm run build`)
- [ ] Coverage check (≥ 60% overall, ≥ 70% for auth/verify/rate-limit/stellar)
- [ ] Responsive widths tested (mobile 375 px, tablet 768 px, desktop 1280 px)
- [ ] Interactive elements have ≥ 44 px tap targets
- [ ] Accessibility checked (`npm run lint` a11y rules pass, no WCAG AA regressions)
- [ ] If `contracts/` changed: `cargo test` and `cargo clippy` pass locally
- [ ] `.env.example` updated if new environment variables were added
- [ ] README or relevant docs updated if behavior or endpoints changed

## Security
- [ ] No secrets, credentials, or PII committed (checked with `git diff --stat`)
- [ ] Sensitive values use environment variables, not hardcoded strings

## Notes
- Any follow-up items or risks?
