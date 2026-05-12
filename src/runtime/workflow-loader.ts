/**
 * Workflow-spec markdown loader.
 *
 * Parses the bounded subset of YAML used by `piorx/workflow-spec@1` markdown
 * frontmatter into a runtime artifact object that `validateArtifact()` can
 * accept.  The on-disk format is documented in
 * `docs/composability.md` "2. WorkflowSpec — declarative workflow as a
 * first-class typed artifact": markdown body plus YAML frontmatter, with
 * `kind:` carrying the artifact-type discriminator (YAML reserves a leading
 * `@` so `artifact_type:` would need quoting).
 *
 * The supported YAML subset covers exactly what the workflow spec needs:
 * scalar key/value pairs, block-style mappings, block-style sequences of
 * scalars, and block-style sequences of mappings (each leading with a
 * `- key: value` line).  Inline flow syntax (`{a: 1}`, `[a, b]`), anchors,
 * tags, multi-document streams, and folded scalars are intentionally not
 * supported; if a spec needs them, surface a parser error rather than
 * silently misinterpret.
 *
 * The parser is structural-only — it does not validate the workflow shape.
 * Callers feed the resulting object to `validateArtifact()` (artifact kernel)
 * and then to the `WorkflowRegistry` for referential checks.
 */

import { readFileSync } from 'node:fs';
import { generateArtifactId } from '../artifacts/ids.ts';
import type { WorkflowSpecV1 } from '../artifacts/types.ts';

// ---------------------------------------------------------------------------
// Frontmatter extraction
// ---------------------------------------------------------------------------

interface SplitMarkdown {
  frontmatter: string;
  body: string;
}

function splitFrontmatter(text: string): SplitMarkdown {
  // Normalize CRLF so the `---` fence detection is line-platform-agnostic.
  const normalized = text.replace(/\r\n?/g, '\n');
  if (!normalized.startsWith('---\n')) {
    throw new Error('workflow markdown: missing leading "---" frontmatter fence');
  }
  const closeIdx = normalized.indexOf('\n---\n', 4);
  if (closeIdx === -1) {
    throw new Error('workflow markdown: missing closing "---" frontmatter fence');
  }
  return {
    frontmatter: normalized.slice(4, closeIdx),
    body: normalized.slice(closeIdx + 5),
  };
}

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

type Line =
  | { kind: 'kv-scalar'; key: string; value: string; indent: number; lineNo: number }
  | { kind: 'kv-block'; key: string; indent: number; lineNo: number }
  | { kind: 'list-scalar'; value: string; indent: number; lineNo: number }
  | { kind: 'list-kv'; key: string; value: string; indent: number; lineNo: number }
  | { kind: 'list-kv-block'; key: string; indent: number; lineNo: number };

function stripTrailingComment(content: string): string {
  // YAML comments start with " #" or are at the start of a line. We only need
  // to handle inline comments preceded by whitespace; full-line comments are
  // dropped during tokenization. Quotes are preserved so a `#` inside a quoted
  // string survives.
  let out = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    const prev = i > 0 ? content[i - 1] : '';
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (
      ch === '#' &&
      !inSingle &&
      !inDouble &&
      (prev === ' ' || prev === '\t' || prev === '')
    ) {
      break;
    }
    out += ch;
  }
  return out.trimEnd();
}

function classifyLine(raw: string, lineNo: number): Line | null {
  if (raw.trim() === '' || raw.trimStart().startsWith('#')) {
    return null;
  }
  const indent = raw.length - raw.trimStart().length;
  const content = stripTrailingComment(raw.slice(indent));
  if (content.length === 0) return null;

  if (content.startsWith('- ') || content === '-') {
    const rest = content === '-' ? '' : content.slice(2);
    if (rest === '') {
      throw new Error(`yaml line ${lineNo}: empty list item not supported`);
    }
    // Detect a list-kv vs list-scalar by looking for a top-level `: ` outside
    // any quoted segment.
    const colonIdx = findKeyValueColon(rest);
    if (colonIdx !== -1) {
      const key = rest.slice(0, colonIdx).trim();
      const valueRaw = rest.slice(colonIdx + 1).trim();
      if (valueRaw === '') {
        return { indent, kind: 'list-kv-block', key, lineNo };
      }
      return { indent, kind: 'list-kv', key, value: valueRaw, lineNo };
    }
    return { indent, kind: 'list-scalar', value: rest, lineNo };
  }

  const colonIdx = findKeyValueColon(content);
  if (colonIdx === -1) {
    throw new Error(`yaml line ${lineNo}: expected mapping or list, got "${content}"`);
  }
  const key = content.slice(0, colonIdx).trim();
  const value = content.slice(colonIdx + 1).trim();
  if (value === '') {
    return { indent, kind: 'kv-block', key, lineNo };
  }
  return { indent, kind: 'kv-scalar', key, value, lineNo };
}

/**
 * Locate the `:` that separates a YAML key from its value, ignoring colons
 * that appear inside quoted strings or as part of the artifact-id syntax
 * (`piorx/intent-capture@1` has no colon, but values like
 * `Stage 1 — Restatement` are fine — they contain no colon either).
 *
 * Real YAML allows `:` inside an unquoted plain scalar only when it is not
 * followed by whitespace. We adopt the simpler "first `: ` outside quotes"
 * rule that matches every line in the bounded subset we support.
 */
function findKeyValueColon(text: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === ':' && !inSingle && !inDouble) {
      const next = text[i + 1];
      if (next === undefined || next === ' ' || next === '\t') {
        return i;
      }
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Scalar parsing
// ---------------------------------------------------------------------------

function parseScalar(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === '') return '';

  // Quoted strings — single or double quotes preserve content verbatim.
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1);
  }

  // Booleans and null per YAML 1.2 core schema (case-sensitive subset).
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null' || trimmed === '~') return null;

  // Numbers — integers and decimals only; the workflow spec uses neither
  // today, but the parser tolerates them so future fields (e.g. budget caps)
  // do not need a parser change.
  if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  if (/^-?\d+\.\d+$/.test(trimmed)) return Number.parseFloat(trimmed);

  // Plain scalar — keep verbatim. The workflow spec uses unquoted artifact
  // ids (`piorx/intent-capture@1`) and human prose (`Stage 1 — Restatement`)
  // here.
  return trimmed;
}

// ---------------------------------------------------------------------------
// Recursive-descent assembly
// ---------------------------------------------------------------------------

class Cursor {
  private pos = 0;
  constructor(private readonly lines: Line[]) {}

  peek(): Line | undefined {
    return this.lines[this.pos];
  }

  next(): Line | undefined {
    return this.lines[this.pos++];
  }

  rewind(): void {
    this.pos--;
  }

  done(): boolean {
    return this.pos >= this.lines.length;
  }
}

function parseMapping(cursor: Cursor, baseIndent: number): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  while (!cursor.done()) {
    const line = cursor.peek()!;
    if (line.indent < baseIndent) break;
    if (line.indent > baseIndent) {
      throw new Error(`yaml line ${line.lineNo}: unexpected indent inside mapping`);
    }
    if (line.kind === 'kv-scalar') {
      cursor.next();
      obj[line.key] = parseScalar(line.value);
    } else if (line.kind === 'kv-block') {
      cursor.next();
      obj[line.key] = parseBlockChildren(cursor, line.indent, line.lineNo);
    } else {
      throw new Error(`yaml line ${line.lineNo}: list item not allowed inside a mapping`);
    }
  }
  return obj;
}

function parseBlockChildren(cursor: Cursor, parentIndent: number, parentLineNo: number): unknown {
  const next = cursor.peek();
  if (!next || next.indent <= parentIndent) {
    throw new Error(
      `yaml line ${parentLineNo}: block "${(next?.indent ?? -1) <= parentIndent ? 'empty' : ''}" expected child content`,
    );
  }
  if (next.kind === 'list-scalar' || next.kind === 'list-kv' || next.kind === 'list-kv-block') {
    return parseSequence(cursor, next.indent);
  }
  return parseMapping(cursor, next.indent);
}

function parseSequence(cursor: Cursor, baseIndent: number): unknown[] {
  const arr: unknown[] = [];
  while (!cursor.done()) {
    const line = cursor.peek()!;
    if (line.indent < baseIndent) break;
    if (line.indent > baseIndent) {
      throw new Error(`yaml line ${line.lineNo}: unexpected indent inside sequence`);
    }
    if (line.kind === 'list-scalar') {
      cursor.next();
      arr.push(parseScalar(line.value));
      continue;
    }
    if (line.kind === 'list-kv' || line.kind === 'list-kv-block') {
      cursor.next();
      // The list-kv line begins an inline mapping. Its own key is at
      // (baseIndent + 2) effective indent; subsequent continuation lines for
      // the same item appear at exactly that indent.
      const obj: Record<string, unknown> = {};
      const childIndent = baseIndent + 2;
      if (line.kind === 'list-kv') {
        obj[line.key] = parseScalar(line.value);
      } else {
        obj[line.key] = parseBlockChildren(cursor, childIndent, line.lineNo);
      }
      // Consume continuation lines for the same mapping at childIndent.
      while (!cursor.done()) {
        const cont = cursor.peek()!;
        if (cont.indent !== childIndent) break;
        if (cont.kind === 'kv-scalar') {
          cursor.next();
          obj[cont.key] = parseScalar(cont.value);
        } else if (cont.kind === 'kv-block') {
          cursor.next();
          obj[cont.key] = parseBlockChildren(cursor, cont.indent, cont.lineNo);
        } else {
          break;
        }
      }
      arr.push(obj);
      continue;
    }
    throw new Error(`yaml line ${line.lineNo}: expected list item`);
  }
  return arr;
}

// ---------------------------------------------------------------------------
// Top-level entrypoints
// ---------------------------------------------------------------------------

/**
 * Parse a YAML frontmatter string into a plain JS object. The input is the
 * content between the leading and trailing `---` fences, exclusive.
 *
 * Throws on malformed input — the caller is expected to feed the result to
 * `validateArtifact()` for shape validation. Parser errors include a line
 * number in the frontmatter (1-indexed against the raw frontmatter, not the
 * surrounding markdown file).
 */
export function parseWorkflowFrontmatter(yaml: string): Record<string, unknown> {
  const rawLines = yaml.split('\n');
  const lines: Line[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const line = classifyLine(rawLines[i]!, i + 1);
    if (line) lines.push(line);
  }
  if (lines.length === 0) {
    throw new Error('workflow markdown: empty frontmatter');
  }
  const baseIndent = lines[0]!.indent;
  if (baseIndent !== 0) {
    throw new Error(`workflow markdown: top-level frontmatter must start at column 0`);
  }
  const cursor = new Cursor(lines);
  return parseMapping(cursor, 0);
}

/**
 * Parse a workflow markdown file (frontmatter + body) into a runtime
 * `WorkflowSpecV1` artifact suitable for `validateArtifact()` and the
 * `WorkflowRegistry`. The body is preserved on the artifact so downstream
 * consumers (agent-readability tests, workflow-spec inspectors) can read the
 * natural-language description without re-loading the file.
 *
 * `kind:` from the frontmatter is translated to `artifact_type:` (the YAML
 * reserved-character workaround documented in `docs/composability.md` and
 * the COMP-P1-T6 dev log). An `artifact_id` is generated deterministically
 * for the loaded spec — the workflow's logical id (`spec.id`) stays
 * stable across reloads, but `artifact_id` is fresh so the registry's
 * boot-time identity is distinct from any prior run's persisted artifact.
 */
export function parseWorkflowMarkdown(markdown: string): WorkflowSpecV1 & { body: string } {
  const { frontmatter, body } = splitFrontmatter(markdown);
  const parsed = parseWorkflowFrontmatter(frontmatter);

  const kind = parsed.kind;
  if (typeof kind !== 'string') {
    throw new Error('workflow markdown: missing required `kind:` discriminator');
  }
  if (kind !== 'piorx/workflow-spec@1') {
    throw new Error(
      `workflow markdown: unsupported kind "${kind}" (expected "piorx/workflow-spec@1")`,
    );
  }
  delete parsed.kind;

  const artifact: Record<string, unknown> = {
    artifact_type: 'piorx/workflow-spec@1',
    artifact_id: generateArtifactId('piorx/workflow-spec@1'),
    ...parsed,
    body,
  };

  return artifact as unknown as WorkflowSpecV1 & { body: string };
}

/**
 * Read a workflow markdown file from disk and parse it into a runtime
 * artifact. The caller is responsible for validating the result against the
 * artifact kernel and the registry's referential checks.
 */
export function loadWorkflowFromFile(filePath: string): WorkflowSpecV1 & { body: string } {
  const text = readFileSync(filePath, 'utf-8');
  return parseWorkflowMarkdown(text);
}
