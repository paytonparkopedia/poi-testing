export interface Job {
  id: string;
  created_at: string;
  created_by: string;
  filename: string;
  file_size: number;
  mode: 'QUOTE_ONLY' | 'QUOTE_START_STOP';
  status: string;
  progress: {
    total_rows_estimated: number | null;
    rows_processed: number;
    success_count: number;
    error_count: number;
    rate_limited_count: number;
  };
  started_at: string | null;
  finished_at: string | null;
  percent_progress: number | null;
}

export interface JobDetail extends Job {
  configuration: any;
  results_path: string | null;
  summary_path: string | null;
  checkpoint_offset: number | null;
  error_message: string | null;
}

export interface JobLog {
  id: string;
  job_id: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  metadata?: Record<string, any>;
  created_at: string;
}

export interface JobError {
  id: string;
  job_id: string;
  row_number: number;
  rid: string | null;
  zone: string | null;
  space: string | null;
  error_type: string;
  error_message: string;
  created_at: string;
}
