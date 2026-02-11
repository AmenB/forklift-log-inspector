/**
 * Structured visualization for the Linux conversion pipeline stage.
 *
 * Parses kernel analysis, package removal, driver configuration,
 * initramfs rebuild, GRUB config, guest capabilities, and augeas errors.
 */
import { useMemo, useState } from 'react';
import type {
  KernelInfo,
  PackageOperation,
  BootConfig,
  InitramfsRebuild,
  LinuxAugeasError,
  ParsedLinuxConversion,
} from '../../parser/v2v';
import { parseLinuxConversion, isLinuxConversionContent } from '../../parser/v2v';
import type { V2VToolRun } from '../../types/v2v';
import { SectionHeader } from './shared';
import { V2VFileTree } from './V2VFileTree';

/** Re-export for consumers that import from this component file. */
export { isLinuxConversionContent };

// ── Component ───────────────────────────────────────────────────────────────

export function LinuxConversionView({ content, toolRun }: { content: string[]; toolRun?: V2VToolRun }) {
  const parsed = useMemo(() => parseLinuxConversion(content), [content]);

  const hasData =
    parsed.conversionModule ||
    parsed.kernels.length > 0 ||
    parsed.packageOps.length > 0 ||
    parsed.guestCaps ||
    parsed.initramfs;

  if (!hasData) return null;

  // Determine if V2VFileTree has data to show
  const hasFileTreeData = toolRun && (
    toolRun.apiCalls.some((c) =>
      ['is_file', 'is_dir', 'is_symlink', 'is_blockdev', 'is_chardev', 'exists', 'stat', 'lstat'].includes(c.name),
    ) || toolRun.virtioWin.fileCopies.length > 0
  );

  return (
    <div className="space-y-4">
      {/* Conversion Summary + Guest Capabilities */}
      {(parsed.conversionModule || parsed.guestCaps || parsed.osDetected) && (
        <SummarySection parsed={parsed} />
      )}

      {/* Kernel Analysis */}
      {parsed.kernels.length > 0 && (
        <KernelSection kernels={parsed.kernels} candidates={parsed.candidatePackages} />
      )}

      {/* Package Operations */}
      {parsed.packageOps.length > 0 && (
        <PackageOpsSection ops={parsed.packageOps} />
      )}

      {/* Boot Configuration */}
      {(parsed.boot.bootloader || parsed.boot.blockDeviceMap.length > 0 || parsed.boot.grubCmdline) && (
        <BootConfigSection boot={parsed.boot} defaultKernel={parsed.defaultKernel} modprobeAliases={parsed.modprobeAliases} />
      )}

      {/* Initramfs Rebuild */}
      {parsed.initramfs && (
        <InitramfsSection initramfs={parsed.initramfs} />
      )}

      {/* Augeas Errors */}
      {parsed.augeasErrors.length > 0 && (
        <AugeasErrorsSection errors={parsed.augeasErrors} />
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

function SummarySection({ parsed }: { parsed: ParsedLinuxConversion }) {
  const { guestCaps } = parsed;
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
          {parsed.osDetected && (
            <div>
              <span className="text-slate-500 dark:text-gray-400">OS:</span>{' '}
              <span className="font-medium text-slate-700 dark:text-gray-200">{parsed.osDetected}</span>
            </div>
          )}
          {guestCaps && (
            <>
              {guestCaps.machine && (
                <div>
                  <span className="text-slate-500 dark:text-gray-400">Machine:</span>{' '}
                  <span className="font-mono text-[10px] text-slate-700 dark:text-gray-200">{guestCaps.machine}</span>
                </div>
              )}
              {guestCaps.arch && (
                <div>
                  <span className="text-slate-500 dark:text-gray-400">Arch:</span>{' '}
                  <span className="font-mono text-[10px] text-slate-700 dark:text-gray-200">{guestCaps.arch}</span>
                </div>
              )}
            </>
          )}
        </div>

        {/* Capabilities badges */}
        {guestCaps && (
          <div className="flex flex-wrap gap-1">
            <Badge color="blue">Block: {guestCaps.blockBus || 'n/a'}</Badge>
            <Badge color="blue">Net: {guestCaps.netBus || 'n/a'}</Badge>
            {guestCaps.virtio10 && <Badge color="green">VirtIO 1.0</Badge>}
            {guestCaps.virtioRng && <Badge color="green">RNG</Badge>}
            {guestCaps.virtioBalloon && <Badge color="green">Balloon</Badge>}
            {guestCaps.pvpanic && <Badge color="green">pvpanic</Badge>}
            {guestCaps.virtioSocket && <Badge color="green">vsock</Badge>}
            {guestCaps.rtcUtc && <Badge color="slate">RTC UTC</Badge>}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Kernel Analysis ─────────────────────────────────────────────────────────

function KernelSection({ kernels, candidates }: { kernels: KernelInfo[]; candidates: string[] }) {
  return (
    <div>
      <SectionHeader title="Kernel Analysis" />
      <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
        {/* Candidate packages */}
        {candidates.length > 0 && (
          <div className="px-3 py-1.5 border-b border-slate-100 dark:border-slate-800 text-[10px] text-slate-500 dark:text-gray-400">
            Candidate packages:{' '}
            {candidates.map((c, i) => (
              <span key={i} className="font-mono text-slate-600 dark:text-gray-300">
                {c}{i < candidates.length - 1 ? ', ' : ''}
              </span>
            ))}
          </div>
        )}

        {/* Kernel table */}
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-left text-slate-400 dark:text-gray-500 border-b border-slate-100 dark:border-slate-800">
              <th className="px-3 py-1 font-medium">Package</th>
              <th className="px-3 py-1 font-medium">Version</th>
              <th className="px-3 py-1 font-medium">Modules</th>
              <th className="px-3 py-1 font-medium">VirtIO Drivers</th>
            </tr>
          </thead>
          <tbody>
            {kernels.map((k, i) => (
              <tr key={i} className={`border-b border-slate-50 dark:border-slate-800/50 last:border-b-0 ${k.isBest ? 'bg-green-50 dark:bg-green-900/10' : ''}`}>
                <td className="px-3 py-1.5">
                  <span className="font-mono text-[10px] text-slate-700 dark:text-gray-200">{k.name}</span>
                  {k.isBest && <Badge color="green">best</Badge>}
                  {k.isDefault && <Badge color="blue">default</Badge>}
                </td>
                <td className="px-3 py-1 font-mono text-[10px] text-slate-500 dark:text-gray-400">
                  {k.version}
                </td>
                <td className="px-3 py-1 text-slate-500 dark:text-gray-400">
                  {k.modulesCount > 0 ? k.modulesCount : '-'}
                </td>
                <td className="px-3 py-1">
                  <div className="flex flex-wrap gap-0.5">
                    {Object.entries(k.virtio).map(([name, supported]) => (
                      <Badge key={name} color={supported ? 'green' : 'red'}>
                        {name}
                      </Badge>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Package Operations ──────────────────────────────────────────────────────

function PackageOpsSection({ ops }: { ops: PackageOperation[] }) {
  return (
    <div>
      <SectionHeader title="Package Removal" />
      {ops.map((op, idx) => (
        <div key={idx} className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden mb-2">
          <div className="px-3 py-1.5 bg-slate-50 dark:bg-slate-800/50 flex items-center justify-between border-b border-slate-100 dark:border-slate-800">
            <div className="flex items-center gap-2 min-w-0">
              <Badge color="slate">{op.manager}</Badge>
              <span className="font-mono text-[10px] text-slate-600 dark:text-gray-300 truncate">{op.command}</span>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              {op.freedSpace && (
                <Badge color="green">Freed: {op.freedSpace}</Badge>
              )}
              {op.durationSecs !== null && (
                <span className="text-[9px] text-slate-400 dark:text-gray-500">{op.durationSecs.toFixed(1)}s</span>
              )}
            </div>
          </div>
          {op.packages.length > 0 && (
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-left text-slate-400 dark:text-gray-500 border-b border-slate-100 dark:border-slate-800">
                  <th className="px-3 py-1 font-medium">Package</th>
                  <th className="px-3 py-1 font-medium">Version</th>
                  {op.manager !== 'apt' && <th className="px-3 py-1 font-medium">Size</th>}
                </tr>
              </thead>
              <tbody>
                {op.packages.map((pkg, i) => (
                  <tr key={i} className="border-b border-slate-50 dark:border-slate-800/50 last:border-b-0">
                    <td className="px-3 py-1">
                      <span className="font-mono text-[10px] text-slate-700 dark:text-gray-200">{pkg.name}</span>
                      {pkg.arch && <span className="text-[9px] text-slate-400 dark:text-gray-500 ml-1">{pkg.arch}</span>}
                    </td>
                    <td className="px-3 py-1 font-mono text-[10px] text-slate-500 dark:text-gray-400">{pkg.version}</td>
                    {op.manager !== 'apt' && <td className="px-3 py-1 text-slate-500 dark:text-gray-400">{pkg.size}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Boot Configuration ──────────────────────────────────────────────────────

function BootConfigSection({
  boot,
  defaultKernel,
  modprobeAliases,
}: {
  boot: BootConfig;
  defaultKernel: string;
  modprobeAliases: { alias: string; module: string }[];
}) {
  const [showEfi, setShowEfi] = useState(false);

  return (
    <div>
      <SectionHeader title="Boot & Driver Configuration" />
      <div className="border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 space-y-2">
        {/* Bootloader */}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
          {boot.bootloader && (
            <div>
              <span className="text-slate-500 dark:text-gray-400">Bootloader:</span>{' '}
              <span className="font-medium text-slate-700 dark:text-gray-200">{boot.bootloader}</span>
              {boot.bootloaderPath && (
                <span className="font-mono text-[10px] text-slate-400 dark:text-gray-500 ml-1">({boot.bootloaderPath})</span>
              )}
            </div>
          )}
          {defaultKernel && (
            <div>
              <span className="text-slate-500 dark:text-gray-400">DEFAULTKERNEL:</span>{' '}
              <span className="font-mono text-[10px] text-slate-700 dark:text-gray-200">{defaultKernel}</span>
            </div>
          )}
        </div>

        {/* Block device mapping */}
        {boot.blockDeviceMap.length > 0 && (
          <div className="text-[11px]">
            <span className="text-slate-500 dark:text-gray-400">Block device map:</span>
            <div className="flex flex-wrap gap-2 mt-0.5">
              {boot.blockDeviceMap.map((m, i) => (
                <span key={i} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border bg-slate-50 dark:bg-slate-800/50 border-slate-200 dark:border-slate-700 font-mono text-[10px]">
                  <span className="text-slate-600 dark:text-gray-300">{m.from}</span>
                  <span className="text-slate-300 dark:text-gray-600">&rarr;</span>
                  <span className="text-blue-600 dark:text-blue-400">{m.to}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Modprobe aliases */}
        {modprobeAliases.length > 0 && (
          <div className="text-[11px]">
            <span className="text-slate-500 dark:text-gray-400">Modprobe aliases added:</span>
            <div className="flex flex-wrap gap-2 mt-0.5">
              {modprobeAliases.map((a, i) => (
                <span key={i} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border bg-slate-50 dark:bg-slate-800/50 border-slate-200 dark:border-slate-700 font-mono text-[10px]">
                  <span className="text-slate-600 dark:text-gray-300">{a.alias}</span>
                  <span className="text-slate-300 dark:text-gray-600">&rarr;</span>
                  <span className="text-green-600 dark:text-green-400">{a.module}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* GRUB command line */}
        {boot.grubCmdline && (
          <div className="text-[11px]">
            <span className="text-slate-500 dark:text-gray-400">GRUB_CMDLINE_LINUX:</span>
            <div className="mt-0.5 font-mono text-[10px] text-slate-600 dark:text-gray-300 bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded px-2 py-1 break-all">
              {boot.grubCmdline}
            </div>
          </div>
        )}

        {/* fstab */}
        {boot.fstabEntries.length > 0 && (
          <div className="text-[11px]">
            <span className="text-slate-500 dark:text-gray-400">fstab entries:</span>
            <div className="flex flex-wrap gap-1 mt-0.5">
              {boot.fstabEntries.map((e, i) => (
                <span key={i} className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-gray-300">
                  {e.spec}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* EFI files */}
        {boot.efiFiles.length > 0 && (
          <div className="text-[11px]">
            <button
              onClick={() => setShowEfi(!showEfi)}
              className="text-slate-500 dark:text-gray-400 hover:text-slate-700 dark:hover:text-gray-200 transition-colors"
            >
              <span className="text-[9px] mr-1">{showEfi ? '\u25BC' : '\u25B6'}</span>
              EFI files ({boot.efiFiles.length})
            </button>
            {showEfi && (
              <div className="mt-1 pl-3 space-y-0.5">
                {boot.efiFiles.map((f, i) => (
                  <div key={i} className="font-mono text-[10px] text-slate-500 dark:text-gray-400">
                    {f}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Initramfs Rebuild ───────────────────────────────────────────────────────

/** Group kernel modules by subsystem directory. */
function groupModulesBySubsystem(modules: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const m of modules) {
    // Module path like "kernel/drivers/virtio/virtio.ko" → group "drivers/virtio"
    // Or just "virtio.ko" → group "other"
    const parts = m.replace(/^kernel\//, '').split('/');
    let group: string;
    if (parts.length >= 3) {
      group = parts.slice(0, 2).join('/');
    } else if (parts.length === 2) {
      group = parts[0];
    } else {
      group = 'other';
    }
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push(parts[parts.length - 1]);
  }
  // Sort groups by count (largest first), then alphabetically
  return new Map(
    [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])),
  );
}

/** Collapsible list used for modules, binaries, firmware, etc. */
function CollapsibleList({
  label,
  count,
  items,
  grouped,
  badgeColor = 'slate',
}: {
  label: string;
  count: number;
  items?: string[];
  grouped?: Map<string, string[]>;
  badgeColor?: 'green' | 'red' | 'blue' | 'slate' | 'amber';
}) {
  const [open, setOpen] = useState(false);
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);

  if (count === 0) return null;

  return (
    <div className="text-[11px]">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-slate-500 dark:text-gray-400 hover:text-slate-700 dark:hover:text-gray-200 transition-colors"
      >
        <span className="text-[9px]">{open ? '\u25BC' : '\u25B6'}</span>
        <span>{label}</span>
        <Badge color={badgeColor}>{count}</Badge>
      </button>
      {open && grouped && (
        <div className="mt-1 ml-3 space-y-1 max-h-[400px] overflow-y-auto">
          {[...grouped.entries()].map(([group, mods]) => (
            <div key={group}>
              <button
                onClick={() => setExpandedGroup(expandedGroup === group ? null : group)}
                className="flex items-center gap-1 text-slate-600 dark:text-gray-300 hover:text-slate-800 dark:hover:text-gray-100 transition-colors"
              >
                <span className="text-[8px]">{expandedGroup === group ? '\u25BC' : '\u25B6'}</span>
                <span className="font-mono text-[10px] text-blue-600 dark:text-blue-400">{group}/</span>
                <span className="text-[9px] text-slate-400 dark:text-gray-500">({mods.length})</span>
              </button>
              {expandedGroup === group && (
                <div className="ml-3 mt-0.5 flex flex-wrap gap-1">
                  {mods.map((mod, i) => (
                    <span key={i} className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-[9px] font-mono text-slate-600 dark:text-gray-300">
                      {mod}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {open && items && !grouped && (
        <div className="mt-1 ml-3 flex flex-wrap gap-1 max-h-[300px] overflow-y-auto">
          {items.map((item, i) => (
            <span key={i} className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-[9px] font-mono text-slate-600 dark:text-gray-300 break-all">
              {item}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function InitramfsSection({ initramfs }: { initramfs: InitramfsRebuild }) {
  const toolLabel = initramfs.tool === 'dracut'
    ? 'dracut'
    : initramfs.tool === 'update-initramfs'
      ? 'update-initramfs'
      : initramfs.tool;

  const moduleGroups = useMemo(
    () => groupModulesBySubsystem(initramfs.includedModules),
    [initramfs.includedModules],
  );

  const hasExtendedData =
    initramfs.binaries.length > 0 ||
    initramfs.firmware.length > 0 ||
    initramfs.configs.length > 0 ||
    initramfs.hooks.length > 0 ||
    initramfs.copyDirs.length > 0 ||
    initramfs.microcodeCount > 0;

  return (
    <div>
      <SectionHeader title={`Initramfs Rebuild (${toolLabel})`} />
      <div className="border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 space-y-2">
        {/* Command */}
        {initramfs.command && (
          <div className="font-mono text-[10px] text-slate-600 dark:text-gray-300 bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded px-2 py-1 break-all">
            {initramfs.command}
          </div>
        )}

        {/* Stats */}
        <div className="flex flex-wrap gap-2">
          {initramfs.durationSecs !== null && (
            <Badge color="blue">Duration: {initramfs.durationSecs.toFixed(1)}s</Badge>
          )}
          {initramfs.compressionMethod && (
            <Badge color="slate">Compression: {initramfs.compressionMethod}</Badge>
          )}
          {initramfs.initramfsPath && (
            <Badge color="slate">Output: {initramfs.initramfsPath}</Badge>
          )}
        </div>

        {/* Summary badges for extended data */}
        {hasExtendedData && (
          <div className="flex flex-wrap gap-1.5">
            {initramfs.includedModules.length > 0 && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-medium bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300">
                {initramfs.includedModules.length} modules
              </span>
            )}
            {initramfs.binaries.length > 0 && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-medium bg-cyan-100 dark:bg-cyan-900/30 text-cyan-700 dark:text-cyan-300">
                {initramfs.binaries.length} binaries
              </span>
            )}
            {initramfs.firmware.length > 0 && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300">
                {initramfs.firmware.length} firmware
              </span>
            )}
            {initramfs.configs.length > 0 && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-medium bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300">
                {initramfs.configs.length} configs
              </span>
            )}
            {initramfs.hooks.length > 0 && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-medium bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300">
                {initramfs.hooks.length} hooks
              </span>
            )}
            {initramfs.microcodeCount > 0 && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-medium bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-gray-300">
                {initramfs.microcodeCount} microcode bundles
              </span>
            )}
          </div>
        )}

        {/* Categorized collapsible sections */}
        <div className="space-y-1">
          {/* Kernel modules — grouped by subsystem */}
          <CollapsibleList
            label="Kernel modules"
            count={initramfs.includedModules.length}
            grouped={moduleGroups}
            badgeColor="blue"
          />

          {/* Hooks */}
          <CollapsibleList
            label="Hooks"
            count={initramfs.hooks.length}
            items={initramfs.hooks}
            badgeColor="amber"
          />

          {/* Copy directories */}
          {initramfs.copyDirs.length > 0 && (
            <CollapsibleList
              label="Copied module directories"
              count={initramfs.copyDirs.length}
              items={initramfs.copyDirs.map((d) => d.excludes ? `${d.dir} ${d.excludes}` : d.dir)}
              badgeColor="slate"
            />
          )}

          {/* Binaries */}
          <CollapsibleList
            label="Binaries &amp; libraries"
            count={initramfs.binaries.length}
            items={initramfs.binaries}
            badgeColor="slate"
          />

          {/* Firmware */}
          <CollapsibleList
            label="Firmware"
            count={initramfs.firmware.length}
            items={initramfs.firmware}
            badgeColor="amber"
          />

          {/* Config files */}
          <CollapsibleList
            label="Configuration files"
            count={initramfs.configs.length}
            items={initramfs.configs}
            badgeColor="green"
          />
        </div>
      </div>
    </div>
  );
}

// ── Augeas Errors ───────────────────────────────────────────────────────────

function AugeasErrorsSection({ errors }: { errors: LinuxAugeasError[] }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div>
      <SectionHeader title="Augeas Parse Errors" />
      <div className="border border-amber-200 dark:border-amber-800 rounded-lg overflow-hidden">
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full px-3 py-1.5 flex items-center justify-between bg-amber-50 dark:bg-amber-900/10 text-[11px] text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/20 transition-colors"
        >
          <span>
            <span className="text-[9px] mr-1">{expanded ? '\u25BC' : '\u25B6'}</span>
            {errors.length} file{errors.length !== 1 ? 's' : ''} failed to parse
          </span>
        </button>
        {expanded && (
          <div className="px-3 py-2 space-y-1 bg-white dark:bg-slate-900">
            {errors.map((err, i) => (
              <div key={i} className="text-[10px] font-mono">
                <span className="text-amber-600 dark:text-amber-400">{err.file}</span>
                {err.message && (
                  <span className="text-slate-500 dark:text-gray-400">
                    {' '}&mdash; {err.message}
                    {err.line && ` at line ${err.line}`}
                    {err.char && `:${err.char}`}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
