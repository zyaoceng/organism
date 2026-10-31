/**
 * Creates a clearly fictional example company ("Example Power Co. (DEMO)") with two Research
 * Updates, evidence and synthetic prices, so the workflow can be explored offline.
 *
 *   npm run seed:demo            (uses WORKBENCH_DATA_DIR or ./data)
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addLink, addThesis, renameNode, setNotes, setValue } from '../domain/model/ops';
import { idByName, sampleModel } from '../domain/testing/sample';
import { structureOnly } from '../domain/templates/standard';
import { openDatabase } from './db/connection';
import { CsvProvider } from './market/csv';
import { DemoProvider } from './market/demo';
import { MarketService } from './market/service';
import { createProject, getDraft, primarySecurity, saveDraft } from './repos/projects';
import { createCatalyst, createEvidence } from './repos/records';
import { commitDraft } from './services/commit';
import { addDays, localToday } from './util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dataDir = path.resolve(process.env.WORKBENCH_DATA_DIR ?? path.join(root, 'data'));
const db = openDatabase(path.join(dataDir, 'workbench.db'));
const today = localToday();
const year = Number(today.slice(0, 4));

let state = sampleModel(year);
const growthA = idByName(state, 'YoY Growth', 'Business A');
state = renameNode(state, idByName(state, 'Business A'), 'Data-center power');
state = renameNode(state, idByName(state, 'Business B'), 'Industrial power');
state = renameNode(state, idByName(state, 'Business C'), 'Optionality (new platforms)');

const projectId = createProject(db, {
  name: 'Example Power Co. (DEMO)',
  description: 'Fictional company with illustrative numbers and synthetic prices. Use it to explore the workflow.',
  state: structureOnly(state),
  templateName: 'the demo seed',
  security: { name: 'Example Power Co.', ticker: 'DEMO', exchange: 'TWSE', apiSymbol: 'DEMO.TW', currency: 'TWD', priceSource: 'demo' },
});

const sec = primarySecurity(db, projectId)!;
const market = new MarketService(db, { demo: new DemoProvider(), csv: new CsvProvider() }, { minIntervalMs: 0 });
await market.bars(sec, 'demo', true);
await market.quote(sec, 'demo', true);

const ev1 = createEvidence(db, projectId, {
  title: 'Q2 call: data-center power orders up, capacity expansion announced',
  sourceName: 'Company IR (fictional)',
  sourceType: 'earnings_call',
  publishedAt: addDays(today, -40),
  notes: 'Management: data-center power +60% YoY; new line adds 30% capacity next year.',
});
const ev2 = createEvidence(db, projectId, {
  title: 'Channel check: second hyperscaler in qualification',
  sourceName: 'Supplier conversation (fictional)',
  sourceType: 'conversation',
  publishedAt: addDays(today, -2),
  notes: 'Qualification samples shipped; decision expected next quarter.',
});

// Update 1: initiation
let d = getDraft(db, projectId);
let s = { ...state };
s = setNotes(s, growthA, 'Growth driven by rack-level power content; capped by the capacity expansion timetable.');
s = addLink(s, { evidenceId: ev1.id, nodeId: growthA, relation: 'supports', locator: 'p.7' }).state;
s = addThesis(s, { statement: 'Data-center power keeps >20% growth through FY+2', invalidation: 'No second hyperscaler qualification within 12 months, or gross margin < 18%', nodeIds: [growthA] }).state;
d = saveDraft(db, projectId, s, d.version);
commitDraft(db, projectId, { title: 'Initiation', reason: 'Initial model from reported segments and Q2 guidance.', asOfDate: addDays(today, -30), evidenceIds: [ev1.id], draftVersion: d.version }, today);

// Update 2: new information changes several assumptions
d = getDraft(db, projectId);
s = d.state;
s = setValue(s, growthA, `FY${year + 2}`, 'base', 0.3);
s = setValue(s, idByName(s, 'Gross Margin'), `FY${year + 2}`, 'base', 0.22);
s = addLink(s, { evidenceId: ev2.id, nodeId: growthA, relation: 'triggered' }).state;
d = saveDraft(db, projectId, s, d.version);
const rev = commitDraft(db, projectId, { title: 'Second hyperscaler in qualification', reason: 'Qualification raises FY+2 growth (20% → 30%) and mix lifts gross margin by 1pp.', asOfDate: today, evidenceIds: [ev2.id], draftVersion: d.version }, today);

createCatalyst(db, projectId, { title: 'Hyperscaler qualification decision', type: 'customer_qualification', expectedDate: addDays(today, 75), datePrecision: 'quarter', expectedOutcome: 'Qualification passes; volume from the following quarter', nodeIds: [growthA], evidenceIds: [ev2.id] });

console.log(`Demo project created: ${projectId} (Research Update #${rev.seq}). Data: ${dataDir}`);
db.close();
