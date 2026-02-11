import { create } from 'zustand';
import type { V2VParsedData, V2VLineCategory } from '../types/v2v';

interface V2VState {
  // Data
  v2vData: V2VParsedData | null;

  // UI state
  selectedToolRun: number;
  componentFilter: V2VLineCategory | 'all';
  searchQuery: string;
  highlightedLine: number | null;
  /** Incremented on every setHighlightedLine call so the scroll effect re-triggers even for the same line */
  highlightVersion: number;
  expandedPanels: Record<string, boolean>;

  // Actions
  setV2VData: (data: V2VParsedData) => void;
  clearV2VData: () => void;
  setSelectedToolRun: (index: number) => void;
  setComponentFilter: (filter: V2VLineCategory | 'all') => void;
  setSearchQuery: (query: string) => void;
  setHighlightedLine: (line: number | null) => void;
  togglePanel: (panelId: string) => void;
  isPanelExpanded: (panelId: string) => boolean;
}

/** Default panel expansion state — aligned with CollapsibleSection ids in V2VDashboard. */
const DEFAULT_EXPANDED_PANELS: Record<string, boolean> = {
  pipeline: true,
  guestinfo: true,
  commands: false,
  errors: false,
  rawlog: false,
};

export const useV2VStore = create<V2VState>()((set, get) => ({
  // Initial state
  v2vData: null,
  selectedToolRun: 0,
  componentFilter: 'all',
  searchQuery: '',
  highlightedLine: null,
  highlightVersion: 0,
  expandedPanels: { ...DEFAULT_EXPANDED_PANELS },

  // Actions
  setV2VData: (data: V2VParsedData) => {
    // Auto-select the first failed run so failures are immediately visible
    const failedIdx = data.toolRuns.findIndex((r) => r.exitStatus === 'error');
    const selectedIdx = failedIdx >= 0 ? failedIdx : 0;
    const selectedRun = data.toolRuns[selectedIdx];
    const hasErrors = selectedRun && selectedRun.exitStatus === 'error' && selectedRun.errors.length > 0;
    set({
      v2vData: data,
      selectedToolRun: selectedIdx,
      componentFilter: 'all',
      searchQuery: '',
      highlightedLine: null,
      // Reset panel states on each upload — show errors panel only when there are failures
      expandedPanels: {
        ...DEFAULT_EXPANDED_PANELS,
        errors: hasErrors,
      },
    });
  },

  clearV2VData: () => {
    set({
      v2vData: null,
      selectedToolRun: 0,
      componentFilter: 'all',
      searchQuery: '',
      highlightedLine: null,
      expandedPanels: { ...DEFAULT_EXPANDED_PANELS },
    });
  },

  setSelectedToolRun: (index: number) => {
    const data = get().v2vData;
    const run = data?.toolRuns[index];
    const hasErrors = run ? run.exitStatus === 'error' && run.errors.length > 0 : false;
    set((state) => ({
      selectedToolRun: index,
      highlightedLine: null,
      expandedPanels: {
        ...state.expandedPanels,
        errors: hasErrors,
      },
    }));
  },

  setComponentFilter: (filter: V2VLineCategory | 'all') => {
    set({ componentFilter: filter });
  },

  setSearchQuery: (query: string) => {
    set({ searchQuery: query });
  },

  setHighlightedLine: (line: number | null) => {
    set((state) => ({
      highlightedLine: line,
      highlightVersion: state.highlightVersion + 1,
      expandedPanels: line !== null
        ? { ...state.expandedPanels, rawlog: true }
        : state.expandedPanels,
    }));
  },

  togglePanel: (panelId: string) => {
    set((state) => ({
      expandedPanels: {
        ...state.expandedPanels,
        [panelId]: !state.expandedPanels[panelId],
      },
    }));
  },

  isPanelExpanded: (panelId: string) => {
    return get().expandedPanels[panelId] ?? false;
  },
}));

// Helper hooks
export const useV2VData = () => useV2VStore((s) => s.v2vData);
export const useSelectedToolRun = () => useV2VStore((s) => s.selectedToolRun);
export const useComponentFilter = () => useV2VStore((s) => s.componentFilter);
export const useV2VSearchQuery = () => useV2VStore((s) => s.searchQuery);
export const useHighlightedLine = () => useV2VStore((s) => s.highlightedLine);
