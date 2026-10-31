/**
 * Import a data archive from another machine (GitHub Codespaces) into a data directory.
 *
 *   node --import tsx src/server/cli/import-data.ts --archive ~/Downloads/wb-data.tgz --data-dir <dir> [--force] [--summary-only]
 *
 * Run from the research-workbench directory, with the server stopped. --summary-only verifies the
 * archive and prints its summary without touching the data directory. --force replaces a database
 * that already has companies (a copy goes to <data-dir>/backups/pre-import-<time>.db).
 *
 * The last stdout line is the summary as JSON. Exit codes: 0 done, 1 the archive was rejected or
 * another error, 2 the data directory already has companies and --force was not given.
 */
import { parseArgs } from 'node:util';
import { ImportError, importData } from '../services/dataImport';

const USAGE = 'Usage: node --import tsx src/server/cli/import-data.ts --archive <file.tgz> --data-dir <dir> [--force] [--summary-only]';

let args: { archive?: string; 'data-dir'?: string; force?: boolean; 'summary-only'?: boolean };
try {
  args = parseArgs({
    options: { archive: { type: 'string' }, 'data-dir': { type: 'string' }, force: { type: 'boolean' }, 'summary-only': { type: 'boolean' } },
    strict: true,
  }).values;
} catch (e) {
  console.error(`${(e as Error).message}\n${USAGE}`);
  process.exit(1);
}
if (!args.archive || (!args['data-dir'] && !args['summary-only'])) {
  console.error(USAGE);
  process.exit(1);
}

try {
  const r = await importData({ archive: args.archive, dataDir: args['data-dir'] ?? '', force: args.force, summaryOnly: args['summary-only'] });
  if (r.imported) {
    const s = r.summary;
    console.log(`Imported ${s.projects.length} compan${s.projects.length === 1 ? 'y' : 'ies'} and ${s.attachments} attachment(s) into ${args['data-dir']}.`);
    if (r.backupFile) console.log(`The previous database was saved as ${r.backupFile}`);
  }
  console.log(JSON.stringify(r.summary));
} catch (e) {
  console.error(`Import failed: ${(e as Error).message}`);
  process.exit(e instanceof ImportError ? e.exitCode : 1);
}
