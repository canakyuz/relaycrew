# Independent review

The team boundary received an independent review from a GPT-6 Astra agent. The review inspected the changed source, configuration, tests, deployment guide, and decision trail. It also produced nine local reproductions using fake providers and the real HTTP request pipeline.

## Findings corrected before publication

- Fresh team initialization now creates the required member array. Follow-up list, add, rotate, and revoke commands work after initialization.
- Revocation closes the active response and cancels upstream work. Uploads, egress holds, and account admission no longer retain the revoked member's concurrency slot.
- Hard pins bind a stable account ID before the body is read. Removing another account during upload does not redirect the pin.
- Internal session identity includes the role. A member named `admin` cannot collide with the administrator's session.
- Member requests cannot enter the cross-provider client-credential relay to bypass account grants.
- Empty account grants remain valid deny-all policies and can still be listed, rotated, and revoked through the CLI.
- Members named `constructor` or `toString` receive zero usage counters before their first request. Status uses an own-property lookup.
- The final provider authorization check runs after upstream admission. A queued request whose authorization changes never reaches the fake provider.

The independent reproductions passed after the fixes. Deterministic versions are committed in the team test files. The final transport test uses a real CONNECT/TLS/HTTP2 tunnel, and the container smoke check uses the running server's actual reload hook.

## Evidence limits

The review found no remaining credential or account-boundary blocker in its inspected source. It did not establish live provider acceptance, subscription eligibility, installed CLI compatibility, or production readiness for a specific organization. Run a real CLI pilot with your authorized provider accounts before rollout.

Member concurrency is enforced in one process. Historical MITM cache entries tied to rotated credential fingerprints remain until restart. This affects long-running installations with frequent key rotation; it does not make old credentials valid again.

Malformed team policies are refused before account synchronization. This is narrower than a guarantee that every possible upstream configuration reload is atomic.

No actionable new-comment or suppression finding remained. Type declarations were preserved. The initial milestone timestamps in the decision trail are approximate reconstructions; later entries record the time they were written.
