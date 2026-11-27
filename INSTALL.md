# Install Tallimeter

A step-by-step guide for people who would rather follow a checklist than read a README. Takes
about five minutes, plus however long it takes to sign in to each vendor you want to track.

Tallimeter reports. It does not switch accounts, redeem resets or fail over for you.

## 1. Check Paseo

Tallimeter needs Paseo **0.17.4** or later. Check the version:

```bash
paseo --version
```

If the command is not found, install Paseo first and come back:
<https://paseo.sh/docs>

## 2. Turn plugins on

Paseo refuses to run any plugin while the global switch is off. There is no CLI command for it, so
in the app open **Settings → Plugins** and enable plugins there.

Check the switch took:

```bash
paseo plugin ls
```

An empty table is fine; an error about plugins being disabled is not. If you need to set it by
hand, it is `pluginsEnabled` in `~/.paseo/config.json`, and `paseo reload` picks the change up
without a restart.

On a remote or paired host, the switch belongs to that daemon: set it there, not in your local
copy.

## 3. Install the plugin

```bash
paseo plugin install git:ivan-cavero/tallimeter
```

The `git:` prefix is required until the plugin is listed in the registry. Without it, Paseo
looks for a registry listing and reports that the plugin was not found.

Paseo clones the repository, compiles the TypeScript and starts the plugin. There is no build
command in the manifest, so nothing runs `npm install` for you.

Confirm it reached `running`:

```bash
paseo plugin ls tallimeter
```

The STATUS column must read `running` and the ERROR column must be empty. If it failed, read the
actual error:

```bash
paseo plugin logs tallimeter
```

## 4. Open the screen

In the app, the sidebar gains a **Usage** row. If you do not see it, press **Ctrl+K** (or **⌘K**)
and type `Usage`.

On first open, tallimeter has already discovered the accounts Paseo has configured. Cards for your
existing Claude, OpenCode, Pi and OpenDesign providers appear without any setup, because the plugin
reads the same directories those agents write.

Cards with spend but no meters are normal at this point: a meter needs the vendor's own login or
credential, which is step 6.

## 5. Add accounts (optional)

Skip this if one account per vendor is enough.

**Settings → Plugins → Tallimeter → Accounts** lists every provider entry. **New account type**
picks which harness the new entry extends, and **Add account** writes the provider entry and asks
Paseo to reload its provider list.

Each family needs one manual sign-in step, because the plugin deliberately does not touch an agent's
login:

| Family | What to run | Then |
| --- | --- | --- |
| Claude | `CLAUDE_CONFIG_DIR=~/.claude-2 claude` | `/login` inside that session |
| OpenCode Go | nothing; open the new provider in Paseo | `/connect` inside it |
| OpenDesign | nothing after adding | paste the model key into that provider's settings |
| Pi | `PI_AGENT_DIR=~/.pi/agent-2 pi` | `/login` inside that session |

Use the exact directory the plugin prints in its confirmation message; it names the one it created.

## 6. Add credentials for the meters

Spend needs no credential: tallimeter reads it from the transcripts your agents already write.
**Allowance** needs one, because no CLI exposes a subscription's remaining percentage to a third
party.

Two paths:

**Read it from the browser (OpenDesign, Linux and macOS).** Sign in to <https://open-design.ai> in
Brave, Chrome, Chromium, Vivaldi or Edge. Then use
**Settings → Plugins → Tallimeter → Credentials → Read OpenDesign session from my browser**. The
plugin copies the cookie database, decrypts the session, verifies it against the live API, and
saves it server-side. The value never reaches the UI.

**Paste a key.** Same section, pick a vendor, give it a name and paste the credential value. Which
kind each vendor needs:

| Vendor | What to paste | Where to get it |
| --- | --- | --- |
| OpenDesign | a `vela_ctrl_…` control key, or the `__Secure-better-auth.session_token` cookie | control key from the `vela` CLI login; the cookie from browser DevTools |
| OpenRouter | an API key with access to `/api/v1/key` | <https://openrouter.ai/keys> |
| Ollama Cloud | an API key | <https://ollama.com/settings/keys> |
| DeepSeek | an API key | <https://platform.deepseek.com/api_keys> |
| Kimi | an API key | <https://platform.moonshot.ai/console/api-keys> |

Claude, Codex, Gemini and Copilot need **no credential at all**: tallimeter reads the login those
CLIs already stored on disk.

After saving, press **Verify** on the row. It makes one cheap request and says whether the provider
accepted the value. A credential that cannot be checked live says so rather than pretending.

## 7. Set budgets (optional)

**Settings → Plugins → Tallimeter → Budgets** takes a monthly budget per account. A card with a
budget gains a percentage, a projection to the end of the cycle, and the date the projection crosses
the budget. Leave the field empty for an account you do not want to budget.

**Cycle** sets the day a billing period starts and the hours and hourly rate used to translate
spend into days of work. Leaving the rate at zero keeps "days of work" hidden, which is the point:
without a rate it would be an invented number.

Budgets and cycle settings are saved together on the same host, so a budget set on a desktop is
visible on the phone that connects to that host.

## 8. Verify it works

- The Usage screen shows a card per account, sorted by spend.
- Opening a card shows the projection and the model split.
- If a vendor credential was saved, that card shows meters with a reset countdown.

```bash
paseo plugin logs tallimeter
```

The first line of every snapshot is a summary like
`[tallimeter] 4 stores, 3 cards; OpenDesign · shared plan:2w`, which tells you how many stores were
read and how many windows came back. If it says `no reading` for a vendor you set up, that vendor's
credential is missing, rejected, or of the wrong kind.

## Troubleshooting

**`paseo plugin install` fails on the Paseo version.** Update Paseo. Plugin installation checks
`requirements.paseo` before it clones anything.

**The plugin installs but the sidebar row is missing.** Check `paseo plugin ls tallimeter`: the
status must be `running`. Then check the host picker in the screen header: a plugin runs per daemon,
and a remote host is a separate install.

**A card shows spend but no meters.** That vendor has no readable allowance from the credential you
stored. Open the card: the empty state names the vendor's own documentation page. Claude and Codex
read their CLI login, so this usually means that CLI is not signed in.

**An OpenDesign card shows no meters even though you are signed in.** An `sk-amr-…` model key is
chat-only. Save the browser session or a `vela_ctrl_…` control key instead.

**The browser import says it found nothing.** Sign in to open-design.ai in the *same* browser profile
you are importing from, and make sure that browser is the one you use on this machine. On Windows,
use the paste path: Chromium wraps its cookie key with DPAPI, which this plugin cannot unwrap.

**OpenCode cards say `no node:sqlite`.** The Paseo runtime you are using lacks `node:sqlite`. Update
Paseo; the other vendors read from JSONL and do not need it.

**Numbers are stale.** The screen refreshes every 15 seconds and the reading time is printed next to
the total. Vendor allowance reads are cached 90 seconds to stay inside their rate limits; the
**Re-read quotas** button bypasses that cache.

**A spend total looks too low.** A model with no known price counts as zero and appears in the
warning line under the grid. OpenDesign publishes its price table publicly and the plugin caches
it for a day; Claude falls back to list price.

## Uninstall

```bash
paseo plugin remove tallimeter
paseo plugin disable tallimeter    # or just disable it
```

`remove` deletes the plugin but keeps your account provider entries, so the CLIs keep their logins.
It does not delete `~/.paseo/tallimeter-credentials.json` either; delete that file yourself if you
want the stored credentials gone.
