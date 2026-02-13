/**
 * Copy source row — shows where a file was copied from.
 */
import { useContext } from 'react';
import { LineLink } from './LineLink';
import { formatBytes } from '../../utils/format';
import { OriginBadge } from './shared';
import { FileTreeNavContext } from './fileTreeTypes';
import type { FileOp } from './fileTreeTypes';

export function CopySourceRow({ op }: { op: FileOp }) {
  const { navigateToIsoFile } = useContext(FileTreeNavContext);

  const isVirtioWin = op.origin === 'virtio_win';
  // VirtIO Win ISO paths look like ///Balloon/2k19/amd64/balloon.sys
  // Clean it for display
  const displaySource = isVirtioWin
    ? op.source.replace(/^\/\/\//, 'ISO: /')
    : op.source;

  return (
    <div className="flex items-baseline gap-2 px-3 py-1.5 bg-slate-50 dark:bg-slate-800/50">
      <span className="text-slate-400 dark:text-gray-500 flex-shrink-0">from</span>
      <OriginBadge origin={op.origin} />
      {isVirtioWin ? (
        <button
          onClick={(e) => {
            e.stopPropagation();
            navigateToIsoFile(op.source);
          }}
          className="font-mono text-purple-600 dark:text-purple-400 hover:text-purple-800 dark:hover:text-purple-300 hover:underline cursor-pointer truncate"
          title={`Navigate to ${op.source.replace(/^\/+/, '')} in VirtIO Win ISO tree`}
        >
          {displaySource}
        </button>
      ) : (
        <span className="font-mono text-slate-600 dark:text-gray-300 truncate" title={op.source}>
          {displaySource}
        </span>
      )}
      {op.sizeBytes !== null && (
        <span className="text-green-600 dark:text-green-400 flex-shrink-0 ml-auto">
          {formatBytes(op.sizeBytes)}
        </span>
      )}
      <span className="flex-shrink-0">
        <LineLink line={op.lineNumber} />
      </span>
    </div>
  );
}
