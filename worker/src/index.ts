import { Worker, Job as BullJob } from 'bullmq';
import { parse } from 'csv-parse';
import { createReadStream } from 'fs';
import { Readable } from 'stream';
import { Pool } from 'pg';
import { Pool } from 'pg';
import {
  getJob,
  updateJobStatus,
  updateJobProgress,
  setJobStarted,
  setJobFinished,
  setJobResults,
  addJobLog,
  addJobError,
} from '../../server/src/db';
import { getStorageAdapter } from '../../server/src/storage';
import { ParkopediaAPIClient } from '../../server/src/api-client';
import { JobConfiguration, JobMode, JobResultRow, JobSummary, CSVRow } from '@poi-testing/shared';
import { parseCSVRow, hasRequiredFields } from '@poi-testing/shared/src/utils';

// Load .env from project root (go up from worker/src to project root)
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const redisConnection = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
};

const dbPool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'poi_testing',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const storage = getStorageAdapter();

interface JobData {
  jobId: string;
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxAttempts: number,
  backoffMs: number,
  isRetryable: (error: any) => boolean = () => true
): Promise<T> {
  let lastError: any;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      if (attempt < maxAttempts && isRetryable(error)) {
        const delay = backoffMs * Math.pow(2, attempt - 1);
        await sleep(delay);
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

function isRateLimited(error: string | null): boolean {
  if (!error) return false;
  const lower = error.toLowerCase();
  return lower.includes('rate limit') || 
         lower.includes('too many requests') ||
         lower.includes('429') ||
         lower.includes('service invoked too many times');
}

async function processJob(bullJob: BullJob<JobData>) {
  const { jobId } = bullJob.data;
  const dbJob = await getJob(jobId);
  
  if (!dbJob) {
    throw new Error(`Job ${jobId} not found`);
  }

  // Check if cancelled
  if (dbJob.status === 'CANCELLING') {
    await updateJobStatus(jobId, 'CANCELLED');
    await addJobLog(jobId, 'info', 'Job cancelled');
    return;
  }

  // Check if paused
  if (dbJob.status === 'PAUSED') {
    await addJobLog(jobId, 'info', 'Job paused, waiting for resume');
    return;
  }

  // Initialize API client
  const config = dbJob.configuration;
  const apiClient = new ParkopediaAPIClient({
    ...config,
    client_id: process.env.API_CLIENT_ID || '',
    client_secret: process.env.API_CLIENT_SECRET || '',
    username: process.env.API_USERNAME || '',
    password: process.env.API_PASSWORD || '',
  });

  // Get token once at start
  try {
    await apiClient.getToken();
    await addJobLog(jobId, 'info', 'Authentication token obtained');
  } catch (error: any) {
    await updateJobStatus(jobId, 'FAILED', `Failed to get auth token: ${error.message}`);
    await addJobLog(jobId, 'error', 'Failed to get auth token', { error: error.message });
    return;
  }

  await setJobStarted(jobId);
  await addJobLog(jobId, 'info', 'Job started processing');

  // Open results file for writing
  const resultsPath = `results/${jobId}-results.ndjson`;
  const fs = await import('fs/promises');
  const path = await import('path');
  const storageBaseDir = process.env.STORAGE_BASE_DIR || './storage';
  const resultsFilePath = path.join(storageBaseDir, resultsPath);
  await fs.mkdir(path.dirname(resultsFilePath), { recursive: true });
  const resultsFileHandle = await fs.open(resultsFilePath, 'w');

  let rowNumber = 0;
  let successCount = 0;
  let errorCount = 0;
  let rateLimitedCount = 0;
  const failureReasons: Record<string, number> = {};
  const startTime = Date.now();

  // Calculate time offsets
  const now = new Date();
  const startTimeUtc = new Date(now.getTime() + config.start_time_offset_hours * 60 * 60 * 1000);
  const stopTimeUtc = new Date(startTimeUtc.getTime() + config.duration_hours * 60 * 60 * 1000);

  // Check if file exists before processing
  const fileExists = await storage.fileExists(dbJob.file_path);
  if (!fileExists) {
    await updateJobStatus(jobId, 'FAILED', `File not found: ${dbJob.file_path}`);
    await addJobLog(jobId, 'error', 'File not found', { file_path: dbJob.file_path });
    await resultsFileHandle.close();
    return;
  }

  // Count total rows first for progress tracking
  let totalRows = 0;
  try {
    await addJobLog(jobId, 'info', 'Counting rows in CSV file...');
    const countStream = await storage.getFileStream(dbJob.file_path);
    const countParser = parse({
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
    });
    
    let lastUpdate = 0;
    await new Promise<void>((resolve, reject) => {
      countParser.on('readable', () => {
        while (countParser.read() !== null) {
          totalRows++;
          // Update job progress in BullMQ every 1000 rows to prevent stalling
          if (totalRows - lastUpdate >= 1000) {
            bullJob.updateProgress(Math.floor((totalRows / 100000) * 100)).catch(() => {}); // Estimate progress, ignore errors
            lastUpdate = totalRows;
          }
        }
      });
      countParser.on('end', () => {
        resolve();
      });
      countParser.on('error', reject);
      countStream.pipe(countParser);
    });
    
    // Set total rows estimate at the start
    await updateJobProgress(jobId, {
      total_rows_estimated: totalRows,
    });
    await bullJob.updateProgress(0); // Reset progress for actual processing
    await addJobLog(jobId, 'info', `CSV file contains ${totalRows} rows`, { total_rows: totalRows });
  } catch (error: any) {
    await addJobLog(jobId, 'warn', 'Could not count rows upfront, will estimate during processing', { error: error.message });
  }

  // Get file stream for actual processing
  let fileStream: Readable;
  try {
    fileStream = await storage.getFileStream(dbJob.file_path);
  } catch (error: any) {
    await updateJobStatus(jobId, 'FAILED', `Failed to open file: ${error.message}`);
    await addJobLog(jobId, 'error', 'Failed to open file', { error: error.message, file_path: dbJob.file_path });
    await resultsFileHandle.close();
    return;
  }
  
  // Parse CSV with streaming
  const parser = parse({
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
  });

  let checkpointOffset = dbJob.checkpoint_offset || 0;
  let bytesRead = 0;

  // Skip to checkpoint if resuming
  if (checkpointOffset > 0) {
    // For simplicity, we'll process from start but track offset
    // In production, you'd want to seek the file stream
    await addJobLog(jobId, 'info', `Resuming from checkpoint: ${checkpointOffset} bytes`);
  }

  return new Promise<void>((resolve, reject) => {
    // Handle file stream errors
    fileStream.on('error', async (error: any) => {
      await updateJobStatus(jobId, 'FAILED', `File stream error: ${error.message}`);
      await addJobLog(jobId, 'error', 'File stream error', { error: error.message });
      await resultsFileHandle.close().catch(() => {});
      reject(error);
    });

    let processing = false;
    const rowQueue: Record<string, any>[] = [];

    const processNextRow = async () => {
      if (processing || rowQueue.length === 0) return;
      processing = true;

      while (rowQueue.length > 0) {
        const row = rowQueue.shift();
        if (!row) break;

        try {
          // Check for pause/cancel
          const currentJob = await getJob(jobId);
          if (currentJob?.status === 'CANCELLING') {
            parser.destroy();
            await updateJobStatus(jobId, 'CANCELLED');
            await updateJobProgress(jobId, {
              rows_processed: rowNumber,
              success_count: successCount,
              error_count: errorCount,
              rate_limited_count: rateLimitedCount,
            }, bytesRead);
            processing = false;
            resolve();
            return;
          }

          if (currentJob?.status === 'PAUSED') {
            parser.pause();
            await updateJobProgress(jobId, {
              rows_processed: rowNumber,
              success_count: successCount,
              error_count: errorCount,
              rate_limited_count: rateLimitedCount,
            }, bytesRead);
            await addJobLog(jobId, 'info', `Job paused at row ${rowNumber}`);
            processing = false;
            // Resolve to complete the BullMQ job, allowing the next job in queue to start
            resolve();
            return;
          }

          rowNumber++;
          const rowStartTime = Date.now();
          const parsedRow = parseCSVRow(row);

      // Validate required fields
      if (!hasRequiredFields(parsedRow)) {
        errorCount++;
        const errorMsg = 'Missing required field: rid or zone';
        failureReasons[errorMsg] = (failureReasons[errorMsg] || 0) + 1;
        
        const resultRow: JobResultRow = {
          job_id: jobId,
          row_number: rowNumber,
          rid: parsedRow.rid,
          zone: parsedRow.zone,
          space: parsedRow.space,
          mode: dbJob.mode as JobMode,
          start_time_utc: startTimeUtc.toISOString(),
          stop_time_utc: stopTimeUtc.toISOString(),
          quote_status_code: null,
          quote_ok: false,
          quote_error: errorMsg,
          start_status_code: null,
          start_ok: false,
          payment_id: null,
          start_error: null,
          stop_status_code: null,
          stop_ok: false,
          stop_error: null,
          duration_ms: Date.now() - rowStartTime,
          timestamp: new Date().toISOString(),
        };

        await resultsFileHandle.writeFile(JSON.stringify(resultRow) + '\n');
        await addJobError(jobId, rowNumber, parsedRow.rid, parsedRow.zone, parsedRow.space, 'validation', errorMsg);
        return;
      }

      // Build quote payload
      const quotePayload: any = {};
      if (parsedRow.zone) {
        quotePayload.parking_payment_zone_id = parsedRow.zone;
      } else if (parsedRow.rid) {
        quotePayload.location_id = parsedRow.rid;
      }
      if (parsedRow.space) {
        quotePayload.location_space_id = parsedRow.space;
      }

      let quoteResult: any = null;
      let startResult: any = null;
      let stopResult: any = null;

      // Request quote
      console.log(`[ROW ${rowNumber}] Processing row:`, { rid: parsedRow.rid, zone: parsedRow.zone, space: parsedRow.space });
      try {
        quoteResult = await retryWithBackoff(
          () => apiClient.requestQuote(
            quotePayload,
            startTimeUtc.toISOString(),
            stopTimeUtc.toISOString()
          ),
          config.retry_max_attempts,
          config.retry_backoff_ms,
          (error) => {
            const status = error?.status || 0;
            return status >= 500 || status === 0; // Retry 5xx and network errors
          }
        );

        console.log(`[ROW ${rowNumber}] Quote result:`, { status: quoteResult.status, error: quoteResult.error, hasData: !!quoteResult.data });

        // Throttle
        if (config.request_delay_ms) {
          await sleep(config.request_delay_ms);
        }
      } catch (error: any) {
        console.error(`[ROW ${rowNumber}] Quote exception:`, error.message);
        quoteResult = {
          status: 0,
          error: error.message || 'Unknown error',
        };
      }

      // Accept both 200 and 201 as success, but check for error in response body
      const quoteOk = (quoteResult.status === 200 || quoteResult.status === 201) && !quoteResult.error;
      console.log(`[ROW ${rowNumber}] Quote ${quoteOk ? 'SUCCESS' : 'FAILED'}:`, quoteResult.status, quoteResult.error || 'OK');
      if (!quoteOk) {
        errorCount++;
        if (isRateLimited(quoteResult.error)) {
          rateLimitedCount++;
          await sleep(config.rate_limit_backoff_ms);
        }
        const errorMsg = quoteResult.error || `HTTP ${quoteResult.status}`;
        failureReasons[errorMsg] = (failureReasons[errorMsg] || 0) + 1;
        // Log error to database
        await addJobError(
          jobId,
          rowNumber,
          parsedRow.rid,
          parsedRow.zone,
          parsedRow.space,
          'quote',
          errorMsg
        );
      } else {
        successCount++;
      }

      // Mode B: Start and stop session
      if (dbJob.mode === 'QUOTE_START_STOP' && quoteOk) {
        try {
          startResult = await retryWithBackoff(
            () => apiClient.startPayment(
              { ...quotePayload, start_time_utc: startTimeUtc.toISOString() },
              startTimeUtc.toISOString(),
              stopTimeUtc.toISOString()
            ),
            config.retry_max_attempts,
            config.retry_backoff_ms,
            (error) => {
              const status = error?.status || 0;
              return status >= 500 || status === 0;
            }
          );

          console.log(`[ROW ${rowNumber}] Start payment result:`, { status: startResult.status, paymentId: startResult.paymentId, error: startResult.error });

          if (config.request_delay_ms) {
            await sleep(config.request_delay_ms);
          }

          if ((startResult.status === 200 || startResult.status === 201) && startResult.paymentId && !startResult.error) {
            try {
              stopResult = await retryWithBackoff(
                () => apiClient.stopPayment(startResult.paymentId),
                config.retry_max_attempts,
                config.retry_backoff_ms,
                (error) => {
                  const status = error?.status || 0;
                  return status >= 500 || status === 0;
                }
              );

              console.log(`[ROW ${rowNumber}] Stop payment result:`, { status: stopResult.status, error: stopResult.error });

              if (stopResult.error || (stopResult.status !== 200 && stopResult.status !== 201 && stopResult.status !== 204)) {
                await addJobError(
                  jobId,
                  rowNumber,
                  parsedRow.rid,
                  parsedRow.zone,
                  parsedRow.space,
                  'stop',
                  stopResult.error || `HTTP ${stopResult.status}`
                );
              }

              if (config.request_delay_ms) {
                await sleep(config.request_delay_ms);
              }
            } catch (error: any) {
              console.error(`[ROW ${rowNumber}] Stop payment exception:`, error.message);
              stopResult = {
                status: 0,
                error: error.message || 'Unknown error',
              };
              await addJobError(
                jobId,
                rowNumber,
                parsedRow.rid,
                parsedRow.zone,
                parsedRow.space,
                'stop',
                error.message || 'Unknown error'
              );
            }
          } else if (startResult.error) {
            await addJobError(
              jobId,
              rowNumber,
              parsedRow.rid,
              parsedRow.zone,
              parsedRow.space,
              'start',
              startResult.error || `HTTP ${startResult.status}`
            );
          }
        } catch (error: any) {
          console.error(`[ROW ${rowNumber}] Start payment exception:`, error.message);
          startResult = {
            status: 0,
            error: error.message || 'Unknown error',
          };
          await addJobError(
            jobId,
            rowNumber,
            parsedRow.rid,
            parsedRow.zone,
            parsedRow.space,
            'start',
            error.message || 'Unknown error'
          );
        }
      }

      // Write result row
      const resultRow: JobResultRow = {
        job_id: jobId,
        row_number: rowNumber,
        rid: parsedRow.rid,
        zone: parsedRow.zone,
        space: parsedRow.space,
        mode: dbJob.mode as JobMode,
        start_time_utc: startTimeUtc.toISOString(),
        stop_time_utc: stopTimeUtc.toISOString(),
        quote_status_code: quoteResult.status,
        quote_ok: quoteOk,
        quote_error: quoteOk ? null : (quoteResult.error || `HTTP ${quoteResult.status}`),
        start_status_code: startResult?.status || null,
        start_ok: ((startResult?.status === 200 || startResult?.status === 201) && !startResult?.error) || false,
        payment_id: startResult?.paymentId || null,
        start_error: ((startResult?.status === 200 || startResult?.status === 201) && !startResult?.error) ? null : (startResult?.error || null),
        stop_status_code: stopResult?.status || null,
        stop_ok: ((stopResult?.status === 200 || stopResult?.status === 201 || stopResult?.status === 204) && !stopResult?.error) || false,
        stop_error: ((stopResult?.status === 200 || stopResult?.status === 201 || stopResult?.status === 204) && !stopResult?.error) ? null : (stopResult?.error || null),
        duration_ms: Date.now() - rowStartTime,
        timestamp: new Date().toISOString(),
      };

          await resultsFileHandle.writeFile(JSON.stringify(resultRow) + '\n');

          // Update progress after each row
          const progressUpdate: any = {
            rows_processed: rowNumber,
            success_count: successCount,
            error_count: errorCount,
            rate_limited_count: rateLimitedCount,
          };
          // If we haven't set total_rows_estimated yet, use current row count as estimate
          if (!totalRows || rowNumber > totalRows) {
            progressUpdate.total_rows_estimated = rowNumber;
          }
          await updateJobProgress(jobId, progressUpdate, bytesRead);
          // Update BullMQ job progress to prevent stalling
          if (totalRows > 0) {
            const percentComplete = Math.floor((rowNumber / totalRows) * 100);
            await bullJob.updateProgress(percentComplete);
          }
        } catch (error: any) {
          console.error(`Error processing row ${rowNumber}:`, error);
          await addJobLog(jobId, 'error', `Error processing row ${rowNumber}`, { error: error.message });
        }
      }

      processing = false;
    };

    fileStream.pipe(parser);

    parser.on('data', (row: Record<string, any>) => {
      rowQueue.push(row);
      processNextRow();
    });

    parser.on('end', async () => {
      // Wait for any remaining rows to process
      while (processing || rowQueue.length > 0) {
        await sleep(100);
      }
      
      await resultsFileHandle.close();

      // Generate summary
      const summary: JobSummary = {
        job_id: jobId,
        total_rows: rowNumber,
        processed: rowNumber,
        successes: successCount,
        errors: errorCount,
        rate_limited: rateLimitedCount,
        started_at: new Date(startTime).toISOString(),
        finished_at: new Date().toISOString(),
        failure_reasons_topN: Object.entries(failureReasons)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([reason, count]) => ({ reason, count })),
      };

      const summaryPath = `results/${jobId}-summary.json`;
      const summaryFilePath = path.join(storageBaseDir, summaryPath);
      await fs.writeFile(summaryFilePath, JSON.stringify(summary, null, 2));

      await setJobResults(jobId, resultsPath, summaryPath);
      // Final progress update - use the totalRows we counted, or rowNumber if counting failed
      await updateJobProgress(jobId, {
        total_rows_estimated: totalRows || rowNumber,
        rows_processed: rowNumber,
        success_count: successCount,
        error_count: errorCount,
        rate_limited_count: rateLimitedCount,
      });

      await setJobFinished(jobId, 'COMPLETED');
      await addJobLog(jobId, 'info', 'Job completed', {
        total_rows: rowNumber,
        successes: successCount,
        errors: errorCount,
        rate_limited: rateLimitedCount,
      });

      resolve();
    });

    parser.on('error', async (error) => {
      await updateJobStatus(jobId, 'FAILED', `CSV parsing error: ${error.message}`);
      await addJobLog(jobId, 'error', 'CSV parsing failed', { error: error.message });
      reject(error);
    });
  });
}

const worker = new Worker<JobData>(
  'job-processing',
  async (job: BullJob<JobData>) => {
    return await processJob(job);
  },
  {
    connection: redisConnection,
    concurrency: parseInt(process.env.WORKER_CONCURRENCY || '1'),
    lockDuration: 24 * 60 * 60 * 1000, // 24 hours - allow long-running jobs
    maxStalledCount: 0, // Don't mark as stalled (jobs can take a long time)
  }
);
worker.on('error', (error) => {
  console.error('Worker error:', error);
});

worker.on('completed', (job) => {
  console.log(`Job ${job.id} completed`);
});

worker.on('failed', (job, err) => {
  console.error(`Job ${job?.id} failed:`, err);
  if (job?.data?.jobId) {
    updateJobStatus(job.data.jobId, 'FAILED', err.message).catch(console.error);
  }
});

console.log('Worker started');
