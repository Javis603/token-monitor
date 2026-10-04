#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { parseArgs } = require('node:util');
const { collectTaskUsage } = require('../src/shared/providers/codex/taskUsageReader');

const HELP = `Codex task usage (observed lifetime tokens, not a bill or account-wide total)
Usage: npm run codex:usage -- [options]
  --thread ID       Report this thread and all known descendants
  --codex-home DIR  Read a different local Codex state directory
  --events FILE     Import JSONL usage events; repeatable
  --no-local        Import only; never open local Codex databases
  --json            Emit machine-readable JSON
  --output FILE     Create an export (refuses to overwrite an existing file)
  --cloud           Read hosted cloud thread/turn usage (separate source)
  --help            Show this help
Cloud/dot automatic account-wide fetching is not implemented.
See docs/codex-task-usage.md for event and manifest contracts.\n`;

function formatReport(report) {
  const amount = (usage) => usage ? usage.totalTokens.toLocaleString('en-US') : 'unknown';
  const c = report.coverage;
  const lines = ['Codex task usage — observed lifetime / 已采集的累计用量',
    `Known tokens / 已知 Token: ${amount(report.knownUsage)}`,
    `Threads / 线程: ${c.measuredThreads}/${c.knownThreads} measured; ${c.missingUsageThreads} missing usage`,
    `Evidence: ${c.reconciledThreads} reconciled, ${c.snapshotOnlyThreads} snapshot-only, ${c.partialThreads} partial`,
    'Cloud account coverage / 云端账户覆盖: unknown（未知，不代表 0）', '',
    'Thread\tParent\tOwn tokens\tStatus'];
  if (report.rootThreadId) lines.splice(2, 0, `Main / 主线程: ${amount(report.rootOwnUsage)}; descendants / 后代线程: ${amount(report.descendantsKnownUsage)}`);
  for (const row of report.threads) lines.push(`${row.threadId}\t${row.parentThreadId || '-'}\t${amount(row.ownUsage)}\t${row.status}`);
  lines.push('', ...report.warnings);
  if (report.diagnostics.length) lines.push('', `Diagnostics: ${report.diagnostics.map((d) => `${d.code} (${d.count})`).join(', ')}`);
  return `${lines.join('\n')}\n`;
}

async function main(args = process.argv.slice(2)) {
  if (args.includes('--cloud')) {
    if (args.includes('--live')) throw Object.assign(new Error('Choose a single usage source'), { code: 'CONFLICTING_SOURCE' });
    return require('./codex-cloud-usage').main(args.filter((arg) => arg !== '--cloud'));
  }
  if (args.includes('--live')) {
    return require('./codex-live-usage').main(args.filter((arg) => arg !== '--live'));
  }
  const { values } = parseArgs({ args, options: {
    thread: { type: 'string' }, 'codex-home': { type: 'string' }, events: { type: 'string', multiple: true },
    'no-local': { type: 'boolean' }, json: { type: 'boolean' }, output: { type: 'string' }, help: { type: 'boolean' }
  }, strict: true, allowPositionals: false });
  if (values.help) { process.stdout.write(HELP); return; }
  const report = await collectTaskUsage({ thread: values.thread, codexHome: values['codex-home'],
    noLocal: values['no-local'], events: values.events });
  const text = values.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report);
  if (values.output) fs.writeFileSync(values.output, text, { flag: 'wx', mode: 0o600 });
  else process.stdout.write(text);
}

if (require.main === module) main().catch((error) => {
  // Never include raw transcript lines or file paths from native errors.
  const code = error.code || (error instanceof RangeError ? 'RESOURCE_LIMIT' : 'INVALID_REQUEST');
  process.stderr.write(`Codex usage report failed (${code}). Run with --help.\n`);
  process.exitCode = 1;
});

module.exports = { main, formatReport };
