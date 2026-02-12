/**
 * Structured visualization for the "Inspecting the source" pipeline stage.
 *
 * Parses the raw inter-stage log lines on-the-fly to extract:
 *  1. Disk layout (from parted output)
 *  2. Filesystem discovery (list_filesystems: adding)
 *  3. Partition inspection steps (check_for_filesystem_on / check_filesystem)
 *  4. OS detection summary (i_root, i_type, etc.)
 */
import { useMemo, useState } from 'react';
import type {
  DiskInfo,
  FilesystemEntry,
  InspectionStep,
  OsInfo,
  FsckResult,
  FstrimResult,
  BootDeviceInfo,
} from '../../parser/v2v';
import { parseInspectContent } from '../../parser/v2v';
import { formatBytes } from '../../utils/format';
import { SectionHeader } from './shared';

// ── Component ───────────────────────────────────────────────────────────────

interface InspectSourceViewProps {
  content: string[];
}

export function InspectSourceView({ content }: InspectSourceViewProps) {
  const parsed = useMemo(() => parseInspectContent(content), [content]);

  const hasData =
    parsed.disks.length > 0 ||
    parsed.filesystems.length > 0 ||
    parsed.inspectionSteps.length > 0 ||
    Object.keys(parsed.osInfo).length > 0 ||
    parsed.fsckResults.length > 0 ||
    parsed.bootDevice !== null ||
    parsed.fstrimResults.length > 0;

  if (!hasData) return null;

  return (
    <div className="space-y-4">
      {/* Disk Layout */}
      {parsed.disks.length > 0 && (
        <DiskLayoutSection disks={parsed.disks} filesystems={parsed.filesystems} lvmVolumes={parsed.lvmVolumes} />
      )}

      {/* Inspection Steps */}
      {parsed.inspectionSteps.length > 0 && (
        <InspectionStepsSection steps={parsed.inspectionSteps} />
      )}

      {/* Boot Device */}
      {parsed.bootDevice && (
        <BootDeviceSection info={parsed.bootDevice} />
      )}

      {/* Filesystem Check Results */}
      {parsed.fsckResults.length > 0 && (
        <FsckResultsSection results={parsed.fsckResults} />
      )}

      {/* Filesystem Trim Results */}
      {parsed.fstrimResults.length > 0 && (
        <FstrimSection results={parsed.fstrimResults} />
      )}

      {/* OS Detection Summary */}
      {Object.keys(parsed.osInfo).length > 0 && (
        <OsInfoSection osInfo={parsed.osInfo} />
      )}
    </div>
  );
}

// ── Sub-sections ────────────────────────────────────────────────────────────

// ── Well-known GPT partition type GUIDs ─────────────────────────────────────

const GPT_TYPE_LABELS: Record<string, string> = {
  'C12A7328-F81F-11D2-BA4B-00A0C93EC93B': 'EFI System',
  'EBD0A0A2-B9E5-4433-87C0-68B6B72699C7': 'Basic Data',
  '0FC63DAF-8483-4772-8E79-3D69D8477DE4': 'Linux Filesystem',
  'E6D6D379-F507-44C2-A23C-238F2A3DF928': 'Linux LVM',
  '0657FD6D-A4AB-43C4-84E5-0933C84B4F4F': 'Linux Swap',
  '21686148-6449-6E6F-744E-656564454649': 'BIOS Boot',
  'DE94BBA4-06D1-4D40-A16A-BFD50179D6AC': 'Windows Recovery',
  'E3C9E316-0B5C-4DB8-817D-F92DF00215AE': 'Microsoft Reserved',
};

function gptTypeLabel(guid: string | undefined): string | null {
  if (!guid) return null;
  return GPT_TYPE_LABELS[guid.toUpperCase()] || null;
}

// ── Disk Layout ─────────────────────────────────────────────────────────────

function DiskLayoutSection({
  disks,
  filesystems,
  lvmVolumes,
}: {
  disks: DiskInfo[];
  filesystems: FilesystemEntry[];
  lvmVolumes: string[];
}) {
  // Map filesystem device -> fsType from list_filesystems for display
  const fsMap = new Map(filesystems.map((f) => [f.device, f.fsType]));

  // Normalize parted FS names to Linux kernel names for consistency
  const normalizeFs = (fs: string): string => {
    const map: Record<string, string> = {
      fat32: 'vfat',
      fat16: 'vfat',
      fat12: 'vfat',
      'linux-swap(v1)': 'swap',
      'linux-swap': 'swap',
      hfs: 'hfsplus',
    };
    return map[fs.toLowerCase()] || fs;
  };

  return (
    <div>
      <SectionHeader title="Disk Layout" count={disks.length} />
      <div className="space-y-3">
        {disks.map((disk) => (
          <div
            key={disk.device}
            className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden"
          >
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
            </div>

            {/* Partitions table */}
            {disk.partitions.length > 0 && (
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="text-left text-slate-400 dark:text-gray-500 border-b border-slate-100 dark:border-slate-800">
                    <th className="px-3 py-1 font-medium">#</th>
                    <th className="px-3 py-1 font-medium">Size</th>
                    <th className="px-3 py-1 font-medium">FS Type</th>
                    <th className="px-3 py-1 font-medium">Name / Flags</th>
                  </tr>
                </thead>
                <tbody>
                  {disk.partitions.map((part) => {
                    const partDevice = `${disk.device}${part.number}`;
                    const detectedFs = fsMap.get(partDevice) || normalizeFs(part.fsType);
                    const gptLabel = gptTypeLabel(part.gptTypeGuid);
                    const nameFlags = [part.name, part.flags].filter(Boolean).join(', ');
                    return (
                      <tr
                        key={part.number}
                        className="border-b border-slate-50 dark:border-slate-800/50 hover:bg-slate-50 dark:hover:bg-slate-800/30"
                      >
                        <td className="px-3 py-1.5 font-mono text-slate-600 dark:text-gray-300">
                          {partDevice}
                        </td>
                        <td className="px-3 py-1.5 text-slate-600 dark:text-gray-300">
                          {formatBytes(part.sizeBytes)}
                        </td>
                        <td className="px-3 py-1.5">
                          <span className="px-1.5 py-0.5 rounded bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 font-mono text-[10px]">
                            {detectedFs || '—'}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 text-slate-500 dark:text-gray-400">
                          {gptLabel ? (
                            <span className="px-1.5 py-0.5 rounded bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 text-[10px]">
                              {gptLabel}
                            </span>
                          ) : (
                            nameFlags || '—'
                          )}
                          {gptLabel && nameFlags && (
                            <span className="ml-1.5 text-[10px] text-slate-400 dark:text-gray-500">
                              {nameFlags}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        ))}

        {/* LVM Volumes */}
        {lvmVolumes.length > 0 && (
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-[10px] text-slate-400 dark:text-gray-500 font-semibold uppercase">
              LVM:
            </span>
            {lvmVolumes.map((lv) => (
              <span
                key={lv}
                className="px-2 py-0.5 rounded bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300 text-[10px] font-mono"
              >
                {lv}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Inspection Steps ────────────────────────────────────────────────────────

const RESULT_COLORS: Record<string, string> = {
  root: 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300 border-green-200 dark:border-green-800',
  boot: 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800',
  swap: 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800',
  default: 'bg-slate-50 dark:bg-slate-800/50 text-slate-600 dark:text-gray-400 border-slate-200 dark:border-slate-700',
};

function getResultColor(result: string): string {
  const lower = result.toLowerCase();
  if (lower.includes('root')) return RESULT_COLORS.root;
  if (lower.includes('boot') || lower.includes('grub')) return RESULT_COLORS.boot;
  if (lower.includes('swap')) return RESULT_COLORS.swap;
  return RESULT_COLORS.default;
}

function InspectionStepsSection({ steps }: { steps: InspectionStep[] }) {
  return (
    <div>
      <SectionHeader title="Partition Inspection" count={steps.length} />
      <div className="space-y-1.5">
        {steps.map((step, idx) => (
          <div
            key={idx}
            className="flex items-baseline gap-2 text-[11px]"
          >
            {/* Step indicator */}
            <div className="w-1.5 h-1.5 rounded-full bg-slate-300 dark:bg-slate-600 flex-shrink-0 translate-y-[5px]" />

            {/* Device */}
            <span className="font-mono font-medium text-slate-700 dark:text-gray-200 min-w-[110px]">
              {step.device}
            </span>

            {/* FS type */}
            <span className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-gray-400 font-mono text-[10px] min-w-[40px] text-center">
              {step.fsType}
            </span>

            {/* Result */}
            {step.result ? (
              <span
                className={`px-2 py-0.5 rounded border text-[10px] font-medium ${getResultColor(step.result)}`}
              >
                {step.result}
              </span>
            ) : (
              <span className="text-[10px] text-slate-400 dark:text-gray-500 italic">
                checked
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Boot Device ─────────────────────────────────────────────────────────────

function BootDeviceSection({ info }: { info: BootDeviceInfo }) {
  return (
    <div>
      <SectionHeader title="Boot Device" />
      <div className="border border-slate-200 dark:border-slate-700 rounded-lg p-3 space-y-2">
        {info.device && (
          <div className="flex items-baseline gap-2 text-[11px]">
            <span className="text-slate-400 dark:text-gray-500">Boot filesystem on:</span>
            <span className="font-mono font-medium text-slate-700 dark:text-gray-200">{info.device}</span>
          </div>
        )}
        {info.grubSignature !== null && (
          <div className="flex items-center gap-2 text-[11px]">
            <span className="text-slate-400 dark:text-gray-500">GRUB signature:</span>
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
              info.grubSignature
                ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300'
                : 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-gray-400'
            }`}>
              {info.grubSignature ? 'found' : 'not found'}
            </span>
          </div>
        )}
        {info.mountPoints.length > 0 && (
          <div className="space-y-0.5">
            <span className="text-[10px] text-slate-400 dark:text-gray-500 font-semibold uppercase">Mount Points</span>
            {info.mountPoints.map((mp, idx) => (
              <div key={idx} className="flex items-baseline gap-2 text-[11px] pl-2">
                <span className="font-mono text-slate-600 dark:text-gray-300 min-w-[130px]">{mp.device}</span>
                <span className="text-slate-400 dark:text-gray-500">{'\u2192'}</span>
                <span className="font-mono text-slate-700 dark:text-gray-200">{mp.mountpoint}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Filesystem Trim ─────────────────────────────────────────────────────────

function FstrimSection({ results }: { results: FstrimResult[] }) {
  const totalBytes = results.reduce((sum, r) => sum + r.trimmedBytes, 0);

  return (
    <div>
      <SectionHeader title="Filesystem Trim (unused space)" count={results.length} />
      <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-left text-slate-400 dark:text-gray-500 border-b border-slate-100 dark:border-slate-800">
              <th className="px-3 py-1 font-medium">Device</th>
              <th className="px-3 py-1 font-medium text-right">Trimmed</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r, idx) => (
              <tr key={idx} className="border-b border-slate-50 dark:border-slate-800/50">
                <td className="px-3 py-1.5 font-mono text-slate-700 dark:text-gray-200">
                  {r.device}
                </td>
                <td className="px-3 py-1.5 text-right text-slate-600 dark:text-gray-300">
                  {r.trimmedHuman}
                </td>
              </tr>
            ))}
            {results.length > 1 && (
              <tr className="border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/30">
                <td className="px-3 py-1.5 font-medium text-slate-500 dark:text-gray-400">Total</td>
                <td className="px-3 py-1.5 text-right font-medium text-slate-700 dark:text-gray-200">
                  {formatBytes(totalBytes)}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Filesystem Check Results ────────────────────────────────────────────────

function FsckResultsSection({ results }: { results: FsckResult[] }) {
  return (
    <div>
      <SectionHeader title="Filesystem Integrity Checks" count={results.length} />
      <div className="space-y-2">
        {results.map((r, idx) => (
          <FsckResultCard key={idx} result={r} />
        ))}
      </div>
    </div>
  );
}

/** Individual fsck result card with collapsible log output (hidden by default). */
function FsckResultCard({ result: r }: { result: FsckResult }) {
  const [expanded, setExpanded] = useState(false);
  const passed = r.exitCode === 0;
  const hasDetails = r.passes.length > 0 || !!r.summary;

  return (
    <div
      className={`border rounded-lg overflow-hidden ${
        passed
          ? 'border-green-200 dark:border-green-800'
          : 'border-red-200 dark:border-red-800'
      }`}
    >
      <div
        onClick={hasDetails ? () => setExpanded(!expanded) : undefined}
        className={`flex items-center gap-2 px-3 py-2 bg-slate-50 dark:bg-slate-800/50 ${
          hasDetails ? 'cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800/70' : ''
        } transition-colors`}
      >
        {hasDetails && (
          <span className="text-[9px] text-slate-400 dark:text-gray-500">{expanded ? '▼' : '▶'}</span>
        )}
        <span className="text-sm">{passed ? '\u2705' : '\u274C'}</span>
        <span className="font-mono text-[11px] font-medium text-slate-700 dark:text-gray-200">
          {r.device}
        </span>
        {r.exitCode >= 0 && (
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
            passed
              ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300'
              : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300'
          }`}>
            exit {r.exitCode}
          </span>
        )}
      </div>
      {expanded && hasDetails && (
        <div className="px-3 py-1.5 text-[10px] font-mono text-slate-500 dark:text-gray-400 space-y-0.5">
          {r.passes.map((p, pidx) => (
            <div key={pidx}>{p}</div>
          ))}
          {r.summary && (
            <div className="text-slate-600 dark:text-gray-300 mt-1">{r.summary}</div>
          )}
        </div>
      )}
    </div>
  );
}

// ── OS Detection Summary ────────────────────────────────────────────────────

const OS_INFO_LABELS: Record<string, string> = {
  root: 'Root Device',
  type: 'OS Type',
  distro: 'Distribution',
  osinfo: 'OS Info ID',
  arch: 'Architecture',
  major_version: 'Major Version',
  minor_version: 'Minor Version',
  package_format: 'Package Format',
  package_management: 'Package Manager',
  product_name: 'Product Name',
  product_variant: 'Variant',
  hostname: 'Hostname',
  windows_systemroot: 'System Root',
  windows_software_hive: 'Software Hive',
  windows_system_hive: 'System Hive',
  windows_current_control_set: 'Control Set',
  drive_mappings: 'Drive Mappings',
};

function OsInfoSection({ osInfo }: { osInfo: OsInfo }) {
  // Determine icon
  const osType = osInfo.type?.toLowerCase() || '';
  const icon = osType === 'windows' ? '\uD83E\uDE9F' : osType === 'linux' ? '\uD83D\uDC27' : '\uD83D\uDDA5';

  return (
    <div>
      <SectionHeader title="Detected Operating System" />
      <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
        {/* Header with product name */}
        {osInfo.product_name && (
          <div className="flex items-center gap-2 px-3 py-2 bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700">
            <span className="text-sm">{icon}</span>
            <span className="text-xs font-semibold text-slate-700 dark:text-gray-200">
              {osInfo.product_name}
            </span>
            {osInfo.product_variant && osInfo.product_variant !== 'unknown' && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-gray-300">
                {osInfo.product_variant}
              </span>
            )}
          </div>
        )}

        {/* Key-value grid */}
        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 px-3 py-2 text-[11px]">
          {Object.entries(osInfo).map(([key, value]) => {
            // Skip product_name/variant (shown in header) and empty/unknown values
            if (key === 'product_name' || key === 'product_variant') return null;
            if (!value || value === 'unknown' || value === '') return null;

            const label = OS_INFO_LABELS[key] || key.replace(/_/g, ' ');
            return (
              <div key={key} className="contents">
                <span className="text-slate-400 dark:text-gray-500 capitalize whitespace-nowrap">
                  {label}
                </span>
                <span className="font-mono text-slate-700 dark:text-gray-200 break-all">
                  {value}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
