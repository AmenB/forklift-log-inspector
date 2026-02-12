import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { V2VDashboard } from '../v2v/V2VDashboard';
import { useV2VStore } from '../../store/useV2VStore';
import type { V2VParsedData, V2VToolRun } from '../../types/v2v';

const minimalToolRun = {
  tool: 'virt-v2v',
  commandLine: '-v -x',
  exitStatus: 'success',
  startLine: 0,
  endLine: 2,
  rawLines: ['Building command: virt-v2v [-v -x]', '[   0.0] Setting up the source', '[ 100.0] Finishing off'],
  stages: [],
  errors: [],
  apiCalls: [],
  hostCommands: [],
  guestInfo: null,
  sourceVM: null,
  versions: {},
  virtioWin: { fileCopies: [], isoPath: null },
  installedApps: [],
  registryHiveAccesses: [],
  diskProgress: [],
  nbdkitConnections: [],
  libguestfs: { backend: '', identifier: '', memsize: 0, smp: 0, drives: [], apiCalls: [], launchLines: [] },
  diskSummary: { hostFreeSpace: null, hostTmpDir: null, disks: [] },
  lineCategories: [],
} as unknown as V2VToolRun;

const minimalV2VData: V2VParsedData = {
  toolRuns: [minimalToolRun],
  totalLines: 3,
  fileName: 'test.log',
};

describe('V2VDashboard', () => {
  beforeEach(() => {
    useV2VStore.getState().clearV2VData();
  });

  it('renders without crashing when no data', () => {
    const { container } = render(<V2VDashboard />);
    expect(container).toBeTruthy();
  });

  it('Clear button clears V2V data when clicked', () => {
    useV2VStore.getState().setV2VData(minimalV2VData);
    render(<V2VDashboard />);

    expect(useV2VStore.getState().v2vData).not.toBeNull();

    const clearButtons = screen.getAllByRole('button', { name: /clear v2v log data/i });
    fireEvent.click(clearButtons[0]);

    expect(useV2VStore.getState().v2vData).toBeNull();
  });
});
