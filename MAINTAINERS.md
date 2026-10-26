# Maintain the community repository

[@sep1ol](https://github.com/sep1ol) maintains this fork and reviews contributions. The contribution process targets `sep1ol/relaycrew`, branch `main`. The upstream project maintains its own contribution policy.

## Triage contributions

Use Discussions for setup questions, usage reports, and early ideas. Use issues for reproducible bugs and concrete feature proposals. Keep security reports in the private channel listed in [SECURITY.md](SECURITY.md).

Confirm the scope and acceptance criteria before applying `help wanted`. Apply `good first issue` only to a bounded task with enough context for a new contributor. Documentation, test fixtures, and small compatibility fixes can be useful starting points. Do not promise a response or release date.

## Review pull requests

Check that the description explains the observed problem, the change, and its validation. Confirm that examples contain synthetic data. Request negative authorization tests for changes to authentication, grants, revocation, or routing. Preserve individual mode unless a migration is documented.

`main` requires one approving code-owner review, resolution of review conversations, and the GitHub Actions `test` check on an up-to-date branch. That aggregate check covers the Node.js matrix and Nix package checks. Docker runs only for relevant files and is not a universal required check.

Updated commits dismiss earlier approvals. Squash merging uses the PR title and description. Use a Conventional Commit title and keep the description suitable for the commit history. GitHub deletes merged PR branches automatically.

## Administrator exception

The repository currently has one administrator. Branch protection does not enforce its review and CI requirements on administrators, so the maintainer can handle their own changes and urgent fixes without needing a second reviewer. Administrators should still use PRs and wait for CI when practical. This exception is not an external contributor's merge permission.

Force pushes and deletion of `main` are disabled in the branch policy. Revisit administrator enforcement when another trusted maintainer can provide independent approvals. Do not add an untrusted account or an approval bot to work around the review requirement.

## Run workflows for public contributions

Fork PRs use the `pull_request` workflow. The CI workflow token has read-only repository contents access. Repository workflow tokens cannot approve PRs. First-time contributor workflow runs require maintainer approval.

Inspect workflow changes before approving a run. Keep provider tokens and other deployment credentials out of contributor workflows. The npm publish workflow is manually triggered and requires separate publisher configuration.
