// Edge-case tests for mend, beyond the kit's practice set: one case per
// sentence of SPEC.md the practice set does not show. Run: node tests/edge-tests.mjs
// Exits 0 when every case matches (exit code, stdout, and every file after).
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'main.ts');

const cases = [];
const add = (name, argv, stdin, files, exit, stdout, changes) => cases.push({ name, argv, stdin, files, exit, stdout, changes });

const U = (body) => `--- a/f.txt\n+++ b/f.txt\n${body}`;

// --- unified: nearest occurrence, ties, insertion -------------------------
add('u-nearest-second', ['p.patch'], null,
  { 'p.patch': U('@@ -4,1 +4,1 @@\n-beta\n+BETA\n'), 'f.txt': 'alpha\nbeta\nalpha\nbeta\ngamma\n' },
  0, 'M f.txt\nok: 1 file\n', { 'f.txt': 'alpha\nbeta\nalpha\nBETA\ngamma\n' });
add('u-nearest-tie-earlier', ['p.patch'], null,
  { 'p.patch': U('@@ -3,1 +3,1 @@\n-beta\n+BETA\n'), 'f.txt': 'alpha\nbeta\nalpha\nbeta\ngamma\n' },
  0, 'M f.txt\nok: 1 file\n', { 'f.txt': 'alpha\nBETA\nalpha\nbeta\ngamma\n' });
add('u-insert-top', ['p.patch'], null,
  { 'p.patch': U('@@ -0,0 +1,2 @@\n+x\n+y\n'), 'f.txt': 'a\nb\nc\n' },
  0, 'M f.txt\nok: 1 file\n', { 'f.txt': 'x\ny\na\nb\nc\n' });
add('u-insert-past-end', ['p.patch'], null,
  { 'p.patch': U('@@ -99,0 +100,1 @@\n+x\n'), 'f.txt': 'a\nb\n' },
  0, 'M f.txt\nok: 1 file\n', { 'f.txt': 'a\nb\nx\n' });

// --- unified: final line break rules --------------------------------------
add('u-backslash-after-old-only', ['p.patch'], null,
  { 'p.patch': U('@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+B\n'), 'f.txt': 'a\nb' },
  0, 'M f.txt\nok: 1 file\n', { 'f.txt': 'a\nB\n' });
add('u-backslash-after-new', ['p.patch'], null,
  { 'p.patch': U('@@ -1,2 +1,2 @@\n a\n-b\n+B\n\\ No newline at end of file\n'), 'f.txt': 'a\nb' },
  0, 'M f.txt\nok: 1 file\n', { 'f.txt': 'a\nB' });
add('u-noeol-untouched', ['p.patch'], null,
  { 'p.patch': U('@@ -1,1 +1,1 @@\n-a\n+A\n'), 'f.txt': 'a\nb\nc' },
  0, 'M f.txt\nok: 1 file\n', { 'f.txt': 'A\nb\nc' });
add('u-create-noeol', ['p.patch'], null,
  { 'p.patch': '--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+hello\n+world\n\\ No newline at end of file\n' },
  0, 'A new.txt\nok: 1 file\n', { 'new.txt': 'hello\nworld' });
add('u-create-eol', ['p.patch'], null,
  { 'p.patch': '--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+hello\n+world\n' },
  0, 'A new.txt\nok: 1 file\n', { 'new.txt': 'hello\nworld\n' });

// --- unified: deletion ignores hunks, rename, tabs, parse errors ----------
add('u-delete-ignores-hunks', ['p.patch'], null,
  { 'p.patch': '--- a/f.txt\n+++ /dev/null\n@@ -1,99 +1,0 @@\n-nonexistent line\n', 'f.txt': 'a\nb\n' },
  0, 'D f.txt\nok: 1 file\n', { 'f.txt': null });
add('u-rename-pairless', ['p.patch'], null,
  { 'p.patch': 'diff --git a/old.txt b/new.txt\nrename from old.txt\nrename to new.txt\n@@ -1,1 +1,1 @@\n-a\n+A\n', 'old.txt': 'a\n' },
  0, 'R old.txt -> new.txt\nok: 1 file\n', { 'old.txt': null, 'new.txt': 'A\n' });
add('u-tab-timestamp', ['p.patch'], null,
  { 'p.patch': '--- a/f.txt\t2026-01-01 00:00:00\n+++ b/f.txt\t2026-01-01 00:00:00\n@@ -1,1 +1,1 @@\n-a\n+A\n', 'f.txt': 'a\n' },
  0, 'M f.txt\nok: 1 file\n', { 'f.txt': 'A\n' });
add('u-hunk-before-section', ['p.patch'], null,
  { 'p.patch': 'note\n@@ -1,1 +1,1 @@\n-a\n+A\n--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-a\n+A\n', 'f.txt': 'a\n' },
  2, 'error: parse 2\n', { 'f.txt': 'a\n' });
add('u-lone-triple-dash', ['p.patch'], null,
  { 'p.patch': 'diff --git a/f.txt b/f.txt\n--- a/f.txt\nsomething else\n+++ b/f.txt\n', 'f.txt': 'a\n' },
  2, 'error: parse 3\n', { 'f.txt': 'a\n' });
add('u-bad-diff-git', ['p.patch'], null,
  { 'p.patch': 'diff --git a/f.txt\n--- a/f.txt\n+++ b/f.txt\n', 'f.txt': 'a\n' },
  2, 'error: parse 1\n', { 'f.txt': 'a\n' });

// --- unified: sections with no hunks, CRLF, strict ------------------------
add('u-nohunk-missing', ['p.patch'], null,
  { 'p.patch': '--- a/gone.txt\n+++ b/gone.txt\n' },
  1, 'error: missing gone.txt\nfailed: 1 of 1 edits\n', {});
add('u-nohunk-noop', ['p.patch'], null,
  { 'p.patch': '--- a/f.txt\n+++ b/f.txt\n', 'f.txt': 'a\n' },
  0, 'ok: 0 files\n', { 'f.txt': 'a\n' });
add('u-crlf-kept', ['p.patch'], null,
  { 'p.patch': U('@@ -1,1 +1,1 @@\n-a\n+A\n'), 'f.txt': 'a\r\nb\r\n' },
  0, 'M f.txt\nok: 1 file\n', { 'f.txt': 'A\r\nb\r\n' });
add('u-strict-blocks-tier2', ['--strict', 'p.patch'], null,
  { 'p.patch': U('@@ -1,1 +1,1 @@\n-x\n+X\n'), 'f.txt': '  x\n' },
  1, 'error: no-match f.txt\nfailed: 1 of 1 edits\n', { 'f.txt': '  x\n' });
add('u-tier2-reindent', ['p.patch'], null,
  { 'p.patch': U('@@ -1,1 +1,1 @@\n-x\n+  y\n'), 'f.txt': '    x\n' },
  0, 'M f.txt\nok: 1 file\n', { 'f.txt': '      y\n' });

// --- unified: atomicity, options ------------------------------------------
add('u-atomic-two-sections', ['p.patch'], null,
  { 'p.patch': `${U('@@ -1,1 +1,1 @@\n-a\n+A\n')}--- a/g.txt\n+++ b/g.txt\n@@ -1,1 +1,1 @@\n-nope\n+NOPE\n`, 'f.txt': 'a\n', 'g.txt': 'g\n' },
  1, 'error: no-match g.txt\nfailed: 1 of 2 edits\n', { 'f.txt': 'a\n', 'g.txt': 'g\n' });
add('cli-options-any-order', ['p.patch', '--check', '--format=unified'], null,
  { 'p.patch': U('@@ -1,1 +1,1 @@\n-a\n+A\n'), 'f.txt': 'a\n' },
  0, 'M f.txt\nok: 1 file\n', { 'f.txt': 'a\n' });
add('cli-double-dash', ['--', '--check'], null, { 'f.txt': 'a\n' },
  2, 'error: no-patch\n', { 'f.txt': 'a\n' });
add('cli-dup-check', ['--check', '--check', 'p.patch'], null,
  { 'p.patch': U('@@ -1,1 +1,1 @@\n-a\n+A\n'), 'f.txt': 'a\n' },
  2, 'error: usage\n', { 'f.txt': 'a\n' });
add('cli-two-positionals', ['a.patch', 'b.patch'], null, { 'f.txt': 'a\n' },
  2, 'error: usage\n', { 'f.txt': 'a\n' });
add('cli-unknown-short', ['-x', 'p.patch'], null, { 'f.txt': 'a\n' },
  2, 'error: usage\n', { 'f.txt': 'a\n' });

// --- search/replace --------------------------------------------------------
add('s-create', ['p.patch'], null,
  { 'p.patch': 'new.txt\n<<<<<<< SEARCH\n=======\nhello\nworld\n>>>>>>> REPLACE\n' },
  0, 'A new.txt\nok: 1 file\n', { 'new.txt': 'hello\nworld\n' });
add('s-create-empty', ['p.patch'], null,
  { 'p.patch': 'new.txt\n<<<<<<< SEARCH\n=======\n>>>>>>> REPLACE\n' },
  0, 'A new.txt\nok: 1 file\n', { 'new.txt': '' });
add('s-ambiguous', ['p.patch'], null,
  { 'p.patch': 'f.txt\n<<<<<<< SEARCH\nx\n=======\nX\n>>>>>>> REPLACE\n', 'f.txt': 'x\ny\nx\n' },
  1, 'error: ambiguous f.txt\nfailed: 1 of 1 edits\n', { 'f.txt': 'x\ny\nx\n' });
add('s-second-block-inherits-path', ['p.patch'], null,
  { 'p.patch': 'a.txt\n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n<<<<<<< SEARCH\nb\n=======\nB\n>>>>>>> REPLACE\n', 'a.txt': 'a\nb\n' },
  0, 'M a.txt\nok: 1 file\n', { 'a.txt': 'A\nB\n' });
add('s-create-exists', ['p.patch'], null,
  { 'p.patch': 'f.txt\n<<<<<<< SEARCH\n=======\nx\n>>>>>>> REPLACE\n', 'f.txt': 'old\n' },
  1, 'error: exists f.txt\nfailed: 1 of 1 edits\n', { 'f.txt': 'old\n' });
add('s-tier2-reindent', ['p.patch'], null,
  { 'p.patch': 'f.txt\n<<<<<<< SEARCH\nx\n=======\n  z\n>>>>>>> REPLACE\n', 'f.txt': '    x\n    y\n' },
  0, 'M f.txt\nok: 1 file\n', { 'f.txt': '      z\n    y\n' });

// --- V4A -------------------------------------------------------------------
add('v-multi-section', ['p.patch'], null,
  { 'p.patch': '*** Begin Patch\n*** Add File: n.txt\n+new\n*** Delete File: d.txt\n*** Update File: u.txt\n-old\n+new\n*** End Patch\n', 'd.txt': 'd\n', 'u.txt': 'old\n' },
  0, 'D d.txt\nA n.txt\nM u.txt\nok: 3 files\n', { 'n.txt': 'new\n', 'd.txt': null, 'u.txt': 'new\n' });
add('v-move-only', ['p.patch'], null,
  { 'p.patch': '*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n*** End Patch\n', 'old.txt': 'a\n' },
  0, 'R old.txt -> new.txt\nok: 1 file\n', { 'old.txt': null, 'new.txt': 'a\n' });
add('v-update-no-chunk', ['p.patch'], null,
  { 'p.patch': '*** Begin Patch\n*** Update File: u.txt\n*** End Patch\n', 'u.txt': 'a\n' },
  2, 'error: parse 2\n', { 'u.txt': 'a\n' });
add('v-anchor-nomatch', ['p.patch'], null,
  { 'p.patch': '*** Begin Patch\n*** Update File: u.txt\n@@ missing anchor\n-x\n+X\n*** End Patch\n', 'u.txt': 'x\n' },
  1, 'error: no-match u.txt\nfailed: 1 of 1 edits\n', { 'u.txt': 'x\n' });
add('v-eof-not-at-end', ['p.patch'], null,
  { 'p.patch': '*** Begin Patch\n*** Update File: u.txt\n a\n-b\n+B\n*** End of File\n*** End Patch\n', 'u.txt': 'a\nb\nc\n' },
  1, 'error: no-match u.txt\nfailed: 1 of 1 edits\n', { 'u.txt': 'a\nb\nc\n' });
add('v-empty-o-at-cursor', ['p.patch'], null,
  { 'p.patch': '*** Begin Patch\n*** Update File: u.txt\n@@ def two():\n+inserted\n*** End Patch\n', 'u.txt': 'def one():\n  pass\n\ndef two():\n  pass\n' },
  0, 'M u.txt\nok: 1 file\n', { 'u.txt': 'def one():\n  pass\n\ndef two():\ninserted\n  pass\n' });
add('v-empty-o-at-eof', ['p.patch'], null,
  { 'p.patch': '*** Begin Patch\n*** Update File: u.txt\n@@ def two():\n+tail\n*** End of File\n*** End Patch\n', 'u.txt': 'def two():\n  pass\n' },
  0, 'M u.txt\nok: 1 file\n', { 'u.txt': 'def two():\n  pass\ntail\n' });
add('v-move-to-not-first', ['p.patch'], null,
  { 'p.patch': '*** Begin Patch\n*** Update File: u.txt\n-x\n+X\n*** Move to: n.txt\n*** End Patch\n', 'u.txt': 'x\n' },
  2, 'error: parse 5\n', { 'u.txt': 'x\n' });
add('v-add-trailing-blanks-stripped', ['p.patch'], null,
  { 'p.patch': '*** Begin Patch\n*** Add File: n.txt\n+a\n+\n\n\n*** End Patch\n' },
  0, 'A n.txt\nok: 1 file\n', { 'n.txt': 'a\n\n' });
add('v-first-line-wrong', ['--format=v4a', 'p.patch'], null,
  { 'p.patch': 'hello\n*** Begin Patch\n*** End Patch\n' },
  2, 'error: parse 1\n', {});
add('v-empty-anchor', ['p.patch'], null,
  { 'p.patch': '*** Begin Patch\n*** Update File: u.txt\n@@\n-x\n+X\n*** End Patch\n', 'u.txt': 'x\n' },
  0, 'M u.txt\nok: 1 file\n', { 'u.txt': 'X\n' });

// --- JSON ------------------------------------------------------------------
add('j-array-fault', ['p.patch'], null,
  { 'p.patch': '[{"command":"create","path":"a.txt","file_text":"x"}, {"command":"bogus","path":"b.txt"}]' },
  2, 'error: parse 1\n', {});
add('j-lines-fault-second', ['p.patch'], null,
  { 'p.patch': '{"command":"create","path":"a.txt","file_text":"x"}\nnot json\n' },
  2, 'error: parse 2\n', {});
add('j-insert-out-of-range', ['p.patch'], null,
  { 'p.patch': '{"command":"insert","path":"f.txt","insert_line":5,"new_str":"x"}', 'f.txt': 'a\nb\n' },
  1, 'error: no-match f.txt\nfailed: 1 of 1 edits\n', { 'f.txt': 'a\nb\n' });
add('j-str-replace-overlap-ambiguous', ['p.patch'], null,
  { 'p.patch': '{"command":"str_replace","path":"f.txt","old_str":"aa","new_str":"b"}', 'f.txt': 'aaa' },
  1, 'error: ambiguous f.txt\nfailed: 1 of 1 edits\n', { 'f.txt': 'aaa' });
add('j-create-byte-for-byte', ['p.patch'], null,
  { 'p.patch': '{"command":"create","path":"n.txt","file_text":"x\\r\\ny"}' },
  0, 'A n.txt\nok: 1 file\n', { 'n.txt': 'x\r\ny' });

// --- driver: check, atomicity, moves, safety, format ----------------------
add('c-check-writes-nothing', ['--check', 'p.patch'], null,
  { 'p.patch': U('@@ -1,1 +1,1 @@\n-a\n+A\n'), 'f.txt': 'a\n' },
  0, 'M f.txt\nok: 1 file\n', { 'f.txt': 'a\n' });
add('c-move-then-fail-atomic', ['p.patch'], null,
  { 'p.patch': `--- a/a.txt\n+++ b/b.txt\n@@ -1,1 +1,1 @@\n-a\n+A\n--- a/c.txt\n+++ b/c.txt\n@@ -1,1 +1,1 @@\n-nope\n+NOPE\n`, 'a.txt': 'a\n', 'c.txt': 'c\n' },
  1, 'error: no-match c.txt\nfailed: 1 of 2 edits\n', { 'a.txt': 'a\n', 'c.txt': 'c\n' });
add('c-move-created-earlier', ['p.patch'], null,
  { 'p.patch': '--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,1 @@\n+x\n--- a/new.txt\n+++ b/other.txt\n' },
  0, 'A other.txt\nok: 1 file\n', { 'other.txt': 'x\n' });
add('c-move-chain', ['p.patch'], null,
  { 'p.patch': '--- a/a.txt\n+++ b/b.txt\n--- a/b.txt\n+++ b/c.txt\n', 'a.txt': 'a\n' },
  0, 'D a.txt\nA c.txt\nok: 2 files\n', { 'a.txt': null, 'c.txt': 'a\n' });
add('c-output-sorted', ['p.patch'], null,
  { 'p.patch': '--- /dev/null\n+++ b/z.txt\n@@ -0,0 +1,1 @@\n+z\n--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1,1 @@\n+a\n' },
  0, 'A a.txt\nA z.txt\nok: 2 files\n', { 'a.txt': 'a\n', 'z.txt': 'z\n' });
add('c-later-edit-sees-earlier', ['p.patch'], null,
  { 'p.patch': 'f.txt\n<<<<<<< SEARCH\n=======\nhello\n>>>>>>> REPLACE\nf.txt\n<<<<<<< SEARCH\nhello\n=======\nbye\n>>>>>>> REPLACE\n' },
  0, 'A f.txt\nok: 1 file\n', { 'f.txt': 'bye\n' });
add('c-no-patch-file', ['missing.patch'], null, {},
  2, 'error: no-patch\n', {});
add('c-empty-stdin-format', ['-'], '', {},
  2, 'error: format\n', {});
add('c-prose-only-format', ['p.patch'], null,
  { 'p.patch': 'just some prose, no patch here\n' },
  2, 'error: format\n', {});
add('c-forced-unified-no-edits', ['--format=unified', 'p.patch'], null,
  { 'p.patch': 'just some prose\n' },
  2, 'error: parse 1\n', {});
add('c-unsafe-dotdot', ['p.patch'], null,
  { 'p.patch': '--- a/../evil.txt\n+++ b/../evil.txt\n@@ -1,1 +1,1 @@\n-a\n+A\n' },
  1, 'error: unsafe ../evil.txt\nfailed: 1 of 1 edits\n', {});
add('c-unsafe-absolute-sr', ['p.patch'], null,
  { 'p.patch': '/abs/path.txt\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n' },
  1, 'error: unsafe /abs/path.txt\nfailed: 1 of 1 edits\n', {});
add('c-unsafe-double-slash-json', ['p.patch'], null,
  { 'p.patch': '{"command":"create","path":"a//b.txt","file_text":"x"}' },
  1, 'error: unsafe a//b.txt\nfailed: 1 of 1 edits\n', {});
add('c-failure-order', ['p.patch'], null,
  { 'p.patch': 'gone1.txt\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\ngone2.txt\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n' },
  1, 'error: missing gone1.txt\nerror: missing gone2.txt\nfailed: 2 of 2 edits\n', {});

let passed = 0;
for (const c of cases) {
  const dir = mkdtempSync(join(tmpdir(), 'mend-edge-'));
  try {
    for (const [p, text] of Object.entries(c.files)) {
      const f = join(dir, ...p.split('/'));
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, text);
    }
    const r = spawnSync(process.execPath, [MAIN, ...c.argv], { cwd: dir, input: c.stdin ?? '', encoding: 'utf8', timeout: 10_000 });
    const why = [];
    if (r.status !== c.exit) why.push(`exit ${r.status}, expected ${c.exit}`);
    if ((r.stdout ?? '') !== c.stdout) why.push(`stdout ${JSON.stringify(r.stdout)}, expected ${JSON.stringify(c.stdout)}`);
    const want = { ...c.files };
    for (const [p, v] of Object.entries(c.changes)) {
      if (v === null) delete want[p];
      else want[p] = v;
    }
    const got = {};
    const walk = (d, rel) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        const rp = rel ? `${rel}/${name}` : name;
        if (statSync(p).isDirectory()) walk(p, rp);
        else got[rp] = readFileSync(p, 'utf8');
      }
    };
    walk(dir, '');
    for (const p of new Set([...Object.keys(want), ...Object.keys(got)])) {
      if (want[p] === undefined) why.push(`${p} should not exist`);
      else if (got[p] === undefined) why.push(`${p} is missing`);
      else if (got[p] !== want[p]) why.push(`${p} differs: expected ${JSON.stringify(want[p])}, got ${JSON.stringify(got[p])}`);
    }
    if (why.length === 0) passed += 1;
    else process.stdout.write(`FAIL ${c.name}\n  ${why.join('\n  ')}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
process.stdout.write(`${passed} of ${cases.length} edge cases passed\n`);
process.exit(passed === cases.length ? 0 : 1);
