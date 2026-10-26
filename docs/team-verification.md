# Team gateway verification

The initial upstream checkout was `d50ca5c`. Before implementation, `npm test` reported 3,055 tests, with 3,028 passed, 23 failed, and four cancelled on Node.js 22.16.0 in WSL. Lint and the non-strict typecheck passed.

Most initial failures came from CLI reload notifications with no timeout and tests assuming that fixed low-numbered localhost ports immediately refuse connections. This host drops those connections. Three failures came from a provider-reset fixture expiring on October 22, 2026 while the tests used the real clock. The fixture tests now control their clock, and local reload notification has a deadline. Fixed-port failure fixtures now allocate and close an ephemeral port. The NXDOMAIN tests isolate the external DNS boundary because the full suite exposed resolver stalls absent in standalone runs.

## Team behavior

`node --test test/team-access.test.js test/team-command.test.js` passed all 39 tests at the first integrated checkpoint. These tests run real HTTP requests, socket handshakes, CLI subprocesses, streaming responses, and temporary configuration files against local fake providers.

The checks cover authentication without a localhost exemption, member/admin separation, own usage, stable account grants, pins, quota and server-error failover, credential stripping, concurrency slots, disconnect cleanup, member session isolation, bound tunnel identity rotation, configuration refusal, and member administration.

An upstream compatibility selection covering client usage, reverse-proxy authentication, WebSocket authentication, and session ID handling passed all 66 tests, including the CLI member tests.

## Limits of the evidence

No real Anthropic or OpenAI subscription was used. The suite does not prove current provider acceptance, OAuth policy compatibility, or behavior in every Claude Code or Codex release. The deployment guide calls for a real CLI pilot before an organization rollout.

Docker deployment configuration is supplied. A production VPS was not accessed or deployed by this implementation task.

The strict check permits existing upstream diagnostics to remain and refuses increases per file. It is not a claim that the upstream tree passes TypeScript strict mode without diagnostics.

Final full-suite and publication results are appended after integration and independent review.


## Final checks

- Complete `npm test` passed with 3,119 passed, five platform skips, zero failures, and zero cancellations. The full run includes 51 team-specific tests. The skipped tests require a dual-stack localhost resolver that this WSL environment does not expose.
- `npm run lint` and `npm run typecheck` passed.
- `npm run typecheck:strict -- --base d50ca5c` passed with 1,647 existing diagnostics against 1,652 at the base, with no per-file increase.
- `docker compose config --quiet` and `docker build -t sep1ol-teamclaude:dev .` passed.
- The real HTTP/2 test completes CONNECT and TLS, makes an inference request, rotates the key, refuses the old tunnel, and accepts a new tunnel with the replacement key.
- The container smoke check passed under the same capability restrictions as Compose. It starts the real CLI server and verifies administrator isolation, live key rotation through the CLI reload hook, and live revocation. It uses synthetic credentials and does not request a provider model.

To repeat the container check after building the image, mount `test-helpers/team-container-smoke.mjs` at `/smoke.mjs` and run it through `docker-entrypoint.sh` with an empty tmpfs at `/data`. The script refuses to run without an explicit container configuration path.

The independent review and corrected findings are recorded in [team review](team-review.md). The repository is published under `sep1ol/relaycrew`; `main` contains the implementation. No npm registry release or production deployment is part of this delivery.
