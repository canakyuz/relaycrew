# Team access boundary

This fork adds an opt-in team mode to the upstream proxy. One shared account manager owns provider quota, credential refresh, and request admission. Each request carries an explicit access policy through the existing retry context.

## Usage

An administrator runs `teamclaude team init`, imports provider credentials, lists stable account IDs with `teamclaude team accounts`, and issues a member credential with `teamclaude team add`. A member sends that credential through `x-api-key` for HTTP inference or Proxy-Authorization for a managed MITM tunnel.

## Shape

`proxy.apiKey` identifies the administrator. With `proxy.teamMode: true`, `proxy.clientKeys` contains members with unique names and credentials, explicit stable account grants, and a concurrency limit. The literal `"*"` grants all accounts, including future additions. An array grants only its listed IDs. An empty array grants none.

`team-access.js` owns validation, credential fingerprints, account authorization, member concurrency leases, and private status. The main HTTP listener authenticates each request. A MITM listener binds the authenticated credential fingerprint and checks current membership on every inner request. Rotating a key invalidates an old binding even when the member name is reused.

The inference listener takes one lease before buffering the request. A lease lasts through retries and the complete response stream. Automatic account selection and failover receive a union of attempted accounts and currently denied accounts. Hard pins receive a separate authorization check. A final authorization callback runs after upstream admission and before opening the provider request. Reload cancels active requests whose credentials or selected-account grants have been revoked.

Internal session IDs include a digest of member identity and the client session ID. Original client headers are preserved on the wire. Member status contains only that member's grants, concurrency, and usage. Fleet status, management MCP, mutations, blind tunnels, and WebSocket relays require the administrator credential. The dashboard HTML is public and contains no account data.

## Synthesis decision

An independent native design compared AsyncLocalStorage with explicit request context. A separate Claude exploration confirmed the shared inference listener, hard-pin bypass, and credential-bound MITM seams. The explicit design was chosen because the retry context and selection exclusions already exist. Credential fingerprint bindings and stable account IDs were retained from the exploration findings.

The configured Grok design lane could not start its Linux sandbox because it could not resolve a denied container socket path. It supplied no candidate. No replacement provider was silently substituted.

## Alternatives considered

AsyncLocalStorage would hide authorization inside callbacks. A missing context at a transport event could become unrestricted access. Explicit `ctx.access` keeps the final dispatch check visible.

An account manager per member or pool would duplicate quota, refresh, and concurrency state. Sharing the existing manager avoids competing owners of provider state.

## Accepted limits

Concurrency applies to one running gateway process. Deploy one replica. There is no distributed queue or database.

Members receive an immediate 429 when their concurrency limit is reached. There is no additional team queue. Account and upstream admission retain their existing queues.

Member traffic supports pooled HTTP inference and HTTP inference inside managed MITM tunnels. Remote Control, arbitrary forwarding, and WebSocket model inference are unavailable to members in this version. The provider CLI may fall back to HTTP for model inference.

Upstream's fleet-wide health check can conservatively suppress overage fallback when an account outside a member's grant remains healthy. Unauthorized accounts are still excluded from selection.

The fork controls technical access. Administrators remain responsible for using provider credentials and account arrangements authorized for their organization.
