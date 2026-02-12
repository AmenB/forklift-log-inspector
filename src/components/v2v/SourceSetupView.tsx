/**
 * Structured visualization for the "Setting up the source" pipeline stage.
 *
 * Parses the libvirt XML domain definition and NBDKIT source instances
 * to show the source VM configuration and VDDK connection details.
 */
import { useMemo } from 'react';
import { formatBytes } from '../../utils/format';
import { SectionHeader } from './shared';

// ── Types ───────────────────────────────────────────────────────────────────

interface SourceVm {
  name: string;
  uuid: string;
  memoryKiB: number;
  vcpus: number;
  osArch: string;
  osType: string;
  bootDev: string;
  domainType: string;
  datacenterPath: string;
  moref: string;
}

interface SourceDisk {
  source: string; // VMDK path, block device, or file path
  target: string; // e.g. sda
  bus: string; // e.g. scsi
  driverType: string; // e.g. raw, qcow2
  diskType: string; // e.g. file, block
}

interface SourceNic {
  mac: string;
  model: string;
  switchId: string;
  portgroupId: string;
}

interface SourceController {
  type: string;
  model: string;
}

interface NbdkitInstance {
  vmdk: string;
  socket: string;
  server: string;
  user: string;
  thumbprint: string;
  filters: string[];
  vddkVersion: string;
  transportModes: string;
}

interface OvaSource {
  ovaPath: string;
  ovaType: string;
  extractDir: string;
  ovfFile: string;
  manifestFile: string;
  disks: OvaDisk[];
}

interface OvaDisk {
  name: string;
  offsetBytes: number;
  sizeBytes: number;
  socket: string;
}

interface ParsedSourceSetup {
  vm: SourceVm | null;
  disks: SourceDisk[];
  nics: SourceNic[];
  controllers: SourceController[];
  nbdkitInstances: NbdkitInstance[];
  ova: OvaSource | null;
}

// ── Parser ──────────────────────────────────────────────────────────────────

function parseSourceSetup(lines: string[]): ParsedSourceSetup {
  let vm: SourceVm | null = null;
  const disks: SourceDisk[] = [];
  const nics: SourceNic[] = [];
  const controllers: SourceController[] = [];
  const nbdkitInstances: NbdkitInstance[] = [];

  // ── Parse libvirt XML ──────────────────────────────────────────────
  // Find the XML block between "libvirt xml is:" and the closing </domain>
  let inXml = false;
  const xmlLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.includes('libvirt xml is:')) {
      // XML may start on the same line after the colon
      const afterColon = line.slice(line.indexOf('libvirt xml is:') + 'libvirt xml is:'.length).trim();
      if (afterColon.length > 0) {
        xmlLines.push(afterColon);
        if (afterColon.includes('</domain>')) continue;
      }
      inXml = true;
      continue;
    }
    if (inXml) {
      xmlLines.push(line);
      if (line.includes('</domain>')) {
        inXml = false;
      }
      continue;
    }
  }

  // Parse XML with regex (lightweight, no DOM parser needed)
  // Handle both single-quoted and double-quoted attributes
  const xmlText = xmlLines.join('\n');

  /** Match an XML attribute value with either single or double quotes */
  const q = `["']([^"']+)["']`; // quote-agnostic attribute value capture

  if (xmlText) {
    const domainTypeMatch = xmlText.match(new RegExp(`<domain\\s+type=${q}`));
    const nameMatch = xmlText.match(/<name>([^<]+)<\/name>/);
    const uuidMatch = xmlText.match(/<uuid>([^<]+)<\/uuid>/);
    // Memory with unit attribute: <memory unit='KiB'>1234</memory>
    // Memory without unit: <memory>0</memory>
    const memMatchUnit = xmlText.match(new RegExp(`<memory\\s+unit=${q}>(\\d+)<\\/memory>`));
    const memMatchPlain = xmlText.match(/<memory>(\d+)<\/memory>/);
    const vcpuMatch = xmlText.match(/<vcpu[^>]*>(\d+)<\/vcpu>/);
    const archMatch = xmlText.match(new RegExp(`<type\\s+arch=${q}`));
    const osTypeMatch = xmlText.match(/<type[^>]*>([^<]+)<\/type>/);
    const bootDevMatch = xmlText.match(new RegExp(`<boot\\s+dev=${q}`));
    const dcMatch = xmlText.match(/<vmware:datacenterpath>([^<]+)<\/vmware:datacenterpath>/);
    const morefMatch = xmlText.match(/<vmware:moref>([^<]+)<\/vmware:moref>/);

    // vCPUs from topology if <vcpu> not present
    let vcpus = vcpuMatch ? parseInt(vcpuMatch[1], 10) : 0;
    if (!vcpus) {
      const topoMatch = xmlText.match(new RegExp(`<topology\\s+sockets=${q}\\s+cores=${q}`));
      if (topoMatch) {
        vcpus = parseInt(topoMatch[1], 10) * parseInt(topoMatch[2], 10);
        // Check for threads attribute
        const threadsMatch = xmlText.match(new RegExp(`<topology[^>]+threads=${q}`));
        if (threadsMatch) vcpus *= parseInt(threadsMatch[1], 10);
      }
    }

    let memoryKiB = 0;
    if (memMatchUnit) {
      const unit = memMatchUnit[1].toLowerCase();
      const val = parseInt(memMatchUnit[2], 10);
      if (unit === 'kib' || unit === 'k') memoryKiB = val;
      else if (unit === 'mib' || unit === 'm') memoryKiB = val * 1024;
      else if (unit === 'gib' || unit === 'g') memoryKiB = val * 1024 * 1024;
      else memoryKiB = val; // default to KiB
    } else if (memMatchPlain) {
      memoryKiB = parseInt(memMatchPlain[1], 10); // default unit is KiB
    }

    vm = {
      name: nameMatch?.[1] || '',
      uuid: uuidMatch?.[1] || '',
      memoryKiB,
      vcpus,
      osArch: archMatch?.[1] || '',
      osType: osTypeMatch?.[1] || '',
      bootDev: bootDevMatch?.[1] || '',
      domainType: domainTypeMatch?.[1] || '',
      datacenterPath: dcMatch?.[1] || '',
      moref: morefMatch?.[1] || '',
    };

    // Disks — handle both type='file' and type='block', both <source file=...> and <source dev=...>
    const diskRegex = new RegExp(
      `<disk\\s+type=${q}\\s+device=${q}>[\\s\\S]*?<source\\s+(?:file|dev)=${q}[\\s\\S]*?<target\\s+dev=${q}\\s+bus=${q}`,
      'g',
    );
    let diskMatch;
    while ((diskMatch = diskRegex.exec(xmlText)) !== null) {
      if (diskMatch[2] === 'disk') {
        // Extract driver type from the matched disk block
        const diskBlock = diskMatch[0];
        const driverTypeMatch = diskBlock.match(new RegExp(`<driver[^>]+type=${q}`));
        disks.push({
          source: diskMatch[3],
          target: diskMatch[4],
          bus: diskMatch[5],
          driverType: driverTypeMatch?.[1] || '',
          diskType: diskMatch[1],
        });
      }
    }

    // NICs — handle both quote styles
    const nicRegex = new RegExp(
      `<interface\\s+type=${q}>[\\s\\S]*?<mac\\s+address=${q}[\\s\\S]*?<model\\s+type=${q}`,
      'g',
    );
    let nicMatch;
    while ((nicMatch = nicRegex.exec(xmlText)) !== null) {
      const nicSlice = xmlText.slice(nicMatch.index);
      const switchMatch = nicSlice.match(new RegExp(`<source\\s+switchid=${q}[^>]*portgroupid=${q}`));
      nics.push({
        mac: nicMatch[2],
        model: nicMatch[3],
        switchId: switchMatch?.[1] || '',
        portgroupId: switchMatch?.[2] || '',
      });
    }

    // Controllers
    const ctrlRegex = new RegExp(`<controller\\s+type=${q}[^>]*model=${q}`, 'g');
    let ctrlMatch;
    while ((ctrlMatch = ctrlRegex.exec(xmlText)) !== null) {
      controllers.push({ type: ctrlMatch[1], model: ctrlMatch[2] });
    }
  }

  // ── Parse NBDKIT instances ────────────────────────────────────────
  // Each "running nbdkit:" block followed by command line
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.includes('running nbdkit:') || line.match(/^\s*LANG=C\s+'nbdkit'/)) {
      // Find the full command line (may be on this line or the next)
      let cmdLine = line;
      if (line.includes('running nbdkit:') && i + 1 < lines.length) {
        cmdLine = lines[i + 1];
      }

      const instance: NbdkitInstance = {
        vmdk: '',
        socket: '',
        server: '',
        user: '',
        thumbprint: '',
        filters: [],
        vddkVersion: '',
        transportModes: '',
      };

      // Extract from command line — handle both 'quoted' and unquoted args
      const socketMatch = cmdLine.match(/'--unix'\s+'([^']+)'/) || cmdLine.match(/--unix\s+(\S+)/);
      if (socketMatch) instance.socket = socketMatch[1];

      const serverMatch = cmdLine.match(/'server=([^']+)'/) || cmdLine.match(/server=(\S+)/);
      if (serverMatch) instance.server = serverMatch[1];

      const fileMatch = cmdLine.match(/'file=([^']+)'/) || cmdLine.match(/file=(\S+)/);
      if (fileMatch) instance.vmdk = fileMatch[1];

      const userMatch = cmdLine.match(/'user=([^']+)'/) || cmdLine.match(/user=(\S+)/);
      if (userMatch) instance.user = userMatch[1];

      const thumbMatch = cmdLine.match(/'thumbprint=([^']+)'/) || cmdLine.match(/thumbprint=(\S+)/);
      if (thumbMatch) instance.thumbprint = thumbMatch[1];

      // Filters — handle both 'quoted' and unquoted
      const filterRegex = /(?:'--filter'\s+'([^']+)'|--filter\s+(\S+))/g;
      let fm;
      while ((fm = filterRegex.exec(cmdLine)) !== null) {
        instance.filters.push(fm[1] || fm[2]);
      }

      // Look ahead for VDDK version and transport modes
      for (let j = i + 1; j < Math.min(i + 300, lines.length); j++) {
        const vddkVerMatch = lines[j].match(/VMware VixDiskLib \(([^)]+)\)/);
        if (vddkVerMatch && !instance.vddkVersion) {
          instance.vddkVersion = vddkVerMatch[1];
        }
        const transMatch = lines[j].match(/Available transport modes:\s+(.+)/);
        if (transMatch && !instance.transportModes) {
          instance.transportModes = transMatch[1].trim().replace(/\.$/, '');
        }
        // Stop at next "running nbdkit:" block
        if (j > i + 1 && lines[j].includes('running nbdkit:')) break;
      }

      if (instance.vmdk || instance.socket) {
        // Avoid duplicates (nbdkit re-execs itself)
        if (!nbdkitInstances.some((n) => n.socket === instance.socket)) {
          nbdkitInstances.push(instance);
        }
      }
    }
  }

  // ── Parse OVA source ───────────────────────────────────────────────
  let ova: OvaSource | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // "ova: orig_ova = /ova/file.ova, top_dir = /var/tmp/ova.xxx, ova_type = TarOptimized /ova/file.ova"
    const ovaInfoMatch = line.match(/ova:\s*orig_ova\s*=\s*(\S+),\s*top_dir\s*=\s*(\S+),\s*ova_type\s*=\s*(.+)/);
    if (ovaInfoMatch && !ova) {
      ova = {
        ovaPath: ovaInfoMatch[1],
        extractDir: ovaInfoMatch[2],
        ovaType: ovaInfoMatch[3].trim(),
        ovfFile: '',
        manifestFile: '',
        disks: [],
      };
    }

    // "tar -xf '...' -C '...' 'file.ovf' 'file.mf'"
    if (ova && line.includes('tar -xf') && line.includes('.ovf')) {
      const ovfMatch = line.match(/'([^']*\.ovf)'/);
      const mfMatch = line.match(/'([^']*\.mf)'/);
      if (ovfMatch) ova.ovfFile = ovfMatch[1];
      if (mfMatch) ova.manifestFile = mfMatch[1];
    }

    // "ova: processing manifest file /var/tmp/.../file.mf"
    if (ova && !ova.manifestFile) {
      const mfMatch = line.match(/ova:\s*processing manifest file\s+(\S+)/);
      if (mfMatch) ova.manifestFile = mfMatch[1];
    }

    // qemu-nbd with json offset/size — extract disk info
    // 'json:{ "file": { "driver": "raw", "offset": 48640, "size": 2922259968, ... "filename": "/ova/file.ova" } }'
    const qemuNbdMatch = line.match(/qemu-nbd.*'--socket'\s+'([^']+)'\s+.*json:\{/);
    if (qemuNbdMatch && ova) {
      const socket = qemuNbdMatch[1];
      // Extract offset and size from the json blob
      const offsetMatch = line.match(/"offset":\s*(\d+)/);
      const sizeMatch = line.match(/"size":\s*(\d+)/);
      // Extract disk name from the OVA path context — look for the filename in nearby lines
      let diskName = '';
      // Look backwards for "ova: testing if ... exists"
      for (let k = i - 1; k >= Math.max(0, i - 10); k--) {
        const testMatch = lines[k].match(/ova:\s*testing if\s+(\S+)\s+exists/);
        if (testMatch) {
          diskName = testMatch[1];
          break;
        }
      }
      ova.disks.push({
        name: diskName,
        offsetBytes: offsetMatch ? parseInt(offsetMatch[1], 10) : 0,
        sizeBytes: sizeMatch ? parseInt(sizeMatch[1], 10) : 0,
        socket,
      });
    }
  }

  // Also detect qemu-nbd with 'running qemu-nbd:' header
  for (let i = 0; i < lines.length; i++) {
    if (ova && lines[i].includes('running qemu-nbd:') && i + 1 < lines.length) {
      const cmdLine = lines[i + 1];
      const socketMatch = cmdLine.match(/'--socket'\s+'([^']+)'/);
      const offsetMatch = cmdLine.match(/"offset":\s*(\d+)/);
      const sizeMatch = cmdLine.match(/"size":\s*(\d+)/);
      if (socketMatch && !ova.disks.some((d) => d.socket === socketMatch[1])) {
        let diskName = '';
        for (let k = i - 1; k >= Math.max(0, i - 10); k--) {
          const testMatch = lines[k].match(/ova:\s*testing if\s+(\S+)\s+exists/);
          if (testMatch) {
            diskName = testMatch[1];
            break;
          }
        }
        ova.disks.push({
          name: diskName,
          offsetBytes: offsetMatch ? parseInt(offsetMatch[1], 10) : 0,
          sizeBytes: sizeMatch ? parseInt(sizeMatch[1], 10) : 0,
          socket: socketMatch[1],
        });
      }
    }
  }

  return { vm, disks, nics, controllers, nbdkitInstances, ova };
}

// ── Component ───────────────────────────────────────────────────────────────

export function SourceSetupView({ content }: { content: string[] }) {
  const parsed = useMemo(() => parseSourceSetup(content), [content]);

  const hasData = parsed.vm !== null || parsed.nbdkitInstances.length > 0 || parsed.ova !== null;
  if (!hasData) return null;

  return (
    <div className="space-y-4">
      {parsed.ova && <OvaSection ova={parsed.ova} />}
      {parsed.vm && <VmSection vm={parsed.vm} disks={parsed.disks} nics={parsed.nics} controllers={parsed.controllers} />}
      {parsed.nbdkitInstances.length > 0 && <NbdkitSection instances={parsed.nbdkitInstances} />}
    </div>
  );
}

// ── Sub-sections ────────────────────────────────────────────────────────────

function OvaSection({ ova }: { ova: OvaSource }) {
  // Extract just the filename from the full OVA path
  const ovaFilename = ova.ovaPath.split('/').pop() || ova.ovaPath;

  return (
    <div>
      <SectionHeader title="OVA Source" />
      <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
        {/* Header */}
        <div className="px-3 py-2 bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-xs font-semibold text-slate-700 dark:text-gray-200">
              {ovaFilename}
            </span>
            <span className="px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/30 text-[10px] text-amber-700 dark:text-amber-300 font-medium">
              OVA
            </span>
            {ova.ovaType && (
              <span className="px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-[10px] text-slate-600 dark:text-gray-300">
                {ova.ovaType}
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[10px] text-slate-500 dark:text-gray-400">
            <span className="font-mono" title="OVA path">{ova.ovaPath}</span>
          </div>
        </div>

        {/* OVF / Manifest */}
        {(ova.ovfFile || ova.manifestFile) && (
          <div className="px-3 py-2 border-b border-slate-100 dark:border-slate-800 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
            {ova.ovfFile && (
              <div>
                <span className="text-slate-400 dark:text-gray-500 mr-1">OVF:</span>
                <span className="font-mono text-slate-600 dark:text-gray-300">{ova.ovfFile}</span>
              </div>
            )}
            {ova.manifestFile && (
              <div>
                <span className="text-slate-400 dark:text-gray-500 mr-1">Manifest:</span>
                <span className="font-mono text-slate-600 dark:text-gray-300">
                  {ova.manifestFile.split('/').pop() || ova.manifestFile}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Disks */}
        {ova.disks.length > 0 && (
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-left text-slate-400 dark:text-gray-500 border-b border-slate-100 dark:border-slate-800">
                <th className="px-3 py-1 font-medium">Disk</th>
                <th className="px-3 py-1 font-medium">Size</th>
                <th className="px-3 py-1 font-medium">Offset</th>
                <th className="px-3 py-1 font-medium">Socket</th>
              </tr>
            </thead>
            <tbody>
              {ova.disks.map((disk, idx) => (
                <tr key={idx} className="border-b border-slate-50 dark:border-slate-800/50 hover:bg-slate-50 dark:hover:bg-slate-800/30">
                  <td className="px-3 py-1.5 font-mono text-slate-700 dark:text-gray-300">
                    {disk.name || `disk-${idx}`}
                  </td>
                  <td className="px-3 py-1.5 text-slate-600 dark:text-gray-300">
                    {disk.sizeBytes > 0 ? formatBytes(disk.sizeBytes) : '—'}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-[10px] text-slate-500 dark:text-gray-400">
                    {disk.offsetBytes > 0 ? `${disk.offsetBytes.toLocaleString()} B` : '—'}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-[10px] text-slate-500 dark:text-gray-400 truncate max-w-[200px]" title={disk.socket}>
                    {disk.socket}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function VmSection({
  vm,
  disks,
  nics,
  controllers,
}: {
  vm: SourceVm;
  disks: SourceDisk[];
  nics: SourceNic[];
  controllers: SourceController[];
}) {
  return (
    <div>
      <SectionHeader title="Source VM (Libvirt)" />
      <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
        {/* Header */}
        <div className="px-3 py-2 bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700 flex items-baseline gap-2 flex-wrap">
          <span className="text-xs font-semibold text-slate-700 dark:text-gray-200">
            {vm.name}
          </span>
          {vm.domainType && (
            <span className="px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-[10px] text-slate-600 dark:text-gray-300">
              {vm.domainType}
            </span>
          )}
          {vm.moref && (
            <span className="font-mono text-[10px] text-slate-400 dark:text-gray-500">
              {vm.moref}
            </span>
          )}
        </div>

        {/* Properties */}
        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 px-3 py-2 text-[11px]">
          {vm.osType && (
            <>
              <span className="text-slate-400 dark:text-gray-500">OS Type</span>
              <span className="text-slate-700 dark:text-gray-200">{vm.osType}</span>
            </>
          )}
          {vm.memoryKiB > 0 && (
            <>
              <span className="text-slate-400 dark:text-gray-500">Memory</span>
              <span className="text-slate-700 dark:text-gray-200">{formatBytes(vm.memoryKiB * 1024)}</span>
            </>
          )}
          {vm.vcpus > 0 && (
            <>
              <span className="text-slate-400 dark:text-gray-500">vCPUs</span>
              <span className="text-slate-700 dark:text-gray-200">{vm.vcpus}</span>
            </>
          )}
          {vm.osArch && (
            <>
              <span className="text-slate-400 dark:text-gray-500">Architecture</span>
              <span className="text-slate-700 dark:text-gray-200">{vm.osArch}</span>
            </>
          )}
          {vm.bootDev && (
            <>
              <span className="text-slate-400 dark:text-gray-500">Boot</span>
              <span className="text-slate-700 dark:text-gray-200">{vm.bootDev}</span>
            </>
          )}
          {vm.datacenterPath && (
            <>
              <span className="text-slate-400 dark:text-gray-500">Datacenter</span>
              <span className="text-slate-700 dark:text-gray-200">{vm.datacenterPath}</span>
            </>
          )}
          {vm.uuid && (
            <>
              <span className="text-slate-400 dark:text-gray-500">UUID</span>
              <span className="font-mono text-[10px] text-slate-600 dark:text-gray-300">{vm.uuid}</span>
            </>
          )}
        </div>

        {/* Disks */}
        {disks.length > 0 && (
          <div className="px-3 py-2 border-t border-slate-100 dark:border-slate-800">
            <span className="text-[10px] text-slate-400 dark:text-gray-500 font-semibold uppercase">Disks</span>
            {disks.map((d, i) => (
              <div key={i} className="flex items-baseline gap-2 text-[11px] pl-2 mt-0.5">
                <span className="font-mono text-slate-600 dark:text-gray-300">{d.target}</span>
                <span className="px-1 py-0 rounded bg-slate-100 dark:bg-slate-800 text-[9px] text-slate-500 dark:text-gray-400">
                  {d.bus}
                </span>
                {d.driverType && (
                  <span className="px-1 py-0 rounded bg-blue-50 dark:bg-blue-900/20 text-[9px] text-blue-600 dark:text-blue-300 border border-blue-200 dark:border-blue-800">
                    {d.driverType}
                  </span>
                )}
                {d.diskType && d.diskType !== 'file' && (
                  <span className="px-1 py-0 rounded bg-amber-50 dark:bg-amber-900/20 text-[9px] text-amber-600 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
                    {d.diskType}
                  </span>
                )}
                {controllers.find((c) => c.type === d.bus || (c.type === 'scsi' && d.bus === 'scsi')) && (
                  <span className="px-1 py-0 rounded bg-indigo-50 dark:bg-indigo-900/20 text-[9px] text-indigo-500 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800">
                    {controllers.find((c) => c.type === 'scsi')?.model || d.bus}
                  </span>
                )}
                <span className="font-mono text-[10px] text-slate-400 dark:text-gray-500 truncate" title={d.source}>
                  {d.source.startsWith('/dev/') ? d.source : d.source.split('/').pop()}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* NICs */}
        {nics.length > 0 && (
          <div className="px-3 py-2 border-t border-slate-100 dark:border-slate-800">
            <span className="text-[10px] text-slate-400 dark:text-gray-500 font-semibold uppercase">Network Adapters</span>
            {nics.map((nic, i) => (
              <div key={i} className="flex items-baseline gap-2 text-[11px] pl-2 mt-0.5">
                <span className="font-mono text-[10px] text-slate-600 dark:text-gray-300">{nic.mac}</span>
                <span className="px-1 py-0 rounded bg-slate-100 dark:bg-slate-800 text-[9px] text-slate-500 dark:text-gray-400">
                  {nic.model}
                </span>
                {nic.portgroupId && (
                  <span className="font-mono text-[10px] text-slate-400 dark:text-gray-500">
                    {nic.portgroupId}
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

function NbdkitSection({ instances }: { instances: NbdkitInstance[] }) {
  return (
    <div>
      <SectionHeader title="NBDKIT Source Connections" />
      <div className="space-y-2">
        {instances.map((inst, i) => (
          <div key={i} className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
            {/* Header: VMDK path */}
            <div className="px-3 py-2 bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700 flex items-center gap-2 flex-wrap">
              <span className="font-mono text-[10px] text-slate-700 dark:text-gray-200 truncate" title={inst.vmdk}>
                {inst.vmdk}
              </span>
              {inst.vddkVersion && (
                <span className="px-1.5 py-0.5 rounded bg-indigo-50 dark:bg-indigo-900/20 text-[9px] text-indigo-600 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800">
                  VDDK {inst.vddkVersion}
                </span>
              )}
            </div>

            {/* Properties */}
            <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 px-3 py-2 text-[11px]">
              {inst.server && (
                <>
                  <span className="text-slate-400 dark:text-gray-500">Server</span>
                  <span className="font-mono text-slate-700 dark:text-gray-200">{inst.server}</span>
                </>
              )}
              {inst.socket && (
                <>
                  <span className="text-slate-400 dark:text-gray-500">Socket</span>
                  <span className="font-mono text-[10px] text-slate-600 dark:text-gray-300">{inst.socket}</span>
                </>
              )}
              {inst.user && (
                <>
                  <span className="text-slate-400 dark:text-gray-500">User</span>
                  <span className="text-slate-700 dark:text-gray-200">{inst.user}</span>
                </>
              )}
              {inst.thumbprint && (
                <>
                  <span className="text-slate-400 dark:text-gray-500">Thumbprint</span>
                  <span className="font-mono text-[10px] text-slate-500 dark:text-gray-400">{inst.thumbprint}</span>
                </>
              )}
              {inst.transportModes && (
                <>
                  <span className="text-slate-400 dark:text-gray-500">Transport</span>
                  <div className="flex gap-1 flex-wrap">
                    {inst.transportModes.split(':').map((mode) => (
                      <span
                        key={mode}
                        className="px-1.5 py-0 rounded bg-slate-100 dark:bg-slate-800 text-[9px] text-slate-600 dark:text-gray-300"
                      >
                        {mode}
                      </span>
                    ))}
                  </div>
                </>
              )}
              {inst.filters.length > 0 && (
                <>
                  <span className="text-slate-400 dark:text-gray-500">Filters</span>
                  <div className="flex gap-1 flex-wrap">
                    {inst.filters.map((f) => (
                      <span
                        key={f}
                        className="px-1.5 py-0 rounded bg-blue-50 dark:bg-blue-900/20 text-[9px] text-blue-600 dark:text-blue-300 border border-blue-200 dark:border-blue-800"
                      >
                        {f}
                      </span>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
