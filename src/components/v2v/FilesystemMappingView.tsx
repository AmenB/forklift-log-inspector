/**
 * Structured visualization for the "Mapping filesystem data to avoid copying
 * unused and blank areas" pipeline stage.
 *
 * Parses: disk layout (parted), discovered filesystems (list_filesystems/blkid),
 * partition type GUIDs (sfdisk), device topology (by-path), per-device trim
 * workflow (mount → fstrim → result), and trim failures.
 */
import { useMemo, useState } from 'react';
import { formatBytes } from '../../utils/format';
import { SectionHeader } from './shared';

// ── Types ───────────────────────────────────────────────────────────────────

interface DiskInfo {
  device: string;
  sizeBytes: number;
  transport: string;
  sectorSize: number;
  tableType: string;
  model: string;
  partitions: PartitionInfo[];
}

interface PartitionInfo {
  number: number;
  startBytes: number;
  endBytes: number;
  sizeBytes: number;
  fsType: string;
  name: string;
  flags: string;
}

interface DiscoveredFs {
  device: string;
  fsType: string;
}

interface PartitionGuid {
  device: string;
  partNum: number;
  guid: string;
  guidName: string;
}

interface DevicePath {
  path: string;
  device: string;
}

interface TrimOp {
  device: string;
  mountpoint: string;
  mountOptions: string;
  trimmedHuman: string;
  trimmedBytes: number;
  fsVersion: string;
  trimFailed: boolean;
  failReason: string;
}

interface MappingData {
  disks: DiskInfo[];
  filesystems: DiscoveredFs[];
  partitionGuids: PartitionGuid[];
  devicePaths: DevicePath[];
  trimOps: TrimOp[];
}

// Well-known GPT partition type GUIDs
const GUID_NAMES: Record<string, string> = {
  'C12A7328-F81F-11D2-BA4B-00A0C93EC93B': 'EFI System',
  '21686148-6449-6E6F-744E-656564454649': 'BIOS Boot',
  '0FC63DAF-8483-4772-8E79-3D69D8477DE4': 'Linux Filesystem',
  'E6D6D379-F507-44C2-A23C-238F2A3DF928': 'Linux LVM',
  '0657FD6D-A4AB-43C4-84E5-0933C84B4F4F': 'Linux Swap',
  'A19D880F-05FC-4D3B-A006-743F0F84911E': 'Linux RAID',
  'EBD0A0A2-B9E5-4433-87C0-68B6B72699C7': 'Microsoft Basic Data',
  'E3C9E316-0B5C-4DB8-817D-F92DF00215AE': 'Microsoft Reserved',
  'DE94BBA4-06D1-4D40-A16A-BFD50179D6AC': 'Windows Recovery',
};

// ── Parser ──────────────────────────────────────────────────────────────────

function parseMappingContent(lines: string[]): MappingData {
  const disks: DiskInfo[] = [];
  const filesystems: DiscoveredFs[] = [];
  const partitionGuids: PartitionGuid[] = [];
  const devicePaths: DevicePath[] = [];
  const trimOps: TrimOp[] = [];

  const seenDisks = new Set<string>();
  const seenFs = new Set<string>();
  const seenGuids = new Set<string>();

  // Trim workflow tracking
  let lastTrimDevice = '';
  let lastMountOptions = '';
  let lastFsVersion = '';
  let trimFailed = false;
  let trimFailReason = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // ── Parted output: BYT; block ──────────────────────────────────
    if (line.trim() === 'BYT;' && i + 1 < lines.length) {
      const diskLine = lines[i + 1];
      const diskMatch = diskLine.match(
        /^(\/dev\/\w+):(\d+)B:(\w+):(\d+):(\d+):(\w+):(.+):;$/,
      );
      if (diskMatch) {
        const device = diskMatch[1];
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
          let j = i + 2;
          while (j < lines.length) {
            const partMatch = lines[j].match(
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

    // ── Filesystem discovery ────────────────────────────────────────
    const fsMatch = line.match(/list_filesystems: adding "([^"]+)", "([^"]+)"/);
    if (fsMatch) {
      const key = fsMatch[1];
      if (!seenFs.has(key)) {
        seenFs.add(key);
        filesystems.push({ device: key, fsType: fsMatch[2] });
      }
    }

    // ── blkid filesystem type ──────────────────────────────────────
    // "command: blkid: stdout:" followed by the type on next line
    if (line.includes('blkid') && line.includes('stdout:') && i + 1 < lines.length) {
      const blkType = lines[i + 1].trim();
      // Look backwards for the blkid command to get the device
      for (let k = i - 1; k >= Math.max(0, i - 5); k--) {
        const cmdMatch = lines[k].match(/blkid.*'(\/dev\/\S+)'/);
        if (cmdMatch) {
          const dev = cmdMatch[1];
          if (!seenFs.has(dev)) {
            seenFs.add(dev);
            filesystems.push({ device: dev, fsType: blkType });
          }
          break;
        }
      }
    }

    // ── Partition type GUIDs from sfdisk ────────────────────────────
    // "command: sfdisk '--part-type' '/dev/sda' '1'" → next relevant line is GUID
    const sfdiskMatch = line.match(/sfdisk '--part-type' '(\/dev\/\w+)' '(\d+)'/);
    if (sfdiskMatch) {
      // Look ahead for "sfdisk: stdout:" then the GUID
      for (let k = i + 1; k < Math.min(lines.length, i + 10); k++) {
        if (lines[k].includes('sfdisk: stdout:') || lines[k].includes('sfdisk returned')) continue;
        const guidCandidate = lines[k].trim();
        if (/^[0-9A-Fa-f]{8}-/.test(guidCandidate)) {
          const guid = guidCandidate.toUpperCase();
          const guidKey = `${sfdiskMatch[1]}:${sfdiskMatch[2]}`;
          if (!seenGuids.has(guidKey)) {
            seenGuids.add(guidKey);
            partitionGuids.push({
              device: sfdiskMatch[1],
              partNum: parseInt(sfdiskMatch[2], 10),
              guid,
              guidName: GUID_NAMES[guid] || '',
            });
          }
          break;
        }
      }
    }

    // ── Device by-path entries ──────────────────────────────────────
    // Lines like "pci-0000:02:00.0-scsi-0:0:0:0-part1" after "ls: stdout:"
    if (/^pci-\S+/.test(line.trim())) {
      const path = line.trim();
      if (!devicePaths.some((d) => d.path === path)) {
        // Infer device from path pattern
        let device = '';
        if (path.includes('-part')) {
          const partNum = path.match(/-part(\d+)/)?.[1] || '';
          // The base device is derived from the path without -partN
          device = partNum ? `part${partNum}` : '';
        } else if (path.endsWith('-0') || path.match(/-scsi-\d+:\d+:\d+:\d+$/)) {
          device = 'disk';
        }
        devicePaths.push({ path, device });
      }
    }

    // ── Trim workflow: mount → trim → result ───────────────────────
    // "info: trimming /dev/sda1"
    const trimInfoMatch = line.match(/info: trimming\s+(\/dev\/\S+)/);
    if (trimInfoMatch) {
      lastTrimDevice = trimInfoMatch[1];
      trimFailed = false;
      trimFailReason = '';
    }

    // "mount '-o' 'discard' '/dev/sda1' '/sysroot/'"
    const mountMatch = line.match(/mount\s+'(-o)'\s+'([^']+)'\s+'(\/dev\/\S+)'/);
    if (mountMatch) {
      lastMountOptions = mountMatch[2];
    }

    // XFS mount info: "XFS (sda1): Mounting V5 Filesystem UUID"
    const xfsMatch = line.match(/XFS \(\w+\): Mounting (V\d+) Filesystem/);
    if (xfsMatch) lastFsVersion = `XFS ${xfsMatch[1]}`;

    // Trim failure: "could not trim, no trim methods worked"
    if (line.includes('could not trim')) {
      trimFailed = true;
      trimFailReason = line.includes('no trim methods worked') ? 'No trim methods worked' : 'Trim failed';
    }

    // Trim result: "/sysroot/: 10 GiB (10724814848 bytes) trimmed"
    const trimResultMatch = line.match(/\/sysroot\/:\s+(.+?)\s+\((\d+)\s+bytes\)\s+trimmed/);
    if (trimResultMatch && lastTrimDevice) {
      // Deduplicate (fstrim output appears twice in logs)
      if (!trimOps.some((t) => t.device === lastTrimDevice)) {
        trimOps.push({
          device: lastTrimDevice,
          mountpoint: '/sysroot/',
          mountOptions: lastMountOptions,
          trimmedHuman: trimResultMatch[1],
          trimmedBytes: parseInt(trimResultMatch[2], 10),
          fsVersion: lastFsVersion,
          trimFailed,
          failReason: trimFailReason,
        });
        lastFsVersion = '';
        lastMountOptions = '';
        trimFailed = false;
        trimFailReason = '';
      }
    }
  }

  return { disks, filesystems, partitionGuids, devicePaths, trimOps };
}

// ── Component ───────────────────────────────────────────────────────────────

export function FilesystemMappingView({ content }: { content: string[] }) {
  const parsed = useMemo(() => parseMappingContent(content), [content]);

  const totalTrimmedBytes = parsed.trimOps.reduce((sum, t) => sum + t.trimmedBytes, 0);
  const hasData =
    parsed.disks.length > 0 ||
    parsed.filesystems.length > 0 ||
    parsed.trimOps.length > 0 ||
    parsed.devicePaths.length > 0;

  if (!hasData) return null;

  return (
    <div className="space-y-4 text-sm">
      {/* Summary bar */}
      <div className="flex flex-wrap items-center gap-2">
        {parsed.disks.length > 0 && (
          <SummaryBadge color="slate">
            {parsed.disks.length} disk{parsed.disks.length !== 1 ? 's' : ''}
          </SummaryBadge>
        )}
        {parsed.filesystems.length > 0 && (
          <SummaryBadge color="blue">
            {parsed.filesystems.length} filesystem{parsed.filesystems.length !== 1 ? 's' : ''}
          </SummaryBadge>
        )}
        {parsed.partitionGuids.length > 0 && (
          <SummaryBadge color="purple">
            {parsed.partitionGuids.length} partition{parsed.partitionGuids.length !== 1 ? 's' : ''}
          </SummaryBadge>
        )}
        {parsed.trimOps.length > 0 && (
          <SummaryBadge color="green">
            {parsed.trimOps.length} trimmed &middot; {formatBytes(totalTrimmedBytes)} reclaimed
          </SummaryBadge>
        )}
      </div>

      {/* Disk Layout */}
      {parsed.disks.length > 0 && (
        <DiskLayoutSection disks={parsed.disks} filesystems={parsed.filesystems} partitionGuids={parsed.partitionGuids} />
      )}

      {/* Discovered Filesystems (if no disks found to show them inline) */}
      {parsed.disks.length === 0 && parsed.filesystems.length > 0 && (
        <FilesystemsSection filesystems={parsed.filesystems} />
      )}

      {/* Trim Operations */}
      {parsed.trimOps.length > 0 && (
        <TrimSection trimOps={parsed.trimOps} totalBytes={totalTrimmedBytes} />
      )}

      {/* Device Topology */}
      {parsed.devicePaths.length > 0 && (
        <DevicePathsSection paths={parsed.devicePaths} />
      )}
    </div>
  );
}

/** Detect if this is a "Mapping filesystem data" stage. */
// eslint-disable-next-line react-refresh/only-export-components
export function isFilesystemMappingStage(name: string): boolean {
  const lower = name.toLowerCase();
  return (lower.includes('mapping') && lower.includes('filesystem'))
    || (lower.includes('mapping') && lower.includes('unused'))
    || (lower.includes('mapping') && lower.includes('blank'));
}

// ── Sub-sections ────────────────────────────────────────────────────────────

function SummaryBadge({ children, color }: { children: React.ReactNode; color: 'green' | 'blue' | 'slate' | 'purple' }) {
  const colors = {
    green: 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300',
    blue: 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300',
    slate: 'bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-gray-300',
    purple: 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300',
  };
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${colors[color]}`}>
      {children}
    </span>
  );
}

// ── Disk Layout ─────────────────────────────────────────────────────────────

function DiskLayoutSection({
  disks,
  filesystems,
  partitionGuids,
}: {
  disks: DiskInfo[];
  filesystems: DiscoveredFs[];
  partitionGuids: PartitionGuid[];
}) {
  return (
    <div>
      <SectionHeader title="Disk Layout" count={disks.length} />
      <div className="space-y-3">
        {disks.map((disk) => {
          // Build a partition device → detected fs type map
          const fsMap = new Map<string, string>();
          for (const fs of filesystems) {
            fsMap.set(fs.device, fs.fsType);
          }
          // Build partition number → GUID map
          const guidMap = new Map<number, PartitionGuid>();
          for (const pg of partitionGuids) {
            if (pg.device === disk.device) {
              guidMap.set(pg.partNum, pg);
            }
          }

          return (
            <div key={disk.device} className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
              {/* Disk header */}
              <div className="flex items-baseline gap-3 px-3 py-2 bg-slate-50 dark:bg-slate-800/50">
                <span className="font-mono text-xs font-semibold text-slate-700 dark:text-gray-200">
                  {disk.device}
                </span>
                <span className="text-[10px] text-slate-500 dark:text-gray-400">
                  {formatBytes(disk.sizeBytes)}
                </span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-gray-300 font-mono">
                  {disk.tableType}
                </span>
                {disk.model && (
                  <span className="text-[10px] text-slate-400 dark:text-gray-500 truncate max-w-[200px]">
                    {disk.model}
                  </span>
                )}
                <span className="text-[10px] text-slate-400 dark:text-gray-500">
                  {disk.transport} &middot; {disk.sectorSize}B sectors
                </span>
              </div>

              {/* Partitions table */}
              {disk.partitions.length > 0 && (
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="text-left text-slate-400 dark:text-gray-500 border-b border-slate-100 dark:border-slate-800">
                      <th className="px-3 py-1 font-medium">Device</th>
                      <th className="px-3 py-1 font-medium">Size</th>
                      <th className="px-3 py-1 font-medium">Type</th>
                      <th className="px-3 py-1 font-medium">Label</th>
                      <th className="px-3 py-1 font-medium">Flags</th>
                      <th className="px-3 py-1 font-medium">GUID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {disk.partitions.map((part) => {
                      const partDevice = `${disk.device}${part.number}`;
                      const detectedFs = fsMap.get(partDevice) || part.fsType;
                      const guid = guidMap.get(part.number);
                      return (
                        <tr key={part.number} className="border-b border-slate-50 dark:border-slate-800/50 hover:bg-slate-50 dark:hover:bg-slate-800/30">
                          <td className="px-3 py-1.5 font-mono text-slate-600 dark:text-gray-300">
                            {partDevice}
                          </td>
                          <td className="px-3 py-1.5 text-slate-600 dark:text-gray-300">
                            {formatBytes(part.sizeBytes)}
                          </td>
                          <td className="px-3 py-1.5">
                            <FsTypeBadge fsType={detectedFs} />
                          </td>
                          <td className="px-3 py-1.5 text-slate-500 dark:text-gray-400">
                            {part.name || '—'}
                          </td>
                          <td className="px-3 py-1.5 text-slate-400 dark:text-gray-500 text-[10px]">
                            {part.flags || '—'}
                          </td>
                          <td className="px-3 py-1.5">
                            {guid ? (
                              <span className="text-[10px] text-purple-600 dark:text-purple-400" title={guid.guid}>
                                {guid.guidName || guid.guid.slice(0, 13) + '...'}
                              </span>
                            ) : (
                              <span className="text-slate-300 dark:text-gray-600">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FsTypeBadge({ fsType }: { fsType: string }) {
  if (!fsType || fsType === 'unknown') {
    return <span className="text-[10px] text-slate-400 dark:text-gray-500 italic">unknown</span>;
  }
  const colorClass =
    fsType === 'xfs' ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300' :
    fsType === 'ext4' || fsType === 'ext3' || fsType === 'ext2' ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300' :
    fsType === 'vfat' || fsType === 'fat16' || fsType === 'fat32' ? 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300' :
    fsType === 'ntfs' ? 'bg-indigo-50 dark:bg-indigo-900/20 text-indigo-700 dark:text-indigo-300' :
    fsType === 'swap' ? 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300' :
    'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-gray-300';

  return (
    <span className={`px-1.5 py-0.5 rounded font-mono text-[10px] ${colorClass}`}>
      {fsType}
    </span>
  );
}

// ── Filesystem list (standalone, when no disk layout is available) ───────────

function FilesystemsSection({ filesystems }: { filesystems: DiscoveredFs[] }) {
  return (
    <div>
      <SectionHeader title="Discovered Filesystems" count={filesystems.length} />
      <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-left text-slate-400 dark:text-gray-500 border-b border-slate-100 dark:border-slate-800">
              <th className="px-3 py-1 font-medium">Device</th>
              <th className="px-3 py-1 font-medium">Type</th>
            </tr>
          </thead>
          <tbody>
            {filesystems.map((fs, idx) => (
              <tr key={idx} className="border-b border-slate-50 dark:border-slate-800/50">
                <td className="px-3 py-1.5 font-mono text-slate-600 dark:text-gray-300">{fs.device}</td>
                <td className="px-3 py-1.5"><FsTypeBadge fsType={fs.fsType} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Trim Operations ─────────────────────────────────────────────────────────

function TrimSection({ trimOps, totalBytes }: { trimOps: TrimOp[]; totalBytes: number }) {
  return (
    <div>
      <SectionHeader title="Filesystem Trim (Unused Space)" count={trimOps.length} />
      <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-left text-slate-400 dark:text-gray-500 border-b border-slate-100 dark:border-slate-800">
              <th className="px-3 py-1 font-medium">Device</th>
              <th className="px-3 py-1 font-medium">FS</th>
              <th className="px-3 py-1 font-medium">Mount Options</th>
              <th className="px-3 py-1 font-medium text-right">Trimmed</th>
              <th className="px-3 py-1 font-medium text-center">Status</th>
            </tr>
          </thead>
          <tbody>
            {trimOps.map((t) => (
              <tr key={t.device} className="border-b border-slate-50 dark:border-slate-800/50">
                <td className="px-3 py-1.5 font-mono text-slate-600 dark:text-gray-300">
                  {t.device}
                </td>
                <td className="px-3 py-1.5">
                  {t.fsVersion ? (
                    <span className="text-[10px] text-blue-600 dark:text-blue-400">{t.fsVersion}</span>
                  ) : (
                    <span className="text-slate-300 dark:text-gray-600">—</span>
                  )}
                </td>
                <td className="px-3 py-1.5 font-mono text-[10px] text-slate-500 dark:text-gray-400">
                  {t.mountOptions || '—'}
                </td>
                <td className="px-3 py-1.5 text-right text-slate-600 dark:text-gray-300">
                  {t.trimmedHuman}
                </td>
                <td className="px-3 py-1.5 text-center">
                  {t.trimFailed ? (
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300" title={t.failReason}>
                      partial
                    </span>
                  ) : (
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300">
                      ok
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {trimOps.length > 1 && (
              <tr className="border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/30">
                <td className="px-3 py-1.5 font-medium text-slate-500 dark:text-gray-400" colSpan={3}>Total</td>
                <td className="px-3 py-1.5 text-right font-medium text-slate-700 dark:text-gray-200">
                  {formatBytes(totalBytes)}
                </td>
                <td />
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Device Paths ────────────────────────────────────────────────────────────

function DevicePathsSection({ paths }: { paths: DevicePath[] }) {
  const [open, setOpen] = useState(false);

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-gray-400 hover:text-slate-700 dark:hover:text-gray-200 transition-colors uppercase tracking-wider font-semibold mb-2"
      >
        <span className="text-[9px]">{open ? '\u25BC' : '\u25B6'}</span>
        Device Paths (by-path)
        <span className="text-[10px] font-normal text-slate-400 dark:text-gray-500">({paths.length})</span>
      </button>
      {open && (
        <div className="border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 space-y-0.5 max-h-[200px] overflow-y-auto">
          {paths.map((p, idx) => (
            <div key={idx} className="font-mono text-[10px] text-slate-600 dark:text-gray-300">
              {p.path}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
