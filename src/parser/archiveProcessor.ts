/**
 * Generic content-based file discovery inside extracted archives.
 *
 * Classifies files by inspecting their content (not their path) and
 * runs them through the appropriate parsing pipeline. Works with any
 * archive layout: MTV must-gather, cluster must-gather, `oc adm inspect`,
 * namespace dumps, etc.
 */

import type { TarEntry } from './tarExtractor';
import type { ParsedData, ArchiveResult } from '../types';
import { extractArchive } from './tarExtractor';
import { parseLogFile } from './logParser';
import { parsePlanYaml } from './planYamlParser';
import { mergeResults } from './mergeResults';

export type { ArchiveResult };

// ── Content-based classifiers ──────────────────────────────────────────────

/** Signatures that identify forklift-controller JSON log lines */
const LOG_SIGNATURES = [
  '"logger":"plan|',
  '"logger": "plan|',
  '"controller":"plan"',
  '"controller": "plan"',
];

/**
 * Check whether a file looks like forklift-controller JSON log output.
 *
 * Primary check: content contains one of the distinctive log signatures.
 * Fallback: the path mentions "forklift-controller" and the first
 * non-empty line starts with '{' (JSON lines).
 */
function isForkliftLogFile(entry: TarEntry): boolean {
  // Quick content-based check (most reliable)
  for (const sig of LOG_SIGNATURES) {
    if (entry.content.includes(sig)) return true;
  }

  // Fallback: path hint + JSON-lines shape
  if (entry.path.toLowerCase().includes('forklift-controller')) {
    const firstLine = entry.content.trimStart().split('\n')[0]?.trim();
    if (firstLine?.startsWith('{')) return true;
  }

  return false;
}

/**
 * Patterns that identify Plan Kubernetes resources from forklift.
 * Both `kind: Plan` / `kind:Plan` variants are covered.
 */
const PLAN_KIND_RE = /kind:\s*Plan\b/;
const FORKLIFT_API_RE = /forklift\.konveyor\.io/;

/**
 * Check whether a file contains a Forklift Plan YAML resource.
 */
function isPlanYamlFile(entry: TarEntry): boolean {
  const c = entry.content;
  return PLAN_KIND_RE.test(c) && FORKLIFT_API_RE.test(c);
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Process an uploaded archive file end-to-end:
 *   1. Extract (recursively for nested tars)
 *   2. Classify files by content
 *   3. Parse with the appropriate pipeline(s)
 *   4. Merge and return
 */
export async function processArchive(file: File): Promise<ArchiveResult> {
  try {
    return await processArchiveImpl(file);
  } catch (err) {
    console.error('processArchive failed:', err);
    return {
      logFiles: [],
      yamlFiles: [],
      parsedData: mergeResults(null, null),
    };
  }
}

async function processArchiveImpl(file: File): Promise<ArchiveResult> {
  // 1. Extract all files (handles nested tars/gzips)
  const entries = await extractArchive(file);

  // 2. Classify
  const logEntries: TarEntry[] = [];
  const yamlEntries: TarEntry[] = [];

  for (const entry of entries) {
    if (isForkliftLogFile(entry)) {
      logEntries.push(entry);
    } else if (isPlanYamlFile(entry)) {
      yamlEntries.push(entry);
    }
  }

  // 3. Parse each category
  let logResult: ParsedData | null = null;
  let yamlResult: ParsedData | null = null;

  if (logEntries.length > 0) {
    const combined = logEntries.map((e) => e.content).join('\n');
    logResult = parseLogFile(combined);
  }

  if (yamlEntries.length > 0) {
    const combined = yamlEntries.map((e) => e.content).join('\n---\n');
    yamlResult = parsePlanYaml(combined);
  }

  // 4. Merge
  const parsedData = mergeResults(logResult, yamlResult);

  return {
    logFiles: logEntries.map((e) => e.path),
    yamlFiles: yamlEntries.map((e) => e.path),
    parsedData,
  };
}
