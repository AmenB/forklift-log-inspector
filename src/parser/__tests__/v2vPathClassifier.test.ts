import { describe, it, expect } from 'vitest';
import {
  V2V_PATH_RE,
  NON_LOG_EXTENSIONS,
  isV2VLogByPath,
  extractV2VPathMeta,
} from '../v2v/pathClassifier';

// ────────────────────────────────────────────────────────────────────────────
// V2V_PATH_RE matching
// ────────────────────────────────────────────────────────────────────────────

describe('V2V_PATH_RE', () => {
  it('matches pods-style V2V path', () => {
    const path = 'namespaces/ns/pods/plan-vm-1234-abc/virt-v2v/logs/current.log';
    expect(V2V_PATH_RE.test(path)).toBe(true);
  });

  it('matches logs-style V2V path', () => {
    const path = 'namespaces/ns/logs/plan-vm-5678-xyz/current.log';
    expect(V2V_PATH_RE.test(path)).toBe(true);
  });

  it('captures namespace, plan name, and VM id', () => {
    const path = 'namespaces/target-ns/pods/myplan-vm-1234-abc/virt-v2v/logs/current.log';
    const match = V2V_PATH_RE.exec(path);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('target-ns');
    expect(match![2]).toBe('myplan');
    expect(match![3]).toBe('1234');
  });

  it('does not match random paths', () => {
    expect(V2V_PATH_RE.test('/var/log/messages')).toBe(false);
    expect(V2V_PATH_RE.test('some/random/path/file.log')).toBe(false);
  });

  it('does not match paths without -vm- pattern', () => {
    expect(V2V_PATH_RE.test('namespaces/ns/pods/plan-abc/virt-v2v/logs/current.log')).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// planName / vmId extraction
// ────────────────────────────────────────────────────────────────────────────

describe('extractV2VPathMeta', () => {
  it('extracts planName and vmId from multi-part plan name', () => {
    const path = 'namespaces/ns/pods/wmsql2-dev-take2-vm-5451-h2fmt/virt-v2v/logs/current.log';
    const meta = extractV2VPathMeta(path);
    expect(meta.planName).toBe('wmsql2-dev-take2');
    expect(meta.vmId).toBe('vm-5451');
  });

  it('extracts planName and vmId from simple plan name', () => {
    const path = 'namespaces/ns/pods/ccm02220-vm-10975-5kxtj/virt-v2v/logs/current.log';
    const meta = extractV2VPathMeta(path);
    expect(meta.planName).toBe('ccm02220');
    expect(meta.vmId).toBe('vm-10975');
  });

  it('returns empty object for non-matching path', () => {
    const meta = extractV2VPathMeta('/var/log/messages');
    expect(meta.planName).toBeUndefined();
    expect(meta.vmId).toBeUndefined();
  });

  it('handles logs-style path', () => {
    const path = 'namespaces/openshift-mtv/logs/myplan-vm-999-abcde/current.log';
    const meta = extractV2VPathMeta(path);
    expect(meta.planName).toBe('myplan');
    expect(meta.vmId).toBe('vm-999');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// isV2VLogByPath
// ────────────────────────────────────────────────────────────────────────────

describe('isV2VLogByPath', () => {
  it('matches paths containing /virt-v2v/', () => {
    expect(isV2VLogByPath('some/path/virt-v2v/logs/current.log')).toBe(true);
  });

  it('matches paths containing /virt-v2v-inspector/', () => {
    expect(isV2VLogByPath('some/path/virt-v2v-inspector/logs/current.log')).toBe(true);
  });

  it('matches V2V pod path via regex', () => {
    expect(isV2VLogByPath('namespaces/ns/pods/plan-vm-1234-abc/logs/current.log')).toBe(true);
  });

  it('rejects .yaml files in V2V pod dirs', () => {
    expect(isV2VLogByPath('namespaces/ns/pods/plan-vm-1234-abc/plan-vm-1234-abc.yaml')).toBe(false);
  });

  it('rejects .yml files', () => {
    expect(isV2VLogByPath('namespaces/ns/pods/plan-vm-1234-abc/config.yml')).toBe(false);
  });

  it('rejects .json files', () => {
    expect(isV2VLogByPath('namespaces/ns/pods/plan-vm-1234-abc/status.json')).toBe(false);
  });

  it('rejects .xml files', () => {
    expect(isV2VLogByPath('namespaces/ns/pods/plan-vm-1234-abc/resource.xml')).toBe(false);
  });

  it('rejects .html files', () => {
    expect(isV2VLogByPath('namespaces/ns/pods/plan-vm-1234-abc/report.html')).toBe(false);
  });

  it('rejects .png files', () => {
    expect(isV2VLogByPath('namespaces/ns/pods/plan-vm-1234-abc/screenshot.png')).toBe(false);
  });

  it('rejects .pdf files', () => {
    expect(isV2VLogByPath('namespaces/ns/pods/plan-vm-1234-abc/report.pdf')).toBe(false);
  });

  it('rejects random paths without V2V indicators', () => {
    expect(isV2VLogByPath('/var/log/messages')).toBe(false);
    expect(isV2VLogByPath('some/controller/logs.txt')).toBe(false);
  });

  it('handles case-insensitive virt-v2v directory matching', () => {
    // The check uses toLowerCase for directory names
    expect(isV2VLogByPath('some/path/VIRT-V2V/logs/current.log')).toBe(true);
    expect(isV2VLogByPath('some/path/Virt-V2V-Inspector/logs/current.log')).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// NON_LOG_EXTENSIONS
// ────────────────────────────────────────────────────────────────────────────

describe('NON_LOG_EXTENSIONS', () => {
  it('includes expected extensions', () => {
    expect(NON_LOG_EXTENSIONS).toContain('.yaml');
    expect(NON_LOG_EXTENSIONS).toContain('.yml');
    expect(NON_LOG_EXTENSIONS).toContain('.json');
    expect(NON_LOG_EXTENSIONS).toContain('.xml');
    expect(NON_LOG_EXTENSIONS).toContain('.png');
    expect(NON_LOG_EXTENSIONS).toContain('.pdf');
  });

  it('does not include .log', () => {
    expect(NON_LOG_EXTENSIONS).not.toContain('.log');
  });

  it('does not include .txt', () => {
    expect(NON_LOG_EXTENSIONS).not.toContain('.txt');
  });
});
