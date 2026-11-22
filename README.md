# mend: one patch tool for every AI edit format

`mend` applies an edit that an AI model wrote to a tree of text files. Models
write edits in four formats, and `mend` reads all of them: a unified diff
(often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format,
and text-editor tool calls as JSON. Every file is changed or nothing is.

The contract is `SPEC.md` in this repository. The entry point is `main.ts`
(Node 22, standard library only).

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the path of the patch file, relative to the working directory.
  When it is absent or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as
  without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order. `--` ends the options.

Exit 0 prints one line per changed path (`A`, `D`, `M`, or `R old -> new`)
and `ok: <n> files`. Exit 1 prints one `error: <code> <path>` line per
failed edit and `failed: <k> of <n> edits`; no file is written. Exit 2
prints one line for a usage, missing-patch, format or parse error.

## How it works

Each edit names old lines `O` that are replaced by new lines `N`. `O` is
found at the first of three matching tiers where it occurs: exact, then
trailing whitespace ignored, then leading and trailing whitespace ignored
(`--strict` tries only the exact tier). Context lines are written as the
file's own lines; at tier 2 the other new lines are re-indented to the
file's indentation. Unified hunks take the occurrence nearest the hunk's
line number; SEARCH/REPLACE blocks fail as ambiguous when the old lines
occur more than once; V4A chunks walk a cursor through the file, anchored
by `@@` lines and `*** End of File`. Edits apply in patch order to the tree
as earlier edits left it, and a failed edit changes nothing while the edits
after it still run.

## Files

- `main.ts` — the CLI.
- `runner.ts` — the kit's trial runner (kept as issued); `main.ts` hands a
  trial over to it when `MAKEFUN_ENV_URL` is set.
- `check.ts` — runs the kit's public practice set against `main.ts`.
- `SPEC.md` — the specification.
- `tests/edge-tests.mjs` — hand-built edge cases for sentences of the
  specification the practice set does not show.

## Tests

```
node check.ts <path to the kit's program/generator/practice.json>
node tests/edge-tests.mjs
```

Practice set: 100 of 100 passed (score 1000). Edge cases: 62 of 62 passed.

## License

MIT — see `LICENSE`.
