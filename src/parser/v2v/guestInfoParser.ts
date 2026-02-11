/**
 * Guest info parsing for virt-v2v logs.
 * Extracts installed apps, drive mappings, fstab, and source VM from libvirt XML.
 */

import type {
  V2VGuestInfo,
  V2VDriveMapping,
  V2VFstabEntry,
  V2VInstalledApp,
  V2VSourceVM,
} from '../../types/v2v';

/**
 * Parse the result of `inspect_list_applications2` into structured app entries.
 *
 * Format: `= <struct guestfs_application2_list(N) = [0]{...} [1]{...} ...>`
 *
 * Values can contain commas (`VMware, Inc.`), braces (`{GUID}`), and backslashes (`C:\...`),
 * so we use `app2_` field prefixes as delimiters instead of commas.
 */
export function parseInstalledApps(resultStr: string, apps: V2VInstalledApp[]): void {
  // Split entries by `} [N]{` boundaries (or start/end markers)
  const listStart = resultStr.indexOf('[0]{');
  if (listStart === -1) return;

  const entriesStr = resultStr.slice(listStart);
  // Split by `} [N]{` — each chunk is one app entry (with leading/trailing junk)
  const rawEntries = entriesStr.split(/\}\s*\[\d+\]\{/);

  for (const raw of rawEntries) {
    // Clean: remove leading `[0]{` and trailing `}>` or `}`
    const fields = raw.replace(/^\[\d+\]\{/, '').replace(/\}\s*>?\s*$/, '');

    const app: V2VInstalledApp = {
      name: extractAppField(fields, 'app2_name'),
      displayName: extractAppField(fields, 'app2_display_name'),
      version: extractAppField(fields, 'app2_version'),
      publisher: extractAppField(fields, 'app2_publisher'),
      installPath: extractAppField(fields, 'app2_install_path'),
      description: extractAppField(fields, 'app2_description'),
      arch: extractAppField(fields, 'app2_arch'),
    };
    if (app.displayName || app.name) {
      apps.push(app);
    }
  }
}

/**
 * Extract a field value from the `app2_key: value, app2_next: ...` string.
 * Uses `, app2_` as the delimiter since values themselves can contain commas.
 */
export function extractAppField(fields: string, key: string): string {
  const marker = `${key}: `;
  const idx = fields.indexOf(marker);
  if (idx === -1) return '';
  const start = idx + marker.length;
  // Value runs until the next `, app2_` boundary
  const nextField = fields.indexOf(', app2_', start);
  if (nextField === -1) {
    // Last field — strip trailing comma/whitespace
    return fields.slice(start).replace(/,?\s*$/, '').trim();
  }
  return fields.slice(start, nextField).trim();
}

/**
 * Extract the product version from a CPE 2.3 string.
 * Format: `cpe:2.3:part:vendor:product:version:...`
 * Returns the version component (parts[5]) or empty string if not a CPE.
 */
export function extractCPEVersion(productName: string): string {
  if (!productName.startsWith('cpe:')) return '';
  const parts = productName.split(':');
  if (parts.length >= 6) {
    const ver = parts[5];
    // `*` means unspecified in CPE
    if (ver && ver !== '*') return ver;
  }
  return '';
}

/**
 * Build a V2VGuestInfo from the collected `i_` key-value pairs.
 *
 * Windows drive mappings format: `i_drive_mappings = E => /dev/sdb1; D => /dev/sda1; C => /dev/sdc2`
 * Linux fstab format (from structured block): `fstab: [(/dev/rhel/root, /), (/dev/sda2, /boot), ...]`
 */
export function buildGuestInfo(raw: Map<string, string>): V2VGuestInfo {
  // Parse Windows drive mappings — two possible formats:
  // i_ format: "E => /dev/sdb1; D => /dev/sda1; C => /dev/sdc2"
  // structured block format: "[(C, /dev/sda2), (E, /dev/sdb1), (F, /dev/sdc1)]"
  const driveMappings: V2VDriveMapping[] = [];
  const mappingsStr = raw.get('drive_mappings') || '';
  if (mappingsStr) {
    if (mappingsStr.includes('=>')) {
      // i_ format
      for (const part of mappingsStr.split(';')) {
        const m = part.trim().match(/^(\w+)\s*=>\s*(.+)$/);
        if (m) {
          driveMappings.push({ letter: m[1], device: m[2].trim() });
        }
      }
    } else {
      // structured block format: [(C, /dev/sda2), ...]
      const entryRe = /\((\w+),\s*([^)]+)\)/g;
      let dm;
      while ((dm = entryRe.exec(mappingsStr)) !== null) {
        driveMappings.push({ letter: dm[1].trim(), device: dm[2].trim() });
      }
    }
    driveMappings.sort((a, b) => a.letter.localeCompare(b.letter));
  }

  // Parse Linux fstab entries: [(/dev/rhel/root, /), (/dev/sda2, /boot), ...]
  const fstab: V2VFstabEntry[] = [];
  const fstabStr = raw.get('fstab') || '';
  if (fstabStr) {
    const entryRe = /\(([^,]+),\s*([^)]+)\)/g;
    let fm;
    while ((fm = entryRe.exec(fstabStr)) !== null) {
      fstab.push({ device: fm[1].trim(), mountpoint: fm[2].trim() });
    }
  }

  // Parse version: prefer i_major_version/i_minor_version, then CPE product version,
  // then fall back to `version: X.Y`.
  //
  // The structured block format (from inspect_os / inspect_get_roots) sometimes
  // reports the CPE *specification* version (e.g. `2.3`) as the OS version,
  // which is wrong for distros like Amazon Linux 2023 whose real version is `2023`.
  // When product_name is a CPE string, we extract the true version from the CPE.
  let majorVersion = parseInt(raw.get('major_version') || '0', 10);
  let minorVersion = parseInt(raw.get('minor_version') || '0', 10);
  if (majorVersion === 0) {
    // Try extracting version from CPE product_name first
    const productName = raw.get('product_name') || '';
    const cpeVersion = extractCPEVersion(productName);
    if (cpeVersion) {
      const vParts = cpeVersion.split('.');
      majorVersion = parseInt(vParts[0] || '0', 10);
      minorVersion = parseInt(vParts[1] || '0', 10);
    }
    // Fall back to the explicit version field
    if (majorVersion === 0 && raw.has('version')) {
      const vParts = (raw.get('version') || '').split('.');
      majorVersion = parseInt(vParts[0] || '0', 10);
      minorVersion = parseInt(vParts[1] || '0', 10);
    }
  }

  return {
    root: raw.get('root') || '',
    type: raw.get('type') || '',
    distro: raw.get('distro') || '',
    osinfo: raw.get('osinfo') || '',
    arch: raw.get('arch') || '',
    majorVersion,
    minorVersion,
    productName: raw.get('product_name') || '',
    productVariant: raw.get('product_variant') || '',
    packageFormat: raw.get('package_format') || '',
    packageManagement: raw.get('package_management') || '',
    hostname: raw.get('hostname') || '',
    buildId: raw.get('build_id') || '',
    windowsSystemroot: raw.get('windows_systemroot') || '',
    windowsSoftwareHive: raw.get('windows_software_hive') || '',
    windowsSystemHive: raw.get('windows_system_hive') || '',
    windowsCurrentControlSet: raw.get('windows_current_control_set') || '',
    driveMappings,
    fstab,
  };
}

/**
 * Parse libvirt XML captured from log lines into a V2VSourceVM structure.
 * Uses simple regex extraction — no XML parser needed for the few fields we care about.
 */
export function parseLibvirtXML(lines: string[]): V2VSourceVM {
  const xml = lines.join('\n');
  const vm: V2VSourceVM = { disks: [], networks: [] };

  // VM name
  const nameMatch = xml.match(/<name>([^<]+)<\/name>/);
  if (nameMatch) vm.name = nameMatch[1];

  // Memory (in KiB)
  const memMatch = xml.match(/<memory\s+unit='KiB'>(\d+)<\/memory>/);
  if (memMatch) vm.memoryKB = parseInt(memMatch[1], 10);

  // vCPUs
  const cpuMatch = xml.match(/<vcpu[^>]*>(\d+)<\/vcpu>/);
  if (cpuMatch) vm.vcpus = parseInt(cpuMatch[1], 10);

  // Firmware / OS type
  const osTypeMatch = xml.match(/<os>[\s\S]*?<type[^>]*>([^<]+)<\/type>/);
  if (osTypeMatch) vm.firmware = osTypeMatch[1];
  if (xml.includes('<loader') || xml.includes('ovmf') || xml.includes('OVMF')) {
    vm.firmware = 'uefi';
  } else if (vm.firmware === 'hvm') {
    vm.firmware = 'bios';
  }

  // Disks: <source file='...' or <source dev='...'
  const diskRe = /<disk\s+[^>]*>[\s\S]*?<\/disk>/g;
  let diskMatch;
  while ((diskMatch = diskRe.exec(xml)) !== null) {
    const block = diskMatch[0];
    const srcFile = block.match(/<source\s+file='([^']+)'/)?.[1]
      || block.match(/<source\s+dev='([^']+)'/)?.[1]
      || block.match(/<source\s+name='([^']+)'/)?.[1];
    const device = block.match(/<target\s+dev='([^']+)'/)?.[1];
    const fmt = block.match(/<driver[^>]+type='([^']+)'/)?.[1];
    if (srcFile) vm.disks.push({ path: srcFile, format: fmt, device });
  }

  // Networks: <interface type='...'> ... <source .../> <model type='...'/>
  const netRe = /<interface\s+type='([^']+)'[^>]*>[\s\S]*?<\/interface>/g;
  let netMatch;
  while ((netMatch = netRe.exec(xml)) !== null) {
    const block = netMatch[0];
    const netType = netMatch[1];
    const model = block.match(/<model\s+type='([^']+)'/)?.[1];
    const source = block.match(/<source\s+(?:network|bridge|portgroup)='([^']+)'/)?.[1];
    vm.networks.push({ type: netType, model, source });
  }

  return vm;
}
