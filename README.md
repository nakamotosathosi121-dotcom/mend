# mend

One patch tool for every AI edit format. `mend` is a Node 22 command-line tool that applies AI-written edits in four formats to a tree of files, to the specification in SPEC.md:

- unified diffs (with wrong line numbers)
- SEARCH/REPLACE blocks
- V4A patches
- text-editor tool calls as JSON

It finds the lines each edit names even when the model drifted their whitespace or indentation (three matching tiers), and changes every file or none.

## Run

```
node main.ts [options] [PATCH]
```

Run with the working directory as the root of a tree of text files. Node 22 standard library only; deterministic; nothing is installed before it runs.

## License

MIT
