// mend: one patch tool for every AI edit format.
//
// mend reads a patch in one of four formats (a unified diff, SEARCH/REPLACE
// blocks, a V4A patch, or JSON edits), applies its edits to the tree of
// text files rooted at the working directory, and writes every change or
// none at all. The contract is SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, matching at three tiers of
// whitespace forgiveness, and the four readers. Node 22, standard library
// only, run as `node main.ts [options] [PATCH]`; PATCH is a patch file, or
// standard input when absent or `-`.
//
// When MAKEFUN_ENV_URL is set, this file hands the process over to
// runner.ts, which runs the trial checks from that env; see runner.ts.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file broken into its lines, its line break, and whether it ends with one. */
interface FileState {
  br: string;
  lines: string[];
  finalBr: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], finalBr: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBr = text.endsWith(br);
  if (finalBr) parts.pop();
  return { br, lines: parts, finalBr };
}

function serializeFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBr ? f.br : '');
}

function leadingWs(line: string): string {
  const m = /^[ \t]*/.exec(line);
  return m === null ? '' : m[0];
}

/** A line as tier `t` sees it: exact, trailing whitespace off, both ends off. */
function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position at or after `from` where `old` occurs at `tier`. */
function occurrences(lines: string[], old: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (old.length === 0) return out;
  const want = old.map((l) => normLine(l, tier));
  for (let i = from; i + old.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < old.length; j += 1) {
      if (normLine(lines[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which `old` occurs at or after `from`, with its positions. */
function findTier(lines: string[], old: string[], strict: boolean, from: number): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, old, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** Like findTier, but only end-of-file occurrences count when `eof` is set. */
function findTierEof(lines: string[], old: string[], strict: boolean, from: number, eof: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    let occ = occurrences(lines, old, t, from);
    if (eof) occ = occ.filter((i) => i + old.length === lines.length);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The first line at or after `from` equal to a single-line anchor, or -1. */
function findSingle(lines: string[], anchor: string, strict: boolean, from: number): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const want = normLine(anchor, t);
    for (let i = from; i < lines.length; i += 1) {
      if (normLine(lines[i]!, t) === want) return i;
    }
  }
  return -1;
}

/** Re-indent one new line at tier 2: the patch's leading whitespace P becomes the file's F. */
function reindent(line: string, p: string, f: string): string {
  if (line === '' || /^[ \t]+$/.test(line)) return line;
  if (!line.startsWith(p)) return line;
  return f + line.slice(p.length);
}

/** One line of the replacement: a context line names its index in O, a fresh line -1. */
interface NLine {
  text: string;
  ctx: number;
}

/** Replace O at `pos` by N, writing context lines as the file's own lines. */
function applyReplace(file: FileState, pos: number, o: string[], n: NLine[], tier: number): void {
  const p = o.length > 0 ? leadingWs(o[0]!) : '';
  const f = o.length > 0 ? leadingWs(file.lines[pos]!) : '';
  const built = n.map((e) => {
    if (e.ctx >= 0) return file.lines[pos + e.ctx]!;
    if (tier === 2) return reindent(e.text, p, f);
    return e.text;
  });
  file.lines.splice(pos, o.length, ...built);
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted). */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { from: string; to: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const file = parseFile(before);
      if (line < 0 || line > file.lines.length) throw new Fail('no-match', p);
      file.lines.splice(line, 0, ...add);
      tree.now.set(p, serializeFile(file));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** One line of a unified hunk or V4A chunk body. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
  empty: boolean;
}

/** Split body lines into the old lines O and the new lines N. */
function bodyParts(body: BodyLine[]): { o: string[]; n: NLine[]; noEol: boolean; lastPlusNoEol: boolean; hasPlus: boolean } {
  const o: string[] = [];
  const n: NLine[] = [];
  let hasPlus = false;
  for (const e of body) {
    if (e.kind === 'ctx') {
      o.push(e.text);
      n.push({ text: e.text, ctx: o.length - 1 });
    } else if (e.kind === 'old') o.push(e.text);
    else if (e.kind === 'new') {
      hasPlus = true;
      n.push({ text: e.text, ctx: -1 });
    }
  }
  let noEol = false;
  let lastPlusNoEol = false;
  for (let k = body.length - 1; k >= 0; k -= 1) {
    if (body[k]!.kind === 'ctx' || body[k]!.kind === 'new') {
      noEol = body[k + 1] !== undefined && body[k + 1]!.kind === 'bs';
      break;
    }
  }
  for (let k = body.length - 1; k >= 0; k -= 1) {
    if (body[k]!.kind === 'new') {
      lastPlusNoEol = body[k + 1] !== undefined && body[k + 1]!.kind === 'bs';
      break;
    }
  }
  return { o, n, noEol, lastPlusNoEol, hasPlus };
}

/** One unified hunk: the old start line A and the old and new lines. */
interface Hunk {
  a: number;
  o: string[];
  n: NLine[];
  noEol: boolean;
  lastPlusNoEol: boolean;
  hasPlus: boolean;
}

/** A unified section's header: its paths and its creation/deletion flags. */
interface USection {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  remove: boolean;
  hunks: Hunk[];
}

interface UBuilder {
  sec: USection;
  hasPair: boolean;
  hasHunk: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  gitOld: string | null;
  gitNew: string | null;
}

/** The path a `--- ` or `+++ ` line names: up to the first tab, spaces off, a/b/ off. */
function headerPath(line: string): string | null {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  const p = (tab >= 0 ? rest.slice(0, tab) : rest).trim();
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2) === '/dev/null' ? null : p.slice(2);
  return p === '/dev/null' ? null : p;
}

/** Read one hunk body starting at `start`; trailing empty lines are not part of it. */
function parseHunkBody(lines: string[], start: number, a: number): { hunk: Hunk; next: number } {
  const body: BodyLine[] = [];
  let j = start;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      body.push({ kind: 'ctx', text: '', empty: true });
      j += 1;
      continue;
    }
    const c = l[0]!;
    if (c === ' ') {
      body.push({ kind: 'ctx', text: l.slice(1), empty: false });
      j += 1;
      continue;
    }
    if (c === '-') {
      body.push({ kind: 'old', text: l.slice(1), empty: false });
      j += 1;
      continue;
    }
    if (c === '+') {
      body.push({ kind: 'new', text: l.slice(1), empty: false });
      j += 1;
      continue;
    }
    if (c === '\\') {
      body.push({ kind: 'bs', text: l.slice(1), empty: false });
      j += 1;
      continue;
    }
    break;
  }
  while (body.length > 0) {
    const last = body[body.length - 1]!;
    if (last.kind === 'ctx' && last.empty) body.pop();
    else break;
  }
  const parts = bodyParts(body);
  return { hunk: { a, o: parts.o, n: parts.n, noEol: parts.noEol, lastPlusNoEol: parts.lastPlusNoEol, hasPlus: parts.hasPlus }, next: j };
}

/** Apply one hunk of a section, `d` hunks' worth of drift already applied. */
function applyUnifiedHunk(file: FileState, h: Hunk, d: number, strict: boolean, path: string): void {
  if (h.o.length > 0) {
    const found = findTier(file.lines, h.o, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    let bestDist = Math.abs(best - target);
    for (let k = 1; k < found.occ.length; k += 1) {
      const pos = found.occ[k]!;
      const dist = Math.abs(pos - target);
      if (dist < bestDist) {
        best = pos;
        bestDist = dist;
      }
    }
    const touchesEnd = best + h.o.length === file.lines.length;
    applyReplace(file, best, h.o, h.n, found.tier);
    if (touchesEnd) file.finalBr = !h.noEol;
  } else {
    const at = Math.min(Math.max(h.a + d, 0), file.lines.length);
    const touchesEnd = at === file.lines.length;
    file.lines.splice(at, 0, ...h.n.map((e) => e.text));
    if (touchesEnd) file.finalBr = !h.noEol;
  }
}

/** Turn a finished unified section into its one edit. */
function unifiedEdit(b: UBuilder, strict: boolean): Edit {
  let oldP: string | null;
  let newP: string | null;
  if (b.hasPair) {
    oldP = b.sec.oldPath;
    newP = b.sec.newPath;
  } else {
    oldP = b.renameFrom ?? b.gitOld;
    newP = b.renameTo ?? b.gitNew;
  }
  const sec = b.sec;
  if (oldP === null || sec.create) {
    const p = newP ?? '';
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let noEol = false;
      for (const h of sec.hunks) {
        for (const e of h.n) if (e.ctx < 0) plus.push(e.text);
        if (h.hasPlus) noEol = h.lastPlusNoEol;
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
    };
  }
  if (newP === null || sec.remove) {
    const p = oldP ?? '';
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  if (oldP !== newP) {
    const op = oldP ?? '';
    const np = newP ?? '';
    return (tree) => {
      if (!safe(op)) throw new Fail('unsafe', op);
      if (!safe(np)) throw new Fail('unsafe', np);
      const before = tree.get(op);
      if (before === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const file = parseFile(before);
      let d = 0;
      for (const h of sec.hunks) {
        applyUnifiedHunk(file, h, d, strict, op);
        d += h.n.length - h.o.length;
      }
      tree.now.set(op, null);
      tree.now.set(np, serializeFile(file));
      tree.moves.push({ from: op, to: np });
    };
  }
  const p = oldP ?? '';
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const file = parseFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      applyUnifiedHunk(file, h, d, strict, p);
      d += h.n.length - h.o.length;
    }
    tree.now.set(p, serializeFile(file));
  };
}

/** Read the patch as a unified diff (SPEC.md section 6). */
function parseUnified(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let cur: UBuilder | null = null;
  const close = (): void => {
    if (cur === null) return;
    edits.push(unifiedEdit(cur, strict));
    cur = null;
  };
  const open = (): UBuilder => {
    const b: UBuilder = {
      sec: { oldPath: null, newPath: null, create: false, remove: false, hunks: [] },
      hasPair: false,
      hasHunk: false,
      renameFrom: null,
      renameTo: null,
      gitOld: null,
      gitNew: null,
    };
    cur = b;
    return b;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      close();
      const b = open();
      b.gitOld = m[1]!;
      b.gitNew = m[2]!;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || cur.hasHunk || cur.hasPair) {
        close();
        open();
      }
      cur!.sec.oldPath = headerPath(line);
      cur!.sec.newPath = headerPath(lines[i + 1]!);
      cur!.hasPair = true;
      i += 2;
      continue;
    }
    if (cur === null) {
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const parsed = parseHunkBody(lines, i + 1, Number(m[1]));
      cur.sec.hunks.push(parsed.hunk);
      cur.hasHunk = true;
      i = parsed.next;
      continue;
    }
    if (cur.hasHunk) {
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
    if (line.startsWith('rename from ')) {
      cur.renameFrom = line.slice(12).trim();
      i += 1;
      continue;
    }
    if (line.startsWith('rename to ')) {
      cur.renameTo = line.slice(10).trim();
      i += 1;
      continue;
    }
    if (line.startsWith('new file mode')) {
      cur.sec.create = true;
      i += 1;
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      cur.sec.remove = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  close();
  return edits;
}

/** One SEARCH/REPLACE block as an edit (SPEC.md section 7). */
function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const file = parseFile(before);
    const found = findTier(file.lines, oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const n: NLine[] = newLines.map((t) => ({ text: t, ctx: -1 }));
    applyReplace(file, found.occ[0]!, oldLines, n, found.tier);
    tree.now.set(path, serializeFile(file));
  };
}

/** Read the patch as SEARCH/REPLACE blocks (SPEC.md section 7). */
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const sIdx = i;
    let eq = -1;
    for (let j = sIdx + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    let path: string | null = null;
    for (let j = sIdx - 1; j > prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${sIdx + 1}`);
    const oldLines = lines.slice(sIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

/** One V4A update chunk: its anchor, its old and new lines, its end-of-file mark. */
interface VChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: NLine[];
}

/** Apply one V4A chunk at the cursor; returns the cursor after what it wrote. */
function applyV4aChunk(file: FileState, ch: VChunk, cursor: number, strict: boolean, path: string): number {
  let cur = cursor;
  if (ch.anchor !== null) {
    const at = findSingle(file.lines, ch.anchor, strict, cur);
    if (at < 0) throw new Fail('no-match', path);
    cur = at + 1;
  }
  if (ch.o.length === 0) {
    const at = ch.eof ? file.lines.length : cur;
    file.lines.splice(at, 0, ...ch.n.map((e) => e.text));
    return at + ch.n.length;
  }
  const found = findTierEof(file.lines, ch.o, strict, cur, ch.eof);
  if (found === null) throw new Fail('no-match', path);
  const pos = found.occ[0]!;
  applyReplace(file, pos, ch.o, ch.n, found.tier);
  return pos + ch.n.length;
}

function v4aAdd(path: string, content: string[], base: number): Edit {
  const fileLines: string[] = [];
  for (let k = 0; k < content.length; k += 1) {
    const l = content[k]!;
    if (l === '') fileLines.push('');
    else if (l.startsWith('+')) fileLines.push(l.slice(1));
    else throw new Exit2(`error: parse ${base + k}`);
  }
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDelete(path: string, content: string[], base: number): Edit {
  if (content.length > 0) throw new Exit2(`error: parse ${base}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdate(path: string, content: string[], base: number, strict: boolean): Edit {
  let idx = 0;
  let moveTo: string | null = null;
  if (content.length > 0 && content[0]!.startsWith('*** Move to: ')) {
    moveTo = content[0]!.slice(13).trim();
    idx = 1;
  }
  const chunks: VChunk[] = [];
  let curBody: BodyLine[] | null = null;
  let curAnchor: string | null = null;
  let curEof = false;
  const flush = (): void => {
    if (curBody === null) return;
    const parts = bodyParts(curBody);
    chunks.push({ anchor: curAnchor, eof: curEof, o: parts.o, n: parts.n });
    curBody = null;
    curAnchor = null;
    curEof = false;
  };
  for (; idx < content.length; idx += 1) {
    const l = content[idx]!;
    if (l.startsWith('@@')) {
      flush();
      curBody = [];
      const anchor = l.slice(2).trim();
      curAnchor = anchor === '' ? null : anchor;
      curEof = false;
      continue;
    }
    if (l === '*** End of File') {
      if (curBody === null) {
        curBody = [];
        curAnchor = null;
        curEof = false;
      }
      curEof = true;
      flush();
      continue;
    }
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (curBody === null) {
        curBody = [];
        curAnchor = null;
        curEof = false;
      }
      if (l === '') curBody.push({ kind: 'ctx', text: '', empty: true });
      else if (l[0] === ' ') curBody.push({ kind: 'ctx', text: l.slice(1), empty: false });
      else if (l[0] === '-') curBody.push({ kind: 'old', text: l.slice(1), empty: false });
      else curBody.push({ kind: 'new', text: l.slice(1), empty: false });
      continue;
    }
    throw new Exit2(`error: parse ${base + idx}`);
  }
  flush();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${base - 1}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const file = parseFile(before);
    let cursor = 0;
    for (const ch of chunks) cursor = applyV4aChunk(file, ch, cursor, strict, path);
    const out = serializeFile(file);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push({ from: path, to: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

/** Read the patch as a V4A patch (SPEC.md section 8). */
function parseV4a(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = n - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice(14).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice(17).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice(17).trim();
    } else throw new Exit2(`error: parse ${i + 1}`);
    let end = i + 1;
    while (end < last) {
      const l = lines[end]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      end += 1;
    }
    let contentEnd = end;
    while (contentEnd > i + 1 && blank(lines[contentEnd - 1]!)) contentEnd -= 1;
    const content = lines.slice(i + 1, contentEnd);
    const base = i + 2;
    if (kind === 'add') edits.push(v4aAdd(path, content, base));
    else if (kind === 'delete') edits.push(v4aDelete(path, content, base));
    else edits.push(v4aUpdate(path, content, base, strict));
    i = end;
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const entries: { key: string; line: string }[] = [];
  const covered = new Set<string>();
  for (const m of tree.moves) {
    const wasOld = tree.original(m.from);
    const wasNew = tree.original(m.to);
    const nowOld = tree.now.get(m.from);
    const nowNew = tree.now.get(m.to);
    if (wasOld !== null && wasNew === null && nowOld === null && nowNew !== null && nowNew !== undefined) {
      entries.push({ key: m.to, line: `R ${m.from} -> ${m.to}` });
      covered.add(m.from);
      covered.add(m.to);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    entries.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = entries.map((e) => e.line);
  if (!check) {
    const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p));
    for (const p of changed) if (tree.now.get(p) === null) rmSync(p, { force: true });
    for (const p of changed) {
      const v = tree.now.get(p)!;
      if (v !== null) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, v);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
