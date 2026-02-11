import { useMemo, useState } from 'react';
import type { V2VPipelineStage, V2VApiCall } from '../../types/v2v';
import { LineLink } from './LineLink';
import { formatDuration } from '../../utils/format';

interface PerformancePanelProps {
  stages: V2VPipelineStage[];
  apiCalls: V2VApiCall[];
}

interface StageTiming {
  name: string;
  durationSecs: number;
  startSecs: number;
  lineNumber: number;
}

const TOP_N = 20;

export function PerformancePanel({ stages, apiCalls }: PerformancePanelProps) {
  const [showAllApi, setShowAllApi] = useState(false);

  const stageTimings = useMemo<StageTiming[]>(() => {
    if (stages.length < 2) return [];
    const timings: StageTiming[] = [];
    for (let i = 0; i < stages.length - 1; i++) {
      timings.push({
        name: stages[i].name,
        durationSecs: +(stages[i + 1].elapsedSeconds - stages[i].elapsedSeconds).toFixed(1),
        startSecs: stages[i].elapsedSeconds,
        lineNumber: stages[i].lineNumber,
      });
    }
    // Last stage has no end — show elapsed so far
    const last = stages[stages.length - 1];
    timings.push({
      name: last.name,
      durationSecs: 0,
      startSecs: last.elapsedSeconds,
      lineNumber: last.lineNumber,
    });
    return timings;
  }, [stages]);

  const maxStageDuration = useMemo(
    () => Math.max(...stageTimings.map((s) => s.durationSecs), 1),
    [stageTimings],
  );

  const slowestApis = useMemo(() => {
    return [...apiCalls]
      .filter((c) => c.durationSecs !== undefined && c.durationSecs > 0)
      .sort((a, b) => (b.durationSecs ?? 0) - (a.durationSecs ?? 0));
  }, [apiCalls]);

  const displayedApis = showAllApi ? slowestApis : slowestApis.slice(0, TOP_N);

  const totalDuration = stages.length >= 2
    ? stages[stages.length - 1].elapsedSeconds - stages[0].elapsedSeconds
    : 0;

  return (
    <div className="space-y-6">
      {/* Stage timings */}
      {stageTimings.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-xs font-semibold text-slate-600 dark:text-gray-400 uppercase tracking-wider">
              Stage Durations
            </h4>
            {totalDuration > 0 && (
              <span className="text-xs text-slate-500 dark:text-gray-400">
                Total: {formatDuration(totalDuration)}
              </span>
            )}
          </div>
          <div className="space-y-1">
            {stageTimings.map((stage, idx) => (
              <div key={idx} className="flex items-center gap-2 text-[11px] group">
                <span className="w-[200px] text-slate-700 dark:text-gray-300 truncate flex-shrink-0" title={stage.name}>
                  {stage.name}
                </span>
                <div className="flex-1 h-4 bg-slate-100 dark:bg-slate-800 rounded overflow-hidden">
                  {stage.durationSecs > 0 && (
                    <div
                      className={`h-full rounded transition-all ${
                        stage.durationSecs / maxStageDuration > 0.5
                          ? 'bg-orange-400 dark:bg-orange-500'
                          : stage.durationSecs > 1
                            ? 'bg-blue-400 dark:bg-blue-500'
                            : 'bg-blue-300 dark:bg-blue-600'
                      }`}
                      style={{ width: `${Math.max(1, (stage.durationSecs / maxStageDuration) * 100)}%` }}
                    />
                  )}
                </div>
                <span className="w-16 text-right font-mono text-slate-500 dark:text-gray-400 flex-shrink-0">
                  {stage.durationSecs > 0 ? formatDuration(stage.durationSecs) : '--'}
                </span>
                <LineLink line={stage.lineNumber} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Slowest API calls */}
      {slowestApis.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-xs font-semibold text-slate-600 dark:text-gray-400 uppercase tracking-wider">
              Slowest API Calls
            </h4>
            <span className="text-xs text-slate-500 dark:text-gray-400">
              {slowestApis.length} with timing data
            </span>
          </div>
          <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="bg-slate-50 dark:bg-slate-800/50 text-slate-500 dark:text-gray-400">
                  <th className="px-3 py-1.5 text-left font-medium">#</th>
                  <th className="px-3 py-1.5 text-left font-medium">API Call</th>
                  <th className="px-3 py-1.5 text-left font-medium">Handle</th>
                  <th className="px-3 py-1.5 text-right font-medium">Duration</th>
                  <th className="px-3 py-1.5 text-right font-medium">Line</th>
                </tr>
              </thead>
              <tbody>
                {displayedApis.map((call, idx) => (
                  <tr
                    key={`${call.lineNumber}-${idx}`}
                    className={`border-t border-slate-100 dark:border-slate-800 ${
                      (call.durationSecs ?? 0) > 1
                        ? 'bg-orange-50/50 dark:bg-orange-900/10'
                        : ''
                    }`}
                  >
                    <td className="px-3 py-1 text-slate-400 dark:text-gray-500">{idx + 1}</td>
                    <td className="px-3 py-1 font-mono text-slate-700 dark:text-gray-300">
                      {call.name}
                      {call.args && (
                        <span className="text-slate-400 dark:text-gray-500 ml-1">
                          {call.args.length > 60 ? call.args.slice(0, 60) + '...' : call.args}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1 text-slate-500 dark:text-gray-400">{call.handle}</td>
                    <td className="px-3 py-1 text-right font-mono font-medium text-slate-700 dark:text-gray-300">
                      {formatDuration(call.durationSecs ?? 0)}
                    </td>
                    <td className="px-3 py-1 text-right">
                      <LineLink line={call.lineNumber} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {slowestApis.length > TOP_N && (
            <button
              onClick={() => setShowAllApi(!showAllApi)}
              className="mt-2 text-xs text-blue-600 dark:text-blue-400 hover:underline"
            >
              {showAllApi ? 'Show top 20' : `Show all ${slowestApis.length}`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

