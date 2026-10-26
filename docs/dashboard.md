# Operate the RelayCrew dashboard

Start the gateway, then open `/relaycrew/dashboard` on its origin. For a local installation the default address is `http://localhost:3456/relaycrew/dashboard`. `relaycrew dashboard` opens it in your browser. Use HTTPS or an SSH tunnel when connecting to a VPS.

The page itself is public and contains no account data. Requests for data and controls use the gateway's authentication rules. In team mode use the administrator key. Team management and usage history always require that key, including on localhost. Member keys cannot inspect the fleet or manage another member.

## Workspace views

- Overview shows the current fleet, account availability and operational problems.
- Accounts retains quota windows, resets, account eligibility, credits and usage details. Switch accounts, change priorities and enable or disable them.
- Team lists members, explicit account grants, concurrency and usage. Add members, edit grants and limits, revoke access, reactivate a member or rotate a key.
- Usage combines existing cumulative/windowed counters with historical distribution by member or configured usage dimension.
- Sessions retains conversation details, filters, sorting and account pins.
- Settings provides threshold controls, configuration reload, quota probes and routing information.

The dashboard updates the existing status snapshot every five seconds. Team and history data are fetched when their views need them. Errors remain visible rather than replacing missing data with a healthy status.

## Manage team access

Enable team mode with `relaycrew team init` before adding members. Provider sign-in still runs on the gateway through `relaycrew login`; provider credentials never need to reach a developer's browser.

Choose explicit stable account IDs or deliberately grant all current and future accounts. Member names identify usage and stay immutable. A member can have no account grants, which denies inference until grants are assigned.

A created or rotated key appears only in its mutation response and the one-time reveal dialog. Copy it before closing the dialog and distribute it privately. Normal listings never return the key. Revocation, rotation and grant removal refresh the live access policy and cancel affected in-flight requests.

Changes use an optimistic revision and the shared configuration lock. If someone else changes the team, refresh and review the latest policy before saving your draft again. A stale whole-configuration save cannot restore older team keys or grants. A busy live writer causes the write to fail instead of proceeding without its lock.

A successful response distinguishes `saved` from `applied`. If the configuration was saved but a runtime reload failed, the response retains any newly issued key and explains that a reload is required. Do not retry key issuance just because the reload failed.

## Read historical distributions

History projects the existing persisted 15-minute usage slots. Select the last five or 24 hours, 15-minute or hourly buckets, and requests, input tokens or output tokens. Compare members or one configured usage dimension. The largest 12 series appear separately; the remaining series are combined while preserving totals. Charts and their accessible tables use the same values.

The first and current buckets may be partial. Missing samples mean no recorded activity; they do not prove that the server was online and idle. Old state without slots cannot be backfilled. Normal restarts restore saved slots, while an abrupt shutdown may lose usage since the latest state save. Retention is bounded to the existing 24-hour window plus its boundary slot. There is no weekly historical series or reconstructed bill.

Member history accounts for requests attributed to named keys. Administrator or unattributed traffic does not become a member series. Dimension totals describe the same traffic from another perspective and must not be added to member totals.

## Administrative API

All responses below use `Cache-Control: no-store`. Send the administrator key in `x-api-key`. Mutations use POST and must satisfy the same-origin browser checks.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/relaycrew/team` | Member/account choices and current revision, without credentials |
| POST | `/relaycrew/team/add` | Create a member and issue a key |
| POST | `/relaycrew/team/update` | Update grants, concurrency and enabled state |
| POST | `/relaycrew/team/rotate` | Replace a member key |
| POST | `/relaycrew/team/revoke` | Disable a member |
| GET | `/relaycrew/usage/history` | Bounded historical counters |

Every mutation includes `revision` and `name`. Add/update include `accounts` and `maxConcurrent`; update also includes `disabled`. Creation and rotation alone return `issuedKey`. Conflicts return 409 and lock contention returns 503.

History requires `scope=clients` or `scope=dimension&dimension=<configured-name>`, `window=5h|24h`, `step=15m|1h`, and `metric=requests|inputTokens|outputTokens`. Unknown or repeated parameters are refused. The response contains aligned `buckets`, bounded `series`, and conserved `total` values plus coverage metadata.

## Preview without provider credentials

Run `npm run preview` from a source checkout. It starts an isolated loopback-only gateway at `http://localhost:43190/relaycrew/dashboard` with clearly labeled synthetic accounts, members and 24-hour history. It prints the temporary protected configuration path; read its administrator key there to sign into the local demonstration. `RELAYCREW_PREVIEW_PORT` selects another unprivileged port. Stop with Ctrl+C to stop the gateway and remove its temporary configuration. The preview never imports your provider accounts and uses a local synthetic upstream.

## Recover an interrupted configuration lock

A live holder is never bypassed. Normal dead-PID lock recovery is serialized by a separate `.lock.recovery` guard. If a process crashes while holding that recovery guard, stale-lock recovery fails closed. Stop the gateway and all other configuration writers before manually removing the abandoned `.lock` and `.lock.recovery` files beside the configuration. Restart only after cleanup. Never delete a lock while a writer may still be running.
