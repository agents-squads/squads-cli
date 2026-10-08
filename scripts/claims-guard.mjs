#!/usr/bin/env node
/**
 * claims-guard — blocks hype and unbacked claims in public copy.
 *
 * Every public claim should be backed by a check the reader could run. The
 * rules below catch phrases that frame a product as replacing people, promise
 * unattended autonomy, or state performance no measurement backs. The rules
 * live in this file; zero dependencies — copy it into any repo's CI.
 *
 * Usage:
 *   node claims-guard.mjs [--context public|internal] [--root DIR]
 *                         [--baseline FILE] [--write-baseline FILE] [--json] [path ...]
 *     --context public    BLOCK findings fail (exit 1); WARN findings print only.   (default)
 *     --context internal  Everything prints, exit 0.
 *     --root DIR          Repo to scan (default: cwd). Tracked files via `git ls-files`.
 *     --baseline FILE     Known findings (from --write-baseline) don't fail — they drain.
 *                         New findings fail. Lets the gate land before legacy copy is fixed.
 *     path ...            Scan only these files (relative to --root).
 *
 * Allow one verified line with the marker:  claims-guard:allow <reason>
 * Exit codes: 0 clean (or only baselined/warn) · 1 new BLOCK findings · 2 usage error.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, basename } from 'node:path';

// [id, severity, regex, reason]. Regexes are case-insensitive; keep them phrase-level
// to avoid flagging ordinary words (e.g. "autonomous" alone is fine; "autonomous company" is not).
const RULES = [
  // Replacement framing — in every language.
  ['ai-workforce', 'block', /\bAI[- ]workforce\b/i, 'replacement framing'],
  ['ai-employee', 'block', /\bAI[- ](employee|employees|worker|workers|staff)\b/i, 'replacement framing'],
  ['replaces-people', 'block', /\breplac(e|es|ed|ing)\s+(your|the|a|an|their)?\s*(whole\s+)?(team|staff|employees?|developers?|hires?|people|workers?|engineers?|analysts?)\b/i, 'replacement claim'],
  ['instead-of-hiring', 'block', /\b(instead of|without) hiring\b/i, 'headcount framing'],
  ['not-salaries', 'block', /\bnot (the )?salar(y|ies)\b/i, 'headcount maths'],
  ['work-of-n', 'block', /\bdo(es)? the work of \d+/i, 'headcount maths'],
  ['autonomous-company', 'block', /\bautonomous\s+(company|companies|business|businesses|organi[sz]ations?|workforce|teams?)\b/i, 'agents do not own direction'],
  // Unattended-autonomy promises — automation without an outcome owner decays.
  ['set-and-forget', 'block', /\bset[- ](it[- ])?and[- ]forget\b/i, 'unattended automation decays without an owner'],
  ['while-you-sleep', 'block', /\bwhile you sleep\b/i, 'unattended-autonomy promise'],
  ['no-human', 'block', /\bno humans?\s+(needed|required|in the loop)\b/i, 'humans own direction and unchecked work'],
  // Unmeasured performance claims.
  ['nx-claim', 'block', /\b\d{1,4}\s?[x×]\s+(more\s+)?(productiv\w*|faster|output|efficien\w*|developers?|engineers?|throughput)\b/i, 'unmeasured multiplier'],
  ['zero-hallucinations', 'block', /\b(zero|no)\s+hallucinations?\b/i, 'unfalsifiable'],
  // Spanish equivalents.
  ['es-empleado-ia', 'block', /\bempleados?\s+(de\s+)?IA\b/i, 'marco de reemplazo'],
  ['es-fuerza-trabajo', 'block', /\bfuerza\s+(de\s+trabajo|laboral)\s+(de\s+)?IA\b/i, 'marco de reemplazo'],
  ['es-reemplaza', 'block', /\breemplaz\w*\s+(a\s+)?(tu|su|sus|tus|el|los)\s+(equipo|personal|empleados?|trabajadores?|desarrolladores?)\b/i, 'nunca afirmar reemplazo'],
  ['es-sin-contratar', 'block', /\b(en vez de|sin)\s+contratar\b/i, 'marco de dotación'],
  ['es-mientras-duermes', 'block', /\bmientras\s+duerme(s|n)?\b/i, 'promesa de autonomía desatendida'],
  ['es-cero-alucinaciones', 'block', /\b(cero|sin)\s+alucinaciones\b/i, 'no falsable'],
  ['es-sin-humanos', 'block', /\bsin\s+(intervención|supervisión)\s+humana\b/i, 'las personas dirigen'],
  // Soft words — not always wrong, but a claim of innovation needs a check behind it.
  ['innovation-claim', 'warn', /\b(innovat\w*|disrupt\w*|revolutioni[sz]\w*|game[- ]chang\w*|innovador\w*|disruptiv\w*|revolucion\w*)\b/i, 'innovation claims need a verifier (zone 3) or a person (zone 4)'],
  ['learns-claim', 'warn', /\b(learns?|understands?) your business\b|\baprende\w* (de )?tu negocio\b/i, 'memory is not learning'],
  ['self-improving', 'warn', /\bself[- ](improving|evolving|learning)\s+(agents?|AI|systems?|squads?)\b/i, 'research question, not a product claim'],
  ['hype-terms', 'warn', /\b(AGI|superintelligen\w*|swarms?)\b/i, 'hype vocabulary'],
];

const TEXT_EXT = new Set(['.md', '.mdx', '.astro', '.html', '.txt', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.yml', '.yaml', '.template', '.svelte', '.vue']);
const EXCLUDE = [/(^|\/)CHANGELOG/i, /(^|\/)node_modules\//, /(^|\/)dist\//, /package-lock\.json$/, /pnpm-lock\.yaml$/, /yarn\.lock$/, /claims-guard\.(mjs|js|json)$/, /\.claims-guard-baseline\.json$/];

function parseArgs(argv) {
  const o = { context: 'public', root: process.cwd(), baseline: null, writeBaseline: null, json: false, paths: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = () => { if (i + 1 >= argv.length) usage(`${a} needs a value`); return argv[++i]; };
    if (a === '--context') o.context = take();
    else if (a.startsWith('--context=')) o.context = a.split('=')[1];
    else if (a === '--root') o.root = take();
    else if (a === '--baseline') o.baseline = take();
    else if (a === '--write-baseline') o.writeBaseline = take();
    else if (a === '--json') o.json = true;
    else if (a === '-h' || a === '--help') usage();
    else if (a.startsWith('--')) usage(`unknown flag ${a}`);
    else o.paths.push(a);
  }
  if (!['public', 'internal'].includes(o.context)) usage(`--context must be public|internal`);
  return o;
}

function usage(msg) {
  if (msg) console.error(`claims-guard: ${msg}`);
  console.error('usage: claims-guard.mjs [--context public|internal] [--root DIR] [--baseline FILE] [--write-baseline FILE] [--json] [path ...]');
  process.exit(2);
}

function listFiles(root, paths) {
  if (paths.length) return paths;
  try {
    return execFileSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\n').filter(Boolean);
  } catch {
    usage(`${root} is not a git repo — pass explicit paths`);
  }
}

function scan(root, files) {
  const findings = [];
  for (const rel of files) {
    if (EXCLUDE.some((re) => re.test(rel))) continue;
    if (!TEXT_EXT.has(extname(rel).toLowerCase()) && !/^README/i.test(basename(rel))) continue;
    const abs = join(root, rel);
    let text;
    try {
      if (!statSync(abs).isFile() || statSync(abs).size > 2 * 1024 * 1024) continue;
      text = readFileSync(abs, 'utf8');
    } catch { continue; }
    const lines = text.split('\n');
    lines.forEach((line, idx) => {
      if (/claims-guard:allow/i.test(line)) return;
      for (const [id, severity, re, reason] of RULES) {
        const m = line.match(re);
        if (m) findings.push({ id, severity, file: rel, line: idx + 1, match: m[0], reason, text: line.trim().slice(0, 160) });
      }
    });
  }
  return findings;
}

// A baseline entry ignores line numbers so unrelated edits don't resurrect drained findings.
const key = (f) => `${f.id}|${f.file}|${f.match.toLowerCase()}`;

const o = parseArgs(process.argv.slice(2));
const findings = scan(o.root, listFiles(o.root, o.paths));

if (o.writeBaseline) {
  const keys = [...new Set(findings.filter((f) => f.severity === 'block').map(key))].sort();
  writeFileSync(o.writeBaseline, JSON.stringify({ note: 'claims-guard baseline — pre-existing BLOCK findings that drain; never add to it by hand', keys }, null, 2) + '\n');
  console.log(`claims-guard: wrote ${keys.length} baseline keys to ${o.writeBaseline}`);
  process.exit(0);
}

const baseline = new Set(o.baseline && existsSync(o.baseline) ? JSON.parse(readFileSync(o.baseline, 'utf8')).keys : []);
for (const f of findings) f.baselined = f.severity === 'block' && baseline.has(key(f));
const blocking = findings.filter((f) => f.severity === 'block' && !f.baselined);

if (o.json) {
  console.log(JSON.stringify({ context: o.context, blocking: blocking.length, findings }, null, 2));
} else {
  const order = { block: 0, warn: 1 };
  for (const f of [...findings].sort((a, b) => order[a.severity] - order[b.severity] || a.file.localeCompare(b.file) || a.line - b.line)) {
    const tag = f.severity === 'block' ? (f.baselined ? 'BASELINE' : 'BLOCK') : 'WARN';
    console.log(`${tag.padEnd(8)} ${f.file}:${f.line}  "${f.match}" — ${f.reason}`);
  }
  const counts = findings.reduce((c, f) => ((c[f.baselined ? 'baseline' : f.severity]++), c), { block: 0, baseline: 0, warn: 0 });
  console.log(`claims-guard: ${counts.block} block · ${counts.baseline} baselined (draining) · ${counts.warn} warn`);
}

process.exit(o.context === 'public' && blocking.length > 0 ? 1 : 0);
