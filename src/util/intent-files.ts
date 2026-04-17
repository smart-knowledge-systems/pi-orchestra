/**
 * Helpers for extracting file references embedded in user intent text.
 *
 * pi CLI @file arguments are expanded into inline <file name="...">...</file>
 * blocks before extensions see the input. These helpers let the conductor:
 *   1. capture tagged file paths for downstream retrieval
 *   2. read inline or on-disk file content before the restatement model call
 *   3. keep the restatement prompt focused by separating request text from file text
 */

import { access, readFile } from 'node:fs/promises';
import { relative, resolve, isAbsolute } from 'node:path';
import type { IntentFileRef, IntentFileRefSource } from '../artifacts/types.ts';

const FILE_BLOCK_RE = /<file name="([^"]+)">([\s\S]*?)<\/file>/g;
const MAX_FILE_CHARS = 4000;
const MAX_TOTAL_CHARS = 12000;
const MAX_FILE_LINES = 80;

const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.txt',
  '.yaml',
  '.yml',
  '.toml',
  '.css',
  '.html',
  '.sh',
  '.bash',
  '.zsh',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.c',
  '.cpp',
  '.h',
  '.hpp',
  '.cs',
]);

export interface IntentFileReference {
  rawPath: string;
  displayPath: string;
  absolutePath: string;
  inlineContent: string;
}

export interface ExtractedIntentFiles {
  cleanedIntent: string;
  taggedFiles: string[];
  files: IntentFileReference[];
}

export interface RestatementContextFile {
  path: string;
  source: 'inline' | 'disk' | 'reference-only';
  content: string;
  truncated: boolean;
}

export interface RestatementContextResult {
  cleanedIntent: string;
  taggedFiles: string[];
  files: RestatementContextFile[];
  contextBlock: string;
}

export function toIntentFileRefs(
  files: ReadonlyArray<{ path: string; source: IntentFileRefSource }>,
): IntentFileRef[] {
  return files.map((file) => ({ path: file.path, source: file.source }));
}

function trimToBudget(
  text: string,
  maxChars: number,
  maxLines: number,
): { text: string; truncated: boolean } {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let limited = lines.slice(0, maxLines).join('\n');
  let truncated = lines.length > maxLines;
  if (limited.length > maxChars) {
    limited = limited.slice(0, maxChars);
    truncated = true;
  }
  return {
    text: limited.trim(),
    truncated,
  };
}

function normalizeDisplayPath(
  filePath: string,
  repoRoot: string,
): { displayPath: string; absolutePath: string } {
  const absolutePath = isAbsolute(filePath) ? filePath : resolve(repoRoot, filePath);
  const relativePath = relative(repoRoot, absolutePath);
  if (!relativePath.startsWith('..') && relativePath !== '') {
    return { displayPath: relativePath, absolutePath };
  }
  return { displayPath: absolutePath, absolutePath };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function looksLikeTextFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot === -1) return true;
  return TEXT_EXTENSIONS.has(lower.slice(dot));
}

export function extractIntentFiles(intentText: string, repoRoot: string): ExtractedIntentFiles {
  const files: IntentFileReference[] = [];

  const cleanedIntent = intentText
    .replace(FILE_BLOCK_RE, (_full, pathValue: string, fileBody: string) => {
      const { displayPath, absolutePath } = normalizeDisplayPath(pathValue.trim(), repoRoot);
      files.push({
        rawPath: pathValue.trim(),
        displayPath,
        absolutePath,
        inlineContent: fileBody.trim(),
      });
      return `\n[Included file: ${displayPath}]\n`;
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    cleanedIntent,
    taggedFiles: uniqueStrings(files.map((file) => file.displayPath)),
    files,
  };
}

async function maybeReadReferencedFile(
  file: IntentFileReference,
): Promise<{ content: string; source: 'inline' | 'disk' | 'reference-only' }> {
  if (file.inlineContent.length > 0) {
    return { content: file.inlineContent, source: 'inline' };
  }

  if (!looksLikeTextFile(file.absolutePath)) {
    return { content: '', source: 'reference-only' };
  }

  try {
    await access(file.absolutePath);
    const content = await readFile(file.absolutePath, 'utf-8');
    return { content, source: 'disk' };
  } catch {
    return { content: '', source: 'reference-only' };
  }
}

export async function buildRestatementContext(
  intentText: string,
  repoRoot: string,
): Promise<RestatementContextResult> {
  const extracted = extractIntentFiles(intentText, repoRoot);
  const files: RestatementContextFile[] = [];
  let remainingBudget = MAX_TOTAL_CHARS;

  for (const ref of extracted.files) {
    const loaded = await maybeReadReferencedFile(ref);
    const perFileBudget = Math.min(MAX_FILE_CHARS, remainingBudget);

    if (perFileBudget <= 0) {
      files.push({
        path: ref.displayPath,
        source: loaded.source,
        content: '',
        truncated: true,
      });
      continue;
    }

    const limited = trimToBudget(loaded.content, perFileBudget, MAX_FILE_LINES);
    remainingBudget -= limited.text.length;
    files.push({
      path: ref.displayPath,
      source: loaded.source,
      content: limited.text,
      truncated: limited.truncated,
    });
  }

  const contextLines: string[] = [];
  if (files.length > 0) {
    contextLines.push('Included files for context:');
    for (const file of files) {
      const meta = `${file.path} (${file.source}${file.truncated ? ', truncated' : ''})`;
      contextLines.push(`- ${meta}`);
      if (file.content) {
        contextLines.push('```text');
        contextLines.push(file.content);
        contextLines.push('```');
      }
    }
  }

  return {
    cleanedIntent: extracted.cleanedIntent,
    taggedFiles: extracted.taggedFiles,
    files,
    contextBlock: contextLines.join('\n').trim(),
  };
}
