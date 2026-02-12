import { describe, it, expect } from 'vitest';
import { processPlanLog, ensureVMExists } from '../planProcessor';
import { LogStore } from '../LogStore';
import type { LogEntry, Plan } from '../../types';

function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    level: 'info',
    ts: '2026-02-05T12:00:00.000Z',
    logger: 'plan|test-ns/my-plan',
    msg: '',
    ...overrides,
  };
}

describe('ensureVMExists', () => {
  it('creates a new VM if one does not exist', () => {
    const plan: Plan = {
      name: 'my-plan',
      namespace: 'test-ns',
      status: 'Pending',
      archived: false,
      migrationType: 'Unknown',
      conditions: [],
      vms: {},
      errors: [],
      panics: [],
      firstSeen: new Date(0),
      lastSeen: new Date(0),
    };
    const ts = new Date('2026-02-05T12:00:00.000Z');
    const entry = makeEntry({ vmRef: { id: 'vm-1', name: 'test-vm' } });

    ensureVMExists(plan, entry, ts);

    expect(plan.vms['vm-1']).toBeDefined();
    expect(plan.vms['vm-1'].id).toBe('vm-1');
    expect(plan.vms['vm-1'].name).toBe('test-vm');
    expect(plan.vms['vm-1'].firstSeen).toEqual(ts);
    expect(plan.vms['vm-1'].lastSeen).toEqual(ts);
    expect(plan.vms['vm-1'].phaseHistory).toEqual([]);
  });

  it('updates lastSeen for existing VM', () => {
    const plan: Plan = {
      name: 'my-plan',
      namespace: 'test-ns',
      status: 'Pending',
      archived: false,
      migrationType: 'Unknown',
      conditions: [],
      vms: {},
      errors: [],
      panics: [],
      firstSeen: new Date(0),
      lastSeen: new Date(0),
    };
    const ts1 = new Date('2026-02-05T12:00:00.000Z');
    const ts2 = new Date('2026-02-05T12:01:00.000Z');

    ensureVMExists(plan, makeEntry({ vmRef: { id: 'vm-1', name: 'test-vm' } }), ts1);
    ensureVMExists(plan, makeEntry({ vmRef: { id: 'vm-1', name: 'test-vm' } }), ts2);

    expect(plan.vms['vm-1'].firstSeen).toEqual(ts1);
    expect(plan.vms['vm-1'].lastSeen).toEqual(ts2);
  });
});

describe('processPlanLog', () => {
  it('processes Migration [STARTED] event', () => {
    const store = new LogStore();
    const plan = store.getOrCreatePlan('test-ns', 'my-plan');
    const entry = makeEntry({
      msg: 'Migration [STARTED]',
      plan: { name: 'my-plan', namespace: 'test-ns' },
      migration: 'migration-123',
    });
    const ts = new Date('2026-02-05T12:00:00.000Z');

    processPlanLog(store, entry, ts);

    expect(plan.status).toBe('Running');
    expect(plan.migration).toBe('migration-123');
    const events = store.getEvents();
    expect(events.some(e => e.type === 'migration_start')).toBe(true);
  });

  it('processes Migration [SUCCEEDED] event', () => {
    const store = new LogStore();
    const plan = store.getOrCreatePlan('test-ns', 'my-plan');
    plan.vms['vm-1'] = {
      id: 'vm-1',
      name: 'test-vm',
      currentPhase: 'CreateDataVolumes',
      currentStep: '',
      migrationType: 'Unknown',
      transferMethod: 'Unknown',
      phaseHistory: [{ name: 'CreateDataVolumes', step: '', startedAt: new Date() }],
      dataVolumes: [],
      createdResources: [],
      phaseLogs: {},
      firstSeen: new Date(),
      lastSeen: new Date(),
    };
    const entry = makeEntry({
      msg: 'Migration [SUCCEEDED]',
      plan: { name: 'my-plan', namespace: 'test-ns' },
    });
    const ts = new Date('2026-02-05T12:05:00.000Z');

    processPlanLog(store, entry, ts);

    expect(plan.status).toBe('Succeeded');
    expect(plan.vms['vm-1'].currentPhase).toBe('Completed');
    const events = store.getEvents();
    expect(events.some(e => e.type === 'migration_succeeded')).toBe(true);
  });

  it('processes VM phase changes', () => {
    const store = new LogStore();
    const plan = store.getOrCreatePlan('test-ns', 'my-plan');
    const entry = makeEntry({
      msg: 'Migration [RUN]',
      plan: { name: 'my-plan', namespace: 'test-ns' },
      vmRef: { id: 'vm-1', name: 'test-vm' },
      phase: 'CreateDataVolumes',
    });
    const ts = new Date('2026-02-05T12:00:00.000Z');

    processPlanLog(store, entry, ts);

    expect(plan.vms['vm-1']).toBeDefined();
    expect(plan.vms['vm-1'].currentPhase).toBe('CreateDataVolumes');
    expect(plan.vms['vm-1'].phaseHistory).toHaveLength(1);
    expect(plan.vms['vm-1'].phaseHistory[0].name).toBe('CreateDataVolumes');
  });

  it('handles error-level logs', () => {
    const store = new LogStore();
    const plan = store.getOrCreatePlan('test-ns', 'my-plan');
    const entry = makeEntry({
      level: 'error',
      msg: 'Reconcile failed',
      plan: { name: 'my-plan', namespace: 'test-ns' },
      error: 'some error message',
    });
    const ts = new Date('2026-02-05T12:00:00.000Z');

    processPlanLog(store, entry, ts);

    expect(plan.status).toBe('Failed');
    expect(plan.errors).toHaveLength(1);
    expect(plan.errors[0].message).toContain('Reconcile failed');
  });
});
