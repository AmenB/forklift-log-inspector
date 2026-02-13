import { describe, it, expect, beforeEach } from 'vitest';
import { useV2VStore } from '../useV2VStore';
import type { V2VFileEntry, V2VParsedData, V2VToolRun } from '../../types/v2v';

// Helper to create a minimal V2VToolRun
function makeToolRun(overrides: Partial<V2VToolRun> = {}): V2VToolRun {
  return {
    tool: 'virt-v2v',
    commandLine: '-v',
    exitStatus: 'success',
    startLine: 0,
    endLine: 10,
    stages: [],
    diskProgress: [],
    nbdkitConnections: [],
    libguestfs: { backend: '', identifier: '', memsize: 0, smp: 0, drives: [], apiCalls: [], launchLines: [] },
    apiCalls: [],
    hostCommands: [],
    guestInfo: null,
    installedApps: [],
    registryHiveAccesses: [],
    virtioWin: { isoPath: null, fileCopies: [] },
    versions: {},
    diskSummary: { disks: [] },
    sourceVM: null,
    errors: [],
    rawLines: ['line1', 'line2'],
    lineCategories: ['other', 'other'],
    ...overrides,
  };
}

function makeFileEntry(overrides: Partial<V2VFileEntry & { toolRuns?: Partial<V2VToolRun>[] }> = {}): V2VFileEntry {
  const toolRuns = (overrides as { toolRuns?: Partial<V2VToolRun>[] }).toolRuns ?? [{}];
  const data: V2VParsedData = {
    toolRuns: toolRuns.map(makeToolRun),
    totalLines: 10,
  };
  return {
    filePath: overrides.filePath ?? '/test/path.log',
    data,
    planName: overrides.planName,
    vmId: overrides.vmId,
  };
}

describe('useV2VStore', () => {
  beforeEach(() => {
    // Reset store state before each test
    useV2VStore.getState().clearV2VData();
  });

  // ── setV2VFileEntries ─────────────────────────────────────────

  describe('setV2VFileEntries', () => {
    it('sets file entries and selects first file by default', () => {
      const entries = [makeFileEntry(), makeFileEntry({ filePath: '/other.log' })];
      useV2VStore.getState().setV2VFileEntries(entries);

      const state = useV2VStore.getState();
      expect(state.v2vFileEntries).toHaveLength(2);
      expect(state.selectedFileIndex).toBe(0);
      expect(state.selectedToolRun).toBe(0);
    });

    it('auto-selects first errored file', () => {
      const entries = [
        makeFileEntry({ filePath: '/success.log' }),
        makeFileEntry({
          filePath: '/error.log',
          toolRuns: [{ exitStatus: 'error', errors: [{ level: 'error', source: 'virt-v2v', message: 'fail', lineNumber: 0, rawLine: 'fail' }] }],
        }),
      ];
      useV2VStore.getState().setV2VFileEntries(entries);

      expect(useV2VStore.getState().selectedFileIndex).toBe(1);
    });

    it('auto-selects failed tool run within selected file', () => {
      const entries = [
        makeFileEntry({
          toolRuns: [
            { exitStatus: 'success' },
            { exitStatus: 'error', errors: [{ level: 'error', source: 'virt-v2v', message: 'fail', lineNumber: 0, rawLine: 'fail' }] },
          ],
        }),
      ];
      useV2VStore.getState().setV2VFileEntries(entries);

      expect(useV2VStore.getState().selectedToolRun).toBe(1);
    });

    it('expands errors panel when errors present', () => {
      const entries = [
        makeFileEntry({
          toolRuns: [{ exitStatus: 'error', errors: [{ level: 'error', source: 'virt-v2v', message: 'fail', lineNumber: 0, rawLine: 'fail' }] }],
        }),
      ];
      useV2VStore.getState().setV2VFileEntries(entries);

      expect(useV2VStore.getState().expandedPanels.errors).toBe(true);
    });

    it('resets filters and search', () => {
      useV2VStore.getState().setComponentFilter('error');
      useV2VStore.getState().setSearchQuery('test');

      const entries = [makeFileEntry()];
      useV2VStore.getState().setV2VFileEntries(entries);

      expect(useV2VStore.getState().componentFilter).toBe('all');
      expect(useV2VStore.getState().searchQuery).toBe('');
    });
  });

  // ── setSelectedFile ─────────────────────────────────────────

  describe('setSelectedFile', () => {
    it('changes selected file and resets filters', () => {
      const entries = [makeFileEntry(), makeFileEntry({ filePath: '/other.log' })];
      useV2VStore.getState().setV2VFileEntries(entries);
      useV2VStore.getState().setComponentFilter('error');

      useV2VStore.getState().setSelectedFile(1);

      const state = useV2VStore.getState();
      expect(state.selectedFileIndex).toBe(1);
      expect(state.componentFilter).toBe('all');
      expect(state.searchQuery).toBe('');
      expect(state.highlightedLine).toBeNull();
    });

    it('selects failed run in new file', () => {
      const entries = [
        makeFileEntry(),
        makeFileEntry({
          filePath: '/error.log',
          toolRuns: [
            { exitStatus: 'success' },
            { exitStatus: 'error', errors: [{ level: 'error', source: 'virt-v2v', message: 'fail', lineNumber: 0, rawLine: 'fail' }] },
          ],
        }),
      ];
      useV2VStore.getState().setV2VFileEntries(entries);
      useV2VStore.getState().setSelectedFile(1);

      expect(useV2VStore.getState().selectedToolRun).toBe(1);
    });

    it('ignores invalid index', () => {
      const entries = [makeFileEntry()];
      useV2VStore.getState().setV2VFileEntries(entries);
      useV2VStore.getState().setSelectedFile(99);

      // Should remain on first file
      expect(useV2VStore.getState().selectedFileIndex).toBe(0);
    });
  });

  // ── clearV2VData ─────────────────────────────────────────

  describe('clearV2VData', () => {
    it('resets all state to defaults', () => {
      const entries = [makeFileEntry()];
      useV2VStore.getState().setV2VFileEntries(entries);
      useV2VStore.getState().setComponentFilter('error');
      useV2VStore.getState().setSearchQuery('test');
      useV2VStore.getState().setHighlightedLine(42);

      useV2VStore.getState().clearV2VData();

      const state = useV2VStore.getState();
      expect(state.v2vFileEntries).toHaveLength(0);
      expect(state.selectedFileIndex).toBe(0);
      expect(state.selectedToolRun).toBe(0);
      expect(state.componentFilter).toBe('all');
      expect(state.searchQuery).toBe('');
      expect(state.highlightedLine).toBeNull();
    });
  });

  // ── getActiveV2VData ─────────────────────────────────────────

  describe('getActiveV2VData', () => {
    it('returns correct file data', () => {
      const entries = [makeFileEntry(), makeFileEntry({ filePath: '/other.log' })];
      useV2VStore.getState().setV2VFileEntries(entries);

      const data = useV2VStore.getState().getActiveV2VData();
      expect(data).not.toBeNull();
      expect(data!.toolRuns).toHaveLength(1);
    });

    it('returns null when no entries', () => {
      expect(useV2VStore.getState().getActiveV2VData()).toBeNull();
    });
  });

  // ── togglePanel / isPanelExpanded ─────────────────────────────────

  describe('togglePanel / isPanelExpanded', () => {
    it('toggles panel expansion state', () => {
      expect(useV2VStore.getState().isPanelExpanded('pipeline')).toBe(true);
      useV2VStore.getState().togglePanel('pipeline');
      expect(useV2VStore.getState().isPanelExpanded('pipeline')).toBe(false);
      useV2VStore.getState().togglePanel('pipeline');
      expect(useV2VStore.getState().isPanelExpanded('pipeline')).toBe(true);
    });

    it('returns false for unknown panel', () => {
      expect(useV2VStore.getState().isPanelExpanded('nonexistent')).toBe(false);
    });

    it('default panels: pipeline and guestinfo expanded, others collapsed', () => {
      expect(useV2VStore.getState().isPanelExpanded('pipeline')).toBe(true);
      expect(useV2VStore.getState().isPanelExpanded('guestinfo')).toBe(true);
      expect(useV2VStore.getState().isPanelExpanded('commands')).toBe(false);
      expect(useV2VStore.getState().isPanelExpanded('errors')).toBe(false);
      expect(useV2VStore.getState().isPanelExpanded('rawlog')).toBe(false);
    });
  });

  // ── setHighlightedLine ─────────────────────────────────────────

  describe('setHighlightedLine', () => {
    it('sets highlighted line and bumps version', () => {
      const v1 = useV2VStore.getState().highlightVersion;
      useV2VStore.getState().setHighlightedLine(42);

      const state = useV2VStore.getState();
      expect(state.highlightedLine).toBe(42);
      expect(state.highlightVersion).toBe(v1 + 1);
    });

    it('expands rawlog panel when highlighting a line', () => {
      expect(useV2VStore.getState().isPanelExpanded('rawlog')).toBe(false);
      useV2VStore.getState().setHighlightedLine(10);
      expect(useV2VStore.getState().isPanelExpanded('rawlog')).toBe(true);
    });

    it('does not collapse rawlog when setting null', () => {
      useV2VStore.getState().setHighlightedLine(10);
      expect(useV2VStore.getState().isPanelExpanded('rawlog')).toBe(true);
      useV2VStore.getState().setHighlightedLine(null);
      // rawlog stays expanded
      expect(useV2VStore.getState().isPanelExpanded('rawlog')).toBe(true);
    });

    it('bumps version even for same line number', () => {
      useV2VStore.getState().setHighlightedLine(42);
      const v1 = useV2VStore.getState().highlightVersion;
      useV2VStore.getState().setHighlightedLine(42);
      expect(useV2VStore.getState().highlightVersion).toBe(v1 + 1);
    });
  });

  // ── setSelectedToolRun ─────────────────────────────────────────

  describe('setSelectedToolRun', () => {
    it('changes selected tool run and resets highlight', () => {
      const entries = [
        makeFileEntry({
          toolRuns: [{ exitStatus: 'success' }, { exitStatus: 'success' }],
        }),
      ];
      useV2VStore.getState().setV2VFileEntries(entries);
      useV2VStore.getState().setHighlightedLine(42);

      useV2VStore.getState().setSelectedToolRun(1);

      const state = useV2VStore.getState();
      expect(state.selectedToolRun).toBe(1);
      expect(state.highlightedLine).toBeNull();
    });

    it('expands errors panel for errored run', () => {
      const entries = [
        makeFileEntry({
          toolRuns: [
            { exitStatus: 'success' },
            { exitStatus: 'error', errors: [{ level: 'error', source: 'virt-v2v', message: 'fail', lineNumber: 0, rawLine: 'fail' }] },
          ],
        }),
      ];
      useV2VStore.getState().setV2VFileEntries(entries);
      useV2VStore.getState().setSelectedToolRun(1);

      expect(useV2VStore.getState().expandedPanels.errors).toBe(true);
    });
  });

  // ── setComponentFilter / setSearchQuery ──────────────────────────

  describe('setComponentFilter', () => {
    it('sets component filter', () => {
      useV2VStore.getState().setComponentFilter('error');
      expect(useV2VStore.getState().componentFilter).toBe('error');
    });
  });

  describe('setSearchQuery', () => {
    it('sets search query', () => {
      useV2VStore.getState().setSearchQuery('test query');
      expect(useV2VStore.getState().searchQuery).toBe('test query');
    });
  });
});
