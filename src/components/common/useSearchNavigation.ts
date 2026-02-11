/**
 * Reusable hook for search + next/prev match navigation, matching the pattern
 * used in V2VPipelineView (RawLogWithSearch) and V2VRawLogViewer.
 */
import { useState, useMemo, useEffect, useCallback } from 'react';

export interface UseSearchNavigationOptions {
  /** Lines or items to search through (case-insensitive substring match) */
  items: string[];
  /** Search query string */
  searchQuery: string;
}

export interface UseSearchNavigationReturn {
  /** Total number of matches */
  matchCount: number;
  /** 0-based index of current match within the matches (0 = first match, 1 = second, etc.) */
  currentMatchIndex: number;
  /** Navigate to the next match (wraps to first after last) */
  goToNextMatch: () => void;
  /** Navigate to the previous match (wraps to last after first) */
  goToPrevMatch: () => void;
  /** Whether the given item index is a search match */
  isMatch: (index: number) => boolean;
  /** The item index of the current match, or -1 if no matches */
  currentMatchItemIndex: number;
  /** Ordered array of item indices that match the search */
  matchIndices: number[];
}

export function useSearchNavigation(options: UseSearchNavigationOptions): UseSearchNavigationReturn {
  const { items, searchQuery } = options;

  const lowerSearch = useMemo(() => searchQuery.toLowerCase(), [searchQuery]);

  const matchIndices = useMemo(() => {
    if (!lowerSearch) return [];
    const indices: number[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].toLowerCase().includes(lowerSearch)) indices.push(i);
    }
    return indices;
  }, [items, lowerSearch]);

  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);

  useEffect(() => {
    setCurrentMatchIndex(0);
  }, [lowerSearch]);

  const goToNextMatch = useCallback(() => {
    if (matchIndices.length === 0) return;
    setCurrentMatchIndex((prev) => (prev + 1) % matchIndices.length);
  }, [matchIndices.length]);

  const goToPrevMatch = useCallback(() => {
    if (matchIndices.length === 0) return;
    setCurrentMatchIndex((prev) => (prev - 1 + matchIndices.length) % matchIndices.length);
  }, [matchIndices.length]);

  const matchSet = useMemo(() => new Set(matchIndices), [matchIndices]);

  const isMatch = useCallback(
    (index: number) => matchSet.has(index),
    [matchSet],
  );

  const currentMatchItemIndex =
    matchIndices.length > 0 ? matchIndices[currentMatchIndex] ?? -1 : -1;

  return {
    matchCount: matchIndices.length,
    currentMatchIndex,
    goToNextMatch,
    goToPrevMatch,
    isMatch,
    currentMatchItemIndex,
    matchIndices,
  };
}
