# Research Workbench — Product Specification

Status: V1 prototype spec. Keep this file in sync with `ARCHITECTURE.md` and
`DATA_MODEL.md` whenever a product decision changes.

## 1. Purpose

Research Workbench is a private tool for **standardizing an equity research
process** so that it can be calibrated over time. It is not a stock
calculator. It exists so that, months later, the analyst can answer:

- What did I believe, and why?
- What evidence supported it?
- When did I change my view, what changed, and how did the change propagate
  into EPS, the multiple, and the target price?
- In hindsight, was the error in the data, the interpretation, the assumption
  magnitude, the model, the valuation multiple, the timing, or the trade
  execution?

Primary users: the author and a few experienced friends. Professional
concepts are kept; mass-market onboarding is a non-goal.

## 2. The causal chain (product backbone)

```
Evidence ──► Interpretation / Assumption ──► Financial metric ──► EPS ──► Valuation ──► Target price
                                                                                      │
                                         Target price + market conditions ──► Trade ──► Outcome ──► Review / calibration
```

Every step is a distinct object in the system. Evidence is never collapsed
into an assumption; an assumption is never collapsed into a model output.

## 3. Product priorities (in order)

1. Clarity 2. Consistency 3. Traceability 4. Flexibility 5. Low-friction entry
6. Easy identification of modeling errors 7. Easy understanding of why
estimates changed 8. Maintainable code.

## 4. Core concepts (user vocabulary)

| Concept | Meaning |
|---|---|
| **Company Project** | The unit of work: one company, its security, its research model and everything around it. |
| **Research Model** | A tree of nodes. The tree is the *structure of the reasoning*. |
| **Node** | One idea in the tree: a metric (with a time series or a single value), a driver, or a pure heading. |
| **Period** | A column of time (e.g. `FY2025`), marked **A**ctual or **E**stimate. |
| **Formula** | How a node is calculated from other nodes. References are by name in the UI and by stable ID in storage. |
| **Scenario** | Bear / Base / Bull. Base holds the shared values; Bear and Bull hold *overrides* only. Actuals are shared. |
| **Evidence** | A source: URL, uploaded file, image/screenshot, or text note. Lives in the project's evidence library. |
| **Evidence link** | "This evidence *supports / contradicts / gives context to / triggered a change in* this node", optionally with a page/slide/timestamp locator. |
| **Thesis** | A statement the analyst believes, with optional **invalidation conditions** and a status. |
| **Draft** | The working copy of the model. Autosaved, never lost, but not yet a belief of record. |
| **Research Update** | A commit: the draft's changes + title + reason/interpretation + cited evidence + knowledge date. Immutable. |
| **Snapshot** | The full, immutable research state after any Research Update, with frozen calculated outputs and the market price at the time. A **Checkpoint** is a Research Update with no model change ("reviewed, view unchanged"). |
| **Catalyst** | A dated event linked to nodes, with expected vs actual outcome. |
| **Trade** | A journal entry referencing the research snapshot that was valid on the entry date. |
| **Review** | A post-mortem that classifies errors into user-chosen categories. |

## 5. Main interface

Desktop-first, three columns plus an optional bottom panel:

- **Left sidebar** — project switcher and navigation: Overview, Model,
  Evidence, Valuation, Catalysts, Market, Trades, History.
- **Center** — the Research Tree / model canvas: indented tree with
  collapsible branches; each row shows the node's time series for the
  selected scenario. Tree = structure; the period columns = time.
- **Right inspector** — the selected node: name, role, unit, scenario ×
  period value matrix, formula editor, dependencies (inputs / used by),
  notes, evidence, theses and invalidation conditions, catalysts, change
  history.
- **Bottom panel** — Draft Changes: every pending change, live downstream
  impact on EPS and target price, and the Commit Research Update form.

Modal dialogs are avoided; editing happens inline or in the inspector.

## 6. Functional requirements — V1

### 6.1 Projects and templates
- Create a company project with a security identity (company name, ticker,
  exchange, provider symbol, currency).
- Start from the **Standard Equity Research Template** (EPS branch, P/E
  branch, Target Price). The template is copied, never linked: every node is
  editable. A project's structure can be saved as a new template.

### 6.2 Research tree
- Add, remove, rename, duplicate (node or whole branch), move (drag & drop or
  keyboard), nest, collapse and expand nodes.
- Duplicating a branch remaps formula references that point inside the
  branch to the new copies.
- Business segmentation is just nodes under Revenue: add, delete, reorder,
  nest freely. Custom (analyst) segmentation is first-class.

### 6.3 Hierarchy is not calculation
- Parent/child placement never implies a calculation.
- Calculations come only from formulas. Formulas may reference any node in
  any branch. The dependency graph must be acyclic; cycles are rejected with
  the full cycle path in the error.
- `SUM(CHILDREN())` is the one explicit, opt-in bridge from hierarchy to
  calculation; the inspector always lists what it resolved to.
- Selecting a node highlights its inputs and dependents in the tree, so
  cross-branch formulas stay understandable without drawing crossing edges.

### 6.4 Time series and point-in-time data
- A metric holds a time series; the tree never has one node per year.
- Each period is Actual or Estimate. A single cell in an actual period may be
  marked as an analyst estimate (e.g. a custom segment management does not
  disclose). Calculated values are marked estimated if any input is.
- Values carry unit, currency and scale (including 億 = 1e8).
- The **knowledge date** (as-of date of a Research Update) is separate from
  the **fiscal period**. Committed estimates are never overwritten; the
  history of "FY28 EPS as believed on each date" is always available.
- Knowledge dates must be non-decreasing across updates, and an update cannot
  cite evidence published after its knowledge date (look-ahead guard).

### 6.5 Formula engine
- Operators `+ - * / ^`, parentheses, postfix `%` (`40%` = 0.4), comparisons
  for `IF`.
- Functions: `SUM MIN MAX AVERAGE CAGR IF ABS ROUND AND OR NOT PREV CHILDREN`.
- `PREV(x)` / `PREV(x, n)` reads an earlier period, so
  `PREV([Revenue]) * (1 + [Growth])` is valid and is not a cycle.
- `[EPS]@FY2028` reads a specific period (used by single-value nodes such as
  Target Price).
- No `eval`. Errors are explained in plain language: invalid syntax, unknown
  name, ambiguous name, deleted reference, missing input, division by zero,
  circular dependency, time-series used without a period.

### 6.6 Scenarios
- Bear / Base / Bull without duplicating the model: Base values are shared;
  Bear/Bull store overrides only for estimate cells.
- Switching scenario recalculates everything instantly.

### 6.7 Evidence and attachments
- Evidence kinds: URL, uploaded file, image/screenshot (clipboard paste
  supported), text note.
- Fields: title, source, source type, URL, file(s), publication date, date
  added, notes, optional verification status, related nodes (via links),
  related Research Updates (via citations).
- Files are stored in persistent project storage (content-addressed), keep
  their original filename, and can be reopened later.
- Evidence referenced by any committed update cannot be deleted, only
  archived.

### 6.8 Draft → Research Update → Snapshot
- Every edit goes to the autosaved draft. Draft cells are highlighted in the
  tree, and the bottom panel lists all pending changes with live impact.
- **Commit Research Update** asks for title, reason / interpretation, cited
  evidence, knowledge date and optional notes.
- On commit the system stores: the full new state, the change set, frozen
  calculated outputs for every node/period/scenario, the downstream impact
  (every changed metric, EPS by period, target price per scenario), a
  per-assumption marginal attribution with an explicit interaction residual,
  and the market price at the time.
- Any past snapshot can be viewed read-only, compared with another, or
  restored into the draft (restoring never rewrites history).

### 6.9 Valuation (P/E workspace)
- Organizes the evidence for the multiple: EPS growth, ROIC, reinvestment
  ROI, gross margin (from the model), historical P/E band, peer table,
  current P/E from market price, re-rating thesis.
- The analyst **manually** sets Bear / Base / Bull P/E with a written
  rationale per scenario. No scoring formula decides the multiple.
- Target price = EPS(basis period) × target P/E, calculated per scenario;
  optional scenario probabilities give a weighted target.

### 6.10 Catalysts
- Title, type, expected date (day / month / quarter precision), actual date,
  status, related nodes, expected outcome, actual outcome, notes, evidence,
  the Research Update it caused (model impact). Upcoming timeline.
- Edits to catalysts, evidence and trades are kept in an audit log so that
  expectations cannot be silently rewritten after the fact.

### 6.11 Theses and invalidation
- A thesis has a statement, invalidation conditions, related nodes, status
  (active / confirmed / invalidated / retired) and an optional review-by
  date. Theses are part of the versioned research state, so drift is visible
  in history.

### 6.12 Market data, chart, trades
- Current price and daily OHLCV through a provider abstraction; provider name
  and fetch time are stored with every value; CSV import is always
  available; a clearly labelled synthetic "demo" provider exists for offline
  use. API keys stay on the server.
- Candlestick chart with volume, moving averages and ATR (separate pane);
  entry / exit markers, stop and target price lines, catalyst markers.
- Trade journal: entry date/price, size, reason, target price at entry, stop
  at entry, ATR at entry, research snapshot (resolved by entry date), exit
  date/price/reason; P&L, R multiple, MFE/MAE, and the hypothetical 2×ATR
  trailing-stop exit for execution review.

### 6.13 History, calibration, review
- Research Update timeline with changes, reasons, evidence, impact.
- Estimate evolution: any node/period across all snapshots per scenario
  (e.g. FY28 EPS on every knowledge date), versus the actual once reported.
- Per-node change history in the inspector.
- Reviews (post-mortems) with the categories: evidence quality, evidence
  interpretation, assumption magnitude, financial model / formula, timing /
  catalyst, valuation multiple, trading execution, risk management. The user
  picks categories and writes notes; nothing is auto-classified.

### 6.14 Search and portability
- Project search across node names, notes, evidence titles/sources/notes,
  catalysts and update titles/reasons.
- Full project JSON export (attachments listed by hash and filename).

## 7. Non-goals for V1

Automated SEC / MOPS parsing, AI research agent, consensus ingestion,
portfolio management, advanced VRVP, ATR / position-size optimization,
broker integration, real-time trading, SaaS features, billing, permissions,
social features. Extension points are documented in `ARCHITECTURE.md`.

## 8. Acceptance tests (V1)

| # | Test | Where it is satisfied |
|---|---|---|
| 1 | New company from a standard template | Projects page → New project |
| 2 | Own business segmentation | Tree: add/rename/nest/reorder under Revenue |
| 3 | Arbitrary new assumption without code change | Tree: add node, set unit, enter values |
| 4 | Formula from other metrics | Inspector formula editor |
| 5 | Upstream change recalculates downstream | Calc engine on every edit |
| 6 | Attach URL, screenshot, file, note to an assumption | Inspector → Evidence |
| 7 | Understand an assumption months later | Inspector: notes, evidence, theses, change history with reasons |
| 8 | One piece of information changes several assumptions in one update | Draft → one commit |
| 9 | See what changed before committing | Draft Changes panel + tree highlights |
| 10 | Previous state recoverable | History: view / compare / restore |
| 11 | How the update changed EPS | Commit impact + attribution |
| 12 | How it changed target price | Commit impact + attribution |
| 13 | Scenarios without three models | Override-based scenarios |
| 14 | Tree readable with cross-branch formulas | Dependency highlighting, inspector input/used-by lists |
| 15 | Historical estimates immune to current data | Frozen outputs; model never reads live prices |
| 16 | Current price and OHLCV | Market page |
| 17 | Entry/exit on the chart | Trades + chart markers |
| 18 | Reconstruct belief, reason, and cause of change | History + time-travel view + evidence citations |

The automated walkthrough in `e2e/acceptance.mjs` exercises these tests
against a throwaway data directory.
