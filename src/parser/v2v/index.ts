/**
 * V2V parser modules - barrel file.
 *
 * Re-exports all types and parser functions from the v2v stage parsers.
 */

// inspectSource
export {
  type DiskInfo,
  type PartitionInfo,
  type FilesystemEntry,
  type InspectionStep,
  type OsInfo,
  type FsckResult,
  type FstrimResult,
  type BootDeviceInfo,
  type ParsedInspection,
  parseInspectContent,
} from './inspectSource';

// selinux
export {
  type SELinuxConfig,
  type AugeasError,
  type MountPoint,
  type SetfilesExec,
  type RelabeledFile,
  type RelabelGroup,
  type ParsedSELinux,
  RELABEL_RE,
  parseSELinuxContent,
} from './selinux';

// diskCopy
export {
  type NbdInfoDisk,
  type VddkConnection,
  type MbrPartition,
  type DiskCopyData,
  CAPABILITY_LABELS,
  parseDiskCopyContent,
  isDiskCopyStage,
} from './diskCopy';

// linuxConversion
export {
  type KernelInfo,
  type RemovedPackage,
  type PackageOperation,
  type BootConfig,
  type InitramfsRebuild,
  type GuestCaps,
  type LinuxAugeasError,
  type ParsedLinuxConversion,
  parseLinuxConversion,
  isLinuxConversionContent,
} from './linuxConversion';

// windowsConversion
export {
  type WindowsOSInfo,
  type WindowsGuestCaps,
  type ParsedWindowsConversion,
  parseWindowsConversion,
  isWindowsConversionContent,
} from './windowsConversion';
