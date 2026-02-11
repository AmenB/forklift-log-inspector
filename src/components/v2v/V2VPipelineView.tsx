import { useMemo, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { V2VToolRun, V2VDiskProgress, V2VHostCommand } from '../../types/v2v';
import { LineLink, LineLinkNavigateContext } from './LineLink';
import { formatDuration } from '../../utils/format';
import { InspectSourceView } from './InspectSourceView';
import { OpenSourceView } from './OpenSourceView';
import { FileWritesView, hasFileWrites } from './FileWritesView';
import { DestinationView } from './DestinationView';
import { SELinuxView } from './SELinuxView';
import { SourceSetupView } from './SourceSetupView';
import { ClosingOverlayView } from './ClosingOverlayView';
import { LinuxConversionView, isLinuxConversionContent } from './LinuxConversionView';
import { HostnameView } from './HostnameView';
import { WindowsConversionView, isWindowsConversionContent } from './WindowsConversionView';
import { BiosUefiView } from './BiosUefiView';
import { FilesystemCheckView } from './FilesystemCheckView';
import { FilesystemMappingView, isFilesystemMappingStage } from './FilesystemMappingView';
import { DiskCopyView, isDiskCopyStage } from './DiskCopyView';
import { OutputMetadataView, isOutputMetadataStage } from './OutputMetadataView';
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

      return { ...stage, durationSeconds, progress, content, hostCommands: stageHostCmds };
    });
  }, [stages, diskProgress, rawLines, startLine, hostCommands]);

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
          const hasError = isStageError(stage.name);
          const hasContent = stage.content !== null;
          const isExpanded = expandedStage === idx;
          const contentLines = stage.content?.length ?? 0;
          const isConversion = isLinuxConversionStage(stage.name, stage.content ?? undefined)
            || isWindowsConversionStage(stage.name, stage.content ?? undefined);

          return (
            <div key={idx} className="flex flex-col items-center">
              {/* Row with stage box + connector */}
              <div className="flex items-center">
                <div
                  onClick={hasContent ? () => setExpandedStage(isExpanded ? null : idx) : undefined}
                  className={`
                    relative px-3 py-2 rounded-lg text-xs max-w-[200px] transition-all border-2
                    ${isConversion ? 'font-bold' : 'font-medium'}
                    ${hasContent ? 'cursor-pointer' : ''}
                    ${isExpanded ? 'shadow-md shadow-emerald-200 dark:shadow-emerald-900/40' : ''}
                    ${hasError
                      ? 'bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 border-red-400 dark:border-red-600'
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

                {/* Connector line */}
                {!isLast && (
                  <div className="w-5 h-0.5 bg-emerald-300 dark:bg-emerald-700 flex-shrink-0" />
                )}
              </div>

              {/* Progress bar for disk copy stages */}
              {stage.progress && (
                <div className="mt-1 w-full max-w-[200px]">
                  <div className="h-1.5 bg-emerald-100 dark:bg-emerald-900/30 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-emerald-500 rounded-full transition-all"
                      style={{ width: `${stage.progress.percentComplete}%` }}
                    />
                  </div>
                  <span className="text-[9px] text-emerald-600 dark:text-emerald-400">
                    {stage.progress.percentComplete}%
                  </span>
                </div>
              )}

              {/* Timing below */}
              <div className="mt-1 flex flex-col items-center">
                {stage.durationSeconds !== null && stage.durationSeconds > 0 && (
                  <span className="text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
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
      {expandedStage !== null && stagesWithDuration[expandedStage]?.content && (
        <StageContentModal
          stageName={stagesWithDuration[expandedStage].name}
          content={stagesWithDuration[expandedStage].content!}
          toolRun={toolRun}
          hostCommands={stagesWithDuration[expandedStage].hostCommands}
          onClose={() => setExpandedStage(null)}
        />
      )}
    </div>
  );
}

// ── Stage content viewer ─────────────────────────────────────────────────────

/** Detect if this stage name has structured data that InspectSourceView can parse. */
function isInspectStage(name: string): boolean {
  const lower = name.toLowerCase();
  // Exclude BIOS/UEFI detection stage — it has its own view
  if (isBiosUefiStage(lower)) return false;
  // Exclude filesystem integrity check — it has its own view
  if (isFilesystemCheckStage(lower)) return false;
  // Exclude filesystem mapping stage — it has its own view
  if (isFilesystemMappingStage(lower)) return false;
  return (
    (lower.includes('inspecting') && lower.includes('source')) ||
    (lower.includes('detecting') && (lower.includes('bios') || lower.includes('uefi') || lower.includes('boot'))) ||
    (lower.includes('checking') && lower.includes('filesystem') && lower.includes('integrity')) ||
    (lower.includes('mapping') && lower.includes('filesystem'))
  );
}

/** Detect "Checking filesystem integrity before/after conversion" stage. */
function isFilesystemCheckStage(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes('checking') && lower.includes('filesystem') && lower.includes('integrity');
}

/** Detect if this stage is "Opening the source" (appliance boot). */
function isOpenSourceStage(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes('opening') && lower.includes('source');
}

/** Detect if this stage is "Setting up the source". */
function isSourceSetupStage(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes('setting up') && lower.includes('source');
}

/** Detect if this stage is "Setting up the destination". */
function isDestinationStage(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes('setting up') && lower.includes('destination');
}

/** Detect if this stage is "SELinux relabelling". */
function isSELinuxStage(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes('selinux');
}

/** Detect if this stage is "Closing the overlay". */
function isClosingOverlayStage(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes('closing') && lower.includes('overlay');
}

/** Detect if this stage is "Finishing off". */
function isFinishingOffStage(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes('finishing') && lower.includes('off');
}

/** Detect if this stage is "Setting the hostname". */
function isHostnameStage(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes('setting') && lower.includes('hostname');
}

/** Detect if this stage is a Linux/RHEL conversion stage. */
function isLinuxConversionStage(name: string, content?: string[]): boolean {
  const lower = name.toLowerCase();
  // Match name-based patterns: "RHEL/Linux conversion", "Linux conversion", etc.
  if (lower.includes('conversion') && (lower.includes('linux') || lower.includes('rhel'))) return true;
  // Match "Converting X.Y (distro) to run on ..." — Debian/Ubuntu use this naming
  if (lower.includes('converting') && !lower.includes('windows') && lower.includes('to run on')) return true;
  if (lower.includes('converting') && !lower.includes('windows') && lower.includes('to ')) return true;
  // Match "picked conversion module linux" in the name
  if (lower.includes('picked conversion module') && !lower.includes('windows')) return true;
  // Fallback: check content — but NOT if the name matches a known specific stage
  if (content && !isSpecificNonConversionStage(name) && isLinuxConversionContent(content) && !isWindowsConversionContent(content)) return true;
  return false;
}

/** Detect if this stage is a Windows conversion stage. */
function isWindowsConversionStage(name: string, content?: string[]): boolean {
  const lower = name.toLowerCase();
  if (lower.includes('converting') && lower.includes('windows')) return true;
  if (lower.includes('picked conversion module') && lower.includes('windows')) return true;
  if (lower.includes('conversion') && lower.includes('windows')) return true;
  // Fallback: check content — but NOT if the name already matches a known specific stage
  // (hostname, seed, SELinux, etc. all contain Windows API calls like inspect_get_type)
  if (content && !isSpecificNonConversionStage(name) && isWindowsConversionContent(content)) return true;
  return false;
}

/** Stages that have their own views and should not be claimed by conversion detection. */
function isSpecificNonConversionStage(name: string): boolean {
  const lower = name.toLowerCase();
  return STAGE_VIEWS.some((e) => e.isSpecific && e.match(name))
    || isSeedStage(name)
    || (lower.includes('checking') && lower.includes('free') && lower.includes('disk'))
    || (lower.includes('checking') && lower.includes('free') && lower.includes('space'));
}

/** Detect "Setting a random seed" or similar seed stages. */
function isSeedStage(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes('seed') || lower.includes('random');
}

/** Detect "Checking if the guest needs BIOS or UEFI to boot" stage. */
function isBiosUefiStage(name: string): boolean {
  const lower = name.toLowerCase();
  return (lower.includes('bios') || lower.includes('uefi')) && lower.includes('boot');
}

/** Extract warning lines from stage content. */
function extractWarnings(content: string[]): string[] {
  return content.filter((l) => l.includes('virt-v2v: warning:') || l.includes('virt-v2v-in-place: warning:'));
}

// ── Stage view registry ─────────────────────────────────────────────────────
// Single source of truth for stage → view mapping. Adding a new stage view
// only requires one entry here instead of updating 3 separate places.

type StageRenderProps = { content: string[]; stageName: string; toolRun: V2VToolRun };

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
  { match: isSELinuxStage, render: ({ content, toolRun }) => <SELinuxView content={content} toolRun={toolRun} />, isSpecific: true },
  { match: isClosingOverlayStage, render: ({ content }) => <ClosingOverlayView content={content} />, isSpecific: true },
  { match: isFinishingOffStage, render: ({ content }) => <FinishingOffView content={content} />, isSpecific: true },
  { match: isHostnameStage, render: ({ content, stageName }) => <HostnameView content={content} stageName={stageName} />, isSpecific: true },
  { match: isBiosUefiStage, render: ({ content }) => <BiosUefiView content={content} />, isSpecific: true },
  { match: isFilesystemCheckStage, render: ({ content }) => <FilesystemCheckView content={content} />, isSpecific: true },
  { match: isFilesystemMappingStage, render: ({ content }) => <FilesystemMappingView content={content} />, isSpecific: true },
  { match: isDiskCopyStage, render: ({ content, stageName }) => <DiskCopyView content={content} stageName={stageName} />, isSpecific: true },
  { match: isOutputMetadataStage, render: ({ content }) => <OutputMetadataView content={content} />, isSpecific: true },
  // Conversion stages — content-based fallback, not specific
  { match: isLinuxConversionStage, render: ({ content, toolRun }) => <LinuxConversionView content={content} toolRun={toolRun} />, isSpecific: false },
  { match: isWindowsConversionStage, render: ({ content, toolRun }) => <WindowsConversionView content={content} toolRun={toolRun} />, isSpecific: false },
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
  onClose,
}: {
  stageName: string;
  content: string[];
  toolRun: V2VToolRun;
  hostCommands: V2VHostCommand[];
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

  // Detect content type
  const isYaml = content.some((l) => /^(apiVersion:|kind:|metadata:|spec:|---\s*$)/.test(l.trim()));
  const isStructured = hasStructuredView(stageName, content);
  const label = isYaml ? 'YAML Output' : 'Output';

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
                return entry
                  ? entry.render({ content, stageName, toolRun })
                  : <FileWritesView content={content} />;
              })()}
              <StageWarnings content={content} />
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
            <div key={idx} className="flex items-start gap-2 px-4 py-1.5 text-[11px]">
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

// ── Raw log with search ─────────────────────────────────────────────────────

function RawLogWithSearch({
  content,
  search,
  onSearchChange,
}: {
  content: string[];
  search: string;
  onSearchChange: (v: string) => void;
}) {
  const lowerSearch = search.toLowerCase();
  const preRef = useRef<HTMLPreElement>(null);

  // Indices of lines that match the search
  const matchLineIndices = useMemo(() => {
    if (!lowerSearch) return [];
    const indices: number[] = [];
    for (let i = 0; i < content.length; i++) {
      if (content[i].toLowerCase().includes(lowerSearch)) indices.push(i);
    }
    return indices;
  }, [content, lowerSearch]);

  const [currentMatchIdx, setCurrentMatchIdx] = useState(0);

  // Reset current match when search changes
  useEffect(() => {
    setCurrentMatchIdx(0);
  }, [lowerSearch]);

  // Scroll to the current match line
  useEffect(() => {
    if (matchLineIndices.length === 0 || !preRef.current) return;
    const lineIdx = matchLineIndices[currentMatchIdx];
    if (lineIdx === undefined) return;
    // Use rAF to ensure the DOM has been laid out after React re-render
    requestAnimationFrame(() => {
      const lineEl = preRef.current?.querySelector(`[data-line="${lineIdx}"]`) as HTMLElement | null;
      if (!lineEl) return;
      // Find the scrollable ancestor (the modal's overflow-auto content div)
      let container = lineEl.parentElement;
      while (container && container.scrollHeight <= container.clientHeight) {
        container = container.parentElement;
      }
      if (container) {
        const lineRect = lineEl.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        const targetScroll = container.scrollTop + (lineRect.top - containerRect.top) - containerRect.height / 2;
        container.scrollTo({ top: Math.max(0, targetScroll), behavior: 'smooth' });
      } else {
        lineEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentMatchIdx, matchLineIndices, lowerSearch]);

  const goNext = useCallback(() => {
    if (matchLineIndices.length === 0) return;
    setCurrentMatchIdx((prev) => (prev + 1) % matchLineIndices.length);
  }, [matchLineIndices.length]);

  const goPrev = useCallback(() => {
    if (matchLineIndices.length === 0) return;
    setCurrentMatchIdx((prev) => (prev - 1 + matchLineIndices.length) % matchLineIndices.length);
  }, [matchLineIndices.length]);

  const currentMatchLine = matchLineIndices.length > 0 ? matchLineIndices[currentMatchIdx] : -1;

  return (
    <div className="flex flex-col">
      {/* Search bar — sticky so it stays visible when scrolling */}
      <div className="sticky top-0 z-10 flex items-center gap-2 px-5 py-2 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50">
        <svg className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          type="text"
          placeholder="Search raw log..."
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          className="flex-1 text-xs px-2 py-1 border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-800 text-slate-900 dark:text-gray-100 placeholder:text-slate-400 outline-none focus:border-indigo-400 dark:focus:border-indigo-500"
          onKeyDown={(e) => {
            if (e.key === 'Escape' && search) {
              e.stopPropagation();
              onSearchChange('');
            } else if (e.key === 'Enter') {
              e.preventDefault();
              if (e.shiftKey) goPrev();
              else goNext();
            }
          }}
        />
        {lowerSearch && matchLineIndices.length > 0 && (
          <>
            <span className="text-[10px] text-slate-400 dark:text-gray-500 flex-shrink-0">
              {currentMatchIdx + 1} / {matchLineIndices.length}
            </span>
            <button
              onClick={goPrev}
              className="p-0.5 rounded text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
              title="Previous match (Shift+Enter)"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
              </svg>
            </button>
            <button
              onClick={goNext}
              className="p-0.5 rounded text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
              title="Next match (Enter)"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
          </>
        )}
        {lowerSearch && matchLineIndices.length === 0 && (
          <span className="text-[10px] text-red-400 dark:text-red-500 flex-shrink-0">
            No matches
          </span>
        )}
        {search && (
          <button
            onClick={() => onSearchChange('')}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
            title="Clear search"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {/* Log content — all lines shown, matches highlighted */}
      <pre
        ref={preRef}
        className="px-5 py-4 text-[11px] font-mono leading-relaxed text-slate-800 dark:text-gray-200"
      >
        {content.map((line, i) => {
          const isMatch = lowerSearch && line.toLowerCase().includes(lowerSearch);
          const isCurrent = i === currentMatchLine;
          return (
            <div
              key={i}
              data-line={i}
              className={`whitespace-pre ${
                isCurrent
                  ? 'bg-yellow-200 dark:bg-yellow-900/40'
                  : isMatch
                    ? 'bg-yellow-100/60 dark:bg-yellow-900/20'
                    : ''
              }`}
            >
              {isMatch ? highlightSearchText(line, lowerSearch) : line}
            </div>
          );
      })}
      </pre>
    </div>
  );
}

function highlightSearchText(text: string, lowerQuery: string): ReactNode {
  const parts: React.ReactNode[] = [];
  const lower = text.toLowerCase();
  let lastIdx = 0;

  while (true) {
    const idx = lower.indexOf(lowerQuery, lastIdx);
    if (idx === -1) break;
    if (idx > lastIdx) parts.push(text.slice(lastIdx, idx));
    parts.push(
      <mark key={idx} className="bg-yellow-300 dark:bg-yellow-700 text-inherit rounded-sm px-0.5">
        {text.slice(idx, idx + lowerQuery.length)}
      </mark>,
    );
    lastIdx = idx + lowerQuery.length;
  }
  if (lastIdx < text.length) parts.push(text.slice(lastIdx));
  return parts.length > 0 ? <>{parts}</> : text;
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
