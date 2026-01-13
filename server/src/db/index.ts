// Load .env FIRST before ANY imports (critical - must be first!)
// Use absolute path resolution to ensure we get the project root correctly
const pathSync = require('path');
// Resolve to absolute path to avoid any relative path issues
const projectRoot = pathSync.resolve(__dirname, '../../../');
const envPath = pathSync.join(projectRoot, '.env');
// Force reload with override to ensure we get the latest values from .env
require('dotenv').config({ path: envPath, override: true });

import { Pool, PoolClient } from 'pg';
import { Job, JobLog, JobConfiguration, JobProgress, JobStatus } from '@poi-testing/shared';
import { promises as fs } from 'fs';
import { join } from 'path';

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'poi_testing',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  max: 20,
};
const pool = new Pool(dbConfig);

export { pool };

export async function initDB() {
  let client;
  try {
    client = await pool.connect();
  } catch (error: any) {
    throw error;
  }
  try {
    // Read and execute schema
    const fs = await import('fs/promises');
    const path = await import('path');
    const schema = await fs.readFile(
      path.join(__dirname, 'schema.sql'),
      'utf-8'
    );
    // Split schema into individual statements and execute them one by one
    // This allows IF NOT EXISTS to work properly for each statement
    const statements = schema
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'));
    
    for (const statement of statements) {
      try {
        await client.query(statement);
      } catch (error: any) {
        // Ignore errors for indexes/tables that already exist
        // Error code 42P07 = duplicate_table, 42P16 = invalid_table_definition
        // But for CREATE INDEX IF NOT EXISTS, it shouldn't error, so log it
        if (error.code !== '42P07' && !error.message.includes('already exists')) {
          console.warn(`Schema statement warning: ${error.message}`);
          // Don't throw - continue with other statements
        }
      }
    }
    console.log('Database schema initialized');
  } finally {
    client.release();
  }
}

export interface JobRow {
  id: string;
  created_at: Date;
  created_by: string;
  filename: string;
  file_size: number;
  file_path: string;
  mode: string;
  status: string;
  total_rows_estimated: number | null;
  rows_processed: number;
  success_count: number;
  error_count: number;
  rate_limited_count: number;
  started_at: Date | null;
  finished_at: Date | null;
  configuration: JobConfiguration;
  results_path: string | null;
  summary_path: string | null;
  checkpoint_offset: number | null;
  error_message: string | null;
}

export async function createJob(
  createdBy: string,
  filename: string,
  fileSize: number,
  filePath: string,
  mode: string,
  configuration: JobConfiguration
): Promise<string> {
  const result = await pool.query(
    `INSERT INTO jobs (created_by, filename, file_size, file_path, mode, configuration)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [createdBy, filename, fileSize, filePath, mode, JSON.stringify(configuration)]
  );
  return result.rows[0].id;
}

export async function getJob(id: string): Promise<JobRow | null> {
  const result = await pool.query('SELECT * FROM jobs WHERE id = $1', [id]);
  if (result.rows.length === 0) return null;
  return mapJobRow(result.rows[0]);
}

export async function listJobs(
  createdBy?: string,
  limit = 50,
  offset = 0
): Promise<JobRow[]> {
  let query = 'SELECT * FROM jobs';
  const params: any[] = [];
  
  if (createdBy) {
    query += ' WHERE created_by = $1';
    params.push(createdBy);
    query += ' ORDER BY created_at DESC LIMIT $2 OFFSET $3';
    params.push(limit, offset);
  } else {
    query += ' ORDER BY created_at DESC LIMIT $1 OFFSET $2';
    params.push(limit, offset);
  }
  
  const result = await pool.query(query, params);
  return result.rows.map(mapJobRow);
}

function mapJobRow(row: any): JobRow {
  return {
    ...row,
    configuration: typeof row.configuration === 'string' 
      ? JSON.parse(row.configuration) 
      : row.configuration,
    created_at: new Date(row.created_at),
    started_at: row.started_at ? new Date(row.started_at) : null,
    finished_at: row.finished_at ? new Date(row.finished_at) : null,
  };
}

export async function updateJobStatus(
  id: string,
  status: JobStatus,
  errorMessage?: string
): Promise<void> {
  await pool.query(
    'UPDATE jobs SET status = $1, error_message = $2 WHERE id = $3',
    [status, errorMessage || null, id]
  );
}

export async function updateJobProgress(
  id: string,
  progress: Partial<JobProgress>,
  checkpointOffset?: number | null
): Promise<void> {
  const updates: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  if (progress.total_rows_estimated !== undefined) {
    updates.push(`total_rows_estimated = $${paramIndex++}`);
    values.push(progress.total_rows_estimated);
  }
  if (progress.rows_processed !== undefined) {
    updates.push(`rows_processed = $${paramIndex++}`);
    values.push(progress.rows_processed);
  }
  if (progress.success_count !== undefined) {
    updates.push(`success_count = $${paramIndex++}`);
    values.push(progress.success_count);
  }
  if (progress.error_count !== undefined) {
    updates.push(`error_count = $${paramIndex++}`);
    values.push(progress.error_count);
  }
  if (progress.rate_limited_count !== undefined) {
    updates.push(`rate_limited_count = $${paramIndex++}`);
    values.push(progress.rate_limited_count);
  }
  if (checkpointOffset !== undefined) {
    updates.push(`checkpoint_offset = $${paramIndex++}`);
    values.push(checkpointOffset);
  }

  if (updates.length === 0) return;

  values.push(id);
  await pool.query(
    `UPDATE jobs SET ${updates.join(', ')} WHERE id = $${paramIndex}`,
    values
  );
}

export async function setJobStarted(id: string): Promise<void> {
  await pool.query(
    'UPDATE jobs SET status = $1, started_at = NOW() WHERE id = $2',
    ['RUNNING', id]
  );
}

export async function setJobFinished(id: string, status: JobStatus): Promise<void> {
  await pool.query(
    'UPDATE jobs SET status = $1, finished_at = NOW() WHERE id = $2',
    [status, id]
  );
}

export async function setJobResults(
  id: string,
  resultsPath: string,
  summaryPath: string
): Promise<void> {
  await pool.query(
    'UPDATE jobs SET results_path = $1, summary_path = $2 WHERE id = $3',
    [resultsPath, summaryPath, id]
  );
}

export async function addJobLog(
  jobId: string,
  level: 'info' | 'warn' | 'error',
  message: string,
  metadata?: Record<string, any>
): Promise<void> {
  await pool.query(
    `INSERT INTO job_logs (job_id, level, message, metadata)
     VALUES ($1, $2, $3, $4)`,
    [jobId, level, message, metadata ? JSON.stringify(metadata) : null]
  );
}

export async function getJobLogs(
  jobId: string,
  limit = 100
): Promise<JobLog[]> {
  const result = await pool.query(
    `SELECT * FROM job_logs
     WHERE job_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [jobId, limit]
  );
  return result.rows.map(row => ({
    ...row,
    metadata: typeof row.metadata === 'string' 
      ? JSON.parse(row.metadata) 
      : row.metadata,
    created_at: new Date(row.created_at),
  }));
}

export async function addJobError(
  jobId: string,
  rowNumber: number,
  rid: string | null,
  zone: string | null,
  space: string | null,
  errorType: string,
  errorMessage: string
): Promise<void> {
  await pool.query(
    `INSERT INTO job_errors (job_id, row_number, rid, zone, space, error_type, error_message)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [jobId, rowNumber, rid, zone, space, errorType, errorMessage]
  );
}

export async function getJobErrors(
  jobId: string,
  limit = 50
): Promise<any[]> {
  const result = await pool.query(
    `SELECT * FROM job_errors
     WHERE job_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [jobId, limit]
  );
  return result.rows;
}

export async function deleteJob(id: string): Promise<void> {
  await pool.query('DELETE FROM jobs WHERE id = $1', [id]);
  // Related records (job_logs, job_errors) are automatically deleted via CASCADE
}

export async function addAuditLog(
  userEmail: string,
  action: string,
  resourceType: string,
  resourceId?: string,
  metadata?: Record<string, any>
): Promise<void> {
  await pool.query(
    `INSERT INTO audit_logs (user_email, action, resource_type, resource_id, metadata)
     VALUES ($1, $2, $3, $4, $5)`,
    [userEmail, action, resourceType, resourceId || null, metadata ? JSON.stringify(metadata) : null]
  );
}
