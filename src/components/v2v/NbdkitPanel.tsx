import { useState } from 'react';
import type { NbdkitConnection } from '../../types/v2v';
import { LineLink } from './LineLink';

interface NbdkitPanelProps {
  connections: NbdkitConnection[];
}

export function NbdkitPanel({ connections }: NbdkitPanelProps) {
  if (connections.length === 0) {
    return (
      <p className="text-sm text-slate-500 dark:text-gray-400 italic">
        No NBDKIT connections found.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {connections.map((conn, idx) => (
        <NbdkitCard key={conn.id || idx} connection={conn} index={idx} />
      ))}
    </div>
  );
}

function NbdkitCard({ connection, index }: { connection: NbdkitConnection; index: number }) {
  const [showLogs, setShowLogs] = useState(false);

  // Derive a short name from socket path (e.g. in0, in1, in2)
  const socketName = connection.socketPath.match(/\/(in\d+)$/)?.[1] || `disk-${index}`;

  return (
    <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-purple-50 dark:bg-purple-900/20">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-purple-700 dark:text-purple-300">
            {socketName}
          </span>
          <span className="text-xs text-slate-500 dark:text-gray-400 font-mono">
            {connection.plugin || 'unknown'} plugin
          </span>
        </div>
        <LineLink
          line={connection.startLine}
          label={`Lines ${connection.startLine + 1}–${connection.endLine + 1}`}
        />
      </div>

      {/* Details */}
      <div className="px-4 py-3 space-y-2">
        <DetailRow label="Socket" value={connection.socketPath} mono />
        {connection.uri && <DetailRow label="NBD URI" value={connection.uri} mono />}
        {connection.diskFile && <DetailRow label="Disk File" value={connection.diskFile} />}
        {connection.filters.length > 0 && (
          <DetailRow label="Filters" value={connection.filters.join(' → ')} />
        )}
        <DetailRow label="Log Lines" value={`${connection.logLines.length}`} />

        {/* Toggle log lines */}
        {connection.logLines.length > 0 && (
          <div>
            <button
              onClick={() => setShowLogs(!showLogs)}
              className="text-xs text-purple-600 dark:text-purple-400 hover:underline"
            >
              {showLogs ? 'Hide' : 'Show'} log lines ({connection.logLines.length})
            </button>
            {showLogs && (
              <pre className="mt-2 text-[11px] font-mono bg-slate-50 dark:bg-slate-900 p-3 rounded overflow-x-auto max-h-64 overflow-y-auto text-slate-700 dark:text-gray-300 leading-relaxed">
                {connection.logLines.slice(0, 200).join('\n')}
                {connection.logLines.length > 200 && `\n... (${connection.logLines.length - 200} more lines)`}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start gap-2 text-xs">
      <span className="text-slate-500 dark:text-gray-400 min-w-[80px] flex-shrink-0">{label}:</span>
      <span
        className={`text-slate-700 dark:text-gray-300 break-all ${mono ? 'font-mono' : ''}`}
      >
        {value}
      </span>
    </div>
  );
}
