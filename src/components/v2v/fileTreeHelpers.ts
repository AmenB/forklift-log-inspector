/**
 * Pure helper functions for the V2V file tree.
 *
 * Handles tree building, mount-context grouping, Augeas path parsing,
 * file-check classification, device label mapping, and statistics counting.
 */
import type { V2VApiCall, V2VDriveMapping, V2VFstabEntry, V2VFileCopy } from '../../types/v2v';
import type { RelabeledFile } from '../../parser/v2v';
import {
  FILE_CHECK_APIS,
  MOUNT_APIS,
  AUGEAS_APIS,
  KNOWN_CONFIG_LEAVES,
  CONFIG_EXTENSIONS,
} from './fileTreeTypes';
import type { FileCheck, FileOp, TreeNode, MountGroup, TreeStats } from './fileTreeTypes';

// ────────────────────────────────────────────────────────────────────────────
// Augeas helpers
// ────────────────────────────────────────────────────────────────────────────

/** Is this an Augeas data call (not error metadata)? */
export function isAugeasDataCall(call: V2VApiCall): boolean {
  if (!AUGEAS_APIS.has(call.name)) return false;
  const arg = call.args;
  // Skip error/metadata paths like /augeas/files/.../error/
  if (arg.includes('/augeas/')) return false;
  // Only include paths operating on real files (/files/ or /file/)
  if (arg.includes('/files/') || arg.includes('/file/')) return true;
  return false;
}

/**
 * Parse an Augeas path like "/files/etc/fstab/1/spec" into
 * { filePath: "/etc/fstab", key: "1/spec" }.
 */
export function parseAugeasPath(augPath: string): { filePath: string; key: string } | null {
  // Strip leading "/files" or "/file" prefix
  let path = augPath;
  if (path.startsWith('/files/') || path.startsWith('/files"') || path === '/files') {
    path = path.slice(6); // "/files".length === 6
  } else if (path.startsWith('/file/') || path.startsWith('/file"') || path === '/file') {
    path = path.slice(5); // "/file".length === 5
  }
  if (!path.startsWith('/')) return null;

  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0) return null;

  // Walk segments to find the file boundary
  let fileEnd = segments.length; // default: entire path is the file
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    // Numeric segments or array notation indicate we've passed the file boundary
    if (/^\d+$/.test(seg) || seg.includes('[')) {
      fileEnd = i;
      break;
    }
    // Segments with file extensions are the file
    if (CONFIG_EXTENSIONS.test(seg)) {
      fileEnd = i + 1;
      break;
    }
    // Known leaf names are the file
    if (KNOWN_CONFIG_LEAVES.has(seg)) {
      fileEnd = i + 1;
      break;
    }
    // UPPERCASE segments (like GRUB_CMDLINE_LINUX, SELINUX) are keys, not files
    if (seg === seg.toUpperCase() && seg.length > 1 && /^[A-Z_]+$/.test(seg)) {
      fileEnd = i;
      break;
    }
  }

  const filePath = '/' + segments.slice(0, fileEnd).join('/');
  const key = segments.slice(fileEnd).join('/');
  return { filePath, key };
}

// ────────────────────────────────────────────────────────────────────────────
// File check helpers
// ────────────────────────────────────────────────────────────────────────────

export function isCheckFound(check: FileCheck): boolean {
  // Non-check APIs (download, upload, mkdir, etc.) always count as "found" — they operated on the file
  if (!FILE_CHECK_APIS.has(check.api)) return true;
  if (check.api === 'stat' || check.api === 'lstat') {
    return check.result !== '' && check.result !== '0' && !check.result.startsWith('error');
  }
  return check.result === '1' || check.result === 'true';
}

export function extractChrootPath(mountCall: V2VApiCall): string {
  for (const cmd of mountCall.guestCommands) {
    if (cmd.command === 'mount' && cmd.args.length > 0) {
      const raw = cmd.args[cmd.args.length - 1];
      return raw.replace(/\/+$/, '') || '/';
    }
  }
  return '';
}

// ────────────────────────────────────────────────────────────────────────────
// Mount-context grouping (for API-call checks)
// ────────────────────────────────────────────────────────────────────────────

export function groupByMount(apiCalls: V2VApiCall[]): MountGroup[] {
  const groups: MountGroup[] = [];
  let currentDevice = '';
  let currentMountpoint = '';
  let currentChrootPath = '';
  let currentChecks: V2VApiCall[] = [];
  let currentMountLine: number | undefined;

  function flush(endLine?: number) {
    if (currentDevice) {
      const key = `${currentDevice}::${currentMountpoint}`;
      const passCount = (passCounts.get(key) ?? 0) + 1;
      passCounts.set(key, passCount);
      groups.push({
        device: currentDevice,
        mountpoint: currentMountpoint,
        chrootPath: currentChrootPath,
        checks: [...currentChecks],
        mountLineNumber: currentMountLine,
        endLineNumber: endLine,
        pass: passCount,
      });
      currentChecks = [];
    }
  }
  const passCounts = new Map<string, number>();

  for (const call of apiCalls) {
    if (MOUNT_APIS.has(call.name)) {
      let device = '';
      let mountpoint = '';
      const quoted = [...call.args.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
      if (call.name === 'mount_options' && quoted.length >= 3) {
        device = quoted[1];
        mountpoint = quoted[2];
      } else if (quoted.length >= 2) {
        device = quoted[0];
        mountpoint = quoted[1];
      }
      if (device) {
        if (device !== currentDevice || mountpoint !== currentMountpoint) flush(call.lineNumber);
        currentDevice = device;
        currentMountpoint = mountpoint;
        currentChrootPath = extractChrootPath(call);
        currentMountLine = call.lineNumber;
      }
    } else if (call.name === 'umount_all' || call.name === 'umount') {
      flush(call.lineNumber);
      currentDevice = '';
      currentMountpoint = '';
      currentChrootPath = '';
      currentMountLine = undefined;
    } else if (FILE_CHECK_APIS.has(call.name) || isAugeasDataCall(call)) {
      currentChecks.push(call);
    }
  }
  flush();

  // If there are orphaned checks that accumulated without a mount context
  // (e.g. augeas calls in a conversion stage where mount happened in a previous stage),
  // create a synthetic group so they're not lost.
  if (currentChecks.length > 0) {
    groups.push({
      device: 'Guest',
      mountpoint: '/',
      chrootPath: '',
      checks: [...currentChecks],
      pass: 1,
    });
  }

  return groups;
}

export function groupNonGuestHandles(apiCalls: V2VApiCall[]): MountGroup[] {
  const byHandle = new Map<string, V2VApiCall[]>();
  for (const call of apiCalls) {
    if (call.handle && call.handle !== 'v2v' && FILE_CHECK_APIS.has(call.name)) {
      const arr = byHandle.get(call.handle) || [];
      arr.push(call);
      byHandle.set(call.handle, arr);
    }
  }
  const groups: MountGroup[] = [];
  for (const [handle, checks] of byHandle) {
    if (checks.length > 0) {
      groups.push({ device: handle, mountpoint: '/', chrootPath: '', checks, pass: 1 });
    }
  }
  return groups;
}

// ────────────────────────────────────────────────────────────────────────────
// Tree building — merges both checks and file copies
// ────────────────────────────────────────────────────────────────────────────

export function insertPath(root: TreeNode, rawPath: string): TreeNode {
  const segments = rawPath.replace(/^\/+/, '').split('/').filter(Boolean);
  let node = root;
  let currentPath = '/';
  for (const seg of segments) {
    currentPath = currentPath === '/' ? `/${seg}` : `${currentPath}/${seg}`;
    if (!node.children.has(seg)) {
      node.children.set(seg, { name: seg, path: currentPath, children: new Map(), checks: [], ops: [] });
    }
    node = node.children.get(seg)!;
  }
  return node;
}

export function buildTree(checks: V2VApiCall[], fileCopies: V2VFileCopy[], relabeledFiles?: RelabeledFile[]): TreeNode {
  const root: TreeNode = { name: '/', path: '/', children: new Map(), checks: [], ops: [] };

  for (const call of checks) {
    // Handle Augeas calls separately — parse the /files/ path
    if (AUGEAS_APIS.has(call.name)) {
      const pathMatch = call.args.match(/^"([^"]+)"/);
      if (!pathMatch) continue;
      const parsed = parseAugeasPath(pathMatch[1]);
      if (!parsed) continue;

      const augOpType = call.name.replace('aug_', '') as FileOp['augOp'];

      // For aug_set, the value is the second quoted arg; aug_clear has no value
      let augValue = call.result;
      if (augOpType === 'set') {
        const allQuoted = [...call.args.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
        augValue = allQuoted.length >= 2 ? allQuoted[1] : '';
      } else if (augOpType === 'clear') {
        augValue = '';
      }

      const node = insertPath(root, parsed.filePath);
      node.ops.push({
        type: 'augeas',
        augOp: augOpType,
        augKey: parsed.key,
        augValue,
        lineNumber: call.lineNumber,
        // Copy fields default values (not used for augeas)
        origin: 'guest',
        source: '',
        sizeBytes: null,
        content: null,
        contentTruncated: false,
      });
      continue;
    }

    // Regular file check
    const pathMatch = call.args.match(/^"([^"]+)"/);
    if (!pathMatch) continue;
    const node = insertPath(root, pathMatch[1]);
    node.checks.push({ api: call.name, result: call.result, lineNumber: call.lineNumber });
  }

  for (const fc of fileCopies) {
    const node = insertPath(root, fc.destination);
    node.ops.push({
      type: 'copy',
      origin: fc.origin,
      source: fc.source,
      sizeBytes: fc.sizeBytes,
      content: fc.content,
      contentTruncated: fc.contentTruncated,
      lineNumber: fc.lineNumber,
    });
  }

  if (relabeledFiles) {
    for (const rf of relabeledFiles) {
      const node = insertPath(root, rf.path);
      node.ops.push({
        type: 'relabel',
        fromContext: rf.fromContext,
        toContext: rf.toContext,
        // Default values for fields not used by relabel
        origin: 'guest',
        source: '',
        sizeBytes: null,
        content: null,
        contentTruncated: false,
        lineNumber: 0,
      });
    }
  }

  return root;
}

// ────────────────────────────────────────────────────────────────────────────
// Tree classification helpers
// ────────────────────────────────────────────────────────────────────────────

export function isTrueCopy(op: FileOp): boolean {
  return op.type === 'copy' && (op.origin === 'virtio_win' || op.origin === 'virt-tools');
}

export function isScriptOp(op: FileOp): boolean {
  return op.type === 'copy' && (op.origin === 'script' || op.origin === 'guest');
}

export function countStats(node: TreeNode): TreeStats {
  let totalEntries = 0;
  let found = 0;
  let notFound = 0;
  let copies = 0;
  let scripts = 0;
  let augeas = 0;
  let relabels = 0;

  const isLeaf = node.children.size === 0;
  if (isLeaf && (node.checks.length > 0 || node.ops.length > 0)) {
    totalEntries = 1;
    const augOps = node.ops.filter((op) => op.type === 'augeas');
    const relabelOps = node.ops.filter((op) => op.type === 'relabel');
    if (node.ops.some(isTrueCopy)) copies = 1;
    if (node.ops.some(isScriptOp)) scripts = 1;
    if (augOps.length > 0) augeas = augOps.length;
    if (relabelOps.length > 0) relabels = relabelOps.length;
    if (node.checks.length > 0) {
      const anyFound = node.checks.some(isCheckFound);
      if (anyFound) found = 1;
      else notFound = 1;
    }
  }

  for (const child of node.children.values()) {
    const sub = countStats(child);
    totalEntries += sub.totalEntries;
    found += sub.found;
    notFound += sub.notFound;
    copies += sub.copies;
    scripts += sub.scripts;
    augeas += sub.augeas;
    relabels += sub.relabels;
  }

  return { totalEntries, found, notFound, copies, scripts, augeas, relabels };
}

export function isDirectory(node: TreeNode): boolean {
  return node.children.size > 0;
}

// ────────────────────────────────────────────────────────────────────────────
// Label helpers
// ────────────────────────────────────────────────────────────────────────────

export function buildDeviceLabelMap(
  driveMappings?: V2VDriveMapping[],
  fstab?: V2VFstabEntry[],
): Map<string, string> {
  const map = new Map<string, string>();
  if (driveMappings) {
    for (const m of driveMappings) map.set(m.device, `${m.letter}:`);
  }
  if (fstab) {
    for (const entry of fstab) {
      if (!map.has(entry.device) && entry.mountpoint !== 'none') map.set(entry.device, entry.mountpoint);
    }
  }
  return map;
}

export function getDeviceDisplayInfo(
  device: string,
  labelMap: Map<string, string>,
  mountpoint?: string,
): { primary: string; secondary: string; icon: string } {
  const label = labelMap.get(device);
  if (label) return { primary: label, secondary: device, icon: '💾' };
  // Detect EFI System Partition (ESP): mountpoint often contains "ESP" temp path
  if (mountpoint && /\bESP[_/]/i.test(mountpoint)) {
    return { primary: 'EFI System Partition', secondary: device, icon: '⚡' };
  }
  return { primary: device, secondary: '', icon: '💾' };
}

export function getHandleDisplayInfo(
  handle: string,
  virtioWinIsoPath?: string | null,
): { primary: string; secondary: string; icon: string } {
  if (handle === 'virtio_win') {
    return { primary: 'VirtIO Win ISO', secondary: virtioWinIsoPath || '', icon: '💿' };
  }
  return { primary: handle, secondary: '', icon: '💾' };
}

// ────────────────────────────────────────────────────────────────────────────
// Deduplicate file copies
// ────────────────────────────────────────────────────────────────────────────

export function dedupeFileCopies(fileCopies: V2VFileCopy[]): V2VFileCopy[] {
  const seen = new Set<string>();
  const result: V2VFileCopy[] = [];
  for (const fc of fileCopies) {
    const key = `${fc.source}→${fc.destination}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(fc);
    }
  }
  return result;
}
