# Testing and coverage

Run `npm run verify` for lint and the Node test suite. Run `npm run test:coverage` to execute the same suite with JavaScript coverage. Both commands require the project's supported Node version and installed development dependencies.

## Coverage reports

Coverage uses [c8](https://github.com/bcoe/c8) as a development dependency around the existing `node:test` runner. Node 22 and 24's built-in test coverage reports only loaded files; c8's `all` option also includes source files that the tests never load, at zero coverage. This keeps untested entry points in the denominator without a custom coverage collector or a test-framework migration.

The scope in `.c8rc.json` includes JavaScript under `src/` (Electron main and renderer, agent, Hub and shared modules) and the Worker's own code under `worker/src/`. Generated `worker/src/shared/` copies are excluded because their authoritative implementations are counted under `src/shared/`. Tests, fixtures, build scripts, the website, dependencies and native Swift/C# code are outside this report's scope.

The command prints a per-file table and writes these ignored files under `coverage/`:

- `index.html`: browsable source with uncovered lines and branches.
- `lcov.info`: LCOV data for compatible coverage tools.
- `coverage-summary.json`: totals and per-file percentages.
- `coverage-final.json`: detailed Istanbul coverage data.

CI collects coverage in the existing Linux/Node 24 test run and uploads the reports as the `javascript-coverage` artifact, including when tests fail. Other platform, Node-version and timezone runs continue to exercise the suite without coverage. Reports currently have no percentage threshold; test failures still fail CI. Establish a stable baseline before choosing thresholds.

## Interpreting the results

Coverage records executed code, not whether assertions are sufficient or the packaged application works. Node fixtures and mocks do not establish native Electron, browser or OS integration coverage. Cross-platform code can remain uncovered on the reporting platform even when another CI job tests it.

Some existing tests assert against source text or execute extracted/reconstructed snippets in a VM. Text assertions do not execute that source, and snippets without an accurate source map cannot reliably contribute coverage to the original file. Those originals stay in the report, possibly at zero. Do not assign a snippet the original filename alone: its offsets may refer to different source lines. Prefer loading the complete module; when extraction is necessary, preserve an accurate source map before crediting execution to the original. Treat these entries as attribution gaps to investigate alongside missing tests, rather than excluding them to improve the percentage.
