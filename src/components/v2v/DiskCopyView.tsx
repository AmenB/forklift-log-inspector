/**
 * Structured visualization for the "Copying disk N/M" pipeline stage.
 *
 * Parses: input/output disk info from nbdinfo, VDDK connection details
 * (VMDK path, transport mode, NFC endpoint, buffer sizes, block params),
 * nbdkit filter stack, copy worker thread count, VDDK warnings,
 * and MBR/GPT partition info from the nbdinfo content field.
 */
import { useMemo, useState } from 'react';
import type { NbdInfoDisk, VddkConnection, MbrPartition } from '../../parser/v2v';
import {
  parseDiskCopyContent,
  isDiskCopyStage,
  CAPABILITY_LABELS,
} from '../../parser/v2v';
import { formatBytes } from '../../utils/format';
import { SectionHeader } from './shared';

// ── Component ───────────────────────────────────────────────────────────────

export function DiskCopyView({ content, stageName }: { content: string[]; stageName: string }) {
  const parsed = useMemo(() => parseDiskCopyContent(content), [content]);

  const hasData =
    parsed.inputDisk !== null ||
    parsed.outputDisk !== null ||
    parsed.vddkConnection !== null ||
    parsed.filterStack.length > 0 ||
    parsed.workerCount > 0;

  if (!hasData) return null;

  // Extract disk number from stage name
  const diskMatch = stageName.match(/(\d+)\/(\d+)/);
  const diskLabel = diskMatch ? `Disk ${diskMatch[1]} of ${diskMatch[2]}` : '';

  return (
    <div className="space-y-4 text-sm">
      {/* Summary bar */}
      <div className="flex flex-wrap items-center gap-2">
        {diskLabel && (
          <SummaryBadge color="slate">{diskLabel}</SummaryBadge>
        )}
        {parsed.inputDisk && (
          <SummaryBadge color="blue">{parsed.inputDisk.exportSizeHuman || formatBytes(parsed.inputDisk.exportSize)}</SummaryBadge>
        )}
        {parsed.vddkConnection?.transportMode && (
          <SummaryBadge color="green">{parsed.vddkConnection.transportMode}</SummaryBadge>
        )}
        {parsed.workerCount > 0 && (
          <SummaryBadge color="purple">{parsed.workerCount} workers</SummaryBadge>
        )}
        {parsed.partitions.length > 0 && (
          <SummaryBadge color="slate">{parsed.partitions.length} partition{parsed.partitions.length !== 1 ? 's' : ''}</SummaryBadge>
        )}
        {parsed.warnings.length > 0 && (
          <SummaryBadge color="amber">{parsed.warnings.length} warning{parsed.warnings.length !== 1 ? 's' : ''}</SummaryBadge>
        )}
      </div>

      {/* Input / Output Disk Info */}
      {(parsed.inputDisk || parsed.outputDisk) && (
        <DiskInfoSection inputDisk={parsed.inputDisk} outputDisk={parsed.outputDisk} />
      )}

      {/* Capabilities Comparison */}
      {parsed.inputDisk && parsed.outputDisk && (
        <CapabilitiesSection inputDisk={parsed.inputDisk} outputDisk={parsed.outputDisk} />
      )}

      {/* VDDK Connection */}
      {parsed.vddkConnection && (
        <VddkConnectionSection conn={parsed.vddkConnection} />
      )}

      {/* Filter Stack */}
      {parsed.filterStack.length > 0 && (
        <FilterStackSection filters={parsed.filterStack} />
      )}

      {/* MBR Partition Table */}
      {parsed.partitions.length > 0 && (
        <PartitionSection partitions={parsed.partitions} />
      )}

      {/* VDDK Warnings */}
      {parsed.warnings.length > 0 && (
        <WarningsSection warnings={parsed.warnings} />
      )}
    </div>
  );
}

/** Re-export for consumers that import from this component file. */
export { isDiskCopyStage };

// ── Shared UI ───────────────────────────────────────────────────────────────

function SummaryBadge({ children, color }: { children: React.ReactNode; color: 'green' | 'blue' | 'slate' | 'purple' | 'amber' }) {
  const colors = {
    green: 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300',
    blue: 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300',
    slate: 'bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-gray-300',
    purple: 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300',
    amber: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300',
  };
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${colors[color]}`}>
      {children}
    </span>
  );
}

function KeyValue({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-[10px] text-slate-400 dark:text-gray-500 min-w-[90px]">{label}</span>
      <span className={`text-[11px] text-slate-700 dark:text-gray-200 ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
}

// ── Input/Output Disk Info ──────────────────────────────────────────────────

function DiskInfoSection({ inputDisk, outputDisk }: { inputDisk: NbdInfoDisk | null; outputDisk: NbdInfoDisk | null }) {
  return (
    <div>
      <SectionHeader title="Disk Info" />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {inputDisk && <DiskInfoCard disk={inputDisk} direction="Input" />}
        {outputDisk && <DiskInfoCard disk={outputDisk} direction="Output" />}
      </div>
    </div>
  );
}

function DiskInfoCard({ disk, direction }: { disk: NbdInfoDisk; direction: string }) {
  return (
    <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
      <div className="flex items-baseline gap-2 px-3 py-2 bg-slate-50 dark:bg-slate-800/50">
        <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
          direction === 'Input'
            ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
            : 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300'
        }`}>
          {direction}
        </span>
        <span className="text-[11px] font-medium text-slate-700 dark:text-gray-200">
          {disk.exportSizeHuman || formatBytes(disk.exportSize)}
        </span>
      </div>
      <div className="px-3 py-2 space-y-1">
        {disk.protocol && <KeyValue label="Protocol" value={disk.protocol} />}
        {disk.uri && <KeyValue label="URI" value={disk.uri} mono />}
        {disk.blockSizes.preferred && (
          <KeyValue
            label="Block sizes"
            value={`min=${disk.blockSizes.minimum}, pref=${disk.blockSizes.preferred}, max=${disk.blockSizes.maximum}`}
            mono
          />
        )}
      </div>
    </div>
  );
}

// ── Capabilities Comparison ─────────────────────────────────────────────────

function CapabilitiesSection({ inputDisk, outputDisk }: { inputDisk: NbdInfoDisk; outputDisk: NbdInfoDisk }) {
  // Collect all capability keys
  const allKeys = new Set<string>();
  for (const k of Object.keys(inputDisk.capabilities)) allKeys.add(k);
  for (const k of Object.keys(outputDisk.capabilities)) allKeys.add(k);

  // Only include known boolean capabilities
  const capKeys = Array.from(allKeys).filter((k) => k in CAPABILITY_LABELS);

  // Check if there are any differences
  const hasDiffs = capKeys.some(
    (k) => (inputDisk.capabilities[k] || '') !== (outputDisk.capabilities[k] || ''),
  );

  // Hook must be called unconditionally (before any early return)
  const [showAll, setShowAll] = useState(!hasDiffs);

  const visibleKeys = showAll ? capKeys : capKeys.filter(
    (k) => (inputDisk.capabilities[k] || '') !== (outputDisk.capabilities[k] || ''),
  );

  if (capKeys.length === 0) return null;

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <SectionHeader title="Capabilities Comparison" />
        {hasDiffs && (
          <button
            onClick={() => setShowAll(!showAll)}
            className="text-[10px] px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-gray-400 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
          >
            {showAll ? 'Show differences only' : 'Show all'}
          </button>
        )}
      </div>
      <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-left text-slate-400 dark:text-gray-500 border-b border-slate-100 dark:border-slate-800">
              <th className="px-3 py-1.5 font-medium">Capability</th>
              <th className="px-3 py-1.5 font-medium text-center">Input</th>
              <th className="px-3 py-1.5 font-medium text-center">Output</th>
            </tr>
          </thead>
          <tbody>
            {visibleKeys.map((key) => {
              const inVal = inputDisk.capabilities[key] || '—';
              const outVal = outputDisk.capabilities[key] || '—';
              const isDiff = inVal !== outVal;
              return (
                <tr
                  key={key}
                  className={`border-b border-slate-50 dark:border-slate-800/50 ${isDiff ? 'bg-amber-50/50 dark:bg-amber-900/10' : ''}`}
                >
                  <td className="px-3 py-1.5 text-slate-600 dark:text-gray-300">
                    {CAPABILITY_LABELS[key] || key}
                  </td>
                  <td className="px-3 py-1.5 text-center">
                    <BoolBadge value={inVal} highlight={isDiff} />
                  </td>
                  <td className="px-3 py-1.5 text-center">
                    <BoolBadge value={outVal} highlight={isDiff} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BoolBadge({ value, highlight }: { value: string; highlight?: boolean }) {
  if (value === 'true') {
    return (
      <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
        highlight
          ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300'
          : 'text-green-600 dark:text-green-400'
      }`}>
        yes
      </span>
    );
  }
  if (value === 'false') {
    return (
      <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
        highlight
          ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300'
          : 'text-slate-400 dark:text-gray-500'
      }`}>
        no
      </span>
    );
  }
  return <span className="text-slate-500 dark:text-gray-400 text-[10px]">{value}</span>;
}

// ── VDDK Connection ─────────────────────────────────────────────────────────

function VddkConnectionSection({ conn }: { conn: VddkConnection }) {
  return (
    <div>
      <SectionHeader title="VDDK Connection" />
      <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
        {/* Header with transport badge */}
        <div className="flex items-center gap-2 px-3 py-2 bg-slate-50 dark:bg-slate-800/50 flex-wrap">
          {conn.transportMode && (
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
              conn.transportMode === 'nbdssl'
                ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300'
                : conn.transportMode === 'file'
                  ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300'
                  : 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300'
            }`}>
              {conn.transportMode}
            </span>
          )}
          {conn.backingSize > 0 && (
            <span className="text-[10px] text-slate-500 dark:text-gray-400">
              {formatBytes(conn.backingSize)}
            </span>
          )}
        </div>

        {/* Details */}
        <div className="px-3 py-2 space-y-1">
          {conn.vmdkPath && <KeyValue label="VMDK" value={conn.vmdkPath} mono />}
          {conn.nfcEndpoint && <KeyValue label="NFC Endpoint" value={conn.nfcEndpoint} mono />}
          {conn.blockParams && (
            <KeyValue
              label="Block Params"
              value={`minblock=${conn.blockParams.minblock}, maxdata=${formatBytes(conn.blockParams.maxdata)}, maxlen=${formatBytes(conn.blockParams.maxlen)}`}
              mono
            />
          )}
          {conn.socketBuffers && (
            <KeyValue
              label="Socket Buffers"
              value={`client: snd=${formatBytes(conn.socketBuffers.clientSnd)} rcv=${formatBytes(conn.socketBuffers.clientRcv)} | server: snd=${formatBytes(conn.socketBuffers.serverSnd)} rcv=${formatBytes(conn.socketBuffers.serverRcv)}`}
              mono
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Filter Stack ────────────────────────────────────────────────────────────

function FilterStackSection({ filters }: { filters: string[] }) {
  return (
    <div>
      <SectionHeader title="nbdkit Filter Stack" count={filters.length} />
      <div className="flex items-center flex-wrap gap-1">
        {filters.map((f, idx) => (
          <span key={idx} className="contents">
            <span className={`px-2 py-1 rounded text-[10px] font-mono font-medium ${
              f === 'vddk'
                ? 'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800'
                : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-gray-300 border border-slate-200 dark:border-slate-700'
            }`}>
              {f}
            </span>
            {idx < filters.length - 1 && (
              <span className="text-slate-300 dark:text-gray-600 text-[10px] mx-0.5">&rarr;</span>
            )}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Partition Table ─────────────────────────────────────────────────────────

function PartitionSection({ partitions }: { partitions: MbrPartition[] }) {
  return (
    <div>
      <SectionHeader title="MBR Partition Table" count={partitions.length} />
      <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-left text-slate-400 dark:text-gray-500 border-b border-slate-100 dark:border-slate-800">
              <th className="px-3 py-1 font-medium">#</th>
              <th className="px-3 py-1 font-medium">Type ID</th>
              <th className="px-3 py-1 font-medium">Active</th>
              <th className="px-3 py-1 font-medium">Start Sector</th>
              <th className="px-3 py-1 font-medium">Sectors</th>
              <th className="px-3 py-1 font-medium text-right">Size</th>
            </tr>
          </thead>
          <tbody>
            {partitions.map((p, idx) => (
              <tr key={idx} className="border-b border-slate-50 dark:border-slate-800/50">
                <td className="px-3 py-1.5 text-slate-500 dark:text-gray-400">{idx + 1}</td>
                <td className="px-3 py-1.5 font-mono text-slate-600 dark:text-gray-300">
                  <PartitionTypeBadge id={p.id} />
                </td>
                <td className="px-3 py-1.5">
                  {p.active ? (
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300">
                      active
                    </span>
                  ) : (
                    <span className="text-slate-300 dark:text-gray-600">&mdash;</span>
                  )}
                </td>
                <td className="px-3 py-1.5 font-mono text-slate-500 dark:text-gray-400">
                  {p.startSector.toLocaleString()}
                </td>
                <td className="px-3 py-1.5 font-mono text-slate-500 dark:text-gray-400">
                  {p.sectorCount.toLocaleString()}
                </td>
                <td className="px-3 py-1.5 text-right text-slate-600 dark:text-gray-300">
                  {formatBytes(p.sizeBytes)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const MBR_TYPE_NAMES: Record<string, string> = {
  '0x7': 'NTFS / exFAT / HPFS',
  '0x83': 'Linux',
  '0x82': 'Linux Swap',
  '0x8e': 'Linux LVM',
  '0xfd': 'Linux RAID',
  '0xc': 'FAT32 (LBA)',
  '0xb': 'FAT32 (CHS)',
  '0xe': 'FAT16 (LBA)',
  '0x6': 'FAT16',
  '0x1': 'FAT12',
  '0xef': 'EFI System',
  '0xee': 'GPT Protective MBR',
  '0x0': 'Empty',
};

function PartitionTypeBadge({ id }: { id: string }) {
  const name = MBR_TYPE_NAMES[id.toLowerCase()] || MBR_TYPE_NAMES[id] || '';
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-gray-300 text-[10px]">
        {id}
      </span>
      {name && (
        <span className="text-[10px] text-slate-400 dark:text-gray-500">{name}</span>
      )}
    </span>
  );
}

// ── Warnings ────────────────────────────────────────────────────────────────

function WarningsSection({ warnings }: { warnings: string[] }) {
  return (
    <div>
      <SectionHeader title="VDDK Warnings" count={warnings.length} />
      <div className="space-y-1.5">
        {warnings.map((w, idx) => (
          <div
            key={idx}
            className="flex items-start gap-2 px-3 py-2 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/10 text-xs text-amber-800 dark:text-amber-200"
          >
            <span className="flex-shrink-0 mt-0.5">&#x26A0;</span>
            <span>{w}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
