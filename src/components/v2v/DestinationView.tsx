/**
 * Structured visualization for the "Setting up the destination" pipeline stage.
 *
 * Parses the VM conversion plan summary, destination disk creation,
 * guest capabilities, output NBDKIT instances, source VDDK connections,
 * filesystem usage, and socket mapping.
 */
import { useMemo } from 'react';
import { formatBytes } from '../../utils/format';
import { SectionHeader } from './shared';

// ── Types ───────────────────────────────────────────────────────────────────

interface VmPlan {
  sourceName: string;
  hypervisorType: string;
  genid: string;
  memory: number;
  vcpus: number;
  firmware: string;
}

interface DiskEntry {
  index: number;
  bus: string;
  destFile: string;
  sizeBytes: number;
  /** Output socket serving this disk */
  outputSocket: string;
  /** Source VMDK path (if matched) */
  sourceVmdk: string;
}

interface NicEntry {
  bridge: string;
  mac: string;
  model: string;
}

interface GuestCaps {
  [key: string]: string;
}

interface SourceConnection {
  vmdk: string;
  server: string;
  transportMode: string;
  sizeBytes: number;
  inputSocket: string;
}

interface FsUsage {
  filesystem: string;
  sizeKB: number;
  usedKB: number;
  availKB: number;
  usePercent: number;
  mountPoint: string;
}

interface ParsedDestination {
  vmPlan: VmPlan | null;
  disks: DiskEntry[];
  nics: NicEntry[];
  guestCaps: GuestCaps;
  osInfo: { [key: string]: string };
  sourceConns: SourceConnection[];
  fsUsage: FsUsage | null;
}

// ── Parser ──────────────────────────────────────────────────────────────────

function parseDestinationContent(lines: string[]): ParsedDestination {
  let vmPlan: VmPlan | null = null;
  const disks: DiskEntry[] = [];
  const nics: NicEntry[] = [];
  const guestCaps: GuestCaps = {};
  const osInfo: { [key: string]: string } = {};
  const sourceConns: SourceConnection[] = [];
  let fsUsage: FsUsage | null = null;

  // Collect output sockets: file/dir config → bound socket
  const outputSockets: { dir: string; socket: string }[] = [];

  let diskIdx = 0;

  // First pass: extract source connections from libnbd/nbdkit negotiation
  let currentVmdk = '';
  let currentServer = '';
  let currentTransport = '';
  let currentInputSocket = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // ── VM plan summary block ────────────────────────────────────────
    const sourceNameMatch = line.match(/^\s*source name:\s+(.+)/);
    if (sourceNameMatch) {
      if (!vmPlan) vmPlan = { sourceName: '', hypervisorType: '', genid: '', memory: 0, vcpus: 0, firmware: '' };
      vmPlan.sourceName = sourceNameMatch[1].trim();
    }

    const hypervisorMatch = line.match(/^hypervisor type:\s+(.+)/);
    if (hypervisorMatch) {
      if (!vmPlan) vmPlan = { sourceName: '', hypervisorType: '', genid: '', memory: 0, vcpus: 0, firmware: '' };
      vmPlan.hypervisorType = hypervisorMatch[1].trim();
    }

    const genidMatch = line.match(/^\s*VM genid:\s+(.+)/);
    if (genidMatch) {
      if (!vmPlan) vmPlan = { sourceName: '', hypervisorType: '', genid: '', memory: 0, vcpus: 0, firmware: '' };
      vmPlan.genid = genidMatch[1].trim();
    }

    const memMatch = line.match(/^\s*memory:\s+(\d+)\s+\(bytes\)/);
    if (memMatch) {
      if (!vmPlan) vmPlan = { sourceName: '', hypervisorType: '', genid: '', memory: 0, vcpus: 0, firmware: '' };
      vmPlan.memory = parseInt(memMatch[1], 10);
    }

    const vcpuMatch = line.match(/^\s*nr vCPUs:\s+(\d+)/);
    if (vcpuMatch) {
      if (!vmPlan) vmPlan = { sourceName: '', hypervisorType: '', genid: '', memory: 0, vcpus: 0, firmware: '' };
      vmPlan.vcpus = parseInt(vcpuMatch[1], 10);
    }

    const fwMatch = line.match(/^\s*firmware:\s+(.+)/);
    if (fwMatch) {
      if (!vmPlan) vmPlan = { sourceName: '', hypervisorType: '', genid: '', memory: 0, vcpus: 0, firmware: '' };
      vmPlan.firmware = fwMatch[1].trim();
    }

    // ── NICs (before "target NICs") ──────────────────────────────────
    const nicMatch = line.match(/^\tBridge "([^"]+)" mac:\s+(\S+)\s+\[(\w+)\]/);
    if (nicMatch && !nics.some((n) => n.mac === nicMatch[2])) {
      nics.push({ bridge: nicMatch[1], mac: nicMatch[2], model: nicMatch[3] });
    }

    // ── Destination disk creation ────────────────────────────────────
    const diskCreateMatch = line.match(/disk_create "([^"]+)" "raw" (\d+)/);
    if (diskCreateMatch) {
      disks.push({
        index: diskIdx++,
        bus: '',
        destFile: diskCreateMatch[1],
        sizeBytes: parseInt(diskCreateMatch[2], 10),
        outputSocket: '',
        sourceVmdk: '',
      });
    }

    // ── Guest capabilities ───────────────────────────────────────────
    const gcapsMatch = line.match(/^gcaps_(\w+)\s+=\s+(.+)/);
    if (gcapsMatch) {
      guestCaps[gcapsMatch[1]] = gcapsMatch[2].trim();
    }

    // ── Output NBDKIT sockets (file= or dir= config) ────────────────
    const fileConfigMatch = line.match(/file: config key=(?:file|dir), value=(.+)/);
    if (fileConfigMatch) {
      const dir = fileConfigMatch[1].trim();
      // Look ahead for the socket
      for (let j = i + 1; j < Math.min(i + 15, lines.length); j++) {
        const socketMatch = lines[j].match(/bound to unix socket\s+(\S+)/);
        if (socketMatch) {
          outputSockets.push({ dir, socket: socketMatch[1] });
          break;
        }
      }
    }

    // ── Source VDDK connection: VMDK path ─────────────────────────────
    // "VixDiskLib_Open (connection, [datastore] path/to.vmdk, ...)"
    const vmdkOpenMatch = line.match(/VixDiskLib_Open\s*\(connection,\s*(.+\.vmdk),/);
    if (vmdkOpenMatch) {
      currentVmdk = vmdkOpenMatch[1].trim();
    }

    // Server from NBD_ClientOpen
    const serverMatch = line.match(/NBD_ClientOpen:.*@([\d.]+:\d+)/);
    if (serverMatch) {
      currentServer = serverMatch[1];
    }

    // Transport mode
    const transportMatch = line.match(/transport mode:\s+(\S+)/);
    if (transportMatch) {
      currentTransport = transportMatch[1];
    }

    // Input socket from nbd_connect_unix or nbd_connect_uri
    const inputSocketMatch = line.match(/nbd_connect_(?:unix|uri):\s*enter:.*(?:unixsocket|uri)="([^"]+)"/);
    if (inputSocketMatch) {
      const raw = inputSocketMatch[1];
      // Extract socket path from URI if present
      const socketParam = raw.match(/socket=([^&"]+)/);
      currentInputSocket = socketParam ? socketParam[1] : raw;
    }

    // Source connection size from exportsize
    const exportSizeMatch = line.match(/exportsize:\s+(\d+)/);
    if (exportSizeMatch && currentVmdk) {
      sourceConns.push({
        vmdk: currentVmdk,
        server: currentServer,
        transportMode: currentTransport,
        sizeBytes: parseInt(exportSizeMatch[1], 10),
        inputSocket: currentInputSocket,
      });
      // Reset for next connection
      currentVmdk = '';
      currentServer = '';
      currentTransport = '';
      currentInputSocket = '';
    }

    // ── Filesystem usage from df output ──────────────────────────────
    // "host:/path  1K-blocks  Used Available Use% Mounted on" followed by data line
    const dfMatch = line.match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)/);
    if (dfMatch && !dfMatch[1].startsWith('Filesystem')) {
      fsUsage = {
        filesystem: dfMatch[1],
        sizeKB: parseInt(dfMatch[2], 10),
        usedKB: parseInt(dfMatch[3], 10),
        availKB: parseInt(dfMatch[4], 10),
        usePercent: parseInt(dfMatch[5], 10),
        mountPoint: dfMatch[6].trim(),
      };
    }

    // ── OS info (i_root = ...) ───────────────────────────────────────
    const osMatch = line.match(/^i_(\w+)\s+=\s+(.*)$/);
    if (osMatch && osMatch[2].trim() && !osInfo[osMatch[1]]) {
      osInfo[osMatch[1]] = osMatch[2].trim();
    }
  }

  // Match output sockets to disks
  for (const disk of disks) {
    // Output NBDKIT: the dir/file matches the disk's destination directory or file
    const matchingSocket = outputSockets.find(
      (s) => disk.destFile.startsWith(s.dir) || s.dir === disk.destFile,
    );
    if (matchingSocket) {
      disk.outputSocket = matchingSocket.socket;
    }
  }

  // Match source connections to disks by order
  for (let idx = 0; idx < disks.length && idx < sourceConns.length; idx++) {
    disks[idx].sourceVmdk = sourceConns[idx].vmdk;
  }

  return { vmPlan, disks, nics, guestCaps, osInfo, sourceConns, fsUsage };
}

// ── Component ───────────────────────────────────────────────────────────────

export function DestinationView({ content }: { content: string[] }) {
  const parsed = useMemo(() => parseDestinationContent(content), [content]);

  const hasData =
    parsed.vmPlan !== null ||
    parsed.disks.length > 0 ||
    Object.keys(parsed.guestCaps).length > 0 ||
    parsed.sourceConns.length > 0;

  if (!hasData) return null;

  return (
    <div className="space-y-4">
      {/* VM Plan Summary */}
      {parsed.vmPlan && <VmPlanSection plan={parsed.vmPlan} nics={parsed.nics} />}

      {/* Source VDDK Connections */}
      {parsed.sourceConns.length > 0 && <SourceConnsSection conns={parsed.sourceConns} />}

      {/* Destination Disks */}
      {parsed.disks.length > 0 && <DestDisksSection disks={parsed.disks} />}

      {/* Filesystem Usage */}
      {parsed.fsUsage && <FsUsageSection usage={parsed.fsUsage} />}

      {/* Guest Capabilities */}
      {Object.keys(parsed.guestCaps).length > 0 && <GuestCapsSection caps={parsed.guestCaps} />}
    </div>
  );
}

// ── Sub-sections ────────────────────────────────────────────────────────────

function VmPlanSection({ plan, nics }: { plan: VmPlan; nics: NicEntry[] }) {
  return (
    <div>
      <SectionHeader title="Conversion Plan" />
      <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
        <div className="px-3 py-2 bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700">
          <span className="text-xs font-semibold text-slate-700 dark:text-gray-200">
            {plan.sourceName}
          </span>
          {plan.hypervisorType && (
            <span className="ml-2 px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-[10px] text-slate-600 dark:text-gray-300">
              {plan.hypervisorType}
            </span>
          )}
        </div>
        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 px-3 py-2 text-[11px]">
          {plan.memory > 0 && (
            <>
              <span className="text-slate-400 dark:text-gray-500">Memory</span>
              <span className="text-slate-700 dark:text-gray-200">{formatBytes(plan.memory)}</span>
            </>
          )}
          {plan.vcpus > 0 && (
            <>
              <span className="text-slate-400 dark:text-gray-500">vCPUs</span>
              <span className="text-slate-700 dark:text-gray-200">{plan.vcpus}</span>
            </>
          )}
          {plan.firmware && plan.firmware !== 'unknown' && (
            <>
              <span className="text-slate-400 dark:text-gray-500">Firmware</span>
              <span className="text-slate-700 dark:text-gray-200">{plan.firmware}</span>
            </>
          )}
          {plan.genid && (
            <>
              <span className="text-slate-400 dark:text-gray-500">VM GenID</span>
              <span className="font-mono text-slate-600 dark:text-gray-300 text-[10px]">{plan.genid}</span>
            </>
          )}
        </div>
        {nics.length > 0 && (
          <div className="px-3 py-2 border-t border-slate-100 dark:border-slate-800 space-y-1">
            <span className="text-[10px] text-slate-400 dark:text-gray-500 font-semibold uppercase">Network Adapters</span>
            {nics.map((nic, idx) => (
              <div key={idx} className="flex items-center gap-2 text-[11px] pl-2">
                <span className="text-slate-600 dark:text-gray-300">{nic.bridge}</span>
                <span className="font-mono text-[10px] text-slate-500 dark:text-gray-400">{nic.mac}</span>
                <span className="px-1 py-0 rounded bg-slate-100 dark:bg-slate-800 text-[9px] text-slate-500 dark:text-gray-400">
                  {nic.model}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SourceConnsSection({ conns }: { conns: SourceConnection[] }) {
  return (
    <div>
      <SectionHeader title="Source VDDK Connections" />
      <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-left text-slate-400 dark:text-gray-500 border-b border-slate-100 dark:border-slate-800">
              <th className="px-3 py-1 font-medium">VMDK</th>
              <th className="px-3 py-1 font-medium">Transport</th>
              <th className="px-3 py-1 font-medium">Server</th>
              <th className="px-3 py-1 font-medium text-right">Size</th>
            </tr>
          </thead>
          <tbody>
            {conns.map((c, i) => (
              <tr key={i} className="border-b border-slate-50 dark:border-slate-800/50 last:border-b-0">
                <td className="px-3 py-1.5 font-mono text-[10px] text-slate-700 dark:text-gray-200 max-w-[250px] truncate" title={c.vmdk}>
                  {c.vmdk}
                </td>
                <td className="px-3 py-1.5">
                  <span className="px-1.5 py-0.5 rounded bg-indigo-50 dark:bg-indigo-900/20 text-[9px] text-indigo-600 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800">
                    {c.transportMode || 'unknown'}
                  </span>
                </td>
                <td className="px-3 py-1.5 font-mono text-[10px] text-slate-500 dark:text-gray-400">
                  {c.server || '--'}
                </td>
                <td className="px-3 py-1.5 text-right text-slate-600 dark:text-gray-300">
                  {formatBytes(c.sizeBytes)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DestDisksSection({ disks }: { disks: DiskEntry[] }) {
  return (
    <div>
      <SectionHeader title="Destination Disks" />
      <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-left text-slate-400 dark:text-gray-500 border-b border-slate-100 dark:border-slate-800">
              <th className="px-3 py-1 font-medium">#</th>
              <th className="px-3 py-1 font-medium">File</th>
              <th className="px-3 py-1 font-medium text-right">Size</th>
            </tr>
          </thead>
          <tbody>
            {disks.map((d) => (
              <tr key={d.index} className="border-b border-slate-50 dark:border-slate-800/50 last:border-b-0">
                <td className="px-3 py-1.5 text-slate-500 dark:text-gray-400">{d.index}</td>
                <td className="px-3 py-1.5">
                  <span className="font-mono text-slate-700 dark:text-gray-200 text-[10px]">
                    {d.destFile.split('/').pop()}
                  </span>
                  {d.outputSocket && (
                    <span className="ml-2 text-[9px] text-slate-400 dark:text-gray-500 font-mono">
                      {'\u2192'} {d.outputSocket.split('/').pop()}
                    </span>
                  )}
                  {d.sourceVmdk && (
                    <span className="ml-2 text-[9px] text-slate-400 dark:text-gray-500 font-mono" title={d.sourceVmdk}>
                      {'\u2190'} {d.sourceVmdk.split('/').pop()}
                    </span>
                  )}
                </td>
                <td className="px-3 py-1.5 text-right text-slate-600 dark:text-gray-300">
                  {formatBytes(d.sizeBytes)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FsUsageSection({ usage }: { usage: FsUsage }) {
  const usedPercent = usage.usePercent;
  const barColor =
    usedPercent >= 90
      ? 'bg-red-500 dark:bg-red-400'
      : usedPercent >= 75
        ? 'bg-amber-500 dark:bg-amber-400'
        : 'bg-green-500 dark:bg-green-400';

  return (
    <div>
      <SectionHeader title="Destination Storage" />
      <div className="border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2">
        <div className="flex items-center justify-between text-[11px] mb-1.5">
          <span className="font-mono text-[10px] text-slate-600 dark:text-gray-300 truncate max-w-[300px]" title={usage.filesystem}>
            {usage.mountPoint}
          </span>
          <span className="text-slate-500 dark:text-gray-400">
            {formatBytes(usage.usedKB * 1024)} / {formatBytes(usage.sizeKB * 1024)}
            <span className="ml-1 font-medium">({usedPercent}%)</span>
          </span>
        </div>
        <div className="w-full h-2 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${barColor}`}
            style={{ width: `${Math.min(usedPercent, 100)}%` }}
          />
        </div>
        <div className="flex justify-between text-[10px] text-slate-400 dark:text-gray-500 mt-1">
          <span>Available: {formatBytes(usage.availKB * 1024)}</span>
          <span className="font-mono truncate max-w-[250px]" title={usage.filesystem}>
            {usage.filesystem.length > 40 ? '...' + usage.filesystem.slice(-37) : usage.filesystem}
          </span>
        </div>
      </div>
    </div>
  );
}

const GCAPS_LABELS: Record<string, string> = {
  block_bus: 'Block Bus',
  net_bus: 'Network Bus',
  machine: 'Machine Type',
  arch: 'Architecture',
  virtio_rng: 'VirtIO RNG',
  virtio_balloon: 'VirtIO Balloon',
  isa_pvpanic: 'ISA PV Panic',
  virtio_socket: 'VirtIO Socket',
  virtio_1_0: 'VirtIO 1.0',
  rtc_utc: 'RTC UTC',
};

function GuestCapsSection({ caps }: { caps: GuestCaps }) {
  return (
    <div>
      <SectionHeader title="Guest Capabilities" />
      <div className="flex flex-wrap gap-2">
        {Object.entries(caps).map(([key, value]) => {
          const label = GCAPS_LABELS[key] || key.replace(/_/g, ' ');
          const isTrue = value === 'true';
          const isFalse = value === 'false';
          return (
            <span
              key={key}
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] border ${
                isTrue
                  ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300 border-green-200 dark:border-green-800'
                  : isFalse
                    ? 'bg-slate-50 dark:bg-slate-800/50 text-slate-400 dark:text-gray-500 border-slate-200 dark:border-slate-700'
                    : 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800'
              }`}
            >
              <span className="font-medium">{label}:</span>
              <span>{value}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}
