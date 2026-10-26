# Contribute to TeamClaude for teams

This fork accepts improvements to self-hosted team access, account grants, credential isolation, provider compatibility, deployment, and verification. Preserve the upstream individual mode unless a change explicitly documents its migration.

Use English identifiers and documentation. Add behavior tests with local fake providers when changing authentication, routing, revocation, or concurrency. Run `npm test`, `npm run lint`, and `npm run typecheck`. The strict typecheck must not add diagnostics relative to the base commit.

Never submit real provider tokens, member keys, configuration files, private request logs, or certificate private keys. Keep examples synthetic. Report credential leaks or authorization bypasses through the private reporting channel in [SECURITY.md](SECURITY.md).

Keep changes focused and explain the behavior the caller observes. Preserve the original MIT license and attribution. Provider account authorization remains governed by the relevant provider agreement.
