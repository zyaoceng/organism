# Research Workbench — Architecture

This document records the architecture review that preceded the build, the
self-critique of the first proposal, the resulting (revised) design, and what
was added afterwards to run the workbench on a Mac, use it from AI assistants
and sync it with Obsidian.

How to read it:

| Sections | Content |
|---|---|
| §1–§4 | The old prototype: what was kept, removed and rebuilt |
| §5–§19 | The core design: architecture, data, tree, formulas, scenarios, evidence, revisions, snapshots, valuation, market data, trades, UI (incl. the home dashboard and trade log) |
| §20–§22 | The original development plan, the self-critique log (what changed from the first proposal and why), and verified facts vs assumptions vs product decisions |
| §23 | Implementation status and verification |
| §24–§26 | Running on a Mac: installer, LaunchAgent and launcher, backups and data import |
| §27–§30 | AI connection: actors and tokens, AI write guards and draft ops, the MCP adapter and its tools, browser sync |
| §31 | Dashboard, trade log and "update all prices" (pointers into §17–§19) |
| §32 | Obsidian vault sync and plugin |
| §33 | What cannot be verified in a Linux container, and known limits of the Mac / AI / Obsidian parts |

Keep this file in sync with `PRODUCT_SPEC.md` and `DATA_MODEL.md`.

---

## 1. Summary of the old prototype

The `organism` repository is a static GitHub Pages site that archives
research handouts (HTML/PDF/PPTX) for a study group. It is not an
application. Two artefacts in it are relevant as prior attempts at a research
tool:

1. **`liteon-2028-scenarios-v2_1.html`** — a single-file interactive valuation
   of Lite-On (2301.TW). A JSON seed (`#sc-seed`) holds settings and three
   scenarios; one `compute()` IIFE hard-codes the model: 800VDC TAM × share ×
   scope factor, LEO subscriber growth → PSU units → TAM, revenue-mix ramps,
   margins per product, invested capital grown by incremental turnover, and
   `P/E = PE₀ × (ROIC/ROIC₀)^α`. It renders tables and hand-built SVG charts,
   validates inputs (`check()`), keeps the last valid config on error, and can
   "save" by serializing the page with the new seed. It shows provenance badges
   (D disclosed, C calculated, E estimated, U user-verified, M market) and a
   source list with page locators, plus a manual "v1 → v2 difference" table
   attributing the valuation change to two inputs.
2. **`05_800VDC/*_ballot_*.html`** — "confidence ballots": a list of bets
   (claim, source, leading evidence, contrary evidence, consensus/peer/reverse
   anchors, market-implied probability) scored with three sliders
   (logic × feasibility × impact).

What the prototype proves: the analyst already thinks in drivers → EPS →
multiple → target, in Bear/Base/Bull, with explicit provenance and with
manual version-to-version attribution. What it cannot do: the model structure
is code, so every company needs new code; there is no persistence beyond
downloaded HTML; no history, no evidence objects, no point-in-time data.

## 2. What should be reused

| Item | Verdict | How |
|---|---|---|
| Provenance badges D/C/E/U/M | **REFACTOR** | Becomes cell provenance: Actual vs Estimate status, input vs formula vs override, and market-data provider metadata. |
| Source list with page locators | **REFACTOR** | Becomes Evidence + EvidenceLink with a `locator` field (page, slide, timestamp). |
| Manual "v1 → v2 difference" attribution table | **REFACTOR** | Becomes automatic Research Update diff + impact + marginal attribution. |
| Validate-before-apply, keep last valid state | **REUSE (principle)** | Draft saves are schema-validated; invalid formulas are never stored. |
| Portable JSON config | **REUSE (principle)** | Model state is one serializable JSON document; project JSON export. |
| Scenario probabilities and weighted target | **REUSE (concept)** | Optional probabilities in the valuation context. |
| Ballot structure (claim / evidence for / evidence against) | **REFACTOR** | Becomes Thesis + evidence links with `supports` / `contradicts`. |
| Formatting helpers (`fmt`, `pc`, `sign`, `esc`) | **REUSE (idea)** | Re-implemented as unit-aware TypeScript formatters. |
| Calm palette / teal accent | **REUSE (taste)** | Informs the new, denser desktop style. |

## 3. What should be removed

| Item | Verdict | Reason |
|---|---|---|
| Hard-coded `compute()` model | **REMOVE** (as code) | The Lite-On logic becomes a user-built model made of nodes and formulas. |
| `P/E = PE₀ × (ROIC/ROIC₀)^α` as the target multiple | **REMOVE** (as the decision) | The spec forbids a formula deciding P/E. The analyst may still build it as a *reference* node in the P/E branch; the target P/E is always typed manually. |
| Save-by-downloading-HTML | **REMOVE** | Replaced by server persistence and JSON export. |
| Ballot L × F × I product score, market-implied probability | **REMOVE** from V1 | The spec asks not to force numeric confidence. Can return later as optional thesis fields. |
| Page-specific DOM wiring (`fields` map, `by()` getters) | **REMOVE** | Generic UI instead. |

## 4. What should be rebuilt

Everything that is the product: the model representation, formula engine,
scenarios, evidence, revisions, snapshots, valuation workspace, market data,
chart, trade journal, UI. Hand-built SVG price charts are **REPLACED** by
TradingView's `lightweight-charts`; small SVG line charts for estimate
evolution are rebuilt as one reusable component. The static research site
itself is **left untouched**; the app lives in `research-workbench/`.

## 5. Product architecture

One TypeScript application, one process, one SQLite file, one attachments
directory. No microservices.

```
research-workbench/
  src/domain/   Pure TypeScript. No I/O. Shared by client, server, MCP adapter
                and (vault/ only) the Obsidian plugin.
    model/      Model state types, zod schema, pure edit operations, tree helpers
    formula/    Lexer, parser (AST), name↔ID references, evaluator, unit inference
    calc/       Dependency graph (DAG, cycles), calculation engine
    revision/   Diff, downstream impact, marginal attribution, change descriptions,
                change keys, rebase, large-move guards
    templates/  Standard Equity Research Template
    market/     Bar types, SMA/EMA/ATR, trailing stop
    trade/      Trade metrics (P&L, R, MFE/MAE), per-currency summary
    valuation/  Frozen targets, probability-weighted target, upside
    portfolio/  Dashboard flags (quote freshness, catalysts, theses)
    agent/      AI draft operations: schema, name resolution, unit parsing
    vault/      Obsidian notes: render, generated block, merge, frontmatter,
                file names, reflections
  src/server/   Fastify HTTP API, SQLite (better-sqlite3), migrations,
                repositories, commit service, actors and tokens, backups,
                data import, vault routes, attachment store,
                market-data providers + cache
  src/client/   React UI (Vite), zustand store, pages and components
  src/mcp/      MCP adapter (stdio) started by the AI apps; HTTP client only
  src/shared/   API types, actors, AI instructions
  obsidian-plugin/  Obsidian plugin "Research Workbench Sync"
  scripts/mac/  Mac installer: install.sh (starter), install.mjs, lib/
  docs/         This documentation
  e2e/          Browser walkthrough of the acceptance tests
```

Separation of concerns (each is a separate module with its own tests):

| Concern | Module | Must not depend on |
|---|---|---|
| Research hierarchy | `domain/model/tree`, `ops` | formula, calc |
| Calculation dependency graph | `domain/calc/graph` | tree rendering |
| Financial time series | `domain/model/types` (periods, cells) | market data |
| Formula engine | `domain/formula` | UI, DB |
| Evidence | server `evidence` repo + `EvidenceLink` in state | calc |
| Revisions | `domain/revision` + server commit service | UI |
| Snapshots | `revisions` table (immutable rows) | live market data |
| Valuation | model nodes with roles + valuation context | market data (only for display of current P/E) |
| Market data | server `market/*` providers → internal `Bar`/`Quote` | model state |
| Charts | client `PriceChart` + `domain/market/indicators` | provider formats |
| Trading | server `trades` repo + `domain/trade` | model state (references a snapshot by ID only) |

The calculation engine runs in the browser for instant recalculation and on
the server at commit time. Both run the same module, and the server's numbers
are the ones frozen into the snapshot.

## 6. Domain model (overview)

Two families of data:

1. **The research state** — what the analyst *believes*. One versioned JSON
   document per project: periods, nodes (hierarchy, units, values, scenario
   overrides, formulas, notes, roles), evidence links, theses, valuation
   context (peers, historical P/E band, P/E rationale, scenario probabilities).
   It exists as a mutable **draft** and as immutable **revisions**.
2. **Records around the research** — facts and events, stored relationally:
   projects, securities, evidence, attachments, catalysts, trades, market
   bars and quotes, notes, reviews, templates, audit log.

Why this split: everything a Research Update must diff, snapshot, restore and
attribute lives in one document, so those operations are simple pure
functions over two documents. Things that have their own lifecycle (a source
document, a trade, a price bar) are rows. See `DATA_MODEL.md` for fields.

Entity mapping against the suggested list:

| Suggested entity | Decision |
|---|---|
| Company, Security | `projects` + `securities` tables (a project is a company; securities are separate so ADRs/dual listings fit later). |
| ResearchModel | The research state document (draft + revisions). |
| ModelNode, HierarchyEdge | `nodes[]` with `parentId`; sibling order = array order. |
| DependencyEdge | **Derived** from formulas, never stored (storing it would duplicate the formula and could drift). |
| MetricSeries, MetricValue | `node.values` keyed by period ID; `node.cellStatus` for per-cell A/E. |
| Scenario, ScenarioOverride | Fixed `bear/base/bull`; `node.overrides[scenario][period]`. |
| Evidence, Attachment | Tables; attachments content-addressed on disk. |
| EvidenceLink | In the research state (versioned). |
| Catalyst, Trade | Tables (+ audit log). |
| ResearchUpdate, ModelChange, ModelSnapshot | One immutable `revisions` row holds the update metadata, its change set, the full state (snapshot) and frozen outputs. |
| ValuationCase | Target price is a node (role `target_price`); the valuation context holds the P/E evidence. |

## 7. Database / persistence design

- **SQLite** via `better-sqlite3` (synchronous, transactional, single file).
  WAL mode, foreign keys on. Adequate for one analyst and a few friends.
- **Migrations**: ordered SQL scripts in `src/server/db/migrations.ts`,
  recorded in `schema_migrations`; applied at startup inside a transaction;
  idempotent.
- **Data directory** (`WORKBENCH_DATA_DIR`, default `./data`; on a Mac
  install `~/Library/Application Support/ResearchWorkbench/`): `workbench.db`,
  `attachments/<aa>/<sha256>`, `tokens.json` (§27) and `backups/` (§26).
  Git-ignored. Back up by copying the folder.
- A database written by a newer schema is refused at startup (`migrate()`
  throws); before pending migrations run on an existing file it is copied to
  `backups/pre-v<N>-<time>.db` with `VACUUM INTO`.
- **Research state** stored as JSON text (`drafts.state_json`,
  `revisions.state_json`), validated with a zod schema on every write.
- **Immutability**: `revisions` rows are insert-only (no update/delete code
  path exists). Evidence referenced by revisions cannot be deleted.
- **Audit log**: creates, updates and deletes of evidence, catalysts, trades,
  notes, reviews store `before`/`after` JSON and, since schema v2, the actor
  (§27); draft writes and commits add `draft_op` / `commit` rows.
- **Draft concurrency**: `drafts.version` is an optimistic-lock counter; a
  stale write returns HTTP 409 (e.g. two browser tabs).

## 8. Research tree design

- The tree is an **outliner** with period columns, not a node-link diagram.
  It stays dense and readable at 100+ nodes, supports inline editing, and
  never draws crossing dependency edges.
- Row = node. Columns = periods for time-series nodes; single-value nodes span
  the period columns. A node with no unit, no formula and no values renders as
  a heading.
- Interactions: click to select; double-click/F2 rename; `A` add child, `S`
  add sibling, `Delete` delete, `Ctrl+D` duplicate branch, `Tab`/`Shift+Tab`
  indent/outdent, `Alt+↑/↓` reorder, `←/→` collapse/expand, drag & drop to
  move; `1/2/3` switch scenario; `Ctrl+Z`/`Ctrl+Shift+Z` undo/redo (draft).
- Collapse state is UI-only (browser storage), not research state.
- Colour convention (industry standard): **blue = hard input**, black =
  formula, orange flag = hard-coded value overriding a formula, coloured dot =
  scenario override, amber background = changed in draft (strong = directly
  edited, light = changed downstream).

## 9. Hierarchy vs dependency relationships

- **Hierarchy**: `node.parentId` + sibling order. Pure presentation of
  reasoning. Moving a node never changes a number.
- **Dependency**: derived at calculation time from parsed formulas. Edge
  `A → B` exists when B's formula references A in the same period or at an
  absolute period (`@FY2028`). `PREV()` references are *lagged* edges.
- **Cycle rule** (two checks):
  1. The graph of same-period edges must be a DAG. A `PREV()` read of a
     single-value node counts as same-period (the value does not shift).
  2. Lagged edges point to earlier periods, but an absolute reference
     (`[X]@FY2028`) can point to a later one. Any loop through lagged edges
     that also contains an absolute reference is rejected as circular
     (conservative).
  Everything else in the (node, period) graph moves strictly backwards in
  time and cannot loop. A runtime guard catches anything missed and reports it
  as a model issue. (The first draft of this rule argued lags are never
  negative and missed both cases; the independent code review caught them.)
- **Readability**: selecting a node marks its direct inputs and dependents in
  the tree; the inspector lists "Depends on" and "Used by" with values and a
  button to trace the full upstream chain.
- `SUM(CHILDREN())` expands to the node's direct children whose unit kind
  matches the parent's; the expansion is shown in the inspector and included
  in the dependency graph.

## 10. Financial time-series design

- `periods[]` is an ordered list of `{id, label, status: 'A'|'E', endDate?}`.
  IDs are canonical and stable (`FY2028`, `FY2028Q1`) because formulas may
  reference them. One frequency per model in V1.
- A node is `series` (value per period) or `scalar` (one value, key `_`).
- Values are plain numbers in the node's declared unit:
  `{kind, currency?, scale, label?}`; percent is stored as a fraction.
- Effective status of a cell = `cellStatus[period] ?? period.status`.
  Calculated cells are estimates if any input cell in the chain is.
- **Point in time** is handled at the revision level: every Research Update
  has a knowledge date (`as_of_date`) and a system time (`committed_at`).
  "FY28 EPS believed on date D" = the frozen output of the latest revision
  with `as_of_date ≤ D`. Knowledge dates are non-decreasing, so this query is
  exact and free of look-ahead.
- Marking a period Actual (e.g. after earnings) is an explicit, diffed change;
  scenario overrides in that period are dropped as part of the same change.

## 11. Formula-engine design

- Hand-written lexer and recursive-descent parser producing an AST. No
  `eval`, no `Function`.
- Grammar (low → high precedence): comparison, `+ -`, `* /`, unary `-`, `^`
  (right-assoc), postfix `%`, primary (number, reference, function call,
  parenthesis).
- References:
  - UI form: `[Gross Margin]`, bare `EPS`, path `[Business A/Growth]`,
    period-pinned `[EPS]@FY2028`.
  - Stored form: `{n_ab12cd34}` (stable node ID) + optional `@PERIOD`.
  - Conversion is span-based so the user's spacing is preserved.
  - Name resolution is scoped: children of the formula's node, then its
    siblings, then a unique global match; otherwise the editor asks for a
    path. Display uses the shortest unambiguous form.
- Functions: `SUM MIN MAX AVERAGE CAGR IF ABS ROUND AND OR NOT PREV CHILDREN`.
  `IF` is lazy (the untaken branch is not evaluated, so
  `IF([Shares]=0, 0, [NI]/[Shares])` is safe).
- Values are `number` or a structured error `{code, message, nodeId,
  periodId}`. Codes: `PARSE, UNKNOWN_NAME, AMBIGUOUS_NAME, DELETED_REF,
  MISSING, DIV0, CYCLE, NEEDS_PERIOD, NO_PERIOD, BAD_ARG, UPSTREAM`.
  Upstream errors keep the root cause, so the UI says "Missing input: Tax
  Rate, FY2027E (Base)" instead of "#REF".
- Missing inputs are **not** treated as zero.
- Unit inference (warnings, not errors): `+`, `-`, `SUM`, `MIN`, `MAX`,
  `AVERAGE` require equal currency and scale when both are known; the
  inferred result is compared with the node's declared unit.
- Model checks: for cells holding a reported value on a formula node, the
  formula result is also computed; a difference > 0.5% is reported ("reported
  FY2025 Revenue differs from sum of segments by −0.7%").

## 12. Scenario design

- Scenarios are fixed `bear`, `base`, `bull`.
- Resolution for `(node, period, scenario)`:
  1. scenario override, only if scenario ≠ base and the cell is an estimate;
  2. base value (`node.values[period]`);
  3. formula;
  4. empty.
- Actual cells are shared; overrides cannot be set on them.
- In the tree, edits apply to the active scenario (base value, or an override
  in Bear/Bull). The inspector shows a Bear/Base/Bull × period matrix where
  inherited cells are grey until overridden.
- The engine computes all three scenarios in one pass (cheap), so switching
  scenario is instant and the Draft panel can show impact for all three.

## 13. Evidence / attachment architecture

- `evidence` rows: title, source name, source type, URL, publication date,
  date added, notes, optional verification status, archive flag.
- `attachments` rows + files: the file is written to
  `attachments/<first two hex>/<sha256>` after hashing; the row keeps the
  original filename, MIME type and size. Identical files are stored once.
  Files are never modified.
- Evidence ↔ node relations are **evidence links inside the research state**
  (`{evidenceId, nodeId, relation, locator?, note?}`) so that snapshots show
  which sources supported which assumption at that time.
- Research Updates **cite** evidence (`revision_evidence`, kind `cited`); at
  commit, links present in the state are also indexed (kind `linked`). An
  evidence row with any `revision_evidence` row can only be archived.
- Serving: `GET /api/attachments/:id/content` sends
  `Content-Disposition` with the original filename, `X-Content-Type-Options:
  nosniff` and a `sandbox` CSP. Only PNG/JPEG/GIF/WebP/PDF are served inline;
  everything else downloads (prevents stored XSS via uploaded HTML/SVG).
- Low friction: paste a screenshot anywhere on the Model page → image
  evidence linked to the selected node; drop a file on the inspector; paste a
  URL.

## 14. Research Update / revision architecture

- **Draft**: server-side working copy (`drafts`), autosaved from the browser
  (debounced), with `base_revision_id`. Draft changes =
  `diff(head.state, draft.state)`; nothing is interrupted per cell edit.
- **Commit** (`POST /revisions`), in one SQLite transaction:
  1. validate draft version, title, reason, knowledge date (≥ previous) and
     cited evidence (published ≤ knowledge date);
  2. compute `before = calc(head.state)` and `after = calc(draft.state)` with
     the shared engine;
  3. `changes = diff(head.state, draft.state)`;
  4. `impact = impact(before, after)` — changed nodes in dependency order
     with before/after per period and scenario, EPS for every estimate
     period, target price and target multiple per scenario;
  5. `attribution` — for each node changed in both states, recompute with
     only that node's new definition applied; report EPS (basis period) and
     target-price effects; `residual = total − Σ marginal` is reported as
     "interaction and structural changes";
  6. insert the immutable revision (state, computed outputs, changes, impact,
     market context = latest cached quote, engine version) and citations;
  7. rebase the draft onto the new revision.
- Kinds: `initial` (template, no knowledge date), `update`, `checkpoint`
  (no changes: "reviewed, view unchanged"), `restore` (draft restored from an
  older revision, then committed).
- Every step is a pure function in `domain/revision` and is unit-tested;
  the server service is tested end to end.

## 15. Snapshot architecture

- Every revision **is** a snapshot: full state + frozen outputs for all
  nodes × periods × scenarios + the market quote at commit time + engine
  version. Reading a snapshot never recomputes, so neither a new market price
  nor a future engine fix can silently change it.
- Views: time-travel (read-only workspace on any revision), compare any two
  revisions (same diff/impact functions), restore into draft.
- Estimate evolution and calibration read frozen outputs across revisions.

## 16. Valuation architecture

- Target price is an ordinary scalar node (role `target_price`) whose default
  formula is `[EPS]@FY2028 * [Target P/E]`. Rolling the basis year is a
  formula change and therefore visible in history and attribution.
- Target P/E is a scalar input node (role `target_multiple`) with Bear/Base/
  Bull values typed by the analyst. The valuation context stores a rationale
  per scenario.
- The P/E workspace reads role nodes (EPS, EPS growth, ROIC, reinvestment
  ROI, gross margin), the historical P/E band, the peer table and the current
  price. It computes current P/E and upside for display only; nothing it
  shows feeds back into the model automatically.
- Roles are optional hints (`eps`, `revenue`, `gross_margin`,
  `operating_income`, `net_income`, `diluted_shares`, `eps_growth`, `roic`,
  `reinvestment_roi`, `target_multiple`, `target_price`, `rerating`), unique
  per model. The engine never uses roles; only workspaces and headlines do.
  Another method (EV/EBITDA, SOTP) is a different formula on the target-price
  node.

## 17. Market-data architecture

```
MarketDataProvider (server only)
  id, label, requiresKey
  getQuote(symbol): Promise<Quote>
  getHistoricalPrices(symbol, start, end): Promise<Bar[]>
```

- Providers: `yahoo` (unofficial chart endpoint, see §22; Taiwan codes try
  `.TW` then `.TWO`), `finmind` (FinMind open data: Taiwan listed, OTC and
  emerging daily prices), `fugle` (富果 market data, only with
  `FUGLE_API_KEY`), `demo` (deterministic synthetic series, always labelled
  SYNTHETIC in the UI), and CSV import (user-supplied file; provenance =
  filename + import time).
- Symbol search: `SymbolSearch` resolves a code or company name (Chinese or
  English) to exchange, board, currency, provider symbol and a suggested
  provider. Sources: FinMind's Taiwan stock list, falling back to TWSE's ISIN
  lists (Big5 HTML, strMode 2/4/5), cached 12 h; Yahoo's search endpoint for
  other markets. A failing source is reported next to the other sources'
  results. Changing a security's provider symbol deletes its cached fetched
  prices so bars from two symbols never mix.
- `MarketDataService` wraps providers with: SQLite cache (`price_bars`,
  `quotes`), incremental history fetch, per-provider minimum request
  interval, typed errors (`NOT_FOUND`, `RATE_LIMITED`, `NETWORK`, `PROVIDER`)
  and a fetch log. Staleness is computed from `fetched_at`: a quote fetched
  more than 24 h ago is stale (`quoteFreshness`, `src/domain/portfolio/flags.ts`,
  the one rule for the market service and the dashboard).
- Throttle: one promise chain per provider. Each caller takes the next slot,
  `interval` after the previous call started (Yahoo 1.5 s, others 1 s), so
  concurrent callers no longer fire together. Demo and CSV make no network
  calls and are not throttled. The throttle spaces calls into the service,
  not HTTP requests: Yahoo's `.TW`→`.TWO` fallback can still send two
  requests close together.
- `refreshSecurity(security)`: one provider call per security — incremental
  daily bars (from a week before the last cached day), then the quote derived
  from the last bar's close (`asOf` = that date, 00:00 UTC; same shape as the
  CSV quote). It never replaces a cached quote from a later day. CSV and
  unknown sources are skipped, not failed.
- "Update all prices" (`PriceRefresher`, `src/server/market/refreshAll.ts`;
  `POST /api/market/refresh` starts a run or returns the running one,
  `GET /api/market/refresh` returns the last run or null):
  - Targets: the primary security of every active company, plus any security
    with an open trade (also in an archived company). The same ticker in two
    companies is refreshed twice (one call per security row).
  - Each provider's securities are refreshed one after another, so the
    throttle chain never holds more than one slot of the run and a page's own
    price request waits at most one slot. **Deviation from the plan's
    "背景串行" (one serial loop):** different providers run side by side, so a
    slow or blocked source (an offline Yahoo, FinMind's hourly limit) does not
    hold up the others. Within a provider it is still serial.
  - Stop rules per provider: a rate limit records that security, sets the
    provider's `retryAfterSec`, and skips the rest of that provider ("Not
    updated: {label} rate limit reached"); 3 consecutive `NETWORK` failures
    mark it `unreachable` and skip the rest (without this an offline Mac waits
    out a 15–20 s timeout per security); a source this server does not have
    (Fugle without a key) is `unavailable`. Other providers continue.
  - The run is background work and runs as the `system` actor
    (`runAs('system', …)`), not as whoever pressed the button.
  - Shutdown (`onClose`): new runs get 503, the call in flight gets up to 3 s,
    pending securities are skipped ("Not updated: the server shut down") and
    the run ends `cancelled`. A call that outlives the grace fails on the
    closed database and is caught.
  - Progress lives in memory only (no migration); every provider call is
    already in `market_fetch_log`. After a restart GET returns null.
- Bars are keyed by `(security, provider, date)` so demo, CSV and live data
  never mix. `adj_close` is kept when the provider supplies it.
- Security identity: company name, ticker (`2301`), exchange (`TWSE`),
  provider symbol (`2301.TW`), currency (`TWD`), preferred price source.
- API keys, if a keyed provider is added, are read from server environment
  variables and never sent to the browser.
- Backtesting readiness: raw OHLC + adj close + provider + fetch time are
  stored; corporate actions and point-in-time adjusted series are future
  tables; indicator functions are pure and deterministic so a future
  walk-forward harness can reuse them.

## 18. Trading architecture

- `trades` table, independent of the model. A trade stores the research
  revision valid **on the entry date** (latest revision with knowledge date ≤
  entry date), the base target price from that frozen snapshot, stop, ATR at
  entry (ATR(14) from cached bars up to the entry date), ATR multiple, reason;
  later exit date/price/reason.
- Derived metrics (pure, `src/domain/trade/metrics.ts`): P&L, return, R
  multiple, holding days, MFE/MAE, and the exit a 2×ATR trailing stop would
  have produced.
  - Mark: a closed trade uses its exit. An open trade uses the cached quote
    when it is not older than the last cached bar, else the last close
    (`markSource` `quote` / `bar`). A mark dated before the entry gives no
    P&L, return or R.
  - Bar coverage: MFE/MAE and the trailing stop are computed only when the
    cached history starts on or before the entry date (`entryBarIndex`);
    otherwise they are null, never measured from a later bar
    (`barsCoverEntry` in the trade log).
- Trade log (`GET /api/trades?status=all|open|closed&projectId=&from=&to=`,
  dates filter the entry date): every trade across companies, newest entry
  first, with the company, security, metrics from that security's own cached
  bars and quote, the linked research snapshot, the trade's reviews and who
  recorded it. Fixed query count (`src/server/repos/portfolio.ts`).
- Money is never converted or added across currencies: the trade summary
  (`summarizeTrades`, `src/domain/trade/summary.ts`) reports realised and
  unrealised P&L and win rate per currency; only R (average over closed
  trades with a stop) is currency-free. The dashboard's open positions use
  the cached quote only (no bars) and sum P&L per security currency.
- Chart: entry/exit arrows, stop and target price lines.
- This separates "was the thesis wrong?" (snapshot vs outcome) from "was
  execution poor?" (trade vs trailing-stop counterfactual, MFE/MAE).

## 19. Primary UI layout

```
┌─────────┬──────────────────────────────────────────────┬──────────────────┐
│ Project │  Top bar: company · price · scenario (B/B/B)  │                  │
│ nav     │  EPS · target P/E · target price · upside     │   Inspector      │
│         ├──────────────────────────────────────────────┤   (selected      │
│Model    │  Research tree         FY24A FY25A FY26E ...  │    node)         │
│Valuation│  ▾ EPS                  6.1   8.6   10.2      │   values matrix  │
│Trades   │    ▾ Revenue            ...                    │   formula        │
│History  │       Business A        ...                    │   depends/used*  │
│ More*   │  ▾ P/E                                         │   notes          │
│Evidence │  Target Price           355.0 (single value)   │   evidence       │
│Catalysts├──────────────────────────────────────────────┤   theses*        │
│Overview │  Draft changes (3) · impact · Commit update ▲  │   history*       │
└─────────┴──────────────────────────────────────────────┴──────────────────┘
                                                   * advanced mode only
```

Other pages: the home dashboard and the trade log (below), Overview
(identity, KPIs by scenario, theses, upcoming catalysts, recent updates,
notes journal), Evidence library, Valuation (P/E workspace), Catalysts
timeline, Trades (price chart, quote and data source, and the journal;
Market was merged into it and `#/market` is an alias), History (updates
timeline, compare, estimate evolution, calibration, reviews).

Basic / advanced mode: the UI starts in basic mode (Model, Valuation,
Trades, History, and the everyday tools); advanced mode adds the More group
and every other tool. See §23.

Home dashboard (`#/`, `src/client/pages/ProjectsPage.tsx` with
`components/DashboardTable.tsx`): one row per company from `GET
/api/dashboard`, a fixed number of queries however many companies there are.
- Columns: last price with its market date (a `stale` badge when fetched more
  than 24 h ago; "no new prices for N days" when a fresh fetch still has an
  old date, a hint of a suspension or wrong symbol), the base target (Bear /
  Base / Bull in advanced mode), the probability-weighted target and its
  upside (advanced), upside to the base target (blank when target and price
  are in different currencies), last research date, `uncommitted` when the
  draft differs from the head, open positions with average R and unrealised
  P&L per currency, overdue / next catalysts (month and quarter dates count
  to the end of their window), theses due for review, the latest AI activity.
- Targets come from the committed head (`frozenTargets`,
  `probabilityWeightedTarget`, `upside` in `src/domain/valuation/targets.ts`,
  the same rule the Valuation page uses); theses from the draft, as on the
  Overview page.
- Headers sort (first click in the column's natural direction, second
  reverses, third restores the server order; remembered in the browser);
  the filter box and `Ctrl+K` match name, code or provider symbol, full-width
  digits included (`src/client/lib/companies.ts`). A row opens the model.
- "Update all prices" starts the server's background run (§17) and polls its
  progress once a second; rows show `…` while waiting and `!` when their
  security failed, and the table reloads when the run ends. A run started in
  another window is picked up from the dashboard's `refresh` field. The page
  also reloads when the window becomes visible again.

Trade log (`#/journal`, `src/client/pages/JournalPage.tsx`): every trade
from `GET /api/trades` (§18), filtered on the client (open / closed,
company, entry dates, not reviewed, text) so the summary always describes
exactly the rows shown. Per currency: realised P&L, win rate, unrealised
P&L; currency-free: average R and the error categories of the reviews. There
is no total across currencies. A row opens that trade on the company's
Trades page (`#/p/<id>/trades/<tradeId>` selects it); trades recorded by an
AI client carry a "recorded by …" badge.

`Ctrl+K`: on the home page and the trade log it opens a company switcher; in
a company the search palette lists matching companies first (they open on
the same tab) and, with nothing typed, the most recent ones.

## 20. Development plan

| Milestone | Content | Verification |
|---|---|---|
| M0 Foundation | Package, TS config, Vite, Fastify, SQLite, migrations | typecheck, migration test |
| M1 Domain core | Model types/schema/ops, formula engine, calc engine, scenarios | unit tests |
| M2 Revisions | Diff, impact, attribution, descriptions | unit tests |
| M3 Server | Projects, drafts, commits, evidence + attachments, catalysts, trades, notes, reviews, templates, export | API tests (inject) |
| M4 Market | Providers, cache, CSV import, indicators | unit + API tests |
| M5 Workspace UI | Shell, tree, inspector, draft panel, commit | browser walkthrough |
| M6 Pages | Evidence, valuation, catalysts, market chart, trades, history, overview, search | browser walkthrough |
| M7 Acceptance | `e2e/acceptance.mjs` for tests 1–18, docs sync | all tests green |

The second round (Mac, AI, Obsidian) was built as M1 Mac installer, backups
and data import; M2 basic / advanced mode; M3 AI connection through MCP; M4
cross-company dashboard and trade log; M5 Obsidian plugin and journal import.
Its design is §24–§33.

---

## 21. Self-critique of the first proposal and corrections

The first proposal (v0) was written before this document's final form. Each
row states the problem, why it matters, and the correction adopted above.

| # | v0 proposal | Problem | Why it matters | Correction (now in §) |
|---|---|---|---|---|
| 1 | Normalized `metric_values` rows with valid-from/valid-to (bitemporal per value). | Heavy: every diff, snapshot and restore becomes a multi-table temporal query; value history is separated from the *reason* it changed. | Complexity with no user benefit at this scale; "why" is the point. | Versioned state document + immutable revisions carrying reason, evidence and frozen outputs (§6, §14). |
| 2 | Store `DependencyEdge` rows. | Duplicates the formula; can drift from it. | Two sources of truth for calculation. | Derive edges from parsed formulas every time (§9). |
| 3 | Separate `ModelSnapshot` entity plus `ResearchUpdate`. | Two concepts for "state at a time"; unclear which one a trade references. | Duplicated concepts confuse history. | Every revision is a snapshot; a no-change "checkpoint" update covers "snapshot without change" (§15). |
| 4 | Node `kind: group | metric`. | Premature distinction; converting a heading into a metric would be a migration. | Friction and code paths for no gain. | Single node type; "heading" is derived (no unit, formula or values) (§8). |
| 5 | Evidence links stored as rows outside the state. | Unlinking later would erase what supported an old belief. | Breaks TEST 18 reconstruction. | Links live in the versioned state (§13). Accepted cost: linking is a draft change to commit; the draft autosaves so nothing is lost. |
| 6 | Trade references HEAD revision. | A back-dated trade would point to research made *after* the trade. | Look-ahead bias in the thesis-vs-execution analysis. | Resolve the revision by entry date (§18). |
| 7 | Snapshot reads recompute outputs from state. | An engine bug fix or new price would silently change history. | Violates TEST 15. | Freeze computed outputs + engine version + quote in the revision (§15). |
| 8 | Target price from a live-price-aware valuation module. | Model would read market data; snapshots would drift. | Violates "historical snapshots must not change". | Model never reads market data; current P/E/upside are display-only (§16). |
| 9 | Knowledge date free-form. | A backdated update would build on later knowledge. | Look-ahead bias in the estimate history. | Knowledge dates non-decreasing; evidence published after the knowledge date cannot be cited (§10, §14). `initial` has no knowledge date so backfilling is still possible. |
| 10 | Treat empty inputs as 0 (spreadsheet default). | Silent wrong EPS. | Hidden model errors. | Strict `MISSING` errors with root-cause messages (§11). |
| 11 | Hard-coded values in formula nodes allowed silently. | Classic spreadsheet error: stale plugs. | Hidden model errors. | Orange flag, formula-check difference, model checks list (§8, §11). |
| 12 | Changing a node's scale just relabels numbers. | 1,853 億 would become 1,853 million. | Unit corruption. | Scale changes convert values by default; relabel is explicit. Conversion is refused when the node has a formula or formulas read it, because formulas do not convert scales (§10, found in review). |
| 13 | Name-based references resolved globally. | Duplicated branches (e.g. every segment has "Growth") become ambiguous; renames break text. | Formula fragility. | IDs in storage; scoped resolution at edit time; path display when ambiguous; branch duplication remaps internal refs (§11). |
| 14 | Attribution by applying changes sequentially. | Order-dependent numbers that look precise. | False precision. | One-at-a-time marginal effects plus an explicit residual (§14). |
| 15 | Scenario overrides allowed everywhere. | Bear case could "change history". | Actuals must be shared. | Overrides only on estimate cells (§12). |
| 16 | Serve attachments with their stored MIME type. | Uploaded HTML/SVG executes on the app origin. | Stored XSS. | Inline only for safe types, sandbox CSP, nosniff (§13). |
| 17 | Catalyst/evidence edits overwrite rows. | "Expected outcome" can be rewritten after the fact. | Thesis drift becomes invisible. | Audit log with before/after (§7). |
| 18 | `P/E` derived from ROIC elasticity (as in the prototype). | A formula deciding the multiple. | Explicitly forbidden; false precision. | Manual Bear/Base/Bull P/E with rationale; reference formulas allowed only as inputs to judgment (§16). |
| 19 | Next.js full-stack. | Framework conventions (server components, routing) add surface for a local, single-user tool. | Maintainability. | Vite + React client, small Fastify server, shared domain module (§5). |
| 20 | Node's built-in `node:sqlite`. | Still marked experimental (emits `ExperimentalWarning` on Node 22.22 in this environment). | Stability. | `better-sqlite3` behind a thin repository layer (§7). |

Checks the spec asked for, and where they are answered:

- *Unnecessary complexity / premature abstraction*: no plugin system, no
  generic scenario count, no bitemporal tables, no graph database (rows
  1–4, 19).
- *Duplicated concepts*: snapshot vs update merged; dependency edges derived
  (rows 2–3).
- *Unclear data ownership*: research state (beliefs) vs relational records
  (facts/events) (§6).
- *Evidence vs assumption confusion*: evidence rows are sources; assumptions
  are node values; links are typed relations; commits cite evidence
  separately from the values they change (§13, §14).
- *Hierarchy vs dependency confusion*: separate by construction (§9).
- *Historical reconstruction, look-ahead, destructive updates*: rows 5–9.
- *Friction*: autosaved draft, inline editing, paste-to-evidence, one commit
  per information event (§8, §13, §14).
- *Attachment persistence*: content-addressed files, never temp paths (§13).
- *Scenario duplication*: override model (§12).
- *Unit/currency ambiguity*: units on every node, inference warnings, scale
  conversion (§10, §11).
- *Formula fragility*: IDs, scoped names, remapping, clear errors (row 13).
- *Extensibility*: new metrics are nodes; new valuation methods are
  formulas; new providers implement one interface; new indicators are pure
  functions.

Known V1 limitations (accepted, documented):

- One period frequency per model (annual *or* quarterly). Extension:
  period hierarchy where `FY = SUM(Q1..Q4)`.
- Scenarios fixed at three; formulas are shared across scenarios (vary
  inputs, not formulas).
- No authentication; the server binds to `127.0.0.1` by default. For a
  shared deployment put it behind an authenticating reverse proxy.
- Attribution is marginal (one change at a time) and reports the residual
  rather than decomposing interactions.

## 22. Verified facts, engineering assumptions, product decisions

**Verified in the build environment**

- Node.js 22.22 and npm 10.9 are available; `node:sqlite` works but prints
  an `ExperimentalWarning`.
- `better-sqlite3` installs and runs (prebuilt binary or local build).
- `lightweight-charts` 5.2.1 typings expose `chart.addSeries(definition,
  options, paneIndex)`, `CandlestickSeries`/`HistogramSeries`/`LineSeries`
  definitions, `createSeriesMarkers(series, markers)`, marker shapes
  `circle | square | arrowUp | arrowDown`, and `series.createPriceLine()`.
- Fastify 5.x and `@fastify/multipart` 10.x install; their APIs are used as
  typed in the installed packages.
- Outbound HTTPS to Yahoo Finance, TWSE, Stooq and Alpha Vantage is blocked
  by this environment's egress policy, so no live market provider could be
  exercised here.

**Engineering assumptions (not verified here)**

- The Yahoo Finance `v8/finance/chart/{symbol}` endpoint is **undocumented**.
  Its response shape (`chart.result[0].meta`, `timestamp[]`,
  `indicators.quote[0].{open,high,low,close,volume}`,
  `indicators.adjclose[0].adjclose`) is assumed from common use; the parser is
  defensive and fails with a clear `PROVIDER` error if the shape differs.
  Taiwan listings use the `.TW` (TWSE) / `.TWO` (TPEx) suffix convention.
  This provider may break or rate-limit without notice, which is why the
  provider interface, CSV import and the demo provider exist.
- FinMind (`/api/v4/data`, datasets `TaiwanStockPrice` and `TaiwanStockInfo`)
  and Fugle (`/marketdata/v1.0/stock/intraday/quote`, `/historical/candles`,
  header `X-API-KEY`) follow their public documentation; field names were
  taken from the documentation and tests use recorded shapes. FinMind's
  `TaiwanStockInfo.type` values for emerging stocks are matched loosely.
- Model sizes stay below ~500 nodes × ~40 periods, so a full recalculation
  per edit (and one per changed node for attribution) is fast enough.
- SQLite's single-writer model is sufficient for one to five users.

**Product decisions (the user's to revisit)**

- P/E is always manual; no scoring formula.
- Percent cells accept "40" or "40%" as 40%.
- Missing inputs are errors, not zero.
- Knowledge dates are non-decreasing.
- Evidence links are versioned with the model.
- The UI opens in Traditional Chinese on the first visit and switches to
  English; node names, notes and evidence may be in any language (CJK tested).
- The default target-price basis is the FY two years ahead (the prototype's
  2028 convention); changing it is an ordinary formula edit.

## 23. Implementation status and verification

Built as designed above; deviations are listed at the end of this section.

| Area | Where | Verified by |
|---|---|---|
| Formula engine (parser, name↔ID, evaluator, units) | `src/domain/formula/` | `formula.test.ts` |
| Dependency DAG, cycles, calculation, scenarios, model checks | `src/domain/calc/` | `engine.test.ts` |
| Tree operations, periods, units, schema invariants | `src/domain/model/` | `ops.test.ts` |
| Diff, impact, attribution | `src/domain/revision/` | `revision.test.ts` |
| Indicators, trade metrics | `src/domain/market/`, `src/domain/trade/` | `indicators.test.ts`, `metrics.test.ts` |
| Persistence, commit service, evidence/attachments, trades, market cache, export, migrations | `src/server/` | `server.test.ts` (Fastify inject, temp data dir) |
| Interface language (English / Traditional Chinese) | `src/client/i18n/`, `src/client/lib/i18n.ts` | `i18n.test.ts` (every `t('…')` literal has a Chinese entry, placeholders match, runtime message patterns), `standard.test.ts` (Chinese template computes like the English one) |
| Basic / advanced mode | `src/client/lib/prefs.ts` (`useAdvanced`, `issueVisible`, `providerVisible`), `<Advanced>` and `AdvancedToggle` in `components/ui.tsx` | `prefs.test.ts`; e2e check 21 |
| Mac installer helpers (layout, plist, launcher, release, prune, AI registration, Obsidian install, report) | `scripts/mac/lib/` | `*.test.mjs` next to each (fixtures for Claude and Codex configs); `.github/workflows/mac-install.yml` at the repository root installs on `macos-15` and `macos-15-intel` |
| Backups, pre-migration copies, newer-schema refusal, data import | `src/server/services/backup.ts`, `db/connection.ts`, `services/dataImport.ts` | `backup.test.ts`, `dataImport.test.ts`, `server.test.ts` |
| Actors, tokens, cookie, Host/Origin check | `src/server/actor.ts`, `tokens.ts`, `app.ts` | `agent.test.ts`, `server.test.ts` |
| Schema v2 upgrade of a v1 database | `src/server/db/migrations.ts` | `migrationV2.test.ts` |
| AI draft operations, units, commit preview and guards, trades, evidence dates | `src/domain/agent/`, `src/server/services/` | `agent.test.ts` (domain), `src/server/agent.test.ts` |
| MCP adapter | `src/mcp/` | `format.test.ts`; `mcp.e2e.test.ts` starts the app and calls every tool through the SDK client over stdio |
| Browser sync and conflict rebase | `src/client/lib/store.ts`, `useDraftSync.ts`, `src/domain/revision/rebase.ts` | `store.test.ts`, `rebase.test.ts`; e2e check 22 |
| Dashboard, trade log, update all prices | `src/server/repos/portfolio.ts`, `market/refreshAll.ts`, `src/domain/valuation/`, `src/domain/portfolio/` | `targets.test.ts`, `flags.test.ts`, `summary.test.ts`, `refreshAll.test.ts`; e2e checks 23–24 |
| Obsidian sync (server, shared logic, plugin) | `src/server/vault/`, `src/domain/vault/`, `obsidian-plugin/` | `vault.test.ts`, `core/merge/render/reflection/filename.test.ts`, `obsidian-plugin/test/*` (fake vault and server, round trip); e2e check 25 |
| UI and end-to-end workflow | `src/client/` | `e2e/acceptance.mjs` — 25 checks: acceptance tests 1–18 and the valuation / catalysts / overview / search pages (check 19) through the real UI in English and advanced mode, the language switch, basic mode, an AI edit picked up by the open page, the dashboard, the trade log and an Obsidian round trip, against a production build on a throwaway data directory |

Results at the time of writing (release `df5cde6`, M1–M5): `npm run typecheck`
clean, `npm test` 562 passed (1 macOS-only test skipped on Linux), `npm run e2e`
25/25; the Mac install workflow passed on `macos-15` and `macos-15-intel`.

Basic / advanced mode is UI-only: no schema, server or domain change. The
choice is a per-browser preference (`workbench.advanced` = `'1'`/`'0'`).
`<Advanced>` renders its children only in advanced mode and holds the hook
itself, so wrapping JSX never changes a component's hook order; components
that need the flag in logic call `useAdvanced()` before any early return.
Basic mode shows four sidebar pages (a deep link into a hidden page still
renders it and shows it under More), hides info notes and the
`ROLE_DUPLICATE` / `OVERRIDE_ON_ACTUAL` warnings, lists only real price
sources (plus the current one), draws a fixed chart (MA 20/50, ATR 14, one
year widened to the selected trade), and on commit cites exactly the evidence
linked in the draft (no checklist). In both modes the commit title is
prefilled from the first change until the user types one. The Market page was merged
into Trades (one `useBars()`, one chart); `#/p/<id>/market` is an alias.

Language: UI strings are keyed by their English text (`t('Model')`), so a
missing translation falls back to English instead of a blank. Messages built
at runtime by the engine and the server stay English at the source and are
translated on the client by whole-message patterns (`i18n/messages.ts`);
unknown messages pass through unchanged. Change descriptions are generated in
either language from the stored structured changes, so old Research Updates
also read in Chinese. User data is never translated.

An independent code review after the first complete build found six issues,
all fixed with regression tests: two autosave/commit races in the client
store (overlapping saves could report a false conflict; an edit during a
commit could be lost), stale undo history after a conflict reload, two
circular-dependency shapes the static check missed (scalar `PREV`, forward
`@PERIOD` loops), scale conversion on formula-connected nodes, and missing
knowledge-date checks on secondary paths (linked evidence at commit, evidence
date edits, explicit or edited trade snapshots).

Deviations and notes:

- npm 10.9 fails to resolve Vitest 4's optional peers ("Cannot read
  properties of null (reading 'edgesOut')"); `.npmrc` sets
  `legacy-peer-deps=true`. Vitest 4.1.11 and `@fastify/static` 10.1.5 are used
  because earlier versions had published advisories.
- Playwright's own browser download is not used; the e2e script uses the
  system Chromium (`CHROME` or `/opt/pw-browsers/chromium`).
- JSON **export** is implemented; JSON **import** is not (planned: import into
  a new project with fresh IDs).
- The UI edits one (primary) security per project; the schema allows more.
- The Yahoo provider remains unverified here (see §22); the demo provider and
  CSV import are fully exercised by tests.

---

## 24. Mac installer

The user pastes one line into Terminal; re-running it is the update:

```
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/zyaoceng/organism/claude/vibrant-thompson-s3npyj/research-workbench/scripts/mac/install.sh)"
```

Options go after ` -- ` (`… -- --doctor`). Two stages:

1. **`scripts/mac/install.sh`** (bash 3.2 and the BSD tools of macOS; the
   whole body is inside `main()` so a partly downloaded script never runs).
   It picks Node 24.22.2 on macOS ≥ 13.5 and Node 22.23.4 on macOS 11–13.4
   (`sysctl hw.optional.arm64` for the chip, `sw_vers` for the version;
   older than 11 is refused), downloads the official nodejs.org tarball,
   compares it with the SHA-256 **written in the script**, and installs it in
   `~/ResearchWorkbench/runtime/node-v…` with `runtime/current` pointing at it.
   It then reads `release.json` on the branch, downloads `install.mjs` and
   `lib/*.mjs` **of that commit** from `raw.githubusercontent.com`, and runs
   them with the bundled Node, passing every argument through. `--doctor`,
   `--dry-run` and `--uninstall` never change `runtime/`; `--doctor` and
   `--uninstall` use the installed copy of `install.mjs` and work offline.
   Linux x64 is accepted for CI and dry runs only.
2. **`scripts/mac/install.mjs`** (Node, built-ins only, because it runs before
   `npm ci`; the pure parts live in `scripts/mac/lib/` and are unit-tested on
   Linux):
   - **Version.** The commit in `release.json` (`WB_RELEASE_COMMIT` pins one;
     `"pending"` is refused), downloaded as a tarball of that commit, so a
     later push to the branch never changes what is installed. `release.json`
     is updated only after the Mac install workflow passed.
   - **Build.** Into `~/ResearchWorkbench/app-<sha7>.partial/`: extract only
     `research-workbench/`, write `version.json`, `npm ci`, `npm run build`,
     check that `better-sqlite3` loads, write a marker (commit, Node ABI,
     arch), rename to `app-<sha7>/`. A finished folder with the same marker is
     reused. Output goes to `~/Library/Logs/ResearchWorkbench/install.log`.
   - **Layout** (`lib/layout.mjs`): `~/ResearchWorkbench/{runtime/, app-<sha7>/,
     current → app-<sha7>, settings.json, .install.lock}`, data in
     `~/Library/Application Support/ResearchWorkbench/`, logs in
     `~/Library/Logs/ResearchWorkbench/` (`server.out.log`, `server.err.log`,
     `install.log`). `settings.json` remembers the port and the Obsidian vault.
   - **Order:** version → build → folders → data import (§26) → switch and
     start (§25) → launcher app → AI registration (§29) → Obsidian plugin
     (§32) → a final message. A lock directory stops two installers at once.
   - **Switch and roll back.** With the service stopped, the database files are
     copied aside (APFS clone), `current` is repointed and the LaunchAgent
     started. If `/api/health` does not answer within 60 seconds, `current`
     goes back to the previous version, the old plist and the database copy
     are put back (a new version may already have migrated the file, and the
     old one refuses a newer schema), and the old version is started again.
   - **Prune** (`lib/prune.mjs`): keep the running version and the one before
     it; delete other `app-*` folders and interrupted `.partial` ones.
   - **Modes:** `--doctor` prints a check list (macOS, chip, bundled Node, app
     version, better-sqlite3, launchd state, port, `/api/health`, diagnostics
     and backups, AI registration, Obsidian plugin, data size, launcher, log
     tail) for the user to screenshot; `--dry-run` checks and prints the plan;
     `--uninstall` boots out the LaunchAgent and removes the plist, the
     launcher and `~/ResearchWorkbench`, keeping data unless `--purge` (typed
     confirmation). The Obsidian plugin folder in the vault is never removed.
     `--source-dir` installs from a checkout and `--no-launchd` skips the
     LaunchAgent and launcher (both for CI); `--port`, `--yes`,
     `--no-register`, `--import`, `--obsidian`, `--obsidian-vault`,
     `--no-obsidian` as in `lib/args.mjs`.
   - Prompts always read `/dev/tty` (stdin may be the piped script).
- **CI:** `.github/workflows/mac-install.yml` (repository root) runs the
  installer on `macos-15` (arm64) and `macos-15-intel`. A runner that refuses
  `launchctl bootstrap gui/<uid>` makes the installer fall back to starting
  the server directly and print a warning that launchd was not verified.

## 25. LaunchAgent and launcher

- `~/Library/LaunchAgents/com.researchworkbench.plist` (`lib/launchd.mjs`):
  `ProgramArguments = [<runtime/current/bin/node>, --import, tsx,
  src/server/main.ts]`, `WorkingDirectory = ~/ResearchWorkbench/current`
  (absolute; launchd does not expand `~`), environment `PATH` (bundled Node
  first), `WORKBENCH_DATA_DIR`, `WORKBENCH_PORT`, `WORKBENCH_LOG_LEVEL=warn`;
  `RunAtLoad`, `KeepAlive = {SuccessfulExit: false}`, `ThrottleInterval = 10`,
  stdout/stderr to the log folder. Checked with `plutil -lint` when available.
- Start: `launchctl enable` + `bootstrap gui/<uid>`, one retry after a
  `bootout`. Stop: `bootout`, wait for the job to go, then 2 s. Before the
  switch the installer checks that port 4310 (or `--port`) is free or held by
  our own job (`lsof`), and names the program that holds it otherwise.
- Server side (`src/server/main.ts`): SIGTERM/SIGINT wait for a backup in
  progress, close Fastify and the database, and exit; after 10 s it gives up
  (launchd kills after 20 s). Daily backups start only once the port is bound.
- `~/Applications/研究工作台.app` (`lib/launcher.mjs`, built with `osacompile`):
  opens `http://127.0.0.1:<port>/` when `/api/health` answers; otherwise
  `launchctl kickstart`s the job and waits up to 20 s, and explains in Chinese
  how to turn the job back on in System Settings → General → Login Items &
  Extensions when it is missing or disabled. Nothing is put on the Desktop.
- `GET /api/diagnostics`: version, Node, platform, data folder, database file,
  schema version, backup status, uptime, each AI client's last connection and
  the Obsidian plugin's last report. The Settings page (`#/settings`) shows it.

## 26. Backups and data import

**Backups** (`src/server/services/backup.ts`, `BackupService`):

- Checked at startup and every hour; a copy is written when the newest is 24
  hours old, to `backups/daily/workbench-YYYYMMDD-HHmmss.db`.
- Each copy: SQLite online backup to `<file>.tmp`, switched out of WAL mode,
  `PRAGMA quick_check` on a read-only connection, then renamed. A failure
  leaves nothing behind and is shown on the Settings page.
- Retention: the newest copy of each of the last 14 days and of each of the
  last 8 ISO weeks. `backups/pre-v<N>-<time>.db` (before a migration,
  `src/server/db/connection.ts`) and `backups/pre-import-<time>.db` (before a
  data import) are never rotated.
- The copies are on the same disk; the user guide recommends Time Machine.

**Data import** (`src/server/services/dataImport.ts`, CLI
`src/server/cli/import-data.ts --archive <tgz> --data-dir <dir> [--force]
[--summary-only]`), for moving the Codespaces data to the Mac. The archive is
what the user guide's one-liner produces (`wb.db`, an online backup, plus
`data/attachments`); a raw `workbench.db` with its `-wal` also works.

1. Extract with the system `tar` into a staging folder; find exactly one
   `wb.db` (preferred) or `workbench.db`.
2. Open it (a `-wal` next to it is replayed), `quick_check`, make sure it is a
   workbench database, `VACUUM INTO` a clean single file.
3. On the clean copy: run migrations (a newer schema is refused), rotate
   `db_generation` (open tabs reload), `integrity_check`,
   `foreign_key_check`, and recompute the sha256 of every attachment row's
   file.
4. `--summary-only` stops here and prints the summary (per company: Research
   Updates, last commit and knowledge date, trades, evidence; attachments;
   schema version; whether a WAL was applied).
5. Otherwise: a target that already has companies needs `--force` (exit code
   2 without it) and is first saved as `pre-import-<time>.db`; attachments are
   copied (existing files kept); the target's old `-wal`/`-shm` are removed
   before the new file takes its name.

The installer's import step finds `--import <file>` or
`~/Downloads/wb-data.tgz`, stops the service, prints the summary and asks;
replacing existing companies needs a second, typed `yes` (never with
`--yes`). After a successful import the archive is renamed
`wb-data.imported-<date>.tgz` so a re-run does not import it again. When macOS
denies Terminal access to Downloads it says where to allow it.

## 27. Actors, tokens and the browser cookie

Every write records **who** made it. This is attribution, not security: any
program of the same macOS user can read the tokens.

- **Actors** (`src/shared/actors.ts`): `user`, `system`, `obsidian` and
  `agent:<client>` for the clients `claude-desktop`, `claude-code`,
  `chatgpt`. Stored in `audit_log.actor`, every `*.created_by`,
  `draft_ops.actor`, `revision_annotations.actor` (`DATA_MODEL.md` §2a).
- **Tokens** (`src/server/tokens.ts`): `<dataDir>/tokens.json`, mode 0600,
  one random token per name in `TOKEN_NAMES` (`user`, the three AI clients,
  `obsidian`). The server creates the file and adds missing keys at startup,
  so tests, dev mode and Linux need no installer; a file it cannot parse is
  kept as `tokens.json.corrupt-<time>` and a new one written.
- **Resolution** (`src/server/actor.ts`, a Fastify `onRequest` hook that
  runs after the Host/Origin check): `Authorization: Bearer <token>` → that
  token's actor; otherwise the `wb_session` cookie → `user`; otherwise
  `unknown`. The actor travels with the request through `AsyncLocalStorage`,
  so repositories call `currentActor()` without new parameters; code outside
  a request (seeding, CLIs, the price refresher via `runAs('system', …)`) is
  `system`. An `unknown` caller may read but any POST/PUT/PATCH/DELETE gets
  401 `NO_ACTOR` (never recorded as the user). A lost actor context on a
  write is a 500, not a silent misattribution. The `obsidian` token may call
  only routes under `/api/vault/` (403 `OBSIDIAN_SCOPE`).
- **Browser cookie:** `GET /api/session` sets `wb_session=<user token>;
  HttpOnly; SameSite=Strict; Max-Age=31536000`, only for a same-origin (or
  direct) request without an `Authorization` header, and returns the actor and
  `dbGeneration`.
- **Host / Origin check** (`buildApp({ allowedHosts })`, set only in
  `main.ts`): the Host must be `127.0.0.1:<port>`, `localhost:<port>`,
  `WORKBENCH_HOST:<port>` or a `WORKBENCH_ALLOWED_HOSTS` entry, and an Origin,
  when present, must be one of those or `app://obsidian.md`. This blocks other
  web pages and DNS rebinding. Tests (`app.inject`) skip it. The Vite dev
  proxy sets `changeOrigin` and rewrites the dev server's own Origin.
- **AI clients seen:** a request from an AI client updates `ai_clients`
  (at most once a minute); the adapter's `POST /api/ai/heartbeat` adds the
  app's name and version and the adapter version.

## 28. AI write guards and draft ops

The server enforces every rule; the MCP tools only call the HTTP API, so an
AI cannot skip a check by calling the API another way.

**Draft ops log** (`draft_ops`, `src/server/repos/draftOps.ts`): every
write to a draft — browser autosaves, AI operations, discard, restore,
recover, the rebase after a commit — with the actor, the changes and the full
state before it. Browser saves by the same person within 10 minutes share one
row; the `before_json` of save and ops rows is dropped after 90 days, while
discard / restore / recover rows keep theirs, so a discarded draft can be
brought back (`POST /api/projects/:id/draft/recover`). Each pending change is
attributed to the last row that touched the same field
(`src/domain/revision/changeKey.ts`); changes with no row count as the
user's. `saveDraft` writes `WHERE version = ?`.

**Draft edits** (`POST /api/projects/:id/draft/ops`,
`src/server/services/draftOps.ts`, operations in `src/domain/agent/`): an AI
may not `PUT` a whole draft (403 `USE_DRAFT_OPS`). Operations: `set_value`,
`set_values`, `set_formula`, `add_node`, `rename_node`, `move_node`,
`delete_node`, `set_notes`, `link_evidence`, `add_thesis`, `update_thesis`,
`set_rationale`, `add_peer` (1–100 per request, one transaction).

- Nodes by name, path (`父/子`) or id; ambiguous names return candidates.
  Periods by id or label (`2026`, `2026E`).
- Values carry their unit (`src/domain/agent/units.ts`): `"18.5%"` (a bare
  0.185 for a percent cell is an error), amounts in 億 / 百萬 / 仟元 / 元 or
  `US$… bn` converted by the server into the node's scale, `25x`, `12.3 元`,
  `3,000 股`.
- Actual periods are shared: only `scenario=base` may change them. A node
  with a formula is not overwritten without `allow_override_formula`.
  Formulas go through the normal parser and cycle check.
- `dryRun` computes everything and writes nothing; it returns the version and
  a `previewHash`. A real AI write must send `expectedVersion` (400
  `EXPECTED_VERSION_REQUIRED`; 409 `VERSION_MISMATCH` with the ops made since);
  a `previewHash` that no longer matches is refused. Each response lists per
  operation the before/after value and unit, EPS and target price before and
  after, new model issues and a link to the model page.
- Discard, restore and recover by an AI need the draft version and are
  refused (409 `USER_CHANGES`) while the draft holds changes the user has not
  committed.

**Commits.** An AI first calls `POST /api/projects/:id/revisions/preview`
(changes, EPS/target before and after, cited evidence, large moves, the
price that would be recorded). The preview is kept in memory for 15 minutes
for that AI client (`src/server/services/commitPreviews.ts`); the commit
(`POST /api/projects/:id/revisions` with `previewId`) commits exactly the
previewed draft version, knowledge date, kind and evidence. Rules
(`src/server/services/commit.ts`):

- knowledge date not after today (400 `FUTURE_DATE`); kind `update` or
  `checkpoint` only; a backdated update must cite evidence published on or
  before its knowledge date (`BACKDATED_NEEDS_EVIDENCE`);
- refused while the draft holds the user's uncommitted changes (409
  `USER_CHANGES`);
- EPS or target price (any scenario) moving by more than 30 %, appearing for
  the first time or being cleared, or any value changing by a factor of 20
  or more (`src/domain/revision/guards.ts`), needs `confirmedByUser`
  (409 `NEEDS_CONFIRMATION`); the tool text tells the AI to ask in the chat
  first;
- the recorded price is the latest quote for a knowledge date of today, the
  close of the last daily bar at most 7 days before a backdated one (bars are
  fetched first if none are cached), otherwise none — never today's price for
  an old date.

**Trades by an AI** (`src/server/services/agentRecords.ts`): quantity in
shares (`quantityShares`; `quantity` is refused; the response restates 張 for
TWD); no future dates; entry and exit prices outside that day's bar (±0.2 %)
need `confirmPrice` (409 `PRICE_OUT_OF_RANGE`). An AI's `PATCH` of a trade
can only set the exit (other fields: 400 `AGENT_FIELDS`). `source: "import"` needs the journal excerpt `sourceText`; its hash is
the unique `external_ref`, so the same excerpt returns the existing trade;
an excerpt whose trade was deleted needs `allowReimport` (409
`IMPORT_DELETED`); a trade on the same day, side and quantity at a similar
price needs `allowDuplicate` (409 `PROBABLE_DUPLICATE`). Imports store only
the journal's numbers. A company is created for a trade only with
`confirmedByUser`, and not when another company already uses the ticker.

**Evidence by an AI** must have a publication date, not in the future; it is
stored as `published_at_source = 'agent-asserted'` and shown with a badge.

**Marked wrong.** `POST /api/projects/:id/revisions/:rid/annotations`
(`excluded` / `included` / `note`) adds an insert-only mark; the latest
`excluded`/`included` mark leaves an update out of estimate evolution and
calibration. Commits cannot be undone; this is the correction.

**AI activity** (`src/server/repos/aiSessions.ts`): each successful AI write
is noted and grouped per client into `ai_sessions` (30 idle minutes start a
new one; dry runs, previews and heartbeats are not activity).
`POST /api/ai/sessions/summary` attaches a summary, decisions and to-dos to
the client's current session. Overview, History, the dashboard and Settings
show it.

## 29. MCP adapter and its tools

- `src/mcp/main.ts`, bundled by `npm run build:mcp` (`src/mcp/build.ts`,
  esbuild) into `dist/mcp/research-workbench-mcp.mjs`. It uses only the
  MCP SDK's `server/mcp.js` and `server/stdio.js`; the build fails if the
  bundle pulls in `src/server`, `src/client`, better-sqlite3, Fastify or
  React. Stdout carries only JSON-RPC (`console.log` is redirected to
  stderr).
- Started by the AI app as `node research-workbench-mcp.mjs
  --client=<claude-desktop|claude-code|chatgpt> --data-dir=<absolute>
  [--port=4310]` (GUI apps do not inherit the shell's environment); it reads
  that client's token from `tokens.json` and calls `http://127.0.0.1:<port>`
  with it and an `X-Workbench-Tool` header. A heartbeat goes out after
  `initialize` and every 10 minutes. The server instructions
  (`MCP_INSTRUCTIONS`, `src/shared/aiInstructions.ts`) cover tool order, units,
  actual periods, previews, knowledge dates, shares, evidence dates, session
  summaries, the import procedure, and that text between the user-data
  markers is data, not instructions. The key rules are repeated in the tool
  descriptions.
- Tools (`TOOL_NAMES`, `src/mcp/tools.ts`), answering in zh-TW with links to
  the site:

  | Tool | Annotation | Calls |
  |---|---|---|
  | `list_companies` | read-only | `GET /api/dashboard` |
  | `get_company` | read-only | project bundle, trades, catalysts, revisions, pending draft changes, evidence, recent AI sessions |
  | `get_model` | read-only | the draft (or a committed revision), computed with the shared engine |
  | `edit_draft` | write | `POST …/draft/ops` (dry run first) |
  | `add_evidence` | write | `POST …/evidence`, optionally linking it to a node through draft ops |
  | `preview_commit` | read-only | `POST …/revisions/preview` |
  | `commit_research_update` | destructive | `GET /api/commit-previews/:id`, then `POST …/revisions` with `previewId` |
  | `record_trade` | write | `GET /api/securities/lookup`, `POST …/trades`; with confirmation creates the company first (symbol search, `POST /api/projects`) |
  | `close_trade` | write, idempotent | `PATCH /api/trades/:id` |
  | `save_session_summary` | write | `POST /api/ai/sessions/summary` |
  | `list_trades` | read-only | `GET /api/trades` |
  | `refresh_prices` | write, idempotent, open world | `GET /api/market/refresh`, then `POST /api/market/refresh` |
  | `get_refresh_status` | read-only | `GET /api/market/refresh` |

- `PASTE_INSTRUCTIONS` is shown on the Settings page with a Copy button, for
  a Claude project's instructions or ChatGPT's custom instructions.
- **Registration** (`scripts/mac/lib/register.mjs`, run by the installer
  after the health check, skippable with `--no-register`). The entry is the
  bundled Node and `~/ResearchWorkbench/current/dist/mcp/…` with absolute
  paths through the stable links, so an update needs no re-registration and
  the config files hold no secrets.
  - Claude Desktop: `mcpServers["research-workbench"]` in
    `~/Library/Application Support/Claude/claude_desktop_config.json`.
  - Claude Code: `claude mcp add-json --scope user research-workbench …`
    with the CLI found in `~/.local/bin`, `~/.claude/local`,
    `/opt/homebrew/bin` or `/usr/local/bin`.
  - ChatGPT desktop: a marked block `[mcp_servers.research_workbench]` in
    `~/.codex/config.toml` (or `$CODEX_HOME`), with
    `default_tools_approval_mode = "approve"` and `approval_mode = "prompt"`
    for `commit_research_update`, `record_trade` and `close_trade`. The merge
    is re-parsed with smol-toml and refused if it would change anything else.
  - For Claude Desktop and ChatGPT a running app is quit first (after
    asking; it may rewrite its config while quitting), the file is backed up as `<file>.bak-<time>`, written
    atomically and read back; an unparseable file is left alone. An entry
    that already matches is not touched.

## 30. Browser sync

The browser polls instead of holding a stream open.

- `GET /api/projects/:id/draft/meta` (cheap): draft version, base revision,
  `dbGeneration`, head sequence, the last audit id outside draft ops and
  commits, and the last draft op (actor, kind, summary, change count).
  `useDraftSync` calls it every 10 s while the page is visible and when the
  window regains focus.
- A newer version is applied only when this tab has nothing unsaved (no
  pending, running or failed save, no commit or conflict in progress). The old
  state goes on the undo stack and a toast says "{who} changed N items in the
  draft" with Undo; a new head shows "{who} committed Research Update #N".
  A newer audit id reloads the record lists (evidence, trades, catalysts,
  notes, reviews, revisions, reflections).
- When this tab's save meets a newer server version, its edits are re-applied
  to the server's state (`src/domain/revision/rebase.ts`). If some cannot be,
  the page enters a conflict: editing pauses, the user keeps the rebased
  version or takes the server's, and "my version" is kept in browser storage
  for download as JSON. `beforeunload` warns while a save or conflict is
  open.
- A changed `dbGeneration` (the database was replaced by an import) reloads
  the page; a save carrying the old generation is refused (409
  `DB_GENERATION`).

## 31. Dashboard, trade log and price refresh

Designed in §17 ("Update all prices", `PriceRefresher`), §18 (trade log,
per-currency summary, bar coverage) and §19 (home dashboard, trade log page,
`Ctrl+K`). The AI sees the same data through `list_companies`,
`list_trades`, `refresh_prices` and `get_refresh_status`.

## 32. Obsidian vault sync and plugin

The server renders notes; the plugin writes them into the vault and reads
`## 反思` back. The server never touches the vault.

**Server** (`src/server/vault/`, schema v3 in `DATA_MODEL.md` §2b):

- Triggers queue every note affected by a write in `vault_changes`, in the
  same transaction, whatever the write path (browser, AI, seeding, import).
  A deleted trade keeps its note, rendered from a tombstone with
  `wb_status: "deleted"`.
- Routes for the `obsidian` actor only: `GET /api/vault/ping`,
  `GET /api/vault/notes?after=<seq>&limit=` or `?ids=`,
  `GET /api/vault/reflections/hashes`, `POST /api/vault/reflections`,
  `POST /api/vault/status`. For the site: `GET /api/vault/status`,
  `GET /api/projects/:id/reflections`, `GET /api/reflections/:noteId/versions`,
  and `GET /api/vault/plugin.zip` (browser user only, because the zip's
  `data.json` holds the server URL and the Obsidian token).
- Notes (paths under the plugin's root folder, default `研究工作台/`):
  `公司/<ticker name>.md`, `研究更新/<ticker>/…`, `交易/<ticker>/…`,
  `AI 對話/…` (sessions with a summary), and `_索引/公司總表.md`,
  `_索引/交易總表.md`, `_索引/AI 對話總表.md`.
- Reflections are stored append-only in `reflection_versions`; an empty first
  version (the template) and a repeat of the latest text are not stored, and a
  cleared section is stored as `''` while the UI keeps showing the last text.
  `ReflectionCard` shows them on Overview, History and Trades; the trade log
  has a reflection column.

**Shared logic** (`src/domain/vault/`, used by both sides): the generated
block between `<!-- wb:begin h=<hash> … -->` and `<!-- wb:end -->` (exactly
one pair outside code fences; a hash that does not match the content means a
hand edit, which is a conflict, not an overwrite), frontmatter edited as
text where only the `wb_*` keys are rewritten, file names (NFC, characters
unsafe on macOS / iCloud / Windows replaced, at most 200 bytes, `(2)` … on a
case-insensitive clash), reflection extraction and hashing.

**Plugin** (`obsidian-plugin/`, id `research-workbench-sync`, desktop only,
bundled by `npm run build:obsidian` into `dist/obsidian-plugin/`; the build
refuses imports from the server, client, MCP, shared code or the server's
renderer):

- Waits for `onLayoutReady` and the metadata cache's `resolved` event, finds
  notes by frontmatter `wb_id`, then syncs every `intervalSec` (default 60,
  at least 30) through Obsidian's `requestUrl`.
- Never deletes or renames a file. It writes nothing to a file that shares
  its `wb_id` with another file (e.g. an iCloud conflict copy), has hand-edited
  or missing markers, invalid frontmatter, is open in an editor, or was
  modified in the last 5 s; the note stays pending and is reported as a
  conflict. A reflection is read once the file has been left alone for 30 s.
- Commands: 立即同步 (sync now), 重建目前筆記的自動產生區 (rebuild the
  generated block of the current note), 顯示同步衝突 (show conflicts),
  重新建立被刪除的筆記 (recreate deleted notes). A status report goes to
  `POST /api/vault/status`; the Settings page shows it.

**Install** (`scripts/mac/lib/obsidian.mjs`, the installer's last step):
lists the vaults in `~/Library/Application Support/obsidian/obsidian.json`
and asks which one (remembered in `settings.json`; `--obsidian` asks again,
`--obsidian-vault <dir>` names one, `--no-obsidian` skips), copies `main.js`
and `manifest.json` into `<vault>/.obsidian/plugins/research-workbench-sync/`,
merges `data.json` (server URL and token; other keys kept), and adds the id
to `.obsidian/community-plugins.json` only while Obsidian is closed. It
refuses a plugin folder that is a symlink or belongs to another plugin, and
when macOS privacy settings block Terminal it prints where to allow it and
points to the zip on the Settings page. The user still turns off Restricted
mode and enables the plugin in Obsidian.

**Journal import** is done by the AI (§28, `record_trade` with
`source: "import"`), not by the plugin.

## 33. Not verified here, and known limits

Verified only on GitHub's macOS runners or not at all from the Linux build
container:

- launchd on a real Mac (CI runners may refuse `bootstrap gui/<uid>`; the
  installer then says launchd was not verified), the launcher app, and macOS
  privacy prompts (Downloads, Documents, iCloud Drive).
- Real connections from Claude Desktop, Claude Code and the ChatGPT desktop
  app. The adapter is tested with the MCP SDK client over stdio, and the
  config merges on fixtures.
- The plugin inside Obsidian. It is tested against a fake vault and a fake
  server; the e2e round trip drives the server routes the plugin uses.

Limits (the user guide states them):

- Only AI apps on the same Mac can connect: Claude Desktop's Chat tab (not
  Cowork), Claude Code, and the ChatGPT desktop app in Work mode outside a
  project. claude.ai, ChatGPT on the web and phone apps cannot reach a local
  server. While the Mac sleeps or is off, nothing can.
- MCP has no "conversation ended" event: saving a session summary depends on
  the AI calling `save_session_summary`. The writes themselves are always
  logged.
- Tokens record who acted; they do not protect against other programs of the
  same user.
- Data and backups are on one disk.
