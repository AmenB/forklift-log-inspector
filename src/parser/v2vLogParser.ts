import type {
  V2VParsedData,
  V2VToolRun,
  V2VLogType,
  LibguestfsInfo,
} from '../types/v2v';

import { inferExitStatus } from './v2v/v2vHelpers';

import {
  createParseContext,
  categorizeLine,
  handleStdoutCapture,
  handlePipelineStages,
  handleMonitorProgress,
  handleVersionsAndDiskInfo,
  handleLibvirtXML,
  handleNbdkit,
  handleLibguestfsTrace,
  handleLibguestfsCmdFlush,
  handleGuestfsdScope,
  handleGuestCommands,
  handleGuestInfo,
  handleBlkid,
  handleFileCopies,
  handleErrors,
  flushPendingState,
} from './v2v/parseHandlers';

// ────────────────────────────────────────────────────────────────────────────
// Regex patterns (preprocessing / boundary detection only)
// ────────────────────────────────────────────────────────────────────────────

/** Container / k8s timestamp prefix: `2026-01-21T00:57:24.837772290Z ` */
const CONTAINER_TS_PREFIX_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+/;

/** `Building command: tool [args]` (with space, bracket args) */
const BUILD_CMD_SPACE_RE = /^Building command:\s*(\S+)\s+\[(.*)]/;

/** `Building command:tool[args]` (no space, bracket args) */
const BUILD_CMD_NOSPACE_RE = /Building command:(\S+?)\[([^\]]*)\]/g;

// ────────────────────────────────────────────────────────────────────────────
// Detection
// ────────────────────────────────────────────────────────────────────────────

/**
 * Detect whether a plain-text file is a virt-v2v / virt-v2v-inspector log.
 * Checks the first ~10 lines for characteristic markers.
 */
export function isV2VLog(content: string): boolean {
  // Look at the first 3000 chars (covers the first few lines even when they
  // are long, like the concatenated Building-command line in virt-v2v.logs).
  // Strip optional container/k8s timestamp prefixes so the markers are visible.
  const head = content
    .slice(0, 3000)
    .replace(CONTAINER_TS_PREFIX_RE, '')
    .replace(/\n\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+/g, '\n');
  // MTV wrapper: "Building command: virt-v2v [...]"
  if (/Building command[:\s]*virt-v2v/i.test(head)) return true;
  // MTV info prefix: "info: virt-v2v ..."
  if (/^info:\s*virt-v2v/m.test(head)) return true;
  // Raw virt-v2v output: "virt-v2v: ..." (version line, stage headers, etc.)
  if (/^virt-v2v:/m.test(head)) return true;
  // Tool-specific names
  if (/virt-v2v-in-place/i.test(head)) return true;
  if (/virt-v2v-inspector/i.test(head)) return true;
  // libguestfs trace lines (present in verbose v2v output)
  if (/^libguestfs:\s+trace:/m.test(head)) return true;
  return false;
}

// ────────────────────────────────────────────────────────────────────────────
// Main parser
// ────────────────────────────────────────────────────────────────────────────

export function parseV2VLog(content: string): V2VParsedData {
  try {
    return parseV2VLogImpl(content);
  } catch (err) {
    console.error('parseV2VLog failed:', err);
    return { toolRuns: [], totalLines: 0 };
  }
}

function parseV2VLogImpl(content: string): V2VParsedData {
  const rawLines = content.split('\n');

  // Pre-process: split concatenated Building-command lines (virt-v2v.logs style)
  const lines = preprocessLines(rawLines);
  const totalLines = lines.length;

  // Identify tool-run boundaries
  const boundaries = findToolRunBoundaries(lines);

  // Parse each tool-run section
  const toolRuns: V2VToolRun[] = [];
  for (let i = 0; i < boundaries.length; i++) {
    const start = boundaries[i].lineIndex;
    const end = i + 1 < boundaries.length ? boundaries[i + 1].lineIndex : totalLines;
    const sectionLines = lines.slice(start, end);

    const toolRun = parseToolRunSection(
      sectionLines,
      boundaries[i].tool,
      boundaries[i].commandLine,
      start,
    );
    toolRuns.push(toolRun);
  }

  // If no boundaries found (e.g. log starts without Building command),
  // treat entire file as single unknown tool run
  if (toolRuns.length === 0) {
    const tool = detectToolFromContent(lines);
    const toolRun = parseToolRunSection(lines, tool, '', 0);
    toolRuns.push(toolRun);
  }

  return { toolRuns, totalLines };
}

// ────────────────────────────────────────────────────────────────────────────
// Pre-processing
// ────────────────────────────────────────────────────────────────────────────

/**
 * Handle lines that have multiple `Building command:` entries concatenated
 * on a single line (seen in virt-v2v.logs).
 */
function preprocessLines(rawLines: string[]): string[] {
  const result: string[] = [];
  for (let line of rawLines) {
    // Strip optional container / k8s timestamp prefix
    // e.g. "2026-01-21T00:57:24.837772290Z Building command: ..."
    line = line.replace(CONTAINER_TS_PREFIX_RE, '');

    // Check if line has multiple Building command: entries
    const parts = splitConcatenatedBuildCommands(line);
    if (parts.length > 1) {
      result.push(...parts);
      continue;
    }

    // Recover corrupted lines where libguestfs trace is embedded after a
    // garbled prefix (e.g. "guestfsd: =libguestfs: trace: ..." or
    // "gulibguestfs: trace: ..."). Extract the trace part as a separate line.
    if (!line.startsWith('libguestfs:') && line.includes('libguestfs: trace:')) {
      const traceIdx = line.indexOf('libguestfs: trace:');
      const prefix = line.slice(0, traceIdx).trim();
      const tracePart = line.slice(traceIdx);
      if (prefix) result.push(prefix);
      result.push(tracePart);
      continue;
    }

    // Handle interleaved libguestfs trace lines within a single line, e.g.:
    // "libguestfs: trace: v2v: aug_setlibguestfs: trace: v2v: aug_get ..."
    // Split at the second occurrence of "libguestfs: trace:"
    if (line.startsWith('libguestfs: trace:')) {
      const secondIdx = line.indexOf('libguestfs: trace:', 1);
      if (secondIdx > 0) {
        result.push(line.slice(0, secondIdx).trim());
        result.push(line.slice(secondIdx));
        continue;
      }
    }

    result.push(line);
  }
  return result;
}

function splitConcatenatedBuildCommands(line: string): string[] {
  // Match all `Building command:name[args]` in the line
  const matches = [...line.matchAll(BUILD_CMD_NOSPACE_RE)];
  if (matches.length <= 1) {
    // Also check for `Building command: name [args]` style
    const spaceMatch = line.match(/Building command:/g);
    if (!spaceMatch || spaceMatch.length <= 1) return [line];
  }

  // Split by `Building command:` boundaries
  const parts: string[] = [];
  const indices: number[] = [];
  let searchFrom = 0;

  while (true) {
    const idx = line.indexOf('Building command:', searchFrom);
    if (idx === -1) break;
    indices.push(idx);
    searchFrom = idx + 17; // length of "Building command:"
  }

  for (let i = 0; i < indices.length; i++) {
    const start = indices[i];
    const end = i + 1 < indices.length ? indices[i + 1] : line.length;
    const part = line.slice(start, end).trim();
    if (part) parts.push(part);
  }

  // If there's content before the first Building command:, keep it
  if (indices.length > 0 && indices[0] > 0) {
    const prefix = line.slice(0, indices[0]).trim();
    if (prefix) parts.unshift(prefix);
  }

  return parts.length > 0 ? parts : [line];
}

// ────────────────────────────────────────────────────────────────────────────
// Boundary detection
// ────────────────────────────────────────────────────────────────────────────

interface ToolBoundary {
  lineIndex: number;
  tool: V2VLogType;
  commandLine: string;
}

function findToolRunBoundaries(lines: string[]): ToolBoundary[] {
  const boundaries: ToolBoundary[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // `Building command: tool [args]`
    const spaceMatch = line.match(BUILD_CMD_SPACE_RE);
    if (spaceMatch) {
      const tool = classifyTool(spaceMatch[1]);
      if (tool) {
        boundaries.push({ lineIndex: i, tool, commandLine: spaceMatch[2] });
        continue;
      }
    }

    // `Building command:tool[args]`
    BUILD_CMD_NOSPACE_RE.lastIndex = 0;
    const noSpaceMatch = BUILD_CMD_NOSPACE_RE.exec(line);
    if (noSpaceMatch) {
      const tool = classifyTool(noSpaceMatch[1]);
      if (tool) {
        boundaries.push({ lineIndex: i, tool, commandLine: noSpaceMatch[2] });
        continue;
      }
    }
  }

  return boundaries;
}

function classifyTool(name: string): V2VLogType | null {
  const lower = name.toLowerCase();
  if (lower === 'virt-v2v-in-place') return 'virt-v2v-in-place';
  if (lower === 'virt-v2v-inspector') return 'virt-v2v-inspector';
  if (lower === 'virt-v2v-customize' || lower === 'virt-customize')
    return 'virt-v2v-customize';
  if (lower === 'virt-v2v') return 'virt-v2v';
  // Skip monitor and other non-main tools
  if (lower.includes('monitor')) return null;
  // Fallback: if it contains virt-v2v
  if (lower.includes('virt-v2v')) return 'virt-v2v';
  return null;
}

function detectToolFromContent(lines: string[]): V2VLogType {
  const head = lines.slice(0, 20).join('\n');
  if (/virt-v2v-in-place/i.test(head)) return 'virt-v2v-in-place';
  if (/virt-v2v-inspector/i.test(head)) return 'virt-v2v-inspector';
  if (/virt-v2v-customize|virt-customize/i.test(head)) return 'virt-v2v-customize';
  return 'virt-v2v';
}

// ────────────────────────────────────────────────────────────────────────────
// Section parser
// ────────────────────────────────────────────────────────────────────────────

function parseToolRunSection(
  sectionLines: string[],
  tool: V2VLogType,
  commandLine: string,
  globalLineOffset: number,
): V2VToolRun {
  const ctx = createParseContext(sectionLines, globalLineOffset);

  for (let i = 0; i < sectionLines.length; i++) {
    const line = sectionLines[i];
    const globalLine = globalLineOffset + i;

    if (!line.trim()) {
      ctx.lineCategories.push('other');
      continue;
    }

    // Determine line category
    const category = categorizeLine(line);
    ctx.lineCategories.push(category);

    // Stdout capture mode — consumes the line if active
    if (handleStdoutCapture(ctx, line)) continue;

    // Pipeline stages
    handlePipelineStages(ctx, line, globalLine);

    // Monitor progress
    handleMonitorProgress(ctx, line, globalLine);

    // Component versions and host free space
    handleVersionsAndDiskInfo(ctx, line);

    // Libvirt XML capture
    handleLibvirtXML(ctx, line);

    // NBDKIT
    handleNbdkit(ctx, line, globalLine);

    // Libguestfs trace & config (includes hivex, API calls)
    handleLibguestfsTrace(ctx, line, globalLine);

    // Libguestfs command: run: continuation flush
    handleLibguestfsCmdFlush(ctx, line);

    // Guestfsd scope boundaries
    handleGuestfsdScope(ctx, line);

    // Guest commands — may consume the line (stdout header, return code)
    if (handleGuestCommands(ctx, line, globalLine)) continue;

    // Guest inspection info
    handleGuestInfo(ctx, line);

    // blkid output
    handleBlkid(ctx, line);

    // VirtIO Win / file copy tracking
    handleFileCopies(ctx, line, globalLine);

    // Errors & Warnings
    handleErrors(ctx, line, globalLine);
  }

  // Flush all pending state
  flushPendingState(ctx);

  const libguestfs: LibguestfsInfo = {
    backend: ctx.lgBackend,
    identifier: ctx.lgIdentifier,
    memsize: ctx.lgMemsize,
    smp: ctx.lgSmp,
    drives: ctx.lgDrives,
    apiCalls: ctx.lgApiCalls,
    launchLines: ctx.lgLaunchLines,
  };

  const exitStatus = inferExitStatus(ctx.stages, ctx.errors, sectionLines);

  return {
    tool,
    commandLine,
    exitStatus,
    startLine: globalLineOffset,
    endLine: globalLineOffset + sectionLines.length - 1,
    stages: ctx.stages,
    diskProgress: ctx.diskProgress,
    nbdkitConnections: ctx.nbdkitConnections,
    libguestfs,
    apiCalls: ctx.completedApiCalls,
    hostCommands: ctx.hostCommands,
    guestInfo: ctx.guestInfo,
    installedApps: ctx.installedApps,
    registryHiveAccesses: ctx.registryHiveAccesses,
    virtioWin: {
      isoPath: ctx.virtioWinIsoPath,
      fileCopies: ctx.fileCopies,
    },
    versions: ctx.versions,
    diskSummary: ctx.diskSummary,
    sourceVM: ctx.sourceVM,
    errors: ctx.errors,
    rawLines: sectionLines,
    lineCategories: ctx.lineCategories,
  };
}
