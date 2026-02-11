/**
 * Generic structured view for stages that write files to the guest.
 *
 * Parses libguestfs trace `write`, `write_append`, `truncate` calls
 * from the raw stage content and shows what was written where.
 */
import { useMemo } from 'react';
import { SectionHeader } from './shared';

interface FileWrite {
  path: string;
  /** Decoded text content (null for binary) */
  content: string | null;
  operation: 'write' | 'write_append' | 'truncate';
  sizeBytes: number | null;
}

/** Decode \xHH and \x0a style escapes to readable text. Returns null if mostly binary. */
function decodeEscaped(raw: string): string | null {
  // Quick check: if it has too many \x sequences with non-printable chars, treat as binary
  const hexCount = (raw.match(/\\x[0-9a-f]{2}/gi) || []).length;
  const totalLen = raw.length;
  if (totalLen > 0 && hexCount / (totalLen / 4) > 0.5) return null;

  try {
    return raw
      .replace(/\\x0a/g, '\n')
      .replace(/\\x0d/g, '\r')
      .replace(/\\x09/g, '\t')
      .replace(/\\x([0-9a-f]{2})/gi, (_, hex) => {
        const code = parseInt(hex, 16);
        if (code >= 0x20 && code < 0x7f) return String.fromCharCode(code);
        return ''; // strip non-printable
      })
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  } catch {
    return null;
  }
}

function parseFileWrites(lines: string[]): FileWrite[] {
  const writes: FileWrite[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    // write "/path" "content"  or  write_append "/path" "content"
    const writeMatch = line.match(
      /(?:^|\s)(write|write_append|internal_write|internal_write_append)\s+"([^"]+)"\s+"([^"]*)"(.*)$/,
    );
    if (writeMatch) {
      const op = writeMatch[1].includes('append') ? 'write_append' as const : 'write' as const;
      const path = writeMatch[2];
      const rawContent = writeMatch[3];
      const rest = writeMatch[4];

      // Deduplicate: write and internal_write are the same operation
      const key = `${op}:${path}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Extract size from truncated marker
      let sizeBytes: number | null = null;
      const sizeMatch = rest.match(/original size (\d+) bytes/);
      if (sizeMatch) sizeBytes = parseInt(sizeMatch[1], 10);

      const decoded = decodeEscaped(rawContent);
      writes.push({ path, content: decoded, operation: op, sizeBytes });
      continue;
    }

    // truncate "/path"
    const truncMatch = line.match(/(?:^|\s)truncate\s+"([^"]+)"/);
    if (truncMatch) {
      const path = truncMatch[1];
      const key = `truncate:${path}`;
      if (!seen.has(key)) {
        seen.add(key);
        writes.push({ path, content: null, operation: 'truncate', sizeBytes: null });
      }
    }
  }

  return writes;
}

// ── Component ───────────────────────────────────────────────────────────────

interface FileWritesViewProps {
  content: string[];
}

export function FileWritesView({ content }: FileWritesViewProps) {
  const writes = useMemo(() => parseFileWrites(content), [content]);

  if (writes.length === 0) return null;

  return (
    <div>
      <SectionHeader title="File Operations" count={writes.length} />
      <div className="space-y-2">
        {writes.map((w, idx) => (
          <div
            key={idx}
            className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden"
          >
            {/* Header: path + operation badge */}
            <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-50 dark:bg-slate-800/50">
              <span className={`px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase ${
                w.operation === 'truncate'
                  ? 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300'
                  : w.operation === 'write_append'
                    ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300'
                    : 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300'
              }`}>
                {w.operation === 'write_append' ? 'append' : w.operation}
              </span>
              <span className="font-mono text-[11px] text-slate-700 dark:text-gray-200 truncate">
                {w.path}
              </span>
              {w.sizeBytes != null && (
                <span className="text-[10px] text-slate-400 dark:text-gray-500 ml-auto flex-shrink-0">
                  {w.sizeBytes} bytes
                </span>
              )}
            </div>

            {/* Content preview */}
            {w.content != null && w.content.trim().length > 0 && (
              <pre className="px-3 py-1.5 text-[10px] font-mono text-slate-600 dark:text-gray-300 bg-white dark:bg-slate-900 max-h-[120px] overflow-y-auto overflow-x-auto whitespace-pre-wrap break-words">
                {w.content.trim()}
              </pre>
            )}
            {w.content === null && w.operation !== 'truncate' && (
              <div className="px-3 py-1.5 text-[10px] text-slate-400 dark:text-gray-500 italic bg-white dark:bg-slate-900">
                binary data{w.sizeBytes != null ? ` (${w.sizeBytes} bytes)` : ''}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Check if the content has any file write operations worth showing. */
export function hasFileWrites(lines: string[]): boolean {
  return lines.some((l) =>
    /(?:write|write_append|internal_write)\s+"\//.test(l),
  );
}
