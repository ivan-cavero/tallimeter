# Installing Tallimeter with an AI agent

Hand the block below to your coding agent (Claude Code, Codex, OpenCode, Pi, Gemini CLI, Copilot,
or anything else that can read files and run commands on your machine). It is written so the agent
inspects your setup first, tells you what it found, and only then installs anything.

---

## The prompt

```text
Install the Paseo plugin "Tallimeter" on this machine, then set it up and report what works
and what does not.

Repository: https://github.com/ivan-cavero/tallimeter
Paseo docs: https://paseo.sh/docs/plugins

Work in this order and show me the output of each step. Do not skip a failed step, and do not
invent a result.

1. INSPECT. Report these facts before changing anything:
   - operating system and architecture (Linux, macOS, or Windows; WSL counts as Linux)
   - `paseo --version`; tallimeter needs >=0.17.4
   - `paseo plugin ls`
   - whether plugins are enabled: look for `pluginsEnabled` in ~/.paseo/config.json
   - which agents are installed and signed in: claude, codex, opencode, pi, gemini, gh
   - whether each of these exists and is non-empty:
     ~/.claude, ~/.claude.json, ~/.codex/auth.json, ~/.local/share/opencode/opencode.db,
     ~/.pi/agent/sessions, ~/.gemini/oauth_creds.json
   - the provider entries in ~/.paseo/config.json under agents.providers, and for each whether
     it is enabled and what CLAUDE_CONFIG_DIR / XDG_DATA_HOME / PI_AGENT_DIR it uses
   - whether node:sqlite is available in the Paseo runtime (it reads OpenCode usage)
   - whether the desktop keyring tool exists: `secret-tool` (Linux) or `security` (macOS)

2. INSTALL. Run `paseo plugin install git:ivan-cavero/tallimeter`. The `git:` prefix is
   required: a bare owner/repository is treated as a registry listing. If the source is already a local
   checkout, use `paseo plugin install /absolute/path/to/tallimeter` instead. Then require
   `paseo plugin ls tallimeter` to say "running" with an empty error column. If it does not,
   read `paseo plugin logs tallimeter` and quote the error.

3. WIRE UP ACCOUNTS. Do not create new accounts unless I ask; existing providers already appear.
   For each provider entry I do have, check that its store directory exists and is readable, and
   tell me which cards will therefore have spend.

4. CREDENTIALS. List which vendors can produce an allowance meter and which cannot, given the
   logins found in step 1. Claude, Codex, Gemini and Copilot read the login their CLI already
   stored, so they need nothing. OpenDesign, OpenRouter, Ollama, DeepSeek and Kimi need a
   credential and tallimeter has no way to get one for you: tell me exactly which value to paste
   and where, and stop there. If I am on Linux or macOS and signed in to open-design.ai, you may
   use "Read OpenDesign session from my browser" from the plugin settings on my confirmation.
   Never paste a credential into a file, a command line, or chat.

5. VERIFY. Re-open the Usage screen, or read `paseo plugin logs tallimeter` and quote the
   summary line it prints, e.g. "4 stores, 3 cards; OpenDesign:2w". State which cards have spend,
   which have meters, and which have neither, and why.

6. REPORT. Give me a short table: vendor, spend visible, meter visible, and the next action for
   each row that is incomplete. Say plainly if something is unsupported on this OS.

Rules: this plugin is reporting-only, so do not attempt failover or reset redemption. Do not edit
files inside ~/.paseo/plugins/*. Do not restart the Paseo daemon. Do not print the contents of
~/.paseo/tallimeter-credentials.json or any vendor token store. If you need to change Paseo's
config, back it up first and show me the diff.
```

---

## What the agent will find, and what it means

The prompt asks for an inspection first because the interesting failure modes are all local:

| Finding | Meaning |
| --- | --- |
| `paseo --version` below 0.17.4 | Installation is refused by the manifest check, not by a bug. Update Paseo. |
| `pluginsEnabled` false | Every plugin is disabled. `paseo plugin install` succeeds but nothing loads. |
| No agent stores at all | The plugin loads and shows an empty grid. That is correct, not broken. |
| Provider with a gateway base URL | It is billed per token, so it gets spend and no subscription window. |
| No `secret-tool` on Linux | Browser session import cannot decrypt cookies. Paste the cookie instead. |
| Windows | Browser session import is unsupported by design (DPAPI). Paste the cookie. |
| No `node:sqlite` | OpenCode cards show no spend; every other vendor is unaffected. |

## If the agent gets stuck

The three commands that resolve most problems:

```bash
paseo plugin ls tallimeter     # status and load error
paseo plugin logs tallimeter   # startup, snapshot summary, handler errors
paseo plugin reload tallimeter # after a source change
```

The plugin's own log line after each refresh lists the stores it read and the window count it got
back per plan, which is the fastest way to see whether a credential did its job.

Never ask an agent to "just make it work" by editing files under `~/.paseo/plugins/`: that
directory is a managed checkout and Paseo overwrites it. A fix belongs in a fork, or as a local
install pointed at your own copy.
