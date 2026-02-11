/**
 * Structured visualization for the Linux conversion pipeline stage.
 *
 * Parses kernel analysis, package removal, driver configuration,
 * initramfs rebuild, GRUB config, guest capabilities, and augeas errors.
 */
import { useMemo, useState } from 'react';
import type { V2VToolRun } from '../../types/v2v';
import { SectionHeader } from './shared';
import { V2VFileTree } from './V2VFileTree';

// ── Types ───────────────────────────────────────────────────────────────────

interface KernelInfo {
  name: string; // e.g. "kernel-core"
  version: string; // e.g. "5.14.0-503.11.1.el9_5.x86_64"
  arch: string;
  vmlinuz: string;
  initramfs: string;
  config: string;
  modulesDir: string;
  modulesCount: number;
  virtio: Record<string, boolean>; // blk, net, rng, balloon, pvpanic, vsock, xen, debug
  isBest: boolean;
  isDefault: boolean;
}

interface RemovedPackage {
  name: string;
  arch: string;
  version: string;
  repo: string;
  size: string;
}

interface PackageOperation {
  /** 'dnf' | 'apt' | 'yum' | 'zypper' | string */
  manager: string;
  command: string;
  packages: RemovedPackage[];
  freedSpace: string;
  durationSecs: number | null;
}

interface BootConfig {
  bootloader: string; // e.g. "grub2"
  bootloaderPath: string; // e.g. "/boot/grub2/grub.cfg"
  efiFiles: string[];
  grubCmdline: string;
  fstabEntries: { spec: string; mount?: string }[];
  blockDeviceMap: { from: string; to: string }[];
}

interface InitramfsRebuild {
  /** 'dracut' | 'update-initramfs' | string */
  tool: string;
  command: string;
  includedModules: string[];
  compressionMethod: string;
  durationSecs: number | null;
  initramfsPath: string;
  /** Categorized entries from the full initramfs output (Debian update-initramfs) */
  binaries: string[];
  firmware: string[];
  configs: string[];
  hooks: string[];
  copyDirs: { dir: string; excludes: string }[];
  microcodeCount: number;
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

interface AugeasError {
  file: string;
  message: string;
  line: string;
  char: string;
  lens: string;
}

interface ParsedLinuxConversion {
  conversionModule: string;
  osDetected: string; // from libosinfo
  kernels: KernelInfo[];
  candidatePackages: string[];
  packageOps: PackageOperation[];
  boot: BootConfig;
  initramfs: InitramfsRebuild | null;
  guestCaps: GuestCaps | null;
  augeasErrors: AugeasError[];
  cleanupChecks: string[]; // VBox, Parallels, VMware checks
  modprobeAliases: { alias: string; module: string }[];
  defaultKernel: string; // DEFAULTKERNEL value
}

// ── Parser ──────────────────────────────────────────────────────────────────

function parseLinuxConversion(lines: string[]): ParsedLinuxConversion {
  const result: ParsedLinuxConversion = {
    conversionModule: '',
    osDetected: '',
    kernels: [],
    candidatePackages: [],
    packageOps: [],
    boot: {
      bootloader: '',
      bootloaderPath: '',
      efiFiles: [],
      grubCmdline: '',
      fstabEntries: [],
      blockDeviceMap: [],
    },
    initramfs: null,
    guestCaps: null,
    augeasErrors: [],
    cleanupChecks: [],
    modprobeAliases: [],
    defaultKernel: '',
  };

  let currentKernel: KernelInfo | null = null;
  let inKernelBlock = false;

  // Package manager state (generic: dnf, apt-get, yum, zypper)
  let inPkgOutput = false;
  let pkgManager = '';
  let pkgCommand = '';
  let pkgPackages: RemovedPackage[] = [];
  let pkgFreed = '';
  let pkgDuration: number | null = null;

  // Initramfs rebuild state (generic: dracut, update-initramfs)
  const initramfsModules: string[] = [];
  let initramfsCommand = '';
  let initramfsTool = '';
  let initramfsCompression = '';
  let initramfsDuration: number | null = null;
  let initramfsPath = '';
  const initramfsBinaries: string[] = [];
  const initramfsFirmware: string[] = [];
  const initramfsConfigs: string[] = [];
  const initramfsHooks: string[] = [];
  const initramfsCopyDirs: { dir: string; excludes: string }[] = [];
  let initramfsMicrocodeCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // ── Conversion module ────────────────────────────────────────────
    const modMatch = line.match(/picked conversion module (\S+)/);
    if (modMatch) {
      result.conversionModule = modMatch[1];
    }

    // ── libosinfo OS detection ───────────────────────────────────────
    const osMatch = line.match(/libosinfo: loaded OS:\s*(.*)/);
    if (osMatch) {
      // Extract the readable part from the URL
      const url = osMatch[1].trim();
      const rhelMatch = url.match(/redhat\.com\/rhel\/(.+)/);
      if (rhelMatch) {
        result.osDetected = `RHEL ${rhelMatch[1]}`;
      } else {
        result.osDetected = url;
      }
    }

    // ── Candidate kernel packages ────────────────────────────────────
    const candidateMatch = line.match(/^info: candidate kernel packages.*?:\s*(.*)/);
    if (candidateMatch) {
      result.candidatePackages = candidateMatch[1].trim().split(/\s+/);
    }

    // ── Kernel info blocks ───────────────────────────────────────────
    // "* kernel-core 5.14.0-503.11.1.el9_5.x86_64 (x86_64)"
    const kernelHeader = line.match(/^\*\s+(\S+)\s+(\S+)\s+\((\S+)\)/);
    if (kernelHeader) {
      // Flush previous kernel
      if (currentKernel) {
        result.kernels.push(currentKernel);
      }

      const isBest = lines.some(
        (l, j) => j < i && j > i - 3 && l.includes('best kernel'),
      );
      const isDefault = lines.some(
        (l, j) => j < i && j > i - 3 && l.includes('default'),
      );

      currentKernel = {
        name: kernelHeader[1],
        version: kernelHeader[2],
        arch: kernelHeader[3],
        vmlinuz: '',
        initramfs: '',
        config: '',
        modulesDir: '',
        modulesCount: 0,
        virtio: {},
        isBest,
        isDefault,
      };
      inKernelBlock = true;
      continue;
    }

    if (inKernelBlock && currentKernel) {
      const trimmed = line.replace(/^\t/, '');
      if (trimmed.startsWith('/boot/vmlinuz-')) {
        currentKernel.vmlinuz = trimmed;
      } else if (trimmed.startsWith('/boot/initramfs-')) {
        currentKernel.initramfs = trimmed;
      } else if (trimmed.startsWith('/boot/config-')) {
        currentKernel.config = trimmed;
      } else if (trimmed.startsWith('/lib/modules/')) {
        currentKernel.modulesDir = trimmed;
      } else if (trimmed.match(/^\d+ modules found/)) {
        currentKernel.modulesCount = parseInt(trimmed, 10);
      } else if (trimmed.startsWith('virtio:')) {
        // "virtio: blk=true net=true rng=true balloon=true"
        const pairs = trimmed.replace('virtio:', '').trim().split(/\s+/);
        for (const p of pairs) {
          const [k, v] = p.split('=');
          if (k && v) currentKernel.virtio[k] = v === 'true';
        }
      } else if (trimmed.match(/^(pvpanic|vsock|xen|debug)=/)) {
        // continuation line "pvpanic=true vsock=true xen=false debug=false"
        const pairs = trimmed.trim().split(/\s+/);
        for (const p of pairs) {
          const [k, v] = p.split('=');
          if (k && v) currentKernel.virtio[k] = v === 'true';
        }
      } else if (!trimmed.startsWith('\t') && !trimmed.startsWith(' ') && trimmed.length > 0 && !trimmed.match(/^\d/) && !trimmed.startsWith('virtio') && !trimmed.startsWith('pvpanic')) {
        // End of kernel block
        inKernelBlock = false;
      }
    }

    // ── Augeas parse errors ──────────────────────────────────────────
    const augErrMatch = line.match(/^augeas failed to parse (.*?):/);
    if (augErrMatch) {
      const file = augErrMatch[1].trim();
      // Next line has the error details
      const detailLine = (i + 1 < lines.length) ? lines[i + 1] : '';
      const detailMatch = detailLine.match(/error "(.+?)"\s+at line (\d+)\s+char (\d+)\s+in lens\s+(.+)/);
      if (detailMatch) {
        result.augeasErrors.push({
          file,
          message: detailMatch[1],
          line: detailMatch[2],
          char: detailMatch[3],
          lens: detailMatch[4].replace(/:$/, ''),
        });
        i++; // skip detail line
      } else {
        result.augeasErrors.push({ file, message: '', line: '', char: '', lens: '' });
      }
    }

    // ── Bootloader detection ─────────────────────────────────────────
    const bootMatch = line.match(/^detected bootloader (\S+) at (.+)/);
    if (bootMatch) {
      result.boot.bootloader = bootMatch[1];
      result.boot.bootloaderPath = bootMatch[2].trim();
    }

    // ── EFI files ────────────────────────────────────────────────────
    // "find = ["/BOOT", "/BOOT/BOOTX64.EFI", ...]"
    if (line.includes('find =') && line.includes('/EFI')) {
      const arrMatch = line.match(/find = \[(.+)\]/);
      if (arrMatch) {
        try {
          const items = arrMatch[1].split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
          result.boot.efiFiles = items.filter((f) => f.length > 0);
        } catch { /* ignore */ }
      }
    }

    // ── GRUB_CMDLINE_LINUX ───────────────────────────────────────────
    if (line.includes('aug_get') && line.includes('GRUB_CMDLINE_LINUX')) {
      // Next relevant line: aug_get = "..."
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const valMatch = lines[j].match(/aug_get = "(.+)"/);
        if (valMatch && valMatch[1].includes('=')) {
          result.boot.grubCmdline = valMatch[1].replace(/^"|"$/g, '');
          break;
        }
      }
    }

    // ── Block device map ─────────────────────────────────────────────
    const bdmMatch = line.match(/^info: block device map:/);
    if (bdmMatch) {
      for (let j = i + 1; j < lines.length; j++) {
        const mapLine = lines[j].match(/^\t(\S+)\s+->\s+(\S+)/);
        if (mapLine) {
          result.boot.blockDeviceMap.push({ from: mapLine[1], to: mapLine[2] });
        } else {
          break;
        }
      }
    }

    // ── fstab entries ────────────────────────────────────────────────
    const fstabMatch = line.match(/aug_get = "(.+)"/);
    if (fstabMatch && line.includes('aug_get') && line.includes('fstab')) {
      result.boot.fstabEntries.push({ spec: fstabMatch[1] });
    }
    // Simpler: pick them from aug_get for /files/etc/fstab/*/spec
    if (line.includes('/files/etc/fstab/') && line.includes('/spec') && line.includes('aug_get =')) {
      const specVal = line.match(/aug_get = "(.+?)"/);
      if (specVal) {
        result.boot.fstabEntries.push({ spec: specVal[1] });
      }
    }

    // ── Package removal (dnf / yum / apt-get / zypper) ─────────────
    // DNF / YUM: sh "dnf -y remove ..." or sh "yum -y remove ..."
    const dnfMatch = line.match(/sh "((?:dnf|yum) -y remove .+?)"/);
    if (dnfMatch) {
      inPkgOutput = true;
      pkgManager = dnfMatch[1].startsWith('yum') ? 'yum' : 'dnf';
      pkgCommand = dnfMatch[1].replace(/'/g, '');
      pkgPackages = [];
      pkgFreed = '';
      pkgDuration = null;
      continue;
    }

    // APT: sh "\n      export DEBIAN_FRONTEND=noninteractive\n      ...apt-get ... remove ..."
    // or sh "apt-get ... remove ..."
    if (!inPkgOutput && line.includes('sh "') && line.includes('apt-get') && line.includes('remove')) {
      inPkgOutput = true;
      pkgManager = 'apt';
      // Extract the package names from the command
      const aptPkgMatch = line.match(/remove\s+(.+?)(?:\\n|\s*")/);
      pkgCommand = aptPkgMatch
        ? `apt-get remove ${aptPkgMatch[1].replace(/'/g, '').trim()}`
        : 'apt-get remove';
      pkgPackages = [];
      pkgFreed = '';
      pkgDuration = null;
      continue;
    }

    // Zypper: sh "zypper ... remove ..."
    if (!inPkgOutput && line.includes('sh "') && line.includes('zypper') && line.includes('remove')) {
      inPkgOutput = true;
      pkgManager = 'zypper';
      pkgCommand = 'zypper remove';
      pkgPackages = [];
      pkgFreed = '';
      pkgDuration = null;
      continue;
    }

    if (inPkgOutput) {
      // Duration line: "sh (0x6f) took 11.55 secs"
      const durationMatch = line.match(/took (\d+\.\d+) secs/);
      if (durationMatch && line.includes('sh')) {
        pkgDuration = parseFloat(durationMatch[1]);
      }

      // "sh = " line with the full output
      if (line.includes('sh = "')) {
        const outputMatch = line.match(/sh = "([\s\S]+)"/);
        if (outputMatch) {
          const output = outputMatch[1].replace(/\\n/g, '\n').replace(/\\r/g, '');

          if (pkgManager === 'dnf' || pkgManager === 'yum') {
            // Parse freed space (DNF/YUM)
            const freedMatch = output.match(/Freed space:\s*(.+)/);
            if (freedMatch) pkgFreed = freedMatch[1].trim();

            // Parse DNF/YUM package table
            const tableLines = output.split('\n');
            let inTable = false;
            for (const tl of tableLines) {
              if (tl.includes('Removing:') || tl.includes('Removing unused dependencies:')) {
                inTable = true;
                continue;
              }
              if (inTable && tl.includes('Transaction Summary')) {
                inTable = false;
                continue;
              }
              if (inTable) {
                const pkgRowMatch = tl.match(/^\s+(\S+)\s+(x86_64|noarch|i686|aarch64)\s+(\S+)\s+@?(\S+)\s+(.+)/);
                if (pkgRowMatch) {
                  pkgPackages.push({
                    name: pkgRowMatch[1],
                    arch: pkgRowMatch[2],
                    version: pkgRowMatch[3],
                    repo: pkgRowMatch[4],
                    size: pkgRowMatch[5].trim(),
                  });
                }
              }
            }
          } else if (pkgManager === 'apt') {
            // Parse APT output: "Removing open-vm-tools (2:12.2.0-1+deb12u4) ..."
            const aptFreedMatch = output.match(/(\d[\d.]*\s*[kKmMgG]?B) disk space will be freed/);
            if (aptFreedMatch) pkgFreed = aptFreedMatch[1].trim();

            const aptLines = output.split('\n');
            for (const tl of aptLines) {
              const aptRmMatch = tl.match(/Removing (\S+) \(([^)]+)\)/);
              if (aptRmMatch) {
                pkgPackages.push({
                  name: aptRmMatch[1],
                  arch: '',
                  version: aptRmMatch[2],
                  repo: 'installed',
                  size: '',
                });
              }
            }
          }
          // (zypper parsing can be added similarly)
        }

        result.packageOps.push({
          manager: pkgManager,
          command: pkgCommand,
          packages: pkgPackages,
          freedSpace: pkgFreed,
          durationSecs: pkgDuration,
        });
        inPkgOutput = false;
      }
    }

    // ── DEFAULTKERNEL ────────────────────────────────────────────────
    if (line.includes('aug_set') && line.includes('DEFAULTKERNEL/value')) {
      const dkMatch = line.match(/"([^"]+)"$/);
      if (dkMatch) result.defaultKernel = dkMatch[1];
    }

    // ── Modprobe aliases ─────────────────────────────────────────────
    // aug_set "/files/etc/modprobe.d/virt-v2v-added.conf/alias[last()+1]" "scsi_hostadapter"
    // followed by: aug_set "...modulename" "virtio_blk"
    if (line.includes('aug_set') && line.includes('modprobe.d') && line.includes('/alias[')) {
      const aliasVal = line.match(/"([^"]+)"$/);
      if (aliasVal) {
        // Look for the modulename line
        for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
          if (lines[j].includes('modulename')) {
            const modVal = lines[j].match(/"([^"]+)"$/);
            if (modVal) {
              result.modprobeAliases.push({ alias: aliasVal[1], module: modVal[1] });
            }
            break;
          }
        }
      }
    }

    // ── Initramfs rebuild (dracut / update-initramfs / mkinitrd) ────
    // Dracut command
    const dracutCmdMatch = line.match(/command "(.+?dracut.+?)"/);
    if (dracutCmdMatch) {
      initramfsCommand = dracutCmdMatch[1];
      initramfsTool = 'dracut';
    }

    // update-initramfs command (Debian/Ubuntu)
    const updateInitramfsCmdMatch = line.match(/command "(.+?update-initramfs.+?)"/);
    if (updateInitramfsCmdMatch) {
      initramfsCommand = updateInitramfsCmdMatch[1];
      initramfsTool = 'update-initramfs';
    }

    // mkinitrd command (SUSE)
    const mkinitrdCmdMatch = line.match(/command "(.+?mkinitrd.+?)"/);
    if (mkinitrdCmdMatch && !line.includes('update-initramfs')) {
      initramfsCommand = mkinitrdCmdMatch[1];
      initramfsTool = 'mkinitrd';
    }

    // Timing from command completion
    if (line.includes('command (0x32) took') && initramfsCommand) {
      const dt = line.match(/took (\d+\.\d+) secs/);
      if (dt) initramfsDuration = parseFloat(dt[1]);
    }

    // Dracut modules: "dracut: *** Including module: xxx ***"
    const dracutModMatch = line.match(/dracut: \*\*\* Including module: (.+?) \*\*\*/);
    if (dracutModMatch) {
      initramfsModules.push(dracutModMatch[1]);
    }

    // update-initramfs modules: "Adding module /usr/lib/modules/.../virtio_blk.ko"
    const addingModMatch = line.match(/Adding module \/usr\/lib\/modules\/\S+\/(.+\.ko)/);
    if (addingModMatch) {
      initramfsModules.push(addingModMatch[1]);
    }

    // Dracut compression
    const compMatch = line.match(/dracut: (?:dracut: )?using auto-determined compression method '(.+?)'/);
    if (compMatch) initramfsCompression = compMatch[1];

    // Initramfs path — dracut: "Creating initramfs image file '...'"
    const initrdMatch = line.match(/Creating (?:initramfs )?image file '(.+?)'/);
    if (initrdMatch) initramfsPath = initrdMatch[1];

    // Initramfs path — update-initramfs: "Generating /boot/initrd.img-..."
    // Stop at literal \n to avoid capturing the entire command output
    const genInitrdMatch = line.match(/update-initramfs: Generating ([^"\\]+)/);
    if (genInitrdMatch) initramfsPath = genInitrdMatch[1].trim();

    // Parse the full command = "..." result line for update-initramfs output
    // This captures the massive output that contains \n-separated entries
    if (line.includes('command = "') && line.includes('update-initramfs')) {
      const outputMatch = line.match(/command = "([\s\S]+)"/);
      if (outputMatch) {
        const outputLines = outputMatch[1].split(/\\n/);
        let lastCopyDir = '';
        for (const ol of outputLines) {
          const trimOl = ol.trim();
          if (!trimOl) continue;

          // Modules
          const olModMatch = trimOl.match(/Adding module \/usr\/lib\/modules\/\S+\/(.+\.ko)/);
          if (olModMatch) { initramfsModules.push(olModMatch[1]); continue; }

          // Binaries / binary-links
          if (trimOl.startsWith('Adding binary') && !trimOl.includes('module')) {
            const bPath = trimOl.replace(/^Adding binary(?:-link)?\s+/, '');
            initramfsBinaries.push(bPath);
            continue;
          }

          // Firmware
          if (trimOl.startsWith('Adding firmware ')) {
            initramfsFirmware.push(trimOl.replace('Adding firmware ', ''));
            continue;
          }

          // Config
          if (trimOl.startsWith('Adding config ')) {
            initramfsConfigs.push(trimOl.replace('Adding config ', ''));
            continue;
          }

          // Copy directory
          const copyDirMatch = trimOl.match(/Copying module directory (.+)/);
          if (copyDirMatch) {
            lastCopyDir = copyDirMatch[1];
            initramfsCopyDirs.push({ dir: lastCopyDir, excludes: '' });
            continue;
          }

          // Exclusions for copy dir: "(excluding ...)"
          if (trimOl.startsWith('(excluding ') && initramfsCopyDirs.length > 0) {
            initramfsCopyDirs[initramfsCopyDirs.length - 1].excludes = trimOl;
            continue;
          }

          // Hooks
          if (trimOl.startsWith('Calling hook ')) {
            initramfsHooks.push(trimOl.replace('Calling hook ', ''));
            continue;
          }

          // Microcode bundles
          if (trimOl.startsWith('microcode bundle ')) {
            initramfsMicrocodeCount++;
            continue;
          }

          // Generating path (if not already captured)
          if (!initramfsPath) {
            const genMatch = trimOl.match(/update-initramfs: Generating (.+)/);
            if (genMatch) initramfsPath = genMatch[1].trim();
          }
        }
      }
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

    // ── Cleanup checks ───────────────────────────────────────────────
    if (line.includes('is_file') && (
      line.includes('VBoxGuestAdditions') ||
      line.includes('parallels-tools') ||
      line.includes('vmware-uninstall') ||
      line.includes('kudzu')
    )) {
      const checkMatch = line.match(/is_file "(.+?)"/);
      if (checkMatch) {
        const resultMatch = line.match(/is_file = (\d)/);
        const found = resultMatch ? resultMatch[1] === '1' : false;
        result.cleanupChecks.push(`${checkMatch[1]} ${found ? '(found)' : '(not found)'}`);
      }
    }
  }

  // Flush last kernel
  if (currentKernel) {
    result.kernels.push(currentKernel);
  }

  // Deduplicate kernels (same name+version shown multiple times)
  const seen = new Set<string>();
  result.kernels = result.kernels.filter((k) => {
    const key = `${k.name}-${k.version}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Deduplicate augeas errors
  const seenErrors = new Set<string>();
  result.augeasErrors = result.augeasErrors.filter((e) => {
    if (seenErrors.has(e.file)) return false;
    seenErrors.add(e.file);
    return true;
  });

  // Deduplicate fstab entries
  const seenFstab = new Set<string>();
  result.boot.fstabEntries = result.boot.fstabEntries.filter((e) => {
    if (seenFstab.has(e.spec)) return false;
    seenFstab.add(e.spec);
    return true;
  });

  // Deduplicate modules (the same module may be parsed from both per-line and command output)
  const uniqueModules = [...new Set(initramfsModules)];

  // Build initramfs rebuild info
  if (initramfsCommand || uniqueModules.length > 0) {
    result.initramfs = {
      tool: initramfsTool || 'unknown',
      command: initramfsCommand,
      includedModules: uniqueModules,
      compressionMethod: initramfsCompression,
      durationSecs: initramfsDuration,
      initramfsPath: initramfsPath,
      binaries: initramfsBinaries,
      firmware: initramfsFirmware,
      configs: initramfsConfigs,
      hooks: initramfsHooks,
      copyDirs: initramfsCopyDirs,
      microcodeCount: initramfsMicrocodeCount,
    };
  }

  return result;
}

// ── Detect if content is a Linux conversion stage ───────────────────────────

// eslint-disable-next-line react-refresh/only-export-components
export function isLinuxConversionContent(lines: string[]): boolean {
  // Check first ~200 lines for conversion-specific markers.
  // NOTE: gcaps_* lines appear in BIOS/UEFI check stages too, so they are NOT
  // reliable conversion markers. Use only conversion-specific operations.
  const sample = lines.slice(0, Math.min(200, lines.length));
  return sample.some(
    (l) =>
      (l.includes('picked conversion module') && !l.includes('windows')) ||
      l.includes('candidate kernel packages') ||
      l.includes('installing kernel') ||
      l.includes('rebuilding initrd') ||
      l.includes('remapping networks'),
  );
}

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

function AugeasErrorsSection({ errors }: { errors: AugeasError[] }) {
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
