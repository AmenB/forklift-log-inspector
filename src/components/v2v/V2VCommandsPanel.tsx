import { useState, useMemo, useCallback } from 'react';
import type { V2VApiCall, V2VGuestCommand } from '../../types/v2v';
import { LineLink } from './LineLink';
import { ExpandArrow } from '../common';

interface V2VCommandsPanelProps {
  apiCalls: V2VApiCall[];
}

/** Maximum number of API calls rendered at once to keep the UI responsive. */
const MAX_DISPLAYED_CALLS = 300;

const SOURCE_COLORS: Record<string, string> = {
  command: 'bg-cyan-100 dark:bg-cyan-900/30 text-cyan-700 dark:text-cyan-300',
  chroot: 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300',
  commandrvf: 'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300',
};

/** API functions that are hidden by default (noisy, high-volume, low-signal). */
const DEFAULT_HIDDEN: ReadonlySet<string> = new Set([
  'is_file',
  'is_dir',
  'is_symlink',
  'is_blockdev',
  'is_chardev',
  'exists',
  'stat',
  'lstat',
  'statvfs',
  'case_sensitive_path',
  'hivex_node_children',
  'hivex_node_get_child',
  'hivex_node_get_value',
  'hivex_node_values',
  'hivex_value_key',
  'hivex_value_type',
  'hivex_value_string',
  'hivex_value_value',
  'hivex_value_utf8',
  'c_pointer',
  'internal_feature_available',
]);

export function V2VCommandsPanel({ apiCalls }: V2VCommandsPanelProps) {
  const [filter, setFilter] = useState('');
  const [expandedApiIdx, setExpandedApiIdx] = useState<number | null>(null);
  const [expandedCmdKey, setExpandedCmdKey] = useState<string | null>(null);
  const [showOnlyWithCommands, setShowOnlyWithCommands] = useState(false);
  const [hiddenApis, setHiddenApis] = useState<Set<string>>(() => new Set(DEFAULT_HIDDEN));
  const [showHiddenManager, setShowHiddenManager] = useState(false);

  const toggleHidden = useCallback((name: string) => {
    setHiddenApis((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  }, []);

  const clearHidden = useCallback(() => setHiddenApis(new Set()), []);
  const resetHidden = useCallback(() => setHiddenApis(new Set(DEFAULT_HIDDEN)), []);

  // API call summary (counts per function name)
  const apiSummary = useMemo(() => {
    const counts = new Map<string, { total: number; withCmds: number }>();
    for (const call of apiCalls) {
      const entry = counts.get(call.name) || { total: 0, withCmds: 0 };
      entry.total++;
      if (call.guestCommands.length > 0) entry.withCmds++;
      counts.set(call.name, entry);
    }
    return [...counts.entries()].sort((a, b) => b[1].total - a[1].total);
  }, [apiCalls]);

  // How many calls are hidden
  const hiddenCount = useMemo(() => {
    let count = 0;
    for (const call of apiCalls) {
      if (hiddenApis.has(call.name)) count++;
    }
    return count;
  }, [apiCalls, hiddenApis]);

  // Filtered API calls
  const filtered = useMemo(() => {
    return apiCalls.filter((call) => {
      if (hiddenApis.has(call.name)) return false;
      if (showOnlyWithCommands && call.guestCommands.length === 0) return false;
      if (filter) {
        const lower = filter.toLowerCase();
        if (
          !call.name.toLowerCase().includes(lower) &&
          !call.args.toLowerCase().includes(lower) &&
          !call.guestCommands.some(
            (c) =>
              c.command.toLowerCase().includes(lower) ||
              c.args.join(' ').toLowerCase().includes(lower),
          )
        ) {
          return false;
        }
      }
      return true;
    });
  }, [apiCalls, filter, showOnlyWithCommands, hiddenApis]);

  const totalGuestCommands = useMemo(
    () => apiCalls.reduce((sum, call) => sum + call.guestCommands.length, 0),
    [apiCalls],
  );

  const handleApiClick = (idx: number, _call: V2VApiCall) => {
    if (expandedApiIdx === idx) {
      setExpandedApiIdx(null);
      setExpandedCmdKey(null);
    } else {
      setExpandedApiIdx(idx);
      setExpandedCmdKey(null);
    }
  };

  const handleCmdClick = (apiIdx: number, cmdIdx: number, _cmd: V2VGuestCommand) => {
    const key = `${apiIdx}-${cmdIdx}`;
    if (expandedCmdKey === key) {
      setExpandedCmdKey(null);
    } else {
      setExpandedCmdKey(key);
    }
  };

  return (
    <div className="space-y-3">
      {/* Summary badges */}
      <div className="flex items-center gap-3 text-xs text-slate-500 dark:text-gray-400">
        <span>
          {apiCalls.length} API calls, {totalGuestCommands} guest commands
        </span>
        {hiddenCount > 0 && (
          <button
            onClick={() => setShowHiddenManager(!showHiddenManager)}
            className="text-amber-600 dark:text-amber-400 hover:underline"
          >
            {hiddenApis.size} hidden ({hiddenCount.toLocaleString()} calls)
          </button>
        )}
      </div>

      {/* Hidden API manager */}
      {showHiddenManager && hiddenApis.size > 0 && (
        <div className="bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-800/50 rounded-lg p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-amber-700 dark:text-amber-300">
              Hidden API functions
            </span>
            <div className="flex gap-2">
              <button
                onClick={clearHidden}
                className="text-[10px] text-amber-600 dark:text-amber-400 hover:underline"
              >
                Show all
              </button>
              <button
                onClick={resetHidden}
                className="text-[10px] text-amber-600 dark:text-amber-400 hover:underline"
              >
                Reset defaults
              </button>
            </div>
          </div>
          <div className="flex flex-wrap gap-1">
            {[...hiddenApis].sort().map((name) => {
              const summary = apiSummary.find(([n]) => n === name);
              const count = summary ? summary[1].total : 0;
              return (
                <button
                  key={name}
                  onClick={() => toggleHidden(name)}
                  className="px-2 py-0.5 rounded text-[10px] font-mono bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 hover:bg-amber-200 dark:hover:bg-amber-800/40 transition-colors group/hidden"
                  title={`Click to unhide ${name}`}
                >
                  <span className="line-through opacity-70">{name}</span>
                  {count > 0 && <span className="opacity-50 ml-0.5">({count})</span>}
                  <span className="ml-1 opacity-0 group-hover/hidden:opacity-100">+</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Top API function summary -- click to filter, right-click to hide */}
      <div className="flex flex-wrap gap-1">
        {apiSummary
          .filter(([name]) => !hiddenApis.has(name))
          .slice(0, 25)
          .map(([name, { total, withCmds }]) => (
            <button
              key={name}
              onClick={() => setFilter(filter === name ? '' : name)}
              onContextMenu={(e) => {
                e.preventDefault();
                toggleHidden(name);
              }}
              title="Click to filter, right-click to hide"
              className={`px-2 py-0.5 rounded text-[10px] font-mono transition-colors group/badge
                ${
                  filter === name
                    ? 'bg-blue-500 text-white'
                    : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-gray-400 hover:bg-slate-200 dark:hover:bg-slate-700'
                }`}
            >
              {name}
              <span className="opacity-60 ml-0.5">
                ({total}
                {withCmds > 0 && `, ${withCmds} w/cmds`})
              </span>
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  toggleHidden(name);
                }}
                className="ml-1 opacity-0 group-hover/badge:opacity-60 hover:!opacity-100 text-red-500 cursor-pointer"
                title={`Hide ${name}`}
              >
                ×
              </span>
            </button>
          ))}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2">
        <input
          type="text"
          placeholder="Filter API calls or commands..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="flex-1 px-3 py-1.5 text-xs border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-800 text-slate-900 dark:text-gray-100 placeholder:text-slate-400"
        />
        <button
          onClick={() => setShowOnlyWithCommands(!showOnlyWithCommands)}
          className={`px-3 py-1.5 rounded-md text-[11px] font-medium transition-colors whitespace-nowrap
            ${
              showOnlyWithCommands
                ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300'
                : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-gray-400'
            }`}
        >
          {showOnlyWithCommands ? 'With commands' : 'All calls'}
        </button>
      </div>

      {/* Hierarchical API call list */}
      <div className="max-h-[600px] overflow-y-auto space-y-0.5">
        {filtered.slice(0, MAX_DISPLAYED_CALLS).map((call, idx) => {
          const isExpanded = expandedApiIdx === idx;
          const hasCmds = call.guestCommands.length > 0;

          return (
            <div key={idx} className="rounded-md overflow-hidden">
              {/* API call row */}
              <div
                onClick={() => handleApiClick(idx, call)}
                className={`
                  flex items-center gap-2 text-[11px] font-mono py-2 px-3 cursor-pointer group transition-colors
                  ${
                    isExpanded
                      ? 'bg-indigo-50 dark:bg-indigo-900/20 border-l-2 border-indigo-400 dark:border-indigo-500'
                      : 'hover:bg-slate-50 dark:hover:bg-slate-800 border-l-2 border-transparent'
                  }
                `}
              >
                {/* Expand indicator */}
                <span
                  className={`flex-shrink-0 text-[9px] ${hasCmds ? 'text-indigo-500 dark:text-indigo-400' : 'text-slate-300 dark:text-slate-600'}`}
                >
                  {hasCmds ? <ExpandArrow expanded={isExpanded} /> : '·'}
                </span>

                {/* Function name */}
                <span className="text-indigo-600 dark:text-indigo-400 font-semibold flex-shrink-0">
                  {call.name}
                </span>
                {call.handle && call.handle !== 'v2v' && (
                  <span className="text-[9px] px-1 py-0.5 rounded bg-violet-100 dark:bg-violet-900/30 text-violet-600 dark:text-violet-400 flex-shrink-0">
                    {call.handle}
                  </span>
                )}

                {/* Args (truncated) */}
                {call.args && (
                  <span className="text-slate-500 dark:text-gray-400 truncate flex-1 min-w-0">
                    {call.args.length > 60 ? call.args.slice(0, 57) + '...' : call.args}
                  </span>
                )}

                {/* Result badge */}
                {call.result && (
                  <span className="text-green-600 dark:text-green-400 text-[10px] flex-shrink-0 max-w-[200px] truncate">
                    = {call.result}
                  </span>
                )}

                {/* Duration */}
                {call.durationSecs !== undefined && (
                  <span className="text-amber-600 dark:text-amber-400 text-[10px] flex-shrink-0">
                    {call.durationSecs.toFixed(2)}s
                  </span>
                )}

                {/* Command count */}
                {hasCmds && (
                  <span className="text-[9px] text-cyan-600 dark:text-cyan-400 flex-shrink-0 font-sans font-medium">
                    {call.guestCommands.length} cmd{call.guestCommands.length !== 1 ? 's' : ''}
                  </span>
                )}

                {/* Line link */}
                <span className="flex-shrink-0 opacity-0 group-hover:opacity-100 ml-1">
                  <LineLink line={call.lineNumber} />
                </span>
              </div>

              {/* Expanded: nested guest commands */}
              {isExpanded && (
                <div className="bg-slate-50/50 dark:bg-slate-800/30 border-l-2 border-indigo-200 dark:border-indigo-800 ml-3">
                  {/* Full args / result */}
                  {(call.args || call.result) && (
                    <div className="px-4 py-2 text-[11px] font-mono space-y-1 border-b border-slate-100 dark:border-slate-700/50">
                      {call.args && (
                        <div>
                          <span className="text-slate-400 dark:text-gray-500">args: </span>
                          <span className="text-slate-700 dark:text-gray-300">{call.args}</span>
                        </div>
                      )}
                      {call.result && (
                        <div>
                          <span className="text-slate-400 dark:text-gray-500">result: </span>
                          <span className="text-green-600 dark:text-green-400">{call.result}</span>
                        </div>
                      )}
                      {call.durationSecs !== undefined && (
                        <div>
                          <span className="text-slate-400 dark:text-gray-500">duration: </span>
                          <span className="text-amber-600 dark:text-amber-400">
                            {call.durationSecs.toFixed(3)}s
                          </span>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Guest commands */}
                  {call.guestCommands.length > 0 ? (
                    <div className="py-1">
                      {call.guestCommands.map((cmd, cmdIdx) => {
                        const cmdKey = `${idx}-${cmdIdx}`;
                        const isCmdExpanded = expandedCmdKey === cmdKey;
                        const hasStdout = cmd.stdoutLines.length > 0;

                        return (
                          <div key={cmdIdx}>
                            <div
                              onClick={(e) => {
                                e.stopPropagation();
                                handleCmdClick(idx, cmdIdx, cmd);
                              }}
                              className={`
                                flex items-start gap-2 text-[11px] font-mono py-1.5 px-4 cursor-pointer group/cmd
                                ${
                                  isCmdExpanded
                                    ? 'bg-cyan-50 dark:bg-cyan-900/20'
                                    : 'hover:bg-white/50 dark:hover:bg-slate-700/30'
                                }
                              `}
                            >
                              {/* Stdout indicator */}
                              <span
                                className={`flex-shrink-0 text-[9px] mt-0.5 ${hasStdout ? 'text-cyan-500' : 'text-slate-300 dark:text-slate-600'}`}
                              >
                                {hasStdout ? <ExpandArrow expanded={isCmdExpanded} /> : '·'}
                              </span>

                              {/* Source badge */}
                              <span
                                className={`px-1.5 py-0.5 rounded text-[9px] font-sans font-medium flex-shrink-0 ${SOURCE_COLORS[cmd.source] || 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-gray-400'}`}
                              >
                                {cmd.source}
                              </span>

                              {/* Command name */}
                              <span className="text-cyan-600 dark:text-cyan-400 flex-shrink-0">
                                {cmd.command}
                              </span>

                              {/* Args */}
                              <span className="text-slate-500 dark:text-gray-400 truncate flex-1 min-w-0">
                                {cmd.args.join(' ')}
                              </span>

                              {/* Stdout line count */}
                              {hasStdout && (
                                <span className="text-[9px] text-green-600 dark:text-green-400 flex-shrink-0 font-sans">
                                  {cmd.stdoutLines.length} line
                                  {cmd.stdoutLines.length !== 1 ? 's' : ''}
                                </span>
                              )}

                              {/* Return code */}
                              {cmd.returnCode !== undefined && (
                                <span
                                  className={`flex-shrink-0 text-[10px] ${cmd.returnCode === 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}
                                >
                                  rc={cmd.returnCode}
                                </span>
                              )}

                              {/* Line link */}
                              <span className="flex-shrink-0 opacity-0 group-hover/cmd:opacity-100">
                                <LineLink line={cmd.lineNumber} />
                              </span>
                            </div>

                            {/* Expanded stdout */}
                            {isCmdExpanded && hasStdout && (
                              <div className="ml-8 mr-4 mt-1 mb-2">
                                <div className="text-[10px] text-green-700 dark:text-green-400 font-medium mb-1">
                                  stdout:
                                </div>
                                <pre className="text-[11px] font-mono bg-slate-900 dark:bg-black text-green-400 p-3 rounded overflow-x-auto max-h-48 overflow-y-auto leading-relaxed">
                                  {cmd.stdoutLines.join('\n')}
                                </pre>
                              </div>
                            )}

                            {/* Expanded with no stdout */}
                            {isCmdExpanded && !hasStdout && (
                              <div className="ml-8 mr-4 mt-1 mb-2">
                                <div className="text-[10px] text-slate-400 dark:text-gray-500 italic">
                                  No stdout captured.
                                </div>
                                {cmd.args.length > 0 && (
                                  <pre className="mt-1 text-[11px] font-mono bg-slate-50 dark:bg-slate-900 text-slate-700 dark:text-gray-300 p-2 rounded overflow-x-auto">
                                    {cmd.command} {cmd.args.join(' ')}
                                  </pre>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="px-4 py-3 text-[11px] text-slate-400 dark:text-gray-500 italic">
                      No guest commands executed for this API call.
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {filtered.length > 300 && (
          <div className="text-xs text-slate-400 dark:text-gray-500 px-2 py-1">
            ... {filtered.length - 300} more API calls
          </div>
        )}
        {filtered.length === 0 && (
          <p className="text-xs text-slate-400 dark:text-gray-500 italic px-2 py-2">
            No API calls match the current filter.
          </p>
        )}
      </div>
    </div>
  );
}
