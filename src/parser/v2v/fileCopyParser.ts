/**
 * File copy parsing for virt-v2v logs.
 * Extracts read_file/write content and original size from libguestfs trace output.
 */

import { parseHexEscapeAt } from './hivexParser';

/** Extract "original size N bytes" from a log line */
export const ORIGINAL_SIZE_RE = /original size (\d+) bytes/;

/** Extract "original size N bytes" from a log line, or null. */
export function extractOriginalSize(line: string): number | null {
  const m = line.match(ORIGINAL_SIZE_RE);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Decode libguestfs trace string escapes: \x0d\x0a → \r\n, \xHH → char, etc.
 */
export function decodeWriteEscapes(s: string): string {
  let result = '';
  let i = 0;
  while (i < s.length) {
    const esc = parseHexEscapeAt(s, i);
    if (esc) {
      result += String.fromCharCode(esc.byte);
      i += esc.consumed;
      continue;
    }
    if (s[i] === '\\' && i + 1 < s.length) {
      const next = s[i + 1];
      if (next === 'n') { result += '\n'; i += 2; continue; }
      if (next === 'r') { result += '\r'; i += 2; continue; }
      if (next === 't') { result += '\t'; i += 2; continue; }
      if (next === '\\') { result += '\\'; i += 2; continue; }
      if (next === '"') { result += '"'; i += 2; continue; }
    }
    result += s[i];
    i++;
  }
  return result;
}

/**
 * Extract content from a `v2v: read_file = "content"` result line.
 * Returns decoded text, or null if it looks like binary.
 * Pattern: read_file = "content here"  or  "content"<truncated, original size N bytes>
 */
export function extractReadFileContent(line: string): string | null {
  // Find the content after `read_file = "`
  const marker = 'read_file = "';
  const startIdx = line.indexOf(marker);
  if (startIdx < 0) return null;
  const contentStart = startIdx + marker.length;

  // Find closing quote
  let contentEnd = line.indexOf('"<truncated', contentStart);
  if (contentEnd < 0) {
    contentEnd = line.lastIndexOf('"');
    if (contentEnd <= contentStart) return null;
  }

  const rawContent = line.substring(contentStart, contentEnd);

  // Skip binary content — if it starts with non-printable escape sequences, it's binary
  if (/^\\x[0-9a-f]{2}\\x[0-9a-f]{2}/i.test(rawContent) && !/^\\x[0-9a-f]{2}\\x0[0ad]/i.test(rawContent)) {
    return null;
  }

  return decodeWriteEscapes(rawContent);
}

/**
 * Extract the inline text content from a `v2v: write` log line.
 * Returns decoded text for script-like files (.bat, .ps1, .reg, .cmd, .txt, .xml),
 * or null for binary files (.exe, .msi, .sys, .dll, .cat, .pdb, etc.).
 *
 * Line format:
 *   libguestfs: trace: v2v: write "/path/file.bat" "escaped content"
 *   libguestfs: trace: v2v: write "/path/file.bat" "escaped..."<truncated, original size N bytes>
 */
export function extractWriteContent(line: string, destPath: string): string | null {
  // Skip content extraction for known binary file extensions
  const binaryExtensions = /\.(exe|msi|dll|sys|cat|pdb|cab|iso|img|bin|dat|drv)$/i;
  if (binaryExtensions.test(destPath)) return null;

  // Find the content between the second pair of quotes
  // The first quoted string is the destination path, the second is the content
  // Pattern: write "/dest" "content"  or  write "/dest" "content"<truncated...>
  const idx = line.indexOf('" "');
  if (idx < 0) return null;

  // Content starts after '" "' (3 chars), so idx + 3
  const contentStart = idx + 3;
  // Find the closing quote — could be at end of line or before <truncated
  let contentEnd = line.indexOf('"<truncated', contentStart);
  if (contentEnd < 0) {
    // No truncation — last quote on the line
    contentEnd = line.lastIndexOf('"');
    if (contentEnd <= contentStart) return null;
  }

  const rawContent = line.substring(contentStart, contentEnd);
  return decodeWriteEscapes(rawContent);
}
