/**
 * Structured visualization for the Windows conversion pipeline stage.
 *
 * Parses OS detection, guest capabilities, registry hive sessions, and warnings.
 * Reuses V2VFileTree for the file operations tree view (mounted disks, file
 * checks, VirtIO driver copies, firstboot scripts, etc.).
 */
import { useMemo } from 'react';
import type { V2VToolRun } from '../../types/v2v';
import { SectionHeader } from './shared';
import { V2VFileTree } from './V2VFileTree';
import { HiveGroupCard, groupHiveAccesses } from './RegistryAppsPanel';

// ── Types ───────────────────────────────────────────────────────────────────

interface WindowsOSInfo {
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

interface GuestCaps {
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

interface ParsedWindowsConversion {
  conversionModule: string;
  osInfo: WindowsOSInfo;
  guestCaps: GuestCaps | null;
  virtioIsoPath: string;
  virtioIsoVersion: string;
  hasVirtioDrivers: boolean;
  warnings: string[];
}

// ── Parser ──────────────────────────────────────────────────────────────────

function parseWindowsConversion(lines: string[]): ParsedWindowsConversion {
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

// ── Detect if content is a Windows conversion stage ─────────────────────────

// eslint-disable-next-line react-refresh/only-export-components
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

// ── Component ───────────────────────────────────────────────────────────────

export function WindowsConversionView({ content, toolRun }: { content: string[]; toolRun?: V2VToolRun }) {
  const parsed = useMemo(() => parseWindowsConversion(content), [content]);

  // Build rich registry hive groups from toolRun data
  const hiveGroups = useMemo(
    () => (toolRun?.registryHiveAccesses ? groupHiveAccesses(toolRun.registryHiveAccesses) : []),
    [toolRun?.registryHiveAccesses],
  );

  const hasData =
    parsed.conversionModule ||
    parsed.osInfo.productName ||
    parsed.guestCaps ||
    hiveGroups.length > 0;

  if (!hasData) return null;

  // Determine if V2VFileTree has data to show
  const hasFileTreeData = toolRun && (
    toolRun.apiCalls.some((c) =>
      ['is_file', 'is_dir', 'is_symlink', 'is_blockdev', 'is_chardev', 'exists', 'stat', 'lstat'].includes(c.name),
    ) || toolRun.virtioWin.fileCopies.length > 0
  );

  return (
    <div className="space-y-4">
      {/* Conversion Summary */}
      {(parsed.conversionModule || parsed.osInfo.productName || parsed.guestCaps) && (
        <SummarySection parsed={parsed} />
      )}

      {/* Registry Hive Operations — rich view with key paths and values */}
      {hiveGroups.length > 0 && (
        <div>
          <SectionHeader title="Registry Hive Operations" />
          <div className="text-xs text-slate-500 dark:text-gray-400 mb-2">
            {hiveGroups.length} registry hive{hiveGroups.length !== 1 ? 's' : ''} accessed
            ({toolRun!.registryHiveAccesses.length} key path{toolRun!.registryHiveAccesses.length !== 1 ? 's' : ''} traversed)
          </div>
          <div className="space-y-2">
            {hiveGroups.map((group) => (
              <HiveGroupCard key={group.hivePath} group={group} />
            ))}
          </div>
        </div>
      )}

      {/* Warnings */}
      {parsed.warnings.length > 0 && (
        <WarningsSection warnings={parsed.warnings} />
      )}

      {/* File Operations — V2VFileTree with mounted disks */}
      {hasFileTreeData && toolRun && (
        <div>
          <SectionHeader title="File Operations" />
          <V2VFileTree
            apiCalls={toolRun.apiCalls}
            fileCopies={toolRun.virtioWin.fileCopies}
            driveMappings={toolRun.guestInfo?.driveMappings}
            fstab={toolRun.guestInfo?.fstab}
            guestType={toolRun.guestInfo?.type}
            virtioWinIsoPath={toolRun.virtioWin?.isoPath}
            defaultExpandGuest
          />
        </div>
      )}
    </div>
  );
}

// ── Sub-sections ────────────────────────────────────────────────────────────

function Badge({ children, color }: { children: React.ReactNode; color: 'green' | 'red' | 'blue' | 'slate' | 'amber' }) {
  const colors = {
    green: 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300',
    red: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300',
    blue: 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300',
    slate: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-gray-400',
    amber: 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300',
  };
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium ${colors[color]}`}>
      {children}
    </span>
  );
}

// ── Summary ─────────────────────────────────────────────────────────────────

function SummarySection({ parsed }: { parsed: ParsedWindowsConversion }) {
  const { osInfo, guestCaps } = parsed;
  return (
    <div>
      <SectionHeader title="Conversion Summary" />
      <div className="border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 space-y-2">
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
          {parsed.conversionModule && (
            <div>
              <span className="text-slate-500 dark:text-gray-400">Module:</span>{' '}
              <span className="font-medium text-slate-700 dark:text-gray-200">{parsed.conversionModule}</span>
            </div>
          )}
          {osInfo.productName && (
            <div>
              <span className="text-slate-500 dark:text-gray-400">OS:</span>{' '}
              <span className="font-medium text-slate-700 dark:text-gray-200">{osInfo.productName}</span>
            </div>
          )}
          {osInfo.productVariant && (
            <div>
              <span className="text-slate-500 dark:text-gray-400">Variant:</span>{' '}
              <span className="font-medium text-slate-700 dark:text-gray-200">{osInfo.productVariant}</span>
            </div>
          )}
          {osInfo.osinfo && (
            <div>
              <span className="text-slate-500 dark:text-gray-400">OSInfo ID:</span>{' '}
              <span className="font-mono text-[10px] text-slate-700 dark:text-gray-200">{osInfo.osinfo}</span>
            </div>
          )}
          {osInfo.arch && (
            <div>
              <span className="text-slate-500 dark:text-gray-400">Arch:</span>{' '}
              <span className="font-mono text-[10px] text-slate-700 dark:text-gray-200">{osInfo.arch}</span>
            </div>
          )}
          {guestCaps?.machine && (
            <div>
              <span className="text-slate-500 dark:text-gray-400">Machine:</span>{' '}
              <span className="font-mono text-[10px] text-slate-700 dark:text-gray-200">{guestCaps.machine}</span>
            </div>
          )}
        </div>

        {/* Windows-specific info */}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
          {osInfo.controlSet && (
            <div>
              <span className="text-slate-500 dark:text-gray-400">Control Set:</span>{' '}
              <span className="font-mono text-[10px] text-slate-700 dark:text-gray-200">{osInfo.controlSet}</span>
            </div>
          )}
          {osInfo.systemRoot && (
            <div>
              <span className="text-slate-500 dark:text-gray-400">System Root:</span>{' '}
              <span className="font-mono text-[10px] text-slate-700 dark:text-gray-200">{osInfo.systemRoot}</span>
            </div>
          )}
          {parsed.virtioIsoPath && (
            <div>
              <span className="text-slate-500 dark:text-gray-400">VirtIO ISO:</span>{' '}
              <span className="font-mono text-[10px] text-slate-700 dark:text-gray-200">{parsed.virtioIsoPath}</span>
              {parsed.virtioIsoVersion && (
                <span className="text-slate-400 dark:text-gray-500 ml-1">v{parsed.virtioIsoVersion}</span>
              )}
            </div>
          )}
        </div>

        {/* Capabilities badges */}
        <div className="flex flex-wrap gap-1">
          {parsed.hasVirtioDrivers && <Badge color="green">VirtIO drivers installed</Badge>}
          {guestCaps && (
            <>
              <Badge color="blue">Block: {guestCaps.blockBus || 'n/a'}</Badge>
              <Badge color="blue">Net: {guestCaps.netBus || 'n/a'}</Badge>
              {guestCaps.virtio10 && <Badge color="green">VirtIO 1.0</Badge>}
              {guestCaps.virtioRng && <Badge color="green">RNG</Badge>}
              {guestCaps.virtioBalloon && <Badge color="green">Balloon</Badge>}
              {guestCaps.pvpanic && <Badge color="green">pvpanic</Badge>}
              {guestCaps.virtioSocket ? <Badge color="green">vsock</Badge> : <Badge color="slate">vsock off</Badge>}
              {guestCaps.rtcUtc ? <Badge color="slate">RTC UTC</Badge> : <Badge color="slate">RTC local</Badge>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Warnings ────────────────────────────────────────────────────────────────

function WarningsSection({ warnings }: { warnings: string[] }) {
  return (
    <div>
      <SectionHeader title="Warnings" />
      <div className="border border-amber-200 dark:border-amber-800 rounded-lg px-3 py-2 bg-amber-50 dark:bg-amber-900/10 space-y-1">
        {warnings.map((w, i) => (
          <div key={i} className="text-[10px] text-amber-700 dark:text-amber-300">
            {w}
          </div>
        ))}
      </div>
    </div>
  );
}
