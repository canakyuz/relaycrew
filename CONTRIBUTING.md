# Contribute to RelayCrew

Contribute to this community fork at [sep1ol/relaycrew](https://github.com/sep1ol/relaycrew). We welcome first contributions, including documentation fixes and bug reproductions.

Follow the [code of conduct](CODE_OF_CONDUCT.md) when participating.

## Choose a contribution

- Improve setup instructions, examples, or troubleshooting in the [README](README.md) and [team operations guide](docs/teams.md).
- Reproduce a bug with synthetic configuration and a small local example.
- Improve local verification or add a test for behavior that lacks coverage.
- Check provider interoperability, including streaming, tool calls, error handling, and client compatibility. Record the gateway and client versions.
- Review an open pull request, try its documented steps, or check whether its tests cover the reported problem.
- Propose an improvement to team access, account grants, credential isolation, deployment, or provider compatibility.

Use [Discussions](https://github.com/sep1ol/relaycrew/discussions) for questions and to discuss a substantial change before implementing it. Use [Issues](https://github.com/sep1ol/relaycrew/issues) for reproducible bugs and concrete feature requests. Search existing threads first. You can open a focused fix without an issue.

Report vulnerabilities privately through [SECURITY.md](SECURITY.md). Never post real provider tokens, member keys, configuration files, account details, private request logs, or certificate private keys. Use synthetic examples in reports, tests, and screenshots.

## Create a branch in your fork

1. Fork [sep1ol/relaycrew](https://github.com/sep1ol/relaycrew) on GitHub.
2. Clone your fork. Replace `YOUR-USERNAME` with your GitHub username.

   ```sh
   git clone https://github.com/YOUR-USERNAME/relaycrew.git
   cd relaycrew
   git remote add upstream https://github.com/sep1ol/relaycrew.git
   git fetch upstream
   git switch --create fix/describe-your-change upstream/main
   ```

3. Make a focused change. Use English identifiers and documentation.
4. Preserve the default individual mode. If a change requires migration, document the affected behavior and migration steps.

This guide uses `upstream` for `sep1ol/relaycrew`. Open contributions against this fork's `main` branch, rather than the original `KarpelesLab/teamclaude` repository.

## Verify your change

For documentation-only changes, read the rendered Markdown, check links and paths, and verify any commands you changed. You do not need to rerun the runtime test suite locally. Describe what you checked in the pull request.

For runtime changes, install Node.js 20 or newer and run the checks below.

```sh
npm install --ignore-scripts
npm test
npm run lint
npm run typecheck
git fetch upstream
npm run typecheck:strict -- --base upstream/main
```

The strict typecheck compares diagnostics with `upstream/main`. Do not add diagnostics relative to that base.

For changes to authentication, authorization, routing, revocation, or concurrency, add behavior tests with local fake providers. Authentication and authorization tests must cover denied access as well as allowed access. Read the [test conventions](test/README.md) before adding network tests.

For a focused check of team access and commands, run:

```sh
node --test test/team-access.test.js test/team-command.test.js
```

These focused tests use local fake providers and do not spend provider quota. Report any live provider verification separately. Never require contributors to share credentials or private account data.

If you change the Nix package or module, run the Nix checks when Nix is available:

```sh
nix flake check --no-update-lock-file -L
nix run --no-update-lock-file .#teamclaude -- help
```

State any check you could not run and why. GitHub Actions runs the Node.js matrix and Nix checks on pull requests. The aggregate `test` check must pass before merge, including for documentation changes.

## Open a pull request

1. Review the diff for unrelated changes and private data.
2. Commit and push your branch to your fork.

   ```sh
   git add <changed-files>
   git commit -m "fix: describe the change"
   git push --set-upstream origin fix/describe-your-change
   ```

3. Open a pull request with **base repository** `sep1ol/relaycrew` and **base branch** `main`.
4. Use a Conventional Commit title such as `fix: correct member grants`. Explain the problem, the resulting behavior, and your validation. Link a related issue if one exists. Use a draft pull request for work that needs feedback before review.
5. Address review comments and push updates to the same branch.

Pull requests require one code-owner approval, the passing `test` check, an up-to-date branch, and resolved review conversations. If `main` advances, fetch and merge it into your branch, then push again:

```sh
git fetch upstream
git merge upstream/main
git push
```

The sole maintainer has an explicit administrative bypass for repository maintenance.

## Preserve licensing and attribution

Contributions use the repository's [MIT license](LICENSE). Preserve the original license and attribution. This project does not require a contributor license agreement or Developer Certificate of Origin sign-off. Provider account authorization remains governed by the relevant provider agreement.
