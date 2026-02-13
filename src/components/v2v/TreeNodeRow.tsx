/**
 * Recursive tree row — renders a single node in the file tree.
 *
 * Handles directory expansion, leaf detail expansion, status badges,
 * augeas operation badges, and SELinux relabel context changes.
 */
import { useState, useMemo, useCallback, useEffect, useRef, useContext } from 'react';
import { LineLink } from './LineLink';
import { formatBytes } from '../../utils/format';
import { OriginBadge } from './shared';
import { ExpandArrow } from '../common';
import { FileTreeNavContext } from './fileTreeTypes';
import type { TreeNode } from './fileTreeTypes';
import { isCheckFound, countStats, isDirectory } from './fileTreeHelpers';
import { CopySourceRow } from './CopySourceRow';
import { AugeasOpRow } from './AugeasOpRow';
import { InlineContextChange } from './InlineContextChange';

export function TreeNodeRow({ node, depth }: { node: TreeNode; depth: number }) {
  const isDir = isDirectory(node);
  const [expanded, setExpanded] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const stats = useMemo(() => countStats(node), [node]);
  const nodeRef = useRef<HTMLDivElement>(null);
  const { focusedPath, focusedVersion } = useContext(FileTreeNavContext);

  // Is this node on the path to the focused file?
  const isOnFocusedPath =
    focusedPath !== null &&
    isDir &&
    (focusedPath.startsWith(node.path + '/') || focusedPath === node.path);

  // Is this node the exact focused target?
  const isFocusedTarget = focusedPath !== null && focusedPath === node.path && !isDir;

  // Auto-expand directory nodes along the focused path
  useEffect(() => {
    if (isOnFocusedPath) setExpanded(true);
  }, [isOnFocusedPath, focusedVersion]);

  // Scroll the focused leaf into view
  useEffect(() => {
    if (isFocusedTarget && nodeRef.current) {
      requestAnimationFrame(() => {
        nodeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }
  }, [isFocusedTarget, focusedVersion]);

  const toggle = useCallback(() => setExpanded((prev) => !prev), []);

  const hasChecks = node.checks.length > 0;
  const hasOps = node.ops.length > 0;
  const copyOps = node.ops.filter((op) => op.type === 'copy');
  const augOps = node.ops.filter((op) => op.type === 'augeas');
  const relabelOps = node.ops.filter((op) => op.type === 'relabel');
  const hasCopyOps = copyOps.length > 0;
  const hasAugOps = augOps.length > 0;
  const hasRelabelOps = relabelOps.length > 0;
  const isFound = node.checks.some(isCheckFound);
  const scriptOp = copyOps.find((op) => op.content !== null);
  // Any copied file, augeas config file, or relabelled file is expandable (if it has details to show)
  const isExpandableLeaf = !isDir && (hasCopyOps || hasAugOps);

  const sortedChildren = useMemo(() => {
    return [...node.children.values()].sort((a, b) => {
      const aDir = isDirectory(a);
      const bDir = isDirectory(b);
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [node]);

  // Determine leaf icon and status
  let leafIcon: React.ReactNode = null;
  let statusBadge: React.ReactNode = null;

  if (!isDir) {
    if (hasRelabelOps && !hasCopyOps && !hasAugOps && !hasChecks) {
      // Pure relabel node
      leafIcon = <span className="text-indigo-500">📄</span>;
    } else if (hasAugOps && !hasCopyOps && !hasChecks && !hasRelabelOps) {
      // Pure augeas config file node
      leafIcon = <span className="text-violet-500">⚙</span>;
    } else if (hasOps && hasChecks) {
      leafIcon = <span className="text-blue-500">📄</span>;
      statusBadge = (
        <span className={`text-[9px] flex-shrink-0 ${isFound ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400'}`}>
          {isFound ? '✓' : '✗'}
        </span>
      );
    } else if (hasOps) {
      leafIcon = <span className="text-blue-500">📄</span>;
    } else if (hasChecks) {
      leafIcon = (
        <span className={isFound ? 'text-green-500' : 'text-red-400 opacity-50'}>
          📄
        </span>
      );
      statusBadge = (
        <span className={`text-[9px] flex-shrink-0 ${isFound ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400'}`}>
          {isFound ? '✓' : '✗'}
        </span>
      );
    }
  }

  return (
    <div ref={nodeRef}>
      <div
        role={isDir || isExpandableLeaf ? 'button' : undefined}
        tabIndex={isDir || isExpandableLeaf ? 0 : undefined}
        aria-expanded={isDir ? expanded : isExpandableLeaf ? showDetails : undefined}
        onClick={isDir ? toggle : isExpandableLeaf ? () => setShowDetails(!showDetails) : undefined}
        onKeyDown={isDir || isExpandableLeaf ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (isDir) { toggle(); } else { setShowDetails((prev) => !prev); } } } : undefined}
        style={{ paddingLeft: `${depth * 16 + 4}px` }}
        className={`
          flex items-center gap-1.5 py-0.5 rounded transition-colors duration-700
          ${isDir || isExpandableLeaf ? 'cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800' : ''}
          ${isFocusedTarget ? 'bg-purple-100 dark:bg-purple-900/40 ring-1 ring-purple-400 dark:ring-purple-600' : ''}
        `}
      >
        {isDir ? (
          <ExpandArrow expanded={expanded} className="text-[9px] text-indigo-500 dark:text-indigo-400 w-3 text-center flex-shrink-0" />
        ) : isExpandableLeaf ? (
          <ExpandArrow expanded={showDetails} className="text-[9px] text-slate-400 w-3 text-center flex-shrink-0" />
        ) : (
          <span className="w-3 flex-shrink-0" />
        )}

        <span className="flex-shrink-0 text-[10px]">
          {isDir ? (
            <span className="text-amber-500 dark:text-amber-400">
              {expanded ? '📂' : '📁'}
            </span>
          ) : (
            leafIcon
          )}
        </span>

        <span
          className={`flex-shrink-0 ${
            isDir
              ? 'text-slate-800 dark:text-gray-200 font-medium'
              : hasChecks && !isFound && !hasOps
                ? 'text-slate-400 dark:text-gray-600 line-through'
                : 'text-slate-700 dark:text-gray-300'
          }`}
        >
          {node.name}
          {isDir && '/'}
        </span>

        {/* Status badge for checks */}
        {!isDir && statusBadge}

        {/* Check API name if not is_file */}
        {!isDir && hasChecks && node.checks.some((c) => c.api !== 'is_file') && (
          <span className="text-[9px] text-slate-400 dark:text-gray-600">
            {node.checks.find((c) => c.api !== 'is_file')?.api}
          </span>
        )}

        {/* Origin badges for file copies */}
        {!isDir && hasCopyOps && copyOps.map((op, i) => (
          <OriginBadge key={i} origin={op.origin} />
        ))}

        {/* Augeas operation count badges */}
        {!isDir && hasAugOps && (() => {
          const gets = augOps.filter((o) => o.augOp === 'get').length;
          const sets = augOps.filter((o) => o.augOp === 'set').length;
          const rms = augOps.filter((o) => o.augOp === 'rm').length;
          const matches = augOps.filter((o) => o.augOp === 'match').length;
          const clears = augOps.filter((o) => o.augOp === 'clear').length;
          const lss = augOps.filter((o) => o.augOp === 'ls').length;
          return (
            <>
              {gets > 0 && <span className="text-[8px] px-1 py-0 rounded bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 flex-shrink-0">{gets} GET</span>}
              {sets > 0 && <span className="text-[8px] px-1 py-0 rounded bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400 flex-shrink-0">{sets} SET</span>}
              {clears > 0 && <span className="text-[8px] px-1 py-0 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 flex-shrink-0">{clears} CLEAR</span>}
              {rms > 0 && <span className="text-[8px] px-1 py-0 rounded bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 flex-shrink-0">{rms} RM</span>}
              {matches > 0 && <span className="text-[8px] px-1 py-0 rounded bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-400 flex-shrink-0">{matches} MATCH</span>}
              {lss > 0 && <span className="text-[8px] px-1 py-0 rounded bg-sky-100 dark:bg-sky-900/30 text-sky-700 dark:text-sky-400 flex-shrink-0">{lss} LS</span>}
            </>
          );
        })()}

        {/* SELinux relabel context change (inline) */}
        {!isDir && hasRelabelOps && relabelOps.length === 1 && (
          <InlineContextChange fromContext={relabelOps[0].fromContext ?? ''} toContext={relabelOps[0].toContext ?? ''} />
        )}

        {/* File size */}
        {!isDir && hasCopyOps && (() => {
          const sz = copyOps.find((op) => op.sizeBytes !== null)?.sizeBytes;
          return sz != null ? (
            <span className="text-[9px] text-green-600 dark:text-green-400 flex-shrink-0">
              {formatBytes(sz)}
            </span>
          ) : null;
        })()}

        {/* Line link */}
        {!isDir && (hasChecks || hasOps) && (
          <LineLink line={(node.checks[0] || node.ops[0])?.lineNumber ?? 0} />
        )}

        {/* Directory stats */}
        {isDir && (
          <span className="text-[9px] text-slate-400 dark:text-gray-500 ml-1">
            {stats.totalEntries} {stats.totalEntries !== 1 ? 'entries' : 'entry'}
            {stats.found > 0 && (
              <span className="text-green-600 dark:text-green-400 ml-1">
                {stats.found} found
              </span>
            )}
            {stats.notFound > 0 && (
              <span className="text-red-500 dark:text-red-400 ml-1">
                {stats.notFound} missing
              </span>
            )}
            {stats.copies > 0 && (
              <span className="text-blue-500 dark:text-blue-400 ml-1">
                {stats.copies} copied
              </span>
            )}
            {stats.scripts > 0 && (
              <span className="text-teal-500 dark:text-teal-400 ml-1">
                {stats.scripts} {stats.scripts === 1 ? 'script' : 'scripts'}
              </span>
            )}
            {stats.augeas > 0 && (
              <span className="text-violet-500 dark:text-violet-400 ml-1">
                {stats.augeas} config ops
              </span>
            )}
            {stats.relabels > 0 && (
              <span className="text-indigo-500 dark:text-indigo-400 ml-1">
                {stats.relabels} relabelled
              </span>
            )}
          </span>
        )}
      </div>

      {/* Expandable details for copied files and augeas ops */}
      {!isDir && showDetails && (hasCopyOps || hasAugOps) && (
        <div style={{ paddingLeft: `${depth * 16 + 24}px` }} className="py-1 pr-2">
          <div className="rounded-md border border-slate-200 dark:border-slate-700 overflow-hidden text-[11px]">
            {/* Source info for each copy operation */}
            {copyOps.map((op, i) => (
              <CopySourceRow key={`copy-${i}`} op={op} />
            ))}

            {/* Script content (if any) */}
            {scriptOp && (
              <>
                <div className="flex items-center justify-between px-3 py-1.5 bg-slate-50 dark:bg-slate-800/50 border-t border-slate-200 dark:border-slate-700">
                  <span className="font-medium text-slate-600 dark:text-gray-300">
                    Content
                  </span>
                  {scriptOp.contentTruncated && (
                    <span className="text-[10px] text-amber-600 dark:text-amber-400 italic">
                      truncated
                      {scriptOp.sizeBytes !== null && ` (full: ${formatBytes(scriptOp.sizeBytes)})`}
                    </span>
                  )}
                </div>
                <pre className="px-3 py-2 leading-relaxed font-mono text-slate-800 dark:text-gray-200 bg-white dark:bg-slate-900 overflow-x-auto max-h-[300px] overflow-y-auto whitespace-pre-wrap break-words">
                  {scriptOp.content}
                </pre>
              </>
            )}

            {/* Augeas operations */}
            {hasAugOps && (
              <div className={hasCopyOps || scriptOp ? 'border-t border-slate-200 dark:border-slate-700' : ''}>
                {augOps.map((op, i) => (
                  <AugeasOpRow key={`aug-${i}`} op={op} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Directory children */}
      {isDir && expanded && (
        <div>
          {sortedChildren.map((child) => (
            <TreeNodeRow key={child.path} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}
