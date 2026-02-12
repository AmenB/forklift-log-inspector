/**
 * Stage detection matchers for the V2V pipeline.
 *
 * These pure functions determine which view component should render
 * a given pipeline stage based on its name (and optionally content).
 * Extracted from V2VPipelineView for readability and testability.
 */
import { isFilesystemMappingStage } from './FilesystemMappingView';
import { isDiskCopyStage } from './DiskCopyView';
import { isOutputMetadataStage } from './OutputMetadataView';
import { isLinuxConversionContent } from './LinuxConversionView';
import { isWindowsConversionContent } from './WindowsConversionView';

// Re-export for convenience so V2VPipelineView imports from a single place
export { isFilesystemMappingStage, isDiskCopyStage, isOutputMetadataStage };

/** Detect "Inspecting the source" — excluding sub-stages that have their own views. */
export function isInspectStage(name: string): boolean {
  const lower = name.toLowerCase();
  if (isBiosUefiStage(lower)) return false;
  if (isFilesystemCheckStage(lower)) return false;
  if (isFilesystemMappingStage(lower)) return false;
  return (
    (lower.includes('inspecting') && lower.includes('source')) ||
    (lower.includes('detecting') && (lower.includes('bios') || lower.includes('uefi') || lower.includes('boot'))) ||
    (lower.includes('checking') && lower.includes('filesystem') && lower.includes('integrity')) ||
    (lower.includes('mapping') && lower.includes('filesystem'))
  );
}

/** Detect "Checking filesystem integrity before/after conversion" stage. */
export function isFilesystemCheckStage(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes('checking') && lower.includes('filesystem') && lower.includes('integrity');
}

/** Detect "Opening the source" (appliance boot). */
export function isOpenSourceStage(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes('opening') && lower.includes('source');
}

/** Detect "Setting up the source". */
export function isSourceSetupStage(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes('setting up') && lower.includes('source');
}

/** Detect "Setting up the destination". */
export function isDestinationStage(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes('setting up') && lower.includes('destination');
}

/** Detect "SELinux relabelling". */
export function isSELinuxStage(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes('selinux');
}

/** Detect "Closing the overlay". */
export function isClosingOverlayStage(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes('closing') && lower.includes('overlay');
}

/** Detect "Finishing off". */
export function isFinishingOffStage(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes('finishing') && lower.includes('off');
}

/** Detect "Setting the hostname". */
export function isHostnameStage(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes('setting') && lower.includes('hostname');
}

/** Detect "Checking if the guest needs BIOS or UEFI to boot" stage. */
export function isBiosUefiStage(name: string): boolean {
  const lower = name.toLowerCase();
  return (lower.includes('bios') || lower.includes('uefi')) && lower.includes('boot');
}

/** Detect "Setting a random seed" or similar seed stages. */
export function isSeedStage(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes('seed') || lower.includes('random');
}

/**
 * All matchers for stages with dedicated views (i.e. "specific" stages).
 * Used by isSpecificNonConversionStage to avoid false positives from
 * content-based conversion detection.
 */
export const SPECIFIC_STAGE_MATCHERS: Array<(name: string) => boolean> = [
  isInspectStage,
  isOpenSourceStage,
  isSourceSetupStage,
  isDestinationStage,
  isSELinuxStage,
  isClosingOverlayStage,
  isFinishingOffStage,
  isHostnameStage,
  isBiosUefiStage,
  isFilesystemCheckStage,
  isFilesystemMappingStage,
  isDiskCopyStage,
  isOutputMetadataStage,
];

/** Stages that have their own views and should not be claimed by conversion detection. */
export function isSpecificNonConversionStage(name: string): boolean {
  const lower = name.toLowerCase();
  return SPECIFIC_STAGE_MATCHERS.some((match) => match(name))
    || isSeedStage(name)
    || (lower.includes('checking') && lower.includes('free') && lower.includes('disk'))
    || (lower.includes('checking') && lower.includes('free') && lower.includes('space'));
}

/** Detect if this stage is a Linux/RHEL conversion stage. */
export function isLinuxConversionStage(name: string, content?: string[]): boolean {
  const lower = name.toLowerCase();
  if (lower.includes('conversion') && (lower.includes('linux') || lower.includes('rhel'))) return true;
  if (lower.includes('converting') && !lower.includes('windows') && lower.includes('to run on')) return true;
  if (lower.includes('converting') && !lower.includes('windows') && lower.includes('to ')) return true;
  if (lower.includes('picked conversion module') && !lower.includes('windows')) return true;
  if (content && !isSpecificNonConversionStage(name) && isLinuxConversionContent(content) && !isWindowsConversionContent(content)) return true;
  return false;
}

/** Detect if this stage is a Windows conversion stage. */
export function isWindowsConversionStage(name: string, content?: string[]): boolean {
  const lower = name.toLowerCase();
  if (lower.includes('converting') && lower.includes('windows')) return true;
  if (lower.includes('picked conversion module') && lower.includes('windows')) return true;
  if (lower.includes('conversion') && lower.includes('windows')) return true;
  if (content && !isSpecificNonConversionStage(name) && isWindowsConversionContent(content)) return true;
  return false;
}
