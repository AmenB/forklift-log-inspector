import { useMemo } from 'react';
import type { V2VToolRun } from '../../types/v2v';
import { useV2VStore } from '../../store/useV2VStore';
import { useDevMode } from '../../store/useStore';
import { V2VPipelineView } from './V2VPipelineView';
import { V2VCommandsPanel } from './V2VCommandsPanel';
import { V2VFileTree } from './V2VFileTree';
import { GuestInfoPanel } from './GuestInfoPanel';
import { V2VErrorsPanel } from './V2VErrorsPanel';
import { V2VRawLogViewer } from './V2VRawLogViewer';
import { VersionsBar } from './VersionsBar';
import { PerformancePanel } from './PerformancePanel';
const TOOL_LABELS: Record<string, string> = {
  'virt-v2v': 'virt-v2v',
  'virt-v2v-in-place': 'virt-v2v-in-place',
  'virt-v2v-inspector': 'virt-v2v-inspector',
  'virt-v2v-customize': 'virt-customize',
};

export function V2VDashboard() {
  const v2vData = useV2VStore((s) => s.v2vData);
  const selectedToolRun = useV2VStore((s) => s.selectedToolRun);
  const { setSelectedToolRun, clearV2VData } = useV2VStore();
  const devMode = useDevMode();

  const currentRun = useMemo(() => {
    if (!v2vData || v2vData.toolRuns.length === 0) return null;
    return v2vData.toolRuns[selectedToolRun] ?? v2vData.toolRuns[0];
  }, [v2vData, selectedToolRun]);

  // Share guest info & source VM across all runs — pick the richest one
  const sharedGuestInfo = useMemo(() => {
    if (!v2vData) return { guestInfo: null, sourceVM: null };
    // Find the run with the most complete guest info
    const bestGuest = v2vData.toolRuns.reduce<typeof v2vData.toolRuns[0]['guestInfo']>((best, run) => {
      if (!run.guestInfo) return best;
      if (!best) return run.guestInfo;
      // Prefer the one with more fields populated
      const score = (g: typeof best) =>
        (g.productName ? 1 : 0) + (g.distro ? 1 : 0) + (g.arch ? 1 : 0) +
        (g.hostname ? 1 : 0) + (g.majorVersion ? 1 : 0) + g.driveMappings.length + g.fstab.length;
      return score(run.guestInfo) > score(best) ? run.guestInfo : best;
    }, null);
    const bestVM = v2vData.toolRuns.reduce<typeof v2vData.toolRuns[0]['sourceVM']>((best, run) => {
      if (!run.sourceVM) return best;
      if (!best) return run.sourceVM;
      const score = (v: typeof best) =>
        (v.name ? 1 : 0) + (v.vcpus !== undefined ? 1 : 0) +
        (v.memoryKB !== undefined ? 1 : 0) + (v.firmware ? 1 : 0);
      return score(run.sourceVM) > score(best) ? run.sourceVM : best;
    }, null);
    return { guestInfo: bestGuest, sourceVM: bestVM };
  }, [v2vData]);

  const stats = useMemo(() => {
    if (!currentRun)
      return { lines: 0, stages: 0, apiCalls: 0, guestCmds: 0, errors: 0, warnings: 0 };
    const guestCmds = currentRun.apiCalls.reduce((s, c) => s + c.guestCommands.length, 0);
    return {
      lines: currentRun.rawLines.length,
      stages: currentRun.stages.length,
      apiCalls: currentRun.apiCalls.length,
      guestCmds,
      errors: currentRun.errors.filter((e) => e.level === 'error').length,
      warnings: currentRun.errors.filter((e) => e.level === 'warning').length,
    };
  }, [currentRun]);

  if (!v2vData || !currentRun) return null;

  return (
    <div className="max-w-7xl mx-auto px-6 py-4 space-y-4">
      {/* Exit status banner */}
      <ExitStatusBanner toolRun={currentRun} />

      {/* Header bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-gray-100">
            V2V Log Analysis
          </h2>
          <span className="text-xs text-slate-500 dark:text-gray-400">
            {v2vData.totalLines.toLocaleString()} total lines
          </span>
          {v2vData.fileName && (
            <span className="text-xs font-mono text-slate-400 dark:text-gray-500 truncate max-w-[300px]" title={v2vData.fileName}>
              {v2vData.fileName}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={clearV2VData}
          className="text-sm text-slate-500 dark:text-gray-400 hover:text-red-500 dark:hover:text-red-400 transition-colors"
          aria-label="Clear V2V log data"
        >
          Clear
        </button>
      </div>

      {/* Tool run tabs */}
      {v2vData.toolRuns.length > 1 && (
        <div className="flex gap-1 bg-slate-100 dark:bg-slate-800 rounded-lg p-1">
          {v2vData.toolRuns.map((run, idx) => (
            <button
              key={idx}
              onClick={() => setSelectedToolRun(idx)}
              className={`
                px-4 py-2 rounded-md text-sm font-medium transition-colors
                ${idx === selectedToolRun
                  ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-gray-100 shadow-sm'
                  : 'text-slate-600 dark:text-gray-400 hover:text-slate-900 dark:hover:text-gray-200'
                }
              `}
            >
              {run.exitStatus === 'success' && <span className="mr-1.5 text-green-600 dark:text-green-400">●</span>}
              {run.exitStatus === 'error' && <span className="mr-1.5 text-red-600 dark:text-red-400">●</span>}
              {run.exitStatus === 'in_progress' && <span className="mr-1.5 text-blue-600 dark:text-blue-400">●</span>}
              {TOOL_LABELS[run.tool] || run.tool}
              <span className="ml-2 text-xs opacity-60">
                ({run.rawLines.length.toLocaleString()} lines)
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Stats bar — always show error/warning counts on failure; full stats in dev mode */}
      {(devMode || (currentRun.exitStatus === 'error' && (stats.errors > 0 || stats.warnings > 0))) && (
        <div className="flex flex-wrap gap-3">
          {devMode && <StatBadge label="Lines" value={stats.lines} />}
          {devMode && <StatBadge label="Stages" value={stats.stages} color="blue" />}
          {devMode && <StatBadge label="API Calls" value={stats.apiCalls} color="cyan" />}
          {devMode && stats.guestCmds > 0 && <StatBadge label="Guest Cmds" value={stats.guestCmds} color="cyan" />}
          {currentRun.exitStatus === 'error' && stats.errors > 0 && <StatBadge label="Errors" value={stats.errors} color="red" />}
          {currentRun.exitStatus === 'error' && stats.warnings > 0 && <StatBadge label="Warnings" value={stats.warnings} color="orange" />}
        </div>
      )}

      {/* Command line */}
      {currentRun.commandLine && (
        <div className="px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700">
          <div className="flex items-center gap-2 text-[11px]">
            <span className="text-slate-400 dark:text-gray-500 flex-shrink-0">$</span>
            <code className="font-mono text-slate-700 dark:text-gray-300 break-all">
              {TOOL_LABELS[currentRun.tool] || currentRun.tool} {currentRun.commandLine}
            </code>
          </div>
        </div>
      )}

      {/* Component versions */}
      {Object.keys(currentRun.versions).length > 0 && (
        <VersionsBar versions={currentRun.versions} />
      )}

      {/* Pipeline stages */}
      <CollapsibleSection id="pipeline" title="Pipeline Stages" defaultOpen>
        <V2VPipelineView toolRun={currentRun} />
      </CollapsibleSection>

      {/* Guest & Source VM Information (shared across runs) + Installed Applications */}
      {(sharedGuestInfo.guestInfo || sharedGuestInfo.sourceVM || currentRun.installedApps.length > 0) && (
        <CollapsibleSection
          id="guestinfo"
          title={`Guest Information${currentRun.installedApps.length > 0 ? ` · ${currentRun.installedApps.length} apps` : ''}`}
          defaultOpen
        >
          <GuestInfoPanel
            info={sharedGuestInfo.guestInfo}
            sourceVM={sharedGuestInfo.sourceVM}
            apps={currentRun.installedApps}
          />
        </CollapsibleSection>
      )}

      {/* Errors & Warnings — always present when there are entries, expanded only on failure */}
      {currentRun.errors.length > 0 && (
        <CollapsibleSection
          id="errors"
          title={`Errors & Warnings (${currentRun.errors.length})`}
          defaultOpen={currentRun.exitStatus === 'error'}
        >
          <V2VErrorsPanel errors={currentRun.errors} />
        </CollapsibleSection>
      )}

      {/* API Calls & Guest Commands (dev mode) */}
      {devMode && currentRun.apiCalls.length > 0 && (
        <CollapsibleSection
          id="commands"
          title={`Libguestfs API Calls (${currentRun.apiCalls.length})`}
          devPreview
        >
          <V2VCommandsPanel apiCalls={currentRun.apiCalls} />
        </CollapsibleSection>
      )}

      {/* File Operations — checks + copies in a unified tree (dev mode) */}
      {devMode && (currentRun.apiCalls.some((c) =>
        ['is_file', 'is_dir', 'is_symlink', 'is_blockdev', 'is_chardev', 'exists', 'stat', 'lstat'].includes(c.name),
      ) || currentRun.virtioWin.fileCopies.length > 0) && (
        <CollapsibleSection id="filetree" title="File Operations" devPreview>
          <V2VFileTree
            apiCalls={currentRun.apiCalls}
            fileCopies={currentRun.virtioWin.fileCopies}
            driveMappings={sharedGuestInfo.guestInfo?.driveMappings}
            fstab={sharedGuestInfo.guestInfo?.fstab}
            virtioWinIsoPath={currentRun.virtioWin?.isoPath}
          />
        </CollapsibleSection>
      )}

      {/* Performance (stage timing + slowest API calls) — dev mode only (Ctrl+Shift+D) */}
      {devMode && (currentRun.stages.length >= 2 || currentRun.apiCalls.some((c) => c.durationSecs !== undefined)) && (
        <CollapsibleSection id="performance" title="Performance" devPreview>
          <PerformancePanel stages={currentRun.stages} apiCalls={currentRun.apiCalls} />
        </CollapsibleSection>
      )}

      {/* Raw log viewer */}
      <CollapsibleSection id="rawlog" title="Raw Log">
        <V2VRawLogViewer toolRun={currentRun} />
      </CollapsibleSection>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

/** Banner showing the conversion exit status (success / in-progress / error). */
function ExitStatusBanner({ toolRun }: { toolRun: V2VToolRun }) {
  if (toolRun.exitStatus === 'unknown') return null;

  // Extract the main fatal error message from the tool itself (e.g. "virt-v2v: error: ...")
  const fatalError = toolRun.exitStatus === 'error'
    ? toolRun.errors.find(
        (e) =>
          e.level === 'error' &&
          /^virt-v2v/.test(e.source) &&
          !/warning/i.test(e.message) &&
          !/ignored\)/i.test(e.message),
      )
    : null;
  // Clean the error message: strip the "virt-v2v-xxx: error: " prefix
  const errorText = fatalError
    ? fatalError.rawLine.replace(/^virt-v2v[\w-]*:\s*error:\s*/i, '').trim()
    : null;

  const bannerStyle =
    toolRun.exitStatus === 'success'
      ? 'bg-green-50 dark:bg-green-900/20 border-green-300 dark:border-green-700'
      : toolRun.exitStatus === 'in_progress'
        ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-300 dark:border-blue-700'
        : 'bg-red-50 dark:bg-red-900/20 border-red-300 dark:border-red-700';

  const bannerIcon =
    toolRun.exitStatus === 'success' ? '✅' : toolRun.exitStatus === 'in_progress' ? '🔄' : '❌';

  const bannerTextColor =
    toolRun.exitStatus === 'success'
      ? 'text-green-700 dark:text-green-300'
      : toolRun.exitStatus === 'in_progress'
        ? 'text-blue-700 dark:text-blue-300'
        : 'text-red-700 dark:text-red-300';

  const bannerLabel =
    toolRun.exitStatus === 'success'
      ? 'Conversion completed successfully (exit 0)'
      : toolRun.exitStatus === 'in_progress'
        ? 'Conversion in progress (no exit status detected)'
        : 'Conversion failed (exit 1)';

  return (
    <div className={`rounded-lg border-2 ${bannerStyle}`}>
      <div className="flex items-center gap-3 px-4 py-2.5">
        <span className="text-xl">{bannerIcon}</span>
        <span className={`text-sm font-semibold ${bannerTextColor}`}>
          {bannerLabel}
        </span>
        {toolRun.stages.length > 0 && (
          <span className="text-xs text-slate-500 dark:text-gray-400 ml-auto">
            {toolRun.stages[toolRun.stages.length - 1].elapsedSeconds.toFixed(1)}s elapsed
          </span>
        )}
      </div>
      {errorText && (
        <div className="px-4 pb-3 pt-0">
          <code className="block text-xs font-mono text-red-800 dark:text-red-200 bg-red-100 dark:bg-red-900/30 rounded px-3 py-2 whitespace-pre-wrap break-words">
            {errorText}
          </code>
        </div>
      )}
    </div>
  );
}

function StatBadge({
  label,
  value,
  color = 'slate',
}: {
  label: string;
  value: number;
  color?: 'slate' | 'blue' | 'purple' | 'cyan' | 'red' | 'orange';
}) {
  const colorClasses: Record<string, string> = {
    slate: 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-gray-300',
    blue: 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300',
    purple: 'bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300',
    cyan: 'bg-cyan-100 dark:bg-cyan-900/40 text-cyan-700 dark:text-cyan-300',
    red: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300',
    orange: 'bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-300',
  };

  return (
    <span className={`px-3 py-1 rounded-full text-xs font-medium ${colorClasses[color]}`}>
      {label}: {value.toLocaleString()}
    </span>
  );
}

function CollapsibleSection({
  id,
  title,
  defaultOpen,
  devPreview,
  children,
}: {
  id: string;
  title: string;
  defaultOpen?: boolean;
  devPreview?: boolean;
  children: React.ReactNode;
}) {
  const { expandedPanels, togglePanel } = useV2VStore();
  const isOpen = expandedPanels[id] ?? defaultOpen ?? false;

  return (
    <div
      className={`border rounded-lg overflow-hidden ${
        devPreview
          ? 'border-amber-300 dark:border-amber-700'
          : 'border-slate-200 dark:border-slate-700'
      }`}
    >
      <button
        onClick={() => togglePanel(id)}
        className={`w-full flex items-center justify-between px-4 py-3 transition-colors ${
          devPreview
            ? 'bg-amber-50 dark:bg-amber-900/20 hover:bg-amber-100 dark:hover:bg-amber-900/30'
            : 'bg-slate-50 dark:bg-slate-800/50 hover:bg-slate-100 dark:hover:bg-slate-800'
        }`}
      >
        <div className="flex items-center gap-2">
          <h3
            className={`text-sm font-semibold ${
              devPreview
                ? 'text-amber-700 dark:text-amber-300'
                : 'text-slate-700 dark:text-gray-300'
            }`}
          >
            {title}
          </h3>
          {devPreview && (
            <span className="text-[9px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-200 dark:bg-amber-800/50 text-amber-700 dark:text-amber-300">
              Dev
            </span>
          )}
        </div>
        <svg
          className={`w-4 h-4 transition-transform ${isOpen ? 'rotate-180' : ''} ${
            devPreview ? 'text-amber-400 dark:text-amber-500' : 'text-slate-400'
          }`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {isOpen && <div className="p-4">{children}</div>}
    </div>
  );
}
