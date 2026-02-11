/**
 * Structured visualization for the "Checking filesystem integrity before/after conversion" stage.
 *
 * Parses:
 *  - list_filesystems discovery (partitions, LVM, blkid results)
 *  - parted disk layout
 *  - sfdisk partition type GUIDs
 *  - xfs_repair / e2fsck integrity check phases and results
 */
import { useMemo, useState } from 'react';
import { SectionHeader } from './shared';
import { formatBytes } from '../../utils/format';

// ── Types ───────────────────────────────────────────────────────────────────

interface DiscoveredFs {
  device: string;
  fsType: string;
}

interface DiskLayout {
  device: string;
  sizeBytes: number;
  transport: string;
  sectorSize: number;
  tableType: string;
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
  typeGuid?: string;
}

interface LvmVolume {
  vgName: string;
  lvName: string;
}

interface FsCheckResult {
  device: string;
  tool: string; // xfs_repair, e2fsck, etc.
  exitCode: number;
  phases: string[];
  duration?: string;
}

interface ParsedFsCheck {
  filesystems: DiscoveredFs[];
  disks: DiskLayout[];
  lvmVolumes: LvmVolume[];
  byPathDevices: string[];
  fsChecks: FsCheckResult[];
}

// ── Well-known GPT type GUIDs ───────────────────────────────────────────────

const GPT_TYPE_NAMES: Record<string, string> = {
  'C12A7328-F81F-11D2-BA4B-00A0C93EC93B': 'EFI System',
  '0FC63DAF-8483-4772-8E79-3D69D8477DE4': 'Linux filesystem',
  'E6D6D379-F507-44C2-A23C-238F2A3DF928': 'Linux LVM',
  'EBD0A0A2-B9E5-4433-87C0-68B6B72699C7': 'Microsoft basic data',
  '21686148-6449-6E6F-744E-656564454649': 'BIOS boot',
  'DE94BBA4-06D1-4D40-A16A-BFD50179D6AC': 'Windows RE',
  'E3C9E316-0B5C-4DB8-817D-F92DF00215AE': 'Microsoft reserved',
  '5808C8AA-7E8F-42E0-85D2-E1E90434CFB3': 'Linux LUKS',
  '0657FD6D-A4AB-43C4-84E5-0933C84B4F4F': 'Linux swap',
};

function gptTypeName(guid: string): string {
  return GPT_TYPE_NAMES[guid.toUpperCase()] || guid;
}

// ── Parsing ─────────────────────────────────────────────────────────────────

function parseFsCheck(lines: string[]): ParsedFsCheck {
  const filesystems: DiscoveredFs[] = [];
  const disks: DiskLayout[] = [];
  const lvmVolumes: LvmVolume[] = [];
  const byPathDevices: string[] = [];
  const fsChecks: FsCheckResult[] = [];
  const seenLvm = new Set<string>();
  const seenByPath = new Set<string>();
  const seenFs = new Set<string>();

  // Partition type GUID map (device+partNum -> GUID)
  const partGuids = new Map<string, string>();

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // ── list_filesystems: adding "/dev/xxx", "type" ────────────────────
    const addFsMatch = line.match(/list_filesystems:\s*adding\s+"([^"]+)",\s*"([^"]+)"/);
    if (addFsMatch) {
      const key = `${addFsMatch[1]}:${addFsMatch[2]}`;
      if (!seenFs.has(key)) {
        seenFs.add(key);
        filesystems.push({ device: addFsMatch[1], fsType: addFsMatch[2] });
      }
      i++;
      continue;
    }

    // ── LVM volumes from lvm lvs output ────────────────────────────────
    const lvmMatch = line.match(/^\s*(\S+)\/(\S+)\s*$/);
    if (lvmMatch) {
      const key = `${lvmMatch[1]}/${lvmMatch[2]}`;
      if (!seenLvm.has(key)) {
        seenLvm.add(key);
        lvmVolumes.push({ vgName: lvmMatch[1], lvName: lvmMatch[2] });
      }
      i++;
      continue;
    }

    // ── /dev/disk/by-path entries ──────────────────────────────────────
    const byPathMatch = line.match(/^(pci-\S+)$/);
    if (byPathMatch) {
      if (!seenByPath.has(byPathMatch[1])) {
        seenByPath.add(byPathMatch[1]);
        byPathDevices.push(byPathMatch[1]);
      }
      i++;
      continue;
    }

    // ── sfdisk partition type GUID ─────────────────────────────────────
    const sfdiskCmdMatch = line.match(/command:\s*sfdisk\s+'--part-type'\s+'([^']+)'\s+'(\d+)'/);
    if (sfdiskCmdMatch) {
      const dev = sfdiskCmdMatch[1];
      const partNum = sfdiskCmdMatch[2];
      // Look ahead for the GUID in sfdisk stdout
      for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
        const guidMatch = lines[j].match(/^([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})\s*$/);
        if (guidMatch) {
          partGuids.set(`${dev}:${partNum}`, guidMatch[1]);
          break;
        }
      }
      i++;
      continue;
    }

    // ── Parted output (BYT; header) ────────────────────────────────────
    if (line.trim() === 'BYT;') {
      // Next line is disk info, then partitions
      const diskLine = i + 1 < lines.length ? lines[i + 1] : '';
      const dp = diskLine.split(':');
      if (dp.length >= 7) {
        const device = dp[0];
        // Skip if we already parsed this disk
        if (!disks.find((d) => d.device === device)) {
          const disk: DiskLayout = {
            device,
            sizeBytes: parseInt(dp[1]) || 0,
            transport: dp[2] || '',
            sectorSize: parseInt(dp[3]) || 512,
            tableType: dp[5] || '',
            model: dp[6]?.replace(/;$/, '') || '',
            partitions: [],
          };
          // Parse partition lines
          for (let j = i + 2; j < lines.length; j++) {
            const pl = lines[j];
            if (!pl.match(/^\d+:/)) break;
            const pp = pl.split(':');
            if (pp.length >= 7) {
              const partNum = parseInt(pp[0]);
              const partKey = `${device}:${partNum}`;
              disk.partitions.push({
                number: partNum,
                startBytes: parseInt(pp[1]) || 0,
                endBytes: parseInt(pp[2]) || 0,
                sizeBytes: parseInt(pp[3]) || 0,
                fsType: pp[4] || '',
                name: pp[5] || '',
                flags: pp[6]?.replace(/;$/, '') || '',
                typeGuid: partGuids.get(partKey),
              });
            }
          }
          disks.push(disk);
        }
      }
      i++;
      continue;
    }

    // ── xfs_repair / e2fsck phases ─────────────────────────────────────
    const xfsRepairCmd = line.match(/commandrvf:\s*xfs_repair\s+.*\s+(\/dev\/\S+)/);
    if (xfsRepairCmd) {
      const device = xfsRepairCmd[1];
      const phases: string[] = [];
      let exitCode = 0;
      let duration: string | undefined;
      for (let j = i + 1; j < lines.length; j++) {
        const pl = lines[j];
        // Phase line
        const phaseMatch = pl.match(/^(Phase \d+ - .*)$/);
        if (phaseMatch) {
          phases.push(phaseMatch[1]);
          continue;
        }
        // Sub-step line
        if (pl.match(/^\s+- /)) {
          phases.push(pl.trimEnd());
          continue;
        }
        // Result line (e.g. "No modify flag set, skipping...")
        if (pl.match(/^No modify flag set/)) {
          phases.push(pl.trim());
          continue;
        }
        // libguestfs trace return
        const retMatch = pl.match(/libguestfs: trace: v2v: xfs_repair = (\d+)/);
        if (retMatch) {
          exitCode = parseInt(retMatch[1]);
          break;
        }
        // guestfsd timing
        const durMatch = pl.match(/guestfsd: => xfs_repair.*took ([\d.]+) secs/);
        if (durMatch) {
          duration = `${durMatch[1]}s`;
          // Keep looking for the trace return
          continue;
        }
        // Other non-continuation lines — may be interleaved noise, skip
        if (pl.match(/^(nbdkit:|commandrvf:|guestfsd: <=|guestfsd: =>|libguestfs: trace:)/)) {
          // Check if it's the end
          const retMatch2 = pl.match(/libguestfs: trace: v2v: xfs_repair = (\d+)/);
          if (retMatch2) {
            exitCode = parseInt(retMatch2[1]);
            break;
          }
          continue;
        }
        // If it's a completely unrelated line, stop
        if (pl.match(/^(command:|list_filesystems:)/)) break;
      }
      // Avoid duplicate checks for the same device
      if (!fsChecks.find((c) => c.device === device)) {
        fsChecks.push({ device, tool: 'xfs_repair', exitCode, phases, duration });
      }
      i++;
      continue;
    }

    // e2fsck support
    const e2fsckCmd = line.match(/commandrvf:\s*e2fsck\s+.*\s+(\/dev\/\S+)/);
    if (e2fsckCmd) {
      const device = e2fsckCmd[1];
      const phases: string[] = [];
      let exitCode = 0;
      let duration: string | undefined;
      for (let j = i + 1; j < lines.length; j++) {
        const pl = lines[j];
        const passMatch = pl.match(/^(Pass \d+:.*)$/);
        if (passMatch) {
          phases.push(passMatch[1]);
          continue;
        }
        if (pl.match(/^\s/) && !pl.match(/^(command:|list_|guestfsd:|libguestfs:)/)) {
          phases.push(pl.trimEnd());
          continue;
        }
        const retMatch = pl.match(/libguestfs: trace: v2v: e2fsck = (\d+)/);
        if (retMatch) {
          exitCode = parseInt(retMatch[1]);
          break;
        }
        const durMatch = pl.match(/guestfsd: => e2fsck.*took ([\d.]+) secs/);
        if (durMatch) {
          duration = `${durMatch[1]}s`;
          continue;
        }
        if (pl.match(/^(command:|list_filesystems:)/)) break;
      }
      if (!fsChecks.find((c) => c.device === device)) {
        fsChecks.push({ device, tool: 'e2fsck', exitCode, phases, duration });
      }
      i++;
      continue;
    }

    i++;
  }

  // Second pass: attach GUIDs to disk partitions that didn't get them inline
  for (const disk of disks) {
    for (const part of disk.partitions) {
      if (!part.typeGuid) {
        const key = `${disk.device}:${part.number}`;
        if (partGuids.has(key)) {
          part.typeGuid = partGuids.get(key);
        }
      }
    }
  }

  return { filesystems, disks, lvmVolumes, byPathDevices, fsChecks };
}

// ── Status helpers ──────────────────────────────────────────────────────────

function checkStatusBadge(exitCode: number) {
  if (exitCode === 0) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300 border border-green-200 dark:border-green-700/50">
        Passed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-700/50">
      Failed (exit {exitCode})
    </span>
  );
}

// ── FS type badge color ─────────────────────────────────────────────────────

function fsTypeBadgeClass(fsType: string): string {
  switch (fsType) {
    case 'swap':
      return 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300';
    case 'LVM2_member':
      return 'bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300';
    case 'vfat':
      return 'bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-300';
    default:
      return 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300';
  }
}

// ── Summary bar helpers ──────────────────────────────────────────────────────

function summaryBadge(count: number, label: string, colorClass: string) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${colorClass}`}>
      {count} {label}
    </span>
  );
}

// ── Component ───────────────────────────────────────────────────────────────

export function FilesystemCheckView({ content }: { content: string[] }) {
  const parsed = useMemo(() => parseFsCheck(content), [content]);

  const isEmpty =
    parsed.filesystems.length === 0 &&
    parsed.disks.length === 0 &&
    parsed.fsChecks.length === 0 &&
    parsed.lvmVolumes.length === 0;

  if (isEmpty) return null;

  // Count how many checks passed / failed
  const passedChecks = parsed.fsChecks.filter((c) => c.exitCode === 0).length;
  const failedChecks = parsed.fsChecks.filter((c) => c.exitCode !== 0).length;

  return (
    <div className="space-y-4 text-sm">
      {/* ── Summary bar ───────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        {parsed.filesystems.length > 0 &&
          summaryBadge(parsed.filesystems.length, parsed.filesystems.length === 1 ? 'filesystem' : 'filesystems', 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300')}
        {parsed.disks.length > 0 &&
          summaryBadge(parsed.disks.length, parsed.disks.length === 1 ? 'disk' : 'disks', 'bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-gray-300')}
        {parsed.lvmVolumes.length > 0 &&
          summaryBadge(parsed.lvmVolumes.length, 'LVM', 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300')}
        {passedChecks > 0 &&
          summaryBadge(passedChecks, 'passed', 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300')}
        {failedChecks > 0 &&
          summaryBadge(failedChecks, 'failed', 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300')}
      </div>

      {/* ── Discovered Filesystems ────────────────────────────────────── */}
      {parsed.filesystems.length > 0 && (
        <section>
          <SectionHeader title="Discovered Filesystems" />
          <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50 dark:bg-slate-800/80 text-slate-500 dark:text-gray-400">
                  <th className="text-left px-3 py-1.5 font-medium">Device</th>
                  <th className="text-left px-3 py-1.5 font-medium">Type</th>
                </tr>
              </thead>
              <tbody>
                {parsed.filesystems.map((fs, idx) => (
                  <tr key={idx} className="border-t border-slate-100 dark:border-slate-700/40">
                    <td className="px-3 py-1.5 font-mono text-blue-600 dark:text-blue-300">{fs.device}</td>
                    <td className="px-3 py-1.5">
                      <span className={`px-1.5 py-0.5 rounded text-xs ${fsTypeBadgeClass(fs.fsType)}`}>
                        {fs.fsType}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ── Disk Layout ───────────────────────────────────────────────── */}
      {parsed.disks.length > 0 && (
        <section>
          <SectionHeader title="Disk Layout" />
          <div className="space-y-3">
            {parsed.disks.map((disk, idx) => (
              <div
                key={idx}
                className="rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden"
              >
                <div className="flex items-center gap-3 px-3 py-2 bg-slate-50 dark:bg-slate-800/80 border-b border-slate-200 dark:border-slate-700/40">
                  <span className="font-mono text-blue-600 dark:text-blue-300 text-xs">{disk.device}</span>
                  <span className="text-slate-500 dark:text-gray-400 text-xs">{formatBytes(disk.sizeBytes)}</span>
                  <span className="px-1.5 py-0.5 rounded text-xs bg-slate-200 dark:bg-slate-700/60 text-slate-600 dark:text-gray-300">
                    {disk.tableType.toUpperCase()}
                  </span>
                  <span className="text-slate-400 dark:text-gray-500 text-xs">{disk.model}</span>
                </div>
                {disk.partitions.length > 0 && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-slate-500 dark:text-gray-500 bg-slate-50/50 dark:bg-slate-800/40">
                          <th className="text-left px-3 py-1 font-medium">#</th>
                          <th className="text-left px-3 py-1 font-medium">Size</th>
                          <th className="text-left px-3 py-1 font-medium">FS</th>
                          <th className="text-left px-3 py-1 font-medium">Name</th>
                          <th className="text-left px-3 py-1 font-medium">Flags</th>
                          <th className="text-left px-3 py-1 font-medium">Type</th>
                        </tr>
                      </thead>
                      <tbody>
                        {disk.partitions.map((p) => (
                          <tr key={p.number} className="border-t border-slate-100 dark:border-slate-700/30">
                            <td className="px-3 py-1 font-mono text-slate-700 dark:text-gray-300">{p.number}</td>
                            <td className="px-3 py-1 text-slate-700 dark:text-gray-300">{formatBytes(p.sizeBytes)}</td>
                            <td className="px-3 py-1 text-slate-500 dark:text-gray-400">{p.fsType || '-'}</td>
                            <td className="px-3 py-1 text-slate-500 dark:text-gray-400">{p.name || '-'}</td>
                            <td className="px-3 py-1">
                              {p.flags ? (
                                <span className="text-yellow-600 dark:text-yellow-300/80 text-xs">{p.flags}</span>
                              ) : (
                                <span className="text-slate-300 dark:text-gray-600">-</span>
                              )}
                            </td>
                            <td className="px-3 py-1 text-slate-400 dark:text-gray-500 text-xs">
                              {p.typeGuid ? gptTypeName(p.typeGuid) : '-'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── LVM Volumes ───────────────────────────────────────────────── */}
      {parsed.lvmVolumes.length > 0 && (
        <section>
          <SectionHeader title="LVM Volumes" />
          <div className="flex flex-wrap gap-2">
            {parsed.lvmVolumes.map((lv, idx) => (
              <span
                key={idx}
                className="inline-flex items-center gap-1 px-2 py-1 rounded bg-purple-50 dark:bg-purple-900/30 border border-purple-200 dark:border-purple-700/40 text-xs"
              >
                <span className="text-purple-600 dark:text-purple-400 font-mono">{lv.vgName}</span>
                <span className="text-slate-400 dark:text-gray-500">/</span>
                <span className="text-purple-700 dark:text-purple-300 font-mono">{lv.lvName}</span>
              </span>
            ))}
          </div>
        </section>
      )}

      {/* ── Filesystem Integrity Checks ───────────────────────────────── */}
      {parsed.fsChecks.length > 0 && (
        <section>
          <SectionHeader title="Integrity Checks" />
          <div className="space-y-3">
            {parsed.fsChecks.map((check, idx) => (
              <FsCheckCard key={idx} check={check} />
            ))}
          </div>
        </section>
      )}

      {/* ── By-Path Devices ───────────────────────────────────────────── */}
      {parsed.byPathDevices.length > 0 && (
        <section>
          <SectionHeader title="Device Paths" />
          <div className="rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2 bg-white dark:bg-transparent">
            <div className="font-mono text-xs text-slate-500 dark:text-gray-400 space-y-0.5">
              {parsed.byPathDevices.map((d, idx) => (
                <div key={idx}>{d}</div>
              ))}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

/** Individual integrity check card with collapsible log output (hidden by default). */
function FsCheckCard({ check }: { check: FsCheckResult }) {
  const [expanded, setExpanded] = useState(false);
  const hasPhases = check.phases.length > 0;

  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden">
      <div
        onClick={hasPhases ? () => setExpanded(!expanded) : undefined}
        className={`flex items-center justify-between px-3 py-2 bg-slate-50 dark:bg-slate-800/80 ${
          hasPhases ? 'cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800/90' : ''
        } transition-colors ${expanded ? 'border-b border-slate-200 dark:border-slate-700/40' : ''}`}
      >
        <div className="flex items-center gap-2">
          {hasPhases && (
            <span className="text-[9px] text-slate-400 dark:text-gray-500">{expanded ? '▼' : '▶'}</span>
          )}
          <span className="font-mono text-blue-600 dark:text-blue-300 text-xs">{check.device}</span>
          <span className="text-slate-400 dark:text-gray-500 text-xs">via</span>
          <span className="font-mono text-slate-600 dark:text-gray-300 text-xs">{check.tool}</span>
        </div>
        <div className="flex items-center gap-2">
          {check.duration && (
            <span className="text-slate-400 dark:text-gray-500 text-xs">{check.duration}</span>
          )}
          {checkStatusBadge(check.exitCode)}
        </div>
      </div>
      {expanded && hasPhases && (
        <div className="px-3 py-2 bg-white dark:bg-transparent">
          <div className="font-mono text-xs space-y-0.5">
            {check.phases.map((phase, pi) => {
              const isPhaseHeader = phase.match(/^Phase \d+/);
              const isResult = phase.match(/^No modify flag set/);
              return (
                <div
                  key={pi}
                  className={
                    isPhaseHeader
                      ? 'text-slate-700 dark:text-gray-300 font-medium mt-1'
                      : isResult
                        ? 'text-green-600 dark:text-green-400 mt-1'
                        : 'text-slate-500 dark:text-gray-500'
                  }
                >
                  {phase}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
