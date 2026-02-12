/**
 * Structured visualization for the Windows conversion pipeline stage.
 *
 * Parses OS detection, guest capabilities, registry hive sessions, and warnings.
 * Reuses V2VFileTree for the file operations tree view (mounted disks, file
 * checks, VirtIO driver copies, firstboot scripts, etc.).
 */
import { useMemo } from 'react';
import type { ParsedWindowsConversion } from '../../parser/v2v';
import { parseWindowsConversion, isWindowsConversionContent } from '../../parser/v2v';
import type { V2VToolRun } from '../../types/v2v';
import { SectionHeader, Badge } from './shared';
import { V2VFileTree } from './V2VFileTree';
import { HiveGroupCard, groupHiveAccesses } from './RegistryAppsPanel';

/** Re-export for consumers that import from this component file. */
export { isWindowsConversionContent };

// ── Component ───────────────────────────────────────────────────────────────

export function WindowsConversionView({
  content,
  toolRun,
  stageStartLine,
  stageEndLine,
}: {
  content: string[];
  toolRun?: V2VToolRun;
  stageStartLine?: number;
  stageEndLine?: number;
}) {
  const parsed = useMemo(() => parseWindowsConversion(content), [content]);

  // Filter registry hive accesses to this stage's line range when available
  const stageHiveAccesses = useMemo(() => {
    if (!toolRun || stageStartLine === undefined || stageEndLine === undefined) return toolRun?.registryHiveAccesses ?? [];
    return toolRun.registryHiveAccesses.filter((a) => a.lineNumber >= stageStartLine && a.lineNumber < stageEndLine);
  }, [toolRun, stageStartLine, stageEndLine]);

  // Build rich registry hive groups from filtered data
  const hiveGroups = useMemo(
    () => groupHiveAccesses(stageHiveAccesses),
    [stageHiveAccesses],
  );

  // Filter API calls and file copies to this stage's line range when available
  const stageApiCalls = useMemo(() => {
    if (!toolRun || stageStartLine === undefined || stageEndLine === undefined) return toolRun?.apiCalls ?? [];
    return toolRun.apiCalls.filter((c) => c.lineNumber >= stageStartLine && c.lineNumber < stageEndLine);
  }, [toolRun, stageStartLine, stageEndLine]);

  const stageFileCopies = useMemo(() => {
    if (!toolRun || stageStartLine === undefined || stageEndLine === undefined) return toolRun?.virtioWin.fileCopies ?? [];
    return toolRun.virtioWin.fileCopies.filter((fc) => fc.lineNumber >= stageStartLine && fc.lineNumber < stageEndLine);
  }, [toolRun, stageStartLine, stageEndLine]);

  const hasData =
    parsed.conversionModule ||
    parsed.osInfo.productName ||
    parsed.guestCaps ||
    hiveGroups.length > 0;

  if (!hasData) return null;

  // Determine if V2VFileTree has data to show (file checks, augeas ops, or file copies)
  const FILE_TREE_APIS = ['is_file', 'is_dir', 'is_symlink', 'is_blockdev', 'is_chardev', 'exists', 'stat', 'lstat',
    'aug_get', 'aug_set', 'aug_rm', 'aug_match', 'aug_clear', 'aug_ls'];
  const hasFileTreeData = toolRun && (
    stageApiCalls.some((c) => FILE_TREE_APIS.includes(c.name)) || stageFileCopies.length > 0
  );

  return (
    <div className="space-y-4">
      {/* Conversion Summary */}
      {(parsed.conversionModule || parsed.osInfo.productName || parsed.guestCaps) && (
        <SummarySection parsed={parsed} />
      )}

      {/* Registry Hive Operations — rich view with key paths and values */}
      {hiveGroups.length > 0 && (
        <div>
          <SectionHeader title="Registry Hive Operations" />
          <div className="text-xs text-slate-500 dark:text-gray-400 mb-2">
            {hiveGroups.length} registry hive{hiveGroups.length !== 1 ? 's' : ''} accessed
            ({stageHiveAccesses.length} key path{stageHiveAccesses.length !== 1 ? 's' : ''} traversed)
          </div>
          <div className="space-y-2">
            {hiveGroups.map((group) => (
              <HiveGroupCard key={group.hivePath} group={group} />
            ))}
          </div>
        </div>
      )}

      {/* Warnings */}
      {parsed.warnings.length > 0 && (
        <WarningsSection warnings={parsed.warnings} />
      )}

      {/* File Operations — V2VFileTree with mounted disks (filtered to this stage) */}
      {hasFileTreeData && toolRun && (
        <div>
          <SectionHeader title="File Operations" />
          <V2VFileTree
            apiCalls={stageApiCalls}
            fileCopies={stageFileCopies}
            driveMappings={toolRun.guestInfo?.driveMappings}
            fstab={toolRun.guestInfo?.fstab}
            virtioWinIsoPath={toolRun.virtioWin?.isoPath}
            defaultExpandGuest
          />
        </div>
      )}
    </div>
  );
}

// ── Sub-sections ────────────────────────────────────────────────────────────

// ── Summary ─────────────────────────────────────────────────────────────────

function SummarySection({ parsed }: { parsed: ParsedWindowsConversion }) {
  const { osInfo, guestCaps } = parsed;
  return (
    <div>
      <SectionHeader title="Conversion Summary" />
      <div className="border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 space-y-2">
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
          {parsed.conversionModule && (
            <div>
              <span className="text-slate-500 dark:text-gray-400">Module:</span>{' '}
              <span className="font-medium text-slate-700 dark:text-gray-200">{parsed.conversionModule}</span>
            </div>
          )}
          {osInfo.productName && (
            <div>
              <span className="text-slate-500 dark:text-gray-400">OS:</span>{' '}
              <span className="font-medium text-slate-700 dark:text-gray-200">{osInfo.productName}</span>
            </div>
          )}
          {osInfo.productVariant && (
            <div>
              <span className="text-slate-500 dark:text-gray-400">Variant:</span>{' '}
              <span className="font-medium text-slate-700 dark:text-gray-200">{osInfo.productVariant}</span>
            </div>
          )}
          {osInfo.osinfo && (
            <div>
              <span className="text-slate-500 dark:text-gray-400">OSInfo ID:</span>{' '}
              <span className="font-mono text-[10px] text-slate-700 dark:text-gray-200">{osInfo.osinfo}</span>
            </div>
          )}
          {osInfo.arch && (
            <div>
              <span className="text-slate-500 dark:text-gray-400">Arch:</span>{' '}
              <span className="font-mono text-[10px] text-slate-700 dark:text-gray-200">{osInfo.arch}</span>
            </div>
          )}
          {guestCaps?.machine && (
            <div>
              <span className="text-slate-500 dark:text-gray-400">Machine:</span>{' '}
              <span className="font-mono text-[10px] text-slate-700 dark:text-gray-200">{guestCaps.machine}</span>
            </div>
          )}
        </div>

        {/* Windows-specific info */}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
          {osInfo.controlSet && (
            <div>
              <span className="text-slate-500 dark:text-gray-400">Control Set:</span>{' '}
              <span className="font-mono text-[10px] text-slate-700 dark:text-gray-200">{osInfo.controlSet}</span>
            </div>
          )}
          {osInfo.systemRoot && (
            <div>
              <span className="text-slate-500 dark:text-gray-400">System Root:</span>{' '}
              <span className="font-mono text-[10px] text-slate-700 dark:text-gray-200">{osInfo.systemRoot}</span>
            </div>
          )}
          {parsed.virtioIsoPath && (
            <div>
              <span className="text-slate-500 dark:text-gray-400">VirtIO ISO:</span>{' '}
              <span className="font-mono text-[10px] text-slate-700 dark:text-gray-200">{parsed.virtioIsoPath}</span>
              {parsed.virtioIsoVersion && (
                <span className="text-slate-400 dark:text-gray-500 ml-1">v{parsed.virtioIsoVersion}</span>
              )}
            </div>
          )}
        </div>

        {/* Capabilities badges */}
        <div className="flex flex-wrap gap-1">
          {parsed.hasVirtioDrivers && <Badge color="green">VirtIO drivers installed</Badge>}
          {guestCaps && (
            <>
              <Badge color="blue">Block: {guestCaps.blockBus || 'n/a'}</Badge>
              <Badge color="blue">Net: {guestCaps.netBus || 'n/a'}</Badge>
              {guestCaps.virtio10 && <Badge color="green">VirtIO 1.0</Badge>}
              {guestCaps.virtioRng && <Badge color="green">RNG</Badge>}
              {guestCaps.virtioBalloon && <Badge color="green">Balloon</Badge>}
              {guestCaps.pvpanic && <Badge color="green">pvpanic</Badge>}
              {guestCaps.virtioSocket ? <Badge color="green">vsock</Badge> : <Badge color="slate">vsock off</Badge>}
              {guestCaps.rtcUtc ? <Badge color="slate">RTC UTC</Badge> : <Badge color="slate">RTC local</Badge>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Warnings ────────────────────────────────────────────────────────────────

function WarningsSection({ warnings }: { warnings: string[] }) {
  return (
    <div>
      <SectionHeader title="Warnings" />
      <div className="border border-amber-200 dark:border-amber-800 rounded-lg px-3 py-2 bg-amber-50 dark:bg-amber-900/10 space-y-1">
        {warnings.map((w, i) => (
          <div key={i} className="text-[10px] text-amber-700 dark:text-amber-300">
            {w}
          </div>
        ))}
      </div>
    </div>
  );
}
