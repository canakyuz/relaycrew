# RelayCrew

Self-hosted gateway for Claude Code and Codex. Run one gateway on a VPS, keep provider credentials on the server, and issue each developer an individually revocable gateway key.

This community fork is maintained at [sep1ol/relaycrew](https://github.com/sep1ol/relaycrew). It retains the MIT license and history of [KarpelesLab/teamclaude](https://github.com/KarpelesLab/teamclaude). The upstream project targets individual use. This fork adds an explicit team access boundary.

## What team mode provides

- Individual member keys with creation, rotation, revocation, and usage attribution.
- Account permissions based on stable IDs, including overlapping account pools.
- Administrator-only fleet status, configuration controls, and management MCP.
- Private member usage at `GET /teamclaude/me`.
- Per-member concurrent request limits covering retries and streaming.
- Credential revalidation inside existing MITM tunnels.
- Persistent provider credentials and usage through the existing protected configuration and state files.

The default individual mode remains compatible with upstream. Team mode requires explicit activation. Codex support inherits upstream's experimental status. Use provider credentials and account arrangements authorized for your organization. A software fork does not change provider subscription terms or increase an account's quota.

## Install from source

Node.js 20 or newer is required. No runtime dependencies are needed.

```sh
git clone https://github.com/sep1ol/relaycrew.git
cd relaycrew
git switch main
node src/index.js team init
node src/index.js login
node src/index.js team accounts
node src/index.js team add alice --accounts '<account-id>' --max-concurrent 4
node src/index.js server --headless
```

Run `login` once for each provider account. It supports Claude OAuth, Codex OAuth, and API credentials through the existing login flows. See [accounts](docs/accounts.md). Member keys are printed only when created or rotated. Store and distribute them through a private channel.

The administrator key stays in the configuration file and is never printed by `team init`. Keep the file private. Do not give developers the server configuration or provider OAuth tokens.

To grant a member every configured account, including future additions, use an explicit wildcard.

```sh
node src/index.js team add bob --accounts '*' --max-concurrent 2
node src/index.js team list
node src/index.js team rotate alice
node src/index.js team revoke bob
```

Changes notify the local server. If a reload fails, the command reports that a restart is required. See [team operations](docs/teams.md) for installation on a VPS and client configuration.

## Verify changes

```sh
npm install --ignore-scripts
npm test
npm run lint
npm run typecheck
npm run typecheck:strict -- --base <previous-commit>
```

Focused team checks use local fake providers and do not spend provider quota.

```sh
node --test test/team-access.test.js test/team-command.test.js
```

See the [architecture](docs/team-architecture.md), [verification record](docs/team-verification.md), and [decision trail](docs/team-decisions.tsv). The original feature reference is preserved in [UPSTREAM.md](UPSTREAM.md).

## Deployment limits

Run one gateway replica. Member concurrency is enforced per process. Usage statistics persist through the existing state file; concurrency counters restart with the process.

Members can use pooled HTTP inference, directly or inside managed MITM tunnels. Arbitrary forwarding, Remote Control, and WebSocket relays are administrator-only. Team mode disables the implicit localhost trust exemption. The static dashboard HTML remains public; its fleet data requires the administrator key.

The repository is named RelayCrew. The CLI command remains `teamclaude` and package metadata uses `@sep1ol/teamclaude`. This repository does not claim an npm release. Install from source or build the included Dockerfile. Automatic npm publishing requires a manually triggered workflow and publisher configuration.

## Contribute

Start with the [contribution guide](CONTRIBUTING.md). Documentation fixes, bug reproductions, compatibility reports, tests, and code reviews all help. Look for [good first issues](https://github.com/sep1ol/relaycrew/labels/good%20first%20issue) or [help wanted](https://github.com/sep1ol/relaycrew/labels/help%20wanted).

Use [Discussions](https://github.com/sep1ol/relaycrew/discussions) for questions and early ideas. The [support guide](SUPPORT.md) explains where to report problems. Pull requests use the repository template and require review and CI. See the [maintainer process](MAINTAINERS.md) and [code of conduct](CODE_OF_CONDUCT.md).
