# Contributing

Thanks for looking. This is a small plugin with a narrow job, and the rules below exist so the
numbers stay honest.

## Run it locally

```bash
git clone https://github.com/ivan-cavero/tallimeter
cd tallimeter
npm install
npm run verify                 # typecheck the client, the server and the tests, then run them
paseo plugin install /absolute/path/to/tallimeter
```

`paseo plugin install` from a directory keeps the runtime id `tallimeter`; `paseo plugin reload
tallimeter` after every source change. There is no build step: Paseo compiles the TypeScript itself.

Useful commands:

| Command | What it does |
| --- | --- |
| `npm run verify` | The gate: three typechecks plus the whole test suite |
| `npm test` | The suites alone, offline |
| `npm run test:live` | Probes the real vendor endpoints; needs real credentials and hits the network |

## The rules that matter

1. **A vendor's allowance is never derived from local token counts.** Spend may be estimated from
   tokens and a price table; a quota window may only come from the vendor. When a read fails, return
   `null` rather than a guess, and the card shows spend with no meter.
2. **Credentials never leave the server.** No RPC returns a secret, no log line contains one, and
   the UI only ever sees the last four characters. Credentials live in
   `~/.paseo/tallimeter-credentials.json`, never in Paseo's `config.json` (its schema rejects unknown
   keys under `agents`) and never in plugin settings, which every connected client can read.
3. **Client code is React Native only.** `View`, `Text`, `Pressable`, `ScrollView`, `TextInput` from
   `react-native`, colours from `theme.colors`, no DOM global, no `className`, no `onClick`. The
   audit the Paseo docs recommend is a good habit before a PR:

   ```bash
   rg -n "document\.|window\.|localStorage|navigator\.|<[a-z]+[ >]|className=|onClick=" client/
   ```

4. **Every number states its unit.** `$1.26 · 561 turns`, never `561t`.
5. **A meter identity comes from the vendor's own field**, such as `durationSeconds`, never from
   array position, so a reordered response cannot mislabel a window.

## Adding a vendor

1. Add an entry to `BRANDS` in `server/registry.ts`: label, Lucide fallback icon, accent colour,
   docs URL, credential kinds, and whether it exposes a subscription, a balance, or nothing.
2. Add a mark to `server/brand-marks.ts`, authored in the shared `0 0 100 100` box and scaled to
   fill about 78% of it. Monochrome glyphs get a tile that clears 4:1 contrast against white.
   Prefer [Simple Icons](https://simpleicons.org) (CC0) for the geometry.
3. Write the reader in `server/quota/<vendor>.ts` as two functions:
   - `parseX(body)` — a pure mapping from the vendor's documented response to `Quota`.
   - `readX(...)` — the network call, with a cache, a timeout, and `null` on any failure.
4. Wire it into `server/quota/index.ts` in both `readQuota` and `quotaRequestForStore`.
5. Add fixtures to `tests/fixtures.ts` and a parser test in `tests/providers.test.ts` or
   `tests/providers-extra.test.ts`. Record the shape from the vendor's documentation, and say in the
   test comment where it came from.
6. Document the endpoint, the response shape, the quirks and the date you checked it in
   `docs/providers.md`, and mark it unverified if you had no real credential.

## Tests

One suite per concern: provider parsers against recorded fixtures, credential-file permissions and
redaction, cycle maths, account discovery, cost and cache ratio, plan grouping, brand marks, and the
network path against a stubbed `fetch` so no request leaves the machine. A bug fix should come with
the test that would have caught it.

## Commits

[Conventional Commits](https://www.conventionalcommits.org): `feat:`, `fix:`, `docs:`, `test:`,
`refactor:`, `chore:`, `perf:`, each with a scope when it helps. The subject states the change in the
imperative, and the body says why rather than what.

## Pull requests

- Run `npm run verify` and say that it passed.
- Reload the plugin and say what you saw on the screen, and on which host.
- If you touched the client, check a wide window and a compact one, and both themes.
- If a number changed, say which number and where it came from.

## Licence

Contributions are under the MIT licence in [LICENSE](LICENSE).
