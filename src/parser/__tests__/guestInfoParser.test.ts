import { describe, it, expect } from 'vitest';
import {
  parseBlkidLine,
  parseLibvirtXML,
  parseInstalledApps,
  buildGuestInfo,
  extractAppField,
  extractCPEVersion,
} from '../v2v/guestInfoParser';
import type { V2VInstalledApp } from '../../types/v2v';

// ────────────────────────────────────────────────────────────────────────────
// parseBlkidLine
// ────────────────────────────────────────────────────────────────────────────

describe('parseBlkidLine', () => {
  it('parses standard blkid line with UUID and TYPE', () => {
    const line = '/dev/sda1: UUID="abc" TYPE="xfs"';
    const result = parseBlkidLine(line);
    expect(result).not.toBeNull();
    expect(result!.device).toBe('/dev/sda1');
    expect(result!.uuid).toBe('abc');
    expect(result!.type).toBe('xfs');
  });

  it('parses blkid line with PARTLABEL and PARTUUID', () => {
    const line =
      '/dev/sda1: UUID="B2A8-041F" TYPE="vfat" PARTLABEL="Basic data partition" PARTUUID="7c1f7103-1234"';
    const result = parseBlkidLine(line);
    expect(result).not.toBeNull();
    expect(result!.device).toBe('/dev/sda1');
    expect(result!.uuid).toBe('B2A8-041F');
    expect(result!.type).toBe('vfat');
    expect(result!.partLabel).toBe('Basic data partition');
    expect(result!.partUuid).toBe('7c1f7103-1234');
  });

  it('parses blkid line with LABEL', () => {
    const line = '/dev/sdb1: LABEL="MyData" TYPE="ext4"';
    const result = parseBlkidLine(line);
    expect(result).not.toBeNull();
    expect(result!.label).toBe('MyData');
    expect(result!.type).toBe('ext4');
  });

  it('returns null for non-blkid format', () => {
    expect(parseBlkidLine('some random line')).toBeNull();
    expect(parseBlkidLine('')).toBeNull();
  });

  it('returns null when device has no KEY="value" pairs', () => {
    const line = '/dev/sda1: some garbage without proper format';
    const result = parseBlkidLine(line);
    expect(result).toBeNull();
  });

  it('handles device paths with numbers', () => {
    const line = '/dev/nvme0n1p1: UUID="xyz" TYPE="ext4"';
    const result = parseBlkidLine(line);
    expect(result).not.toBeNull();
    expect(result!.device).toBe('/dev/nvme0n1p1');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// parseLibvirtXML
// ────────────────────────────────────────────────────────────────────────────

describe('parseLibvirtXML', () => {
  it('parses VM name from XML', () => {
    const xml = ['<domain>', '<name>my-vm</name>', '</domain>'];
    const result = parseLibvirtXML(xml);
    expect(result.name).toBe('my-vm');
  });

  it('parses memory in KiB', () => {
    const xml = ["<memory unit='KiB'>4194304</memory>"];
    const result = parseLibvirtXML(xml);
    expect(result.memoryKB).toBe(4194304);
  });

  it('parses vCPUs', () => {
    const xml = ['<vcpu>4</vcpu>'];
    const result = parseLibvirtXML(xml);
    expect(result.vcpus).toBe(4);
  });

  it('parses firmware/OS type', () => {
    const xml = ['<os>', '<type>hvm</type>', '</os>'];
    const result = parseLibvirtXML(xml);
    expect(result.firmware).toBe('bios');
  });

  it('detects UEFI from loader/ovmf', () => {
    const xml = ['<os>', '<loader>/usr/share/edk2/ovmf/OVMF.fd</loader>', '</os>'];
    const result = parseLibvirtXML(xml);
    expect(result.firmware).toBe('uefi');
  });

  it('parses disk with source file', () => {
    const xml = [
      "<disk type='file'>",
      "<source file='/var/lib/libvirt/images/disk.qcow2'/>",
      "<target dev='vda'/>",
      "<driver type='qcow2'/>",
      '</disk>',
    ];
    const result = parseLibvirtXML(xml);
    expect(result.disks).toHaveLength(1);
    expect(result.disks[0].path).toBe('/var/lib/libvirt/images/disk.qcow2');
    expect(result.disks[0].device).toBe('vda');
    expect(result.disks[0].format).toBe('qcow2');
  });

  it('parses disk with source dev', () => {
    const xml = [
      "<disk type='block'>",
      "<source dev='/dev/sda'/>",
      "<target dev='vda'/>",
      '</disk>',
    ];
    const result = parseLibvirtXML(xml);
    expect(result.disks).toHaveLength(1);
    expect(result.disks[0].path).toBe('/dev/sda');
  });

  it('parses network interfaces', () => {
    const xml = [
      "<interface type='network'>",
      "<source network='default'/>",
      "<model type='virtio'/>",
      '</interface>',
    ];
    const result = parseLibvirtXML(xml);
    expect(result.networks).toHaveLength(1);
    expect(result.networks[0].type).toBe('network');
    expect(result.networks[0].model).toBe('virtio');
    expect(result.networks[0].source).toBe('default');
  });

  it('returns empty arrays when no disks or networks', () => {
    const result = parseLibvirtXML(['<domain></domain>']);
    expect(result.disks).toEqual([]);
    expect(result.networks).toEqual([]);
  });

  it('joins multiple lines with newlines', () => {
    const xml = ['<domain>', '<name>test</name>', '</domain>'];
    const result = parseLibvirtXML(xml);
    expect(result.name).toBe('test');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// parseInstalledApps
// ────────────────────────────────────────────────────────────────────────────

describe('parseInstalledApps', () => {
  it('parses single app from guestfs_application2_list', () => {
    const resultStr =
      '= <struct guestfs_application2_list(1) = [0]{app2_name: foo, app2_version: 1.0}>';
    const apps: V2VInstalledApp[] = [];
    parseInstalledApps(resultStr, apps);
    expect(apps).toHaveLength(1);
    expect(apps[0].name).toBe('foo');
    expect(apps[0].version).toBe('1.0');
  });

  it('parses multiple apps', () => {
    const resultStr =
      '= <struct guestfs_application2_list(2) = [0]{app2_name: app1, app2_version: 1.0} [1]{app2_name: app2, app2_version: 2.0}>';
    const apps: V2VInstalledApp[] = [];
    parseInstalledApps(resultStr, apps);
    expect(apps).toHaveLength(2);
    expect(apps[0].name).toBe('app1');
    expect(apps[1].name).toBe('app2');
  });

  it('returns early when no [0]{ marker', () => {
    const apps: V2VInstalledApp[] = [];
    parseInstalledApps('no list here', apps);
    expect(apps).toHaveLength(0);
  });

  it('handles app2_display_name and app2_publisher', () => {
    const resultStr =
      '= <struct guestfs_application2_list(1) = [0]{app2_name: pkg, app2_display_name: My App, app2_publisher: VMware, Inc.}>';
    const apps: V2VInstalledApp[] = [];
    parseInstalledApps(resultStr, apps);
    expect(apps[0].displayName).toBe('My App');
    expect(apps[0].publisher).toBe('VMware, Inc.');
  });

  it('skips entries with no name or displayName', () => {
    const resultStr =
      '= <struct guestfs_application2_list(1) = [0]{app2_version: 1.0}>';
    const apps: V2VInstalledApp[] = [];
    parseInstalledApps(resultStr, apps);
    expect(apps).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// extractAppField
// ────────────────────────────────────────────────────────────────────────────

describe('extractAppField', () => {
  it('extracts field when present', () => {
    const fields = 'app2_name: foo, app2_version: 1.0, app2_publisher: Acme';
    expect(extractAppField(fields, 'app2_name')).toBe('foo');
    expect(extractAppField(fields, 'app2_version')).toBe('1.0');
    expect(extractAppField(fields, 'app2_publisher')).toBe('Acme');
  });

  it('returns empty string when key not found', () => {
    const fields = 'app2_name: foo';
    expect(extractAppField(fields, 'app2_nonexistent')).toBe('');
  });

  it('handles last field (no trailing comma)', () => {
    const fields = 'app2_name: lastValue';
    expect(extractAppField(fields, 'app2_name')).toBe('lastValue');
  });

  it('handles values with commas using app2_ delimiter', () => {
    const fields = 'app2_name: VMware, Inc. Tool, app2_version: 1.0';
    expect(extractAppField(fields, 'app2_name')).toBe('VMware, Inc. Tool');
  });

  it('trims whitespace', () => {
    const fields = 'app2_name:  spaced  , app2_version: 2.0';
    expect(extractAppField(fields, 'app2_name')).toBe('spaced');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// extractCPEVersion
// ────────────────────────────────────────────────────────────────────────────

describe('extractCPEVersion', () => {
  it('extracts version from CPE 2.3 string', () => {
    const cpe = 'cpe:2.3:o:redhat:enterprise_linux:9.0:GA:*:*:*:*:*:*';
    expect(extractCPEVersion(cpe)).toBe('9.0');
  });

  it('returns empty for non-CPE string', () => {
    expect(extractCPEVersion('Red Hat Enterprise Linux 9')).toBe('');
  });

  it('returns empty for CPE with * (unspecified version)', () => {
    const cpe = 'cpe:2.3:o:vendor:product:*:*:*:*:*:*:*:*';
    expect(extractCPEVersion(cpe)).toBe('');
  });

  it('extracts multi-part version', () => {
    const cpe = 'cpe:2.3:o:amazon:amazon_linux:2023.0.0:*:*:*:*:*:*:*';
    expect(extractCPEVersion(cpe)).toBe('2023.0.0');
  });

  it('returns empty when parts length < 6', () => {
    expect(extractCPEVersion('cpe:2.3:a:b:c')).toBe('');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// buildGuestInfo
// ────────────────────────────────────────────────────────────────────────────

describe('buildGuestInfo', () => {
  it('builds guest info from i_ key-value pairs', () => {
    const raw = new Map<string, string>([
      ['root', '/dev/sda1'],
      ['type', 'linux'],
      ['distro', 'rhel'],
      ['product_name', 'Red Hat Enterprise Linux'],
      ['major_version', '9'],
      ['minor_version', '0'],
    ]);
    const info = buildGuestInfo(raw);
    expect(info.root).toBe('/dev/sda1');
    expect(info.type).toBe('linux');
    expect(info.distro).toBe('rhel');
    expect(info.majorVersion).toBe(9);
    expect(info.minorVersion).toBe(0);
  });

  it('parses drive mappings in i_ format (E => /dev/sdb1)', () => {
    const raw = new Map<string, string>([
      ['drive_mappings', 'E => /dev/sdb1; D => /dev/sda1; C => /dev/sdc2'],
    ]);
    const info = buildGuestInfo(raw);
    expect(info.driveMappings).toHaveLength(3);
    expect(info.driveMappings[0]).toEqual({ letter: 'C', device: '/dev/sdc2' });
    expect(info.driveMappings[1]).toEqual({ letter: 'D', device: '/dev/sda1' });
    expect(info.driveMappings[2]).toEqual({ letter: 'E', device: '/dev/sdb1' });
  });

  it('parses drive mappings in structured block format', () => {
    const raw = new Map<string, string>([
      ['drive_mappings', '[(C, /dev/sda2), (E, /dev/sdb1), (F, /dev/sdc1)]'],
    ]);
    const info = buildGuestInfo(raw);
    expect(info.driveMappings).toHaveLength(3);
    expect(info.driveMappings[0]).toEqual({ letter: 'C', device: '/dev/sda2' });
  });

  it('parses fstab entries', () => {
    const raw = new Map<string, string>([
      ['fstab', '[(/dev/rhel/root, /), (/dev/sda2, /boot), (/dev/sda1, /home)]'],
    ]);
    const info = buildGuestInfo(raw);
    expect(info.fstab).toHaveLength(3);
    expect(info.fstab[0]).toEqual({ device: '/dev/rhel/root', mountpoint: '/' });
    expect(info.fstab[1]).toEqual({ device: '/dev/sda2', mountpoint: '/boot' });
  });

  it('extracts version from CPE when major_version is 0', () => {
    const raw = new Map<string, string>([
      ['product_name', 'cpe:2.3:o:amazon:amazon_linux:2023.0:*:*:*:*:*:*:*'],
      ['major_version', '0'],
      ['minor_version', '0'],
    ]);
    const info = buildGuestInfo(raw);
    expect(info.majorVersion).toBe(2023);
    expect(info.minorVersion).toBe(0);
  });

  it('falls back to version field when major_version is 0', () => {
    const raw = new Map<string, string>([
      ['version', '8.5'],
      ['major_version', '0'],
      ['minor_version', '0'],
    ]);
    const info = buildGuestInfo(raw);
    expect(info.majorVersion).toBe(8);
    expect(info.minorVersion).toBe(5);
  });

  it('handles empty map with defaults', () => {
    const info = buildGuestInfo(new Map());
    expect(info.root).toBe('');
    expect(info.type).toBe('');
    expect(info.driveMappings).toEqual([]);
    expect(info.fstab).toEqual([]);
    expect(info.majorVersion).toBe(0);
    expect(info.minorVersion).toBe(0);
  });
});
