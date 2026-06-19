<div align="center">

# perf-budget-check

**Fail CI when JavaScript bundles exceed your size budgets — before slow pages ship.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?labelColor=0B0A09)](LICENSE)
[![dependencies: zero](https://img.shields.io/badge/dependencies-zero-blue?labelColor=0B0A09)](package.json)
[![node: >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen?labelColor=0B0A09)](https://nodejs.org)

</div>

## Install

```bash
npx github:NickCirv/perf-budget-check init
npx github:NickCirv/perf-budget-check check dist
```

## Usage

```bash
# Scaffold a config file
npx github:NickCirv/perf-budget-check init

# Check build output against budgets (exits 1 on failure)
npx github:NickCirv/perf-budget-check check dist

# CI-quiet mode — only print failures
npx github:NickCirv/perf-budget-check check dist --quiet

# GitHub Actions annotations format
npx github:NickCirv/perf-budget-check check dist --format github

# Compare two build directories for size regressions
npx github:NickCirv/perf-budget-check compare dist-main dist-feature

# Show build size trend
npx github:NickCirv/perf-budget-check history --last 10
```

| Flag | Default | Description |
|------|---------|-------------|
| `--config <file>` | `.perfbudget.json` | Path to config file |
| `--format table\|json\|github` | `table` | Output format |
| `--threshold <pct>` | `10` | Warn when within N% of budget |
| `--quiet`, `-q` | — | Only show failures (CI mode) |
| `--dir <dir>` | `dist` | Directory to scan for `report` |
| `--last <n>` | `10` | History entries to display |

## What it does

`perf-budget-check` scans a build output directory, matches files against glob patterns defined in `.perfbudget.json`, and compares raw and gzip sizes against your declared budgets. It exits with code 1 if any budget is exceeded, making it a drop-in CI gate for Webpack, Vite, Rollup, Parcel, or any tool that writes output files. Gzip estimates use Node's built-in `zlib.gzipSync` at maximum compression — no approximations. Build sizes are recorded to `.perf-history.json` after each `check` run, and the `history` and `compare` commands let you track regressions over time without any external service.

---
<sub>Zero dependencies · Node >=18 · MIT · by <a href="https://github.com/NickCirv">NickCirv</a></sub>
