import { describe, it, expect } from 'vitest';
import { isV2VLog, parseV2VLog } from '../v2vLogParser';

// ────────────────────────────────────────────────────────────────────────────
// isV2VLog detection
// ────────────────────────────────────────────────────────────────────────────

describe('isV2VLog', () => {
  it('detects "Building command:virt-v2v" format', () => {
    expect(isV2VLog('Building command:virt-v2v[-v -x -o kubevirt]')).toBe(true);
  });

  it('detects "Building command: virt-v2v-inspector" with space', () => {
    expect(isV2VLog('Building command: virt-v2v-inspector [-v -x]')).toBe(true);
  });

  it('detects "info: virt-v2v:" prefix', () => {
    expect(isV2VLog('info: virt-v2v: virt-v2v 2.7.1rhel=9 (x86_64)')).toBe(true);
  });

  it('detects virt-v2v-in-place in first lines', () => {
    expect(isV2VLog('Building command: virt-v2v-in-place [--verbose]')).toBe(true);
  });

  it('rejects non-v2v content', () => {
    expect(isV2VLog('{"level":"info","msg":"Reconcile started"}')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isV2VLog('')).toBe(false);
  });

  it('detects v2v log with container/k8s timestamp prefixes', () => {
    const log = [
      '2026-01-21T00:57:24.837772290Z Building command: virt-v2v-inspector [-v -x]',
      '2026-01-21T00:57:24.866991227Z info: virt-v2v-inspector: virt-v2v 2.8.1rhel=10 (x86_64)',
    ].join('\n');
    expect(isV2VLog(log)).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Tool run boundaries
// ────────────────────────────────────────────────────────────────────────────

describe('parseV2VLog – tool run boundaries', () => {
  it('detects a single virt-v2v run', () => {
    const log = [
      'Building command: virt-v2v [-v -x -o kubevirt]',
      '[   0.0] Setting up the source: -i libvirt',
      '[ 100.0] Finishing off',
    ].join('\n');

    const result = parseV2VLog(log);
    expect(result.toolRuns).toHaveLength(1);
    expect(result.toolRuns[0].tool).toBe('virt-v2v');
    expect(result.toolRuns[0].commandLine).toBe('-v -x -o kubevirt');
  });

  it('detects multiple tool runs', () => {
    const log = [
      'Building command: virt-v2v-in-place [--verbose --format raw]',
      '[   0.0] Setting up the source',
      '[ 100.0] Finishing off',
      'Building command: virt-v2v-inspector [-v -x -if raw]',
      '[   0.0] Setting up the source',
      '[ 200.0] Finishing off',
      'Building command: virt-customize [--verbose --format raw]',
      '[   0.0] Examining the guest',
      '[ 50.0] Finishing off',
    ].join('\n');

    const result = parseV2VLog(log);
    expect(result.toolRuns).toHaveLength(3);
    expect(result.toolRuns[0].tool).toBe('virt-v2v-in-place');
    expect(result.toolRuns[1].tool).toBe('virt-v2v-inspector');
    expect(result.toolRuns[2].tool).toBe('virt-v2v-customize');
  });

  it('handles concatenated Building command lines (no space)', () => {
    const log = [
      'Building command:virt-v2v[-v -x]Building command:/usr/local/bin/virt-v2v-monitor[]virt-v2v monitoring: start',
      'info: virt-v2v: virt-v2v 2.7.1rhel=9 (x86_64)',
      '[   0.0] Setting up the source',
    ].join('\n');

    const result = parseV2VLog(log);
    // Should detect virt-v2v (monitor is skipped)
    expect(result.toolRuns.length).toBeGreaterThanOrEqual(1);
    expect(result.toolRuns[0].tool).toBe('virt-v2v');
  });

  it('falls back to content detection when no Building command', () => {
    const log = [
      'info: virt-v2v: virt-v2v 2.7.1rhel=9 (x86_64)',
      '[   0.0] Setting up the source',
    ].join('\n');

    const result = parseV2VLog(log);
    expect(result.toolRuns).toHaveLength(1);
    expect(result.toolRuns[0].tool).toBe('virt-v2v');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Pipeline stages
// ────────────────────────────────────────────────────────────────────────────

describe('parseV2VLog – pipeline stages', () => {
  it('parses stage names and elapsed seconds', () => {
    const log = [
      'Building command: virt-v2v [-v]',
      '[   0.0] Setting up the source: -i libvirt',
      '[   1.5] Opening the source',
      '[  30.0] Inspecting the source',
      '[ 120.0] Finishing off',
    ].join('\n');

    const result = parseV2VLog(log);
    const stages = result.toolRuns[0].stages;
    expect(stages).toHaveLength(4);
    expect(stages[0].name).toBe('Setting up the source: -i libvirt');
    expect(stages[0].elapsedSeconds).toBe(0.0);
    expect(stages[1].name).toBe('Opening the source');
    expect(stages[1].elapsedSeconds).toBe(1.5);
    expect(stages[3].name).toBe('Finishing off');
    expect(stages[3].elapsedSeconds).toBe(120.0);
  });

  it('assigns correct line numbers to stages', () => {
    const log = [
      'Building command: virt-v2v [-v]',
      'some noise line',
      '[   0.0] Setting up the source',
      'more noise',
      '[  10.0] Finishing off',
    ].join('\n');

    const result = parseV2VLog(log);
    const stages = result.toolRuns[0].stages;
    // Line numbers are global (0-based) — stage at line 2 and 4
    expect(stages[0].lineNumber).toBe(2);
    expect(stages[1].lineNumber).toBe(4);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Exit status inference
// ────────────────────────────────────────────────────────────────────────────

describe('parseV2VLog – exit status', () => {
  it('infers success when "Finishing off" is present', () => {
    const log = [
      'Building command: virt-v2v [-v]',
      '[   0.0] Setting up the source',
      '[ 100.0] Finishing off',
    ].join('\n');

    const result = parseV2VLog(log);
    expect(result.toolRuns[0].exitStatus).toBe('success');
  });

  it('infers success from "virt-v2v monitoring: Finished"', () => {
    const log = [
      'Building command: virt-v2v [-v]',
      '[   0.0] Setting up the source',
      '[ 100.0] Finishing off',
      'virt-v2v monitoring: Finished',
    ].join('\n');

    const result = parseV2VLog(log);
    expect(result.toolRuns[0].exitStatus).toBe('success');
  });

  it('infers error when fatal error without Finishing off', () => {
    const log = [
      'Building command: virt-v2v-inspector [-v]',
      '[   0.0] Setting up the source',
      'virt-v2v-inspector: error: inspection could not detect the source guest',
    ].join('\n');

    const result = parseV2VLog(log);
    expect(result.toolRuns[0].exitStatus).toBe('error');
  });

  it('returns unknown when no clear signal', () => {
    const log = [
      'Building command: virt-v2v [-v]',
      'some random line',
    ].join('\n');

    const result = parseV2VLog(log);
    expect(result.toolRuns[0].exitStatus).toBe('unknown');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Component versions
// ────────────────────────────────────────────────────────────────────────────

describe('parseV2VLog – component versions', () => {
  it('parses virt-v2v version', () => {
    const log = [
      'Building command: virt-v2v [-v]',
      'info: virt-v2v: virt-v2v 2.7.1rhel=9,release=8.el9_6 (x86_64)',
    ].join('\n');

    const { versions } = parseV2VLog(log).toolRuns[0];
    expect(versions.virtV2v).toBe('2.7.1rhel=9,release=8.el9_6');
  });

  it('parses libvirt version', () => {
    const log = [
      'Building command: virt-v2v [-v]',
      'info: libvirt version: 10.10.0',
    ].join('\n');

    const { versions } = parseV2VLog(log).toolRuns[0];
    expect(versions.libvirt).toBe('10.10.0');
  });

  it('parses nbdkit version', () => {
    const log = [
      'Building command: virt-v2v [-v]',
      'nbdkit 1.38.5 (nbdkit-vddk-plugin.1)',
    ].join('\n');

    const { versions } = parseV2VLog(log).toolRuns[0];
    expect(versions.nbdkit).toBe('1.38.5');
  });

  it('parses VDDK version', () => {
    const log = [
      'Building command: virt-v2v [-v]',
      'VMware VixDiskLib (7.0.3) Release build-20091367',
    ].join('\n');

    const { versions } = parseV2VLog(log).toolRuns[0];
    expect(versions.vddk).toBe('7.0.3');
  });

  it('parses QEMU version', () => {
    const log = [
      'Building command: virt-v2v [-v]',
      'libguestfs: qemu version: 9.1',
    ].join('\n');

    const { versions } = parseV2VLog(log).toolRuns[0];
    expect(versions.qemu).toBe('9.1');
  });

  it('parses libguestfs version from struct', () => {
    const log = [
      'Building command: virt-v2v [-v]',
      'libguestfs: trace: v2v: version = <struct guestfs_version = major: 1, minor: 54, release: 0, extra: rhel=9>',
    ].join('\n');

    const { versions } = parseV2VLog(log).toolRuns[0];
    expect(versions.libguestfs).toBe('1.54.0');
  });

  it('returns empty versions when none found', () => {
    const log = [
      'Building command: virt-v2v [-v]',
      '[   0.0] Setting up the source',
    ].join('\n');

    const { versions } = parseV2VLog(log).toolRuns[0];
    expect(Object.keys(versions).length).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// NBDKIT connections
// ────────────────────────────────────────────────────────────────────────────

describe('parseV2VLog – NBDKIT connections', () => {
  it('parses nbdkit connection from "running nbdkit" block with URI', () => {
    // Real format: "running nbdkit:" on its own line, then indented LANG=C line with --unix
    const log = [
      'Building command: virt-v2v [-v]',
      'running nbdkit:',
      " LANG=C 'nbdkit' '--exit-with-parent' '--foreground' '--unix' '/tmp/v2v.abc/in0' '--verbose' 'vddk'",
      'nbdkit: debug: TLS disabled',
      'nbdkit: debug: NBD URI: nbd+unix:///?socket=/tmp/v2v.abc/in0',
      '[   0.0] Setting up the source',
    ].join('\n');

    const result = parseV2VLog(log);
    const conns = result.toolRuns[0].nbdkitConnections;
    expect(conns.length).toBeGreaterThanOrEqual(1);
    expect(conns[0].socketPath).toBe('/tmp/v2v.abc/in0');
    expect(conns[0].uri).toBe('nbd+unix:///?socket=/tmp/v2v.abc/in0');
  });

  it('extracts server from nbdkit config line', () => {
    const log = [
      'Building command: virt-v2v [-v]',
      'running nbdkit:',
      " LANG=C 'nbdkit' '--exit-with-parent' '--foreground' '--unix' '/tmp/v2v.abc/in0' '--verbose' 'vddk'",
      'nbdkit: debug: config key=server, value=10.6.46.159',
      'nbdkit: debug: NBD URI: nbd+unix:///?socket=/tmp/v2v.abc/in0',
      '[   0.0] Setting up the source',
    ].join('\n');

    const result = parseV2VLog(log);
    const conns = result.toolRuns[0].nbdkitConnections;
    expect(conns.length).toBeGreaterThanOrEqual(1);
    expect(conns[0].server).toBe('10.6.46.159');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Guest info
// ────────────────────────────────────────────────────────────────────────────

describe('parseV2VLog – guest info', () => {
  it('parses Windows guest info from inspect_os block', () => {
    // The structured block format uses 4-space indentation for key: value pairs
    const log = [
      'Building command: virt-v2v [-v]',
      'inspect_os: fses:',
      'fs: /dev/sda2 (ntfs) role: root',
      '    type: windows',
      '    distro: windows',
      '    product_name: Windows Server 2019',
      '    product_variant: ServerStandard',
      '    version: 10.0',
      '    arch: x86_64',
      '    hostname: WIN-SERVER',
      '    windows_systemroot: /Windows',
      '    windows_current_control_set: ControlSet001',
      '    drive_mappings: [(C, /dev/sda2)]',
    ].join('\n');

    const result = parseV2VLog(log);
    const info = result.toolRuns[0].guestInfo;
    expect(info).not.toBeNull();
    expect(info!.type).toBe('windows');
    expect(info!.productName).toBe('Windows Server 2019');
    expect(info!.productVariant).toBe('ServerStandard');
    expect(info!.arch).toBe('x86_64');
    expect(info!.hostname).toBe('WIN-SERVER');
    expect(info!.windowsSystemroot).toBe('/Windows');
    expect(info!.windowsCurrentControlSet).toBe('ControlSet001');
    expect(info!.driveMappings).toHaveLength(1);
    expect(info!.driveMappings[0].letter).toBe('C');
    expect(info!.driveMappings[0].device).toBe('/dev/sda2');
  });

  it('parses Linux guest info with fstab', () => {
    const log = [
      'Building command: virt-v2v [-v]',
      'inspect_os: fses:',
      'fs: /dev/sda1 (xfs) role: root',
      '    type: linux',
      '    distro: rhel',
      '    product_name: Red Hat Enterprise Linux 8.10',
      '    version: 8.10',
      '    arch: x86_64',
      '    hostname: myhost.local',
      '    package_format: rpm',
      '    package_management: dnf',
      '    fstab: [(/dev/sda1, /), (/dev/sda2, /boot)]',
    ].join('\n');

    const result = parseV2VLog(log);
    const info = result.toolRuns[0].guestInfo;
    expect(info).not.toBeNull();
    expect(info!.type).toBe('linux');
    expect(info!.distro).toBe('rhel');
    expect(info!.hostname).toBe('myhost.local');
    expect(info!.packageFormat).toBe('rpm');
    expect(info!.packageManagement).toBe('dnf');
    expect(info!.fstab).toHaveLength(2);
    expect(info!.fstab[0].device).toBe('/dev/sda1');
    expect(info!.fstab[0].mountpoint).toBe('/');
    expect(info!.fstab[1].mountpoint).toBe('/boot');
  });

  it('parses Amazon Linux CPE version correctly', () => {
    const log = [
      'Building command: virt-v2v [-v]',
      'inspect_os: fses:',
      'fs: /dev/sda1 (xfs) role: root',
      '    type: linux',
      '    distro: amazonlinux',
      '    product_name: cpe:2.3:o:amazon:amazon_linux:2023',
      '    version: 2.3',
      '    arch: x86_64',
    ].join('\n');

    const result = parseV2VLog(log);
    const info = result.toolRuns[0].guestInfo;
    expect(info).not.toBeNull();
    expect(info!.distro).toBe('amazonlinux');
    expect(info!.productName).toBe('cpe:2.3:o:amazon:amazon_linux:2023');
  });

  it('returns null guestInfo when no inspect_os data', () => {
    const log = [
      'Building command: virt-customize [--verbose]',
      '[   0.0] Examining the guest',
    ].join('\n');

    const result = parseV2VLog(log);
    expect(result.toolRuns[0].guestInfo).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Source VM from libvirt XML
// ────────────────────────────────────────────────────────────────────────────

describe('parseV2VLog – source VM metadata', () => {
  it('parses VM name, memory, vcpus, and firmware from libvirt XML', () => {
    // Libvirt XML uses single-quoted attributes
    const log = [
      'Building command: virt-v2v [-v]',
      'libvirt xml is:',
      "<domain type='vmware'>",
      '  <name>my-test-vm</name>',
      "  <memory unit='KiB'>4194304</memory>",
      '  <vcpu>2</vcpu>',
      '  <os>',
      '    <type>hvm</type>',
      '  </os>',
      '</domain>',
      '[   0.0] Setting up the source',
    ].join('\n');

    const result = parseV2VLog(log);
    const vm = result.toolRuns[0].sourceVM;
    expect(vm).not.toBeNull();
    expect(vm!.name).toBe('my-test-vm');
    expect(vm!.memoryKB).toBe(4194304);
    expect(vm!.vcpus).toBe(2);
    expect(vm!.firmware).toBe('bios');
  });

  it('detects UEFI firmware from loader element', () => {
    const log = [
      'Building command: virt-v2v [-v]',
      'libvirt xml is:',
      "<domain type='vmware'>",
      '  <name>uefi-vm</name>',
      '  <os>',
      '    <type>hvm</type>',
      "    <loader readonly='yes' type='pflash'>/usr/share/OVMF/OVMF_CODE.fd</loader>",
      '  </os>',
      '</domain>',
      '[   0.0] Setting up the source',
    ].join('\n');

    const result = parseV2VLog(log);
    const vm = result.toolRuns[0].sourceVM;
    expect(vm).not.toBeNull();
    expect(vm!.firmware).toBe('uefi');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Errors and warnings
// ────────────────────────────────────────────────────────────────────────────

describe('parseV2VLog – errors and warnings', () => {
  it('detects errors and warnings', () => {
    const log = [
      'Building command: virt-v2v [-v]',
      'virt-v2v: error: some fatal error occurred',
      'virt-v2v: warning: random seed could not be set for this type of guest',
    ].join('\n');

    const result = parseV2VLog(log);
    const errors = result.toolRuns[0].errors;
    const errs = errors.filter((e) => e.level === 'error');
    const warns = errors.filter((e) => e.level === 'warning');
    expect(errs.length).toBeGreaterThanOrEqual(1);
    expect(warns.length).toBeGreaterThanOrEqual(1);
    expect(errs[0].source).toBe('virt-v2v');
    expect(warns[0].source).toBe('virt-v2v');
  });

  it('filters false-positive errors', () => {
    const log = [
      'Building command: virt-v2v [-v]',
      'libguestfs: trace: v2v: get_backend_setting = NULL (error)',
    ].join('\n');

    const result = parseV2VLog(log);
    const errs = result.toolRuns[0].errors.filter((e) => e.level === 'error');
    // "NULL (error)" is a false positive and should be filtered
    expect(errs).toHaveLength(0);
  });

  it('identifies error sources correctly', () => {
    const log = [
      'Building command: virt-v2v [-v]',
      'nbdkit: error: something went wrong',
      'libguestfs: error: API call failed',
      'virt-v2v-inspector: error: inspection failed',
    ].join('\n');

    const result = parseV2VLog(log);
    const errs = result.toolRuns[0].errors.filter((e) => e.level === 'error');
    const sources = errs.map((e) => e.source);
    expect(sources).toContain('nbdkit');
    expect(sources).toContain('libguestfs');
    expect(sources).toContain('virt-v2v-inspector');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Host commands
// ────────────────────────────────────────────────────────────────────────────

describe('parseV2VLog – host commands', () => {
  it('parses libguestfs command: run: blocks', () => {
    const log = [
      'Building command: virt-v2v [-v]',
      'libguestfs: command: run: qemu-img',
      'libguestfs: command: run: \\ info',
      'libguestfs: command: run: \\ --output json',
      'libguestfs: command: run: \\ /tmp/overlay.qcow2',
    ].join('\n');

    const result = parseV2VLog(log);
    const cmds = result.toolRuns[0].hostCommands;
    expect(cmds.length).toBeGreaterThanOrEqual(1);
    expect(cmds[0].command).toBe('qemu-img');
    expect(cmds[0].args.join(' ')).toContain('info');
    expect(cmds[0].args.join(' ')).toContain('--output json');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// File copies
// ────────────────────────────────────────────────────────────────────────────

describe('parseV2VLog – file copies', () => {
  it('detects virtio_win file copy from read_file + write', () => {
    const log = [
      'Building command: virt-v2v [-v]',
      'libguestfs: trace: virtio_win: read_file "///Balloon/2k19/amd64/balloon.cat"',
      'libguestfs: trace: virtio_win: read_file = "data"<truncated, original size 12345 bytes>',
      'libguestfs: trace: v2v: write "/Windows/Drivers/VirtIO/balloon.cat" "data"<truncated, original size 12345 bytes>',
    ].join('\n');

    const result = parseV2VLog(log);
    const copies = result.toolRuns[0].virtioWin.fileCopies;
    expect(copies.length).toBeGreaterThanOrEqual(1);
    const copy = copies.find((c) => c.destination.includes('balloon.cat'));
    expect(copy).toBeDefined();
    expect(copy!.origin).toBe('virtio_win');
    expect(copy!.sizeBytes).toBe(12345);
  });

  it('detects guest file write (non-virtio)', () => {
    const log = [
      'Building command: virt-v2v [-v]',
      'libguestfs: trace: v2v: write "/etc/hostname" "myhost\\x0a"',
      'libguestfs: trace: v2v: internal_write "/etc/hostname" "myhost\\x0a"',
    ].join('\n');

    const result = parseV2VLog(log);
    const copies = result.toolRuns[0].virtioWin.fileCopies;
    const hostnameCopy = copies.find((c) => c.destination === '/etc/hostname');
    expect(hostnameCopy).toBeDefined();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Hivex registry sessions
// ────────────────────────────────────────────────────────────────────────────

describe('parseV2VLog – hivex registry', () => {
  it('tracks hivex open → close as a session', () => {
    const log = [
      'Building command: virt-v2v [-v]',
      'libguestfs: trace: v2v: hivex_open "/Windows/System32/config/SYSTEM"',
      'libguestfs: trace: v2v: hivex_open = 0',
      'libguestfs: trace: v2v: hivex_root',
      'libguestfs: trace: v2v: hivex_root = 512',
      'libguestfs: trace: v2v: hivex_node_get_child 512 "ControlSet001"',
      'libguestfs: trace: v2v: hivex_node_get_child = 600',
      'libguestfs: trace: v2v: hivex_close',
      'libguestfs: trace: v2v: hivex_close = 0',
    ].join('\n');

    const result = parseV2VLog(log);
    const accesses = result.toolRuns[0].registryHiveAccesses;
    expect(accesses.length).toBeGreaterThanOrEqual(1);
    expect(accesses[0].hivePath).toBe('/Windows/System32/config/SYSTEM');
    expect(accesses[0].keyPath).toBe('ControlSet001');
  });

  it('skips empty sessions with no navigation or values', () => {
    const log = [
      'Building command: virt-v2v [-v]',
      'libguestfs: trace: v2v: hivex_open "/Windows/System32/config/SYSTEM"',
      'libguestfs: trace: v2v: hivex_open = 0',
      'libguestfs: trace: v2v: hivex_root',
      'libguestfs: trace: v2v: hivex_root = 512',
      'libguestfs: trace: v2v: hivex_close',
      'libguestfs: trace: v2v: hivex_close = 0',
    ].join('\n');

    const result = parseV2VLog(log);
    const accesses = result.toolRuns[0].registryHiveAccesses;
    // Empty session (root only, no navigation) should be skipped
    expect(accesses).toHaveLength(0);
  });

  it('detects write mode from hivex_node_set_value', () => {
    const log = [
      'Building command: virt-v2v [-v]',
      'libguestfs: trace: v2v: hivex_open "/Windows/System32/config/SYSTEM" "write:true"',
      'libguestfs: trace: v2v: hivex_open = 0',
      'libguestfs: trace: v2v: hivex_root',
      'libguestfs: trace: v2v: hivex_root = 100',
      'libguestfs: trace: v2v: hivex_node_get_child 100 "ControlSet001"',
      'libguestfs: trace: v2v: hivex_node_get_child = 200',
      'libguestfs: trace: v2v: hivex_node_set_value 200 "Start" 4 "\\x03\\x00\\x00\\x00"',
      'libguestfs: trace: v2v: hivex_node_set_value = 0',
      'libguestfs: trace: v2v: hivex_close',
      'libguestfs: trace: v2v: hivex_close = 0',
    ].join('\n');

    const result = parseV2VLog(log);
    const accesses = result.toolRuns[0].registryHiveAccesses;
    expect(accesses.length).toBeGreaterThanOrEqual(1);
    expect(accesses[0].mode).toBe('write');
  });

  it('builds key path from hivex_node_get_child calls', () => {
    const log = [
      'Building command: virt-v2v [-v]',
      'libguestfs: trace: v2v: hivex_open "/Windows/System32/config/SYSTEM"',
      'libguestfs: trace: v2v: hivex_open = 0',
      'libguestfs: trace: v2v: hivex_root',
      'libguestfs: trace: v2v: hivex_root = 100',
      'libguestfs: trace: v2v: hivex_node_get_child 100 "ControlSet001"',
      'libguestfs: trace: v2v: hivex_node_get_child = 200',
      'libguestfs: trace: v2v: hivex_node_get_child 200 "services"',
      'libguestfs: trace: v2v: hivex_node_get_child = 300',
      'libguestfs: trace: v2v: hivex_node_get_child 300 "firstboot"',
      'libguestfs: trace: v2v: hivex_node_get_child = 400',
      'libguestfs: trace: v2v: hivex_close',
      'libguestfs: trace: v2v: hivex_close = 0',
    ].join('\n');

    const result = parseV2VLog(log);
    const accesses = result.toolRuns[0].registryHiveAccesses;
    expect(accesses.length).toBeGreaterThanOrEqual(1);
    expect(accesses[0].keyPath).toBe('ControlSet001\\services\\firstboot');
    expect(accesses[0].mode).toBe('read');
  });

  it('re-navigation from root handle flushes and starts fresh path', () => {
    const log = [
      'Building command: virt-v2v [-v]',
      'libguestfs: trace: v2v: hivex_open "/Windows/System32/config/SYSTEM"',
      'libguestfs: trace: v2v: hivex_open = 0',
      'libguestfs: trace: v2v: hivex_root',
      'libguestfs: trace: v2v: hivex_root = 100',
      // First traversal: ControlSet001\services
      'libguestfs: trace: v2v: hivex_node_get_child 100 "ControlSet001"',
      'libguestfs: trace: v2v: hivex_node_get_child = 200',
      'libguestfs: trace: v2v: hivex_node_get_child 200 "services"',
      'libguestfs: trace: v2v: hivex_node_get_child = 300',
      // Second traversal from root: ControlSet001\Control
      'libguestfs: trace: v2v: hivex_node_get_child 100 "ControlSet001"',
      'libguestfs: trace: v2v: hivex_node_get_child = 400',
      'libguestfs: trace: v2v: hivex_node_get_child 400 "Control"',
      'libguestfs: trace: v2v: hivex_node_get_child = 500',
      'libguestfs: trace: v2v: hivex_close',
      'libguestfs: trace: v2v: hivex_close = 0',
    ].join('\n');

    const result = parseV2VLog(log);
    const accesses = result.toolRuns[0].registryHiveAccesses;
    // Should produce two separate entries (not "ControlSet001\services\ControlSet001\Control")
    expect(accesses.length).toBeGreaterThanOrEqual(2);
    expect(accesses[0].keyPath).toBe('ControlSet001\\services');
    expect(accesses[1].keyPath).toBe('ControlSet001\\Control');
  });

  it('reads values via hivex_node_get_value + hivex_value_string with per-value lineNumber', () => {
    const log = [
      'Building command: virt-v2v [-v]',
      'libguestfs: trace: v2v: hivex_open "/Windows/System32/config/SYSTEM"',
      'libguestfs: trace: v2v: hivex_open = 0',
      'libguestfs: trace: v2v: hivex_root',
      'libguestfs: trace: v2v: hivex_root = 100',
      'libguestfs: trace: v2v: hivex_node_get_child 100 "ControlSet001"',
      'libguestfs: trace: v2v: hivex_node_get_child = 200',
      'libguestfs: trace: v2v: hivex_node_get_value 200 "ServiceName"',
      'libguestfs: trace: v2v: hivex_node_get_value = 999',
      'libguestfs: trace: v2v: hivex_value_string 999',  // line 10
      'libguestfs: trace: v2v: hivex_value_string = "MyService"',
      'libguestfs: trace: v2v: hivex_close',
      'libguestfs: trace: v2v: hivex_close = 0',
    ].join('\n');

    const result = parseV2VLog(log);
    const accesses = result.toolRuns[0].registryHiveAccesses;
    expect(accesses.length).toBeGreaterThanOrEqual(1);
    expect(accesses[0].keyPath).toBe('ControlSet001');
    expect(accesses[0].mode).toBe('read');
    expect(accesses[0].values.length).toBeGreaterThanOrEqual(1);
    const val = accesses[0].values.find((v) => v.name === 'ServiceName');
    expect(val).toBeDefined();
    expect(val!.value).toBe('MyService');
    // Value lineNumber should be the line where hivex_value_string returned
    expect(val!.lineNumber).toBeGreaterThan(0);
  });

  it('hivex_node_set_value marks mode as write, navigation-only stays read', () => {
    // Navigation-only (no writes)
    const readLog = [
      'Building command: virt-v2v [-v]',
      'libguestfs: trace: v2v: hivex_open "/Windows/System32/config/SYSTEM" "write:true"',
      'libguestfs: trace: v2v: hivex_open = 0',
      'libguestfs: trace: v2v: hivex_root',
      'libguestfs: trace: v2v: hivex_root = 100',
      'libguestfs: trace: v2v: hivex_node_get_child 100 "ControlSet001"',
      'libguestfs: trace: v2v: hivex_node_get_child = 200',
      'libguestfs: trace: v2v: hivex_close',
      'libguestfs: trace: v2v: hivex_close = 0',
    ].join('\n');
    const readResult = parseV2VLog(readLog);
    const readAccesses = readResult.toolRuns[0].registryHiveAccesses;
    expect(readAccesses.length).toBeGreaterThanOrEqual(1);
    // Even though opened with write:true, no actual write ops happened → mode is read
    expect(readAccesses[0].mode).toBe('read');

    // With actual write
    const writeLog = [
      'Building command: virt-v2v [-v]',
      'libguestfs: trace: v2v: hivex_open "/Windows/System32/config/SYSTEM" "write:true"',
      'libguestfs: trace: v2v: hivex_open = 0',
      'libguestfs: trace: v2v: hivex_root',
      'libguestfs: trace: v2v: hivex_root = 100',
      'libguestfs: trace: v2v: hivex_node_get_child 100 "ControlSet001"',
      'libguestfs: trace: v2v: hivex_node_get_child = 200',
      'libguestfs: trace: v2v: hivex_node_set_value 200 "Start" 4 "\\x03\\x00\\x00\\x00"',
      'libguestfs: trace: v2v: hivex_node_set_value = 0',
      'libguestfs: trace: v2v: hivex_commit 0',
      'libguestfs: trace: v2v: hivex_commit = 0',
      'libguestfs: trace: v2v: hivex_close',
      'libguestfs: trace: v2v: hivex_close = 0',
    ].join('\n');
    const writeResult = parseV2VLog(writeLog);
    const writeAccesses = writeResult.toolRuns[0].registryHiveAccesses;
    expect(writeAccesses.length).toBeGreaterThanOrEqual(1);
    expect(writeAccesses[0].mode).toBe('write');
    expect(writeAccesses[0].values.length).toBeGreaterThanOrEqual(1);
    expect(writeAccesses[0].values[0].name).toBe('Start');
  });

  it('skips empty sessions — no spurious (root) entries after commit + close', () => {
    const log = [
      'Building command: virt-v2v [-v]',
      'libguestfs: trace: v2v: hivex_open "/Windows/System32/config/SYSTEM" "write:true"',
      'libguestfs: trace: v2v: hivex_open = 0',
      'libguestfs: trace: v2v: hivex_root',
      'libguestfs: trace: v2v: hivex_root = 100',
      'libguestfs: trace: v2v: hivex_node_get_child 100 "ControlSet001"',
      'libguestfs: trace: v2v: hivex_node_get_child = 200',
      'libguestfs: trace: v2v: hivex_node_set_value 200 "Start" 4 "\\x03\\x00\\x00\\x00"',
      'libguestfs: trace: v2v: hivex_node_set_value = 0',
      'libguestfs: trace: v2v: hivex_commit 0',
      'libguestfs: trace: v2v: hivex_commit = 0',
      // After commit, session is flushed; hivex_close should NOT create a spurious entry
      'libguestfs: trace: v2v: hivex_close',
      'libguestfs: trace: v2v: hivex_close = 0',
    ].join('\n');

    const result = parseV2VLog(log);
    const accesses = result.toolRuns[0].registryHiveAccesses;
    // Only one entry for ControlSet001 — no empty/root entry from close
    const csEntries = accesses.filter(
      (a) => a.hivePath === '/Windows/System32/config/SYSTEM',
    );
    expect(csEntries).toHaveLength(1);
    expect(csEntries[0].keyPath).toBe('ControlSet001');
    // No entry with empty keyPath
    const emptyKeyEntries = accesses.filter((a) => !a.keyPath);
    expect(emptyKeyEntries).toHaveLength(0);
  });

  it('hivex_node_add_child marks mode as write', () => {
    const log = [
      'Building command: virt-v2v [-v]',
      'libguestfs: trace: v2v: hivex_open "/Windows/System32/config/SYSTEM" "write:true"',
      'libguestfs: trace: v2v: hivex_open = 0',
      'libguestfs: trace: v2v: hivex_root',
      'libguestfs: trace: v2v: hivex_root = 100',
      'libguestfs: trace: v2v: hivex_node_get_child 100 "ControlSet001"',
      'libguestfs: trace: v2v: hivex_node_get_child = 200',
      'libguestfs: trace: v2v: hivex_node_add_child 200 "newsubkey"',
      'libguestfs: trace: v2v: hivex_node_add_child = 300',
      'libguestfs: trace: v2v: hivex_close',
      'libguestfs: trace: v2v: hivex_close = 0',
    ].join('\n');

    const result = parseV2VLog(log);
    const accesses = result.toolRuns[0].registryHiveAccesses;
    expect(accesses.length).toBeGreaterThanOrEqual(1);
    // add_child is a write operation
    expect(accesses[0].mode).toBe('write');
    // Path should include the added child
    expect(accesses[0].keyPath).toBe('ControlSet001\\newsubkey');
  });

  it('write mode lineNumber points to the first write operation', () => {
    const log = [
      'Building command: virt-v2v [-v]',                                          // line 0
      'libguestfs: trace: v2v: hivex_open "/Windows/System32/config/SYSTEM" "write:true"', // line 1
      'libguestfs: trace: v2v: hivex_open = 0',                                  // line 2
      'libguestfs: trace: v2v: hivex_root',                                       // line 3
      'libguestfs: trace: v2v: hivex_root = 100',                                // line 4
      'libguestfs: trace: v2v: hivex_node_get_child 100 "ControlSet001"',         // line 5
      'libguestfs: trace: v2v: hivex_node_get_child = 200',                       // line 6
      'libguestfs: trace: v2v: hivex_node_set_value 200 "Start" 4 "\\x03\\x00\\x00\\x00"', // line 7
      'libguestfs: trace: v2v: hivex_node_set_value = 0',                         // line 8
      'libguestfs: trace: v2v: hivex_close',                                      // line 9
      'libguestfs: trace: v2v: hivex_close = 0',                                  // line 10
    ].join('\n');

    const result = parseV2VLog(log);
    const accesses = result.toolRuns[0].registryHiveAccesses;
    expect(accesses.length).toBeGreaterThanOrEqual(1);
    // lineNumber should point to the set_value line (7), not the navigation start (1)
    expect(accesses[0].lineNumber).toBe(7);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Disk progress
// ────────────────────────────────────────────────────────────────────────────

describe('parseV2VLog – disk progress', () => {
  it('parses disk copy progress from monitoring lines', () => {
    const log = [
      'Building command: virt-v2v [-v]',
      '[   0.0] Setting up the source',
      'virt-v2v monitoring: Copying disk 1 out of 2',
      'virt-v2v monitoring: Progress update, completed 25 %',
      'virt-v2v monitoring: Progress update, completed 50 %',
      'virt-v2v monitoring: Copying disk 2 out of 2',
      'virt-v2v monitoring: Progress update, completed 100 %',
      '[ 100.0] Finishing off',
    ].join('\n');

    const result = parseV2VLog(log);
    const dp = result.toolRuns[0].diskProgress;
    expect(dp.length).toBeGreaterThanOrEqual(4);
    // First disk entry
    expect(dp[0].diskNumber).toBe(1);
    expect(dp[0].totalDisks).toBe(2);
    expect(dp[0].percentComplete).toBe(0);
    // Progress updates for disk 1
    expect(dp[1].diskNumber).toBe(1);
    expect(dp[1].percentComplete).toBe(25);
    expect(dp[2].diskNumber).toBe(1);
    expect(dp[2].percentComplete).toBe(50);
    // Disk 2
    expect(dp[3].diskNumber).toBe(2);
    expect(dp[3].totalDisks).toBe(2);
  });

  it('returns empty diskProgress when no monitoring lines', () => {
    const log = [
      'Building command: virt-v2v [-v]',
      '[   0.0] Setting up the source',
      '[ 100.0] Finishing off',
    ].join('\n');

    const result = parseV2VLog(log);
    expect(result.toolRuns[0].diskProgress).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// API calls
// ────────────────────────────────────────────────────────────────────────────

describe('parseV2VLog – API calls', () => {
  it('parses libguestfs trace lines into V2VApiCall objects', () => {
    const log = [
      'Building command: virt-v2v [-v]',
      'libguestfs: trace: v2v: vfs_type "/dev/sda1"',
      'libguestfs: trace: v2v: vfs_type = "ntfs"',
    ].join('\n');

    const result = parseV2VLog(log);
    const apis = result.toolRuns[0].apiCalls;
    const vfsCall = apis.find((a) => a.name === 'vfs_type');
    expect(vfsCall).toBeDefined();
    expect(vfsCall!.args).toContain('/dev/sda1');
    expect(vfsCall!.result).toBe('"ntfs"');
    expect(vfsCall!.handle).toBe('v2v');
  });

  it('attaches guestfsd duration to API calls', () => {
    const log = [
      'Building command: virt-v2v [-v]',
      'libguestfs: trace: v2v: list_partitions',
      'guestfsd: <= list_partitions (0x8) request length 40 bytes',
      'guestfsd: => list_partitions (0x8) took 0.04 secs',
      'libguestfs: trace: v2v: list_partitions = "/dev/sda1 /dev/sda2"',
    ].join('\n');

    const result = parseV2VLog(log);
    const apis = result.toolRuns[0].apiCalls;
    const call = apis.find((a) => a.name === 'list_partitions');
    expect(call).toBeDefined();
    expect(call!.durationSecs).toBeCloseTo(0.04);
  });

  it('nests guest commands inside API calls via guestfsd scope', () => {
    const log = [
      'Building command: virt-v2v [-v]',
      'libguestfs: trace: v2v: is_file "/etc/hostname"',
      'guestfsd: <= is_file (0x28) request length 80 bytes',
      'command: stat /etc/hostname',
      'command: stat returned 0',
      'guestfsd: => is_file (0x28) took 0.01 secs',
      'libguestfs: trace: v2v: is_file = 1',
    ].join('\n');

    const result = parseV2VLog(log);
    const apis = result.toolRuns[0].apiCalls;
    const call = apis.find((a) => a.name === 'is_file');
    expect(call).toBeDefined();
    expect(call!.guestCommands.length).toBeGreaterThanOrEqual(1);
    expect(call!.guestCommands[0].command).toBe('stat');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Installed apps
// ────────────────────────────────────────────────────────────────────────────

describe('parseV2VLog – installed apps', () => {
  it('parses inspect_list_applications2 result into installed apps', () => {
    const log = [
      'Building command: virt-v2v [-v]',
      'libguestfs: trace: v2v: inspect_list_applications2 "/dev/sda2"',
      'libguestfs: trace: v2v: inspect_list_applications2 = <struct guestfs_application2_list(2) = [0]{app2_name: MyApp, app2_display_name: My Application, app2_version: 1.2.3, app2_publisher: Acme Corp, app2_install_path: C:\\Program Files\\MyApp, app2_description: Test app, app2_arch: x86_64} [1]{app2_name: Other, app2_display_name: Other App, app2_version: 4.5.6, app2_publisher: Other Corp, app2_install_path: , app2_description: , app2_arch: x86_64}>',
    ].join('\n');

    const result = parseV2VLog(log);
    const apps = result.toolRuns[0].installedApps;
    expect(apps).toHaveLength(2);
    expect(apps[0].name).toBe('MyApp');
    expect(apps[0].displayName).toBe('My Application');
    expect(apps[0].version).toBe('1.2.3');
    expect(apps[0].publisher).toBe('Acme Corp');
    expect(apps[1].name).toBe('Other');
    expect(apps[1].version).toBe('4.5.6');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Line categories
// ────────────────────────────────────────────────────────────────────────────

describe('parseV2VLog – line categories', () => {
  it('assigns correct categories to different line types', () => {
    const log = [
      'Building command: virt-v2v [-v]',
      '[   0.0] Setting up the source',
      'nbdkit: debug: TLS disabled',
      'libguestfs: trace: v2v: version',
      'guestfsd: <= list_partitions (0x8)',
      'command: blkid -c',
      'virt-v2v monitoring: Finished',
      '[ 100.0] Finishing off',
    ].join('\n');

    const result = parseV2VLog(log);
    const cats = result.toolRuns[0].lineCategories;
    // Line 0 = info (Building command starts with "Building")
    // Line 1 = stage (pipeline stage)
    expect(cats[1]).toBe('stage');
    // Line 2 = nbdkit
    expect(cats[2]).toBe('nbdkit');
    // Line 3 = libguestfs
    expect(cats[3]).toBe('libguestfs');
    // Line 4 = guestfsd
    expect(cats[4]).toBe('guestfsd');
    // Line 5 = command
    expect(cats[5]).toBe('command');
    // Line 6 = monitor
    expect(cats[6]).toBe('monitor');
    // Line 7 = stage
    expect(cats[7]).toBe('stage');
  });

  it('categorizes error and warning lines', () => {
    const log = [
      'Building command: virt-v2v [-v]',
      'virt-v2v: error: some fatal error occurred',
      'virt-v2v: warning: something is not right',
    ].join('\n');

    const result = parseV2VLog(log);
    const cats = result.toolRuns[0].lineCategories;
    expect(cats[1]).toBe('error');
    expect(cats[2]).toBe('warning');
  });

  it('lineCategories length matches rawLines length', () => {
    const log = [
      'Building command: virt-v2v [-v]',
      '[   0.0] Setting up the source',
      'some other line',
      '[ 100.0] Finishing off',
    ].join('\n');

    const result = parseV2VLog(log);
    const run = result.toolRuns[0];
    expect(run.lineCategories.length).toBe(run.rawLines.length);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Disk summary
// ────────────────────────────────────────────────────────────────────────────

describe('parseV2VLog – disk summary', () => {
  it('parses check_host_free_space into diskSummary', () => {
    const log = [
      'Building command: virt-v2v [-v]',
      'check_host_free_space: large_tmpdir=/var/tmp free_space=56748552192',
      '[   0.0] Setting up the source',
    ].join('\n');

    const result = parseV2VLog(log);
    const ds = result.toolRuns[0].diskSummary;
    expect(ds.hostTmpDir).toBe('/var/tmp');
    expect(ds.hostFreeSpace).toBe(56748552192);
  });

  it('builds per-disk info from nbdkit connections', () => {
    const log = [
      'Building command: virt-v2v [-v]',
      'running nbdkit:',
      " LANG=C 'nbdkit' '--unix' '/tmp/v2v/in0' 'vddk'",
      'nbdkit: debug: config key=server, value=10.6.46.159',
      'nbdkit: debug: config key=vm, value=moref=vm-152',
      'nbdkit: debug: transport mode: nbdssl',
      'nbdkit: debug: NBD URI: nbd+unix:///?socket=/tmp/v2v/in0',
      '[   0.0] Setting up the source',
    ].join('\n');

    const result = parseV2VLog(log);
    const ds = result.toolRuns[0].diskSummary;
    expect(ds.disks.length).toBeGreaterThanOrEqual(1);
    expect(ds.disks[0].index).toBe(1);
    expect(ds.disks[0].server).toBe('10.6.46.159');
    expect(ds.disks[0].vmMoref).toBe('vm-152');
    expect(ds.disks[0].transportMode).toBe('nbdssl');
  });

  it('returns empty disk summary when no data', () => {
    const log = [
      'Building command: virt-v2v [-v]',
      '[   0.0] Setting up the source',
    ].join('\n');

    const result = parseV2VLog(log);
    const ds = result.toolRuns[0].diskSummary;
    expect(ds.disks).toHaveLength(0);
    expect(ds.hostFreeSpace).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Blkid
// ────────────────────────────────────────────────────────────────────────────

describe('parseV2VLog – blkid', () => {
  it('parses blkid output into guest info blkid entries', () => {
    const log = [
      'Building command: virt-v2v [-v]',
      'inspect_os: fses:',
      'fs: /dev/sda1 (xfs) role: root',
      '    type: linux',
      '    distro: rhel',
      '/dev/sda1: UUID="abc-123" TYPE="xfs" PARTLABEL="Linux filesystem"',
      '/dev/sda2: UUID="def-456" TYPE="vfat" PARTUUID="7c1f7103-abcd"',
    ].join('\n');

    const result = parseV2VLog(log);
    const info = result.toolRuns[0].guestInfo;
    expect(info).not.toBeNull();
    expect(info!.blkid.length).toBeGreaterThanOrEqual(2);

    const sda1 = info!.blkid.find((e) => e.device === '/dev/sda1');
    expect(sda1).toBeDefined();
    expect(sda1!.uuid).toBe('abc-123');
    expect(sda1!.type).toBe('xfs');
    expect(sda1!.partLabel).toBe('Linux filesystem');

    const sda2 = info!.blkid.find((e) => e.device === '/dev/sda2');
    expect(sda2).toBeDefined();
    expect(sda2!.uuid).toBe('def-456');
    expect(sda2!.type).toBe('vfat');
    expect(sda2!.partUuid).toBe('7c1f7103-abcd');
  });

  it('deduplicates blkid entries by device', () => {
    const log = [
      'Building command: virt-v2v [-v]',
      'inspect_os: fses:',
      'fs: /dev/sda1 (xfs) role: root',
      '    type: linux',
      '    distro: rhel',
      '/dev/sda1: UUID="abc-123" TYPE="xfs"',
      '/dev/sda1: UUID="abc-123" TYPE="xfs"',
    ].join('\n');

    const result = parseV2VLog(log);
    const blkid = result.toolRuns[0].guestInfo!.blkid;
    const sda1Entries = blkid.filter((e) => e.device === '/dev/sda1');
    expect(sda1Entries).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Edge cases
// ────────────────────────────────────────────────────────────────────────────

describe('parseV2VLog – edge cases', () => {
  it('handles empty input', () => {
    const result = parseV2VLog('');
    expect(result.toolRuns).toHaveLength(1);
    expect(result.totalLines).toBe(1);
  });

  it('handles single non-v2v line', () => {
    const result = parseV2VLog('some random line');
    expect(result.toolRuns).toHaveLength(1);
    expect(result.toolRuns[0].stages).toHaveLength(0);
  });

  it('handles truncated log (no Finishing off)', () => {
    const log = [
      'Building command: virt-v2v [-v]',
      '[   0.0] Setting up the source',
      '[   1.0] Opening the source',
    ].join('\n');

    const result = parseV2VLog(log);
    expect(result.toolRuns[0].stages).toHaveLength(2);
    expect(result.toolRuns[0].exitStatus).toBe('in_progress');
  });

  it('totalLines reflects actual line count', () => {
    const log = 'line1\nline2\nline3';
    const result = parseV2VLog(log);
    expect(result.totalLines).toBe(3);
  });

  it('strips container/k8s timestamp prefixes and parses correctly', () => {
    const log = [
      '2026-01-21T00:57:24.837772290Z Building command: virt-v2v-inspector [-v -x -io vddk-file=disk.vmdk]',
      '2026-01-21T00:57:24.866991227Z info: virt-v2v-inspector: virt-v2v 2.8.1rhel=10,release=13.el10_1 (x86_64)',
      '2026-01-21T00:57:24.866991227Z info: libvirt version: 11.5.0',
      '2026-01-21T00:57:24.867181497Z check_host_free_space: large_tmpdir=/var/tmp free_space=233603178496',
      '2026-01-21T00:57:24.867201063Z [   0.0] Setting up the source: -i libvirt',
      '2026-01-21T00:57:25.263421236Z virt-v2v-inspector: warning: libvirt domain is running or paused',
    ].join('\n');

    const result = parseV2VLog(log);
    expect(result.toolRuns).toHaveLength(1);
    expect(result.toolRuns[0].tool).toBe('virt-v2v-inspector');
    expect(result.toolRuns[0].commandLine).toBe('-v -x -io vddk-file=disk.vmdk');
    expect(result.toolRuns[0].stages).toHaveLength(1);
    expect(result.toolRuns[0].stages[0].name).toBe('Setting up the source: -i libvirt');
    expect(result.toolRuns[0].versions.virtV2v).toBe('2.8.1rhel=10,release=13.el10_1');
    expect(result.toolRuns[0].versions.libvirt).toBe('11.5.0');
    // Warning should be detected
    const warns = result.toolRuns[0].errors.filter((e) => e.level === 'warning');
    expect(warns.length).toBeGreaterThanOrEqual(1);
  });

  it('handles mixed timestamped and non-timestamped lines', () => {
    const log = [
      '2026-01-21T00:57:24.837772290Z Building command: virt-v2v [-v]',
      'info: virt-v2v: virt-v2v 2.7.1rhel=9 (x86_64)',
      '2026-01-21T00:57:24.867201063Z [   0.0] Setting up the source',
      '[ 100.0] Finishing off',
    ].join('\n');

    const result = parseV2VLog(log);
    expect(result.toolRuns).toHaveLength(1);
    expect(result.toolRuns[0].tool).toBe('virt-v2v');
    expect(result.toolRuns[0].stages).toHaveLength(2);
    expect(result.toolRuns[0].exitStatus).toBe('success');
  });
});
