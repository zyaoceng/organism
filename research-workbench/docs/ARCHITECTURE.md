# Research Workbench — Architecture

This document records the architecture review that preceded the build, the
self-critique of the first proposal, and the resulting (revised) design.
Sections 1–20 describe the **revised** design; §21 is the critique log that
explains what changed from the first proposal and why; §22 separates verified
facts from engineering assumptions and product decisions.

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
  src/domain/   Pure TypeScript. No I/O. Shared by client and server.
    model/      Model state types, zod schema, pure edit operations, tree helpers
    formula/    Lexer, parser (AST), name↔ID references, evaluator, unit inference
    calc/       Dependency graph (DAG, cycles), calculation engine
    revision/   Diff, downstream impact, marginal attribution, change descriptions
    templates/  Standard Equity Research Template
    market/     Bar types, SMA/EMA/ATR, trailing stop
    trade/      Trade metrics (P&L, R, MFE/MAE)
  src/server/   Fastify HTTP API, SQLite (better-sqlite3), migrations,
                repositories, commit service, attachment store,
                market-data providers + cache
  src/client/   React UI (Vite), zustand store, pages and components
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
- **Data directory** (`WORKBENCH_DATA_DIR`, default `./data`): `workbench.db`
  and `attachments/<aa>/<sha256>`. Git-ignored. Back up by copying the folder.
- **Research state** stored as JSON text (`drafts.state_json`,
  `revisions.state_json`), validated with a zod schema on every write.
- **Immutability**: `revisions` rows are insert-only (no update/delete code
  path exists). Evidence referenced by revisions cannot be deleted.
- **Audit log**: updates/deletes of evidence, catalysts, trades, notes,
  reviews store `before`/`after` JSON.
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

- Providers: `yahoo` (unofficial chart endpoint, see §22), `demo`
  (deterministic synthetic series, always labelled SYNTHETIC in the UI), and
  CSV import (user-supplied file; provenance = filename + import time).
- `MarketDataService` wraps providers with: SQLite cache (`price_bars`,
  `quotes`), incremental history fetch, per-provider minimum request
  interval, typed errors (`NOT_FOUND`, `RATE_LIMITED`, `NETWORK`, `PROVIDER`)
  and a fetch log. Staleness is computed from `fetched_at`.
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
- Derived metrics (pure): P&L, return, R multiple, holding days, MFE/MAE, and
  the exit a 2×ATR trailing stop would have produced.
- Chart: entry/exit arrows, stop and target price lines.
- This separates "was the thesis wrong?" (snapshot vs outcome) from "was
  execution poor?" (trade vs trailing-stop counterfactual, MFE/MAE).

## 19. Primary UI layout

```
┌─────────┬──────────────────────────────────────────────┬──────────────────┐
│ Project │  Top bar: company · price · scenario (B/B/B)  │                  │
│ nav     │  EPS · target P/E · target price · upside     │   Inspector      │
│         ├──────────────────────────────────────────────┤   (selected      │
│Overview │  Research tree         FY24A FY25A FY26E ...  │    node)         │
│Model    │  ▾ EPS                  6.1   8.6   10.2      │   values matrix  │
│Evidence │    ▾ Revenue            ...                    │   formula        │
│Valuation│       Business A        ...                    │   depends/used   │
│Catalysts│  ▾ P/E                                         │   notes          │
│Market   │  Target Price           355.0 (single value)   │   evidence       │
│Trades   ├──────────────────────────────────────────────┤   theses         │
│History  │  Draft changes (3) · impact · Commit update ▲  │   history        │
└─────────┴──────────────────────────────────────────────┴──────────────────┘
```

Other pages: Overview (identity, KPIs by scenario, theses, upcoming
catalysts, recent updates, notes journal), Evidence library, Valuation (P/E
workspace), Catalysts timeline, Market (chart), Trades (journal), History
(updates timeline, compare, estimate evolution, calibration, reviews).

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
- Model sizes stay below ~500 nodes × ~40 periods, so a full recalculation
  per edit (and one per changed node for attribution) is fast enough.
- SQLite's single-writer model is sufficient for one to five users.

**Product decisions (the user's to revisit)**

- P/E is always manual; no scoring formula.
- Percent cells accept "40" or "40%" as 40%.
- Missing inputs are errors, not zero.
- Knowledge dates are non-decreasing.
- Evidence links are versioned with the model.
- UI language is English; node names, notes and evidence may be in any
  language (CJK tested).
- The default target-price basis is the FY two years ahead (the prototype's
  2028 convention); changing it is an ordinary formula edit.

## 23. Implementation status and verification (V1 prototype)

Built as designed above; deviations are listed at the end of this section.

| Area | Where | Verified by |
|---|---|---|
| Formula engine (parser, name↔ID, evaluator, units) | `src/domain/formula/` | `formula.test.ts` |
| Dependency DAG, cycles, calculation, scenarios, model checks | `src/domain/calc/` | `engine.test.ts` |
| Tree operations, periods, units, schema invariants | `src/domain/model/` | `ops.test.ts` |
| Diff, impact, attribution | `src/domain/revision/` | `revision.test.ts` |
| Indicators, trade metrics | `src/domain/market/`, `src/domain/trade/` | `indicators.test.ts` |
| Persistence, commit service, evidence/attachments, trades, market cache, export, migrations | `src/server/` | `server.test.ts` (Fastify inject, temp data dir) |
| UI and end-to-end workflow | `src/client/` | `e2e/acceptance.mjs` — 19 checks covering acceptance tests 1–18 through the real UI, against a production build on a throwaway data directory |

Results at the time of writing: `npm run typecheck` clean, `npm test` 70/70,
`npm run e2e` 19/19.

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
