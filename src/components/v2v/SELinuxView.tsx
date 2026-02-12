/**
 * Structured visualization for the "SELinux relabelling" pipeline stage.
 *
 * Parses SELinux configuration, augeas parse errors, mount points,
 * setfiles execution details, and the relabelled files summary.
 */
import { useMemo, useState } from 'react';
import type {
  SELinuxConfig,
  AugeasError,
  MountPoint,
  SetfilesExec,
} from '../../parser/v2v';
import { parseSELinuxContent } from '../../parser/v2v';
import type { V2VToolRun, V2VApiCall, V2VFileCopy } from '../../types/v2v';
import { SectionHeader } from './shared';
import { StageFileOpsTree } from './V2VFileTree';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract all Relabeled lines from the tool run's raw lines.
 *
 * The setfiles stdout (containing Relabeled entries) is often written to the
 * log AFTER the next stage marker due to output buffering. The stage content
 * only includes lines within the stage boundary, so we also scan all raw
 * lines in the entire tool run to find any Relabeled entries that were missed.
 */
function extractAllRelabeledLines(toolRun?: V2VToolRun): string[] {
  if (!toolRun) return [];
  const result: string[] = [];
  for (const line of toolRun.rawLines) {
    if (/^\s*[Rr]elabeled\s+/.test(line)) {
      result.push(line);
    }
  }
  return result;
}

// ── Component ───────────────────────────────────────────────────────────────

export function SELinuxView({ content, toolRun, stageApiCalls, stageFileCopies }: {
  content: string[];
  toolRun?: V2VToolRun;
  stageApiCalls?: V2VApiCall[];
  stageFileCopies?: V2VFileCopy[];
}) {
  const allRelabeledLines = useMemo(() => extractAllRelabeledLines(toolRun), [toolRun]);
  const parsed = useMemo(
    () => parseSELinuxContent(content, allRelabeledLines.length > 0 ? allRelabeledLines : undefined),
    [content, allRelabeledLines],
  );

  // Flat array of relabelled files for the unified tree
  const allRelabeledFiles = useMemo(
    () => parsed.relabelGroups.flatMap((g) => g.files),
    [parsed.relabelGroups],
  );

  // If nothing at all was found, show a simple message
  const hasAnyData = parsed.config.loadPolicyFound
    || parsed.config.mode
    || parsed.config.type
    || parsed.config.selinuxRelabelAvailable
    || parsed.augeasErrors.length > 0
    || parsed.mountPoints.length > 0
    || parsed.setfiles.exitCode !== null
    || parsed.totalRelabeled > 0;

  if (!hasAnyData) {
    return (
      <div className="px-3 py-4 text-center">
        <span className="text-xs text-slate-400 dark:text-gray-500 italic">
          No SELinux relabelling data found in this stage.
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* SELinux Config */}
      {(parsed.config.mode || parsed.config.type || parsed.config.loadPolicyFound || parsed.config.selinuxRelabelAvailable) && (
        <ConfigSection config={parsed.config} />
      )}

      {/* File Operations — unified tree with file checks, augeas ops, and relabelled files */}
      {(parsed.totalRelabeled > 0 || (stageApiCalls && stageApiCalls.length > 0) || (stageFileCopies && stageFileCopies.length > 0)) && (
        <div>
          <SectionHeader title="File Operations" />
          <StageFileOpsTree
            apiCalls={stageApiCalls ?? []}
            fileCopies={stageFileCopies}
            relabeledFiles={allRelabeledFiles}
          />
        </div>
      )}

      {/* Mount Points */}
      {parsed.mountPoints.length > 0 && (
        <MountPointsSection mounts={parsed.mountPoints} />
      )}

      {/* Augeas Warnings */}
      {parsed.augeasErrors.length > 0 && (
        <AugeasErrorsSection errors={parsed.augeasErrors} />
      )}

      {/* Setfiles Execution */}
      {(parsed.setfiles.durationSecs !== null ||
        parsed.setfiles.exitCode !== null ||
        parsed.setfiles.contextErrors.length > 0) && (
        <SetfilesSection setfiles={parsed.setfiles} />
      )}

    </div>
  );
}

// ── Sub-sections ────────────────────────────────────────────────────────────

function ConfigSection({ config }: { config: SELinuxConfig }) {
  // Normalize mode: "disable" → "disabled"
  const mode = config.mode === 'disable' ? 'disabled' : config.mode;

  const modeColor =
    mode === 'enforcing'
      ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 border-green-200 dark:border-green-800'
      : mode === 'permissive'
        ? 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300 border-yellow-200 dark:border-yellow-800'
        : 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800';

  return (
    <div>
      <SectionHeader title="SELinux Configuration" />
      <div className="border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2">
        <div className="flex items-baseline gap-3 flex-wrap">
          {mode && (
            <span className={`inline-flex items-baseline gap-1 px-2 py-0.5 rounded text-[10px] font-medium border ${modeColor}`}>
              SELINUX: {mode}
            </span>
          )}
          {config.type && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] border bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800">
              Type: {config.type}
            </span>
          )}
          {config.loadPolicyFound && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] border bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300 border-green-200 dark:border-green-800">
              load_policy: found
            </span>
          )}
          {config.selinuxRelabelAvailable && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] border bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300 border-green-200 dark:border-green-800">
              relabel: available
            </span>
          )}
          {config.fileContextsPath && (
            <span className="font-mono text-[10px] text-slate-500 dark:text-gray-400">
              {config.fileContextsPath}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function MountPointsSection({ mounts }: { mounts: MountPoint[] }) {
  return (
    <div>
      <SectionHeader title="Relabelled Filesystems" />
      <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-left text-slate-400 dark:text-gray-500 border-b border-slate-100 dark:border-slate-800">
              <th className="px-3 py-1 font-medium">Device</th>
              <th className="px-3 py-1 font-medium">Mount Point</th>
            </tr>
          </thead>
          <tbody>
            {mounts.map((m, i) => (
              <tr key={i} className="border-b border-slate-50 dark:border-slate-800/50 last:border-b-0">
                <td className="px-3 py-1 font-mono text-[10px] text-slate-600 dark:text-gray-300">{m.device}</td>
                <td className="px-3 py-1 font-mono text-[10px] text-slate-700 dark:text-gray-200">{m.path}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AugeasErrorsSection({ errors }: { errors: AugeasError[] }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 mb-2 group"
      >
        <svg
          className={`w-3 h-3 text-slate-400 transition-transform ${expanded ? 'rotate-90' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        <h4 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-gray-400 group-hover:text-slate-700 dark:group-hover:text-gray-300 transition-colors">
          Augeas Parse Warnings
        </h4>
        <span className="px-1.5 py-0 rounded-full bg-amber-100 dark:bg-amber-900/30 text-[10px] text-amber-700 dark:text-amber-300">
          {errors.length}
        </span>
      </button>
      {expanded && (
        <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-left text-slate-400 dark:text-gray-500 border-b border-slate-100 dark:border-slate-800">
                <th className="px-3 py-1 font-medium">File</th>
                <th className="px-3 py-1 font-medium">Line</th>
                <th className="px-3 py-1 font-medium">Message</th>
              </tr>
            </thead>
            <tbody>
              {errors.map((e, i) => (
                <tr key={i} className="border-b border-slate-50 dark:border-slate-800/50 last:border-b-0">
                  <td className="px-3 py-1 font-mono text-[10px] text-slate-600 dark:text-gray-300">{e.file}</td>
                  <td className="px-3 py-1 text-slate-500 dark:text-gray-400">
                    {e.line}:{e.char}
                  </td>
                  <td className="px-3 py-1 text-amber-600 dark:text-amber-400">{e.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SetfilesSection({ setfiles }: { setfiles: SetfilesExec }) {
  const [errorsExpanded, setErrorsExpanded] = useState(false);

  return (
    <div>
      <SectionHeader title="Setfiles Execution" />
      <div className="border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 space-y-2">
        {/* Stats row */}
        <div className="flex items-center gap-3 flex-wrap">
          {setfiles.exitCode !== null && (
            <span
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium border ${
                setfiles.exitCode <= 1
                  ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300 border-green-200 dark:border-green-800'
                  : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800'
              }`}
            >
              exit {setfiles.exitCode}
            </span>
          )}
          {setfiles.durationSecs !== null && (
            <span className="text-[10px] text-slate-500 dark:text-gray-400">
              {setfiles.durationSecs.toFixed(2)}s
            </span>
          )}
          {setfiles.autorelabelRemoved && (
            <span className="text-[10px] text-slate-400 dark:text-gray-500 italic">
              .autorelabel removed
            </span>
          )}
          {setfiles.skippedBins.length > 0 && (
            <span className="text-[10px] text-slate-400 dark:text-gray-500">
              {setfiles.skippedBins.length} old .bin file{setfiles.skippedBins.length > 1 ? 's' : ''} skipped
            </span>
          )}
        </div>

        {/* Context errors */}
        {setfiles.contextErrors.length > 0 && (
          <div>
            <button
              onClick={() => setErrorsExpanded(!errorsExpanded)}
              className="flex items-center gap-1.5 text-[10px] text-amber-600 dark:text-amber-400 hover:text-amber-700 dark:hover:text-amber-300 transition-colors"
            >
              <svg
                className={`w-2.5 h-2.5 transition-transform ${errorsExpanded ? 'rotate-90' : ''}`}
                fill="none" viewBox="0 0 24 24" stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              {setfiles.contextErrors.length} file{setfiles.contextErrors.length > 1 ? 's' : ''} could not be relabelled
            </button>
            {errorsExpanded && (
              <div className="mt-1 pl-4 space-y-0.5">
                {setfiles.contextErrors.map((path, i) => (
                  <div key={i} className="font-mono text-[10px] text-slate-500 dark:text-gray-400">
                    {path}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

