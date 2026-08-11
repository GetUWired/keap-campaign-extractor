import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeAppName } from '../app.js';
import { type EntityCatalog, fetchCatalog } from '../api/catalog.js';
import { createClient } from '../api/client.js';

function fail(message: string): void {
  console.error(`\n${message}\n`);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const appIndex = argv.indexOf('--app');
  const rawApp = appIndex >= 0 ? argv[appIndex + 1] : undefined;
  if (!rawApp) {
    fail('Usage: KEAP_API_KEY=… npm run enrich -- --app <appName>');
    return;
  }

  let app: string;
  try {
    app = normalizeAppName(rawApp);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }

  // Checked before anything else so a missing key costs nothing and says so.
  const apiKey = process.env.KEAP_API_KEY;
  if (!apiKey) {
    fail(
      'KEAP_API_KEY is not set. Create a Service Account Key in the Keap account ' +
        '(admin only) and pass it in the environment. It is never written to disk.',
    );
    return;
  }

  const outDir = join('artifacts', app);
  if (!existsSync(outDir)) {
    fail(`No artifacts at ${outDir}. Run:  npm run extract-all -- --app ${app}`);
    return;
  }

  const started = Date.now();
  let catalog: EntityCatalog;
  try {
    catalog = await fetchCatalog(createClient(apiKey), app);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }

  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, 'entities.json');
  await writeFile(outPath, JSON.stringify(catalog, null, 2), 'utf8');

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n[${app}] catalog: ${catalog.entities.length} entities in ${elapsed}s`);
  for (const [kind, source] of Object.entries(catalog.sources)) {
    console.log(
      'unavailable' in source
        ? `  ${kind.padEnd(12)} unavailable — ${source.unavailable}`
        : `  ${kind.padEnd(12)} ${String(source.count).padStart(5)}  ${source.endpoint}`,
    );
  }
  for (const warning of catalog.warnings) console.log(`  warning: ${warning}`);
  console.log(`  output: ${outPath}\n`);
}

await main();
