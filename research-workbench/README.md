Research Workbench
==================

A private tool for doing equity research the same way every time, so the
research can be calibrated later.

The chain it records: **evidence → interpretation / assumption → financial
metric → EPS → valuation → target price**, then **trade → outcome → review**.
Every Research Update keeps what you believed, why, which evidence caused
the change, what changed, and how it moved EPS and the target price.

Each company can also be linked to its Excel model (`.xlsx` in the Obsidian
vault). The **Assumptions** page reads the file, lists the assumptions that
wait for a decision first, recalculates trial values with the workbook's own
formulas, shows which assumption moves the target price most, and writes the
numbers you decide on back into the file. Excel stays the only store of those
numbers. With Tailscale the site also opens on your phone.

- 中文使用說明：[`docs/使用說明.md`](docs/使用說明.md)
- Product spec: [`docs/PRODUCT_SPEC.md`](docs/PRODUCT_SPEC.md)
- Architecture, prototype review and self-critique: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- Data model and SQL schema: [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md)

Install on a Mac
----------------

Paste this line into Terminal (macOS 11 or later, Apple Silicon or Intel):

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/zyaoceng/organism/claude/vibrant-thompson-s3npyj/research-workbench/scripts/mac/install.sh)"
```

Re-running the same line is the update. It installs the commit named in
[`release.json`](release.json) (the last one that passed the Mac install
workflow), never whatever is on the branch at that moment. It needs no
Homebrew, Node or Xcode: `install.sh` downloads the official Node.js tarball
(Node 24, or Node 22 before macOS 13.5), checks its SHA-256 against the value
written in the script, and runs `scripts/mac/install.mjs` with it, which:

- downloads that commit, runs `npm ci` and `npm run build` into
  `~/ResearchWorkbench/app-<sha7>/` and points `~/ResearchWorkbench/current` at it;
- keeps the data in `~/Library/Application Support/ResearchWorkbench/` and the
  logs in `~/Library/Logs/ResearchWorkbench/`;
- imports `~/Downloads/wb-data.tgz` (or `--import <file>`), a data archive from
  the old Codespaces setup, after showing what is in it;
- starts the server as a LaunchAgent (`com.researchworkbench`, port 4310) and
  rolls back to the previous version and database when the new one does not
  answer `/api/health` within 60 seconds;
- builds `~/Applications/研究工作台.app`, which opens the site and starts the
  server if needed;
- registers the MCP adapter with Claude Desktop, Claude Code and the ChatGPT
  desktop app (a config file it edits is backed up first);
- with Tailscale signed in on the Mac, offers phone access: it runs
  `tailscale serve --bg <port>` and gives the LaunchAgent the HTTPS host name
  and the one Tailscale account to let in;
- offers to install the Obsidian plugin into one of your vaults, and tells the
  server that vault folder, which is where linked Excel files must be.

Add options after ` -- `, for example `… install.sh)" -- --doctor`:

| Option | Meaning |
|---|---|
| `--doctor` | Print diagnostics (Node, better-sqlite3, launchd, health check, port, data, backups, AI and Obsidian registration, vault folder access, `tailscale serve` and the phone URL) and exit |
| `--dry-run` | Check and print what would happen; change nothing |
| `--uninstall` [`--purge`] | Remove the LaunchAgent, the app and `~/ResearchWorkbench`; data is kept unless `--purge` |
| `--import <file>` | Import a data archive (default `~/Downloads/wb-data.tgz`) |
| `--port <n>` | Serve on another port (remembered) |
| `--yes`, `-y` | No prompts; take the default answers |
| `--no-register` | Do not register with the AI apps |
| `--obsidian`, `--obsidian-vault <dir>`, `--no-obsidian` | Choose the Obsidian vault again, install into this vault, or skip the plugin |
| `--tailscale`, `--no-tailscale` | Set up phone access through Tailscale (or redo it), or turn it off. `--yes` alone never turns it on. Neither can be combined with `--uninstall` |
| `--source-dir <dir>`, `--no-launchd` | Install from a local checkout, skip the LaunchAgent and app (CI) |

The Chinese guide [`docs/使用說明.md`](docs/使用說明.md) walks through it.

Running from source
-------------------

Needs Node.js 20.10 or later (developed on Node 22).

```bash
cd research-workbench
npm install
npm run dev          # API on 127.0.0.1:4310 + UI on http://localhost:5173
```

Production-style single process (API and built UI on one port):

```bash
npm run build        # vite build (dist/client) + build:mcp + build:obsidian
npm start            # http://127.0.0.1:4310
```

`npm run build` runs three steps, each also available on its own:

| Script | Output |
|---|---|
| `vite build` | the web UI in `dist/client/` |
| `npm run build:mcp` | the MCP adapter bundle `dist/mcp/research-workbench-mcp.mjs` (esbuild; the build fails if it pulls in the server, the client, better-sqlite3, Fastify or React) |
| `npm run build:obsidian` | the Obsidian plugin in `dist/obsidian-plugin/` (`main.js`, `manifest.json`) |

`npm run mcp -- --client=claude-code --data-dir=<absolute data dir>` runs the
adapter from source (stdio). Optional offline example with a fictional company
and synthetic prices:

```bash
npm run seed:demo
```

| Environment variable | Default | Meaning |
|---|---|---|
| `WORKBENCH_DATA_DIR` | `./data` | SQLite file (`workbench.db`), uploaded files (`attachments/`), `tokens.json` and `backups/` (daily copies in `daily/`, kept 14 days + 8 weeks; `pre-v<N>-…` before a schema migration and `pre-import-…` before a data import, never deleted) and `workbook-backups/<project id>/` (the copy of a linked Excel file taken before each write-back, newest 30 kept) |
| `WORKBENCH_PORT` | `4310` | API port (the dev UI proxies `/api` to it) |
| `WORKBENCH_HOST` | `127.0.0.1` | Bind address. There is no login, so keep it local or put an authenticating proxy in front |
| `WORKBENCH_ALLOWED_HOSTS` | (none) | Extra `host:port` names, comma-separated, that requests may use. The server accepts only `127.0.0.1:<port>` and `localhost:<port>` (plus `WORKBENCH_HOST`) and refuses requests from other web origins |
| `WORKBENCH_VAULT_DIR` | (none) | The folder linked Excel files must be in. Wins over the folder saved through `PUT /api/settings/vault-dir` (which the Mac installer calls with the Obsidian vault) |
| `WORKBENCH_HTTPS_HOSTS` | (none) | Bare host names (no scheme, port or path), comma-separated, that `tailscale serve` forwards to this server over HTTPS. Each is accepted as `Host` and as an `https://` origin and gets a `Secure` cookie |
| `WORKBENCH_TAILSCALE_LOGINS` | (none) | Tailscale accounts, comma-separated, allowed in through `WORKBENCH_HTTPS_HOSTS` (matched without regard to case). Empty means every request through those hosts is refused |
| `WORKBENCH_LOG_LEVEL` | `info` | Server log level (`warn`, `error`, `debug`, …) |
| `WORKBENCH_QUIET` | (unset) | Any value turns server logging off |

Back up by copying the data directory. Everything in it is yours; nothing is
sent anywhere except price requests to the chosen market-data provider.
`tokens.json` holds one random token per caller (browser, each AI client,
Obsidian); it records who did what and is not a password.

Checks
------

```bash
npm run typecheck    # TypeScript
npm test             # 838 unit + API tests, 2 more skipped in the Linux container (domain engine, revisions, server, backups, data import, AI rules, MCP adapter over stdio, Obsidian vault sync and plugin, Excel reading / recalculation / detection / write-back, phone access, installer helpers, client store, translations)
npm run e2e          # builds, starts a throwaway server, drives the UI through acceptance tests 1-18, the valuation / catalysts / overview / search pages, the language switch, basic mode, an AI edit, the dashboard, the trade log, an Obsidian round trip, the assumptions page with trial values, the phone width, a write to Excel and the overview's count (29 checks)
```

`npm run e2e` uses the pre-installed Chromium at `/opt/pw-browsers/chromium`
when present; set `CHROME=/path/to/chrome` otherwise. Screenshots go to
`e2e/output/`. The write-back tests that reopen the written file in
LibreOffice are skipped when `/usr/bin/soffice` is absent. The installer itself is
exercised on macOS (arm64 and Intel) by `.github/workflows/mac-install.yml`
at the repository root, which also links, reads and writes an example
workbook in a fake vault and checks that no other file in it changed.

Everyday workflow
-----------------

0. **Assumptions** (first page of a company): link the company's `.xlsx`
   from the vault folder. The page reads the assumption tables by their
   headers (取用值 / 下緣 / 上緣 / 依據, and a column of 要 / 已定), puts
   the ones marked 要 first and keeps next-four-quarter revenue, EPS and the
   target price on screen. A number typed under **Try** is recalculated on
   the server and nothing is saved. **Write to Excel** lists every cell
   first, then changes only those cells (a formula becomes the number; 要 can
   become 已定), after copying the original to `workbook-backups/`. It is
   refused while Excel has the file open or when the file changed since the
   page read it, and an AI client can never do it. The page also ranks the
   assumptions by how far each moves the target price between its low and
   high, compares 我的預估 with the other parties (more than 10% apart is
   marked), shows a self-check of the recalculation against the results Excel
   stored, and offers **Copy diagnosis** (layout only, no figures).
1. **New company** → pick the Standard Equity Research Template (or one you
   saved). Periods start at Y-2A … Y+2E; amounts are in 億 for TWD and
   millions for USD.
2. **Model** page: the tree is your reasoning; the columns are time.
   - Click a cell and type. Blue = typed input, black = formula.
   - `A` add child · `S` add sibling · `F2` rename · `Tab`/`Shift+Tab`
     indent · `Alt+↑/↓` move · `Ctrl+D` duplicate branch · `Del` delete ·
     drag rows to move · `1 2 3` Bear/Base/Bull · `Ctrl+Z` undo.
   - In the inspector: units, the Bear/Base/Bull matrix, formula (names in
     `[brackets]`, `PREV()`, `[EPS]@FY2028`, `SUM(CHILDREN())`), notes,
     evidence, theses with invalidation conditions, catalysts, and the
     node's change history.
3. **Evidence**: paste a URL, drop a file, paste a screenshot (`Ctrl+V`), or
   write a note on the selected node. Files are stored permanently with
   their original names.
4. Edits are an autosaved **draft**. The bottom bar shows every change and
   its live effect on EPS and target price. **Commit Research Update** with a
   title, knowledge date, reason and the evidence behind it.
5. **Valuation**: growth/returns, historical P/E band, peers, re-rating
   thesis; type Bear/Base/Bull P/E yourself with a rationale.
6. **History**: every update is an immutable snapshot. View any snapshot
   read-only, compare two, restore one into the draft, follow how FY EPS or
   the target price evolved by knowledge date, and write post-mortems.
7. **Trades**: price chart with MA, ATR, trade and catalyst markers, stops
   and target lines, the quote and the price source; the trade journal links
   each entry to the research snapshot valid on its entry date and shows the
   2×ATR trailing-stop counterfactual. (`#/p/<id>/market` still opens it.)
8. **Home and trade log**: the company list is one table of every company —
   the number of cells still marked 要 in its linked Excel (待判斷), last price and its date (stale and "no new prices" flags), the base target
   from the latest committed update (Bear / Base / Bull and the
   probability-weighted target in advanced mode), upside, last research date,
   uncommitted draft, open positions with R, overdue catalysts, theses due for
   review and the latest AI activity. Sort by any column, filter by name or
   code, **Update all prices** in the background, and press `Ctrl+K` anywhere
   to switch company. The **Trade log** (`#/journal`) lists every trade across
   companies with R, P&L in each security's own currency (never converted or
   added across currencies), the research snapshot, reviews and who recorded it.
9. **AI assistants**: in Claude Desktop (Chat tab), Claude Code or the ChatGPT
   desktop app (Work mode, outside a project), ask about or update your
   research in plain language. The assistant uses the workbench's tools
   (`list_companies`, `get_model`, `edit_draft`, `preview_commit`,
   `commit_research_update`, `record_trade`, …); the server checks units,
   versions, dates and prices, asks for your confirmation on large moves, and
   records which AI made each write. The page you have open picks up an AI's
   draft edit within about 10 seconds ("Claude Desktop changed 3 items in the
   draft", with Undo). **Settings** (`#/settings`) shows each AI client's last
   connection, recent AI activity, and instructions to paste into a Claude
   project or ChatGPT's custom instructions. Old trade journals are imported
   by pasting them into the chat: the AI previews every trade, you confirm, and
   importing the same excerpt again adds nothing.
10. **Mark a Research Update wrong** (History, on the update): it stays as it
    was but is left out of estimate evolution and calibration; the mark can be
    undone.
11. **Obsidian**: the *Research Workbench Sync* plugin writes every company,
    Research Update, trade and summarised AI session as a note under
    `研究工作台/` in your vault, and sends what you write under `## 反思`
    back; the workbench keeps every version and shows it on Overview, History,
    Trades and the trade log. The plugin only rewrites its own generated block between
    `<!-- wb:begin … -->` and `<!-- wb:end -->`; it never deletes a file or
    changes your text. Settings shows its status and offers the plugin as a zip
    for installing by hand.

Basic and advanced mode
-----------------------

The UI starts in **basic mode**: the sidebar lists Assumptions, Model, Valuation,
Trades and History, and the pages show the everyday tools. The **Advanced mode** switch
(bottom left of a company's sidebar, and at the top of the company list, the
trade log and Settings) adds a **More** group (Evidence,
Catalysts, Overview) and every other tool: the language switch, theses, node
change history, dependency marks, period editing, chart settings, MFE/MAE and
the trailing stop, CSV import, the commit evidence checklist, the causal chain
and attribution, snapshot comparison and the evolution chart. It is a UI
preference stored in the browser (`src/client/lib/prefs.ts`); the data is the
same in both modes, and links into hidden pages keep working.

Phone access
------------

The server keeps listening on `127.0.0.1` only. `tailscale serve` on the Mac
forwards `https://<mac>.<tailnet>.ts.net` to it, and the server accepts that
host name only from a loopback peer and only with a `Tailscale-User-Login`
header naming an allowed account; everything else through that name gets 403
(`TAILSCALE_LOGIN_REQUIRED`, `TAILSCALE_LOGIN_NOT_ALLOWED`, `TAILSCALE_ONLY`),
and a forwarded request that names a local host gets 403
`FORWARDED_LOCAL_HOST`. The installer never turns on Tailscale Funnel, and
`--doctor` fails when it is on. **Settings** shows the phone address. Below
720 px the layout is one column and the sidebar becomes a scrolling top bar.
Details: `docs/ARCHITECTURE.md` §34.

Language
--------

The interface switches between English and Traditional Chinese (中文 / English
buttons in the sidebar and on the company list, shown in advanced mode). The
choice is remembered in the browser; the first visit opens in Chinese. New companies built
from the standard template get Chinese node names when Chinese is on. Your own
text (node names, notes, evidence) is never translated.

Translations live in `src/client/i18n/`: the dictionaries are keyed by the
English text passed to `t()`, and `messages.ts` translates messages built at
runtime (formula errors, model checks, server errors). A unit test fails when a
`t('…')` string has no Chinese entry.

Market data
-----------

| Provider | Status |
|---|---|
| `yahoo` | Unofficial Yahoo Finance chart endpoint; US and Taiwan (`2301.TW`, `7899.TWO`). For Taiwan codes both `.TW` and `.TWO` are tried. Undocumented; it may change or rate-limit. |
| `finmind` | FinMind open data API: Taiwan listed, OTC and emerging (興櫃) daily prices; the quote is the latest close. No key needed; `FINMIND_TOKEN` raises the hourly limit. |
| `fugle` | Fugle (富果) market data API: real-time Taiwan quotes and daily candles. Offered only when `FUGLE_API_KEY` is set. |
| `demo` | Deterministic synthetic prices, always labelled SYNTHETIC. For offline use and tests. |
| `csv` | Import daily OHLCV (Yahoo-style or TWSE Chinese headers). |

None of the three network providers could be exercised from the build
environment (egress blocked); they follow the providers' documentation and are
covered by tests against recorded response shapes.

**Symbol search** (`GET /api/symbols/search?q=`) finds a security by code or
company name, Chinese or English. Taiwan stocks come from FinMind's stock list
(fallback: TWSE's public ISIN lists for 上市 / 上櫃 / 興櫃); other markets come
from Yahoo's search endpoint. Each hit carries the exchange, the provider symbol
with the right suffix and a suggested price source. The UI uses it in the new
company form and on the Trades page. Changing a security's provider symbol drops
its cached prices (imported CSV bars are kept).

Providers live in `src/server/market/`; add one by implementing
`MarketDataProvider` (`getQuote`, `getHistoricalPrices`). Keys, if a
provider needs one, belong in server environment variables (`FINMIND_TOKEN`, `FUGLE_API_KEY`).

Layout
------

```
src/domain/       pure TypeScript shared by client, server, MCP adapter and
                  Obsidian plugin (formula engine, calculation, revisions,
                  templates, indicators, AI draft operations, vault notes,
                  workbook layout detection and sensitivity) — no I/O
src/server/       Fastify API, SQLite migrations/repositories, commit service,
                  actors and tokens, backups, data import, vault sync,
                  attachment store, market-data providers, and xlsx/ (read,
                  recalculate and write back the linked Excel files)
src/client/       React UI (Vite), zustand store, pages and components
src/mcp/          MCP adapter (stdio) the AI apps start; calls the HTTP API
src/shared/       API types, actors, AI instructions
obsidian-plugin/  Obsidian plugin (Research Workbench Sync)
scripts/mac/      Mac installer (install.sh, install.mjs, lib/)
scripts/fixtures/ builds the example workbook used by the tests
e2e/              browser acceptance walkthrough
```

Known limits are listed in `docs/ARCHITECTURE.md` §21, §33 and §34.

Licence
-------

GPL-3.0-only (see [`LICENSE`](LICENSE)). The Excel recalculation uses
[HyperFormula](https://hyperformula.handsontable.com/) under its GPLv3 licence
key, which is why the whole project is GPL.
