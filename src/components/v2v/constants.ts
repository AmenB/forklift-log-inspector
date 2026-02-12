/**
 * Shared constants for v2v views.
 */

/** Well-known GPT partition type GUIDs → human-readable names. */
export const GPT_TYPE_GUIDS: Record<string, string> = {
  'C12A7328-F81F-11D2-BA4B-00A0C93EC93B': 'EFI System',
  '0FC63DAF-8483-4772-8E79-3D69D8477DE4': 'Linux Filesystem',
  'E6D6D379-F507-44C2-A23C-238F2A3DF928': 'Linux LVM',
  'EBD0A0A2-B9E5-4433-87C0-68B6B72699C7': 'Microsoft Basic Data',
  '21686148-6449-6E6F-744E-656564454649': 'BIOS Boot',
  'DE94BBA4-06D1-4D40-A16A-BFD50179D6AC': 'Windows Recovery',
  'E3C9E316-0B5C-4DB8-817D-F92DF00215AE': 'Microsoft Reserved',
  '5808C8AA-7E8F-42E0-85D2-E1E90434CFB3': 'Linux LUKS',
  '0657FD6D-A4AB-43C4-84E5-0933C84B4F4F': 'Linux Swap',
  'A19D880F-05FC-4D3B-A006-743F0F84911E': 'Linux RAID',
};

/**
 * Look up a GPT type GUID and return its human-readable name.
 * Falls back to the raw GUID when not recognized.
 */
export function gptTypeName(guid: string): string {
  return GPT_TYPE_GUIDS[guid.toUpperCase()] || guid;
}

/**
 * Look up a GPT type GUID and return its label, or null if not recognized.
 */
export function gptTypeLabel(guid: string | undefined): string | null {
  if (!guid) return null;
  return GPT_TYPE_GUIDS[guid.toUpperCase()] || null;
}
