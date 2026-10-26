# Security policy

Report credential exposure, cross-member access, or account authorization bypasses privately through [GitHub security advisories](https://github.com/sep1ol/teamclaude/security/advisories/new). Do not put credentials, personal prompts, or exploit details in public issues. If private reporting is unavailable, open an issue requesting a private contact without including vulnerability details.

The maintained fork is [sep1ol/teamclaude](https://github.com/sep1ol/teamclaude). The original project is [KarpelesLab/teamclaude](https://github.com/KarpelesLab/teamclaude). This fork retains the original MIT license and is maintained independently.

Run the gateway under a dedicated Unix account. Keep its configuration, state, logs, and certificate private keys private. Use HTTPS or an SSH tunnel for remote clients. Run one replica; member concurrency enforcement is local to the gateway process.

Team mode is opt-in. Give developers member keys. Keep `proxy.apiKey`, provider credentials, management MCP, and fleet status restricted to administrators. A member key can spend every account explicitly granted to it, so treat wildcard grants as access to all current and future accounts.

Only repository files and synthetic fixtures belong in commits. The `data/` directory is excluded from Git and the Docker build context. A gateway key, provider token, or private key must never be pasted into an issue, test result, or screenshot.
