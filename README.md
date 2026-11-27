# Tallimeter

A Paseo plugin that tells you what your coding agents actually cost, per account, and how much
subscription allowance each one has left.

Tallimeter (a tally meter) answers four questions the vendors' own dashboards answer badly or not
at all:

- **What did I spend this cycle, and on what?** Every account gets a card with its cost, turns,
  tokens, cache-hit rate, per-model split and a 30-day line chart.
- **How much allowance is left, and when does it come back?** Claude's 5-hour and weekly windows,
  OpenCode Go's rolling/weekly/monthly windows, OpenDesign's coding-plan windows and wallet, and
  the balance or quota of the other vendors, read from each vendor's own API.
- **Am I going to run out?** A projection to the end of the cycle, and a per-day pace: "18% a day
  keeps it to the reset".
- **Which of my ten accounts is the expensive one?** A compact grid, one card per account, sorted
  by spend.

Tallimeter never estimates a quota from local token counts. If a vendor read fails, the card keeps
its spend numbers and shows no window, because an invented percentage looks authoritative and
is worse than an empty meter.

## Install

```bash
paseo plugin install git:ivan-cavero/tallimeter
```

The prefix goes away once the plugin is listed in the Paseo registry, which turns the same command
into `paseo plugin install ivan-cavero/tallimeter`.

Either form is the whole install. Paseo compiles the TypeScript itself, so there is no build step and no
`npm install` on your machine. Tallimeter requires Paseo 0.17.4 or later.

From a checkout instead:

```bash
git clone https://github.com/ivan-cavero/tallimeter
paseo plugin install /absolute/path/to/tallimeter
paseo plugin ls tallimeter        # expect status "running"
```

Then open **Settings → Plugins → Tallimeter** and go to the **Accounts** and **Credentials**
sections.

Not sure how to do any of that? [INSTALL.md](INSTALL.md) is a step-by-step guide for Linux, macOS
and Windows, and [docs/install-with-ai.md](docs/install-with-ai.md) is a prompt you can hand to an
AI agent so it does the install and the setup for you.

## What you get

**Usage screen.** One card per account: brand mark, name, spend this cycle, turns, tokens and
cache-hit share. Up to three allowance meters, each with a pace marker. Always-visible chips for
share of the cycle, actual daily spend, recommended daily spend and time to the reset. Several
cards can be open at once, and each keeps its own column, so opening one never re-flows the grid.

**Allowance meters.** A percentage used, a countdown to the reset, a distinction between
subscription windows and prepaid wallets, and one dot per day of the window showing where an even
spend would have reached by now.

**30-day trend.** A line chart with a cost axis of round ticks, five dated ticks, one line per
account, a dashed average-day rule and a tooltip that names the day and splits it by account. Under
it, the models that took the most over the same window.

**Per-card projection.** Spend to today, a dotted continuation at the same pace, the budget ceiling,
the point where the projection crosses it, and the reset.

**Budgets and workdays.** A per-account cycle budget with percentage and projection. If you set an
hourly rate, spend is also shown as days of work; without a rate that figure stays hidden instead
of being invented.

## Which providers are covered

| Provider | Spend | Allowance |
| --- | --- | --- |
| Claude (Anthropic) | Claude Code transcripts, priced at list price | 5-hour and weekly windows, model-scoped weekly windows, extra-usage spend |
| OpenCode Go | OpenCode's SQLite database, per turn cost | Rolling 5-hour, weekly and monthly windows |
| OpenDesign | OpenCode or Pi transcripts | 5-hour and weekly plan windows, wallet balance |
| Codex (ChatGPT plan) | Codex transcripts | 5-hour and weekly windows, credits |
| Gemini (Code Assist) | Gemini transcripts | Per-model quota buckets |
| OpenRouter | Gateway turns | Per-key budget window, remaining credit |
| Ollama Cloud | Gateway turns | Monthly included allowance, purchased credits |
| DeepSeek | Gateway turns | Prepaid balance |
| Kimi | Gateway turns | 5-hour, weekly and monthly coding-plan windows |
| GitHub Copilot | Copilot turns | Monthly premium-request allowance |
| Pi | Pi transcripts | Whatever vendor login the session uses |

Claude, OpenDesign and GitHub Copilot are verified against real accounts here. The rest are
implemented from the vendors' own documentation and tested against recorded response shapes, and
are marked **unverified live** in [docs/providers.md](docs/providers.md) until someone with a real
credential runs `npm run test:live`.

## Multiple accounts per vendor

Each account is its own Paseo provider entry with its own login directory, so two Claude
subscriptions or two OpenDesign plans are two cards with two credentials. The plugin can create
those entries for you from its settings screen:

| Family | What it creates | How you sign in |
| --- | --- | --- |
| Claude | `extends: claude` plus its own `CLAUDE_CONFIG_DIR` | `CLAUDE_CONFIG_DIR=… claude`, then `/login` |
| OpenCode Go | `extends: opencode` plus its own config and data directories | `/connect` inside that provider |
| OpenDesign | `extends: claude` with the AMR gateway environment | model key in the provider, control key or browser session for the meter |
| Pi | `extends: pi` plus its own `PI_AGENT_DIR` | sign in with `/login` |

Removing an account deletes the provider entry and deliberately leaves its directory on disk, so a
click never destroys a login.

## Credentials

Subscription and billing reads need a credential the agent CLIs do not hand out: an OpenDesign
session cookie, an OpenRouter management key, a DeepSeek balance key. Claude, Codex, Gemini and
Copilot are different: tallimeter reads the login those CLIs already stored and never asks for a
copy.

- Stored in `~/.paseo/tallimeter-credentials.json`, written atomically with mode `0600`.
- Never in Paseo's `config.json`, whose schema rejects unknown keys under `agents`.
- Never in plugin settings, which every connected client can read, phones included.
- Never returned to a client. The UI shows the last four characters of a value, which is enough to
  tell two keys apart and useless to an attacker.
- Portable. The file is plain JSON, so copying it to another machine moves the accounts.
- Not encrypted at rest. There is no key you could carry separately, and a local key would be
  false confidence. The file relies on filesystem permissions, like other local tooling.

OpenDesign's dashboard cookie can be imported straight from your browser on Linux and macOS:

- **Linux**: reads Brave, Chrome, Chromium, Vivaldi or Edge via `secret-tool`. Chromium's
  AES-128-CBC / PBKDF2-SHA1 `saltysalt` scheme is implemented directly, the cookie database is
  copied before it is read so a running browser is never disturbed, and the session is verified
  against the live API before it is saved.
- **macOS**: the same, with the login Keychain via `security`.
- **Windows**: Chromium wraps its cookie key with DPAPI, which Node cannot unwrap without a native
  module, so the import says so and you paste the cookie instead. Paste setup is the same on all
  three platforms.

An `sk-amr-…` OpenDesign model key is chat-only and cannot read billing. A `vela_ctrl_…` control
key works, and so does the browser session, which is the same credential the web dashboard uses.

## Requirements and limits

- Paseo **0.17.4** or later, on Linux, macOS or Windows. The UI is React Native, so the same screen
  works in the desktop app, the browser and on a phone.
- OpenCode usage needs `node:sqlite` in the Paseo runtime. Without it, OpenCode cards report no
  spend and the rest still works.
- Reporting and account management only. No failover and no reset redemption; that is a different
  plugin's job.
- Quota reads are cached for 90 seconds per account, because Anthropic and the other vendors
  rate-limit usage endpoints. The screen refreshes every 15 seconds.
- A model with no known price counts as zero and appears in a warning line. Free gateway variants
  are genuinely free and are counted as such.

## Development

```bash
npm install
npm run verify      # typecheck client, server and tests, then run the suite
npm run test:live   # probe the real endpoints; needs real credentials, hits the network
```

```
paseo-plugin.json          manifest
index.client.tsx           screen, sidebar row, Command Center item, settings screens
index.server.ts            snapshot, accounts and credentials RPCs
client/usage-screen.tsx    cards, meters, settings UI
client/trend-panel.tsx     30-day line chart
client/projection-chart.tsx per-card projection
server/stores.ts           account discovery and transcript readers
server/aggregate.ts        cycle math, projection, per-model split, history
server/quota/*.ts          one reader per vendor
server/brand-marks.ts      brand marks, all in one 0 0 100 100 box
shared/contracts.ts        Zod contracts and the settings document
```

`npm test` runs the suites offline: provider parsers against recorded fixtures, credential-file
permissions and redaction, cycle maths, discovery and its transcript cache, quota routing, cost and
cache ratio, plan grouping, browser-import refusals, brand marks, and the network path against a
stubbed `fetch`, so no request leaves the machine. 126 tests across 10 files.

## Publishing notes

Publishing is documented in [docs/publishing.md](docs/publishing.md). `OVERVIEW.md` is the listing
page inside Paseo and follows the registry's content contract; `README.md` is this page.

The verification job in `.github/workflows/verify.yml` runs `npm run verify` on every push and pull
request, so a broken parser or a missing typecheck fails before it reaches a release.

## Licence and trademarks

MIT. See [LICENSE](LICENSE).

Provider names and logos belong to their owners and are used only to label which account a number
came from. Most marks come from [Simple Icons](https://simpleicons.org) (CC0 1.0); OpenAI,
OpenCode, OpenDesign and Pi marks come from the vendors' own site assets.
