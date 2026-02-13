import { useMemo, useState, useEffect, useCallback, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { V2VToolRun, V2VDiskProgress, V2VHostCommand } from '../../types/v2v';
import { LineLink, LineLinkNavigateContext } from './LineLink';
import { StageFileOpsTree } from './V2VFileTree';
import { groupHiveAccesses, HiveGroupCard } from './RegistryAppsPanel';
import { formatDuration } from '../../utils/format';
import { VirtualizedLogViewer } from './VirtualizedLogViewer';
import {
  isInspectStage,
  isOpenSourceStage,
  isSourceSetupStage,
  isDestinationStage,
  isSELinuxStage,
  isClosingOverlayStage,
  isFinishingOffStage,
  isHostnameStage,
  isBiosUefiStage,
  isFilesystemCheckStage,
  isFilesystemMappingStage,
  isDiskCopyStage,
  isOutputMetadataStage,
  isLinuxConversionStage,
  isWindowsConversionStage,
} from './stageMatchers';
import { InspectSourceView } from './InspectSourceView';
import { OpenSourceView } from './OpenSourceView';
import { FileWritesView, hasFileWrites } from './FileWritesView';
import { DestinationView } from './DestinationView';
import { SELinuxView } from './SELinuxView';
import { SourceSetupView } from './SourceSetupView';
import { ClosingOverlayView } from './ClosingOverlayView';
import { LinuxConversionView } from './LinuxConversionView';
import { HostnameView } from './HostnameView';
import { WindowsConversionView } from './WindowsConversionView';
import { BiosUefiView } from './BiosUefiView';
import { FilesystemCheckView } from './FilesystemCheckView';
import { FilesystemMappingView } from './FilesystemMappingView';
import { DiskCopyView } from './DiskCopyView';
import { OutputMetadataView } from './OutputMetadataView';
import { FinishingOffView } from './FinishingOffView';

interface V2VPipelineViewProps {
  toolRun: V2VToolRun;
}

interface EnrichedStage {
  name: string;
  elapsedSeconds: number;
  lineNumber: number;
  durationSeconds: number | null;
  progress: V2VDiskProgress | null;
  /** Non-trivial output lines between this stage and the next */
  content: string[] | null;
  /** Host commands executed during this stage */
  hostCommands: V2VHostCommand[];
  /** True if errors occurred during this stage (by line range or exit status) */
  hasErrors: boolean;
}

export function V2VPipelineView({ toolRun }: V2VPipelineViewProps) {
  const { stages, diskProgress, rawLines, startLine, hostCommands } = toolRun;
  const [expandedStage, setExpandedStage] = useState<number | null>(null);

  // Compute duration, progress, inter-stage content, and host commands per stage
  const stagesWithDuration = useMemo<EnrichedStage[]>(() => {
    return stages.map((stage, idx) => {
      const nextStage = idx + 1 < stages.length ? stages[idx + 1] : null;
      const durationSeconds = nextStage
        ? nextStage.elapsedSeconds - stage.elapsedSeconds
        : null;

      // Disk progress
      const diskMatch = stage.name.match(/^Copying disk (\d+)\/(\d+)/);
      let progress: V2VDiskProgress | null = null;
      if (diskMatch) {
        const diskNum = parseInt(diskMatch[1], 10);
        const diskEntries = diskProgress.filter((dp) => dp.diskNumber === diskNum);
        if (diskEntries.length > 0) {
          progress = diskEntries[diskEntries.length - 1];
        }
      }

      // Extract content between this stage line and the next stage line (or end of rawLines for last stage)
      let content: string[] | null = null;
      {
        const localStart = stage.lineNumber - startLine + 1; // line after the stage header
        const localEnd = nextStage
          ? nextStage.lineNumber - startLine   // up to (not including) next stage
          : rawLines.length;                   // to end of rawLines for last stage
        if (localEnd > localStart && localStart >= 0 && localEnd <= rawLines.length) {
          const between = rawLines
            .slice(localStart, localEnd)
            .filter((l) => l.trim().length > 0);
          // Only keep if there's meaningful content (not just monitoring/noise)
          const meaningful = between.filter(
            (l) => !isNoisyInterStageLine(l),
          );
          if (meaningful.length > 0) {
            content = between;
          }
        }
      }

      // Filter host commands that fall within this stage's line range
      const stageStartLine = stage.lineNumber;
      const stageEndLine = nextStage ? nextStage.lineNumber : Infinity;
      const stageHostCmds = hostCommands.filter(
        (cmd) => cmd.lineNumber >= stageStartLine && cmd.lineNumber < stageEndLine,
      );

      // Mark the last stage as failed only when v2v actually exited with an error
      const isLastStage = idx === stages.length - 1;
      const hasErrors = isStageError(stage.name)
        || (isLastStage && toolRun.exitStatus === 'error');

      return { ...stage, durationSeconds, progress, content, hostCommands: stageHostCmds, hasErrors };
    });
  }, [stages, diskProgress, rawLines, startLine, hostCommands, toolRun.exitStatus]);

  if (stages.length === 0) {
    return (
      <p className="text-sm text-slate-500 dark:text-gray-400 italic">
        No pipeline stages found in this tool run.
      </p>
    );
  }

  const totalSeconds = stages[stages.length - 1].elapsedSeconds;

  return (
    <div className="space-y-3">
      {/* Total duration */}
      <div className="text-xs text-slate-500 dark:text-gray-400">
        Total elapsed: <span className="font-semibold">{formatDuration(totalSeconds)}</span>
        {' '}&middot;{' '}
        {stages.length} stage{stages.length !== 1 ? 's' : ''}
      </div>

      {/* Pipeline visualization */}
      <div className="flex flex-wrap items-start gap-y-5 gap-x-0">
        {stagesWithDuration.map((stage, idx) => {
          const isLast = idx === stagesWithDuration.length - 1;
          const hasError = stage.hasErrors;
          const hasContent = stage.content !== null;
          const isExpanded = expandedStage === idx;
          const contentLines = stage.content?.length ?? 0;
          const isConversion = isLinuxConversionStage(stage.name, stage.content ?? undefined)
            || isWindowsConversionStage(stage.name, stage.content ?? undefined);

          return (
            <div key={idx} className="flex flex-col items-center">
              {/* Row with stage box + connector */}
              <div className="flex items-center">
                {/* Stage box + progress bar column — keeps progress bar same width as button */}
                <div className="flex flex-col items-stretch">
                  <div
                    role={hasContent ? 'button' : undefined}
                    tabIndex={hasContent ? 0 : undefined}
                    aria-expanded={hasContent ? isExpanded : undefined}
                    onClick={hasContent ? () => setExpandedStage(isExpanded ? null : idx) : undefined}
                    onKeyDown={hasContent ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpandedStage(isExpanded ? null : idx); } } : undefined}
                    className={`
                      relative px-3 py-2 rounded-lg text-xs max-w-[200px] transition-all border-2
                      ${isConversion ? 'font-bold' : 'font-medium'}
                      ${hasContent ? 'cursor-pointer' : ''}
                      ${isExpanded
                        ? hasError
                          ? 'shadow-md shadow-red-200 dark:shadow-red-900/40'
                          : 'shadow-md shadow-emerald-200 dark:shadow-emerald-900/40'
                        : ''
                      }
                      ${hasError
                        ? isLast
                          ? 'bg-red-500 dark:bg-red-600 text-white border-red-500 dark:border-red-600'
                          : 'bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 border-red-400 dark:border-red-600'
                        : isLast
                          ? 'bg-emerald-500 dark:bg-emerald-600 text-white border-emerald-500 dark:border-emerald-600'
                          : 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-800 dark:text-emerald-200 border-emerald-400 dark:border-emerald-600'
                      }
                      ${hasContent && !isExpanded && !hasError ? 'hover:bg-emerald-100 dark:hover:bg-emerald-900/30 hover:shadow-sm' : ''}
                      ${hasContent && !isExpanded && hasError ? 'hover:bg-red-100 dark:hover:bg-red-900/40 hover:shadow-sm' : ''}
                    `}
                    title={`${stage.name}\nAt: ${formatDuration(stage.elapsedSeconds)}${stage.durationSeconds !== null ? `\nDuration: ${formatDuration(stage.durationSeconds)}` : ''}${hasContent ? '\nClick to view output' : ''}\nLine: ${stage.lineNumber + 1}`}
                  >
                    <span className="block truncate leading-tight text-center">
                      {shortenStageName(stage.name)}
                    </span>

                    {/* Badge with content line count */}
                    {hasContent && contentLines > 0 && (
                      <span
                        className={`absolute -top-2.5 -right-2.5 min-w-[20px] h-5 flex items-center justify-center px-1 rounded-full text-[9px] font-bold border-2 border-white dark:border-slate-900 ${
                          hasError
                            ? 'bg-red-500 text-white'
                            : 'bg-emerald-500 text-white'
                        }`}
                      >
                        {contentLines > 999 ? `${(contentLines / 1000).toFixed(0)}k` : contentLines}
                      </span>
                    )}
                  </div>

                  {/* Progress bar — below button, same width via items-stretch */}
                  {stage.progress && (
                    <div className="mt-1 px-0.5">
                      <div className="h-1.5 bg-emerald-100 dark:bg-emerald-900/30 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-emerald-500 rounded-full transition-all"
                          style={{ width: `${stage.progress.percentComplete}%` }}
                        />
                      </div>
                      <span className="block text-center text-[9px] text-emerald-600 dark:text-emerald-400">
                        {stage.progress.percentComplete}%
                      </span>
                    </div>
                  )}
                </div>

                {/* Connector line — when a progress bar is present, self-align to top + offset
                   so the connector stays centered on the button instead of the taller column */}
                {!isLast && (
                  <div className={`w-5 h-0.5 flex-shrink-0${stage.progress ? ' self-start mt-4' : ''} ${hasError ? 'bg-red-300 dark:bg-red-700' : 'bg-emerald-300 dark:bg-emerald-700'}`} />
                )}
              </div>

              {/* Timing below */}
              <div className="mt-1 flex flex-col items-center">
                {stage.durationSeconds !== null && stage.durationSeconds > 0 && (
                  <span className={`text-[10px] font-medium ${hasError ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                    {formatDuration(stage.durationSeconds)}
                  </span>
                )}
                <LineLink line={stage.lineNumber} />
              </div>
            </div>
          );
        })}
      </div>

      {/* Modal for stage content */}
      {expandedStage !== null && stagesWithDuration[expandedStage]?.content && (() => {
        const stage = stagesWithDuration[expandedStage];
        const nextStage = stagesWithDuration[expandedStage + 1];
        return (
          <StageContentModal
            stageName={stage.name}
            content={stage.content!}
            toolRun={toolRun}
            hostCommands={stage.hostCommands}
            stageStartLine={stage.lineNumber}
            stageEndLine={nextStage ? nextStage.lineNumber : toolRun.endLine}
            onClose={() => setExpandedStage(null)}
          />
        );
      })()}
    </div>
  );
}

// ── Stage content viewer ─────────────────────────────────────────────────────

/** Extract warning lines from stage content. */
function extractWarnings(content: string[]): string[] {
  return content.filter((l) => l.includes('virt-v2v: warning:') || l.includes('virt-v2v-in-place: warning:'));
}

// ── Stage view registry ─────────────────────────────────────────────────────
// Single source of truth for stage → view mapping. Adding a new stage view
// only requires one entry here instead of updating 3 separate places.

type StageRenderProps = { content: string[]; stageName: string; toolRun: V2VToolRun; stageStartLine: number; stageEndLine: number };

interface StageViewEntry {
  match: (name: string, content?: string[]) => boolean;
  render: (props: StageRenderProps) => ReactNode;
  /** If true, this stage should not be claimed by conversion detection */
  isSpecific: boolean;
}

const STAGE_VIEWS: StageViewEntry[] = [
  // Specific stages — matched first and excluded from conversion fallback
  { match: isInspectStage, render: ({ content }) => <InspectSourceView content={content} />, isSpecific: true },
  { match: isOpenSourceStage, render: ({ content }) => <OpenSourceView content={content} />, isSpecific: true },
  { match: isSourceSetupStage, render: ({ content }) => <SourceSetupView content={content} />, isSpecific: true },
  { match: isDestinationStage, render: ({ content }) => <DestinationView content={content} />, isSpecific: true },
  { match: isSELinuxStage, render: ({ content, toolRun, stageStartLine, stageEndLine }) => {
    const apiCalls = toolRun.apiCalls.filter((c) => c.lineNumber >= stageStartLine && c.lineNumber < stageEndLine);
    const fileCopies = toolRun.virtioWin.fileCopies.filter((fc) => fc.lineNumber >= stageStartLine && fc.lineNumber < stageEndLine);
    return <SELinuxView content={content} toolRun={toolRun} stageApiCalls={apiCalls} stageFileCopies={fileCopies} />;
  }, isSpecific: true },
  { match: isClosingOverlayStage, render: ({ content }) => <ClosingOverlayView content={content} />, isSpecific: true },
  { match: isFinishingOffStage, render: ({ content }) => <FinishingOffView content={content} />, isSpecific: true },
  { match: isHostnameStage, render: ({ content, stageName }) => <HostnameView content={content} stageName={stageName} />, isSpecific: true },
  { match: isBiosUefiStage, render: ({ content }) => <BiosUefiView content={content} />, isSpecific: true },
  { match: isFilesystemCheckStage, render: ({ content }) => <FilesystemCheckView content={content} />, isSpecific: true },
  { match: isFilesystemMappingStage, render: ({ content }) => <FilesystemMappingView content={content} />, isSpecific: true },
  { match: isDiskCopyStage, render: ({ content, stageName }) => <DiskCopyView content={content} stageName={stageName} />, isSpecific: true },
  { match: isOutputMetadataStage, render: ({ content }) => <OutputMetadataView content={content} />, isSpecific: true },
  // Conversion stages — content-based fallback, not specific
  { match: isLinuxConversionStage, render: ({ content, toolRun, stageStartLine, stageEndLine }) => <LinuxConversionView content={content} toolRun={toolRun} stageStartLine={stageStartLine} stageEndLine={stageEndLine} />, isSpecific: false },
  { match: isWindowsConversionStage, render: ({ content, toolRun, stageStartLine, stageEndLine }) => <WindowsConversionView content={content} toolRun={toolRun} stageStartLine={stageStartLine} stageEndLine={stageEndLine} />, isSpecific: false },
];

/** Find the first matching stage view entry. */
function findStageView(name: string, content?: string[]): StageViewEntry | undefined {
  return STAGE_VIEWS.find((e) => e.match(name, content));
}

/** Does this stage have a structured view available? */
function hasStructuredView(name: string, content?: string[]): boolean {
  if (findStageView(name, content)) return true;
  // Fallback: any stage with file write operations
  if (content && hasFileWrites(content)) return true;
  // Fallback: any stage that contains warnings
  if (content && extractWarnings(content).length > 0) return true;
  return false;
}

function StageContentModal({
  stageName,
  content,
  toolRun,
  hostCommands: stageHostCmds,
  stageStartLine,
  stageEndLine,
  onClose,
}: {
  stageName: string;
  content: string[];
  toolRun: V2VToolRun;
  hostCommands: V2VHostCommand[];
  stageStartLine: number;
  stageEndLine: number;
  onClose: () => void;
}) {
  const [showRaw, setShowRaw] = useState(false);
  const [rawSearch, setRawSearch] = useState('');

  // Close on Escape key
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // If the user is in a search input with text, let the input handle ESC first
        const target = e.target as HTMLElement;
        if (target.tagName === 'INPUT' && (target as HTMLInputElement).value) {
          return;
        }
        onClose();
      }
    },
    [onClose],
  );

  useEffect(() => {
    // Use capture phase so ESC fires even if a child element stops propagation
    document.addEventListener('keydown', handleKeyDown, true);
    // Prevent body scroll while modal is open
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      document.body.style.overflow = '';
    };
  }, [handleKeyDown]);

  // Filter API calls, file copies, and registry hive accesses to this stage's line range
  const stageApiCalls = useMemo(
    () => toolRun.apiCalls.filter((c) => c.lineNumber >= stageStartLine && c.lineNumber < stageEndLine),
    [toolRun.apiCalls, stageStartLine, stageEndLine],
  );
  const stageFileCopies = useMemo(
    () => toolRun.virtioWin.fileCopies.filter((fc) => fc.lineNumber >= stageStartLine && fc.lineNumber < stageEndLine),
    [toolRun.virtioWin.fileCopies, stageStartLine, stageEndLine],
  );
  const stageHiveAccesses = useMemo(
    () => toolRun.registryHiveAccesses.filter((a) => a.lineNumber >= stageStartLine && a.lineNumber < stageEndLine),
    [toolRun.registryHiveAccesses, stageStartLine, stageEndLine],
  );
  const stageHiveGroups = useMemo(
    () => groupHiveAccesses(stageHiveAccesses),
    [stageHiveAccesses],
  );

  // Detect content type
  const isYaml = content.some((l) => /^(apiVersion:|kind:|metadata:|spec:|---\s*$)/.test(l.trim()));
  const isStructured = hasStructuredView(stageName, content);
  const label = isYaml ? 'YAML Output' : 'Output';

  // Conversion and SELinux stages already show their own file ops — skip the generic ones for those
  const isConversionStage = isLinuxConversionStage(stageName, content) || isWindowsConversionStage(stageName, content);
  const hasOwnFileOps = isConversionStage || isSELinuxStage(stageName);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 md:p-10">
      {/* Backdrop — click to close */}
      <div className="absolute inset-0 bg-black/50 dark:bg-black/70" onClick={onClose} />

      {/* Modal panel — wrap with LineLinkNavigateContext so clicking any LineLink closes the modal */}
      <LineLinkNavigateContext.Provider value={onClose}>
      <div className="relative w-full max-w-5xl max-h-[90vh] flex flex-col bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-700 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 bg-indigo-50 dark:bg-indigo-900/30 border-b border-indigo-200 dark:border-indigo-800 flex-shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <span className="text-sm font-semibold text-indigo-700 dark:text-indigo-300 truncate">
              {stageName}
            </span>
            <span className="text-[10px] text-indigo-500 dark:text-indigo-400 flex-shrink-0">
              {label} ({content.length} lines)
            </span>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {isStructured && (
              <button
                onClick={() => setShowRaw(!showRaw)}
                className={`text-[10px] px-2.5 py-1 rounded transition-colors ${
                  showRaw
                    ? 'bg-indigo-200 dark:bg-indigo-800 text-indigo-700 dark:text-indigo-300'
                    : 'bg-indigo-100 dark:bg-indigo-900/50 text-indigo-500 dark:text-indigo-400 hover:bg-indigo-200 dark:hover:bg-indigo-800'
                }`}
              >
                {showRaw ? 'Structured' : 'Raw Log'}
              </button>
            )}
            <button
              onClick={onClose}
              className="p-1 rounded-md text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              title="Close (Esc)"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Content area */}
        <div className="flex-1 overflow-auto">
          {isStructured && !showRaw ? (
            <div className="px-5 py-4">
              {(() => {
                const entry = findStageView(stageName, content);
                if (entry) return entry.render({ content, stageName, toolRun, stageStartLine, stageEndLine });
                // Only show FileWritesView as fallback when no StageFileOpsTree will be rendered
                // (StageFileOpsTree already shows the same file write data in tree form)
                if (hasOwnFileOps) return <FileWritesView content={content} />;
                return null;
              })()}
              {/* Stage warnings (skip for Windows conversion which has its own) */}
              {!isWindowsConversionStage(stageName, content) && (
                <StageWarnings content={content} />
              )}
              {/* Per-stage file operations tree (skip for stages that have their own) */}
              {!hasOwnFileOps && (
                <StageFileOpsTree apiCalls={stageApiCalls} fileCopies={stageFileCopies} />
              )}
              {/* Per-stage registry hive operations (skip for conversion stages that have their own) */}
              {!isConversionStage && stageHiveGroups.length > 0 && (
                <div className="mt-4">
                  <div className="text-[10px] font-semibold text-slate-500 dark:text-gray-400 uppercase tracking-wider mb-2">
                    Registry Hive Operations
                  </div>
                  <div className="text-xs text-slate-500 dark:text-gray-400 mb-2">
                    {stageHiveGroups.length} registry hive{stageHiveGroups.length !== 1 ? 's' : ''} accessed
                    ({stageHiveAccesses.length} key path{stageHiveAccesses.length !== 1 ? 's' : ''} traversed)
                  </div>
                  <div className="space-y-2">
                    {stageHiveGroups.map((group) => (
                      <HiveGroupCard key={group.hivePath} group={group} />
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <RawLogWithSearch content={content} search={rawSearch} onSearchChange={setRawSearch} />
          )}

          {/* Host Commands for this stage (only in structured view) */}
          {!showRaw && stageHostCmds.length > 0 && (
            <StageHostCommands commands={stageHostCmds} />
          )}
        </div>
      </div>
      </LineLinkNavigateContext.Provider>
    </div>,
    document.body,
  );
}

// ── Stage warnings ──────────────────────────────────────────────────────────

function StageWarnings({ content }: { content: string[] }) {
  const warnings = useMemo(() => extractWarnings(content), [content]);
  if (warnings.length === 0) return null;

  return (
    <div className="space-y-1.5 mt-3">
      <h4 className="text-[10px] font-semibold text-amber-600 dark:text-amber-400 uppercase tracking-wider">
        Warnings
      </h4>
      {warnings.map((w, i) => {
        const msg = w.replace(/^virt-v2v(-in-place)?:\s*warning:\s*/i, '').trim();
        return (
          <div
            key={i}
            className="flex items-start gap-2 px-3 py-2 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/10 text-xs text-amber-800 dark:text-amber-200"
          >
            <span className="flex-shrink-0 mt-0.5">⚠</span>
            <span>{msg}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── Host commands for a stage ────────────────────────────────────────────────

function StageHostCommands({ commands }: { commands: V2VHostCommand[] }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="mx-5 my-3 border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="w-full flex items-center justify-between px-4 py-2 bg-slate-50 dark:bg-slate-800/50 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
      >
        <span className="text-xs font-semibold text-slate-700 dark:text-gray-300">
          Host Commands ({commands.length})
        </span>
        <svg
          className={`w-4 h-4 text-slate-400 transition-transform ${expanded ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {expanded && (
        <div className="divide-y divide-slate-100 dark:divide-slate-800">
          {commands.map((cmd, idx) => (
            <div key={idx} className="flex items-baseline gap-2 px-4 py-1.5 text-[11px]">
              <span className="flex-shrink-0 font-mono text-slate-400 dark:text-gray-500 w-5 text-right">
                {idx + 1}
              </span>
              <code className="flex-1 font-mono text-slate-700 dark:text-gray-300 break-all">
                {cmd.command} {cmd.args.join(' ')}
              </code>
              <span className="flex-shrink-0">
                <LineLink line={cmd.lineNumber} />
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Raw log with search (uses shared VirtualizedLogViewer) ──────────────────

function RawLogWithSearch({
  content,
  search,
  onSearchChange,
}: {
  content: string[];
  search: string;
  onSearchChange: (v: string) => void;
}) {
  return (
    <VirtualizedLogViewer
      lines={content}
      search={search}
      onSearchChange={onSearchChange}
      config={{ searchPlaceholder: 'Search raw log...' }}
    />
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Lines between stages that are just noise (monitoring, nbdkit cleanup, etc.) */
function isNoisyInterStageLine(line: string): boolean {
  if (/^virt-v2v monitoring:/.test(line)) return true;
  if (/^nbdkit:/.test(line)) return true;
  if (/^rm -rf --/.test(line)) return true;
  // guestfsd protocol chatter is noise, but not all of it
  if (/^guestfsd: [<=>]/.test(line)) return true;
  // SELinux/cgroup noise from commandrvf
  if (line === 'SELinux enabled state cached to: disabled') return true;
  if (line.startsWith('No filesystem is currently mounted on /sys/fs/cgroup')) return true;
  if (line.startsWith('Failed to determine unit we run in')) return true;
  return false;
}


function shortenStageName(name: string): string {
  // Remove long source arguments after stage names
  const colonIdx = name.indexOf(':');
  if (colonIdx > 0 && colonIdx < 40) {
    const prefix = name.slice(0, colonIdx);
    // Keep first 30 chars after colon
    const rest = name.slice(colonIdx + 1).trim();
    if (rest.length > 30) {
      return `${prefix}: ${rest.slice(0, 27)}...`;
    }
    return name;
  }
  if (name.length > 50) {
    return name.slice(0, 47) + '...';
  }
  return name;
}

function isStageError(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes('error') || lower.includes('fail');
}
