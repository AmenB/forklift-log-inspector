import { useState, useCallback, useRef, DragEvent, ChangeEvent } from 'react';
import { useStore } from '../store/useStore';
import { useToast } from './Toast';
import { parseLogFile, parsePlanYaml, isYamlContent } from '../parser';
import { processArchive } from '../parser/archiveProcessor';

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

export function UploadZone() {
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [clearOnUpload, setClearOnUpload] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { setParseResult, clearData } = useStore();
  const { showToast } = useToast();

  const handleFile = useCallback(async (file: File) => {
    if (!isValidFile(file.name)) {
      showToast(
        `Invalid file type. Allowed: ${[...PLAIN_EXTENSIONS, '.tar', '.tar.gz', '.tgz'].join(', ')}`,
        'error',
      );
      return;
    }

    setIsProcessing(true);

    try {
      if (clearOnUpload) {
        clearData();
      }

      // ── Archive path ──────────────────────────────────────────────
      if (isArchiveFile(file.name)) {
        const archiveResult = await processArchive(file);

        if (archiveResult.logFiles.length === 0 && archiveResult.yamlFiles.length === 0) {
          showToast(
            'No forklift controller logs or Plan YAMLs found in archive',
            'error',
          );
          return;
        }

        setParseResult(archiveResult.parsedData);

        const parts: string[] = [];
        if (archiveResult.logFiles.length > 0) {
          parts.push(
            `${archiveResult.logFiles.length} log file${archiveResult.logFiles.length !== 1 ? 's' : ''}`,
          );
        }
        if (archiveResult.yamlFiles.length > 0) {
          parts.push(
            `${archiveResult.yamlFiles.length} Plan YAML${archiveResult.yamlFiles.length !== 1 ? 's' : ''}`,
          );
        }
        showToast(
          `Archive processed: found ${parts.join(' and ')} (${archiveResult.parsedData.stats.plansFound} plan${archiveResult.parsedData.stats.plansFound !== 1 ? 's' : ''}, ${archiveResult.parsedData.stats.vmsFound} VM${archiveResult.parsedData.stats.vmsFound !== 1 ? 's' : ''})`,
          'success',
        );
        return;
      }

      // ── Plain file path ───────────────────────────────────────────
      const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
      const content = await file.text();
      const isYaml = ext === '.yaml' || ext === '.yml' || isYamlContent(content);

      const result = isYaml ? parsePlanYaml(content) : parseLogFile(content);
      setParseResult(result);

      showToast(
        isYaml
          ? `Parsed Plan YAML: found ${result.stats.plansFound} plan${result.stats.plansFound !== 1 ? 's' : ''}, ${result.stats.vmsFound} VM${result.stats.vmsFound !== 1 ? 's' : ''}`
          : `Parsed ${result.stats.parsedLines.toLocaleString()} lines, found ${result.stats.plansFound} plans`,
        'success',
      );
    } catch (error) {
      console.error('Error parsing file:', error);
      showToast('Failed to parse file', 'error');
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

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      handleFile(files[0]);
    }
  }, [handleFile]);

  const handleFileInputChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      handleFile(files[0]);
    }
    // Reset input so same file can be selected again
    e.target.value = '';
  }, [handleFile]);

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
          accept=".log,.txt,.json,.yaml,.yml,.tar,.tar.gz,.tgz"
          onChange={handleFileInputChange}
          className="hidden"
        />

        {isProcessing ? (
          <div className="flex flex-col items-center gap-3">
            <div className="w-8 h-8 border-2 border-pink-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-slate-500 dark:text-gray-400">Processing file...</p>
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
              Drop your log file, Plan YAML, or archive here, or click to browse
            </p>
            <p className="text-slate-500 dark:text-gray-400 text-sm">
              Supports .log, .txt, .json, .yaml, .yml, .tar, .tar.gz, .tgz files
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
