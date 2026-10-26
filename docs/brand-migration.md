# RelayCrew names and existing installations

RelayCrew is the canonical product, package (`@sep1ol/relaycrew`), command (`relaycrew`), environment prefix (`RELAYCREW_`), and control URL prefix (`/relaycrew`). The dashboard is `/relaycrew/dashboard`.

Existing `teamclaude` and `teamrouter` binary names and control URL prefixes remain accepted. All spellings pass through the same authentication, authorization, and cross-origin controls. Unrecognized control routes stay local instead of being forwarded to a provider.

Environment variables use the first defined spelling in this order: `RELAYCREW_*`, `TEAMROUTER_*`, `TEAMCLAUDE_*`. An explicitly empty canonical value masks inherited legacy values; individual settings still apply their own defaults.

New installations use `relaycrew.json`. Without an explicit config path, an existing `relaycrew.json`, `teamrouter.json`, or `teamclaude.json` is reused in that order. State, callback tokens and crash logs remain beside the selected configuration. Existing complete MITM certificate sets are reused, preserving the CA trusted by clients. No credential or certificate migration is required for ordinary CLI installations.

The Docker entrypoint follows the same environment precedence and discovers existing configuration files in `/data`. Both legacy binary names remain available in the image. Keep your existing volume and explicit settings.

`relaycrew service status` recognizes an installed legacy user service. An explicit `relaycrew service install` stops and retires the previous service before starting the canonical one. An unloaded legacy macOS service can be migrated or removed. A failed stop of a live service stops the installation instead of starting a competing daemon.

Nix installations using `services.teamclaude.enable` retain their previous default storage and user/group names. New `services.relaycrew.enable` installations use RelayCrew names. Keep explicit customized paths when changing option namespaces. See [Nix setup](../nix/README.md).

The callback.net credential-store key prefix remains `teamrouter.` because it identifies existing remote rows and refresh locks. It is a stored protocol identity, not the product name shown in the interface. The original upstream attribution and historical verification records also retain their original names.
