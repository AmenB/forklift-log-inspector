import { describe, it, expect } from 'vitest';
import {
  extractOriginalSize,
  extractReadFileContent,
  extractWriteContent,
  decodeWriteEscapes,
} from '../v2v/fileCopyParser';

// ────────────────────────────────────────────────────────────────────────────
// extractOriginalSize
// ────────────────────────────────────────────────────────────────────────────

describe('extractOriginalSize', () => {
  it('extracts size from "original size N bytes"', () => {
    expect(extractOriginalSize('original size 1024 bytes')).toBe(1024);
    expect(extractOriginalSize('original size 0 bytes')).toBe(0);
  });

  it('extracts size from line with surrounding text', () => {
    const line =
      'libguestfs: trace: v2v: read_file = "content"<truncated, original size 4096 bytes>';
    expect(extractOriginalSize(line)).toBe(4096);
  });

  it('returns null when pattern not found', () => {
    expect(extractOriginalSize('some other line')).toBeNull();
    expect(extractOriginalSize('')).toBeNull();
  });

  it('handles large numbers', () => {
    expect(extractOriginalSize('original size 10737418240 bytes')).toBe(
      10737418240,
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// extractReadFileContent
// ────────────────────────────────────────────────────────────────────────────

describe('extractReadFileContent', () => {
  it('extracts content from read_file result', () => {
    const line = 'libguestfs: trace: v2v: read_file = "hello world"';
    expect(extractReadFileContent(line)).toBe('hello world');
  });

  it('extracts content with truncation marker', () => {
    const line =
      'libguestfs: trace: v2v: read_file = "short"<truncated, original size 100 bytes>';
    expect(extractReadFileContent(line)).toBe('short');
  });

  it('decodes escape sequences in content', () => {
    const line = 'libguestfs: trace: v2v: read_file = "line1\\nline2"';
    expect(extractReadFileContent(line)).toBe('line1\nline2');
  });

  it('returns null when read_file marker not found', () => {
    expect(extractReadFileContent('some other line')).toBeNull();
    expect(extractReadFileContent('')).toBeNull();
  });

  it('returns null for binary content (hex escape pattern)', () => {
    const line =
      'libguestfs: trace: v2v: read_file = "\\x00\\x01\\x02\\x03binary"';
    expect(extractReadFileContent(line)).toBeNull();
  });

  it('allows hex escapes that look like CRLF (\\x0d\\x0a)', () => {
    const line =
      'libguestfs: trace: v2v: read_file = "\\x0d\\x0aWindows line ending"';
    expect(extractReadFileContent(line)).not.toBeNull();
  });

  it('returns null for empty quoted content (contentEnd <= contentStart)', () => {
    const line = 'libguestfs: trace: v2v: read_file = ""';
    expect(extractReadFileContent(line)).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// extractWriteContent
// ────────────────────────────────────────────────────────────────────────────

describe('extractWriteContent', () => {
  it('extracts content from write line for .bat file', () => {
    const line =
      'libguestfs: trace: v2v: write "/path/script.bat" "echo hello"';
    expect(extractWriteContent(line, '/path/script.bat')).toBe('echo hello');
  });

  it('extracts content for .ps1 file', () => {
    const line =
      'libguestfs: trace: v2v: write "/tmp/run.ps1" "Write-Host test"';
    expect(extractWriteContent(line, '/tmp/run.ps1')).toBe('Write-Host test');
  });

  it('extracts content for .reg file', () => {
    const line =
      'libguestfs: trace: v2v: write "/path/file.reg" "Windows Registry"';
    expect(extractWriteContent(line, '/path/file.reg')).toBe(
      'Windows Registry',
    );
  });

  it('returns null for .exe (binary extension)', () => {
    const line =
      'libguestfs: trace: v2v: write "/path/file.exe" "MZ binary content"';
    expect(extractWriteContent(line, '/path/file.exe')).toBeNull();
  });

  it('returns null for .dll', () => {
    const line = 'libguestfs: trace: v2v: write "/path/kernel32.dll" "..."';
    expect(extractWriteContent(line, '/path/kernel32.dll')).toBeNull();
  });

  it('returns null for .msi, .sys, .cat, .pdb, .cab, .iso', () => {
    const line = 'libguestfs: trace: v2v: write "/x.y" "content"';
    expect(extractWriteContent(line, '/x.msi')).toBeNull();
    expect(extractWriteContent(line, '/x.sys')).toBeNull();
    expect(extractWriteContent(line, '/x.cat')).toBeNull();
    expect(extractWriteContent(line, '/x.pdb')).toBeNull();
    expect(extractWriteContent(line, '/x.cab')).toBeNull();
    expect(extractWriteContent(line, '/x.iso')).toBeNull();
  });

  it('handles truncated write content', () => {
    const line =
      'libguestfs: trace: v2v: write "/path/file.bat" "short"<truncated, original size 500 bytes>';
    expect(extractWriteContent(line, '/path/file.bat')).toBe('short');
  });

  it('decodes escape sequences', () => {
    const line =
      'libguestfs: trace: v2v: write "/x.bat" "line1\\nline2\\t tab"';
    expect(extractWriteContent(line, '/x.bat')).toBe('line1\nline2\t tab');
  });

  it('returns null when " " pattern not found', () => {
    expect(extractWriteContent('malformed line', '/x.bat')).toBeNull();
  });

  it('extracts content for .xml and .txt', () => {
    const line =
      'libguestfs: trace: v2v: write "/config.xml" "<root/>"';
    expect(extractWriteContent(line, '/config.xml')).toBe('<root/>');

    const line2 = 'libguestfs: trace: v2v: write "/readme.txt" "text"';
    expect(extractWriteContent(line2, '/readme.txt')).toBe('text');
  });

  it('is case-insensitive for binary extensions', () => {
    const line = 'libguestfs: trace: v2v: write "/x.EXE" "content"';
    expect(extractWriteContent(line, '/x.EXE')).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// decodeWriteEscapes
// ────────────────────────────────────────────────────────────────────────────

describe('decodeWriteEscapes', () => {
  it('decodes \\n to newline', () => {
    expect(decodeWriteEscapes('a\\nb')).toBe('a\nb');
  });

  it('decodes \\r to carriage return', () => {
    expect(decodeWriteEscapes('a\\rb')).toBe('a\rb');
  });

  it('decodes \\t to tab', () => {
    expect(decodeWriteEscapes('a\\tb')).toBe('a\tb');
  });

  it('decodes \\\\ to backslash', () => {
    expect(decodeWriteEscapes('a\\\\b')).toBe('a\\b');
  });

  it('decodes \\" to double quote', () => {
    expect(decodeWriteEscapes('a\\"b')).toBe('a"b');
  });

  it('decodes \\x0d\\x0a to CRLF', () => {
    expect(decodeWriteEscapes('\\x0d\\x0a')).toBe('\r\n');
  });

  it('decodes \\x41 to A', () => {
    expect(decodeWriteEscapes('\\x41')).toBe('A');
  });

  it('passes through plain text', () => {
    expect(decodeWriteEscapes('plain text')).toBe('plain text');
  });

  it('handles empty string', () => {
    expect(decodeWriteEscapes('')).toBe('');
  });

  it('handles mixed escapes', () => {
    expect(decodeWriteEscapes('line1\\nline2\\t\\"quoted\\"')).toBe(
      'line1\nline2\t"quoted"',
    );
  });

  it('decodes \\x00 (null byte)', () => {
    expect(decodeWriteEscapes('\\x00')).toBe('\u0000');
  });
});
