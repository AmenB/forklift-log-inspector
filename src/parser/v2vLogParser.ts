import type {
  V2VParsedData,
  V2VToolRun,
  V2VLogType,
  V2VPipelineStage,
  V2VDiskProgress,
  NbdkitConnection,
  LibguestfsInfo,
  LibguestfsDrive,
  LibguestfsApiCall,
  V2VApiCall,
  V2VGuestCommand,
  V2VHostCommand,
  V2VGuestInfo,
  V2VRegistryHiveAccess,
  V2VFileCopy,
  V2VInstalledApp,
  V2VError,
  V2VLineCategory,
  V2VComponentVersions,
  V2VDiskSummary,
  V2VSourceVM,
} from '../types/v2v';

import {
  HivexSessionState,
  flushHivexSession,
  decodeHivexData,
} from './v2v/hivexParser';

import {
  finalizeNbdkit,
  NBDKIT_SOCKET_RE,
  NBDKIT_URI_RE,
  NBDKIT_PLUGIN_RE,
  NBDKIT_FILTER_RE,
  NBDKIT_FILE_RE,
  NBDKIT_SERVER_RE,
  NBDKIT_VM_RE,
  NBDKIT_TRANSPORT_RE,
  COW_FILE_SIZE_RE,
} from './v2v/nbdkitParser';

import {
  buildGuestInfo,
  parseInstalledApps,
  parseLibvirtXML,
  parseBlkidLine,
} from './v2v/guestInfoParser';

import {
  extractOriginalSize,
  extractReadFileContent,
  extractWriteContent,
} from './v2v/fileCopyParser';

import {
  categorizeLine,
  isKnownPrefix,
  isNoisyCommand,
  parseCommandArgs,
  isErrorFalsePositive,
  extractSource,
  inferExitStatus,
  buildHostCommand,
  findQueueByApiName,
  attachGuestfsdToApiCall,
  parseVersionFields,
  STAGE_RE,
  KERNEL_BOOT_RE,
  ERROR_RE,
  WARNING_RE,
  MONITOR_PROGRESS_RE,
  MONITOR_DISK_RE,
  HOST_FREE_SPACE_RE,
  LIBGUESTFS_TRACE_RE,
  LIBGUESTFS_DRIVE_RE,
  LIBGUESTFS_MEMSIZE_RE,
  LIBGUESTFS_SMP_RE,
  LIBGUESTFS_BACKEND_RE,
  LIBGUESTFS_ID_RE,
  COMMAND_RE,
  CMD_RETURN_RE,
  CMD_STDOUT_RE,
  COMMANDRVF_META_RE,
  COMMANDRVF_EXEC_RE,
  CHROOT_RE,
  LIBGUESTFS_CMD_RE,
  GUESTFSD_START_RE,
  GUESTFSD_END_RE,
} from './v2v/v2vHelpers';

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
  const stages: V2VPipelineStage[] = [];
  const diskProgress: V2VDiskProgress[] = [];
  const nbdkitConnections: NbdkitConnection[] = [];
  const errors: V2VError[] = [];
  const lineCategories: V2VLineCategory[] = [];

  // ── Hierarchical API-call tracking ──────────────────────────────
  // Completed V2VApiCall entries (with nested guest commands)
  const completedApiCalls: V2VApiCall[] = [];
  // Open (not-yet-result-matched) API calls, keyed by function name (FIFO)
  const openApiCalls = new Map<string, V2VApiCall[]>();
  // Active guestfsd scope: commands between `guestfsd: <=` and `guestfsd: =>`
  let activeGuestfsd: { name: string; commands: V2VGuestCommand[] } | null = null;
  // Host-level commands from `libguestfs: command: run:`
  const hostCommands: V2VHostCommand[] = [];

  // Libguestfs appliance state (for the info panel)
  let lgBackend = '';
  let lgIdentifier = '';
  let lgMemsize = 0;
  let lgSmp = 0;
  const lgDrives: LibguestfsDrive[] = [];
  const lgApiCalls: LibguestfsApiCall[] = [];
  const lgLaunchLines: string[] = [];

  // NBDKIT state
  let currentNbdkit: Partial<NbdkitConnection> | null = null;
  const nbdkitMap = new Map<string, NbdkitConnection>();

  // Multiline libguestfs command: run: accumulator
  let pendingLibguestfsCmd: string[] = [];
  let pendingLibguestfsCmdLine = 0;

  // State machine for capturing `command:` stdout
  let stdoutCapture: { cmdName: string } | null = null;

  // Guest OS info from `i_` prefixed lines (e.g. `i_root = /dev/sda2`)
  let guestInfo: V2VGuestInfo | null = null;
  const guestInfoRaw = new Map<string, string>();
  const blkidEntries: import('../types/v2v').V2VBlkidEntry[] = [];

  // ── Component versions ──────────────────────────────────────────
  const versions: V2VComponentVersions = {};

  // ── Disk / storage summary ────────────────────────────────────
  const diskSummary: V2VDiskSummary = { disks: [] };

  // ── Source VM (from libvirt XML) ──────────────────────────────
  let sourceVM: V2VSourceVM | null = null;
  let xmlCapture: string[] | null = null;

  // VirtIO Win / file copy tracking
  let virtioWinIsoPath: string | null = null;
  const fileCopies: V2VFileCopy[] = [];
  // Track the last read_file from virtio_win so we can pair it with the following v2v write
  let pendingVirtioWinRead: { source: string; sizeBytes: number | null; lineNumber: number } | null = null;
  // Track v2v: read_file calls so we can pair them with subsequent v2v: write to the same path
  // (guest read-modify-write pattern, e.g. /etc/hostname)
  const pendingV2VReads = new Map<string, { content: string | null; sizeBytes: number | null; lineNumber: number }>();
  // Track the path of the most recent v2v: read_file call to capture its result content
  let lastV2VReadFilePath: string | null = null;

  // Installed applications and registry hive accesses
  const installedApps: V2VInstalledApp[] = [];
  const registryHiveAccesses: V2VRegistryHiveAccess[] = [];
  // Track the current hivex session to build key paths and capture value operations
  let currentHivexSession: HivexSessionState | null = null;

  /** Regex for "HANDLE \"NAME\"" patterns in hivex trace args. */
  const HIVEX_HANDLE_NAME_RE = /(\d+)\s+"([^"]+)"/;
  /** Regex for quoted string results in hivex trace args. */
  const HIVEX_QUOTED_STRING_RE = /^"(.*)"$/;

  /** Flush the current hivex traversal path and reset for a new traversal. */
  function resetHivexTraversal(
    session: HivexSessionState,
    overrides?: { hasWriteOp?: boolean; firstWriteLine?: number; lineNumber?: number },
  ): void {
    flushHivexSession(session, registryHiveAccesses);
    session.keySegments = [];
    session.values = [];
    session.pendingGetValueName = null;
    session.pendingChildName = null;
    session.pendingChildParent = null;
    session.hasWriteOp = overrides?.hasWriteOp ?? false;
    session.firstWriteLine = overrides?.firstWriteLine ?? 0;
    if (overrides?.lineNumber !== undefined) {
      session.lineNumber = overrides.lineNumber;
    }
  }

  /** Add a guest command to the active guestfsd scope (or to the most recent open API call). */
  function addGuestCommand(cmd: V2VGuestCommand) {
    if (activeGuestfsd) {
      activeGuestfsd.commands.push(cmd);
    } else {
      // No guestfsd scope open — attach to most recent open API call directly
      const allOpen = [...openApiCalls.values()];
      const lastQueue = allOpen[allOpen.length - 1];
      if (lastQueue && lastQueue.length > 0) {
        lastQueue[lastQueue.length - 1].guestCommands.push(cmd);
      }
    }
  }

  /** Find the last guest command matching a name (for return codes / stdout). */
  function findLastGuestCommand(cmdName: string): V2VGuestCommand | undefined {
    // Search active guestfsd scope first
    if (activeGuestfsd) {
      for (let j = activeGuestfsd.commands.length - 1; j >= 0; j--) {
        if (activeGuestfsd.commands[j].command === cmdName) return activeGuestfsd.commands[j];
      }
    }
    // Then search all open API calls
    for (const queue of openApiCalls.values()) {
      for (let q = queue.length - 1; q >= 0; q--) {
        const cmds = queue[q].guestCommands;
        for (let j = cmds.length - 1; j >= 0; j--) {
          if (cmds[j].command === cmdName) return cmds[j];
        }
      }
    }
    // Finally search completed API calls
    for (let a = completedApiCalls.length - 1; a >= 0; a--) {
      const cmds = completedApiCalls[a].guestCommands;
      for (let j = cmds.length - 1; j >= 0; j--) {
        if (cmds[j].command === cmdName) return cmds[j];
      }
    }
    return undefined;
  }

  for (let i = 0; i < sectionLines.length; i++) {
    const line = sectionLines[i];
    const globalLine = globalLineOffset + i;

    if (!line.trim()) {
      lineCategories.push('other');
      continue;
    }

    // Determine line category
    const category = categorizeLine(line);
    lineCategories.push(category);

    // ── Stdout capture mode ──────────────────────────────────────────
    if (stdoutCapture) {
      if (isKnownPrefix(line)) {
        stdoutCapture = null;
        // Fall through to normal parsing
      } else {
        const cmd = findLastGuestCommand(stdoutCapture.cmdName);
        if (cmd) cmd.stdoutLines.push(line);
        continue;
      }
    }

    // ── Pipeline stages ──────────────────────────────────────────────
    if (!KERNEL_BOOT_RE.test(line)) {
      const stageMatch = line.match(STAGE_RE);
      if (stageMatch) {
        stages.push({
          name: stageMatch[2].trim(),
          elapsedSeconds: parseFloat(stageMatch[1]),
          lineNumber: globalLine,
        });
      }
    }

    // ── Monitor progress ─────────────────────────────────────────────
    const progressMatch = line.match(MONITOR_PROGRESS_RE);
    if (progressMatch) {
      const lastDisk = diskProgress.length > 0 ? diskProgress[diskProgress.length - 1] : null;
      if (lastDisk) {
        diskProgress.push({
          diskNumber: lastDisk.diskNumber,
          totalDisks: lastDisk.totalDisks,
          percentComplete: parseInt(progressMatch[1], 10),
          lineNumber: globalLine,
        });
      }
    }

    const diskMatch = line.match(MONITOR_DISK_RE);
    if (diskMatch) {
      diskProgress.push({
        diskNumber: parseInt(diskMatch[1], 10),
        totalDisks: parseInt(diskMatch[2], 10),
        percentComplete: 0,
        lineNumber: globalLine,
      });
    }

    // ── Component versions ──────────────────────────────────────────
    parseVersionFields(line, versions);

    // ── Host free space ──────────────────────────────────────────
    if (!diskSummary.hostFreeSpace) {
      const m = line.match(HOST_FREE_SPACE_RE);
      if (m) {
        diskSummary.hostTmpDir = m[1];
        diskSummary.hostFreeSpace = parseInt(m[2], 10);
      }
    }

    // ── Libvirt XML capture ──────────────────────────────────────
    if (xmlCapture !== null) {
      xmlCapture.push(line);
      if (line.trimStart().startsWith('</domain>')) {
        sourceVM = parseLibvirtXML(xmlCapture);
        xmlCapture = null;
      }
    } else if (!sourceVM && /<domain type=/.test(line)) {
      xmlCapture = [line];
    }

    // ── NBDKIT ───────────────────────────────────────────────────────
    const isNbdkitStart =
      line.startsWith('running nbdkit:') || line.startsWith('running nbdkit ');
    if (isNbdkitStart) {
      currentNbdkit = { startLine: globalLine, logLines: [], filters: [] };
    }

    if (isNbdkitStart || line.startsWith('nbdkit:') || (currentNbdkit && line.startsWith(' '))) {
      if (currentNbdkit) {
        currentNbdkit.logLines = currentNbdkit.logLines || [];
        currentNbdkit.logLines.push(line);
        currentNbdkit.endLine = globalLine;
      }

      const socketMatch = line.match(NBDKIT_SOCKET_RE);
      if (socketMatch && currentNbdkit) currentNbdkit.socketPath = socketMatch[1];

      const uriMatch = line.match(NBDKIT_URI_RE);
      if (uriMatch && currentNbdkit) {
        currentNbdkit.uri = uriMatch[1];
        const id = currentNbdkit.socketPath || `nbdkit-${nbdkitMap.size}`;
        if (!nbdkitMap.has(id)) {
          nbdkitMap.set(id, {
            id,
            socketPath: currentNbdkit.socketPath || '',
            uri: currentNbdkit.uri || '',
            plugin: currentNbdkit.plugin || '',
            filters: currentNbdkit.filters || [],
            diskFile: currentNbdkit.diskFile || '',
            startLine: currentNbdkit.startLine || globalLine,
            endLine: globalLine,
            logLines: currentNbdkit.logLines || [],
            server: currentNbdkit.server,
            vmMoref: currentNbdkit.vmMoref,
            transportMode: currentNbdkit.transportMode,
            backingSize: currentNbdkit.backingSize,
          });
        }
      }

      const pluginMatch = line.match(NBDKIT_PLUGIN_RE);
      if (pluginMatch && currentNbdkit) currentNbdkit.plugin = pluginMatch[1];

      const filterMatch = line.match(NBDKIT_FILTER_RE);
      if (filterMatch && currentNbdkit) {
        currentNbdkit.filters = currentNbdkit.filters || [];
        if (!currentNbdkit.filters.includes(filterMatch[1])) {
          currentNbdkit.filters.push(filterMatch[1]);
        }
      }

      const fileMatch = line.match(NBDKIT_FILE_RE);
      if (fileMatch && currentNbdkit) currentNbdkit.diskFile = fileMatch[1];

      // Extended NBDKIT fields
      const serverMatch = line.match(NBDKIT_SERVER_RE);
      if (serverMatch && currentNbdkit) currentNbdkit.server = serverMatch[1];

      const vmMatch = line.match(NBDKIT_VM_RE);
      if (vmMatch && currentNbdkit) currentNbdkit.vmMoref = vmMatch[1];

      const transportMatch = line.match(NBDKIT_TRANSPORT_RE);
      if (transportMatch && currentNbdkit) currentNbdkit.transportMode = transportMatch[1];

      const cowMatch = line.match(COW_FILE_SIZE_RE);
      if (cowMatch && currentNbdkit) currentNbdkit.backingSize = parseInt(cowMatch[1], 10);
    } else if (currentNbdkit && !line.startsWith('nbdkit:')) {
      finalizeNbdkit(currentNbdkit, nbdkitMap, globalLine);
      currentNbdkit = null;
    }

    // Standalone nbdkit log lines
    if (line.startsWith('nbdkit:') && !currentNbdkit) {
      const lastConn = [...nbdkitMap.values()].pop();
      if (lastConn) {
        lastConn.logLines.push(line);
        lastConn.endLine = globalLine;
      }
    }

    // ── Libguestfs trace & config ────────────────────────────────────
    if (line.startsWith('libguestfs:')) {
      const backendMatch = line.match(LIBGUESTFS_BACKEND_RE);
      if (backendMatch) {
        lgBackend = backendMatch[1];
        lgLaunchLines.push(line);
      }

      const idMatch = line.match(LIBGUESTFS_ID_RE);
      if (idMatch) lgIdentifier = idMatch[1];

      if (line.includes('libguestfs: launch:')) lgLaunchLines.push(line);

      const traceMatch = line.match(LIBGUESTFS_TRACE_RE);
      if (traceMatch) {
        const traceHandle = traceMatch[1];
        const apiName = traceMatch[2];
        const apiArgs = traceMatch[3];

        // Extract config values
        const memMatch = apiArgs.match(LIBGUESTFS_MEMSIZE_RE);
        if (memMatch) lgMemsize = parseInt(memMatch[1], 10);

        const smpMatch = apiArgs.match(LIBGUESTFS_SMP_RE);
        if (smpMatch) lgSmp = parseInt(smpMatch[1], 10);

        const driveMatch = line.match(LIBGUESTFS_DRIVE_RE);
        if (driveMatch) {
          lgDrives.push({
            path: driveMatch[1],
            format: driveMatch[2],
            protocol: driveMatch[3],
            server: driveMatch[4],
          });
        }

        // Parse inspect_list_applications2 result
        if (apiName === 'inspect_list_applications2' && apiArgs.startsWith('=')) {
          parseInstalledApps(apiArgs, installedApps);
        }

        // Track hivex sessions: open → navigate key path → read/write values → close
        if (apiName === 'hivex_open' && !apiArgs.startsWith('=')) {
          // Flush any previous unclosed session
          flushHivexSession(currentHivexSession, registryHiveAccesses);
          const hiveMatch = apiArgs.match(/^"([^"]+)"/);
          if (hiveMatch) {
            currentHivexSession = {
              hivePath: hiveMatch[1],
              mode: apiArgs.includes('write:true') ? 'write' : 'read',
              keySegments: [],
              values: [],
              pendingGetValueName: null,
              pendingChildName: null,
              pendingChildParent: null,
              lineNumber: globalLine,
              rootHandle: '',
              hasWriteOp: false,
              firstWriteLine: 0,
            };
          }
        }

        // hivex_root resets the key path (new traversal within same session)
        if (apiName === 'hivex_root' && currentHivexSession) {
          if (apiArgs.startsWith('= ')) {
            // Return value: capture the root handle so we can detect re-navigation from root
            currentHivexSession.rootHandle = apiArgs.slice(2).trim();
          } else {
            // Call: flush any existing path data
            if (currentHivexSession.keySegments.length > 0 || currentHivexSession.values.length > 0) {
              resetHivexTraversal(currentHivexSession);
            }
          }
        }

        // hivex_node_get_child: defer adding the segment until we see the result
        if (apiName === 'hivex_node_get_child' && currentHivexSession) {
          if (apiArgs.startsWith('= ')) {
            // Result: non-zero means the child exists → commit the pending segment
            const resultVal = apiArgs.slice(2).trim();
            if (resultVal !== '0' && currentHivexSession.pendingChildName) {
              currentHivexSession.keySegments.push(currentHivexSession.pendingChildName);
            }
            // Either way, clear the pending state
            currentHivexSession.pendingChildName = null;
            currentHivexSession.pendingChildParent = null;
          } else {
            // Call: store the child name, don't add to path yet
            const childMatch = apiArgs.match(HIVEX_HANDLE_NAME_RE);
            if (childMatch) {
              const parentHandle = childMatch[1];
              const childName = childMatch[2];
              // If navigating from root again, flush current path and start fresh
              if (currentHivexSession.rootHandle && parentHandle === currentHivexSession.rootHandle && currentHivexSession.keySegments.length > 0) {
                resetHivexTraversal(currentHivexSession, { lineNumber: globalLine });
              }
              currentHivexSession.pendingChildName = childName;
              currentHivexSession.pendingChildParent = parentHandle;
            }
          }
        }

        // hivex_node_add_child extends the path with a new (created) subkey
        if (apiName === 'hivex_node_add_child' && !apiArgs.startsWith('=') && currentHivexSession) {
          currentHivexSession.hasWriteOp = true;
          if (!currentHivexSession.firstWriteLine) currentHivexSession.firstWriteLine = globalLine;
          const addMatch = apiArgs.match(HIVEX_HANDLE_NAME_RE);
          if (addMatch) {
            const parentHandle = addMatch[1];
            const childName = addMatch[2];
            // If adding from root again, flush current path and start fresh
            if (currentHivexSession.rootHandle && parentHandle === currentHivexSession.rootHandle && currentHivexSession.keySegments.length > 0) {
              resetHivexTraversal(currentHivexSession, {
                hasWriteOp: true,
                firstWriteLine: globalLine,
                lineNumber: globalLine,
              });
            }
            currentHivexSession.keySegments.push(childName);
          }
        }

        // Track read values: hivex_node_get_value NODE "NAME" → remember the value name
        if (apiName === 'hivex_node_get_value' && currentHivexSession) {
          if (apiArgs.startsWith('= ')) {
            // Result: = 0 means not found, non-zero means found (handle for hivex_value_string)
            const resultVal = apiArgs.slice(2).trim();
            if (resultVal === '0') {
              currentHivexSession.pendingGetValueName = null; // value not found
            }
            // If non-zero, keep pendingGetValueName for hivex_value_string to pick up
          } else {
            // Call: extract value name
            const valNameMatch = apiArgs.match(HIVEX_HANDLE_NAME_RE);
            if (valNameMatch) {
              currentHivexSession.pendingGetValueName = valNameMatch[2];
            }
          }
        }

        // hivex_value_string result gives us the actual read value
        if (apiName === 'hivex_value_string' && currentHivexSession) {
          if (apiArgs.startsWith('= ')) {
            const valStr = apiArgs.slice(2).trim();
            const strMatch = valStr.match(HIVEX_QUOTED_STRING_RE);
            if (strMatch && currentHivexSession.pendingGetValueName) {
              currentHivexSession.values.push({
                name: currentHivexSession.pendingGetValueName,
                value: strMatch[1],
                lineNumber: globalLine,
              });
              currentHivexSession.pendingGetValueName = null;
            }
          }
        }

        // hivex_value_value result gives us raw value data (for non-string types)
        if (apiName === 'hivex_value_value' && currentHivexSession) {
          if (apiArgs.startsWith('= ')) {
            const valStr = apiArgs.slice(2).trim();
            const strMatch = valStr.match(HIVEX_QUOTED_STRING_RE);
            if (strMatch && currentHivexSession.pendingGetValueName) {
              // Try decoding as REG_SZ (type 1) by default since we don't have the type here
              currentHivexSession.values.push({
                name: currentHivexSession.pendingGetValueName,
                value: decodeHivexData(strMatch[1], 1),
                lineNumber: globalLine,
              });
              currentHivexSession.pendingGetValueName = null;
            }
          }
        }

        // hivex_value_key result gives us the name of a value (alternative to hivex_node_get_value)
        if (apiName === 'hivex_value_key' && currentHivexSession) {
          if (apiArgs.startsWith('= ')) {
            const valStr = apiArgs.slice(2).trim();
            const strMatch = valStr.match(HIVEX_QUOTED_STRING_RE);
            if (strMatch) {
              // Store the name for a subsequent hivex_value_string/hivex_value_value to pick up
              currentHivexSession.pendingGetValueName = strMatch[1];
            }
          }
        }

        // hivex_commit flushes writes to disk — flush current session values as a checkpoint
        if (apiName === 'hivex_commit' && !apiArgs.startsWith('=') && currentHivexSession) {
          currentHivexSession.hasWriteOp = true; // commit implies writes
          if (!currentHivexSession.firstWriteLine) currentHivexSession.firstWriteLine = globalLine;
          if (currentHivexSession.values.length > 0 || currentHivexSession.keySegments.length > 0) {
            resetHivexTraversal(currentHivexSession);
          }
        }

        // hivex_node_name result — can enrich the current path if we see it
        // (usually redundant with hivex_node_get_child, so we just note it for completeness)

        // Track write values: hivex_node_set_value NODE "NAME" TYPE "DATA"
        if (apiName === 'hivex_node_set_value' && !apiArgs.startsWith('=') && currentHivexSession) {
          currentHivexSession.hasWriteOp = true;
          if (!currentHivexSession.firstWriteLine) currentHivexSession.firstWriteLine = globalLine;
          const setMatch = apiArgs.match(/^\d+\s+"([^"]+)"\s+(\d+)\s+"(.+)"$/);
          if (setMatch) {
            const valName = setMatch[1];
            const regType = parseInt(setMatch[2], 10);
            const rawData = setMatch[3];
            currentHivexSession.values.push({
              name: valName,
              value: decodeHivexData(rawData, regType),
              lineNumber: globalLine,
            });
          }
        }

        // hivex_close finalizes the session
        if (apiName === 'hivex_close' && !apiArgs.startsWith('=') && currentHivexSession) {
          flushHivexSession(currentHivexSession, registryHiveAccesses);
          currentHivexSession = null;
        }

        // Flat API call list for LibguestfsInfo panel
        if (!apiName.endsWith('=') && apiName !== '=') {
          lgApiCalls.push({ name: apiName, args: apiArgs, result: '', lineNumber: globalLine });
        } else if (apiName === '=' || apiArgs.startsWith('=')) {
          const lastCall = lgApiCalls[lgApiCalls.length - 1];
          if (lastCall) {
            lastCall.result = apiArgs.replace(/^=\s*/, '').trim() || apiName;
          }
        }

        // Hierarchical API call tracking
        const isResult = apiName === '=' || apiArgs.startsWith('=');
        if (!isResult && !apiName.endsWith('=')) {
          // This is an API call invocation
          const apiCall: V2VApiCall = {
            name: apiName,
            args: apiArgs,
            result: '',
            handle: traceHandle,
            guestCommands: [],
            lineNumber: globalLine,
          };
          const queueKey = `${traceHandle}:${apiName}`;
          const queue = openApiCalls.get(queueKey) || [];
          queue.push(apiCall);
          openApiCalls.set(queueKey, queue);
        } else {
          // This is an API call result — match it to the oldest open call of this name
          // Find the function name: either it's `name = result` or `= result` (preceded by the same name)
          let resultName = '';
          let resultValue = '';
          if (apiName === '=') {
            // `= result` — the result belongs to the most recently added lgApiCalls entry
            const lastLgCall = lgApiCalls[lgApiCalls.length - 1];
            if (lastLgCall) resultName = lastLgCall.name;
            resultValue = apiArgs.replace(/^=?\s*/, '').trim();
          } else if (apiArgs.startsWith('=')) {
            // `name = result` — but apiName captured includes trailing chars
            resultName = apiName.replace(/=$/, '');
            resultValue = apiArgs.replace(/^=\s*/, '').trim();
          }

          if (resultName) {
            const resultKey = `${traceHandle}:${resultName}`;
            const queue = openApiCalls.get(resultKey);
            if (queue && queue.length > 0) {
              const apiCall = queue.shift()!;
              apiCall.result = resultValue;
              completedApiCalls.push(apiCall);
              if (queue.length === 0) openApiCalls.delete(resultKey);
            }
          }
        }
      }

      // libguestfs command: run: (multi-line host command)
      const cmdMatch = line.match(LIBGUESTFS_CMD_RE);
      if (cmdMatch) {
        const cmdText = cmdMatch[1].trim();
        if (cmdText && !cmdText.startsWith('\\')) {
          if (pendingLibguestfsCmd.length > 0) {
            hostCommands.push(buildHostCommand(pendingLibguestfsCmd, pendingLibguestfsCmdLine));
          }
          pendingLibguestfsCmd = [cmdText];
          pendingLibguestfsCmdLine = globalLine;
        } else if (cmdText.startsWith('\\')) {
          pendingLibguestfsCmd.push(cmdText.slice(1).trim());
        }
      }
    }

    // ── Libguestfs command: run: continuation flush ──────────────────
    if (
      pendingLibguestfsCmd.length > 0 &&
      !line.startsWith('libguestfs:') &&
      !line.trim().startsWith('\\')
    ) {
      hostCommands.push(buildHostCommand(pendingLibguestfsCmd, pendingLibguestfsCmdLine));
      pendingLibguestfsCmd = [];
    }

    // ── Guestfsd scope boundaries ────────────────────────────────────
    if (line.startsWith('guestfsd:')) {
      const startMatch = line.match(GUESTFSD_START_RE);
      if (startMatch) {
        // Close any existing scope (shouldn't overlap, but be safe)
        if (activeGuestfsd) {
          attachGuestfsdToApiCall(activeGuestfsd, openApiCalls, completedApiCalls);
        }
        activeGuestfsd = { name: startMatch[1], commands: [] };
      }

      const endMatch = line.match(GUESTFSD_END_RE);
      if (endMatch) {
        const durationSecs = parseFloat(endMatch[2]);
        if (activeGuestfsd) {
          // Set duration on the matching open API call
          // guestfsd runs inside the appliance — try all known handles
          const guestfsdApiName = endMatch[1];
          const durationQueue = findQueueByApiName(openApiCalls, guestfsdApiName)
            || findQueueByApiName(openApiCalls, activeGuestfsd.name);
          if (durationQueue && durationQueue.length > 0) {
            durationQueue[0].durationSecs = durationSecs;
          }
          attachGuestfsdToApiCall(activeGuestfsd, openApiCalls, completedApiCalls);
          activeGuestfsd = null;
        } else {
          // No active scope — try to set duration on the matching API call
          const durationQueue = findQueueByApiName(openApiCalls, endMatch[1]);
          if (durationQueue && durationQueue.length > 0) {
            durationQueue[0].durationSecs = durationSecs;
          }
        }
      }
    }

    // ── Guest commands (`command:`, `commandrvf:`, `chroot:`) ────────
    if (!line.startsWith('libguestfs:') && !line.startsWith('guestfsd:')) {
      // Stdout header: `command: blkid: stdout:`
      const stdoutHeaderMatch = line.match(CMD_STDOUT_RE);
      if (stdoutHeaderMatch) {
        stdoutCapture = { cmdName: stdoutHeaderMatch[1] };
        continue;
      }

      // Return code: `command: blkid returned 0`
      const retMatch = line.match(CMD_RETURN_RE);
      if (retMatch) {
        const retCode = parseInt(retMatch[2], 10);
        const cmd = findLastGuestCommand(retMatch[1]);
        if (cmd && cmd.returnCode === undefined) cmd.returnCode = retCode;
        continue;
      }

      // Command invocation: `command: blkid '-c' ...`
      if (line.startsWith('command:')) {
        const cmdExecMatch = line.match(COMMAND_RE);
        if (cmdExecMatch) {
          const args = parseCommandArgs(cmdExecMatch[2]);
          addGuestCommand({
            command: cmdExecMatch[1],
            args,
            source: 'command',
            stdoutLines: [],
            lineNumber: globalLine,
          });
        }
      }

      // commandrvf: skip metadata lines and noisy udevadm settle commands
      if (line.startsWith('commandrvf:')) {
        if (!COMMANDRVF_META_RE.test(line)) {
          const rvfMatch = line.match(COMMANDRVF_EXEC_RE);
          if (rvfMatch && !isNoisyCommand(rvfMatch[1])) {
            const args = parseCommandArgs(rvfMatch[2]);
            addGuestCommand({
              command: rvfMatch[1],
              args,
              source: 'commandrvf',
              stdoutLines: [],
              lineNumber: globalLine,
            });
          }
        }
      }

      // chroot:
      if (line.startsWith('chroot:')) {
        const chrootMatch = line.match(CHROOT_RE);
        if (chrootMatch) {
          addGuestCommand({
            command: chrootMatch[2],
            args: [],
            source: 'chroot',
            stdoutLines: [],
            lineNumber: globalLine,
          });
        }
      }
    }

    // ── Guest inspection info (`i_root = /dev/sda2`, etc.) ─────────
    {
      const iMatch = line.match(/^i_(\w+)\s*=\s*(.+)$/);
      if (iMatch) {
        guestInfoRaw.set(iMatch[1], iMatch[2].trim());
      }

      // `inspect_get_roots:` header line: `/dev/sda2 (ntfs):` or `/dev/rhel/root (xfs):`
      const rootHeaderMatch = line.match(/^(\/dev\/\S+)\s+\(\w+\):\s*$/);
      if (rootHeaderMatch && !guestInfoRaw.has('root')) {
        guestInfoRaw.set('root', rootHeaderMatch[1]);
      }

      // `fs:` header line with role: `fs: /dev/sda1 (xfs) role: root`
      const fsHeaderMatch = line.match(/^fs:\s+(\/dev\/\S+)\s+\(\w+\)\s+role:\s+(\w+)/);
      if (fsHeaderMatch) {
        if (fsHeaderMatch[2] === 'root' && !guestInfoRaw.has('root')) {
          guestInfoRaw.set('root', fsHeaderMatch[1]);
        }
      }

      // Indented fields from the `inspect_get_roots:` structured block.
      // These serve as fallbacks when `i_` lines aren't present.
      const indentedMatch = line.match(/^\s{4}(\w[\w\s]*\w)\s*:\s*(.+)$/);
      if (indentedMatch) {
        const key = indentedMatch[1].trim();
        const val = indentedMatch[2].trim();
        // Map structured-block keys to internal keys (use _ for spaces)
        const keyMap: Record<string, string> = {
          'type': 'type',
          'distro': 'distro',
          'arch': 'arch',
          'hostname': 'hostname',
          'version': 'version',
          'product_name': 'product_name',
          'product_variant': 'product_variant',
          'package_format': 'package_format',
          'package_management': 'package_management',
          'build ID': 'build_id',
          'fstab': 'fstab',
          'drive_mappings': 'drive_mappings',
          'windows_systemroot': 'windows_systemroot',
          'windows_software_hive': 'windows_software_hive',
          'windows_system_hive': 'windows_system_hive',
          'windows_current_control_set': 'windows_current_control_set',
        };
        const mappedKey = keyMap[key];
        if (mappedKey && !guestInfoRaw.has(mappedKey)) {
          guestInfoRaw.set(mappedKey, val);
        }
      }
    }

    // ── blkid output lines (`/dev/sda1: UUID="..." TYPE="vfat" ...`) ─
    {
      const blkidEntry = parseBlkidLine(line);
      if (blkidEntry && !blkidEntries.some((e) => e.device === blkidEntry.device)) {
        blkidEntries.push(blkidEntry);
      }
    }

    // ── VirtIO Win ISO / file copy tracking ─────────────────────────
    {
      // Detect the VirtIO Win ISO source line:
      // "windows: copy_from_virtio_win: guest tools source ISO /usr/share/virtio-win/virtio-win.iso"
      const isoMatch = line.match(/copy_from_virtio_win:\s+guest tools source ISO\s+(\S+)/);
      if (isoMatch) {
        virtioWinIsoPath = isoMatch[1];
      }

      // Track read_file from virtio_win ISO:
      // libguestfs: trace: virtio_win: read_file "///Balloon/2k19/amd64/balloon.sys"
      const readFileMatch = line.match(/libguestfs: trace: virtio_win: read_file "(\/\/\/[^"]+)"/);
      if (readFileMatch) {
        pendingVirtioWinRead = { source: readFileMatch[1], sizeBytes: null, lineNumber: globalLine };
      }

      // Capture the read_file result to get the file size:
      // libguestfs: trace: virtio_win: read_file = "..."<truncated, original size 229416 bytes>
      if (pendingVirtioWinRead) {
        const readSize = extractOriginalSize(line);
        if (readSize !== null) {
          pendingVirtioWinRead.sizeBytes = readSize;
        }
      }

      // Track v2v: read_file from guest filesystem (read-modify-write pattern):
      // libguestfs: trace: v2v: read_file "/etc/hostname"
      const v2vReadFileMatch = line.match(/libguestfs: trace: v2v: read_file "([^"]+)"/);
      if (v2vReadFileMatch && !line.includes('read_file =')) {
        const readPath = v2vReadFileMatch[1];
        lastV2VReadFilePath = readPath;
        pendingV2VReads.set(readPath, { content: null, sizeBytes: null, lineNumber: globalLine });
      }

      // Capture the v2v: read_file result content:
      // libguestfs: trace: v2v: read_file = "mnecas\x0a"
      // libguestfs: trace: v2v: read_file = "..."<truncated, original size N bytes>
      if (lastV2VReadFilePath) {
        const v2vReadResultMatch = line.match(/libguestfs: trace: v2v: read_file = /);
        if (v2vReadResultMatch) {
          const pending = pendingV2VReads.get(lastV2VReadFilePath);
          if (pending) {
            const pendingSize = extractOriginalSize(line);
            if (pendingSize !== null) {
              pending.sizeBytes = pendingSize;
            }
            // Extract the content for text-like files
            const contentResult = extractReadFileContent(line);
            if (contentResult !== null) {
              pending.content = contentResult;
            }
          }
          lastV2VReadFilePath = null;
        }
      }

      // Track v2v: write to guest (pair with pending read or standalone):
      // libguestfs: trace: v2v: write "/destination/path" "content..."
      const writeMatch = line.match(/libguestfs: trace: v2v: write "([^"]+)"/);
      if (writeMatch) {
        const dest = writeMatch[1];
        // Extract size from "original size N bytes" if present
        const writeSize = extractOriginalSize(line);
        const contentTruncated = line.includes('<truncated,');

        // Extract inline content from write for text files (scripts, batch files)
        const contentResult = extractWriteContent(line, dest);

        if (pendingVirtioWinRead) {
          // This write corresponds to a virtio_win read
          fileCopies.push({
            source: pendingVirtioWinRead.source,
            destination: dest,
            sizeBytes: pendingVirtioWinRead.sizeBytes ?? writeSize,
            origin: 'virtio_win',
            content: null,
            contentTruncated: false,
            lineNumber: pendingVirtioWinRead.lineNumber,
          });
          pendingVirtioWinRead = null;
        } else if (pendingV2VReads.has(dest)) {
          // This write corresponds to a v2v: read_file of the same path (guest read-modify-write)
          const readInfo = pendingV2VReads.get(dest)!;
          fileCopies.push({
            source: dest,
            destination: dest,
            sizeBytes: readInfo.sizeBytes ?? writeSize,
            origin: 'guest',
            content: contentResult ?? readInfo.content,
            contentTruncated,
            lineNumber: readInfo.lineNumber,
          });
          pendingV2VReads.delete(dest);
        } else {
          // Standalone write (generated scripts, configs)
          fileCopies.push({
            source: '(generated)',
            destination: dest,
            sizeBytes: writeSize,
            origin: 'script',
            content: contentResult,
            contentTruncated,
            lineNumber: globalLine,
          });
        }
      }

      // Track v2v: upload from host to guest:
      // libguestfs: trace: v2v: upload "/usr/share/virt-tools/rhsrvany.exe" "/destination"
      const uploadMatch = line.match(/libguestfs: trace: v2v: upload "([^"]+)" "([^"]+)"/);
      if (uploadMatch) {
        const src = uploadMatch[1];
        const dest = uploadMatch[2];
        // Skip temp file uploads (these are the internal mechanism for write operations)
        if (!src.startsWith('/tmp/')) {
          fileCopies.push({
            source: src,
            destination: dest,
            sizeBytes: null,
            origin: 'virt-tools',
            content: null,
            contentTruncated: false,
            lineNumber: globalLine,
          });
        }
      }
    }

    // ── Errors & Warnings ────────────────────────────────────────────
    if (ERROR_RE.test(line) && !isErrorFalsePositive(line)) {
      const source = extractSource(line);
      errors.push({
        level: 'error',
        source,
        message: line,
        lineNumber: globalLine,
        rawLine: line,
      });
    } else if (WARNING_RE.test(line)) {
      const source = extractSource(line);
      errors.push({
        level: 'warning',
        source,
        message: line,
        lineNumber: globalLine,
        rawLine: line,
      });
    }
  }

  // ── Flush pending state ──────────────────────────────────────────
  if (pendingLibguestfsCmd.length > 0) {
    hostCommands.push(buildHostCommand(pendingLibguestfsCmd, pendingLibguestfsCmdLine));
  }
  if (activeGuestfsd) {
    attachGuestfsdToApiCall(activeGuestfsd, openApiCalls, completedApiCalls);
  }
  if (currentNbdkit) {
    finalizeNbdkit(currentNbdkit, nbdkitMap, globalLineOffset + sectionLines.length - 1);
  }

  // Move any remaining open API calls to completed
  for (const queue of openApiCalls.values()) {
    completedApiCalls.push(...queue);
  }

  // Sort API calls by line number to maintain log order
  completedApiCalls.sort((a, b) => a.lineNumber - b.lineNumber);

  // Build guest info from collected `i_` or structured-block lines
  // At minimum we need `type` or `distro` to have meaningful guest info
  if (guestInfoRaw.size > 0 && (guestInfoRaw.has('root') || guestInfoRaw.has('type') || guestInfoRaw.has('distro'))) {
    guestInfo = buildGuestInfo(guestInfoRaw);
    guestInfo.blkid = blkidEntries;
  }

  // Flush any unclosed hivex session
  flushHivexSession(currentHivexSession, registryHiveAccesses);
  currentHivexSession = null;

  // Collect nbdkit connections
  nbdkitConnections.push(...nbdkitMap.values());

  // Build disk summary from nbdkit connections
  nbdkitConnections.forEach((conn, idx) => {
    diskSummary.disks.push({
      index: idx + 1,
      sizeBytes: conn.backingSize,
      sourceFile: conn.diskFile || undefined,
      transportMode: conn.transportMode,
      server: conn.server,
      vmMoref: conn.vmMoref,
    });
  });

  const libguestfs: LibguestfsInfo = {
    backend: lgBackend,
    identifier: lgIdentifier,
    memsize: lgMemsize,
    smp: lgSmp,
    drives: lgDrives,
    apiCalls: lgApiCalls,
    launchLines: lgLaunchLines,
  };

  // Infer exit status
  const exitStatus = inferExitStatus(stages, errors, sectionLines);

  return {
    tool,
    commandLine,
    exitStatus,
    startLine: globalLineOffset,
    endLine: globalLineOffset + sectionLines.length - 1,
    stages,
    diskProgress,
    nbdkitConnections,
    libguestfs,
    apiCalls: completedApiCalls,
    hostCommands,
    guestInfo,
    installedApps,
    registryHiveAccesses,
    virtioWin: {
      isoPath: virtioWinIsoPath,
      fileCopies,
    },
    versions,
    diskSummary,
    sourceVM,
    errors,
    rawLines: sectionLines,
    lineCategories,
  };
}
