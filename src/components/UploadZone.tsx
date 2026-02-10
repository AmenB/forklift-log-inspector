import { useState, useCallback, useRef, DragEvent, ChangeEvent } from 'react';
import { useStore } from '../store/useStore';
import { useToast } from './Toast';
import { parseLogFile, parsePlanYaml, isYamlContent } from '../parser';
import { processArchive } from '../parser/archiveProcessor';
import { mergeResults } from '../parser/mergeResults';
import type { ParsedData } from '../types';

/** Extensions for plain text files handled directly */
const PLAIN_EXTENSIONS = ['.log', '.txt', '.json', '.yaml', '.yml'];

/** Extensions that indicate a tar archive */
const ARCHIVE_EXTENSIONS = ['.tar', '.tgz'];

/**
 * Detect whether a filename refers to a tar archive.
 * Handles compound extensions like `.tar.gz`.
 */
function isArchiveFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.endsWith('.tar.gz')) return true;
  for (const ext of ARCHIVE_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

/**
 * Check if a filename has a valid (plain or archive) extension.
 */
function isValidFile(name: string): boolean {
  if (isArchiveFile(name)) return true;
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  return PLAIN_EXTENSIONS.includes(ext);
}

/**
 * Detect whether a plain file is YAML based on extension or content.
 */
function isYamlFile(name: string, content: string): boolean {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  return ext === '.yaml' || ext === '.yml' || isYamlContent(content);
}

export function UploadZone() {
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [clearOnUpload, setClearOnUpload] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { setParseResult, clearData } = useStore();
  const { showToast } = useToast();

  /**
   * Process multiple files: classify each, run through the appropriate
   * pipeline, then merge everything together.
   *
   * All log content (from plain files + archives) is combined, all YAML
   * content is combined, then the two are merged using mergeResults so
   * that log data is primary and YAML enriches it.
   */
  const handleFiles = useCallback(async (files: File[]) => {
    // Validate all files first
    const invalid = files.filter(f => !isValidFile(f.name));
    if (invalid.length > 0) {
      showToast(
        `Skipped ${invalid.length} invalid file${invalid.length !== 1 ? 's' : ''}. Allowed: ${[...PLAIN_EXTENSIONS, '.tar', '.tar.gz', '.tgz'].join(', ')}`,
        'error',
      );
    }

    const valid = files.filter(f => isValidFile(f.name));
    if (valid.length === 0) return;

    setIsProcessing(true);

    try {
      if (clearOnUpload) {
        clearData();
      }

      // Accumulate all log content and YAML content across all files
      const logContents: string[] = [];
      const yamlContents: string[] = [];
      const archiveParsedResults: ParsedData[] = [];
      let archiveLogCount = 0;
      let archiveYamlCount = 0;

      for (const file of valid) {
        if (isArchiveFile(file.name)) {
          // ── Archive: extract, classify, parse, merge ──────────────
          const result = await processArchive(file);
          archiveLogCount += result.logFiles.length;
          archiveYamlCount += result.yamlFiles.length;

          if (result.logFiles.length > 0 || result.yamlFiles.length > 0) {
            archiveParsedResults.push(result.parsedData);
          }
        } else {
          // ── Plain file ────────────────────────────────────────────
          const content = await file.text();
          if (isYamlFile(file.name, content)) {
            yamlContents.push(content);
          } else {
            logContents.push(content);
          }
        }
      }

      // Parse all plain log files together
      let logResult: ParsedData | null = null;
      if (logContents.length > 0) {
        logResult = parseLogFile(logContents.join('\n'));
      }

      // Parse all plain YAML files together
      let yamlResult: ParsedData | null = null;
      if (yamlContents.length > 0) {
        yamlResult = parsePlanYaml(yamlContents.join('\n---\n'));
      }

      // Merge plain logs + plain YAML (logs primary, YAML enriches)
      let combined = mergeResults(logResult, yamlResult);

      // Merge in archive results
      for (const archiveResult of archiveParsedResults) {
        combined = mergeResults(combined, archiveResult);
      }

      if (combined.plans.length === 0 && combined.events.length === 0) {
        showToast('No forklift data found in the uploaded files', 'error');
        return;
      }

      setParseResult(combined);

      // Build toast message
      const plainLogCount = logContents.length;
      const plainYamlCount = yamlContents.length;
      const totalLogs = plainLogCount + archiveLogCount;
      const totalYamls = plainYamlCount + archiveYamlCount;
      const parts: string[] = [];

      if (totalLogs > 0) {
        parts.push(`${totalLogs} log file${totalLogs !== 1 ? 's' : ''}`);
      }
      if (totalYamls > 0) {
        parts.push(`${totalYamls} Plan YAML${totalYamls !== 1 ? 's' : ''}`);
      }

      const fileDesc = parts.length > 0
        ? parts.join(' + ')
        : `${valid.length} file${valid.length !== 1 ? 's' : ''}`;

      showToast(
        `Processed ${fileDesc}: ${combined.stats.plansFound} plan${combined.stats.plansFound !== 1 ? 's' : ''}, ${combined.stats.vmsFound} VM${combined.stats.vmsFound !== 1 ? 's' : ''}`,
        'success',
      );
    } catch (error) {
      console.error('Error parsing files:', error);
      showToast('Failed to parse files', 'error');
    } finally {
      setIsProcessing(false);
    }
  }, [clearOnUpload, clearData, setParseResult, showToast]);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const fileList = e.dataTransfer.files;
    if (fileList.length > 0) {
      handleFiles(Array.from(fileList));
    }
  }, [handleFiles]);

  const handleFileInputChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (fileList && fileList.length > 0) {
      handleFiles(Array.from(fileList));
    }
    // Reset input so same files can be selected again
    e.target.value = '';
  }, [handleFiles]);

  const handleClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  return (
    <div className="max-w-7xl mx-auto px-6 py-4">
      <div
        onClick={handleClick}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`
          relative border-2 border-dashed rounded-xl p-8 text-center cursor-pointer
          transition-all duration-200
          ${isDragging
            ? 'border-pink-500 bg-pink-500/10'
            : 'border-slate-300 dark:border-slate-600 hover:border-pink-500/50 hover:bg-slate-50 dark:hover:bg-slate-800'
          }
          ${isProcessing ? 'pointer-events-none opacity-50' : ''}
        `}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".log,.txt,.json,.yaml,.yml,.tar,.tar.gz,.tgz"
          onChange={handleFileInputChange}
          className="hidden"
        />

        {isProcessing ? (
          <div className="flex flex-col items-center gap-3">
            <div className="w-8 h-8 border-2 border-pink-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-slate-500 dark:text-gray-400">Processing files...</p>
          </div>
        ) : (
          <>
            <svg
              className="w-12 h-12 mx-auto mb-4 text-slate-400 dark:text-gray-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
              />
            </svg>
            <p className="text-slate-900 dark:text-gray-100 font-medium mb-1">
              Drop your files here, or click to browse
            </p>
            <p className="text-slate-500 dark:text-gray-400 text-sm">
              Upload logs, Plan YAMLs, and archives together to combine them
            </p>
            <p className="text-slate-500 dark:text-gray-400 text-xs mt-1">
              .log, .txt, .json, .yaml, .yml, .tar, .tar.gz, .tgz
            </p>
          </>
        )}
      </div>

      <div className="mt-3 flex items-center justify-center">
        <label className="flex items-center gap-2 text-sm text-slate-500 dark:text-gray-400 cursor-pointer">
          <input
            type="checkbox"
            checked={clearOnUpload}
            onChange={(e) => setClearOnUpload(e.target.checked)}
            className="w-4 h-4 rounded border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700
                       checked:bg-pink-500 checked:border-pink-500
                       focus:ring-2 focus:ring-pink-500 focus:ring-offset-0"
          />
          Clear existing data on upload
        </label>
      </div>
    </div>
  );
}
