import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { normalizeAppName, sessionPathFor } from '../app.js';

/**
 * The whole pipeline, in the one order that works.
 *
 * Written after running it by hand three times. Two of the orderings are not
 * obvious and both fail quietly rather than loudly:
 *
 *   - `extract-all` without `--force` sees every campaign marked done and
 *     reports "nothing to do", producing a report with today's date built
 *     entirely on last month's campaigns.
 *   - `enrich` must precede `normalize`, because the graph's comparison
 *     against the account is built during normalize. Run the other way round
 *     and every reference looks present and nothing is reported as broken.
 *
 * `login` is deliberately absent: it needs a human at a browser.
 */

export interface Step {
  name: string;
  script: string;
  args: string[];
}

export interface RefreshOptions {
  app: string;
  /** Rebuild the reports from data already on disk, touching no network. */
  skipExtract: boolean;
  /** A tag list to analyse instead of auditing every tag in the account. */
  tagsPath?: string;
  /** Also re-render the per-campaign pages, which is slow and rarely needed. */
  render: boolean;
}

export function planSteps(options: RefreshOptions): Step[] {
  const app = ['--app', options.app];
  const steps: Step[] = [];

  if (!options.skipExtract) {
    steps.push({ name: 'enumerate', script: 'enumerate', args: app });
    // --force is the whole point: without it this step does nothing at all.
    steps.push({ name: 'extract-all', script: 'extract-all', args: [...app, '--force'] });
    steps.push({ name: 'enrich', script: 'enrich', args: app });
  }

  steps.push({ name: 'normalize', script: 'normalize', args: app });
  steps.push({
    name: 'tag-impact',
    script: 'tag-impact',
    args: options.tagsPath === undefined ? [...app, '--all-tags'] : [...app, '--tags', options.tagsPath],
  });
  steps.push({ name: 'broken-refs', script: 'broken-refs', args: app });
  if (options.render) steps.push({ name: 'render', script: 'render', args: app });

  return steps;
}

function fail(message: string): void {
  console.error(`\n${message}\n`);
  process.exitCode = 1;
}

function argAfter(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

/** Runs one npm script, streaming its output so a long step is watchable. */
function run(step: Step): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('npm', ['run', step.script, '--', ...step.args], {
      stdio: 'inherit',
      shell: false,
    });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const rawApp = argAfter(argv, '--app');
  if (rawApp === undefined) {
    fail(
      'Usage: npm run refresh -- --app <appName> [--tags <list.csv>] [--skip-extract] [--render]',
    );
    return;
  }

  let app: string;
  try {
    app = normalizeAppName(rawApp);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }

  const options: RefreshOptions = {
    app,
    skipExtract: argv.includes('--skip-extract'),
    render: argv.includes('--render'),
  };
  const tagsPath = argAfter(argv, '--tags');
  if (tagsPath !== undefined) options.tagsPath = tagsPath;

  if (options.tagsPath !== undefined && !existsSync(options.tagsPath)) {
    fail(`No tag list at ${options.tagsPath}`);
    return;
  }

  // Checked up front rather than four minutes into the extract.
  if (!options.skipExtract && !existsSync(sessionPathFor(app))) {
    fail(`No saved session for "${app}". Run:  npm run login -- --app ${app}`);
    return;
  }

  const steps = planSteps(options);
  const started = Date.now();
  console.log(`\n[${app}] refreshing — ${steps.map((s) => s.name).join(' → ')}\n`);

  for (const [index, step] of steps.entries()) {
    const label = `[${index + 1}/${steps.length}] ${step.name}`;
    console.log(`\n━━━ ${label} ━━━`);
    const code = await run(step);
    if (code !== 0) {
      // Name the command to resume from, so a failure halfway through does not
      // mean starting the 20-minute extract again.
      const resume = steps
        .slice(index)
        .map((s) => `  npm run ${s.script} -- ${s.args.join(' ')}`)
        .join('\n');
      fail(
        `${label} failed with exit code ${code}. Nothing after it ran.\n\n` +
          `Fix the cause, then resume with:\n${resume}`,
      );
      return;
    }
  }

  const elapsed = ((Date.now() - started) / 1000 / 60).toFixed(1);
  console.log(`\n━━━ done in ${elapsed} min ━━━`);
  console.log(`  artifacts/${app}/broken-refs.html   — what is already broken`);
  console.log(`  artifacts/${app}/tag-impact.html    — where every tag is used`);
  console.log('  Both are self-contained: send the file, no server needed.\n');
}

await main();
