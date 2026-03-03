#!/usr/bin/env node
/**
 * perf-budget-check — Performance budgets for your CI pipeline
 * Zero external dependencies. Pure Node.js ES modules.
 */

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── ANSI Colors ─────────────────────────────────────────────────────────────
const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  magenta: '\x1b[35m',
  cyan:    '\x1b[36m',
  white:   '\x1b[37m',
  bgRed:   '\x1b[41m',
  bgGreen: '\x1b[42m',
};

const noColor = process.env.NO_COLOR || process.env.CI_NO_COLOR;
const clr = (code, str) => noColor ? str : `${code}${str}${C.reset}`;

// ─── Size Utilities ───────────────────────────────────────────────────────────
const UNITS = [
  ['GB', 1024 ** 3],
  ['MB', 1024 ** 2],
  ['KB', 1024],
  ['B',  1],
];

function parseSize(str) {
  if (typeof str === 'number') return str;
  const match = String(str).trim().match(/^(\d+(?:\.\d+)?)\s*(GB|MB|KB|B)?$/i);
  if (!match) throw new Error(`Invalid size: "${str}"`);
  const num = parseFloat(match[1]);
  const unit = (match[2] || 'B').toUpperCase();
  const multiplier = UNITS.find(([u]) => u === unit)?.[1] ?? 1;
  return Math.round(num * multiplier);
}

function formatSize(bytes) {
  for (const [unit, mult] of UNITS) {
    if (bytes >= mult) return `${(bytes / mult).toFixed(2)}${unit}`;
  }
  return `${bytes}B`;
}

function gzipSize(filePath) {
  const content = fs.readFileSync(filePath);
  const compressed = zlib.gzipSync(content, { level: 9 });
  return compressed.length;
}

// ─── Glob Matching ────────────────────────────────────────────────────────────
function globToRegex(pattern) {
  // Converts *.js / main.*.js / **/*.js patterns to RegExp
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // escape regex special chars (except * and ?)
    .replace(/\\\./g, '\\.')                 // dots already escaped above
    .replace(/\*\*/g, '<<GLOBSTAR>>')        // save **
    .replace(/\*/g, '[^/]*')                 // * → match anything except /
    .replace(/\?/g, '[^/]')                  // ? → single char except /
    .replace(/<<GLOBSTAR>>/g, '.*');         // ** → match across dirs
  return new RegExp(`^${escaped}$`);
}

function matchGlob(filename, pattern) {
  // Match against basename first, then full relative path
  const re = globToRegex(pattern);
  return re.test(filename) || re.test(path.basename(filename));
}

// ─── File Discovery ───────────────────────────────────────────────────────────
const SCANNABLE_EXTS = new Set(['.js', '.mjs', '.cjs', '.css', '.html', '.htm', '.wasm']);

function scanDir(dir, baseDir = dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip node_modules and hidden dirs
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      results.push(...scanDir(fullPath, baseDir));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (SCANNABLE_EXTS.has(ext)) {
        results.push({
          fullPath,
          relativePath: path.relative(baseDir, fullPath),
          name: entry.name,
        });
      }
    }
  }
  return results;
}

// ─── Config Handling ──────────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  budgets: [
    { pattern: '*.js',      maxSize: '200KB', maxGzip: '70KB'  },
    { pattern: 'main.*.js', maxSize: '150KB', maxGzip: '50KB'  },
    { pattern: '*.css',     maxSize: '50KB',  maxGzip: '20KB'  },
    { pattern: '*.html',    maxSize: '20KB'                     },
    { pattern: '*.wasm',    maxSize: '500KB'                    },
  ],
  history: {
    enabled: true,
    file: '.perf-history.json',
    keep: 30,
  },
};

function loadConfig(configPath = '.perfbudget.json') {
  const resolved = path.resolve(configPath);
  if (fs.existsSync(resolved)) {
    try {
      return JSON.parse(fs.readFileSync(resolved, 'utf8'));
    } catch (e) {
      fatal(`Invalid JSON in ${configPath}: ${e.message}`);
    }
  }
  return DEFAULT_CONFIG;
}

// ─── Budget Checking ──────────────────────────────────────────────────────────
function findBudget(filename, budgets) {
  // Last matching budget wins (more specific patterns override broader ones)
  let match = null;
  for (const budget of budgets) {
    if (matchGlob(filename, budget.pattern)) match = budget;
  }
  return match;
}

function checkFile(fileInfo, budgets, threshold = 0) {
  const { fullPath, relativePath, name } = fileInfo;
  const stat = fs.statSync(fullPath);
  const rawSize = stat.size;
  const budget = findBudget(name, budgets);

  if (!budget) return null; // No budget for this file — skip

  const maxSize  = budget.maxSize  ? parseSize(budget.maxSize)  : null;
  const maxGzip  = budget.maxGzip  ? parseSize(budget.maxGzip)  : null;

  const gz = (maxGzip !== null) ? gzipSize(fullPath) : null;

  const rawFails  = maxSize !== null && rawSize > maxSize;
  const gzipFails = maxGzip !== null && gz > maxGzip;
  const fails = rawFails || gzipFails;

  const rawWarn  = !rawFails  && maxSize !== null && threshold > 0 &&
                   rawSize > maxSize * (1 - threshold / 100);
  const gzipWarn = !gzipFails && maxGzip !== null && threshold > 0 &&
                   gz !== null && gz > maxGzip * (1 - threshold / 100);
  const warns = rawWarn || gzipWarn;

  return {
    file: relativePath,
    name,
    rawSize,
    gzSize: gz,
    maxSize,
    maxGzip,
    rawFails,
    gzipFails,
    rawWarn,
    gzipWarn,
    fails,
    warns,
    budget,
  };
}

// ─── Output Formatters ────────────────────────────────────────────────────────
function pad(str, len, right = false) {
  const plain = str.replace(/\x1b\[[0-9;]*m/g, ''); // strip ANSI for length calc
  const spaces = Math.max(0, len - plain.length);
  return right ? ' '.repeat(spaces) + str : str + ' '.repeat(spaces);
}

function renderTable(results, quiet) {
  const cols = {
    file:    Math.max(4, ...results.map(r => r.file.length)),
    raw:     10,
    budget:  10,
    gzip:    10,
    gbudget: 10,
    status:  8,
  };

  const border = {
    tl: '╔', tr: '╗', bl: '╚', br: '╝',
    h: '═', v: '║', lm: '╠', rm: '╣', tm: '╦', bm: '╩', x: '╬',
  };

  const row = (...cells) => border.v + cells.join(border.v) + border.v;
  const hline = (l, m, r) =>
    l + [cols.file + 2, cols.raw + 2, cols.budget + 2, cols.gzip + 2, cols.gbudget + 2, cols.status + 2]
      .map(w => border.h.repeat(w)).join(m) + r;

  const header = row(
    pad(clr(C.bold, ' File'),    cols.file + 1),
    pad(clr(C.bold, ' Raw'),     cols.raw  + 1),
    pad(clr(C.bold, ' Budget'),  cols.budget + 1),
    pad(clr(C.bold, ' Gzip'),    cols.gzip + 1),
    pad(clr(C.bold, ' GBudget'), cols.gbudget + 1),
    pad(clr(C.bold, ' Status'),  cols.status + 1),
  );

  const lines = [
    hline(border.tl, border.tm, border.tr),
    header,
    hline(border.lm, border.x, border.rm),
  ];

  let shown = 0;
  for (const r of results) {
    if (quiet && !r.fails && !r.warns) continue;

    const statusStr = r.fails
      ? clr(C.red,    ' ❌ FAIL')
      : r.warns
        ? clr(C.yellow, ' ⚠️ WARN')
        : clr(C.green,  ' ✅ PASS');

    const rawStr  = formatSize(r.rawSize);
    const maxStr  = r.maxSize !== null ? formatSize(r.maxSize) : '  —   ';
    const gzStr   = r.gzSize  !== null ? formatSize(r.gzSize)  : '  —   ';
    const mgzStr  = r.maxGzip !== null ? formatSize(r.maxGzip) : '  —   ';

    const rawColored  = r.rawFails  ? clr(C.red, rawStr) : r.rawWarn  ? clr(C.yellow, rawStr) : rawStr;
    const gzColored   = r.gzipFails ? clr(C.red, gzStr)  : r.gzipWarn ? clr(C.yellow, gzStr)  : gzStr;

    lines.push(row(
      pad(` ${r.file}`,  cols.file + 1),
      pad(` ${rawColored}`, cols.raw + 1, true),
      pad(` ${maxStr}`,  cols.budget  + 1, true),
      pad(` ${gzColored}`, cols.gzip + 1, true),
      pad(` ${mgzStr}`,  cols.gbudget + 1, true),
      pad(statusStr,     cols.status  + 1),
    ));
    shown++;
  }

  if (shown === 0 && quiet) {
    console.log(clr(C.green + C.bold, '✅ All budgets passed.'));
    return;
  }

  lines.push(hline(border.bl, border.bm, border.br));
  console.log(lines.join('\n'));
}

function renderJSON(results, summary) {
  console.log(JSON.stringify({ summary, results }, null, 2));
}

function renderGitHub(results, summary) {
  // GitHub Actions annotation format
  for (const r of results) {
    if (r.fails) {
      const msg = [
        r.rawFails  ? `raw ${formatSize(r.rawSize)} > budget ${formatSize(r.maxSize)}` : '',
        r.gzipFails ? `gzip ${formatSize(r.gzSize)} > budget ${formatSize(r.maxGzip)}` : '',
      ].filter(Boolean).join(', ');
      console.log(`::error file=${r.file}::Budget exceeded — ${msg}`);
    } else if (r.warns) {
      const msg = [
        r.rawWarn  ? `raw ${formatSize(r.rawSize)} near budget ${formatSize(r.maxSize)}` : '',
        r.gzipWarn ? `gzip ${formatSize(r.gzSize)} near budget ${formatSize(r.maxGzip)}` : '',
      ].filter(Boolean).join(', ');
      console.log(`::warning file=${r.file}::Near budget — ${msg}`);
    }
  }
  if (summary.failed === 0) {
    console.log(`::notice::perf-budget-check: All ${summary.checked} budgets passed ✅`);
  } else {
    console.log(`::error::perf-budget-check: ${summary.failed} budget(s) exceeded ❌`);
  }
}

// ─── History ──────────────────────────────────────────────────────────────────
function loadHistory(histFile) {
  const resolved = path.resolve(histFile);
  if (fs.existsSync(resolved)) {
    try { return JSON.parse(fs.readFileSync(resolved, 'utf8')); } catch {}
  }
  return [];
}

function saveHistory(histFile, history, keep) {
  const resolved = path.resolve(histFile);
  const trimmed = history.slice(-keep);
  fs.writeFileSync(resolved, JSON.stringify(trimmed, null, 2));
}

function buildHistoryEntry(results, dir) {
  const ts = new Date().toISOString();
  let commitHash = null;
  try {
    commitHash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {}

  return {
    timestamp: ts,
    commit: commitHash,
    dir,
    files: results.map(r => ({
      file: r.file,
      rawSize: r.rawSize,
      gzSize: r.gzSize,
      fails: r.fails,
    })),
    totals: {
      totalRaw:  results.reduce((s, r) => s + r.rawSize, 0),
      totalGzip: results.filter(r => r.gzSize !== null).reduce((s, r) => s + r.gzSize, 0),
      failed:    results.filter(r => r.fails).length,
      checked:   results.length,
    },
  };
}

// ─── Commands ─────────────────────────────────────────────────────────────────

/** perf-budget-check init */
function cmdInit(args) {
  const configPath = args['--config'] || '.perfbudget.json';
  if (fs.existsSync(configPath)) {
    console.log(clr(C.yellow, `Config already exists: ${configPath}`));
    console.log('Delete it first or edit manually.');
    process.exit(1);
  }
  fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
  console.log(clr(C.green, `✅ Created ${configPath}`));
  console.log(clr(C.dim,   'Edit the budgets to match your project requirements.'));
}

/** perf-budget-check check [dir] */
function cmdCheck(positional, args) {
  const dir       = positional[0] || 'dist';
  const config    = loadConfig(args['--config'] || '.perfbudget.json');
  const threshold = parseInt(args['--threshold'] || '10', 10);
  const quiet     = args['--quiet'] || args['-q'] || false;
  const format    = args['--format'] || 'table';

  if (!fs.existsSync(dir)) {
    fatal(`Directory not found: ${dir}`);
  }

  if (!quiet && format === 'table') {
    console.log(clr(C.cyan + C.bold, `\n  perf-budget-check  `) + clr(C.dim, `scanning ${dir}...\n`));
  }

  const files = scanDir(dir);
  if (files.length === 0) {
    console.log(clr(C.yellow, `No scannable files found in ${dir}`));
    process.exit(0);
  }

  const results = files
    .map(f => checkFile(f, config.budgets, threshold))
    .filter(Boolean);

  if (results.length === 0) {
    console.log(clr(C.yellow, 'No files matched any budget rule.'));
    console.log(clr(C.dim,    'Run `perf-budget-check init` to create a config, or check your patterns.'));
    process.exit(0);
  }

  const summary = {
    dir,
    checked: results.length,
    passed:  results.filter(r => !r.fails && !r.warns).length,
    warned:  results.filter(r => r.warns).length,
    failed:  results.filter(r => r.fails).length,
    totalRaw:  results.reduce((s, r) => s + r.rawSize, 0),
    totalGzip: results.filter(r => r.gzSize !== null).reduce((s, r) => s + r.gzSize, 0),
  };

  if (format === 'json') {
    renderJSON(results, summary);
  } else if (format === 'github') {
    renderGitHub(results, summary);
  } else {
    renderTable(results, quiet);

    if (!quiet) {
      const totalLine = [
        `  Checked: ${clr(C.bold, String(summary.checked))}`,
        clr(C.green,  `Passed: ${summary.passed}`),
        summary.warned > 0 ? clr(C.yellow, `Warned: ${summary.warned}`) : null,
        summary.failed > 0 ? clr(C.red,    `Failed: ${summary.failed}`) : null,
      ].filter(Boolean).join('  │  ');
      console.log('\n' + totalLine);

      const sizeReport = `  Total raw: ${clr(C.bold, formatSize(summary.totalRaw))}` +
        (summary.totalGzip > 0 ? `  │  Total gzip: ${clr(C.bold, formatSize(summary.totalGzip))}` : '');
      console.log(sizeReport + '\n');
    }
  }

  // History tracking
  if (config.history?.enabled !== false) {
    const histFile = config.history?.file || '.perf-history.json';
    const keep     = config.history?.keep || 30;
    const history  = loadHistory(histFile);
    history.push(buildHistoryEntry(results, dir));
    saveHistory(histFile, history, keep);
  }

  if (summary.failed > 0) process.exit(1);
}

/** perf-budget-check history */
function cmdHistory(args) {
  const config  = loadConfig(args['--config'] || '.perfbudget.json');
  const histFile = config.history?.file || '.perf-history.json';
  const n = parseInt(args['--last'] || '10', 10);

  const history = loadHistory(histFile);
  if (history.length === 0) {
    console.log(clr(C.yellow, 'No history yet. Run `perf-budget-check check` first.'));
    return;
  }

  const recent = history.slice(-n);
  console.log(clr(C.cyan + C.bold, '\n  Build Size History\n'));

  const border = { h: '─', v: '│', tl: '┌', tr: '┐', bl: '└', br: '┘', lm: '├', rm: '┤', x: '┼', tm: '┬', bm: '┴' };
  const widths = [24, 8, 10, 10, 8];
  const hline = (l, m, r) => l + widths.map(w => border.h.repeat(w + 2)).join(m) + r;

  const row = (...cells) => border.v + cells.map((c, i) => ` ${pad(c, widths[i])} `).join(border.v) + border.v;

  console.log(hline(border.tl, border.tm, border.tr));
  console.log(row(
    clr(C.bold, 'Timestamp'), clr(C.bold, 'Commit'),
    clr(C.bold, 'Total Raw'), clr(C.bold, 'Total Gz'), clr(C.bold, 'Status'),
  ));
  console.log(hline(border.lm, border.x, border.rm));

  for (const entry of recent) {
    const ts     = entry.timestamp.replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
    const commit = entry.commit ?? 'unknown';
    const raw    = formatSize(entry.totals.totalRaw);
    const gz     = entry.totals.totalGzip > 0 ? formatSize(entry.totals.totalGzip) : '—';
    const status = entry.totals.failed > 0
      ? clr(C.red,    `${entry.totals.failed} FAIL`)
      : clr(C.green,  'PASS');
    console.log(row(ts, commit, raw, gz, status));
  }
  console.log(hline(border.bl, border.bm, border.br));
  console.log();
}

/** perf-budget-check compare <baseline> <current> */
function cmdCompare(positional, args) {
  const baseDir = positional[0];
  const currDir = positional[1];

  if (!baseDir || !currDir) {
    fatal('Usage: perf-budget-check compare <baseline-dir> <current-dir>');
  }
  if (!fs.existsSync(baseDir)) fatal(`Baseline dir not found: ${baseDir}`);
  if (!fs.existsSync(currDir)) fatal(`Current dir not found: ${currDir}`);

  const config = loadConfig(args['--config'] || '.perfbudget.json');

  const baseFiles = scanDir(baseDir);
  const currFiles = scanDir(currDir);

  const baseMap = new Map(baseFiles.map(f => [f.name, f]));
  const currMap = new Map(currFiles.map(f => [f.name, f]));

  const allNames = new Set([...baseMap.keys(), ...currMap.keys()]);
  const rows = [];

  for (const name of allNames) {
    const ext = path.extname(name).toLowerCase();
    if (!SCANNABLE_EXTS.has(ext)) continue;

    const b = baseMap.get(name);
    const c = currMap.get(name);

    const baseSize = b ? fs.statSync(b.fullPath).size : null;
    const currSize = c ? fs.statSync(c.fullPath).size : null;
    const delta    = baseSize !== null && currSize !== null ? currSize - baseSize : null;
    const pct      = delta !== null && baseSize > 0 ? ((delta / baseSize) * 100).toFixed(1) : null;

    rows.push({ name, baseSize, currSize, delta, pct });
  }

  console.log(clr(C.cyan + C.bold, `\n  Compare: ${baseDir}  →  ${currDir}\n`));

  const widths = [30, 12, 12, 12, 8];
  const border = { h: '─', v: '│', tl: '┌', tr: '┐', bl: '└', br: '┘', lm: '├', rm: '┤', x: '┼', tm: '┬', bm: '┴' };
  const hline  = (l, m, r) => l + widths.map(w => border.h.repeat(w + 2)).join(m) + r;
  const row    = (...cells) => border.v + cells.map((c, i) => ` ${pad(c, widths[i])} `).join(border.v) + border.v;

  console.log(hline(border.tl, border.tm, border.tr));
  console.log(row(
    clr(C.bold, 'File'), clr(C.bold, 'Baseline'),
    clr(C.bold, 'Current'), clr(C.bold, 'Delta'), clr(C.bold, 'Change'),
  ));
  console.log(hline(border.lm, border.x, border.rm));

  for (const r of rows) {
    const b = r.baseSize !== null ? formatSize(r.baseSize) : clr(C.dim, 'new');
    const c = r.currSize !== null ? formatSize(r.currSize) : clr(C.dim, 'del');
    let d = '—', p = '—';
    if (r.delta !== null) {
      const sign = r.delta >= 0 ? '+' : '';
      d = (r.delta >= 0 ? clr(C.red, sign + formatSize(Math.abs(r.delta))) : clr(C.green, sign + formatSize(Math.abs(r.delta))));
      p = r.pct ? (r.delta >= 0 ? clr(C.red, `${r.pct}%`) : clr(C.green, `${r.pct}%`)) : '—';
    }
    console.log(row(r.name, b, c, d, p));
  }
  console.log(hline(border.bl, border.bm, border.br));
  console.log();
}

/** perf-budget-check report */
function cmdReport(args) {
  const dir     = args['--dir'] || 'dist';
  const format  = args['--format'] || 'table';
  const config  = loadConfig(args['--config'] || '.perfbudget.json');
  const threshold = parseInt(args['--threshold'] || '10', 10);

  if (!fs.existsSync(dir)) {
    fatal(`Directory not found: ${dir}`);
  }

  const files = scanDir(dir);
  const results = files.map(f => checkFile(f, config.budgets, threshold)).filter(Boolean);
  const summary = {
    dir,
    checked: results.length,
    passed:  results.filter(r => !r.fails && !r.warns).length,
    warned:  results.filter(r => r.warns).length,
    failed:  results.filter(r => r.fails).length,
    totalRaw:  results.reduce((s, r) => s + r.rawSize, 0),
    totalGzip: results.filter(r => r.gzSize !== null).reduce((s, r) => s + r.gzSize, 0),
  };

  if (format === 'json') {
    renderJSON(results, summary);
  } else if (format === 'github') {
    renderGitHub(results, summary);
  } else {
    renderTable(results, false);
  }
}

// ─── Help ─────────────────────────────────────────────────────────────────────
function showHelp() {
  console.log(`
${clr(C.cyan + C.bold, '  perf-budget-check')}  ${clr(C.dim, 'v1.0.0')}
  ${clr(C.dim, 'Performance budgets for your CI pipeline')}

${clr(C.bold, 'USAGE')}
  perf-budget-check <command> [options]

${clr(C.bold, 'COMMANDS')}
  ${clr(C.green, 'init')}                     Create .perfbudget.json with defaults
  ${clr(C.green, 'check')} [dir]              Check files against budgets (default: dist)
  ${clr(C.green, 'history')}                  Show size trend over last N builds
  ${clr(C.green, 'compare')} <base> <curr>    Compare two build directories
  ${clr(C.green, 'report')}                   Generate a report in various formats

${clr(C.bold, 'OPTIONS')}
  --config <file>          Config file path (default: .perfbudget.json)
  --format table|json|github  Output format (default: table)
  --threshold <pct>        Warn when within N% of budget (default: 10)
  --quiet, -q              Only show failures (CI mode)
  --last <n>               History: show last N entries (default: 10)
  --dir <dir>              Report: directory to scan

${clr(C.bold, 'EXAMPLES')}
  perf-budget-check init
  perf-budget-check check dist
  perf-budget-check check build --quiet
  perf-budget-check check --format github
  perf-budget-check history --last 5
  perf-budget-check compare dist-old dist-new
  perf-budget-check report --format json --dir public

${clr(C.bold, 'CI INTEGRATION')}
  Exit code 0 = all budgets passed
  Exit code 1 = one or more budgets exceeded
`);
}

// ─── Arg Parser ───────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {};
  const positional = [];
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
        args[a] = next;
        i += 2;
      } else {
        args[a] = true;
        i++;
      }
    } else if (a.startsWith('-') && a.length === 2) {
      args[a] = true;
      i++;
    } else {
      positional.push(a);
      i++;
    }
  }
  return { args, positional };
}

// ─── Error Helper ─────────────────────────────────────────────────────────────
function fatal(msg) {
  console.error(clr(C.red + C.bold, `\n  Error: `) + msg + '\n');
  process.exit(1);
}

// ─── Entry Point ──────────────────────────────────────────────────────────────
const argv    = process.argv.slice(2);
const command = argv[0];
const rest    = argv.slice(1);
const { args, positional } = parseArgs(rest);

if (!command || command === '--help' || command === '-h' || command === 'help') {
  showHelp();
} else if (command === '--version' || command === '-v' || command === 'version') {
  console.log('1.0.0');
} else if (command === 'init') {
  cmdInit(args);
} else if (command === 'check') {
  cmdCheck(positional, args);
} else if (command === 'history') {
  cmdHistory(args);
} else if (command === 'compare') {
  cmdCompare(positional, args);
} else if (command === 'report') {
  cmdReport(args);
} else {
  console.error(clr(C.red, `Unknown command: ${command}`));
  showHelp();
  process.exit(1);
}
