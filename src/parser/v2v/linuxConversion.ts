/**
 * Parser for the Linux conversion pipeline stage.
 *
 * Parses kernel analysis, package removal, driver configuration,
 * initramfs rebuild, GRUB config, guest capabilities, and augeas errors.
 */

// ── Types ───────────────────────────────────────────────────────────────────

export interface KernelInfo {
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

export interface RemovedPackage {
  name: string;
  arch: string;
  version: string;
  repo: string;
  size: string;
}

export interface PackageOperation {
  /** 'dnf' | 'apt' | 'yum' | 'zypper' | string */
  manager: string;
  command: string;
  packages: RemovedPackage[];
  freedSpace: string;
  durationSecs: number | null;
}

export interface BootConfig {
  bootloader: string; // e.g. "grub2"
  bootloaderPath: string; // e.g. "/boot/grub2/grub.cfg"
  efiFiles: string[];
  grubCmdline: string;
  fstabEntries: { spec: string; mount?: string }[];
  blockDeviceMap: { from: string; to: string }[];
}

export interface InitramfsRebuild {
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

export interface GuestCaps {
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

export interface LinuxAugeasError {
  file: string;
  message: string;
  line: string;
  char: string;
  lens: string;
}

export interface ParsedLinuxConversion {
  conversionModule: string;
  osDetected: string; // from libosinfo
  kernels: KernelInfo[];
  candidatePackages: string[];
  packageOps: PackageOperation[];
  boot: BootConfig;
  initramfs: InitramfsRebuild | null;
  guestCaps: GuestCaps | null;
  augeasErrors: LinuxAugeasError[];
  cleanupChecks: string[]; // VBox, Parallels, VMware checks
  modprobeAliases: { alias: string; module: string }[];
  defaultKernel: string; // DEFAULTKERNEL value
}

// ── Parser ──────────────────────────────────────────────────────────────────

export function parseLinuxConversion(lines: string[]): ParsedLinuxConversion {
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
