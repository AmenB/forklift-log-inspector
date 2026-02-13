/**
 * DeviceTree — renders a single device (disk/ISO) as an expandable file tree.
 */
import { useState, useMemo, useEffect, useContext } from 'react';
import type { V2VApiCall, V2VFileCopy } from '../../types/v2v';
import type { RelabeledFile } from '../../parser/v2v';
import { LineLink } from './LineLink';
import { ExpandArrow } from '../common';
import { useDevMode } from '../../store/useStore';
import { FileTreeNavContext } from './fileTreeTypes';
import { buildTree, countStats, isDirectory } from './fileTreeHelpers';
import { TreeNodeRow } from './TreeNodeRow';

export function DeviceTree({
  checks,
  fileCopies,
  relabeledFiles,
  primaryLabel,
  secondaryLabel,
  passLabel,
  icon = '💾',
  isIsoTree = false,
  defaultExpanded = false,
  mountLineNumber,
}: {
  checks: V2VApiCall[];
  fileCopies: V2VFileCopy[];
  relabeledFiles?: RelabeledFile[];
  primaryLabel: string;
  secondaryLabel: string;
  /** e.g. "(pass 2)" — shown next to device path in a distinct color */
  passLabel?: string;
  icon?: string;
  /** If true, this tree participates in cross-tree ISO navigation */
  isIsoTree?: boolean;
  /** If true, the tree starts expanded */
  defaultExpanded?: boolean;
  /** Line number of the mount API call, for navigation */
  mountLineNumber?: number;
}) {
  const devMode = useDevMode();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const tree = useMemo(() => buildTree(checks, fileCopies, relabeledFiles), [checks, fileCopies, relabeledFiles]);
  const stats = useMemo(() => countStats(tree), [tree]);
  const { focusedPath, focusedVersion } = useContext(FileTreeNavContext);

  // Auto-expand this device tree when a focused ISO path targets it
  useEffect(() => {
    if (isIsoTree && focusedPath) {
      setExpanded(true);
    }
  }, [isIsoTree, focusedPath, focusedVersion]);

  if (stats.totalEntries === 0) return null;

  return (
    <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
      <div
        onClick={() => setExpanded(!expanded)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(!expanded); } }}
        aria-expanded={expanded}
        className="w-full flex items-center gap-3 px-4 py-2.5 bg-slate-50 dark:bg-slate-800/50 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors text-left cursor-pointer"
      >
        <ExpandArrow expanded={expanded} className="text-[10px] text-indigo-500 dark:text-indigo-400 flex-shrink-0" />
        <span className="text-sm">{icon}</span>
        <span className="text-xs font-semibold text-slate-800 dark:text-gray-200">
          {primaryLabel}
        </span>
        {secondaryLabel && (
          <span className="text-[10px] font-mono text-slate-400 dark:text-gray-500">
            {secondaryLabel}
          </span>
        )}
        {devMode && passLabel && (
          <span className="text-[10px] font-medium text-amber-600 dark:text-amber-400">
            {passLabel}
          </span>
        )}

        <span className="ml-auto flex items-center gap-3 text-[10px]">
          <span className="text-slate-500 dark:text-gray-400">
            {stats.totalEntries.toLocaleString()} {stats.totalEntries === 1 ? 'entry' : 'entries'}
          </span>
          {stats.found > 0 && (
            <span className="text-green-600 dark:text-green-400">
              {stats.found.toLocaleString()} found
            </span>
          )}
          {stats.notFound > 0 && (
            <span className="text-red-500 dark:text-red-400">
              {stats.notFound.toLocaleString()} missing
            </span>
          )}
          {stats.copies > 0 && (
            <span className="text-blue-500 dark:text-blue-400">
              {stats.copies.toLocaleString()} copied
            </span>
          )}
          {stats.scripts > 0 && (
            <span className="text-teal-500 dark:text-teal-400">
              {stats.scripts.toLocaleString()} {stats.scripts === 1 ? 'script' : 'scripts'}
            </span>
          )}
          {stats.augeas > 0 && (
            <span className="text-violet-500 dark:text-violet-400">
              {stats.augeas.toLocaleString()} config ops
            </span>
          )}
          {stats.relabels > 0 && (
            <span className="text-indigo-500 dark:text-indigo-400">
              {stats.relabels.toLocaleString()} relabelled
            </span>
          )}
          {mountLineNumber !== undefined && (
            <span onClick={(e) => e.stopPropagation()}>
              <LineLink line={mountLineNumber} />
            </span>
          )}
        </span>
      </div>

      {expanded && (
        <div className="max-h-[500px] overflow-y-auto font-mono text-[11px] py-1 px-2">
          {[...tree.children.values()]
            .sort((a, b) => {
              const aDir = isDirectory(a);
              const bDir = isDirectory(b);
              if (aDir !== bDir) return aDir ? -1 : 1;
              return a.name.localeCompare(b.name);
            })
            .map((child) => (
              <TreeNodeRow key={child.path} node={child} depth={0} />
            ))}
          {tree.children.size === 0 && (
            <div className="text-[11px] text-slate-400 dark:text-gray-500 italic px-2 py-2">
              No file tree entries.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
