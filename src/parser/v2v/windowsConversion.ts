/**
 * Parser for the Windows conversion pipeline stage.
 *
 * Parses OS detection, guest capabilities, registry hive sessions, and warnings.
 */

// ── Types ───────────────────────────────────────────────────────────────────

export interface WindowsOSInfo {
  type: string;           // "windows"
  arch: string;           // "x86_64"
  majorVersion: number | null;
  minorVersion: number | null;
  productName: string;    // "Windows Server 2019 Standard"
  productVariant: string; // "Server"
  osinfo: string;         // "win2k19"
  controlSet: string;     // "ControlSet001"
  systemRoot: string;     // "/Windows"
}

export interface WindowsGuestCaps {
  blockBus: string;
  netBus: string;
  virtioRng: boolean;
  virtioBalloon: boolean;
  pvpanic: boolean;
  virtioSocket: boolean;
  machine: string;
  arch: string;
  virtio10: boolean;
  rtcUtc: boolean;
}

export interface ParsedWindowsConversion {
  conversionModule: string;
  osInfo: WindowsOSInfo;
  guestCaps: WindowsGuestCaps | null;
  virtioIsoPath: string;
  virtioIsoVersion: string;
  hasVirtioDrivers: boolean;
  warnings: string[];
}

// ── Parser ──────────────────────────────────────────────────────────────────

export function parseWindowsConversion(lines: string[]): ParsedWindowsConversion {
  const result: ParsedWindowsConversion = {
    conversionModule: '',
    osInfo: {
      type: '', arch: '', majorVersion: null, minorVersion: null,
      productName: '', productVariant: '', osinfo: '',
      controlSet: '', systemRoot: '',
    },
    guestCaps: null,
    virtioIsoPath: '',
    virtioIsoVersion: '',
    hasVirtioDrivers: false,
    warnings: [],
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // ── Conversion module ────────────────────────────────────────────
    const modMatch = line.match(/picked conversion module (\S+)/);
    if (modMatch) {
      result.conversionModule = modMatch[1];
    }

    // ── OS detection ─────────────────────────────────────────────────
    const typeMatch = line.match(/inspect_get_type = "(.+?)"/);
    if (typeMatch && !result.osInfo.type) result.osInfo.type = typeMatch[1];

    const archMatch = line.match(/inspect_get_arch = "(.+?)"/);
    if (archMatch && !result.osInfo.arch) result.osInfo.arch = archMatch[1];

    const majorMatch = line.match(/inspect_get_major_version = (\d+)/);
    if (majorMatch && result.osInfo.majorVersion === null) result.osInfo.majorVersion = parseInt(majorMatch[1], 10);

    const minorMatch = line.match(/inspect_get_minor_version = (\d+)/);
    if (minorMatch && result.osInfo.minorVersion === null) result.osInfo.minorVersion = parseInt(minorMatch[1], 10);

    const prodNameMatch = line.match(/inspect_get_product_name = "(.+?)"/);
    if (prodNameMatch && !result.osInfo.productName) result.osInfo.productName = prodNameMatch[1];

    const variantMatch = line.match(/inspect_get_product_variant = "(.+?)"/);
    if (variantMatch && !result.osInfo.productVariant) result.osInfo.productVariant = variantMatch[1];

    const osinfoMatch = line.match(/inspect_get_osinfo = "(.+?)"/);
    if (osinfoMatch && !result.osInfo.osinfo) result.osInfo.osinfo = osinfoMatch[1];

    const ctrlSetMatch = line.match(/inspect_get_windows_current_control_set = "(.+?)"/);
    if (ctrlSetMatch && !result.osInfo.controlSet) result.osInfo.controlSet = ctrlSetMatch[1];

    const sysrootMatch = line.match(/inspect_get_windows_systemroot = "(.+?)"/);
    if (sysrootMatch && !result.osInfo.systemRoot) result.osInfo.systemRoot = sysrootMatch[1];

    // ── VirtIO summary ───────────────────────────────────────────────
    const isoMatch = line.match(/copy_from_virtio_win:\s+guest tools source ISO\s+(\S+)/);
    if (isoMatch) result.virtioIsoPath = isoMatch[1];

    const isoVerMatch = line.match(/virtio-win-(\d[\d.]+\d)\.iso/);
    if (isoVerMatch && !result.virtioIsoVersion) result.virtioIsoVersion = isoVerMatch[1];

    if (line.includes('This guest has virtio drivers installed')) {
      result.hasVirtioDrivers = true;
    }

    // ── Guest capabilities ───────────────────────────────────────────
    const gcapsMatch = line.match(/^gcaps_(\w+)\s*=\s*(.+)/);
    if (gcapsMatch) {
      if (!result.guestCaps) {
        result.guestCaps = {
          blockBus: '', netBus: '', virtioRng: false, virtioBalloon: false,
          pvpanic: false, virtioSocket: false, machine: '', arch: '',
          virtio10: false, rtcUtc: false,
        };
      }
      const key = gcapsMatch[1];
      const val = gcapsMatch[2].trim();
      switch (key) {
        case 'block_bus': result.guestCaps.blockBus = val; break;
        case 'net_bus': result.guestCaps.netBus = val; break;
        case 'virtio_rng': result.guestCaps.virtioRng = val === 'true'; break;
        case 'virtio_balloon': result.guestCaps.virtioBalloon = val === 'true'; break;
        case 'isa_pvpanic': result.guestCaps.pvpanic = val === 'true'; break;
        case 'virtio_socket': result.guestCaps.virtioSocket = val === 'true'; break;
        case 'machine': result.guestCaps.machine = val; break;
        case 'arch': result.guestCaps.arch = val; break;
        case 'virtio_1_0': result.guestCaps.virtio10 = val === 'true'; break;
        case 'rtc_utc': result.guestCaps.rtcUtc = val === 'true'; break;
      }
    }

    // ── Warnings ─────────────────────────────────────────────────────
    const warnMatch = line.match(/virt-v2v:\s*warning:\s*(.+)/);
    if (warnMatch) {
      const msg = warnMatch[1].trim();
      if (!result.warnings.includes(msg)) {
        result.warnings.push(msg);
      }
    }
  }

  return result;
}

export function isWindowsConversionContent(lines: string[]): boolean {
  const sample = lines.slice(0, Math.min(200, lines.length));
  // Require strong conversion-specific markers, not just inspect_get_type or gcaps_*
  // which appear in many non-conversion stages (hostname, seed, BIOS/UEFI check, etc.)
  return sample.some(
    (l) =>
      (l.includes('picked conversion module') && l.includes('windows')) ||
      l.includes('copy_from_virtio_win') ||
      l.includes('virtio_win: read_file'),
  );
}
