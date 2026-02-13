/**
 * V2VFileTree — main file tree component showing filesystem operations
 * performed during a V2V migration.
 *
 * Also exports StageFileOpsTree — a lightweight per-stage variant.
 */
import { useState, useMemo, useCallback } from 'react';
import type { V2VApiCall, V2VFileCopy } from '../../types/v2v';
import type { RelabeledFile } from '../../parser/v2v';
import { FileTreeNavContext, STAGE_FILE_OPS } from './fileTreeTypes';
import type { FileTreeNav, MountGroup } from './fileTreeTypes';
import {
  groupByMount,
  groupNonGuestHandles,
  buildTree,
  countStats,
  isAugeasDataCall,
  dedupeFileCopies,
  buildDeviceLabelMap,
  getDeviceDisplayInfo,
  getHandleDisplayInfo,
} from './fileTreeHelpers';
import { DeviceTree } from './DeviceTree';

// ────────────────────────────────────────────────────────────────────────────
// Props
// ────────────────────────────────────────────────────────────────────────────

interface V2VFileTreeProps {
  apiCalls: V2VApiCall[];
  fileCopies?: V2VFileCopy[];
  driveMappings?: import('../../types/v2v').V2VDriveMapping[];
  fstab?: import('../../types/v2v').V2VFstabEntry[];
  /** Path to the VirtIO Win ISO (shown as label for virtio_win handle) */
  virtioWinIsoPath?: string | null;
  /** If true, guest device trees start expanded (but not the VirtIO ISO tree) */
  defaultExpandGuest?: boolean;
}

// ────────────────────────────────────────────────────────────────────────────
// Main component
// ────────────────────────────────────────────────────────────────────────────

export function V2VFileTree({
  apiCalls,
  fileCopies: rawFileCopies,
  driveMappings,
  fstab,
  virtioWinIsoPath,
  defaultExpandGuest = false,
}: V2VFileTreeProps) {
  const fileCopies = useMemo(() => dedupeFileCopies(rawFileCopies || []), [rawFileCopies]);

  // Cross-tree navigation state: clicking a VirtIO source link focuses the ISO tree
  const [focusedIsoPath, setFocusedIsoPath] = useState<string | null>(null);
  const [focusedIsoVersion, setFocusedIsoVersion] = useState(0);

  const navigateToIsoFile = useCallback((isoSourcePath: string) => {
    // Clean path: ///Balloon/2k19/amd64/balloon.inf → /Balloon/2k19/amd64/balloon.inf
    const cleanPath = '/' + isoSourcePath.replace(/^\/+/, '');
    setFocusedIsoPath(cleanPath);
    setFocusedIsoVersion((v) => v + 1);
  }, []);

  const navCtx = useMemo<FileTreeNav>(
    () => ({ focusedPath: focusedIsoPath, focusedVersion: focusedIsoVersion, navigateToIsoFile }),
    [focusedIsoPath, focusedIsoVersion, navigateToIsoFile],
  );

  // Guest filesystem API checks (v2v handle)
  const guestCalls = useMemo(
    () => apiCalls.filter((c) => c.handle === 'v2v' || c.handle === ''),
    [apiCalls],
  );
  const mountGroups = useMemo(() => groupByMount(guestCalls), [guestCalls]);

  // Non-guest handle API checks (e.g. virtio_win ISO)
  const handleGroups = useMemo(() => groupNonGuestHandles(apiCalls), [apiCalls]);

  // File copies destined for the guest (v2v write/upload)
  const guestFileCopies = useMemo(
    () => fileCopies.filter((fc) => fc.origin !== 'virtio_win' || fc.destination.startsWith('/')),
    [fileCopies],
  );

  const deviceLabelMap = useMemo(
    () => buildDeviceLabelMap(driveMappings, fstab),
    [driveMappings, fstab],
  );

  // Figure out which mount group to attach file copies to.
  // Most copies go to the root device. We'll attach them all to the first (root) mount group.
  // If no mount groups exist, create a synthetic one for the root device.
  const enrichedMountGroups = useMemo(() => {
    if (guestFileCopies.length === 0) return mountGroups;

    // Find the root device from the first mount group or guest info
    const rootGroup = mountGroups.find((g) => g.mountpoint === '/') || mountGroups[0];
    if (!rootGroup) {
      // No mount groups at all — create a synthetic one if we have file copies
      return [
        ...mountGroups,
        { device: 'Guest', mountpoint: '/', chrootPath: '', checks: [] as V2VApiCall[], pass: 1 },
      ];
    }
    return mountGroups;
  }, [mountGroups, guestFileCopies.length]);

  // Merge mount groups that share the same device into a single entry
  const mergedDeviceGroups = useMemo(() => {
    const deviceOrder: string[] = [];
    const deviceMap = new Map<string, MountGroup[]>();
    for (const group of enrichedMountGroups) {
      if (!deviceMap.has(group.device)) {
        deviceOrder.push(group.device);
        deviceMap.set(group.device, []);
      }
      deviceMap.get(group.device)!.push(group);
    }
    return deviceOrder.map((device) => {
      const passes = deviceMap.get(device)!;
      return {
        device,
        mountpoint: passes[0].mountpoint,
        passes,
        allChecks: passes.flatMap((p) => p.checks),
        firstMountLineNumber: passes[0].mountLineNumber,
      };
    });
  }, [enrichedMountGroups]);

  // Precompute file copies for each merged device group (also used for summary stats)
  const deviceGroupsWithCopies = useMemo(() => {
    return mergedDeviceGroups.map((merged) => {
      const copies = guestFileCopies.filter((fc) => {
        const inAnyPass = merged.passes.some((pass) => {
          if (pass.mountLineNumber === undefined) return true;
          if (fc.lineNumber < pass.mountLineNumber) return false;
          if (pass.endLineNumber !== undefined && fc.lineNumber >= pass.endLineNumber) return false;
          return true;
        });
        if (!inAnyPass) return false;
        const dest = fc.destination;
        let bestMatch = '';
        let bestDevice = '';
        for (const g of enrichedMountGroups) {
          if (g.mountLineNumber !== undefined) {
            if (fc.lineNumber < g.mountLineNumber) continue;
            if (g.endLineNumber !== undefined && fc.lineNumber >= g.endLineNumber) continue;
          }
          const mp = g.mountpoint;
          if (
            (dest === mp || dest.startsWith(mp === '/' ? '/' : mp + '/')) &&
            mp.length > bestMatch.length
          ) {
            bestMatch = mp;
            bestDevice = g.device;
          }
        }
        if (!bestMatch) return merged === mergedDeviceGroups[0];
        return bestDevice === merged.device;
      });
      return { merged, copies };
    });
  }, [mergedDeviceGroups, guestFileCopies, enrichedMountGroups]);

  // Compute summary stats from the actual trees (consistent with DeviceTree display)
  const summaryStats = useMemo(() => {
    let totalEntries = 0, found = 0, notFound = 0, copies = 0, scripts = 0, augeas = 0, relabels = 0;
    for (const { merged, copies: fileCopies } of deviceGroupsWithCopies) {
      const tree = buildTree(merged.allChecks, fileCopies);
      const stats = countStats(tree);
      totalEntries += stats.totalEntries;
      found += stats.found;
      notFound += stats.notFound;
      copies += stats.copies;
      scripts += stats.scripts;
      augeas += stats.augeas;
      relabels += stats.relabels;
    }
    for (const group of handleGroups) {
      const tree = buildTree(group.checks, []);
      const stats = countStats(tree);
      totalEntries += stats.totalEntries;
      found += stats.found;
      notFound += stats.notFound;
      copies += stats.copies;
      scripts += stats.scripts;
      augeas += stats.augeas;
      relabels += stats.relabels;
    }
    return { totalEntries, found, notFound, copies, scripts, augeas, relabels };
  }, [deviceGroupsWithCopies, handleGroups]);

  const totalDevices = new Set([
    ...enrichedMountGroups.map((g) => g.device),
    ...handleGroups.map((g) => g.device),
  ]).size;
  const totalOps = summaryStats.totalEntries;

  if (totalOps === 0) return null;

  const totalChecks = summaryStats.found + summaryStats.notFound;

  return (
    <FileTreeNavContext.Provider value={navCtx}>
      <div className="space-y-4">
        {/* Summary */}
        <div className="flex flex-wrap gap-3 text-xs text-slate-500 dark:text-gray-400">
          <span>
            {totalOps.toLocaleString()} file operations across {totalDevices} device
            {totalDevices !== 1 ? 's' : ''}
          </span>
          {totalChecks > 0 && (
            <span className="text-indigo-500 dark:text-indigo-400">
              {totalChecks.toLocaleString()} checks
            </span>
          )}
          {summaryStats.copies > 0 && (
            <span className="text-blue-500 dark:text-blue-400">
              {summaryStats.copies.toLocaleString()} copied
            </span>
          )}
          {summaryStats.scripts > 0 && (
            <span className="text-teal-500 dark:text-teal-400">
              {summaryStats.scripts.toLocaleString()} {summaryStats.scripts === 1 ? 'script' : 'scripts'}
            </span>
          )}
          {summaryStats.augeas > 0 && (
            <span className="text-violet-500 dark:text-violet-400">
              {summaryStats.augeas.toLocaleString()} config ops
            </span>
          )}
          {summaryStats.relabels > 0 && (
            <span className="text-indigo-500 dark:text-indigo-400">
              {summaryStats.relabels.toLocaleString()} relabelled
            </span>
          )}
        </div>

        {/* One tree per device — multiple passes on the same device are merged */}
        {deviceGroupsWithCopies.map(({ merged, copies }) => {
          const display = getDeviceDisplayInfo(merged.device, deviceLabelMap, merged.mountpoint);
          const passLabel = merged.passes.length > 1 ? `(${merged.passes.length} passes)` : '';

          return (
            <DeviceTree
              key={`device::${merged.device}`}
              checks={merged.allChecks}
              fileCopies={copies}
              primaryLabel={display.primary}
              secondaryLabel={display.secondary}
              passLabel={passLabel || undefined}
              icon={display.icon}
              defaultExpanded={defaultExpandGuest}
              mountLineNumber={merged.firstMountLineNumber}
            />
          );
        })}

        {/* One tree per non-guest handle (e.g. virtio_win ISO) */}
        {handleGroups.map((group) => {
          const display = getHandleDisplayInfo(group.device, virtioWinIsoPath);
          return (
            <DeviceTree
              key={`handle::${group.device}`}
              checks={group.checks}
              fileCopies={[]}
              primaryLabel={display.primary}
              secondaryLabel={display.secondary}
              icon={display.icon}
              isIsoTree
            />
          );
        })}
      </div>
    </FileTreeNavContext.Provider>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// StageFileOpsTree — lightweight per-stage file operations tree
// ────────────────────────────────────────────────────────────────────────────

/**
 * Shows file operations that occurred during a single pipeline stage.
 * Unlike the full V2VFileTree, this doesn't require mount context —
 * it shows all file-related API calls in a flat tree.
 */
export function StageFileOpsTree({
  apiCalls,
  fileCopies: rawFileCopies,
  relabeledFiles,
}: {
  apiCalls: V2VApiCall[];
  fileCopies?: V2VFileCopy[];
  relabeledFiles?: RelabeledFile[];
}) {
  // Filter to file-related calls only (broader set than FILE_CHECK_APIS)
  const fileCalls = useMemo(
    () => apiCalls.filter((c) => STAGE_FILE_OPS.has(c.name) || isAugeasDataCall(c)),
    [apiCalls],
  );

  const fileCopies = useMemo(() => dedupeFileCopies(rawFileCopies || []), [rawFileCopies]);

  if (fileCalls.length === 0 && fileCopies.length === 0 && (!relabeledFiles || relabeledFiles.length === 0)) return null;

  return (
    <DeviceTree
      checks={fileCalls}
      fileCopies={fileCopies}
      relabeledFiles={relabeledFiles}
      primaryLabel="File Operations"
      secondaryLabel=""
      icon="📂"
      defaultExpanded
    />
  );
}
