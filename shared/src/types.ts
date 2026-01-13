export type JobMode = 'QUOTE_ONLY' | 'QUOTE_START_STOP';

export type JobStatus = 
  | 'QUEUED' 
  | 'RUNNING' 
  | 'PAUSED' 
  | 'CANCELLING' 
  | 'CANCELLED' 
  | 'FAILED' 
  | 'COMPLETED';

export interface JobProgress {
  total_rows_estimated: number | null;
  rows_processed: number;
  success_count: number;
  error_count: number;
  rate_limited_count: number;
}

export interface JobConfiguration {
  apiver: string;
  uid: string;
  cid: string;
  user_id: string;
  base_url: string;
  start_time_offset_hours: number;
  duration_hours: number;
  request_throttle_rps?: number;
  request_delay_ms?: number;
  retry_max_attempts: number;
  retry_backoff_ms: number;
  rate_limit_backoff_ms: number;
  max_runtime_hours?: number;
  max_errors_threshold?: number;
}

export interface Job {
  id: string;
  created_at: Date;
  created_by: string;
  filename: string;
  file_size: number;
  mode: JobMode;
  status: JobStatus;
  progress: JobProgress;
  started_at: Date | null;
  finished_at: Date | null;
  configuration: JobConfiguration;
  results_path: string | null;
  summary_path: string | null;
  checkpoint_offset: number | null;
}

export interface JobResultRow {
  job_id: string;
  row_number: number;
  rid: string | null;
  zone: string | null;
  space: string | null;
  mode: JobMode;
  start_time_utc: string;
  stop_time_utc: string;
  quote_status_code: number | null;
  quote_ok: boolean;
  quote_error: string | null;
  start_status_code: number | null;
  start_ok: boolean;
  payment_id: string | null;
  start_error: string | null;
  stop_status_code: number | null;
  stop_ok: boolean;
  stop_error: string | null;
  duration_ms: number;
  timestamp: string;
}

export interface JobSummary {
  job_id: string;
  total_rows: number;
  processed: number;
  successes: number;
  errors: number;
  rate_limited: number;
  started_at: string | null;
  finished_at: string | null;
  failure_reasons_topN: Array<{ reason: string; count: number }>;
}

export interface JobLog {
  id: string;
  job_id: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  metadata?: Record<string, any>;
  created_at: Date;
}

export interface CSVRow {
  rid?: string | null;
  zone?: string | null;
  space?: string | null;
  [key: string]: any;
}
