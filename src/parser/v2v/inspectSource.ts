/**
 * Parser for the "Inspecting the source" pipeline stage.
 *
 * Parses the raw inter-stage log lines to extract:
 *  1. Disk layout (from parted output)
 *  2. Filesystem discovery (list_filesystems: adding)
 *  3. Partition inspection steps (check_for_filesystem_on / check_filesystem)
 *  4. OS detection summary (i_root, i_type, etc.)
 */

// ── Types ───────────────────────────────────────────────────────────────────

export interface DiskInfo {
  device: string;
  sizeBytes: number;
  transport: string;
  sectorSize: number;
  tableType: string; // gpt, msdos
  model: string;
  partitions: PartitionInfo[];
}

export interface PartitionInfo {
  number: number;
  startBytes: number;
  endBytes: number;
  sizeBytes: number;
  fsType: string;
  name: string;
  flags: string;
  /** GPT partition type GUID (e.g. EFI System Partition GUID) */
  gptTypeGuid?: string;
}

export interface FilesystemEntry {
  device: string;
  fsType: string;
}

export interface InspectionStep {
  device: string;
  fsType: string;
  result: string;
}

export interface OsInfo {
  [key: string]: string;
}

export interface FsckResult {
  device: string;
  exitCode: number;
  passes: string[];
  summary: string;
}

export interface FstrimResult {
  device: string;
  trimmedHuman: string;
  trimmedBytes: number;
}

export interface BootDeviceInfo {
  device: string;
  grubSignature: boolean | null;
  mountPoints: { device: string; mountpoint: string }[];
}

export interface ParsedInspection {
  disks: DiskInfo[];
  filesystems: FilesystemEntry[];
  inspectionSteps: InspectionStep[];
  osInfo: OsInfo;
  lvmVolumes: string[];
  fsckResults: FsckResult[];
  bootDevice: BootDeviceInfo | null;
  fstrimResults: FstrimResult[];
}

// ── Parser ──────────────────────────────────────────────────────────────────

export function parseInspectContent(lines: string[]): ParsedInspection {
  const disks: DiskInfo[] = [];
  const seenDisks = new Set<string>();
  const filesystems: FilesystemEntry[] = [];
  const inspectionSteps: InspectionStep[] = [];
  const osInfo: OsInfo = {};
  const lvmVolumes: string[] = [];
  const fsckResults: FsckResult[] = [];
  let bootDevice: BootDeviceInfo | null = null;
  const fstrimResults: FstrimResult[] = [];
  let lastTrimDevice = '';

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // ── Parted output: BYT; block ────────────────────────────────────
    // Format: BYT;\n/dev/sda:SIZE:transport:sector:sector:table:model:;\npartitions...
    if (line.trim() === 'BYT;' && i + 1 < lines.length) {
      const diskLine = lines[i + 1];
      const diskMatch = diskLine.match(
        /^(\/dev\/\w+):(\d+)B:(\w+):(\d+):(\d+):(\w+):(.+):;$/,
      );
      if (diskMatch) {
        const device = diskMatch[1];
        // Deduplicate: parted output repeats many times
        if (!seenDisks.has(device)) {
          seenDisks.add(device);
          const disk: DiskInfo = {
            device,
            sizeBytes: parseInt(diskMatch[2], 10),
            transport: diskMatch[3],
            sectorSize: parseInt(diskMatch[4], 10),
            tableType: diskMatch[6],
            model: diskMatch[7],
            partitions: [],
          };
          // Parse partition lines
          let j = i + 2;
          while (j < lines.length) {
            const partLine = lines[j];
            const partMatch = partLine.match(
              /^(\d+):(\d+)B:(\d+)B:(\d+)B:([^:]*):([^:]*):([^;]*);$/,
            );
            if (partMatch) {
              disk.partitions.push({
                number: parseInt(partMatch[1], 10),
                startBytes: parseInt(partMatch[2], 10),
                endBytes: parseInt(partMatch[3], 10),
                sizeBytes: parseInt(partMatch[4], 10),
                fsType: partMatch[5] || '',
                name: partMatch[6] || '',
                flags: partMatch[7] || '',
              });
              j++;
            } else {
              break;
            }
          }
          disks.push(disk);
        }
      }
    }

    // ── list_filesystems: adding ──────────────────────────────────────
    const fsMatch = line.match(
      /list_filesystems: adding "([^"]+)", "([^"]+)"/,
    );
    if (fsMatch) {
      const entry = { device: fsMatch[1], fsType: fsMatch[2] };
      // Deduplicate
      if (!filesystems.some((f) => f.device === entry.device)) {
        filesystems.push(entry);
      }
    }

    // ── LVM volumes ──────────────────────────────────────────────────
    // Lines like "  rhel/root" after "command: lvm: stdout:"
    if (
      line.startsWith('command: lvm: stdout:') &&
      i + 1 < lines.length
    ) {
      let j = i + 1;
      while (j < lines.length) {
        const lvLine = lines[j].trim();
        if (lvLine && /^[\w-]+\/[\w-]+$/.test(lvLine)) {
          if (!lvmVolumes.includes(lvLine)) {
            lvmVolumes.push(lvLine);
          }
          j++;
        } else {
          break;
        }
      }
    }

    // ── check_for_filesystem_on ──────────────────────────────────────
    const checkMatch = line.match(
      /check_for_filesystem_on:\s+(\S+)\s+\((\w+)\)/,
    );
    if (checkMatch) {
      inspectionSteps.push({
        device: checkMatch[1],
        fsType: checkMatch[2],
        result: '', // filled by check_filesystem below
      });
    }

    // ── check_filesystem result ──────────────────────────────────────
    const resultMatch = line.match(
      /check_filesystem:\s+(\S+)\s+matched\s+(.+)/,
    );
    if (resultMatch) {
      // Find the last step for this device and fill the result
      for (let k = inspectionSteps.length - 1; k >= 0; k--) {
        if (inspectionSteps[k].device === resultMatch[1] && !inspectionSteps[k].result) {
          inspectionSteps[k].result = resultMatch[2].trim();
          break;
        }
      }
    }

    // ── GPT partition type GUIDs ───────────────────────────────────────
    // From: libguestfs: trace: v2v: part_get_gpt_type = "C12A7328-..."
    const gptMatch = line.match(
      /part_get_gpt_type\s+=\s+"([^"]+)"/,
    );
    if (gptMatch) {
      const guid = gptMatch[1];
      // Look backwards for the preceding part_get_gpt_type call to find device + partnum
      // Format: part_get_gpt_type "/dev/sda" 1
      for (let k = i - 1; k >= Math.max(0, i - 10); k--) {
        const callMatch = lines[k].match(
          /part_get_gpt_type\s+"(\/dev\/\w+)"\s+(\d+)/,
        );
        if (callMatch) {
          const dev = callMatch[1];
          const partNum = parseInt(callMatch[2], 10);
          // Find the disk and partition
          const disk = disks.find((d) => d.device === dev);
          if (disk) {
            const part = disk.partitions.find((p) => p.number === partNum);
            if (part && !part.gptTypeGuid) {
              part.gptTypeGuid = guid;
            }
          }
          break;
        }
      }
    }

    // ── OS info summary (i_root = ..., i_type = ...) ─────────────────
    const osMatch = line.match(/^i_(\w+)\s+=\s+(.*)$/);
    if (osMatch) {
      const key = osMatch[1];
      const value = osMatch[2].trim();
      if (value && !osInfo[key]) {
        osInfo[key] = value;
      }
    }

    // ── fstrim results ────────────────────────────────────────────────
    // "info: trimming /dev/rhel/root" then "fstrim -v /sysroot/" then "/sysroot/: 12.8 GiB (13753122816 bytes) trimmed"
    const trimInfoMatch = line.match(/info: trimming\s+(\/dev\/\S+)/);
    if (trimInfoMatch) lastTrimDevice = trimInfoMatch[1];

    const trimResultMatch = line.match(/\/sysroot\/:\s+(.+?)\s+\((\d+)\s+bytes\)\s+trimmed/);
    if (trimResultMatch && lastTrimDevice) {
      // Deduplicate (fstrim output appears twice in logs)
      if (!fstrimResults.some((r) => r.device === lastTrimDevice)) {
        fstrimResults.push({
          device: lastTrimDevice,
          trimmedHuman: trimResultMatch[1],
          trimmedBytes: parseInt(trimResultMatch[2], 10),
        });
      }
    }

    // ── Boot device detection ─────────────────────────────────────────
    const grubSigMatch = line.match(/has_grub_signature:.*"GRUB" signature on (\/dev\/\S+)\?\s+(true|false)/);
    if (grubSigMatch) {
      if (!bootDevice) bootDevice = { device: '', grubSignature: null, mountPoints: [] };
      bootDevice.grubSignature = grubSigMatch[2] === 'true';
    }

    const bootFsMatch = line.match(/get_device_of_boot_filesystem:\s+found\s+\/boot\s+filesystem on device\s+(\/dev\/\S+)/);
    if (bootFsMatch) {
      if (!bootDevice) bootDevice = { device: '', grubSignature: null, mountPoints: [] };
      bootDevice.device = bootFsMatch[1];
    }

    // mountpoints = ["/dev/rhel/root", "/", "/dev/sda2", "/boot", ...]
    const mpMatch = line.match(/mountpoints\s+=\s+\[([^\]]+)\]/);
    if (mpMatch && !bootDevice?.mountPoints.length) {
      if (!bootDevice) bootDevice = { device: '', grubSignature: null, mountPoints: [] };
      const parts = mpMatch[1].split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
      for (let m = 0; m < parts.length - 1; m += 2) {
        bootDevice.mountPoints.push({ device: parts[m], mountpoint: parts[m + 1] });
      }
    }

    // ── e2fsck / xfs_repair results ────────────────────────────────────
    // e2fsck call: "e2fsck "/dev/sda2" "forceno:true""
    const fsckCallMatch = line.match(/e2fsck\s+"(\/dev\/\S+)"/);
    if (fsckCallMatch) {
      fsckResults.push({
        device: fsckCallMatch[1],
        exitCode: -1, // filled later
        passes: [],
        summary: '',
      });
    }

    // e2fsck pass lines: "Pass 1: Checking inodes, blocks, and sizes"
    const passMatch = line.match(/^Pass \d+:\s+(.+)/);
    if (passMatch && fsckResults.length > 0) {
      const last = fsckResults[fsckResults.length - 1];
      last.passes.push(passMatch[0]);
    }

    // e2fsck summary: "/dev/sda2: 167058/954720 files ..."
    const fsckSummaryMatch = line.match(/^(\/dev\/\S+):\s+\d+\/\d+\s+files.+blocks$/);
    if (fsckSummaryMatch && fsckResults.length > 0) {
      const last = fsckResults[fsckResults.length - 1];
      last.summary = line.trim();
    }

    // e2fsck result: "e2fsck = 0"
    const fsckResultMatch = line.match(/e2fsck\s+=\s+(\d+)/);
    if (fsckResultMatch && fsckResults.length > 0) {
      const last = fsckResults[fsckResults.length - 1];
      last.exitCode = parseInt(fsckResultMatch[1], 10);
    }

    // xfs_repair result: "xfs_repair = 0"
    const xfsResultMatch = line.match(/xfs_repair\s+=\s+(\d+)/);
    if (xfsResultMatch) {
      // Look back for the device
      for (let k = i - 1; k >= Math.max(0, i - 20); k--) {
        const devMatch = lines[k].match(/xfs_repair\s+"(\/dev\/\S+)"/);
        if (devMatch) {
          fsckResults.push({
            device: devMatch[1],
            exitCode: parseInt(xfsResultMatch[1], 10),
            passes: [],
            summary: 'xfs_repair',
          });
          break;
        }
      }
    }

    i++;
  }

  return { disks, filesystems, inspectionSteps, osInfo, lvmVolumes, fsckResults, bootDevice, fstrimResults };
}
