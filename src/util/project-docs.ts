/**
 * Project documentation discovery.
 *
 * Scans the repository root for well-known project documentation files
 * (README.md, AGENTS.md, CLAUDE.md) that may provide useful context
 * for intent expansion.
 *
 * Per spec: if no tagged files exist and any of these docs exist, the
 * user must be asked whether to include them before expansion proceeds.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Well-known project doc filenames
// ---------------------------------------------------------------------------

export const PROJECT_DOC_FILENAMES = ['README.md', 'AGENTS.md', 'CLAUDE.md'] as const;

export type ProjectDocFilename = (typeof PROJECT_DOC_FILENAMES)[number];

// ---------------------------------------------------------------------------
// Discovery result
// ---------------------------------------------------------------------------

export interface DiscoveredProjectDoc {
  filename: ProjectDocFilename;
  path: string;
}

// ---------------------------------------------------------------------------
// Discovery function
// ---------------------------------------------------------------------------

/**
 * Discover which well-known project documentation files exist at the
 * given repository root.
 *
 * Returns only files that actually exist on disk.
 */
export function discoverProjectDocs(repoRoot: string): DiscoveredProjectDoc[] {
  const results: DiscoveredProjectDoc[] = [];
  for (const filename of PROJECT_DOC_FILENAMES) {
    const fullPath = resolve(repoRoot, filename);
    if (existsSync(fullPath)) {
      results.push({ filename, path: fullPath });
    }
  }
  return results;
}
