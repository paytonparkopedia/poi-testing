import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { initDB, createJob, getJob, listJobs, updateJobStatus, deleteJob, addAuditLog } from './db';
import { getStorageAdapter } from './storage';
import { Queue } from 'bullmq';
import { JobConfiguration, JobMode } from '@poi-testing/shared';
import { Readable } from 'stream';
import { promises as fs } from 'fs';
import { join } from 'path';

// Load .env from project root (go up from server/src to project root)
require('dotenv').config({ path: join(__dirname, '../../.env') });

const app = Fastify({ logger: true });

// CORS
app.register(cors, {
  origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
  credentials: true,
});

// Multipart for file uploads
app.register(multipart, {
  limits: {
    fileSize: 1024 * 1024 * 1024, // 1GB
  },
});

// Redis connection for BullMQ
const redisConnection = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
};

const jobQueue = new Queue('job-processing', {
  connection: redisConnection,
});

jobQueue.on('error', (error) => {
  console.error('Redis queue error:', error);
});

const storage = getStorageAdapter();

// Auth middleware (stub - replace with real SSO/OIDC)
async function authenticate(request: any, reply: any) {
  // For MVP: use header or query param
  const userEmail = request.headers['x-user-email'] || request.query.userEmail || 'anonymous@example.com';
  request.userEmail = userEmail;
}

// Health check
app.get('/health', async () => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

// Upload CSV and create job
app.post('/api/jobs', { preHandler: authenticate }, async (request: any, reply) => {
  const userEmail = request.userEmail;
  
  // Parse multipart form
  const parts = request.parts();
  let fileData: any = null;
  let mode = 'QUOTE_ONLY';

  for await (const part of parts) {
    if (part.type === 'file') {
      fileData = part;
    } else if (part.fieldname === 'mode') {
      mode = part.value as string;
    }
  }

  if (!fileData) {
    return reply.code(400).send({ error: 'No file uploaded' });
  }
  if (mode !== 'QUOTE_ONLY' && mode !== 'QUOTE_START_STOP') {
    return reply.code(400).send({ error: 'Invalid mode' });
  }

  // Build configuration from env vars
  const configuration: JobConfiguration = {
    apiver: process.env.API_APIVER || '',
    uid: process.env.API_UID || '',
    cid: process.env.API_CID || '',
    user_id: process.env.API_USER_ID || '',
    base_url: process.env.API_BASE_URL || '',
    start_time_offset_hours: parseInt(process.env.START_TIME_OFFSET_HOURS || '8'),
    duration_hours: parseInt(process.env.DURATION_HOURS || '24'),
    request_throttle_rps: process.env.REQUEST_THROTTLE_RPS ? parseInt(process.env.REQUEST_THROTTLE_RPS) : undefined,
    request_delay_ms: process.env.REQUEST_DELAY_MS ? parseInt(process.env.REQUEST_DELAY_MS) : undefined,
    retry_max_attempts: parseInt(process.env.RETRY_MAX_ATTEMPTS || '2'),
    retry_backoff_ms: parseInt(process.env.RETRY_BACKOFF_MS || '1000'),
    rate_limit_backoff_ms: parseInt(process.env.RATE_LIMIT_BACKOFF_MS || '60000'),
    max_runtime_hours: process.env.MAX_RUNTIME_HOURS ? parseInt(process.env.MAX_RUNTIME_HOURS) : undefined,
    max_errors_threshold: process.env.MAX_ERRORS_THRESHOLD ? parseInt(process.env.MAX_ERRORS_THRESHOLD) : undefined,
  };

  // Validate required config
  if (!configuration.apiver || !configuration.uid || !configuration.cid || 
      !configuration.user_id || !configuration.base_url) {
    return reply.code(500).send({ error: 'Server configuration incomplete' });
  }

  // Save file to storage
  const filePath = `uploads/${Date.now()}-${fileData.filename}`;
  const fileStream = Readable.from(fileData.file);
  const savedPath = await storage.saveFile(filePath, fileStream);

  // Get file size - use the actual saved path from storage adapter
  const stats = await import('fs/promises');
  // Wait a moment for the file to be fully written
  await new Promise(resolve => setTimeout(resolve, 100));
  const fileStat = await stats.stat(savedPath);

  // Create job record
  const jobId = await createJob(
    userEmail,
    fileData.filename,
    fileStat.size,
    filePath,
    mode as JobMode,
    configuration
  );

  // Enqueue job with long lock duration (for large CSV files that take time to process)
  // Lock duration: 24 hours (in milliseconds) - enough for very large files
  await jobQueue.add('process-job', { jobId }, {
    jobId,
    attempts: 1, // Jobs should not retry automatically
    lockDuration: 24 * 60 * 60 * 1000, // 24 hours in milliseconds
  });

  await addAuditLog(userEmail, 'CREATE', 'job', jobId, { filename: fileData.filename, mode });

  return { id: jobId, status: 'QUEUED' };
});

// List jobs
app.get('/api/jobs', { preHandler: authenticate }, async (request: any, reply) => {
  const userEmail = request.userEmail;
  const isAdmin = request.headers['x-user-role'] === 'admin';
  const limit = parseInt((request.query as any)?.limit || '50');
  const offset = parseInt((request.query as any)?.offset || '0');

  const jobs = await listJobs(isAdmin ? undefined : userEmail, limit, offset);
  
  return jobs.map(job => ({
    id: job.id,
    created_at: job.created_at,
    created_by: job.created_by,
    filename: job.filename,
    file_size: job.file_size,
    mode: job.mode,
    status: job.status,
    progress: {
      total_rows_estimated: job.total_rows_estimated,
      rows_processed: job.rows_processed,
      success_count: job.success_count,
      error_count: job.error_count,
      rate_limited_count: job.rate_limited_count,
    },
    started_at: job.started_at,
    finished_at: job.finished_at,
    percent_progress: job.total_rows_estimated 
      ? (job.rows_processed / job.total_rows_estimated) * 100 
      : null,
  }));
});

// Get job details
app.get('/api/jobs/:id', { preHandler: authenticate }, async (request: any, reply) => {
  const jobId = (request.params as any).id;
  const userEmail = request.userEmail;
  const isAdmin = request.headers['x-user-role'] === 'admin';

  const job = await getJob(jobId);
  if (!job) {
    return reply.code(404).send({ error: 'Job not found' });
  }

  if (!isAdmin && job.created_by !== userEmail) {
    return reply.code(403).send({ error: 'Forbidden' });
  }

  return {
    id: job.id,
    created_at: job.created_at,
    created_by: job.created_by,
    filename: job.filename,
    file_size: job.file_size,
    mode: job.mode,
    status: job.status,
    progress: {
      total_rows_estimated: job.total_rows_estimated,
      rows_processed: job.rows_processed,
      success_count: job.success_count,
      error_count: job.error_count,
      rate_limited_count: job.rate_limited_count,
    },
    started_at: job.started_at,
    finished_at: job.finished_at,
    percent_progress: job.total_rows_estimated 
      ? (job.rows_processed / job.total_rows_estimated) * 100 
      : null,
    configuration: job.configuration,
    results_path: job.results_path,
    summary_path: job.summary_path,
    checkpoint_offset: job.checkpoint_offset,
    error_message: job.error_message,
  };
});

// Pause job
app.post('/api/jobs/:id/pause', { preHandler: authenticate }, async (request: any, reply) => {
  const jobId = (request.params as any).id;
  const userEmail = request.userEmail;
  const isAdmin = request.headers['x-user-role'] === 'admin';

  const job = await getJob(jobId);
  if (!job) {
    return reply.code(404).send({ error: 'Job not found' });
  }

  if (!isAdmin && job.created_by !== userEmail) {
    return reply.code(403).send({ error: 'Forbidden' });
  }

  if (job.status !== 'RUNNING') {
    return reply.code(400).send({ error: 'Job is not running' });
  }

  // Set status to PAUSED - worker will detect this during processing and return early
  // This will complete the current BullMQ job and allow the next job in queue to start
  await updateJobStatus(jobId, 'PAUSED');
  await addAuditLog(userEmail, 'PAUSE', 'job', jobId);

  return { status: 'PAUSED' };
});

// Resume job
app.post('/api/jobs/:id/resume', { preHandler: authenticate }, async (request: any, reply) => {
  const jobId = (request.params as any).id;
  const userEmail = request.userEmail;
  const isAdmin = request.headers['x-user-role'] === 'admin';

  const job = await getJob(jobId);
  if (!job) {
    return reply.code(404).send({ error: 'Job not found' });
  }

  if (!isAdmin && job.created_by !== userEmail) {
    return reply.code(403).send({ error: 'Forbidden' });
  }

  if (job.status !== 'PAUSED') {
    return reply.code(400).send({ error: 'Job is not paused' });
  }

  await updateJobStatus(jobId, 'QUEUED');
  await jobQueue.add('process-job', { jobId }, { 
    jobId,
    lockDuration: 24 * 60 * 60 * 1000, // 24 hours in milliseconds
  });
  await addAuditLog(userEmail, 'RESUME', 'job', jobId);

  return { status: 'QUEUED' };
});

// Cancel job
app.post('/api/jobs/:id/cancel', { preHandler: authenticate }, async (request: any, reply) => {
  const jobId = (request.params as any).id;
  const userEmail = request.userEmail;
  const isAdmin = request.headers['x-user-role'] === 'admin';

  const job = await getJob(jobId);
  if (!job) {
    return reply.code(404).send({ error: 'Job not found' });
  }

  if (!isAdmin && job.created_by !== userEmail) {
    return reply.code(403).send({ error: 'Forbidden' });
  }

  if (!['QUEUED', 'RUNNING', 'PAUSED'].includes(job.status)) {
    return reply.code(400).send({ error: 'Job cannot be cancelled' });
  }

  await updateJobStatus(jobId, 'CANCELLING');
  await addAuditLog(userEmail, 'CANCEL', 'job', jobId);

  return { status: 'CANCELLING' };
});

// Remove job (soft delete - only when cancelled/completed)
app.delete('/api/jobs/:id', { preHandler: authenticate }, async (request: any, reply) => {
  const jobId = (request.params as any).id;
  const userEmail = request.userEmail;
  const isAdmin = request.headers['x-user-role'] === 'admin';

  const job = await getJob(jobId);
  if (!job) {
    return reply.code(404).send({ error: 'Job not found' });
  }

  if (!isAdmin && job.created_by !== userEmail) {
    return reply.code(403).send({ error: 'Forbidden' });
  }

  if (!['CANCELLED', 'COMPLETED', 'FAILED'].includes(job.status)) {
    return reply.code(400).send({ error: 'Job can only be removed when cancelled, completed, or failed' });
  }

  // Delete the job from the database (cascades to logs and errors)
  await deleteJob(jobId);
  await addAuditLog(userEmail, 'DELETE', 'job', jobId);

  return { success: true };
});

// Get job logs
app.get('/api/jobs/:id/logs', { preHandler: authenticate }, async (request: any, reply) => {
  const jobId = (request.params as any).id;
  const userEmail = request.userEmail;
  const isAdmin = request.headers['x-user-role'] === 'admin';

  const job = await getJob(jobId);
  if (!job) {
    return reply.code(404).send({ error: 'Job not found' });
  }

  if (!isAdmin && job.created_by !== userEmail) {
    return reply.code(403).send({ error: 'Forbidden' });
  }

  const { getJobLogs } = await import('./db');
  const logs = await getJobLogs(jobId, 100);

  return logs;
});

// Get job errors
app.get('/api/jobs/:id/errors', { preHandler: authenticate }, async (request: any, reply) => {
  const jobId = (request.params as any).id;
  const userEmail = request.userEmail;
  const isAdmin = request.headers['x-user-role'] === 'admin';

  const job = await getJob(jobId);
  if (!job) {
    return reply.code(404).send({ error: 'Job not found' });
  }

  if (!isAdmin && job.created_by !== userEmail) {
    return reply.code(403).send({ error: 'Forbidden' });
  }

  const { getJobErrors } = await import('./db');
  const errors = await getJobErrors(jobId, 50);

  return errors;
});

// Download results
app.get('/api/jobs/:id/results', { preHandler: authenticate }, async (request: any, reply) => {
  const jobId = (request.params as any).id;
  const userEmail = request.userEmail;
  const isAdmin = request.headers['x-user-role'] === 'admin';

  const job = await getJob(jobId);
  if (!job) {
    return reply.code(404).send({ error: 'Job not found' });
  }

  if (!isAdmin && job.created_by !== userEmail) {
    return reply.code(403).send({ error: 'Forbidden' });
  }

  if (!job.results_path) {
    return reply.code(404).send({ error: 'Results not available yet' });
  }

  const stream = await storage.getFileStream(job.results_path);
  reply.type('application/x-ndjson');
  reply.send(stream);
});

// Download summary
app.get('/api/jobs/:id/summary', { preHandler: authenticate }, async (request: any, reply) => {
  const jobId = (request.params as any).id;
  const userEmail = request.userEmail;
  const isAdmin = request.headers['x-user-role'] === 'admin';

  const job = await getJob(jobId);
  if (!job) {
    return reply.code(404).send({ error: 'Job not found' });
  }

  if (!isAdmin && job.created_by !== userEmail) {
    return reply.code(403).send({ error: 'Forbidden' });
  }

  if (!job.summary_path) {
    return reply.code(404).send({ error: 'Summary not available yet' });
  }

  const stream = await storage.getFileStream(job.summary_path);
  reply.type('application/json');
  reply.send(stream);
});

const start = async () => {
  try {
    // Initialize database
    await initDB();

    const port = parseInt(process.env.PORT || '3001');
    await app.listen({ port, host: '0.0.0.0' });
    console.log(`Server listening on port ${port}`);
  } catch (err: any) {
    app.log.error(err);
    process.exit(1);
  }
};

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
