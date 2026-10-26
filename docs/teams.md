# Run a team gateway on a VPS

Use one gateway instance for one organization. Provider tokens remain on the VPS. Developers receive gateway member keys.

## Prepare the server

Clone this fork, install Node.js 20 or newer, and run the commands below as the Unix user that owns the gateway. Use a dedicated data directory.

```sh
umask 077
mkdir -p "$HOME/.config/relaycrew-team"
export RELAYCREW_CONFIG="$HOME/.config/relaycrew-team/config.json"
node src/index.js team init
node src/index.js login
node src/index.js team accounts
node src/index.js team add alice --accounts '<account-id>,<another-account-id>' --max-concurrent 4
```

Keep `RELAYCREW_CONFIG` set for subsequent commands. Provider login uses the original interactive flows described in [accounts](accounts.md). Use only accounts your organization is authorized to use for this arrangement.

Start the gateway under your service manager with `node /path/to/relaycrew/src/index.js server --headless`. Set `RELAYCREW_CONFIG` and `RELAYCREW_DISABLE_AUTOUPDATE=1` in the service environment. Bind the gateway to localhost behind HTTPS or connect through an SSH tunnel. Keep access to the protected configuration and state directory restricted to the gateway Unix user.

For an SSH connection, forward the gateway port from each developer machine.

```sh
ssh -N -L 3456:127.0.0.1:3456 gateway-user@your-vps
```

Each developer still presents their own member key. Team mode never trusts a request solely because it comes from localhost.

## Use Docker Compose

The included Compose file builds this repository and binds port 3456 to the VPS loopback interface.

```sh
mkdir -p data
chmod 700 data
docker compose build
docker compose run --rm gateway team init
docker compose run --rm gateway login
docker compose up -d
docker compose exec gateway relaycrew team accounts
docker compose exec gateway relaycrew team add alice --accounts '<account-id>'
```

`data/` contains secrets and is excluded from Git and the Docker build context. Back it up as private credential material. The container health check authenticates with the administrator key stored in its mounted configuration. Provider browser login may require an SSH callback tunnel; see the account login instructions.

## Connect Claude Code

For direct HTTP mode through the SSH tunnel, set the gateway URL and member key in the developer's environment.

```sh
export ANTHROPIC_BASE_URL=http://127.0.0.1:3456
read -rs -p 'Gateway member key: ' ANTHROPIC_API_KEY
export ANTHROPIC_API_KEY
printf '\n'
claude
```

Use your HTTPS hostname instead when the gateway is behind a TLS reverse proxy. Never send a member key over plain HTTP across the public internet. Direct mode uses Claude Code's API-key authentication path and can expose a different feature set from subscription sign-in.

To retain provider CLI subscription authentication, use the existing MITM mode with the member key in Proxy-Authorization. Obtain the gateway CA certificate from the administrator over a trusted channel and add it using `NODE_EXTRA_CA_CERTS`. Never copy the CA private key. Set `HTTPS_PROXY` to the authenticated gateway address. The format is `http://:<member-key>@127.0.0.1:3456` through the SSH tunnel. A provider account pin can occupy the username slot, producing `http://<account-pin>:<member-key>@127.0.0.1:3456`. Percent-encode userinfo components. Managed model requests use the member's account grant. Other tunnel destinations and Remote Control are refused in team mode.

## Connect Codex

For ChatGPT/Codex subscription accounts, configure a provider route to the gateway's Codex backend path. Merge this into your existing `~/.codex/config.toml`.

```toml
model_provider = "team_gateway"

[model_providers.team_gateway]
name = "Team gateway"
base_url = "http://127.0.0.1:3456/backend-api/codex"
wire_api = "responses"
requires_openai_auth = true
env_http_headers = { "x-api-key" = "TEAM_GATEWAY_KEY" }
```

Set `TEAM_GATEWAY_KEY` to your member credential in the environment that launches Codex. Sign in using the official Codex client. Its provider authentication remains separate from the gateway key. Use a Codex version supporting custom providers and environment-backed headers. The upstream Codex integration is experimental. Test your installed CLI's prompt, streaming, tool calls, and compaction before rolling it out. The automated suite verifies local protocol behavior rather than a live provider subscription.

For an OpenAI API-key account, use a provider base URL ending in `/v1` and the API authentication configuration supported by your Codex release. The account must point to its OpenAI-compatible upstream. Keep gateway authentication in `x-api-key`; the gateway injects the selected provider credential.

## Inspect member usage

Send `GET /relaycrew/me` with the member key in `x-api-key`. The response contains that member's account IDs or wildcard, active request count, concurrency limit, and token counters. It contains no provider tokens, other members, fleet sessions, or account names.

`team list` never prints credentials. `team rotate <name>` replaces a key and prints the replacement once. `team revoke <name>` disables the member. Reload invalidates old tunnel identities and cancels active requests whose access was revoked. Requests already accepted by a provider may have incurred usage before cancellation.

Grants refer to stable account IDs, so renaming or reordering accounts does not change permission. Removing an account leaves a stale grant that authorizes nothing. To change grants or a concurrency limit, edit the member entry in the protected configuration and restart the gateway process. Revocation and rotation retain the member's usage history because accounting is keyed by member name. Avoid reusing a departed employee's name for another person.

## Configuration reference

Set `proxy.teamMode` to `true`. `proxy.apiKey` is the administrator credential. Each `proxy.clientKeys` entry has these fields.

| Field | Value |
| --- | --- |
| `name` | Unique identifier, 1 to 64 letters, digits, underscores, dots, or hyphens. Starts with a letter or digit. |
| `key` | Unique secret generated by the administrator command. |
| `accounts` | An array of stable account IDs, or the literal `"*"` for all current and future accounts. An empty array grants no accounts. |
| `maxConcurrent` | Integer from 1 to 1024. Defaults to 4. |
| `disabled` | Boolean. Defaults to false. |

Missing account grants, duplicate identities or keys, and malformed limits refuse startup. Malformed team-policy reloads are refused before the running account configuration is synchronized. The administrator credential is never a member credential.

Member concurrency counts requests from admission until response completion or disconnection. A retry retains the same slot. A rejected request receives 429 with a short Retry-After. Another member's slots are independent. Limits apply within one gateway process.
