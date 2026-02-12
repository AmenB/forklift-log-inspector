import { useState, useMemo, useRef, useEffect, useCallback, memo } from 'react';
import { useV2VStore } from '../../store/useV2VStore';
import type { V2VToolRun, V2VLineCategory } from '../../types/v2v';

interface V2VRawLogViewerProps {
  toolRun: V2VToolRun;
}

const CATEGORY_FILTERS: { key: V2VLineCategory | 'all'; label: string; color: string }[] = [
  { key: 'all', label: 'All', color: 'bg-slate-600' },
  { key: 'stage', label: 'Stages', color: 'bg-blue-500' },
  { key: 'nbdkit', label: 'nbdkit', color: 'bg-purple-500' },
  { key: 'libguestfs', label: 'libguestfs', color: 'bg-indigo-500' },
  { key: 'guestfsd', label: 'guestfsd', color: 'bg-cyan-500' },
  { key: 'command', label: 'Commands', color: 'bg-teal-500' },
  { key: 'kernel', label: 'Kernel', color: 'bg-slate-500' },
  { key: 'error', label: 'Errors', color: 'bg-red-500' },
  { key: 'warning', label: 'Warnings', color: 'bg-orange-500' },
  { key: 'monitor', label: 'Monitor', color: 'bg-green-500' },
  { key: 'info', label: 'Info', color: 'bg-sky-500' },
];

const LINE_COLORS: Record<V2VLineCategory, string> = {
  stage: 'text-blue-600 dark:text-blue-400',
  nbdkit: 'text-purple-600 dark:text-purple-400',
  libguestfs: 'text-indigo-600 dark:text-indigo-400',
  guestfsd: 'text-cyan-600 dark:text-cyan-400',
  command: 'text-teal-600 dark:text-teal-400',
  kernel: 'text-slate-500 dark:text-slate-500',
  info: 'text-sky-600 dark:text-sky-400',
  error: 'text-red-600 dark:text-red-400 font-semibold',
  warning: 'text-orange-600 dark:text-orange-400',
  monitor: 'text-green-600 dark:text-green-400',
  xml: 'text-slate-500 dark:text-gray-500',
  yaml: 'text-slate-500 dark:text-gray-500',
  other: 'text-slate-700 dark:text-gray-300',
};

/** Estimated row height in pixels for virtual scrolling */
const ROW_HEIGHT = 20;
/** Extra rows rendered above and below the viewport */
const OVERSCAN = 30;
/** Container max-height in pixels */
const VIEWPORT_HEIGHT = 600;
/** Debounce delay for search input (ms) */
const SEARCH_DEBOUNCE_MS = 200;

interface FilteredLine {
  index: number;
  text: string;
  category: V2VLineCategory;
  globalLine: number;
}

export function V2VRawLogViewer({ toolRun }: V2VRawLogViewerProps) {
  const { componentFilter, searchQuery, highlightedLine, highlightVersion, setComponentFilter, setSearchQuery } =
    useV2VStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [localSearch, setLocalSearch] = useState(searchQuery);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const isMountedRef = useRef(false);
  const [currentMatchIdx, setCurrentMatchIdx] = useState(0);

  // Reset filters and search when the component mounts (e.g. opening the Raw Log section)
  useEffect(() => {
    setComponentFilter('all');
    setSearchQuery('');
    setLocalSearch('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounce search input to avoid filtering on every keystroke
  const handleSearchChange = useCallback(
    (value: string) => {
      setLocalSearch(value);
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
      searchTimerRef.current = setTimeout(() => {
        setSearchQuery(value);
      }, SEARCH_DEBOUNCE_MS);
    },
    [setSearchQuery],
  );

  // Sync localSearch when store query changes externally
  useEffect(() => {
    setLocalSearch(searchQuery);
  }, [searchQuery]);

  // Pre-compute category counts once (not on every render)
  const categoryCounts = useMemo(() => {
    const counts = new Map<V2VLineCategory | 'all', number>();
    counts.set('all', toolRun.rawLines.length);
    for (const cat of toolRun.lineCategories) {
      counts.set(cat, (counts.get(cat) || 0) + 1);
    }
    return counts;
  }, [toolRun.rawLines.length, toolRun.lineCategories]);

  // Pre-lowercase all lines once — avoids re-lowercasing on every search query change
  const lowerLines = useMemo(
    () => toolRun.rawLines.map((line) => line.toLowerCase()),
    [toolRun.rawLines],
  );

  // Pre-lowercase the search query once
  const lowerSearch = useMemo(() => searchQuery.toLowerCase(), [searchQuery]);

  // Filter lines by category only (search no longer filters — it highlights)
  const filteredLines = useMemo(() => {
    const lines: FilteredLine[] = [];
    const hasFilter = componentFilter !== 'all';

    for (let i = 0; i < toolRun.rawLines.length; i++) {
      const category = toolRun.lineCategories[i] || 'other';

      if (hasFilter && category !== componentFilter) continue;

      lines.push({
        index: i,
        text: toolRun.rawLines[i],
        category,
        globalLine: toolRun.startLine + i,
      });
    }
    return lines;
  }, [toolRun, componentFilter]);

  // Compute search match indices within filteredLines using pre-lowered lines
  const searchMatchIndices = useMemo(() => {
    if (!lowerSearch) return [];
    const indices: number[] = [];
    for (let i = 0; i < filteredLines.length; i++) {
      if (lowerLines[filteredLines[i].index].includes(lowerSearch)) {
        indices.push(i);
      }
    }
    return indices;
  }, [filteredLines, lowerSearch, lowerLines]);

  // Reset current match when search changes
  useEffect(() => {
    setCurrentMatchIdx(0);
  }, [lowerSearch]);

  // Navigate to next search match
  const goNextMatch = useCallback(() => {
    if (searchMatchIndices.length === 0) return;
    setCurrentMatchIdx((prev) => (prev + 1) % searchMatchIndices.length);
  }, [searchMatchIndices.length]);

  // Navigate to previous search match
  const goPrevMatch = useCallback(() => {
    if (searchMatchIndices.length === 0) return;
    setCurrentMatchIdx((prev) => (prev - 1 + searchMatchIndices.length) % searchMatchIndices.length);
  }, [searchMatchIndices.length]);

  // The filteredLines index of the current search match
  const currentSearchLine = searchMatchIndices.length > 0 ? searchMatchIndices[currentMatchIdx] : -1;

  // Auto-scroll to current search match within the virtual scroll container
  useEffect(() => {
    if (currentSearchLine < 0 || !containerRef.current) return;
    const targetScroll = Math.max(0, currentSearchLine * ROW_HEIGHT - VIEWPORT_HEIGHT / 2);
    containerRef.current.scrollTop = targetScroll;
    setScrollTop(targetScroll);
  }, [currentSearchLine]);

  // Build a globalLine → filteredIndex lookup for fast highlight jumps
  const highlightIndex = useMemo(() => {
    if (highlightedLine === null) return -1;
    for (let i = 0; i < filteredLines.length; i++) {
      if (filteredLines[i].globalLine === highlightedLine) return i;
      if (filteredLines[i].globalLine > highlightedLine) break;
    }
    return -1;
  }, [highlightedLine, filteredLines]);

  // Auto-scroll to highlighted line (from LineLink clicks).
  useEffect(() => {
    if (highlightIndex < 0 || !containerRef.current) return;
    const targetScroll = Math.max(0, highlightIndex * ROW_HEIGHT - VIEWPORT_HEIGHT / 2);
    requestAnimationFrame(() => {
      if (containerRef.current) {
        containerRef.current.scrollTop = targetScroll;
        setScrollTop(targetScroll);
        containerRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    });
  }, [highlightIndex, highlightVersion]);

  // Reset scroll on category filter change (but not on initial mount)
  useEffect(() => {
    if (!isMountedRef.current) {
      isMountedRef.current = true;
      return;
    }
    if (containerRef.current) {
      containerRef.current.scrollTop = 0;
      setScrollTop(0);
    }
  }, [componentFilter]);

  // Track scroll position — throttled with rAF to avoid layout thrashing
  const rafRef = useRef(0);
  const handleScroll = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      const el = containerRef.current;
      if (el) setScrollTop(el.scrollTop);
      rafRef.current = 0;
    });
  }, []);

  // Build a Set of filteredLines indices that are search matches for O(1) lookup
  const searchMatchSet = useMemo(() => new Set(searchMatchIndices), [searchMatchIndices]);

  // ── Virtual scroll calculations ─────────────────────────────────
  const totalHeight = filteredLines.length * ROW_HEIGHT;
  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endIdx = Math.min(
    filteredLines.length,
    Math.ceil((scrollTop + VIEWPORT_HEIGHT) / ROW_HEIGHT) + OVERSCAN,
  );
  const visibleLines = filteredLines.slice(startIdx, endIdx);
  const offsetTop = startIdx * ROW_HEIGHT;

  return (
    <div className="space-y-2">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 flex-1 min-w-[200px]">
          <input
            type="text"
            placeholder="Search log..."
            aria-label="Search log"
            value={localSearch}
            onChange={(e) => handleSearchChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && localSearch) {
                e.stopPropagation();
                handleSearchChange('');
              } else if (e.key === 'Enter') {
                e.preventDefault();
                if (e.shiftKey) goPrevMatch();
                else goNextMatch();
              }
            }}
            className="flex-1 px-3 py-1.5 text-xs border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-800 text-slate-900 dark:text-gray-100 placeholder:text-slate-400 outline-none focus:border-indigo-400 dark:focus:border-indigo-500"
          />
          {lowerSearch && searchMatchIndices.length > 0 && (
            <>
              <span className="text-[10px] text-slate-400 dark:text-gray-500 flex-shrink-0 tabular-nums">
                {currentMatchIdx + 1} / {searchMatchIndices.length}
              </span>
              <button
                onClick={goPrevMatch}
                className="p-1 rounded text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
                title="Previous match (Shift+Enter)"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                </svg>
              </button>
              <button
                onClick={goNextMatch}
                className="p-1 rounded text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
                title="Next match (Enter)"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
            </>
          )}
          {lowerSearch && searchMatchIndices.length === 0 && (
            <span className="text-[10px] text-red-400 dark:text-red-500 flex-shrink-0">No matches</span>
          )}
          {localSearch && (
            <button
              onClick={() => handleSearchChange('')}
              className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
              title="Clear search"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-1">
          {CATEGORY_FILTERS.map(({ key, label, color }) => {
            const isActive = componentFilter === key;
            const count = categoryCounts.get(key) || 0;
            if (count === 0 && key !== 'all') return null;

            return (
              <button
                key={key}
                onClick={() => setComponentFilter(key)}
                className={`
                  px-2 py-1 rounded text-[10px] font-medium transition-colors flex items-center gap-1
                  ${isActive
                    ? `${color} text-white`
                    : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-gray-400 hover:bg-slate-200 dark:hover:bg-slate-700'
                  }
                `}
              >
                {label}
                <span className="opacity-60">({count.toLocaleString()})</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Stats */}
      <div className="text-[10px] text-slate-400 dark:text-gray-500">
        {filteredLines.length.toLocaleString()} lines
        {filteredLines.length !== toolRun.rawLines.length &&
          ` (filtered from ${toolRun.rawLines.length.toLocaleString()})`}
      </div>

      {/* Log content — virtual scrolling */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="font-mono text-[11px] leading-[1.6] bg-slate-50 dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-700 overflow-auto"
        style={{ maxHeight: VIEWPORT_HEIGHT }}
      >
        {filteredLines.length === 0 ? (
          <div className="p-6 text-center text-slate-400 dark:text-gray-500 text-xs">
            No lines match the current filters.
          </div>
        ) : (
          <div style={{ height: totalHeight, position: 'relative', minWidth: 'fit-content' }}>
            <div style={{ position: 'absolute', top: offsetTop, left: 0 }}>
              {visibleLines.map((line, vi) => {
                const filteredIdx = startIdx + vi;
                const isMatch = searchMatchSet.has(filteredIdx);
                return (
                  <LogRow
                    key={line.index}
                    line={line}
                    isHighlighted={highlightedLine === line.globalLine}
                    isSearchMatch={isMatch}
                    isCurrentMatch={filteredIdx === currentSearchLine}
                    searchQuery={isMatch ? searchQuery : ''}
                  />
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Memoized row component ─────────────────────────────────────────

interface LogRowProps {
  line: FilteredLine;
  isHighlighted: boolean;
  isSearchMatch: boolean;
  isCurrentMatch: boolean;
  searchQuery: string;
}

const LogRow = memo(function LogRow({ line, isHighlighted, isSearchMatch, isCurrentMatch, searchQuery }: LogRowProps) {
  let rowBg = '';
  if (isCurrentMatch) {
    rowBg = 'bg-yellow-200 dark:bg-yellow-900/40';
  } else if (isHighlighted) {
    rowBg = 'bg-yellow-100 dark:bg-yellow-900/30';
  } else if (isSearchMatch) {
    rowBg = 'bg-yellow-50 dark:bg-yellow-900/15';
  }

  return (
    <div
      className={`flex min-w-full hover:bg-slate-100 dark:hover:bg-slate-800/50 ${rowBg}`}
      style={{ height: ROW_HEIGHT }}
    >
      {/* Line number gutter — sticky so it stays visible during horizontal scroll */}
      <div
        className="px-2 py-0 text-right select-none text-slate-400 dark:text-gray-600 w-[60px] flex-shrink-0 whitespace-nowrap border-r border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 z-10"
        style={{ position: 'sticky', left: 0 }}
      >
        {line.globalLine + 1}
      </div>
      {/* Log text — no truncation, allows horizontal scroll */}
      <div
        className={`px-3 py-0 whitespace-nowrap ${LINE_COLORS[line.category]}`}
      >
        {searchQuery && isSearchMatch ? highlightSearch(line.text, searchQuery) : line.text}
      </div>
    </div>
  );
});

// ── Search highlight helper ─────────────────────────────────────────

function highlightSearch(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const parts: React.ReactNode[] = [];
  const lower = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  let lastIdx = 0;

  while (true) {
    const idx = lower.indexOf(lowerQuery, lastIdx);
    if (idx === -1) break;
    if (idx > lastIdx) parts.push(text.slice(lastIdx, idx));
    parts.push(
      <mark key={idx} className="bg-yellow-300 dark:bg-yellow-700 text-inherit rounded-sm px-0.5">
        {text.slice(idx, idx + query.length)}
      </mark>,
    );
    lastIdx = idx + query.length;
  }
  if (lastIdx < text.length) parts.push(text.slice(lastIdx));
  return parts.length > 0 ? <>{parts}</> : text;
}
