# Tallimeter

Tallimeter reports what your coding agents cost and how much subscription allowance they have left,
per account, inside Paseo.

It reads spend from the transcripts and databases the agents already write, and it reads allowance
from each vendor's own API. It never estimates a remaining percentage from local token counts: when a
vendor read fails, the card keeps its spend numbers and shows no meter, because a guessed
percentage looks authoritative.

## What it shows

One card per account on the Usage screen. Each card carries the brand, the spend this cycle, the
turn count, the tokens, the cache hit share, up to three allowance meters, and the card's share of
the cycle against its actual and recommended daily spend. Cards sort by spend and sit in a grid that
fits one to three columns, and opening a card adds a projection chart and a per-model split without
reflowing the rest of the grid.

An allowance meter shows the percentage used, the countdown to its reset, and a marker for the
daily pace that would stretch the remainder to that reset. Subscription windows and prepaid wallets
are drawn differently, because a wallet with no cap is not a percentage.

A 30-day chart plots daily spend as one line per account, with a cost axis, dated ticks, an average
day reference and a tooltip that names the day and splits it by account. The models that took the
most over the same window are listed under it.

A budget per account adds a percentage, a projection to the end of the cycle, and the date the
projection crosses the budget. An hourly rate, if you set one, also translates spend into days of
work.

## Providers

Spend is read for Claude, OpenCode Go, OpenDesign, Codex, Gemini, OpenRouter, Ollama, DeepSeek,
Kimi, GitHub Copilot and Pi.

Allowance comes from the vendors that expose it: Claude's 5-hour and weekly windows, OpenCode Go's
rolling, weekly and monthly windows, OpenDesign's plan windows and wallet, Codex's 5-hour and
weekly windows plus credits, Gemini's per-model buckets, OpenRouter's per-key budget, Ollama's
included allowance and purchased credits, DeepSeek's prepaid balance, Kimi's coding-plan windows and
Copilot's monthly premium requests.

Claude and OpenDesign were verified against real accounts while building this. The others are built
from their vendors' published responses and tested against recorded shapes, which is stated per
vendor in the repository's provider notes.

## Setup

Paseo accounts need no setup. The plugin discovers the providers Paseo already has configured and
reads the directories those agents write, so a Claude, OpenCode, Pi or OpenDesign account appears
with its spend as soon as the plugin runs.

An allowance meter needs the vendor's own credential, because no agent CLI hands out a
subscription's remaining percentage:

- Claude, Codex, Gemini and GitHub Copilot need nothing: the plugin reads the login those CLIs
  already stored on disk and never asks for a copy.
- OpenDesign, OpenRouter, Ollama, DeepSeek and Kimi need a key, a control key or a browser session,
  pasted once in the plugin's Credentials settings. On Linux and macOS, an OpenDesign session can
  instead be read from Brave, Chrome, Chromium, Vivaldi or Edge, verified against the live API and
  stored server-side. On Windows that import is unavailable, because Chromium wraps its cookie key
  in a form Node cannot unwrap, and pasting the cookie is the alternative.

The plugin can create additional provider entries from its Accounts settings, one per account, each
with its own login directory. Removing an entry leaves that directory on disk so a click never
destroys a login.

It requires Paseo 0.17.4 or later and runs on Linux, macOS and Windows. Its UI is React Native,
so the same screen works in the desktop app, in the browser and on a phone.

## Data access

The plugin reads transcript and database files written by the agents it reports on: Claude
transcripts, Codex auth and transcripts, the OpenCode database, Pi sessions and the Gemini login. It
reads Paseo's own provider configuration to know which accounts exist, and it reads its own
credential file.

Credentials live in one file the plugin owns, written atomically with permissions limited to the
user. They are never written to Paseo's configuration, never stored in plugin settings, which
every connected client can read, and never returned to a client: the UI shows the last four
characters only. The file is plain JSON, so copying it to another machine moves the accounts, and it
is not encrypted at rest, relying on filesystem permissions instead.

Vendor credentials are sent only to that vendor's own API, to read allowance and model prices. No
usage data leaves the machine.

## Limits

The plugin reports and manages accounts. It does not switch accounts, redeem resets or fail over.

Vendor allowance reads are cached for ninety seconds per account to stay inside those vendors'
rate limits. A model with no known price counts as zero and is named in a warning line. OpenCode
spend needs `node:sqlite` in the Paseo runtime; without it, OpenCode cards report no spend and
every other vendor is unaffected.
