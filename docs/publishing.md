# Publishing Tallimeter

The steps that turn this repository into `paseo plugin install ivan-cavero/tallimeter` for anyone,
and into a listing on the Paseo plugin registry. Maintainer notes, not user documentation.

## What is already ready

- `paseo-plugin.json` with an id, a display name, a one-sentence description and
  `requirements.paseo`.
- `OVERVIEW.md` beside the manifest, written to the registry's content contract.
- `LICENSE` (MIT) and `README.md` with the install command.
- `package.json` with the repository URL, a version and the `files` list.
- No runtime dependencies: the plugin uses only host modules, so there is nothing to lock beyond
  the development tree, and the manifest declares no `build` step.

## 1. Push the repository

```bash
git remote add origin git@github.com:ivan-cavero/tallimeter.git
git push -u origin main
```

A public GitHub repository is enough for direct installation. No registry step is needed for
`paseo plugin install git:ivan-cavero/tallimeter` to work. The registry listing is what removes the
`git:` prefix, because a bare `owner/slug` is resolved against the registry and fails until it is
listed.

## 2. Add an interface image (recommended)

The registry requires at least one image for a visual plugin, and a plugin with a screen counts as
visual. Without one the reviewer asks for it before the listing goes live.

1. Open the Usage screen on a real install with real accounts.
2. Capture the grid, the meters and the trend chart. Hide anything private; a sample account name is
   fine, a real API key preview is not.
3. Save it as `docs/images/screenshot.png` and declare it in the manifest:

   ```json
   "media": ["docs/images/screenshot.png"]
   ```

4. Add `"docs/"` to the `files` list in `package.json` so npm publishes it too.

Commit that, then reload and check the card thumbnail in the app's plugin list.

## 3. Publish on npm (optional)

Git installation needs no npm package. Publish only if you want `npm:` installs and automatic update
PRs from the registry.

```bash
npm run verify
npm pack --dry-run --ignore-scripts
npm publish --access public
```

Check the dry-run file list contains `paseo-plugin.json`, `OVERVIEW.md`, `LICENSE`, both runtime
entries, and every imported module under `client/`, `server/` and `shared/`. Repository-only aliases
and files outside the package do not reach users.

The package must not be `private`, and `repository` must point at this public repository, because
the registry uses it to work out listing ownership.

## 4. Submit to the registry

1. Open <https://github.com/getpaseo/plugins/issues/new?template=submit-plugin.yml>.
2. Title: `Tallimeter`.
3. Source: `https://github.com/ivan-cavero/tallimeter`, or the npm package name if you published
   one. Add a tag or commit if you want a specific revision reviewed.
4. Categories: pick what fits; usage and cost tracking plus settings UI are the honest ones.
5. Description: mention the screenshot URL if you are not declaring it in the manifest.

The bot opens a review PR. A reviewer inspects the artefact **without running it**, checks the
dependency tree and the data access, and pins the approved commit. Publication then makes
`paseo plugin install ivan-cavero/tallimeter` resolve through the registry.

## What a reviewer will look at

Being ready for these questions is most of the work:

- **Data access.** Tallimeter reads transcripts on disk (`~/.claude`, `~/.codex`,
  `~/.local/share/opencode`, `~/.pi`, `~/.gemini`), Paseo's own `config.json` and `providers.json`,
  and its own credential file. It sends vendor credentials only to that vendor's own API, and
  never to a third party. There is no telemetry.
- **Network destinations.** Anthropic's usage endpoint, OpenCode's Go endpoint, OpenDesign's billing
  API and public price table, ChatGPT's backend, Google's Code Assist, and the balance or key
  endpoints of OpenRouter, Ollama, DeepSeek, Kimi and GitHub. `docs/providers.md` lists each one
  with its shape and the date it was checked.
- **Credentials handling.** A 0600 file outside Paseo's config, redacted to the last four
  characters in the UI, never returned to a client, never written to a log. The browser import
  copies the cookie database before reading it and verifies the session before storing it.
- **Processes.** No shell is used to read usage. `paseo reload` is the one child process, run
  after a provider entry changes. The browser import shells out to `secret-tool` or `security`
  to read the keyring entry.
- **What it does not do.** No failover, no reset redemption, no account switching. Saying that
  plainly is better than letting a reviewer discover an absent feature mid-review.

## Release checklist

- `npm run verify` is green.
- `paseo plugin install /path` reaches `running` on a clean daemon.
- `OVERVIEW.md` has no installation commands, which the validator rejects outright.
- The version in `package.json` and the tagged commit are the ones submitted.
- `git status` is clean, so the reviewed commit is the whole change.
