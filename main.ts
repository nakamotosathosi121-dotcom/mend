// mend: applies an edit that an AI model wrote to a tree of text files, in the four formats SPEC.md
// specifies: unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches and
// text-editor tool calls as JSON. Every file is changed or nothing is. Node 22, the standard library
// alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over
// to runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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
const trimSpaces = (s: string): string => s.replace(/^ +| +$/g, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];
const rstripWs = (s: string): string => s.replace(/[ \t]+$/, '');
const stripWs = (s: string): string => s.replace(/^[ \t]+|[ \t]+$/g, '');

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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

type Move = { old: string; new: string };
type Edit = (tree: Tree, moves: Move[]) => void;

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

// ---- A file's text as lines (SPEC section 3) ----

interface FileText {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const parts = text.split(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileText): string {
  return f.lines.length === 0 ? '' : f.lines.join(f.br) + (f.final ? f.br : '');
}

// ---- Matching lines at three tiers (SPEC section 5) ----

function eqTier(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rstripWs(a) === rstripWs(b);
  return stripWs(a) === stripWs(b);
}

function tiersFor(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

function occurrences(lines: string[], O: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!eqTier(lines[i + j]!, O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function matchTier(lines: string[], O: string[], strict: boolean, from = 0, eofOnly = false): { tier: number; occ: number[] } | null {
  for (const tier of tiersFor(strict)) {
    let occ = occurrences(lines, O, tier, from);
    if (eofOnly) occ = occ.filter((i) => i + O.length === lines.length);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

function reindent(text: string, F: string, P: string): string {
  if (text === '' || /^[ \t]*$/.test(text)) return text;
  return text.startsWith(P) ? F + text.slice(P.length) : text;
}

// A hunk or chunk body: context, old, new and `\` lines, with the O and N views of section 5.
interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
  fromEmpty: boolean;
}
interface NLine {
  text: string;
  oIdx: number | null;
}
interface Block {
  oList: string[];
  nList: NLine[];
}

function bodyLine(L: string): BodyLine | null {
  if (L === '') return { kind: 'ctx', text: '', fromEmpty: true };
  const c = L[0]!;
  if (c === ' ') return { kind: 'ctx', text: L.slice(1), fromEmpty: false };
  if (c === '-') return { kind: 'old', text: L.slice(1), fromEmpty: false };
  if (c === '+') return { kind: 'new', text: L.slice(1), fromEmpty: false };
  if (c === '\\') return { kind: 'bs', text: L.slice(1), fromEmpty: false };
  return null;
}

function toBlock(body: BodyLine[]): Block {
  const oList: string[] = [];
  const nList: NLine[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      const oi = oList.length;
      oList.push(b.text);
      nList.push({ text: b.text, oIdx: oi });
    } else if (b.kind === 'old') oList.push(b.text);
    else if (b.kind === 'new') nList.push({ text: b.text, oIdx: null });
  }
  return { oList, nList };
}

/** The lines written for a match of block's O at `pos`: context as the file's own lines, tier 2 re-indented. */
function buildSegment(lines: string[], pos: number, block: Block, tier: number): string[] {
  const F = leadWs(lines[pos]!);
  const P = leadWs(block.oList[0]!);
  return block.nList.map((n) => (n.oIdx !== null ? lines[pos + n.oIdx]! : tier === 2 ? reindent(n.text, F, P) : n.text));
}

function bsAfterLastCtxOrNew(body: BodyLine[]): boolean {
  for (let j = body.length - 1; j >= 0; j--) {
    if (body[j]!.kind === 'ctx' || body[j]!.kind === 'new') return body[j + 1]?.kind === 'bs';
  }
  return false;
}

// ---- Unified diffs (SPEC section 6) ----

interface Hunk {
  A: number;
  body: BodyLine[];
}
interface Section {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameOld: string | undefined;
  renameNew: string | undefined;
  gitOld: string | undefined;
  gitNew: string | undefined;
  newFileMode: boolean;
  deletedFileMode: boolean;
  hunks: Hunk[];
}

function headerPath(line: string): string | null {
  let s = line.slice(4);
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  s = trimSpaces(s);
  if (s === '/dev/null') return null;
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s;
}

function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(text);
  let cur = f.lines;
  let final = f.final;
  let d = 0;
  for (const h of hunks) {
    const block = toBlock(h.body);
    const O = block.oList;
    if (O.length === 0) {
      const pos = Math.max(0, Math.min(h.A + d, cur.length));
      const seg = block.nList.map((n) => n.text);
      const atEnd = pos === cur.length;
      cur = [...cur.slice(0, pos), ...seg, ...cur.slice(pos)];
      if (atEnd) final = !bsAfterLastCtxOrNew(h.body);
      d += seg.length;
    } else {
      const m = matchTier(cur, O, strict);
      if (m === null) throw new Fail('no-match', path);
      const target = h.A - 1 + d;
      let pos = m.occ[0]!;
      let best = Math.abs(pos - target);
      for (const o of m.occ) {
        const dist = Math.abs(o - target);
        if (dist < best) {
          best = dist;
          pos = o;
        }
      }
      const seg = buildSegment(cur, pos, block, m.tier);
      const touchesEnd = pos + O.length === cur.length;
      cur = [...cur.slice(0, pos), ...seg, ...cur.slice(pos + O.length)];
      if (touchesEnd) final = !bsAfterLastCtxOrNew(h.body);
      d += block.nList.length - O.length;
    }
  }
  return joinFile({ lines: cur, br: f.br, final });
}

function sectionEdit(sec: Section, strict: boolean): Edit {
  return (tree, moves) => {
    const oldPath = sec.pairOld !== undefined ? sec.pairOld : sec.renameOld ?? sec.gitOld ?? null;
    const newPath = sec.pairNew !== undefined ? sec.pairNew : sec.renameNew ?? sec.gitNew ?? null;
    const isCreation = oldPath === null || sec.newFileMode;
    const isDeletion = newPath === null || sec.deletedFileMode;
    if (isCreation && newPath !== null) {
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const created: string[] = [];
      let lastPlusBs = false;
      for (const h of sec.hunks) {
        h.body.forEach((b, bi) => {
          if (b.kind === 'new') {
            created.push(b.text);
            lastPlusBs = h.body[bi + 1]?.kind === 'bs';
          }
        });
      }
      tree.now.set(newPath, created.length === 0 ? '' : created.join('\n') + (lastPlusBs ? '' : '\n'));
      return;
    }
    if (isDeletion && oldPath !== null) {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    if (oldPath === null || newPath === null) return;
    if (oldPath !== newPath) {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      const text = tree.get(oldPath);
      if (text === null) throw new Fail('missing', oldPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const out = applyHunks(text, sec.hunks, strict, oldPath);
      tree.now.set(newPath, out);
      tree.now.set(oldPath, null);
      moves.push({ old: oldPath, new: newPath });
      return;
    }
    if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
    const text = tree.get(oldPath);
    if (text === null) throw new Fail('missing', oldPath);
    tree.now.set(oldPath, applyHunks(text, sec.hunks, strict, oldPath));
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let sec: Section | null = null;
  let hunk: Hunk | null = null;
  let state: 'outside' | 'header' | 'body' | 'after' = 'outside';
  const newSection = (): Section => ({
    pairOld: undefined,
    pairNew: undefined,
    renameOld: undefined,
    renameNew: undefined,
    gitOld: undefined,
    gitNew: undefined,
    newFileMode: false,
    deletedFileMode: false,
    hunks: [],
  });
  const endBody = (): void => {
    if (hunk !== null) {
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.fromEmpty) hunk.body.pop();
      hunk = null;
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i]!;
    if (L.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(L);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      endBody();
      sec = newSection();
      sec.gitOld = m[1]!;
      sec.gitNew = m[2]!;
      sections.push(sec);
      state = 'header';
      continue;
    }
    if (L.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (state === 'header' && sec !== null) {
        sec.pairOld = headerPath(L);
        sec.pairNew = headerPath(lines[i + 1]!);
      } else {
        endBody();
        sec = newSection();
        sec.pairOld = headerPath(L);
        sec.pairNew = headerPath(lines[i + 1]!);
        sections.push(sec);
        state = 'header';
      }
      i++;
      continue;
    }
    if (L.startsWith('@@')) {
      endBody();
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(L);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      hunk = { A: parseInt(m[1]!, 10), body: [] };
      sec.hunks.push(hunk);
      state = 'body';
      continue;
    }
    if (state === 'body' && hunk !== null) {
      const b = bodyLine(L);
      if (b !== null) {
        hunk.body.push(b);
        continue;
      }
      endBody();
      state = 'after';
    }
    if (state === 'header' && sec !== null) {
      if (L.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (L.startsWith('+++ ')) sec.pairNew = headerPath(L);
      else if (L.startsWith('rename from ')) sec.renameOld = trimSpaces(L.slice(12));
      else if (L.startsWith('rename to ')) sec.renameNew = trimSpaces(L.slice(10));
      else if (L.startsWith('new file mode')) sec.newFileMode = true;
      else if (L.startsWith('deleted file mode')) sec.deletedFileMode = true;
    }
  }
  endBody();
  return sections.map((s) => sectionEdit(s, strict));
}

// ---- SEARCH/REPLACE blocks (SPEC section 7) ----

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const f = splitFile(text);
    const m = matchTier(f.lines, oldLines, strict);
    if (m === null) throw new Fail('no-match', path);
    if (m.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = m.occ[0]!;
    const F = leadWs(f.lines[pos]!);
    const P = leadWs(oldLines[0]!);
    const seg = newLines.map((t) => (m.tier === 2 ? reindent(t, F, P) : t));
    const cur = [...f.lines.slice(0, pos), ...seg, ...f.lines.slice(pos + oldLines.length)];
    tree.now.set(path, joinFile({ lines: cur, br: f.br, final: f.final }));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let j = i + 1;
    while (j < lines.length && lines[j]!.trimEnd() !== '=======' && lines[j]!.trimEnd() !== '>>>>>>> REPLACE') j++;
    if (j >= lines.length || lines[j]!.trimEnd() !== '=======') throw new Exit2(`error: parse ${searchLine}`);
    let k = j + 1;
    while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') k++;
    if (k >= lines.length) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, j);
    const newLines = lines.slice(j + 1, k);
    let path: string | null = null;
    for (let t = i - 1; t >= searchFrom; t--) {
      const tr = lines[t]!.trim();
      if (tr === '' || tr.startsWith('```')) continue;
      path = tr;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    prevPath = path;
    edits.push(srEdit(path, oldLines, newLines, strict));
    searchFrom = k + 1;
    i = k + 1;
  }
  return edits;
}

// ---- V4A patches (SPEC section 8) ----

interface Chunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

function findAnchor(lines: string[], anchor: string, strict: boolean, from: number): number {
  for (const tier of tiersFor(strict)) {
    for (let i = from; i < lines.length; i++) {
      if (eqTier(lines[i]!, anchor, tier)) return i;
    }
  }
  return -1;
}

function applyChunks(text: string, chunks: Chunk[], strict: boolean, path: string): string {
  const f = splitFile(text);
  let cur = f.lines;
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      const found = findAnchor(cur, ch.anchor, strict, cursor);
      if (found < 0) throw new Fail('no-match', path);
      cursor = found + 1;
    }
    const block = toBlock(ch.body);
    const O = block.oList;
    if (O.length === 0) {
      const pos = ch.eof ? cur.length : Math.min(cursor, cur.length);
      const seg = block.nList.map((n) => n.text);
      cur = [...cur.slice(0, pos), ...seg, ...cur.slice(pos)];
      cursor = pos + seg.length;
    } else {
      const m = matchTier(cur, O, strict, cursor, ch.eof);
      if (m === null) throw new Fail('no-match', path);
      const pos = m.occ[0]!;
      const seg = buildSegment(cur, pos, block, m.tier);
      cur = [...cur.slice(0, pos), ...seg, ...cur.slice(pos + O.length)];
      cursor = pos + seg.length;
    }
  }
  return joinFile({ lines: cur, br: f.br, final: f.final });
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && blank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  interface RawSection {
    kind: 'add' | 'delete' | 'update';
    path: string;
    headerLine: number;
    body: { line: string; no: number }[];
  }
  const raw: RawSection[] = [];
  let cur: RawSection | null = null;
  for (let i = first + 1; i < last; i++) {
    const L = lines[i]!;
    if (L.startsWith('*** Add File: ')) {
      cur = { kind: 'add', path: trimSpaces(L.slice(14)), headerLine: i + 1, body: [] };
      raw.push(cur);
    } else if (L.startsWith('*** Delete File: ')) {
      cur = { kind: 'delete', path: trimSpaces(L.slice(17)), headerLine: i + 1, body: [] };
      raw.push(cur);
    } else if (L.startsWith('*** Update File: ')) {
      cur = { kind: 'update', path: trimSpaces(L.slice(17)), headerLine: i + 1, body: [] };
      raw.push(cur);
    } else if (cur === null) {
      if (!blank(L)) throw new Exit2(`error: parse ${i + 1}`);
    } else {
      cur.body.push({ line: L, no: i + 1 });
    }
  }
  for (const s of raw) {
    while (s.body.length > 0 && blank(s.body[s.body.length - 1]!.line)) s.body.pop();
  }
  const edits: Edit[] = [];
  for (const s of raw) {
    if (s.kind === 'add') {
      const fileLines: string[] = [];
      for (const b of s.body) {
        if (b.line.startsWith('+')) fileLines.push(b.line.slice(1));
        else if (b.line === '') fileLines.push('');
        else throw new Exit2(`error: parse ${b.no}`);
      }
      const path = s.path;
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
    } else if (s.kind === 'delete') {
      if (s.body.length > 0) throw new Exit2(`error: parse ${s.body[0]!.no}`);
      const path = s.path;
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      let moveTo: string | null = null;
      let idx = 0;
      if (s.body.length > 0 && s.body[0]!.line.startsWith('*** Move to: ')) {
        moveTo = trimSpaces(s.body[0]!.line.slice(13));
        idx = 1;
      }
      const chunks: Chunk[] = [];
      let chunk: Chunk | null = null;
      for (; idx < s.body.length; idx++) {
        const { line: L, no } = s.body[idx]!;
        if (L.startsWith('@@')) {
          const anchor = trimSpaces(L.slice(2));
          chunk = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          chunks.push(chunk);
        } else if (L === '*** End of File') {
          if (chunk === null) throw new Exit2(`error: parse ${no}`);
          chunk.eof = true;
          chunk = null;
        } else {
          const b = bodyLine(L);
          if (b === null || b.kind === 'bs') throw new Exit2(`error: parse ${no}`);
          if (chunk === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${no}`);
            chunk = { anchor: null, eof: false, body: [] };
            chunks.push(chunk);
          }
          chunk.body.push(b);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${s.headerLine}`);
      const path = s.path;
      edits.push((tree, moves) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        const text = tree.get(path);
        if (text === null) throw new Fail('missing', path);
        if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
        const out = applyChunks(text, chunks, strict, path);
        if (moveTo !== null) {
          tree.now.set(moveTo, out);
          tree.now.set(path, null);
          moves.push({ old: path, new: moveTo });
        } else {
          tree.now.set(path, out);
        }
      });
    }
  }
  return edits;
}

// ---- JSON edits (SPEC section 9) ----

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
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
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

// ---- Invocation, output and exit codes (SPEC sections 1, 2 and 10) ----

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
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const moves: Move[] = [];
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = moves.length;
    try {
      edit(tree, moves);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const consumed = new Set<string>();
  const rByNew = new Map<string, string>();
  for (const mv of moves) {
    if (consumed.has(mv.old) || consumed.has(mv.new)) continue;
    const oldWas = tree.original(mv.old);
    const oldNow = tree.get(mv.old);
    const newWas = tree.original(mv.new);
    const newNow = tree.get(mv.new);
    if (oldWas !== null && oldNow === null && newWas === null && newNow !== null) {
      rByNew.set(mv.new, `R ${mv.old} -> ${mv.new}`);
      consumed.add(mv.old);
      consumed.add(mv.new);
    }
  }
  const rows: string[] = [];
  const writes: { p: string; now: string | null }[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (rByNew.has(p)) rows.push(rByNew.get(p)!);
    else if (!consumed.has(p) && was !== now) rows.push(`${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
    if (was !== now) writes.push({ p, now });
  }
  if (!check) {
    for (const w of writes) {
      if (w.now === null) rmSync(w.p, { force: true });
      else {
        mkdirSync(dirname(w.p), { recursive: true });
        writeFileSync(w.p, w.now);
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
