/**
 * Parser for the "Copying disk N/M" pipeline stage.
 *
 * Parses: input/output disk info from nbdinfo, VDDK connection details
 * (VMDK path, transport mode, NFC endpoint, buffer sizes, block params),
 * nbdkit filter stack, copy worker thread count, VDDK warnings,
 * and MBR/GPT partition info from the nbdinfo content field.
 */

// ── Types ───────────────────────────────────────────────────────────────────

export interface NbdInfoDisk {
  label: string; // "input disk 1/3" or "output disk 1/3"
  protocol: string;
  exportSize: number;
  exportSizeHuman: string;
  uri: string;
  contentDescription: string;
  capabilities: Record<string, string>; // key -> "true"/"false"/value
  blockSizes: { minimum: string; preferred: string; maximum: string };
}

export interface VddkConnection {
  vmdkPath: string;
  transportMode: string;
  nfcEndpoint: string;
  backingSize: number;
  blockParams: { minblock: number; maxdata: number; maxlen: number } | null;
  socketBuffers: { clientSnd: number; clientRcv: number; serverSnd: number; serverRcv: number } | null;
}

export interface MbrPartition {
  id: string;
  active: boolean;
  startSector: number;
  sectorCount: number;
  sizeBytes: number;
}

export interface DiskCopyData {
  inputDisk: NbdInfoDisk | null;
  outputDisk: NbdInfoDisk | null;
  vddkConnection: VddkConnection | null;
  filterStack: string[];
  workerCount: number;
  warnings: string[];
  partitions: MbrPartition[];
}

// ── Capability metadata ─────────────────────────────────────────────────────

export const CAPABILITY_LABELS: Record<string, string> = {
  is_rotational: 'Rotational',
  is_read_only: 'Read Only',
  can_write: 'Write',
  can_zero: 'Zero',
  can_fast_zero: 'Fast Zero',
  can_trim: 'Trim',
  can_fua: 'Force Unit Access',
  can_flush: 'Flush',
  can_multi_conn: 'Multi-connection',
  can_cache: 'Cache',
  can_extents: 'Extents',
  can_df: 'Disk Free',
  can_block_status_payload: 'Block Status Payload',
};

// ── Parser ──────────────────────────────────────────────────────────────────

export function parseDiskCopyContent(lines: string[]): DiskCopyData {
  let inputDisk: NbdInfoDisk | null = null;
  let outputDisk: NbdInfoDisk | null = null;
  let vddkConnection: VddkConnection | null = null;
  const filterStack: string[] = [];
  let workerCount = 0;
  const warnings: string[] = [];
  const partitions: MbrPartition[] = [];

  // State for parsing multi-line nbdinfo blocks
  let currentDisk: NbdInfoDisk | null = null;
  let currentDiskTarget: 'input' | 'output' | null = null;

  // State for VDDK connection
  let vmdkPath = '';
  let transportMode = '';
  let nfcEndpoint = '';
  let backingSize = 0;
  let blockParams: VddkConnection['blockParams'] = null;
  let socketBuffers: VddkConnection['socketBuffers'] = null;

  // Track seen filters to avoid duplication
  const seenFilters = new Set<string>();
  // Track highest worker thread index
  let maxWorkerIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // ── nbdinfo disk info blocks ──────────────────────────────────
    const diskInfoMatch = line.match(/^info:\s+(input|output)\s+disk\s+(\d+\/\d+):/);
    if (diskInfoMatch) {
      // Finalize previous disk if any
      if (currentDisk && currentDiskTarget) {
        if (currentDiskTarget === 'input') inputDisk = currentDisk;
        else outputDisk = currentDisk;
      }
      currentDiskTarget = diskInfoMatch[1] as 'input' | 'output';
      currentDisk = {
        label: `${diskInfoMatch[1]} disk ${diskInfoMatch[2]}`,
        protocol: '',
        exportSize: 0,
        exportSizeHuman: '',
        uri: '',
        contentDescription: '',
        capabilities: {},
        blockSizes: { minimum: '', preferred: '', maximum: '' },
      };
      continue;
    }

    // Inside an nbdinfo block, parse indented lines
    if (currentDisk) {
      // Protocol line (not indented, follows the disk info header)
      const protoMatch = line.match(/^protocol:\s+(.+)/);
      if (protoMatch) {
        currentDisk.protocol = protoMatch[1].trim();
        continue;
      }

      // Export size
      const sizeMatch = line.match(/^\texport-size:\s+(\d+)\s+\(([^)]+)\)/);
      if (sizeMatch) {
        currentDisk.exportSize = parseInt(sizeMatch[1], 10);
        currentDisk.exportSizeHuman = sizeMatch[2];
        continue;
      }

      // Content description
      const contentMatch = line.match(/^\tcontent:\s+(.+)/);
      if (contentMatch) {
        currentDisk.contentDescription = contentMatch[1].trim();
        continue;
      }

      // URI
      const uriMatch = line.match(/^\turi:\s+(.+)/);
      if (uriMatch) {
        currentDisk.uri = uriMatch[1].trim();
        continue;
      }

      // Block sizes
      const blockMinMatch = line.match(/^\tblock_size_minimum:\s+(.+)/);
      if (blockMinMatch) {
        currentDisk.blockSizes.minimum = blockMinMatch[1].trim();
        continue;
      }
      const blockPrefMatch = line.match(/^\tblock_size_preferred:\s+(.+)/);
      if (blockPrefMatch) {
        currentDisk.blockSizes.preferred = blockPrefMatch[1].trim();
        continue;
      }
      const blockMaxMatch = line.match(/^\tblock_size_maximum:\s+(.+)/);
      if (blockMaxMatch) {
        currentDisk.blockSizes.maximum = blockMaxMatch[1].trim();
        continue;
      }

      // Capabilities (boolean and other tab-indented key: value)
      const capMatch = line.match(/^\t(is_\w+|can_\w+):\s+(.+)/);
      if (capMatch) {
        currentDisk.capabilities[capMatch[1]] = capMatch[2].trim();
        continue;
      }

      // End of nbdinfo block: non-indented line that isn't protocol/export/contexts
      if (!line.startsWith('\t') && !line.startsWith('protocol:') && !line.startsWith('export=') && line.trim() !== '' && !line.startsWith('\t\t')) {
        // Finalize current disk
        if (currentDiskTarget === 'input') inputDisk = currentDisk;
        else if (currentDiskTarget === 'output') outputDisk = currentDisk;
        currentDisk = null;
        currentDiskTarget = null;
        // Don't continue - process this line further below
      } else {
        continue;
      }
    }

    // ── VDDK connection details from nbdkit debug lines ───────────

    // VMDK path from VixDiskLib_Open
    const vmdkMatch = line.match(/VixDiskLib_Open\s+\(connection,\s+(.+?),\s+\d+,/);
    if (vmdkMatch && !vmdkPath) {
      vmdkPath = vmdkMatch[1].trim();
    }

    // Transport mode
    const transportMatch = line.match(/transport mode:\s+(\w+)/);
    if (transportMatch) {
      transportMode = transportMatch[1];
    }

    // NFC endpoint
    const nfcMatch = line.match(/NBD_ClientOpen: attempting to create connection to\s+(.+)/);
    if (nfcMatch && !nfcEndpoint) {
      nfcEndpoint = nfcMatch[1].trim();
    }

    // Socket buffer sizes
    const socketMatch = line.match(/NfcAioOpenSession: the socket options client snd buffer size (\d+),\s+rcv buffer size (\d+)/);
    if (socketMatch && !socketBuffers) {
      socketBuffers = {
        clientSnd: parseInt(socketMatch[1], 10),
        clientRcv: parseInt(socketMatch[2], 10),
        serverSnd: 0,
        serverRcv: 0,
      };
    }
    const serverSocketMatch = line.match(/NfcAioOpenSession: the socket options server snd buffer size (\d+),\s+rcv buffer size (\d+)/);
    if (serverSocketMatch && socketBuffers) {
      socketBuffers.serverSnd = parseInt(serverSocketMatch[1], 10);
      socketBuffers.serverRcv = parseInt(serverSocketMatch[2], 10);
    }

    // Backing size from cow filter
    const cowSizeMatch = line.match(/cow: underlying file size:\s+(\d+)/);
    if (cowSizeMatch) {
      backingSize = parseInt(cowSizeMatch[1], 10);
    }

    // Block params from handle values
    const blockParamsMatch = line.match(/handle values minblock=(\d+)\s+maxdata=(\d+)\s+maxlen=(\d+)/);
    if (blockParamsMatch) {
      blockParams = {
        minblock: parseInt(blockParamsMatch[1], 10),
        maxdata: parseInt(blockParamsMatch[2], 10),
        maxlen: parseInt(blockParamsMatch[3], 10),
      };
    }

    // ── Filter stack (from first "FILTER: open" sequence) ─────────
    // Pattern: "nbdkit: vddk[N]: debug: FILTER: open"
    const filterOpenMatch = line.match(/nbdkit:\s+\w+\[\d+\]:\s+debug:\s+(\w[\w-]+):\s+open\s+readonly/);
    if (filterOpenMatch) {
      const filterName = filterOpenMatch[1];
      if (!seenFilters.has(filterName)) {
        seenFilters.add(filterName);
        filterStack.push(filterName);
      }
    }

    // ── Worker thread count ───────────────────────────────────────
    const workerMatch = line.match(/starting worker thread\s+\w+\.(\d+)/);
    if (workerMatch) {
      const idx = parseInt(workerMatch[1], 10);
      if (idx > maxWorkerIdx) maxWorkerIdx = idx;
    }

    // ── VDDK warnings ────────────────────────────────────────────
    const warnMatch = line.match(/warning\s+-\[\d+\]\s+\[.+?\]\s+(.+)/);
    if (warnMatch) {
      const msg = warnMatch[1].trim();
      if (!warnings.includes(msg)) {
        warnings.push(msg);
      }
    }
  }

  // Finalize last nbdinfo block
  if (currentDisk && currentDiskTarget) {
    if (currentDiskTarget === 'input') inputDisk = currentDisk;
    else outputDisk = currentDisk;
  }

  // Build worker count
  if (maxWorkerIdx >= 0) {
    workerCount = maxWorkerIdx + 1;
  }

  // Build VDDK connection if we found any data
  if (vmdkPath || transportMode) {
    vddkConnection = {
      vmdkPath,
      transportMode,
      nfcEndpoint,
      backingSize,
      blockParams,
      socketBuffers,
    };
  }

  // Parse MBR partitions from input disk content description
  if (inputDisk?.contentDescription) {
    const desc = inputDisk.contentDescription;
    // Match each "partition N : ID=0xNN, ..." segment
    const partRegex = /partition\s+(\d+)\s*:\s*ID=(0x[\da-fA-F]+),?\s*(active,?)?\s*.*?startsector\s+(\d+),\s*(\d+)\s+sectors/g;
    let m;
    while ((m = partRegex.exec(desc)) !== null) {
      partitions.push({
        id: m[2],
        active: !!m[3],
        startSector: parseInt(m[4], 10),
        sectorCount: parseInt(m[5], 10),
        sizeBytes: parseInt(m[5], 10) * 512,
      });
    }
  }

  return { inputDisk, outputDisk, vddkConnection, filterStack, workerCount, warnings, partitions };
}

export function isDiskCopyStage(name: string): boolean {
  return /^Copying disk\s+\d+/i.test(name);
}
