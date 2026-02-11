/**
 * Structured visualization for the "Detecting/Checking if the guest uses BIOS or UEFI to boot" stage.
 *
 * Handles two log formats:
 *  A) virt-v2v style: parted output, list_partitions, part_get_parttype
 *  B) virt-v2v-in-place style: target firmware, guest info summary, gcaps, mountpoint stats
 */
import { useMemo } from 'react';
import { formatBytes } from '../../utils/format';
import { SectionHeader } from './shared';

// ── Types ───────────────────────────────────────────────────────────────────

interface DiskLayout {
  device: string;
  sizeBytes: number;
  transport: string;
  sectorSize: number;
  tableType: string; // gpt, msdos
  model: string;
  partitions: PartitionEntry[];
}

interface PartitionEntry {
  number: number;
  startBytes: number;
  endBytes: number;
  sizeBytes: number;
  fsType: string;
  name: string;
  flags: string;
}

interface MountpointStat {
  device: string;
  mountpoint: string;
  fsType: string;
  sizeBytes: number;
  usedBytes: number;
  availBytes: number;
  usePercent: string;
}

interface ParsedBiosUefi {
  // Format A: virt-v2v style
  allPartitions: string[];
  diskLayouts: DiskLayout[];
  partTableTypes: Record<string, string>;
  byPathEntries: string[];

  // Format B: virt-v2v-in-place style
  targetFirmware: string;
  targetBootDevice: string;
  uefiMessage: string;
  guestInfo: Record<string, string>; // key-value pairs from info block
  gcaps: Record<string, string>;     // gcaps_* values
  mountpoints: MountpointStat[];
  disks: string[];                   // disk summary lines

  // Shared
  bootType: 'bios' | 'uefi' | 'unknown';
}

// ── Parser ──────────────────────────────────────────────────────────────────

function parseBiosUefi(lines: string[]): ParsedBiosUefi {
  const allPartitions: string[] = [];
  const diskLayouts: DiskLayout[] = [];
  const partTableTypes: Record<string, string> = {};
  const byPathEntries: string[] = [];

  let targetFirmware = '';
  let targetBootDevice = '';
  let uefiMessage = '';
  const guestInfo: Record<string, string> = {};
  const gcaps: Record<string, string> = {};
  const mountpoints: MountpointStat[] = [];
  const disks: string[] = [];

  let inMountpointStats = false;
  let pendingMountDevice = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // ── UEFI/BIOS message ──
    const uefiMatch = line.match(/(?:virt-v2v[\w-]*):\s*(This guest requires (?:UEFI|BIOS)[^.]*\.?)/i);
    if (uefiMatch) {
      uefiMessage = uefiMatch[1];
    }

    // ── Target firmware / boot device ──
    const fwMatch = line.match(/^target firmware:\s*(.+)/);
    if (fwMatch) targetFirmware = fwMatch[1].trim();

    const bootDevMatch = line.match(/^target boot device:\s*(.+)/);
    if (bootDevMatch) targetBootDevice = bootDevMatch[1].trim();

    // ── Guest info block (key: value format with leading whitespace) ──
    const infoMatch = line.match(/^\s{2,}(\S[^:]+):\s*(.+)/);
    if (infoMatch && !inMountpointStats) {
      const key = infoMatch[1].trim();
      const val = infoMatch[2].trim();
      if (val && key !== 'Size' && key !== 'Used' && key !== 'Available') {
        guestInfo[key] = val;
      }
    }

    // ── Source name ──
    const srcMatch = line.match(/^\s+source name:\s*(.+)/);
    if (srcMatch) guestInfo['source name'] = srcMatch[1].trim();

    // ── i_* inspection lines ──
    const iMatch = line.match(/^(i_\w+)\s*=\s*(.+)/);
    if (iMatch) guestInfo[iMatch[1]] = iMatch[2].trim();

    // ── gcaps_* lines ──
    const gcMatch = line.match(/^(gcaps_\w+)\s*=\s*(.+)/);
    if (gcMatch) gcaps[gcMatch[1]] = gcMatch[2].trim();

    // ── Disk summary lines ──
    if (line.match(/^\s+\d+\s+\[\w+\]/)) {
      disks.push(line.trim());
    }

    // ── Mountpoint stats ──
    if (line.includes('mountpoint stats:')) {
      inMountpointStats = true;
      continue;
    }
    if (inMountpointStats) {
      // Header line: Size Used Available Use%
      if (line.includes('Size') && line.includes('Used') && line.includes('Available')) continue;

      // Device line: /dev/sda1 /boot/efi (vfat):
      const devMatch = line.match(/^(\/\S+)\s+(\S+)\s+\((\w+)\):/);
      if (devMatch) {
        pendingMountDevice = `${devMatch[1]}|${devMatch[2]}|${devMatch[3]}`;
        continue;
      }

      // Size line (bytes): 627900416  6082560  621817856
      if (pendingMountDevice) {
        const numLine = line.trim();
        const nums = numLine.split(/\s+/).filter((n) => /^\d+$/.test(n));
        if (nums.length >= 3) {
          const [dev, mp, fs] = pendingMountDevice.split('|');
          mountpoints.push({
            device: dev,
            mountpoint: mp,
            fsType: fs,
            sizeBytes: parseInt(nums[0], 10),
            usedBytes: parseInt(nums[1], 10),
            availBytes: parseInt(nums[2], 10),
            usePercent: '',
          });
          pendingMountDevice = '';
          continue;
        }
        // Human-readable line with percentages: 598.8M  5.8M  593.0M  1.0%
        const pctMatch = numLine.match(/([\d.]+%)\s*$/);
        if (pctMatch && mountpoints.length > 0) {
          mountpoints[mountpoints.length - 1].usePercent = pctMatch[1];
          continue;
        }
      }

      // Stop at non-mountpoint content
      if (line.startsWith('total ') || line.startsWith('drwx') || line.startsWith('srwx') || line.startsWith('-rw')) {
        inMountpointStats = false;
      }
    }

    // ── Format A: list_partitions result ──
    const partListMatch = line.match(/list_partitions\s*=\s*\[([^\]]*)\]/);
    if (partListMatch) {
      const parts = partListMatch[1].match(/"([^"]+)"/g);
      if (parts) {
        for (const p of parts) allPartitions.push(p.replace(/"/g, ''));
      }
    }

    // ── Format A: part_get_parttype result ──
    const partTypeResult = line.match(/part_get_parttype\s*=\s*"([^"]+)"/);
    if (partTypeResult) {
      for (let j = i - 1; j >= Math.max(0, i - 20); j--) {
        const callMatch = lines[j].match(/part_get_parttype\s+"([^"]+)"/);
        if (callMatch) {
          partTableTypes[callMatch[1]] = partTypeResult[1];
          break;
        }
      }
    }

    // ── Format A: parted stdout block ──
    if (line.includes('command: parted: stdout:') || line.includes('command: parted:stdout:')) {
      const disk: DiskLayout = {
        device: '', sizeBytes: 0, transport: '', sectorSize: 0, tableType: '', model: '', partitions: [],
      };
      for (let j = i + 1; j < Math.min(i + 20, lines.length); j++) {
        const l = lines[j].trim();
        if (!l || l === 'BYT;') continue;
        if (l.match(/^\/dev\/\w+:\d+B:/)) {
          const fields = l.split(':');
          if (fields.length >= 7) {
            disk.device = fields[0];
            disk.sizeBytes = parseInt(fields[1].replace('B', ''), 10) || 0;
            disk.transport = fields[2];
            disk.sectorSize = parseInt(fields[3], 10) || 512;
            disk.tableType = fields[5];
            disk.model = fields[6];
          }
          continue;
        }
        const partMatch = l.match(/^(\d+):(\d+)B:(\d+)B:(\d+)B:([^:]*):([^:]*):([^;]*);?/);
        if (partMatch) {
          disk.partitions.push({
            number: parseInt(partMatch[1], 10),
            startBytes: parseInt(partMatch[2], 10),
            endBytes: parseInt(partMatch[3], 10),
            sizeBytes: parseInt(partMatch[4], 10),
            fsType: partMatch[5] || '', name: partMatch[6] || '', flags: partMatch[7] || '',
          });
          continue;
        }
        break;
      }
      if (disk.device && !diskLayouts.some((d) => d.device === disk.device)) {
        diskLayouts.push(disk);
      }
    }

    // ── Format A: /dev/disk/by-path entries ──
    if (line.startsWith('pci-')) {
      byPathEntries.push(line.trim());
    }
  }

  // Determine boot type
  let bootType: 'bios' | 'uefi' | 'unknown' = 'unknown';

  // Format B: explicit target firmware
  if (targetFirmware) {
    bootType = targetFirmware.toLowerCase() === 'uefi' ? 'uefi' : 'bios';
  } else if (uefiMessage.toLowerCase().includes('uefi')) {
    bootType = 'uefi';
  } else if (uefiMessage.toLowerCase().includes('bios')) {
    bootType = 'bios';
  }

  // Format A: infer from partition table types
  if (bootType === 'unknown') {
    const types = Object.values(partTableTypes);
    if (types.length > 0) {
      const hasGpt = types.some((t) => t === 'gpt');
      const hasMsdos = types.some((t) => t === 'msdos');
      const hasEsp = diskLayouts.some((d) =>
        d.partitions.some(
          (p) => p.flags.includes('esp') || p.flags.includes('boot, esp') || p.name.toLowerCase().includes('efi'),
        ),
      );
      if (hasGpt && hasEsp) bootType = 'uefi';
      else if (hasGpt) bootType = 'uefi';
      else if (hasMsdos) bootType = 'bios';
    }
  }

  return {
    allPartitions, diskLayouts, partTableTypes, byPathEntries,
    targetFirmware, targetBootDevice, uefiMessage, guestInfo, gcaps, mountpoints, disks,
    bootType,
  };
}

// ── Component ───────────────────────────────────────────────────────────────

export function BiosUefiView({ content }: { content: string[] }) {
  const p = useMemo(() => parseBiosUefi(content), [content]);

  const hasFormatA = p.allPartitions.length > 0 || p.diskLayouts.length > 0 || p.byPathEntries.length > 0;
  const hasFormatB = p.targetFirmware !== '' || p.uefiMessage !== '' || Object.keys(p.guestInfo).length > 0 || Object.keys(p.gcaps).length > 0 || p.mountpoints.length > 0;

  if (!hasFormatA && !hasFormatB) return null;

  return (
    <div className="space-y-4">
      {/* Boot type badge */}
      <div className="flex items-center gap-2 flex-wrap">
        <SectionHeader title="Boot Type" />
        <span
          className={`px-2 py-0.5 rounded text-[11px] font-semibold ${
            p.bootType === 'bios'
              ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800'
              : p.bootType === 'uefi'
                ? 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-800'
                : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-gray-300 border border-slate-200 dark:border-slate-700'
          }`}
        >
          {p.bootType === 'bios' ? 'BIOS (MBR)' : p.bootType === 'uefi' ? 'UEFI (GPT)' : 'Unknown'}
        </span>
        {p.uefiMessage && (
          <span className="text-[11px] text-slate-500 dark:text-gray-400 italic">
            {p.uefiMessage}
          </span>
        )}
      </div>

      {/* Target info */}
      {(p.targetFirmware || p.targetBootDevice) && (
        <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
          <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 px-3 py-2 text-[11px]">
            {p.targetFirmware && (
              <>
                <span className="text-slate-400 dark:text-gray-500">Target Firmware</span>
                <span className="text-slate-700 dark:text-gray-200 font-semibold">{p.targetFirmware}</span>
              </>
            )}
            {p.targetBootDevice && (
              <>
                <span className="text-slate-400 dark:text-gray-500">Target Boot Device</span>
                <span className="text-slate-700 dark:text-gray-200">{p.targetBootDevice}</span>
              </>
            )}
          </div>
        </div>
      )}

      {/* Guest capabilities */}
      {Object.keys(p.gcaps).length > 0 && (
        <div>
          <SectionHeader title="Guest Capabilities" />
          <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
            <div className="flex flex-wrap gap-1.5 px-3 py-2">
              {Object.entries(p.gcaps).map(([key, val]) => {
                const label = key.replace('gcaps_', '');
                const isBool = val === 'true' || val === 'false';
                return (
                  <span
                    key={key}
                    className={`px-1.5 py-0.5 rounded text-[10px] font-mono border ${
                      isBool && val === 'true'
                        ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800'
                        : isBool && val === 'false'
                          ? 'bg-slate-50 dark:bg-slate-800 text-slate-400 dark:text-gray-500 border-slate-200 dark:border-slate-700'
                          : 'bg-indigo-50 dark:bg-indigo-900/20 text-indigo-700 dark:text-indigo-300 border-indigo-200 dark:border-indigo-800'
                    }`}
                    title={`${key} = ${val}`}
                  >
                    {label}{!isBool && `=${val}`}
                  </span>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Mountpoint stats */}
      {p.mountpoints.length > 0 && (
        <div>
          <SectionHeader title="Mountpoint Stats" />
          <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700">
                  <th className="px-3 py-1.5 text-left text-slate-500 dark:text-gray-400 font-semibold">Device</th>
                  <th className="px-3 py-1.5 text-left text-slate-500 dark:text-gray-400 font-semibold">Mount</th>
                  <th className="px-3 py-1.5 text-left text-slate-500 dark:text-gray-400 font-semibold">FS</th>
                  <th className="px-3 py-1.5 text-right text-slate-500 dark:text-gray-400 font-semibold">Size</th>
                  <th className="px-3 py-1.5 text-right text-slate-500 dark:text-gray-400 font-semibold">Used</th>
                  <th className="px-3 py-1.5 text-right text-slate-500 dark:text-gray-400 font-semibold">Avail</th>
                  <th className="px-3 py-1.5 text-right text-slate-500 dark:text-gray-400 font-semibold">Use%</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {p.mountpoints.map((mp, i) => (
                  <tr key={i} className="hover:bg-slate-50 dark:hover:bg-slate-800/30">
                    <td className="px-3 py-1.5 font-mono text-slate-700 dark:text-gray-200">{mp.device}</td>
                    <td className="px-3 py-1.5 font-mono text-slate-600 dark:text-gray-300">{mp.mountpoint}</td>
                    <td className="px-3 py-1.5">
                      <span className="px-1 py-0 rounded bg-emerald-50 dark:bg-emerald-900/20 text-[9px] text-emerald-600 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">
                        {mp.fsType}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-right text-slate-600 dark:text-gray-300">{formatBytes(mp.sizeBytes)}</td>
                    <td className="px-3 py-1.5 text-right text-slate-600 dark:text-gray-300">{formatBytes(mp.usedBytes)}</td>
                    <td className="px-3 py-1.5 text-right text-slate-600 dark:text-gray-300">{formatBytes(mp.availBytes)}</td>
                    <td className="px-3 py-1.5 text-right font-semibold text-slate-700 dark:text-gray-200">{mp.usePercent}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Format A: Discovered partitions */}
      {p.allPartitions.length > 0 && (
        <div>
          <SectionHeader title="Discovered Partitions" />
          <div className="flex flex-wrap gap-1.5">
            {p.allPartitions.map((part) => (
              <span
                key={part}
                className="px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-[11px] font-mono text-slate-700 dark:text-gray-200 border border-slate-200 dark:border-slate-700"
              >
                {part}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Format A: Disk layouts */}
      {p.diskLayouts.length > 0 && (
        <div>
          <SectionHeader title="Disk Layouts" />
          <div className="space-y-2">
            {p.diskLayouts.map((disk) => (
              <DiskCard key={disk.device} disk={disk} partTableType={p.partTableTypes[disk.device]} />
            ))}
          </div>
        </div>
      )}

      {/* Format A: Device path mapping */}
      {p.byPathEntries.length > 0 && (
        <div>
          <SectionHeader title="Device Paths (/dev/disk/by-path)" />
          <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {p.byPathEntries.map((e, i) => (
                <div key={i} className="px-3 py-1.5 text-[11px] font-mono text-slate-600 dark:text-gray-300">
                  {e}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function DiskCard({ disk, partTableType }: { disk: DiskLayout; partTableType?: string }) {
  const tableType = partTableType || disk.tableType;

  return (
    <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
      <div className="px-3 py-2 bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700 flex items-center gap-2 flex-wrap">
        <span className="font-mono text-[11px] font-semibold text-slate-700 dark:text-gray-200">{disk.device}</span>
        <span className="text-[10px] text-slate-500 dark:text-gray-400">{formatBytes(disk.sizeBytes)}</span>
        {tableType && (
          <span
            className={`px-1.5 py-0.5 rounded text-[9px] font-semibold border ${
              tableType === 'gpt'
                ? 'bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-300 border-purple-200 dark:border-purple-800'
                : 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-300 border-blue-200 dark:border-blue-800'
            }`}
          >
            {tableType.toUpperCase()}
          </span>
        )}
        {disk.transport && (
          <span className="px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-[9px] text-slate-600 dark:text-gray-300">
            {disk.transport}
          </span>
        )}
        {disk.model && (
          <span className="text-[10px] text-slate-400 dark:text-gray-500">{disk.model}</span>
        )}
      </div>
      {disk.partitions.length > 0 && (
        <div className="divide-y divide-slate-100 dark:divide-slate-800">
          {disk.partitions.map((pt) => (
            <div key={pt.number} className="px-3 py-1.5 flex items-center gap-2 text-[11px]">
              <span className="font-mono text-slate-600 dark:text-gray-300 w-6 text-right">{pt.number}</span>
              <span className="text-slate-500 dark:text-gray-400 w-16 text-right">{formatBytes(pt.sizeBytes)}</span>
              {pt.fsType && (
                <span className="px-1.5 py-0 rounded bg-emerald-50 dark:bg-emerald-900/20 text-[9px] text-emerald-600 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">
                  {pt.fsType}
                </span>
              )}
              {pt.flags && (
                <span className="px-1.5 py-0 rounded bg-amber-50 dark:bg-amber-900/20 text-[9px] text-amber-600 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
                  {pt.flags}
                </span>
              )}
              {pt.name && <span className="text-[10px] text-slate-400 dark:text-gray-500">{pt.name}</span>}
              <span className="ml-auto text-[9px] font-mono text-slate-400 dark:text-gray-500">
                {formatBytes(pt.startBytes)} – {formatBytes(pt.endBytes)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
