Research Workbench
==================

A private tool for doing equity research the same way every time, so the
research can be calibrated later.

The chain it records: **evidence → interpretation / assumption → financial
metric → EPS → valuation → target price**, then **trade → outcome → review**.
Every Research Update keeps what you believed, why, which evidence caused
the change, what changed, and how it moved EPS and the target price.

- 中文使用說明：[`docs/使用說明.md`](docs/使用說明.md)
- Product spec: [`docs/PRODUCT_SPEC.md`](docs/PRODUCT_SPEC.md)
- Architecture, prototype review and self-critique: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- Data model and SQL schema: [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md)

Running it
----------

Needs Node.js 20.10 or later (developed on Node 22).

```bash
cd research-workbench
npm install
npm run dev          # API on 127.0.0.1:4310 + UI on http://localhost:5173
```

Production-style single process (API and built UI on one port):

```bash
npm run build
npm start            # http://127.0.0.1:4310
```

Optional offline example with a fictional company and synthetic prices:

```bash
npm run seed:demo
```

| Environment variable | Default | Meaning |
|---|---|---|
| `WORKBENCH_DATA_DIR` | `./data` | SQLite file (`workbench.db`) and uploaded files (`attachments/`) |
| `WORKBENCH_PORT` | `4310` | API port (the dev UI proxies `/api` to it) |
| `WORKBENCH_HOST` | `127.0.0.1` | Bind address. V1 has no login, so keep it local or put an authenticating proxy in front |

Back up by copying the data directory. Everything in it is yours; nothing is
sent anywhere except price requests to the chosen market-data provider.

Checks
------

```bash
npm run typecheck    # TypeScript
npm test             # 70 unit + API tests (domain engine, revisions, server, client store)
npm run e2e          # builds, starts a throwaway server, drives the UI through acceptance tests 1-18
```

`npm run e2e` uses the pre-installed Chromium at `/opt/pw-browsers/chromium`
when present; set `CHROME=/path/to/chrome` otherwise. Screenshots go to
`e2e/output/`.

Everyday workflow
-----------------

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
7. **Market / Trades**: price chart with MA, ATR, trade markers, stops and
   target lines; the trade journal links each entry to the research
   snapshot valid on its entry date and shows the 2×ATR trailing-stop
   counterfactual.

Market data
-----------

| Provider | Status |
|---|---|
| `yahoo` | Unofficial Yahoo Finance chart endpoint; US and Taiwan (`2301.TW`, `.TWO`). Undocumented and **not verified from the build environment** (network blocked there); it may change or rate-limit. |
| `demo` | Deterministic synthetic prices, always labelled SYNTHETIC. For offline use and tests. |
| `csv` | Import daily OHLCV (Yahoo-style or TWSE Chinese headers). |

Providers live in `src/server/market/`; add one by implementing
`MarketDataProvider` (`getQuote`, `getHistoricalPrices`). Keys, if a
provider needs one, belong in server environment variables.

Layout
------

```
src/domain/   pure TypeScript shared by client and server (formula engine,
              calculation, revisions, templates, indicators) — no I/O
src/server/   Fastify API, SQLite migrations/repositories, commit service,
              attachment store, market-data providers
src/client/   React UI (Vite), zustand store, pages and components
src/shared/   API types
e2e/          browser acceptance walkthrough
```

Known V1 limits are listed at the end of `docs/ARCHITECTURE.md` §21.
