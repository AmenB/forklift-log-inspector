/**
 * Shared virtualized log viewer with search.
 *
 * Used by both RawLogWithSearch (in V2VPipelineView) and V2VRawLogViewer.
 * Provides virtual scrolling, debounced search, match navigation, and
 * configurable row rendering.
 */
import { useMemo, useState, useEffect, useCallback, useRef, memo } from 'react';
import { highlightSearch } from './shared';

// ── Configuration ────────────────────────────────────────────────────────────

export interface VirtualizedLogViewerConfig {
  /** Row height in pixels (default 18) */
  rowHeight?: number;
  /** Extra rows rendered above/below viewport (default 30) */
  overscan?: number;
  /** Container max-height in pixels (default 520) */
  viewportHeight?: number;
  /** Debounce delay for search input in ms (default 150) */
  searchDebounceMs?: number;
  /** Placeholder text for the search input */
  searchPlaceholder?: string;
}

const DEFAULTS = {
  rowHeight: 18,
  overscan: 30,
  viewportHeight: 520,
  searchDebounceMs: 150,
  searchPlaceholder: 'Search log...',
} as const;

// ── Match info exposed to custom headers ────────────────────────────────────

export interface LogSearchMatchInfo {
  /** Total number of search matches */
  matchCount: number;
  /** Zero-based index of the current match */
  currentMatchIdx: number;
  /** Navigate to next search match */
  goNext: () => void;
  /** Navigate to previous search match */
  goPrev: () => void;
}

// ── Main component ──────────────────────────────────────────────────────────

export interface VirtualizedLogViewerProps {
  /** Log lines to display */
  lines: string[];
  /** Current search query (controlled from parent) */
  search: string;
  /** Callback when search changes */
  onSearchChange: (value: string) => void;
  /** Configuration overrides */
  config?: VirtualizedLogViewerConfig;
  /**
   * Optional: render a custom header instead of the default search bar.
   * Receives search-match navigation helpers for building custom controls.
   */
  renderHeader?: (matchInfo: LogSearchMatchInfo) => React.ReactNode;
  /** Optional: render a custom row. If not provided, uses the default simple row. */
  renderRow?: (props: {
    text: string;
    lineIndex: number;
    isMatch: boolean;
    isCurrent: boolean;
    searchQuery: string;
  }) => React.ReactNode;
  /** Optional: external scroll-to-line (e.g. from LineLink highlight) */
  scrollToLine?: number | null;
  /** Monotonically increasing version to re-trigger scroll even for the same line */
  scrollToVersion?: number;
  /** Additional class names for the outer container */
  className?: string;
  /** Whether to show the line count footer (default true) */
  showLineCount?: boolean;
  /** Optional: render empty state when lines array is empty */
  emptyState?: React.ReactNode;
  /** Additional class names for the scroll container */
  scrollContainerClassName?: string;
}

export function VirtualizedLogViewer({
  lines,
  search,
  onSearchChange,
  config,
  renderHeader,
  renderRow,
  scrollToLine,
  scrollToVersion,
  className,
  showLineCount = true,
  emptyState,
  scrollContainerClassName,
}: VirtualizedLogViewerProps) {
  const rowHeight = config?.rowHeight ?? DEFAULTS.rowHeight;
  const overscan = config?.overscan ?? DEFAULTS.overscan;
  const viewportHeight = config?.viewportHeight ?? DEFAULTS.viewportHeight;
  const searchDebounceMs = config?.searchDebounceMs ?? DEFAULTS.searchDebounceMs;
  const searchPlaceholder = config?.searchPlaceholder ?? DEFAULTS.searchPlaceholder;

  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [localSearch, setLocalSearch] = useState(search);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>();

  // Pre-lowercase all lines once
  const lowerLines = useMemo(() => lines.map((l) => l.toLowerCase()), [lines]);
  const lowerSearch = useMemo(() => search.toLowerCase(), [search]);

  // Debounced search propagation (only used by default search bar)
  const handleSearchChange = useCallback(
    (value: string) => {
      setLocalSearch(value);
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
      searchTimerRef.current = setTimeout(() => {
        onSearchChange(value);
      }, searchDebounceMs);
    },
    [onSearchChange, searchDebounceMs],
  );

  // Sync local search when parent changes it
  useEffect(() => {
    setLocalSearch(search);
  }, [search]);

  // Search match indices
  const matchLineIndices = useMemo(() => {
    if (!lowerSearch) return [];
    const indices: number[] = [];
    for (let i = 0; i < lowerLines.length; i++) {
      if (lowerLines[i].includes(lowerSearch)) indices.push(i);
    }
    return indices;
  }, [lowerLines, lowerSearch]);

  const matchSet = useMemo(() => new Set(matchLineIndices), [matchLineIndices]);

  const [currentMatchIdx, setCurrentMatchIdx] = useState(0);

  // Reset current match when search changes
  useEffect(() => {
    setCurrentMatchIdx(0);
  }, [lowerSearch]);

  // Auto-scroll to current search match
  useEffect(() => {
    if (matchLineIndices.length === 0 || !containerRef.current) return;
    const lineIdx = matchLineIndices[currentMatchIdx];
    if (lineIdx === undefined) return;
    const targetScroll = Math.max(0, lineIdx * rowHeight - viewportHeight / 2);
    containerRef.current.scrollTop = targetScroll;
    setScrollTop(targetScroll);
  }, [currentMatchIdx, matchLineIndices, rowHeight, viewportHeight]);

  // External scroll-to-line
  useEffect(() => {
    if (scrollToLine == null || !containerRef.current) return;
    const targetScroll = Math.max(0, scrollToLine * rowHeight - viewportHeight / 2);
    requestAnimationFrame(() => {
      if (containerRef.current) {
        containerRef.current.scrollTop = targetScroll;
        setScrollTop(targetScroll);
        // Scroll the container into the browser viewport if it's off-screen
        containerRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    });
  }, [scrollToLine, scrollToVersion, rowHeight, viewportHeight]);

  const goNext = useCallback(() => {
    if (matchLineIndices.length === 0) return;
    setCurrentMatchIdx((prev) => (prev + 1) % matchLineIndices.length);
  }, [matchLineIndices.length]);

  const goPrev = useCallback(() => {
    if (matchLineIndices.length === 0) return;
    setCurrentMatchIdx((prev) => (prev - 1 + matchLineIndices.length) % matchLineIndices.length);
  }, [matchLineIndices.length]);

  const currentMatchLine = matchLineIndices.length > 0 ? matchLineIndices[currentMatchIdx] : -1;

  // Track scroll position (throttled with rAF)
  const rafRef = useRef(0);
  const handleScroll = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      const el = containerRef.current;
      if (el) setScrollTop(el.scrollTop);
      rafRef.current = 0;
    });
  }, []);

  // Virtual scroll calculations
  const totalHeight = lines.length * rowHeight;
  const startIdx = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const endIdx = Math.min(
    lines.length,
    Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan,
  );
  const visibleLines = lines.slice(startIdx, endIdx);
  const offsetTop = startIdx * rowHeight;

  // Match info for renderHeader
  const matchInfo: LogSearchMatchInfo = {
    matchCount: matchLineIndices.length,
    currentMatchIdx,
    goNext,
    goPrev,
  };

  return (
    <div className={`flex flex-col ${className ?? ''}`}>
      {/* Header: custom or default search bar */}
      {renderHeader ? (
        renderHeader(matchInfo)
      ) : (
        <DefaultSearchBar
          localSearch={localSearch}
          lowerSearch={lowerSearch}
          matchCount={matchLineIndices.length}
          currentMatchIdx={currentMatchIdx}
          goNext={goNext}
          goPrev={goPrev}
          onSearchChange={handleSearchChange}
          placeholder={searchPlaceholder}
        />
      )}

      {/* Log content — virtual scrolling */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className={scrollContainerClassName ?? 'font-mono text-[11px] leading-[1.6] text-slate-800 dark:text-gray-200 overflow-auto'}
        style={{ maxHeight: viewportHeight }}
      >
        {lines.length === 0 && emptyState ? (
          emptyState
        ) : (
          <div style={{ height: totalHeight, position: 'relative', minWidth: 'fit-content' }}>
            <div style={{ position: 'absolute', top: offsetTop, left: 0, right: 0 }}>
              {visibleLines.map((line, vi) => {
                const lineIdx = startIdx + vi;
                const isMatch = matchSet.has(lineIdx);
                const isCurrent = lineIdx === currentMatchLine;

                if (renderRow) {
                  return (
                    <div key={lineIdx} style={{ height: rowHeight }}>
                      {renderRow({
                        text: line,
                        lineIndex: lineIdx,
                        isMatch,
                        isCurrent,
                        searchQuery: isMatch ? search : '',
                      })}
                    </div>
                  );
                }

                return (
                  <DefaultLogRow
                    key={lineIdx}
                    text={line}
                    isMatch={isMatch}
                    isCurrent={isCurrent}
                    searchQuery={isMatch ? search : ''}
                    rowHeight={rowHeight}
                  />
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Line count footer */}
      {showLineCount && (
        <div className="px-5 py-1 text-[10px] text-slate-400 dark:text-gray-500 border-t border-slate-200 dark:border-slate-700 flex-shrink-0">
          {lines.length.toLocaleString()} lines
        </div>
      )}
    </div>
  );
}

// ── Default search bar ──────────────────────────────────────────────────────

function DefaultSearchBar({
  localSearch,
  lowerSearch,
  matchCount,
  currentMatchIdx,
  goNext,
  goPrev,
  onSearchChange,
  placeholder,
}: {
  localSearch: string;
  lowerSearch: string;
  matchCount: number;
  currentMatchIdx: number;
  goNext: () => void;
  goPrev: () => void;
  onSearchChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <div className="flex items-center gap-2 px-5 py-2 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 flex-shrink-0">
      <svg className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
      </svg>
      <input
        type="text"
        placeholder={placeholder}
        aria-label={placeholder}
        value={localSearch}
        onChange={(e) => onSearchChange(e.target.value)}
        className="flex-1 text-xs px-2 py-1 border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-800 text-slate-900 dark:text-gray-100 placeholder:text-slate-400 outline-none focus:border-indigo-400 dark:focus:border-indigo-500"
        onKeyDown={(e) => {
          if (e.key === 'Escape' && localSearch) {
            e.stopPropagation();
            onSearchChange('');
          } else if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) goPrev();
            else goNext();
          }
        }}
      />
      {lowerSearch && matchCount > 0 && (
        <SearchNavControls
          matchCount={matchCount}
          currentMatchIdx={currentMatchIdx}
          goNext={goNext}
          goPrev={goPrev}
        />
      )}
      {lowerSearch && matchCount === 0 && (
        <span className="text-[10px] text-red-400 dark:text-red-500 flex-shrink-0">
          No matches
        </span>
      )}
      {localSearch && (
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
  );
}

// ── Reusable search nav controls (exported for custom headers) ──────────────

export function SearchNavControls({
  matchCount,
  currentMatchIdx,
  goNext,
  goPrev,
}: {
  matchCount: number;
  currentMatchIdx: number;
  goNext: () => void;
  goPrev: () => void;
}) {
  return (
    <>
      <span className="text-[10px] text-slate-400 dark:text-gray-500 flex-shrink-0 tabular-nums">
        {currentMatchIdx + 1} / {matchCount}
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
  );
}

// ── Default row renderer ────────────────────────────────────────────────────

interface DefaultLogRowProps {
  text: string;
  isMatch: boolean;
  isCurrent: boolean;
  searchQuery: string;
  rowHeight: number;
}

const DefaultLogRow = memo(function DefaultLogRow({
  text,
  isMatch,
  isCurrent,
  searchQuery,
  rowHeight,
}: DefaultLogRowProps) {
  let bg = '';
  if (isCurrent) {
    bg = 'bg-yellow-200 dark:bg-yellow-900/40';
  } else if (isMatch) {
    bg = 'bg-yellow-100/60 dark:bg-yellow-900/20';
  }

  return (
    <div className={`whitespace-pre px-5 ${bg}`} style={{ height: rowHeight }}>
      {isMatch && searchQuery ? highlightSearch(text, searchQuery) : text}
    </div>
  );
});
