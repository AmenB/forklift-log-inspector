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
  V2VDriveMapping,
  V2VFstabEntry,
  V2VInstalledApp,
  V2VRegistryHiveAccess,
  V2VFileCopy,
  V2VError,
  V2VLineCategory,
  V2VComponentVersions,
  V2VDiskSummary,
  V2VSourceVM,
  V2VExitStatus,
} from '../types/v2v';

// ────────────────────────────────────────────────────────────────────────────
// Internal types
// ────────────────────────────────────────────────────────────────────────────

/** Mutable state for tracking a hivex registry session within the parser. */
interface HivexSessionState {
  hivePath: string;
  mode: 'read' | 'write';
  keySegments: string[];
  values: { name: string; value: string; lineNumber: number }[];
  pendingGetValueName: string | null;
  lineNumber: number;
  rootHandle: string;
  hasWriteOp: boolean;
  firstWriteLine: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Detection
// ────────────────────────────────────────────────────────────────────────────

/**
 * Detect whether a plain-text file is a virt-v2v / virt-v2v-inspector log.
 * Checks the first ~10 lines for characteristic markers.
 */
export function isV2VLog(content: string): boolean {
  // Look at the first 2000 chars (covers the first few lines even when they
  // are long, like the concatenated Building-command line in virt-v2v.logs).
  // Strip optional container/k8s timestamp prefixes so the markers are visible.
  const head = content
    .slice(0, 3000)
    .replace(CONTAINER_TS_PREFIX_RE, '')
    .replace(/\n\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+/g, '\n');
  if (/Building command[:\s]*virt-v2v/i.test(head)) return true;
  if (/^info:\s*virt-v2v/m.test(head)) return true;
  if (/virt-v2v-in-place/i.test(head)) return true;
  if (/virt-v2v-inspector/i.test(head)) return true;
  return false;
}

// ────────────────────────────────────────────────────────────────────────────
// Regex patterns
// ────────────────────────────────────────────────────────────────────────────

/** virt-v2v pipeline stage: `[   0.0] Setting up the source` (1 decimal) */
const STAGE_RE = /^\[\s*(\d+\.\d)\]\s+(.+)$/;

/** Kernel boot line: `[    0.000000]` (3+ decimals) */
const KERNEL_BOOT_RE = /^\[\s*\d+\.\d{3,}\]/;

/** Container / k8s timestamp prefix: `2026-01-21T00:57:24.837772290Z ` */
const CONTAINER_TS_PREFIX_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+/;

/** `Building command: tool [args]` (with space, bracket args) */
const BUILD_CMD_SPACE_RE = /^Building command:\s*(\S+)\s+\[(.*)]/;

/** `Building command:tool[args]` (no space, bracket args) */
const BUILD_CMD_NOSPACE_RE = /Building command:(\S+?)\[([^\]]*)\]/g;

/** nbdkit socket path */
const NBDKIT_SOCKET_RE = /--unix['\s]+([^\s']+)/;

/** nbdkit NBD URI */
const NBDKIT_URI_RE = /NBD URI:\s*(\S+)/;

/** nbdkit plugin registration */
const NBDKIT_PLUGIN_RE = /registered plugin\s+\S+\s+\(name\s+(\w+)\)/;

/** nbdkit filter registration */
const NBDKIT_FILTER_RE = /registered filter\s+\S+\s+\(name\s+(\w+)\)/;

/** nbdkit file= config */
const NBDKIT_FILE_RE = /config key=file, value=(.+)/;

/** libguestfs trace api call — captures: [1]=handle (v2v, virtio_win, ...), [2]=api name, [3]=args */
const LIBGUESTFS_TRACE_RE = /^libguestfs: trace: (\w+): (\S+)\s*(.*)/;

/** libguestfs add_drive */
const LIBGUESTFS_DRIVE_RE =
  /add_drive\s+"([^"]*)"\s+"format:([^"]*)"\s+"protocol:([^"]*)"\s+"server:([^"]*)"/;

/** libguestfs set_memsize */
const LIBGUESTFS_MEMSIZE_RE = /set_memsize\s+(\d+)/;

/** libguestfs set_smp */
const LIBGUESTFS_SMP_RE = /set_smp\s+(\d+)/;

/** libguestfs backend */
const LIBGUESTFS_BACKEND_RE = /^libguestfs: launch: backend=(.+)/;

/** libguestfs identifier from kernel command line */
const LIBGUESTFS_ID_RE = /guestfs_identifier=(\S+)/;

/** command execution: `command: blkid '-c' ...` */
const COMMAND_RE = /^command:\s+(\S+)\s*(.*)/;

/** command return code: `command: blkid returned 0` */
const CMD_RETURN_RE = /^command:\s+(\S+)\s+returned\s+(\d+)/;

/** command stdout header: `command: blkid: stdout:` */
const CMD_STDOUT_RE = /^command:\s+(\S+):\s+stdout:$/;

/** commandrvf metadata: `commandrvf: stdout=y stderr=y flags=0x0` */
const COMMANDRVF_META_RE = /^commandrvf:\s+stdout=[yn]\s+stderr=[yn]\s+flags=/;

/** commandrvf execution: `commandrvf: udevadm --debug settle` */
const COMMANDRVF_EXEC_RE = /^commandrvf:\s+(\S+)\s*(.*)/;

/** chroot execution */
const CHROOT_RE = /^chroot:\s+(\S+):\s+running\s+'([^']+)'/;

/** libguestfs command: run: */
const LIBGUESTFS_CMD_RE = /^libguestfs: command: run:\s*(.*)/;

/** virt-v2v monitoring progress */
const MONITOR_PROGRESS_RE = /virt-v2v monitoring:\s*Progress update, completed\s+(\d+)\s*%/;

/** virt-v2v monitoring disk copy */
const MONITOR_DISK_RE = /virt-v2v monitoring:\s*Copying disk\s+(\d+)\s+out of\s+(\d+)/;

/** guestfsd request start: `guestfsd: <= list_partitions (0x8) request length 40 bytes` */
const GUESTFSD_START_RE = /^guestfsd:\s+<=\s+(\w+)\s+\(0x[\da-f]+\)/i;

/** guestfsd request end: `guestfsd: => list_partitions (0x8) took 0.04 secs` */
const GUESTFSD_END_RE = /^guestfsd:\s+=>\s+(\w+)\s+\(0x[\da-f]+\)\s+took\s+([\d.]+)\s+secs/i;

/** error patterns (context-aware) */
const ERROR_RE = /\berror[:\s]/i;
const WARNING_RE = /\bwarning[:\s]/i;

// ── Version detection regexes ─────────────────────────────────────────────

/** info: virt-v2v: virt-v2v 2.7.1rhel=9,release=8.el9_6 (x86_64) */
const VERSION_VIRTV2V_RE = /^info:\s*(?:virt-v2v[\w-]*):\s*virt-v2v\s+([\d.]+\S*)/;
/** info: libvirt version: 10.10.0 */
const VERSION_LIBVIRT_RE = /^info:\s*libvirt version:\s*([\d.]+)/;
/** nbdkit 1.38.5 (nbdkit-...) */
const VERSION_NBDKIT_RE = /\bnbdkit\s+([\d]+\.[\d]+\.[\d]+)/;
/** VMware VixDiskLib (7.0.3) Release ... */
const VERSION_VDDK_RE = /VMware VixDiskLib \(([\d.]+)\)/;
/** libguestfs: qemu version: 9.1  or  qemu version (reported by libvirt) = 10000000 */
const VERSION_QEMU_RE = /libguestfs:\s*qemu version[^:]*:\s*([\d.]+)/;
/** libguestfs: trace: v2v: version = <struct guestfs_version = major: 1, minor: 56, release: 1 */
const VERSION_LIBGUESTFS_RE =
  /libguestfs: trace: \w+: version = <struct guestfs_version = major: (\d+), minor: (\d+), release: (\d+)/;

// ── Disk / storage regexes ────────────────────────────────────────────────

/** check_host_free_space: large_tmpdir=/var/tmp free_space=56748552192 */
const HOST_FREE_SPACE_RE = /^check_host_free_space:\s+large_tmpdir=(\S+)\s+free_space=(\d+)/;
/** nbdkit: vddk[N]: debug: cow: underlying file size: NNNN */
const COW_FILE_SIZE_RE = /cow:\s+underlying file size:\s+(\d+)/;
/** nbdkit config key=server, value=10.6.46.159 */
const NBDKIT_SERVER_RE = /config key=server, value=(\S+)/;
/** nbdkit config key=vm, value=moref=vm-152 */
const NBDKIT_VM_RE = /config key=vm, value=moref=(\S+)/;
/** nbdkit transport mode: nbdssl */
const NBDKIT_TRANSPORT_RE = /transport mode:\s*(\w+)/;

/** false-positive error patterns to ignore */
const ERROR_FALSE_POSITIVES = [
  /get_backend_setting = NULL \(error\)/,
  /usbserial.*error/i,
  /error: No error/,
  /TLS disabled/,
];

// ────────────────────────────────────────────────────────────────────────────
// Main parser
// ────────────────────────────────────────────────────────────────────────────

export function parseV2VLog(content: string): V2VParsedData {
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

        // hivex_node_get_child adds a segment to the current path
        if (apiName === 'hivex_node_get_child' && !apiArgs.startsWith('=') && currentHivexSession) {
          const childMatch = apiArgs.match(HIVEX_HANDLE_NAME_RE);
          if (childMatch) {
            const parentHandle = childMatch[1];
            const childName = childMatch[2];
            // If navigating from root again, flush current path and start fresh
            if (currentHivexSession.rootHandle && parentHandle === currentHivexSession.rootHandle && currentHivexSession.keySegments.length > 0) {
              resetHivexTraversal(currentHivexSession, { lineNumber: globalLine });
            }
            currentHivexSession.keySegments.push(childName);
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

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function categorizeLine(line: string): V2VLineCategory {
  if (KERNEL_BOOT_RE.test(line)) return 'kernel';
  if (STAGE_RE.test(line)) return 'stage';
  if (line.startsWith('nbdkit:') || line.startsWith('running nbdkit')) return 'nbdkit';
  if (line.startsWith('libguestfs:')) return 'libguestfs';
  if (line.startsWith('guestfsd:')) return 'guestfsd';
  if (line.startsWith('command:') || line.startsWith('commandrvf:') || line.startsWith('chroot:'))
    return 'command';
  if (line.startsWith('info:')) return 'info';
  if (/virt-v2v monitoring:/i.test(line)) return 'monitor';
  if (line.trimStart().startsWith('<')) return 'xml';
  if (/^\s*(apiVersion:|kind:|metadata:|spec:|status:|---\s*$)/.test(line)) return 'yaml';
  if (WARNING_RE.test(line)) return 'warning';
  if (ERROR_RE.test(line) && !isErrorFalsePositive(line)) return 'error';
  return 'other';
}

function finalizeNbdkit(
  nbdkit: Partial<NbdkitConnection>,
  map: Map<string, NbdkitConnection>,
  endLine: number,
) {
  const id = nbdkit.socketPath || `nbdkit-${map.size}`;
  if (!map.has(id)) {
    map.set(id, {
      id,
      socketPath: nbdkit.socketPath || '',
      uri: nbdkit.uri || '',
      plugin: nbdkit.plugin || '',
      filters: nbdkit.filters || [],
      diskFile: nbdkit.diskFile || '',
      startLine: nbdkit.startLine || endLine,
      endLine,
      logLines: nbdkit.logLines || [],
      server: nbdkit.server,
      vmMoref: nbdkit.vmMoref,
      transportMode: nbdkit.transportMode,
      backingSize: nbdkit.backingSize,
    });
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Extracted helpers to reduce duplication in parseToolRunSection
// ────────────────────────────────────────────────────────────────────────────

/** Data-driven version detection: try each regex against the line. */
const VERSION_MATCHERS: { key: keyof V2VComponentVersions; re: RegExp; fmt?: (m: RegExpMatchArray) => string }[] = [
  { key: 'virtV2v', re: VERSION_VIRTV2V_RE },
  { key: 'libvirt', re: VERSION_LIBVIRT_RE },
  { key: 'nbdkit', re: VERSION_NBDKIT_RE },
  { key: 'vddk', re: VERSION_VDDK_RE },
  { key: 'qemu', re: VERSION_QEMU_RE },
  { key: 'libguestfs', re: VERSION_LIBGUESTFS_RE, fmt: (m) => `${m[1]}.${m[2]}.${m[3]}` },
];

function parseVersionFields(line: string, versions: V2VComponentVersions): void {
  for (const { key, re, fmt } of VERSION_MATCHERS) {
    if (!versions[key]) {
      const m = line.match(re);
      if (m) {
        (versions as Record<string, string>)[key] = fmt ? fmt(m) : m[1];
      }
    }
  }
}

/** Extract "original size N bytes" from a log line, or null. */
const ORIGINAL_SIZE_RE = /original size (\d+) bytes/;
function extractOriginalSize(line: string): number | null {
  const m = line.match(ORIGINAL_SIZE_RE);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Parse a single \xHH hex escape at position i in string s.
 * Returns the byte value and number of characters consumed, or null.
 */
function parseHexEscapeAt(s: string, i: number): { byte: number; consumed: number } | null {
  if (s[i] === '\\' && i + 3 < s.length && s[i + 1] === 'x') {
    const hex = s.substring(i + 2, i + 4);
    const val = parseInt(hex, 16);
    if (!isNaN(val)) return { byte: val, consumed: 4 };
  }
  return null;
}

/** Flush a hivex session into the accesses array if it has data. */
function flushHivexSession(
  session: HivexSessionState | null,
  accesses: V2VRegistryHiveAccess[],
): void {
  if (!session) return;
  const keyPath = session.keySegments.join('\\');

  // Skip empty sessions — no path and no values means nothing meaningful to record
  if (!keyPath && session.values.length === 0) return;

  // Determine actual mode: use hasWriteOp to distinguish read navigations
  // within a write-mode session from actual write operations
  const actualMode: 'read' | 'write' = session.hasWriteOp ? 'write' : 'read';

  // For writes, point to the first write operation; for reads, use navigation start
  const lineNumber = (actualMode === 'write' && session.firstWriteLine)
    ? session.firstWriteLine
    : session.lineNumber;

  // Avoid duplicate entries: if the last entry has the same hive, key path, mode, and
  // line number, merge values into it instead of creating a new entry
  const last = accesses.length > 0 ? accesses[accesses.length - 1] : null;
  if (
    last &&
    last.hivePath === session.hivePath &&
    last.keyPath === keyPath &&
    last.mode === actualMode &&
    last.lineNumber === lineNumber
  ) {
    // Merge values
    last.values.push(...session.values);
    return;
  }

  accesses.push({
    hivePath: session.hivePath,
    mode: actualMode,
    keyPath,
    values: session.values,
    lineNumber,
  });
}

/**
 * Infer the exit status of a tool run from available signals:
 * - "Finishing off" stage reached → likely success
 * - Fatal errors from virt-v2v/virt-v2v-in-place → error
 * - "virt-v2v monitoring: Finished" in raw lines → success
 */
function inferExitStatus(
  stages: V2VPipelineStage[],
  errors: V2VError[],
  rawLines: string[],
): V2VExitStatus {
  const hasFinishingOff = stages.some((s) => /Finishing off/i.test(s.name));
  const hasMonitorFinished = rawLines.some((l) => /virt-v2v monitoring:\s*Finished/i.test(l));

  // Fatal errors from the tool itself (not from libguestfs/nbdkit)
  const hasFatalError = errors.some(
    (e) =>
      e.level === 'error' &&
      /^virt-v2v/.test(e.source) &&
      !/warning/i.test(e.message) &&
      !/ignored\)/i.test(e.message),
  );

  if (hasFatalError && !hasFinishingOff) return 'error';
  if (hasFinishingOff || hasMonitorFinished) return 'success';
  if (hasFatalError) return 'error';

  // No clear signal — if we have stages, the run is likely still in progress (log was captured mid-run)
  if (stages.length > 0) return 'in_progress';
  return 'unknown';
}

function buildHostCommand(parts: string[], lineNumber: number): V2VHostCommand {
  const command = parts[0] || '';
  const args = parts.slice(1);
  return { command, args, lineNumber };
}

/**
 * Find the first open API call queue whose key ends with `:apiName`.
 * Keys are stored as `handle:apiName`.
 */
function findQueueByApiName(
  openApiCalls: Map<string, V2VApiCall[]>,
  apiName: string,
): V2VApiCall[] | undefined {
  const suffix = `:${apiName}`;
  for (const [key, queue] of openApiCalls) {
    if (key.endsWith(suffix) && queue.length > 0) return queue;
  }
  return undefined;
}

/**
 * Attach collected guestfsd commands to the matching open API call.
 * Finds by name (FIFO) and moves commands into the API call's guestCommands array.
 */
function attachGuestfsdToApiCall(
  scope: { name: string; commands: V2VGuestCommand[] },
  openApiCalls: Map<string, V2VApiCall[]>,
  completedApiCalls: V2VApiCall[],
) {
  if (scope.commands.length === 0) return;

  // Try open API calls first (by api name across all handles)
  const queue = findQueueByApiName(openApiCalls, scope.name);
  if (queue && queue.length > 0) {
    queue[0].guestCommands.push(...scope.commands);
    return;
  }

  // Fall back to the most recent completed API call with the same name
  for (let i = completedApiCalls.length - 1; i >= 0; i--) {
    if (completedApiCalls[i].name === scope.name) {
      completedApiCalls[i].guestCommands.push(...scope.commands);
      return;
    }
  }

  // Last resort: attach to any open API call
  for (const q of openApiCalls.values()) {
    if (q.length > 0) {
      q[0].guestCommands.push(...scope.commands);
      return;
    }
  }
}

/**
 * Parse the result of `inspect_list_applications2` into structured app entries.
 *
 * Format: `= <struct guestfs_application2_list(N) = [0]{...} [1]{...} ...>`
 *
 * Values can contain commas (`VMware, Inc.`), braces (`{GUID}`), and backslashes (`C:\...`),
 * so we use `app2_` field prefixes as delimiters instead of commas.
 */

// ── Hivex data decoder ──────────────────────────────────────────────────────

/**
 * Decode the raw escaped byte data from hivex_node_set_value traces into
 * a human-readable string.
 *
 * Registry types:
 *   1 = REG_SZ (UTF-16LE string)
 *   2 = REG_EXPAND_SZ (UTF-16LE string with env-var refs)
 *   4 = REG_DWORD (32-bit LE integer)
 *   7 = REG_MULTI_SZ (series of null-terminated UTF-16LE strings)
 *   3 = REG_BINARY
 */
function decodeHivexData(rawData: string, regType: number): string {
  const bytes = parseEscapedHivexBytes(rawData);

  if (regType === 4 && bytes.length >= 4) {
    // REG_DWORD – little-endian 32-bit unsigned
    const value = (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | ((bytes[3] << 24) >>> 0)) >>> 0;
    return String(value);
  }

  if (regType === 1 || regType === 2 || regType === 7) {
    // REG_SZ / REG_EXPAND_SZ / REG_MULTI_SZ – UTF-16LE
    return decodeUtf16LE(bytes);
  }

  // REG_BINARY or other – show hex summary
  if (bytes.length <= 16) {
    return bytes.map(b => b.toString(16).padStart(2, '0')).join(' ');
  }
  return `(${bytes.length} bytes)`;
}

/** Decode UTF-16LE bytes to a JS string, stopping at null terminator. */
function decodeUtf16LE(bytes: number[]): string {
  let result = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const code = bytes[i] | (bytes[i + 1] << 8);
    if (code === 0) break; // null terminator
    result += String.fromCharCode(code);
  }
  return result;
}

/**
 * Parse the escaped byte string from libguestfs hivex trace output.
 *
 * libguestfs trace format:
 *   `\xHH` → byte value HH (hex) — used for non-printable bytes
 *   `\`    → literal backslash (byte 0x5C) when NOT followed by `xHH`
 *   any other char → its ASCII byte value
 *
 * IMPORTANT: libguestfs does NOT double-escape backslashes. A `\` in the
 * output is just byte 0x5C. So `\\x00` in the trace means byte 0x5C
 * followed by `\x00` (byte 0x00) — i.e. a UTF-16LE backslash character.
 */
function parseEscapedHivexBytes(s: string): number[] {
  const bytes: number[] = [];
  let i = 0;
  while (i < s.length) {
    const esc = parseHexEscapeAt(s, i);
    if (esc) {
      bytes.push(esc.byte);
      i += esc.consumed;
    } else {
      bytes.push(s.charCodeAt(i));
      i++;
    }
  }
  return bytes;
}

function parseInstalledApps(resultStr: string, apps: V2VInstalledApp[]) {
  // Split entries by `} [N]{` boundaries (or start/end markers)
  const listStart = resultStr.indexOf('[0]{');
  if (listStart === -1) return;

  const entriesStr = resultStr.slice(listStart);
  // Split by `} [N]{` — each chunk is one app entry (with leading/trailing junk)
  const rawEntries = entriesStr.split(/\}\s*\[\d+\]\{/);

  for (const raw of rawEntries) {
    // Clean: remove leading `[0]{` and trailing `}>` or `}`
    const fields = raw.replace(/^\[\d+\]\{/, '').replace(/\}\s*>?\s*$/, '');

    const app: V2VInstalledApp = {
      name: extractAppField(fields, 'app2_name'),
      displayName: extractAppField(fields, 'app2_display_name'),
      version: extractAppField(fields, 'app2_version'),
      publisher: extractAppField(fields, 'app2_publisher'),
      installPath: extractAppField(fields, 'app2_install_path'),
      description: extractAppField(fields, 'app2_description'),
      arch: extractAppField(fields, 'app2_arch'),
    };
    if (app.displayName || app.name) {
      apps.push(app);
    }
  }
}

/**
 * Extract a field value from the `app2_key: value, app2_next: ...` string.
 * Uses `, app2_` as the delimiter since values themselves can contain commas.
 */
function extractAppField(fields: string, key: string): string {
  const marker = `${key}: `;
  const idx = fields.indexOf(marker);
  if (idx === -1) return '';
  const start = idx + marker.length;
  // Value runs until the next `, app2_` boundary
  const nextField = fields.indexOf(', app2_', start);
  if (nextField === -1) {
    // Last field — strip trailing comma/whitespace
    return fields.slice(start).replace(/,?\s*$/, '').trim();
  }
  return fields.slice(start, nextField).trim();
}

/**
 * Build a V2VGuestInfo from the collected `i_` key-value pairs.
 *
 * Windows drive mappings format: `i_drive_mappings = E => /dev/sdb1; D => /dev/sda1; C => /dev/sdc2`
 * Linux fstab format (from structured block): `fstab: [(/dev/rhel/root, /), (/dev/sda2, /boot), ...]`
 */
function buildGuestInfo(raw: Map<string, string>): V2VGuestInfo {
  // Parse Windows drive mappings — two possible formats:
  // i_ format: "E => /dev/sdb1; D => /dev/sda1; C => /dev/sdc2"
  // structured block format: "[(C, /dev/sda2), (E, /dev/sdb1), (F, /dev/sdc1)]"
  const driveMappings: V2VDriveMapping[] = [];
  const mappingsStr = raw.get('drive_mappings') || '';
  if (mappingsStr) {
    if (mappingsStr.includes('=>')) {
      // i_ format
      for (const part of mappingsStr.split(';')) {
        const m = part.trim().match(/^(\w+)\s*=>\s*(.+)$/);
        if (m) {
          driveMappings.push({ letter: m[1], device: m[2].trim() });
        }
      }
    } else {
      // structured block format: [(C, /dev/sda2), ...]
      const entryRe = /\((\w+),\s*([^)]+)\)/g;
      let dm;
      while ((dm = entryRe.exec(mappingsStr)) !== null) {
        driveMappings.push({ letter: dm[1].trim(), device: dm[2].trim() });
      }
    }
    driveMappings.sort((a, b) => a.letter.localeCompare(b.letter));
  }

  // Parse Linux fstab entries: [(/dev/rhel/root, /), (/dev/sda2, /boot), ...]
  const fstab: V2VFstabEntry[] = [];
  const fstabStr = raw.get('fstab') || '';
  if (fstabStr) {
    const entryRe = /\(([^,]+),\s*([^)]+)\)/g;
    let fm;
    while ((fm = entryRe.exec(fstabStr)) !== null) {
      fstab.push({ device: fm[1].trim(), mountpoint: fm[2].trim() });
    }
  }

  // Parse version: prefer i_major_version/i_minor_version, then CPE product version,
  // then fall back to `version: X.Y`.
  //
  // The structured block format (from inspect_os / inspect_get_roots) sometimes
  // reports the CPE *specification* version (e.g. `2.3`) as the OS version,
  // which is wrong for distros like Amazon Linux 2023 whose real version is `2023`.
  // When product_name is a CPE string, we extract the true version from the CPE.
  let majorVersion = parseInt(raw.get('major_version') || '0', 10);
  let minorVersion = parseInt(raw.get('minor_version') || '0', 10);
  if (majorVersion === 0) {
    // Try extracting version from CPE product_name first
    const productName = raw.get('product_name') || '';
    const cpeVersion = extractCPEVersion(productName);
    if (cpeVersion) {
      const vParts = cpeVersion.split('.');
      majorVersion = parseInt(vParts[0] || '0', 10);
      minorVersion = parseInt(vParts[1] || '0', 10);
    }
    // Fall back to the explicit version field
    if (majorVersion === 0 && raw.has('version')) {
      const vParts = (raw.get('version') || '').split('.');
      majorVersion = parseInt(vParts[0] || '0', 10);
      minorVersion = parseInt(vParts[1] || '0', 10);
    }
  }

  return {
    root: raw.get('root') || '',
    type: raw.get('type') || '',
    distro: raw.get('distro') || '',
    osinfo: raw.get('osinfo') || '',
    arch: raw.get('arch') || '',
    majorVersion,
    minorVersion,
    productName: raw.get('product_name') || '',
    productVariant: raw.get('product_variant') || '',
    packageFormat: raw.get('package_format') || '',
    packageManagement: raw.get('package_management') || '',
    hostname: raw.get('hostname') || '',
    buildId: raw.get('build_id') || '',
    windowsSystemroot: raw.get('windows_systemroot') || '',
    windowsSoftwareHive: raw.get('windows_software_hive') || '',
    windowsSystemHive: raw.get('windows_system_hive') || '',
    windowsCurrentControlSet: raw.get('windows_current_control_set') || '',
    driveMappings,
    fstab,
  };
}

/**
 * Extract the product version from a CPE 2.3 string.
 * Format: `cpe:2.3:part:vendor:product:version:...`
 * Returns the version component (parts[5]) or empty string if not a CPE.
 */
function extractCPEVersion(productName: string): string {
  if (!productName.startsWith('cpe:')) return '';
  const parts = productName.split(':');
  if (parts.length >= 6) {
    const ver = parts[5];
    // `*` means unspecified in CPE
    if (ver && ver !== '*') return ver;
  }
  return '';
}

/** Known line prefixes that indicate stdout capture should stop. */
const KNOWN_PREFIXES = [
  'command:',
  'commandrvf:',
  'chroot:',
  'guestfsd:',
  'libguestfs:',
  'nbdkit:',
  'supermin:',
  'libnbd:',
  'info:',
  'virt-v2v',
  'umount-all:',
  'Building command',
  'windows:',
  'hivex:',
  // Noisy udev / systemd / varlink / debug prefixes (stop stdout capture)
  'udev:',
  'udevadm:',
  'varlink:',
  'list_filesystems:',
];

function isKnownPrefix(line: string): boolean {
  for (const prefix of KNOWN_PREFIXES) {
    if (line.startsWith(prefix)) return true;
  }
  // Pipeline stages
  if (STAGE_RE.test(line) && !KERNEL_BOOT_RE.test(line)) return true;
  // Kernel boot lines
  if (KERNEL_BOOT_RE.test(line)) return true;
  // Common noisy stderr / interstitial lines
  if (NOISY_LINE_RE.test(line)) return true;
  // Corrupted / interleaved prefixes from concurrent process output
  if (CORRUPTED_PREFIX_RE.test(line)) return true;
  // Guest inspection info lines (i_root, i_type, etc.)
  if (/^i_\w+\s*=/.test(line)) return true;
  // Inspection structured block lines
  if (/^inspect_/.test(line)) return true;
  if (/^fs:\s+\/dev\//.test(line)) return true;
  if (/^check_filesystem:/.test(line)) return true;
  if (/^check_for_filesystem/.test(line)) return true;
  if (/^get_windows_systemroot/.test(line)) return true;
  // Root device header from inspect_get_roots: `/dev/sda1 (xfs):`
  if (/^\/dev\/\S+\s+\(\w+\):/.test(line)) return true;
  // Indented fields from inspect_os / inspect_get_roots structured blocks
  // e.g. "    type: linux", "    distro: amazonlinux", "    fstab: [...]"
  if (/^\s{4}\w[\w\s]*\w\s*:/.test(line)) return true;
  return false;
}

/** Commands to omit entirely (noisy, run before every disk operation). */
const NOISY_COMMANDS = ['udevadm'];

function isNoisyCommand(name: string): boolean {
  return NOISY_COMMANDS.includes(name);
}

/** Noisy stderr / interstitial lines that should stop stdout capture. */
const NOISY_LINE_RE =
  /^(?:No filesystem is currently mounted on|Failed to determine unit we run in|SELinux enabled state cached to|varlink:|udev:|udevadm:)/;

/** Corrupted prefixes from interleaved concurrent process output. */
const CORRUPTED_PREFIX_RE =
  /^(?:gulibguestfs:|estfsd:|uestfsd:|stfsd:|glibguestfs:|guelibguestfs:|gueslibguestfs:|guestfsdlibguestfs:|tfsd:)/;

function parseCommandArgs(argsStr: string): string[] {
  if (!argsStr) return [];
  // Split on spaces but respect quoted strings
  const args: string[] = [];
  const re = /'([^']*)'|"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(argsStr)) !== null) {
    args.push(m[1] ?? m[2] ?? m[3]);
  }
  return args;
}

/**
 * Extract the inline text content from a `v2v: write` log line.
 * Returns decoded text for script-like files (.bat, .ps1, .reg, .cmd, .txt, .xml),
 * or null for binary files (.exe, .msi, .sys, .dll, .cat, .pdb, etc.).
 *
 * Line format:
 *   libguestfs: trace: v2v: write "/path/file.bat" "escaped content"
 *   libguestfs: trace: v2v: write "/path/file.bat" "escaped..."<truncated, original size N bytes>
 */
/**
 * Extract content from a `v2v: read_file = "content"` result line.
 * Returns decoded text, or null if it looks like binary.
 * Pattern: read_file = "content here"  or  "content"<truncated, original size N bytes>
 */
function extractReadFileContent(line: string): string | null {
  // Find the content after `read_file = "`
  const marker = 'read_file = "';
  const startIdx = line.indexOf(marker);
  if (startIdx < 0) return null;
  const contentStart = startIdx + marker.length;

  // Find closing quote
  let contentEnd = line.indexOf('"<truncated', contentStart);
  if (contentEnd < 0) {
    contentEnd = line.lastIndexOf('"');
    if (contentEnd <= contentStart) return null;
  }

  const rawContent = line.substring(contentStart, contentEnd);

  // Skip binary content — if it starts with non-printable escape sequences, it's binary
  if (/^\\x[0-9a-f]{2}\\x[0-9a-f]{2}/i.test(rawContent) && !/^\\x[0-9a-f]{2}\\x0[0ad]/i.test(rawContent)) {
    return null;
  }

  return decodeWriteEscapes(rawContent);
}

function extractWriteContent(line: string, destPath: string): string | null {
  // Skip content extraction for known binary file extensions
  const binaryExtensions = /\.(exe|msi|dll|sys|cat|pdb|cab|iso|img|bin|dat|drv)$/i;
  if (binaryExtensions.test(destPath)) return null;

  // Find the content between the second pair of quotes
  // The first quoted string is the destination path, the second is the content
  // Pattern: write "/dest" "content"  or  write "/dest" "content"<truncated...>
  const idx = line.indexOf('" "');
  if (idx < 0) return null;

  // Content starts after '" "' (3 chars), so idx + 3
  const contentStart = idx + 3;
  // Find the closing quote — could be at end of line or before <truncated
  let contentEnd = line.indexOf('"<truncated', contentStart);
  if (contentEnd < 0) {
    // No truncation — last quote on the line
    contentEnd = line.lastIndexOf('"');
    if (contentEnd <= contentStart) return null;
  }

  const rawContent = line.substring(contentStart, contentEnd);
  return decodeWriteEscapes(rawContent);
}

/**
 * Decode libguestfs trace string escapes: \x0d\x0a → \r\n, \xHH → char, etc.
 */
function decodeWriteEscapes(s: string): string {
  let result = '';
  let i = 0;
  while (i < s.length) {
    const esc = parseHexEscapeAt(s, i);
    if (esc) {
      result += String.fromCharCode(esc.byte);
      i += esc.consumed;
      continue;
    }
    if (s[i] === '\\' && i + 1 < s.length) {
      const next = s[i + 1];
      if (next === 'n') { result += '\n'; i += 2; continue; }
      if (next === 'r') { result += '\r'; i += 2; continue; }
      if (next === 't') { result += '\t'; i += 2; continue; }
      if (next === '\\') { result += '\\'; i += 2; continue; }
      if (next === '"') { result += '"'; i += 2; continue; }
    }
    result += s[i];
    i++;
  }
  return result;
}

function isErrorFalsePositive(line: string): boolean {
  for (const fp of ERROR_FALSE_POSITIVES) {
    if (fp.test(line)) return true;
  }
  // nbdkit debug lines that mention "error" in VDDK timestamps
  if (line.startsWith('nbdkit:') && line.includes('debug:')) return true;
  return false;
}

/**
 * Parse libvirt XML captured from log lines into a V2VSourceVM structure.
 * Uses simple regex extraction — no XML parser needed for the few fields we care about.
 */
function parseLibvirtXML(lines: string[]): V2VSourceVM {
  const xml = lines.join('\n');
  const vm: V2VSourceVM = { disks: [], networks: [] };

  // VM name
  const nameMatch = xml.match(/<name>([^<]+)<\/name>/);
  if (nameMatch) vm.name = nameMatch[1];

  // Memory (in KiB)
  const memMatch = xml.match(/<memory\s+unit='KiB'>(\d+)<\/memory>/);
  if (memMatch) vm.memoryKB = parseInt(memMatch[1], 10);

  // vCPUs
  const cpuMatch = xml.match(/<vcpu[^>]*>(\d+)<\/vcpu>/);
  if (cpuMatch) vm.vcpus = parseInt(cpuMatch[1], 10);

  // Firmware / OS type
  const osTypeMatch = xml.match(/<os>[\s\S]*?<type[^>]*>([^<]+)<\/type>/);
  if (osTypeMatch) vm.firmware = osTypeMatch[1];
  if (xml.includes('<loader') || xml.includes('ovmf') || xml.includes('OVMF')) {
    vm.firmware = 'uefi';
  } else if (vm.firmware === 'hvm') {
    vm.firmware = 'bios';
  }

  // Disks: <source file='...' or <source dev='...'
  const diskRe = /<disk\s+[^>]*>[\s\S]*?<\/disk>/g;
  let diskMatch;
  while ((diskMatch = diskRe.exec(xml)) !== null) {
    const block = diskMatch[0];
    const srcFile = block.match(/<source\s+file='([^']+)'/)?.[1]
      || block.match(/<source\s+dev='([^']+)'/)?.[1]
      || block.match(/<source\s+name='([^']+)'/)?.[1];
    const device = block.match(/<target\s+dev='([^']+)'/)?.[1];
    const fmt = block.match(/<driver[^>]+type='([^']+)'/)?.[1];
    if (srcFile) vm.disks.push({ path: srcFile, format: fmt, device });
  }

  // Networks: <interface type='...'> ... <source .../> <model type='...'/>
  const netRe = /<interface\s+type='([^']+)'[^>]*>[\s\S]*?<\/interface>/g;
  let netMatch;
  while ((netMatch = netRe.exec(xml)) !== null) {
    const block = netMatch[0];
    const netType = netMatch[1];
    const model = block.match(/<model\s+type='([^']+)'/)?.[1];
    const source = block.match(/<source\s+(?:network|bridge|portgroup)='([^']+)'/)?.[1];
    vm.networks.push({ type: netType, model, source });
  }

  return vm;
}

function extractSource(line: string): string {
  if (line.startsWith('nbdkit:')) return 'nbdkit';
  if (line.startsWith('libguestfs:')) return 'libguestfs';
  if (line.startsWith('guestfsd:')) return 'guestfsd';
  if (line.startsWith('supermin:')) return 'supermin';
  if (line.startsWith('libnbd:')) return 'libnbd';
  if (/^virt-v2v-in-place:/.test(line)) return 'virt-v2v-in-place';
  if (/^virt-v2v-inspector:/.test(line)) return 'virt-v2v-inspector';
  if (/^virt-v2v-customize:|^virt-customize:/.test(line)) return 'virt-v2v-customize';
  if (/^virt-v2v:/.test(line)) return 'virt-v2v';
  return 'unknown';
}
