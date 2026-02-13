import { useState, useCallback } from 'react';
import { useSummary, useStore } from '../store/useStore';
import { useV2VStore } from '../store/useV2VStore';
import { Modal } from './common';

export function StatsBar() {
  const summary = useSummary();
  const v2vFileEntries = useV2VStore((s) => s.v2vFileEntries);
  const [showV2VModal, setShowV2VModal] = useState(false);

  const v2vCount = v2vFileEntries.length;

  const stats = [
    { label: 'Total Plans', value: summary.totalPlans, color: 'text-slate-900 dark:text-gray-100' },
    { label: 'Running', value: summary.running, color: 'text-blue-600 dark:text-blue-400' },
    { label: 'Succeeded', value: summary.succeeded, color: 'text-green-600 dark:text-green-400' },
    { label: 'Failed', value: summary.failed, color: 'text-red-600 dark:text-red-400' },
    { label: 'Archived', value: summary.archived, color: 'text-slate-500 dark:text-gray-400' },
  ];

  const gridCols = v2vCount > 0
    ? 'grid-cols-2 sm:grid-cols-3 md:grid-cols-6'
    : 'grid-cols-2 sm:grid-cols-3 md:grid-cols-5';

  return (
    <div className="max-w-7xl mx-auto px-6 py-4">
      <div className={`grid ${gridCols} gap-4`}>
        {stats.map((stat) => (
          <div
            key={stat.label}
            className="bg-slate-100 dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-4 text-center"
          >
            <div className={`text-2xl font-bold ${stat.color}`}>
              {stat.value}
            </div>
            <div className="text-sm text-slate-500 dark:text-gray-400 mt-1">
              {stat.label}
            </div>
          </div>
        ))}

        {v2vCount > 0 && (
          <button
            onClick={() => setShowV2VModal(true)}
            className="bg-purple-50 dark:bg-purple-500/10 rounded-xl border border-purple-200 dark:border-purple-500/30
                       p-4 text-center hover:bg-purple-100 dark:hover:bg-purple-500/20 transition-colors cursor-pointer"
          >
            <div className="text-2xl font-bold text-purple-600 dark:text-purple-400">
              {v2vCount}
            </div>
            <div className="text-sm text-purple-500 dark:text-purple-400 mt-1">
              V2V Logs
            </div>
          </button>
        )}
      </div>

      {showV2VModal && v2vCount > 0 && (
        <V2VLogsModal onClose={() => setShowV2VModal(false)} />
      )}
    </div>
  );
}

// ── V2V Logs Modal ────────────────────────────────────────────────────────

/** Extract a short display name from a long archive path */
function shortenPath(path: string): string {
  // Show the last meaningful parts: e.g. ".../pods/planName-vm-NNNN-suffix/.../current.log"
  const parts = path.split('/');
  if (parts.length <= 4) return path;
  return '…/' + parts.slice(-4).join('/');
}

function V2VLogsModal({ onClose }: { onClose: () => void }) {
  const v2vFileEntries = useV2VStore((s) => s.v2vFileEntries);
  const plans = useStore((s) => s.plans);
  const setViewMode = useStore((s) => s.setViewMode);

  const handleViewAnalysis = useCallback((fileIndex: number) => {
    useV2VStore.getState().setSelectedFile(fileIndex);
    if (plans.length > 0) {
      setViewMode('v2v');
    }
    onClose();
  }, [plans.length, setViewMode, onClose]);

  return (
    <Modal isOpen onClose={onClose} title="V2V Logs Found in Archive" maxWidth="lg">
      <div className="p-4 space-y-2 max-h-[60vh] overflow-y-auto">
        {v2vFileEntries.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-gray-400 text-center py-4">
            No V2V log files found.
          </p>
        ) : (
          v2vFileEntries.map((entry, idx) => {
            const totalRuns = entry.data.toolRuns.length;
            const hasError = entry.data.toolRuns.some((r) => r.exitStatus === 'error');
            const hasSuccess = entry.data.toolRuns.some((r) => r.exitStatus === 'success');

            return (
              <div
                key={idx}
                className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-700/50 rounded-lg border border-slate-200 dark:border-slate-600 gap-3"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                    hasError ? 'bg-red-500' :
                    hasSuccess ? 'bg-green-500' :
                    'bg-slate-400'
                  }`} />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="font-medium text-slate-900 dark:text-gray-100 truncate">
                        {entry.planName ?? 'Unknown plan'}
                      </span>
                      <span className="text-slate-400 dark:text-gray-500">·</span>
                      <span className="text-slate-600 dark:text-gray-300">
                        {entry.vmId ?? 'Unknown VM'}
                      </span>
                    </div>
                    <div className="text-xs font-mono text-slate-400 dark:text-gray-500 truncate mt-0.5" title={entry.filePath}>
                      {shortenPath(entry.filePath)}
                    </div>
                    <div className="text-xs text-slate-400 dark:text-gray-500 mt-0.5">
                      {totalRuns} tool run{totalRuns !== 1 ? 's' : ''}
                      {' · '}
                      {entry.data.totalLines.toLocaleString()} lines
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => handleViewAnalysis(idx)}
                  className="px-3 py-1 rounded-lg text-xs font-medium
                    bg-purple-50 dark:bg-purple-500/10 hover:bg-purple-100 dark:hover:bg-purple-500/20
                    text-purple-600 dark:text-purple-400 transition-colors flex-shrink-0"
                >
                  View Analysis
                </button>
              </div>
            );
          })
        )}
      </div>
    </Modal>
  );
}
