/**
 * Web Worker for processing archive files off the main thread.
 *
 * Receives a File via postMessage, runs the full extraction → classification
 * → parsing pipeline, and posts back progress updates and the final result.
 */

import { processArchive } from './archiveProcessor';

export interface WorkerProgressMessage {
  type: 'progress';
  stage: string;
  detail?: string;
}

export interface WorkerResultMessage {
  type: 'result';
  data: import('../types').ArchiveResult;
}

export interface WorkerErrorMessage {
  type: 'error';
  message: string;
}

export type WorkerOutMessage = WorkerProgressMessage | WorkerResultMessage | WorkerErrorMessage;

export interface WorkerInMessage {
  type: 'processArchive';
  file: File;
}

const ctx = self as unknown as Worker;

ctx.onmessage = async (event: MessageEvent<WorkerInMessage>) => {
  const msg = event.data;

  if (msg.type === 'processArchive') {
    try {
      const result = await processArchive(msg.file, (stage, detail) => {
        ctx.postMessage({ type: 'progress', stage, detail } satisfies WorkerProgressMessage);
      });
      ctx.postMessage({ type: 'result', data: result } satisfies WorkerResultMessage);
    } catch (err) {
      ctx.postMessage({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      } satisfies WorkerErrorMessage);
    }
  }
};
