import { describe, it, expect } from 'vitest';
import { parsePlanYaml, isYamlContent } from '../planYamlParser';

describe('isYamlContent', () => {
  it('returns false for JSON content', () => {
    expect(isYamlContent('{"level":"info","msg":"test"}')).toBe(false);
    expect(isYamlContent('[{"a":1}]')).toBe(false);
  });

  it('returns true for YAML with apiVersion and kind', () => {
    expect(isYamlContent('apiVersion: forklift.konveyor.io/v1beta1\nkind: Plan')).toBe(true);
  });

  it('returns true for YAML starting with ---', () => {
    expect(isYamlContent('---\napiVersion: v1\nkind: ConfigMap')).toBe(true);
  });

  it('returns false for JSON log lines', () => {
    const jsonLog = '{"level":"info","ts":"2026-02-05T12:00:00.000Z","logger":"plan|ns/plan","msg":"test"}';
    expect(isYamlContent(jsonLog)).toBe(false);
  });
});

describe('parsePlanYaml', () => {
  it('parses a simple Plan YAML with metadata, spec, and status', () => {
    const yaml = `
apiVersion: forklift.konveyor.io/v1beta1
kind: Plan
metadata:
  name: my-plan
  namespace: test-ns
  creationTimestamp: "2026-02-05T12:00:00Z"
spec:
  description: Test migration
  type: warm
  targetNamespace: target-ns
status:
  conditions:
    - type: Succeeded
      status: "True"
      message: Migration completed
`;
    const result = parsePlanYaml(yaml);

    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].name).toBe('my-plan');
    expect(result.plans[0].namespace).toBe('test-ns');
    expect(result.plans[0].status).toBe('Succeeded');
    expect(result.plans[0].spec?.description).toBe('Test migration');
    expect(result.plans[0].spec?.targetNamespace).toBe('target-ns');
    expect(result.stats.plansFound).toBe(1);
    expect(result.events).toHaveLength(0);
  });

  it('handles a PlanList with multiple items', () => {
    const yaml = `
apiVersion: forklift.konveyor.io/v1beta1
kind: PlanList
items:
  - apiVersion: forklift.konveyor.io/v1beta1
    kind: Plan
    metadata:
      name: plan-a
      namespace: ns1
    spec:
      type: cold
  - apiVersion: forklift.konveyor.io/v1beta1
    kind: Plan
    metadata:
      name: plan-b
      namespace: ns2
    spec:
      type: warm
`;
    const result = parsePlanYaml(yaml);

    expect(result.plans).toHaveLength(2);
    expect(result.plans[0].name).toBe('plan-a');
    expect(result.plans[0].namespace).toBe('ns1');
    expect(result.plans[1].name).toBe('plan-b');
    expect(result.plans[1].namespace).toBe('ns2');
  });

  it('correctly computes plan status from conditions (Succeeded)', () => {
    const yaml = `
apiVersion: forklift.konveyor.io/v1beta1
kind: Plan
metadata:
  name: p
  namespace: ns
status:
  conditions:
    - type: Succeeded
      status: "True"
`;
    const result = parsePlanYaml(yaml);
    expect(result.plans[0].status).toBe('Succeeded');
  });

  it('correctly computes plan status from conditions (Failed)', () => {
    const yaml = `
apiVersion: forklift.konveyor.io/v1beta1
kind: Plan
metadata:
  name: p
  namespace: ns
status:
  conditions:
    - type: Failed
      status: "True"
`;
    const result = parsePlanYaml(yaml);
    expect(result.plans[0].status).toBe('Failed');
  });

  it('correctly computes plan status from conditions (Running)', () => {
    const yaml = `
apiVersion: forklift.konveyor.io/v1beta1
kind: Plan
metadata:
  name: p
  namespace: ns
status:
  conditions:
    - type: Executing
      status: "True"
`;
    const result = parsePlanYaml(yaml);
    expect(result.plans[0].status).toBe('Running');
  });

  it('extracts VM status and pipeline info', () => {
    const yaml = `
apiVersion: forklift.konveyor.io/v1beta1
kind: Plan
metadata:
  name: p
  namespace: ns
spec:
  type: warm
status:
  migration:
    started: "2026-02-05T12:00:00Z"
    completed: "2026-02-05T12:05:00Z"
    vms:
      - id: vm-1
        name: test-vm
        phase: Completed
        started: "2026-02-05T12:00:00Z"
        completed: "2026-02-05T12:05:00Z"
        pipeline:
          - name: CreateDataVolumes
            phase: Completed
            started: "2026-02-05T12:00:00Z"
            completed: "2026-02-05T12:01:00Z"
`;
    const result = parsePlanYaml(yaml);

    expect(result.plans[0].vms['vm-1']).toBeDefined();
    const vm = result.plans[0].vms['vm-1'];
    expect(vm.name).toBe('test-vm');
    expect(vm.currentPhase).toBe('Completed');
    expect(vm.fromYaml).toBe(true);
    expect(vm.phaseHistory.length).toBeGreaterThan(0);
  });
});
