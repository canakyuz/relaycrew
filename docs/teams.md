# Deploy a team gateway on a VPS

This walkthrough installs one RelayCrew gateway for one organization. Provider credentials stay on the VPS. Each developer receives an individual member key. At the end, you can open the dashboard, run Claude Code or Codex through the gateway, and revoke a developer's access.

Use only provider accounts your organization is authorized to use for this arrangement. Provider sign-in runs through the CLI on the gateway. The web dashboard manages existing accounts and team access.

## 1. Choose an installation

Use a Linux VPS with SSH access, `sudo`, Git, and curl. The native examples use Debian or Ubuntu with systemd and Bash. Replace `admin@your-vps` with your existing SSH administrator account. The dedicated `relaycrew` service account created below cannot accept SSH logins.

Choose one installation. Both use port 3456 on the VPS loopback interface, so do not start both on the same port.

- [Native Node.js with systemd](#2a-install-nodejs-and-systemd) keeps code in `/opt/relaycrew` and private data in `/home/relaycrew/.config/relaycrew-team`.
- [Docker Compose](#2b-install-with-docker-compose) keeps code in `/opt/relaycrew` and private data in `/opt/relaycrew/data`.

For the native installation, install a supported [Node.js LTS release](https://nodejs.org/en/about/previous-releases), such as Node.js 24, system-wide. The examples use `/usr/bin/node`. If your installation uses another absolute path, replace `/usr/bin/node` in the commands and unit. The service user must be able to execute it; a binary inside your administrator's private NVM directory is unsuitable. RelayCrew requires Node.js 20 or newer, but use a maintained release for a new deployment. The gateway has no npm runtime dependencies.

For Compose, install [Docker Engine and the Compose plugin](https://docs.docker.com/engine/install/ubuntu/). Check `sudo docker version` and `sudo docker compose version` before continuing. Node.js runs inside the image.

For the initial connection, keep the gateway private and use an [SSH tunnel](#3-connect-through-ssh-or-https). A public HTTPS endpoint additionally needs a domain pointing to this VPS and inbound TCP ports 80 and 443. Port 3456 stays private in either case.

## 2a. Install Node.js and systemd

Run these commands in your administrator's SSH session on the VPS. Use a fresh `/opt/relaycrew` directory.

```bash
sudo useradd --system --user-group --home-dir /home/relaycrew --create-home --shell /usr/sbin/nologin relaycrew
sudo install -d -m 0755 -o relaycrew -g relaycrew /opt/relaycrew
sudo install -d -m 0700 -o relaycrew -g relaycrew /home/relaycrew/.config/relaycrew-team
sudo -u relaycrew -H git clone --branch main https://github.com/sep1ol/relaycrew.git /opt/relaycrew
sudo -u relaycrew -H /usr/bin/node --version
```

The last command must print the supported Node.js version you installed. If it fails, correct the Node path or its permissions before installing the service.

Define this helper in the same administrator shell. It runs the gateway CLI as the service user with the same configuration the unit will use. Keep this shell open for later `rc` commands. To use a new shell, define the helper again.

```bash
rc() {
	sudo -u relaycrew -H env \
		RELAYCREW_CONFIG=/home/relaycrew/.config/relaycrew-team/config.json \
		RELAYCREW_DISABLE_AUTOUPDATE=1 \
		/usr/bin/node /opt/relaycrew/src/index.js "$@"
}
rc team init
```

`team init` enables team mode and creates the administrator key in the private configuration. It does not print that key. Before the gateway starts, an absent-server reload warning is expected; the configuration was still saved.

### Sign provider accounts in

For a Claude subscription account, use the copy-and-paste login flow:

```bash
rc login --token
```

Open the printed URL in your laptop's browser, sign in, and paste the returned code into the VPS prompt. Repeat the command for each account. For an Anthropic API-key account, use `rc login --api` instead and enter the provider key at its prompt.

For a ChatGPT/Codex account:

```bash
rc login --codex
```

Open the printed URL in your laptop's browser. If the browser cannot load `http://localhost:1455/auth/callback`, copy the complete callback address from its address bar into the VPS prompt. Keep the `code` and `state` parameters. Do not add `--token` to this command; that flag selects the Claude login flow. See [signing accounts in over SSH](accounts.md#signing-accounts-in-over-ssh) for the optional native callback tunnel.

List the configured account IDs:

```bash
rc team accounts
```

Expect at least one account for the provider your developers will use. Keep the account ID for [creating a member](#5-connect-a-developer). An account ID grants access independently of its display name.

### Install the system service

Save the following unit as `/etc/systemd/system/relaycrew.service`. Replace the Node binary path if needed. Credentials belong in the private configuration, not in this unit.

```ini
[Unit]
Description=RelayCrew team gateway
Documentation=https://github.com/sep1ol/relaycrew
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=relaycrew
Group=relaycrew
WorkingDirectory=/opt/relaycrew
ExecStart=/usr/bin/node /opt/relaycrew/src/index.js server --headless
Restart=on-failure
RestartSec=5
UMask=0077
Environment=RELAYCREW_CONFIG=/home/relaycrew/.config/relaycrew-team/config.json
Environment=RELAYCREW_DISABLE_AUTOUPDATE=1
Environment=RELAYCREW_HOST=127.0.0.1

[Install]
WantedBy=multi-user.target
```

Validate and start the service:

```bash
sudo systemd-analyze verify /etc/systemd/system/relaycrew.service
sudo systemctl daemon-reload
sudo systemctl enable --now relaycrew.service
sudo systemctl status relaycrew.service
sudo journalctl -u relaycrew.service --lines 50 --no-pager
```

Expect an active service and a log line showing `127.0.0.1:3456`. If validation reports a missing Node executable, fix `ExecStart` before starting the service. To follow logs, run `sudo journalctl -u relaycrew.service --follow`. To restart, run `sudo systemctl restart relaycrew.service`.

The explicit host setting keeps this installation on loopback. Legacy `TEAMCLAUDE_*` and `TEAMROUTER_*` environment names remain accepted, but use `RELAYCREW_*` for new installations.

`relaycrew service install` creates a per-user unit at `~/.config/systemd/user/relaycrew.service`. This walkthrough uses a system unit, so it starts at boot without a login session or a separate linger configuration.

Continue at [connecting through SSH or HTTPS](#3-connect-through-ssh-or-https).

## 2b. Install with Docker Compose

Run these commands in your administrator's SSH session on the VPS. Use a fresh checkout. The repository's `compose.yaml` publishes only `127.0.0.1:3456` on the VPS, while the process listens on the container network interface.

```bash
sudo git clone --branch main https://github.com/sep1ol/relaycrew.git /opt/relaycrew
cd /opt/relaycrew
sudo install -d -m 0700 -o 1000 -g 1000 data
sudo docker compose build
sudo docker compose run --rm gateway team init
```

This example uses the image's default UID and GID, both 1000. The entrypoint runs the gateway as that unprivileged identity. If an existing deployment uses different IDs, use its IDs for directory ownership and subsequent `exec --user` commands. `data/` holds the configuration, runtime state, and certificate material. It is excluded from Git and the Docker build context.

### Sign provider accounts in

For a Claude subscription account:

```bash
sudo docker compose run --rm gateway login --token
```

Open the printed URL on your laptop, then paste the returned code into the container's prompt. For an Anthropic API-key account, replace `login --token` with `login --api`.

For a ChatGPT/Codex account:

```bash
sudo docker compose run --rm gateway login --codex
```

Open the URL on your laptop. Copy the complete `http://localhost:1455/auth/callback?...` address from the browser's address bar into the prompt if the callback page cannot load. This manual flow does not require publishing port 1455 from the container. Do not combine `--token` with `--codex`.

### Start the gateway

```bash
sudo docker compose up -d
sudo docker compose ps
sudo docker compose logs --tail 50 gateway
```

The container should become healthy after its startup interval. Its health check uses the administrator key from the mounted configuration. To follow logs, run `sudo docker compose logs --follow gateway`. To restart, run `sudo docker compose restart gateway`.

Define the following helper in the same shell for commands against the running container:

```bash
rc() {
	sudo docker compose -f /opt/relaycrew/compose.yaml exec \
		--user 1000:1000 \
		--env HOME=/data \
		--env RELAYCREW_CONFIG=/data/relaycrew.json \
		gateway relaycrew "$@"
}
rc team accounts
```

`compose exec` bypasses the image entrypoint. The explicit user prevents CLI writes from changing configuration ownership to root. The explicit configuration path selects the gateway's mounted data. Use this helper for live team changes; a separate `compose run` container cannot reload the running gateway over its own loopback interface.

Expect at least one account for the provider your developers will use. Keep its ID for [creating a member](#5-connect-a-developer).

## 3. Connect through SSH or HTTPS

### Use an SSH tunnel

Run this command on each developer's laptop, not on the VPS:

```bash
ssh -N -L 127.0.0.1:3456:127.0.0.1:3456 admin@your-vps
```

Leave the tunnel running in its terminal. The gateway is now at `http://127.0.0.1:3456` on that laptop. If port 3456 is already occupied locally, change only the first port, for example `127.0.0.1:3457:127.0.0.1:3456`, and use port 3457 in the client URLs below.

Each developer needs authorized SSH access to establish their own tunnel. Use an administrator or separately provisioned SSH account, not the `nologin` service user. Every request still needs a gateway member key. Team mode never trusts a request solely because it reaches loopback.

### Use a public HTTPS hostname

Alternatively, point a DNS name such as `gateway.example.com` at the VPS. Install [Caddy](https://caddyserver.com/docs/install) as a host service using its package instructions. Allow inbound TCP ports 80 and 443 in the VPS firewall and provider firewall, and retain your SSH access. Do not publish port 3456 publicly.

Add this site to `/etc/caddy/Caddyfile`, replacing the example hostname. If Caddy already serves other sites, append this block rather than replacing their configuration.

```caddyfile
gateway.example.com {
	reverse_proxy 127.0.0.1:3456
}
```

Validate and load the configuration:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
sudo systemctl status caddy
```

Caddy obtains and renews the public certificate when [automatic HTTPS requirements](https://caddyserver.com/docs/automatic-https) are satisfied. Its [reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy) handles WebSocket upgrades and streaming responses. Preserve the complete request paths, `x-api-key`, and `Authorization` headers if you choose another reverse proxy. Forward `/relaycrew/`, `/v1/`, and `/backend-api/codex/` on the same origin.

Use `https://gateway.example.com` instead of the tunnel's HTTP origin in the remaining steps. The gateway page is public; its data and controls require authentication. Publishing the page does not grant administrator access.

## 4. Verify the gateway and dashboard

On the VPS, verify that an unauthenticated fleet request is refused:

```bash
curl --silent --output /dev/null --write-out '%{http_code}\n' \
	http://127.0.0.1:3456/relaycrew/status
```

Expect `401`. A connection error means the service, container, or port needs attention. An unexpected `200` means team mode is not enforcing authentication on this installation; check that the server loaded the configuration initialized above.

Retrieve only the administrator key in a private terminal. For the native installation:

```bash
sudo -u relaycrew -H /usr/bin/node -p \
	'JSON.parse(require("node:fs").readFileSync("/home/relaycrew/.config/relaycrew-team/config.json", "utf8")).proxy.apiKey'
```

For Compose:

```bash
sudo docker compose -f /opt/relaycrew/compose.yaml exec --user 1000:1000 gateway node -p \
	'JSON.parse(require("node:fs").readFileSync("/data/relaycrew.json", "utf8")).proxy.apiKey'
```

Store this administrator key privately. Do not give developers the server configuration, provider tokens, or administrator key. `team init` deliberately does not print it.

On your laptop, open `http://127.0.0.1:3456/relaycrew/dashboard` through the tunnel, or `https://gateway.example.com/relaycrew/dashboard` through Caddy. Enter the administrator key. Confirm that Accounts lists your signed-in providers and Team allows member management. The [dashboard guide](dashboard.md) explains all six views.

To verify an authenticated request from your laptop without putting the literal key in shell history or curl's arguments, use Bash:

```bash
read -r -s -p 'Gateway administrator key: ' rc_admin_key
printf '\n'
printf 'x-api-key: %s\n' "$rc_admin_key" | \
	curl --fail-with-body --silent --show-error --header @- \
		http://127.0.0.1:3456/relaycrew/status
unset rc_admin_key
```

Expect JSON with the account status. Use the HTTPS origin instead when testing Caddy. These status checks do not send an inference request to a provider.

## 5. Connect a developer

### Issue an individual key

In the VPS shell where you defined `rc`, list stable account IDs and create a member:

```bash
rc team accounts
rc team add alice --accounts '<account-id>,<another-account-id>' --max-concurrent 4
rc team list
```

Replace the example IDs with actual IDs from `team accounts`, without the output's JSON quote marks. Grant only the accounts the developer should use. A quoted `'*'` deliberately grants all current and future accounts. Give Claude users Claude account access and Codex users access to the appropriate Codex provider accounts.

Creation prints the new member key once. Deliver it privately to that developer. The dashboard can also create a member and reveal its key once. A failed reload message means the change was saved but still needs a service restart; do not issue another key to fix a reload failure.

### Check the member's access

On the developer's laptop, use Bash and enter their member key:

```bash
read -r -s -p 'Gateway member key: ' TEAM_GATEWAY_KEY
export TEAM_GATEWAY_KEY
printf '\n'
printf 'x-api-key: %s\n' "$TEAM_GATEWAY_KEY" | \
	curl --fail-with-body --silent --show-error --header @- \
		http://127.0.0.1:3456/relaycrew/me
printf 'x-api-key: %s\n' "$TEAM_GATEWAY_KEY" | \
	curl --silent --output /dev/null --write-out '%{http_code}\n' --header @- \
		http://127.0.0.1:3456/relaycrew/status
```

Expect `/relaycrew/me` to return only this member's grants, concurrency, and usage. Expect the fleet `/relaycrew/status` request to return `403`. A member key cannot open the administrator dashboard's data. Substitute your HTTPS origin if applicable.

### Configure Claude Code

For direct HTTP mode through the SSH tunnel, use a fresh shell for this gateway configuration:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:3456
unset ANTHROPIC_AUTH_TOKEN
export ANTHROPIC_API_KEY="$TEAM_GATEWAY_KEY"
claude
```

For HTTPS, set `ANTHROPIC_BASE_URL=https://gateway.example.com`. Keep `TEAM_GATEWAY_KEY` from the preceding prompt in this shell, or enter it again. Existing managed settings or a credential helper may also affect authentication; see the [Claude Code gateway instructions](https://code.claude.com/docs/en/llm-gateway).

Send a short prompt, then check the member's counters in Team or Usage. This check uses provider capacity. Direct mode uses Claude Code's API-key authentication path and can differ from subscription sign-in.

To retain the client's subscription authentication, use [MITM proxy mode](proxy-modes.md) with the member key in `Proxy-Authorization`. Obtain the gateway's public CA certificate from the administrator through a trusted channel and set `NODE_EXTRA_CA_CERTS`. Never distribute a private certificate key. Through the SSH tunnel, `HTTPS_PROXY` has the form `http://:<member-key>@127.0.0.1:3456`; an account pin can use the username slot. Percent-encode userinfo components. Team mode refuses unrelated tunnel destinations and Remote Control. An HTTPS reverse proxy alone does not expose a forward CONNECT proxy; use the SSH tunnel for this mode.

### Configure Codex

For ChatGPT/Codex subscription accounts, merge the following into the developer's user-level `~/.codex/config.toml`. Keep unrelated existing settings. Use a unique provider name if `team_gateway` is already defined.

```toml
model_provider = "team_gateway"

[model_providers.team_gateway]
name = "RelayCrew team gateway"
base_url = "http://127.0.0.1:3456/backend-api/codex"
wire_api = "responses"
requires_openai_auth = true
env_http_headers = { "x-api-key" = "TEAM_GATEWAY_KEY" }
```

For HTTPS, change `base_url` to `https://gateway.example.com/backend-api/codex`. Keep `TEAM_GATEWAY_KEY` exported in the environment that launches Codex. Sign into the official Codex client with its normal login flow, then start `codex`. Its client authentication remains separate from the gateway member key. The administrator's `rc login --codex` configures the VPS provider account; it does not sign the developer's Codex client in.

Use a Codex version supporting custom providers and environment-backed headers. See the [official OpenAI configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) for those settings. RelayCrew's upstream Codex integration is experimental. Test a prompt, streaming, tool calls, and compaction with your installed CLI before rolling it out. Local tests do not establish live subscription compatibility.

For an OpenAI API-key account, use a provider base URL ending in `/v1` and the API authentication configuration supported by that Codex release. Configure the account's OpenAI-compatible upstream first. Keep gateway authentication in `x-api-key`; RelayCrew injects the selected provider credential.

## 6. Operate the team

Use Team in the administrator dashboard to edit account grants, concurrency, or enabled state. You can also rotate or revoke a key from the VPS shell:

```bash
rc team rotate alice
rc team revoke alice
rc team list
```

Rotation prints a replacement key once. Update that developer's environment before they reconnect. Revocation disables the member. Both refresh the running policy and cancel affected in-flight requests. A request already accepted by a provider may have incurred usage before cancellation. If the CLI reports that live reload failed, restart the service or container before treating the change as applied.

Grants use stable account IDs, so renaming or reordering accounts does not change permission. Removing an account leaves a stale grant that authorizes nothing. Revocation and rotation retain usage because accounting is keyed by member name. Avoid reusing a departed employee's name for another person.

Usage shows cumulative counters and historical distributions for the last five or 24 hours. Missing samples mean no recorded activity, not proof that the gateway was online. History is restored from saved state after a normal restart. It is not a billing ledger or a weekly archive.

### Back up private data

Stop the gateway before taking a consistent backup. For the native installation:

```bash
sudo systemctl stop relaycrew.service
sudo sh -c 'umask 077; tar -C /home/relaycrew/.config/relaycrew-team -czf /root/relaycrew-backup-$(date -u +%Y%m%dT%H%M%SZ).tgz .'
sudo systemctl start relaycrew.service
```

For Compose:

```bash
cd /opt/relaycrew
sudo docker compose stop gateway
sudo sh -c 'umask 077; tar -C /opt/relaycrew/data -czf /root/relaycrew-backup-$(date -u +%Y%m%dT%H%M%SZ).tgz .'
sudo docker compose up -d
```

The entire data directory contains credentials and certificate material. Keep its backup private and encrypted in your backup system. Restore into a stopped installation, preserve the data layout, restore the service user's ownership, and restrict directory access before starting. Review member access after restoring an older backup because it may predate a revocation. Provider credentials may need a fresh login. Keep the existing certificate material when restoring to preserve client trust.

### Upgrade and recover

Automatic updates are disabled in both installation paths. Record the installed revision before updating. For native installations:

```bash
sudo -u relaycrew -H git -C /opt/relaycrew rev-parse HEAD
sudo -u relaycrew -H git -C /opt/relaycrew pull --ff-only origin main
sudo systemctl restart relaycrew.service
sudo systemctl status relaycrew.service
```

For Compose:

```bash
cd /opt/relaycrew
sudo git rev-parse HEAD
sudo git pull --ff-only origin main
sudo docker compose build
sudo docker compose up -d
sudo docker compose ps
```

Take a backup first and repeat the dashboard and member checks after upgrading. If an upgrade fails, stop the gateway, check out the recorded revision in the source checkout, and restart the native service or rebuild and start Compose. Keep the current data unless a documented migration specifically requires restoring a backup. Restarting or rolling back code interrupts active requests.

### Troubleshoot an installation

| Symptom | Check |
| --- | --- |
| Connection refused | Check `systemctl status`, `docker compose ps`, logs, and the configured port. |
| SSH tunnel cannot bind | Use an unused local port and update the laptop's URLs. |
| TLS certificate fails | Check DNS, inbound ports 80 and 443, and Caddy logs. Do not bypass certificate validation. |
| `401` from the gateway | Check the member key, revocation state, environment, and correct configuration file. |
| `403` from fleet endpoints | Member keys are intentionally refused. Use the administrator key for fleet data and controls. |
| `429` from the gateway | Check the member's concurrency limit and account availability. Another member has independent slots. |
| Member change saved but not applied | Restart the service or container, then repeat `/relaycrew/me` with the expected key. |
| CLI appears to use another configuration | Recreate the documented `rc` helper. Docker `exec` needs the explicit path, HOME, and user. |
| Account needs sign-in | Repeat provider login on the VPS, then reload or restart. Check [account troubleshooting](accounts.md). |
| Configuration lock remains busy | Check live writers first. Follow [lock recovery](dashboard.md#recover-an-interrupted-configuration-lock) only after stopping all writers. |

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

Member concurrency counts requests from admission until response completion or disconnection. A retry retains the same slot. Limits apply within one gateway process; do not run several gateway instances against the same data directory as a distributed pool.
