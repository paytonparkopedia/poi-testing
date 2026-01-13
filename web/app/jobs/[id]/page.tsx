'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { JobDetail, JobLog, JobError } from '../../types';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:3001';

function getFixText(step: string, error: string): string {
  if (error.includes('rate limit') || error.includes('too many times')) {
    return 'Rate limit reached - wait and retry';
  }
  if (step === 'quote' && error.includes('Invalid')) {
    return 'Check mapping/payment config';
  }
  if (step === 'start' && error.includes('Missing')) {
    return 'Check session ID in response';
  }
  if (step === 'stop') {
    return 'Check vendor stop rules';
  }
  if (step === 'validation') {
    return 'Check CSV input format';
  }
  return 'Check API auth or input data';
}

export default function JobDetailPage() {
  const params = useParams();
  const router = useRouter();
  const jobId = params.id as string;
  const [job, setJob] = useState<JobDetail | null>(null);
  const [logs, setLogs] = useState<JobLog[]>([]);
  const [errors, setErrors] = useState<JobError[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 3000); // Poll every 3s
    return () => clearInterval(interval);
  }, [jobId]);

  const loadData = async () => {
    try {
      const userEmail = localStorage.getItem('userEmail') || 'test@example.com';
      const headers = { 'X-User-Email': userEmail };

      const [jobRes, logsRes, errorsRes] = await Promise.all([
        fetch(`${API_BASE}/api/jobs/${jobId}`, { headers }),
        fetch(`${API_BASE}/api/jobs/${jobId}/logs`, { headers }),
        fetch(`${API_BASE}/api/jobs/${jobId}/errors`, { headers }),
      ]);

      if (jobRes.ok) {
        const jobData = await jobRes.json();
        setJob(jobData);
      }
      if (logsRes.ok) {
        const logsData = await logsRes.json();
        setLogs(logsData);
      }
      if (errorsRes.ok) {
        const errorsData = await errorsRes.json();
        setErrors(errorsData);
      }
    } catch (error) {
      console.error('Failed to load job data:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleAction = async (action: 'pause' | 'resume' | 'cancel') => {
    setActionLoading(action);
    try {
      const userEmail = localStorage.getItem('userEmail') || 'test@example.com';
      const response = await fetch(`${API_BASE}/api/jobs/${jobId}/${action}`, {
        method: 'POST',
        headers: { 'X-User-Email': userEmail },
      });

      if (!response.ok) {
        const error = await response.json();
        alert(`Action failed: ${error.error}`);
        return;
      }

      await loadData();
    } catch (error: any) {
      alert(`Action failed: ${error.message}`);
    } finally {
      setActionLoading(null);
    }
  };

  const downloadResults = () => {
    const userEmail = localStorage.getItem('userEmail') || 'test@example.com';
    window.open(`${API_BASE}/api/jobs/${jobId}/results?userEmail=${encodeURIComponent(userEmail)}`, '_blank');
  };

  const downloadSummary = () => {
    const userEmail = localStorage.getItem('userEmail') || 'test@example.com';
    window.open(`${API_BASE}/api/jobs/${jobId}/summary?userEmail=${encodeURIComponent(userEmail)}`, '_blank');
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'COMPLETED': return 'bg-green-100 text-green-800';
      case 'RUNNING': return 'bg-blue-100 text-blue-800';
      case 'FAILED': return 'bg-red-100 text-red-800';
      case 'CANCELLED': return 'bg-gray-100 text-gray-800';
      case 'PAUSED': return 'bg-yellow-100 text-yellow-800';
      case 'CANCELLING': return 'bg-orange-100 text-orange-800';
      case 'QUEUED': return 'bg-purple-100 text-purple-800';
      default: return 'bg-gray-100 text-gray-800';
    }
  };

  if (loading && !job) {
    return <div className="p-8 text-center">Loading...</div>;
  }

  if (!job) {
    return <div className="p-8 text-center">Job not found</div>;
  }

  return (
    <div className="min-h-screen p-8">
      <div className="max-w-7xl mx-auto">
        <div className="mb-6">
          <Link href="/" className="text-blue-600 hover:text-blue-800">← Back to Jobs</Link>
        </div>

        <h1 className="text-3xl font-bold mb-8">Job Details</h1>

        {/* Job Info Card */}
        <div className="bg-white rounded-lg shadow p-6 mb-6">
          <div className="grid grid-cols-2 gap-4 mb-4">
            <div>
              <label className="text-sm font-medium text-gray-500">Job ID</label>
              <p className="text-sm font-mono">{job.id}</p>
            </div>
            <div>
              <label className="text-sm font-medium text-gray-500">Status</label>
              <p>
                <span className={`px-2 py-1 text-xs font-semibold rounded-full ${getStatusColor(job.status)}`}>
                  {job.status}
                </span>
              </p>
            </div>
            <div>
              <label className="text-sm font-medium text-gray-500">Filename</label>
              <p className="text-sm">{job.filename}</p>
            </div>
            <div>
              <label className="text-sm font-medium text-gray-500">Mode</label>
              <p className="text-sm">{job.mode === 'QUOTE_ONLY' ? 'Quote Only' : 'Quote + Start + Stop'}</p>
            </div>
            <div>
              <label className="text-sm font-medium text-gray-500">Created</label>
              <p className="text-sm">{new Date(job.created_at).toLocaleString()}</p>
            </div>
            <div>
              <label className="text-sm font-medium text-gray-500">Created By</label>
              <p className="text-sm">{job.created_by}</p>
            </div>
            {job.started_at && (
              <div>
                <label className="text-sm font-medium text-gray-500">Started</label>
                <p className="text-sm">{new Date(job.started_at).toLocaleString()}</p>
              </div>
            )}
            {job.finished_at && (
              <div>
                <label className="text-sm font-medium text-gray-500">Finished</label>
                <p className="text-sm">{new Date(job.finished_at).toLocaleString()}</p>
              </div>
            )}
          </div>

          {job.error_message && (
            <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded">
              <p className="text-sm text-red-800">{job.error_message}</p>
            </div>
          )}

          {/* Progress */}
          <div className="mt-6">
            <div className="flex justify-between mb-2">
              <label className="text-sm font-medium text-gray-700">Progress</label>
              <span className="text-sm text-gray-600">
                {job.percent_progress !== null
                  ? `${job.percent_progress.toFixed(1)}%`
                  : `${job.progress?.rows_processed || 0} rows processed`}
              </span>
            </div>
            {job.percent_progress !== null && (
              <div className="w-full bg-gray-200 rounded-full h-4">
                <div
                  className="bg-blue-600 h-4 rounded-full transition-all"
                  style={{ width: `${Math.min(100, job.percent_progress)}%` }}
                />
              </div>
            )}
            {job.progress && (
              <>
                <div className="mt-2 grid grid-cols-4 gap-4 text-sm">
                  <div>
                    <span className="text-gray-500">Total:</span>{' '}
                    <span className="font-medium">{job.progress.total_rows_estimated || 'Unknown'}</span>
                  </div>
                  <div>
                    <span className="text-gray-500">Processed:</span>{' '}
                    <span className="font-medium">{job.progress.rows_processed || 0}</span>
                  </div>
                  <div>
                    <span className="text-gray-500">Success:</span>{' '}
                    <span className="font-medium text-green-600">{job.progress.success_count || 0}</span>
                  </div>
                  <div>
                    <span className="text-gray-500">Errors:</span>{' '}
                    <span className="font-medium text-red-600">{job.progress.error_count || 0}</span>
                  </div>
                </div>
                {(job.progress.rate_limited_count || 0) > 0 && (
                  <div className="mt-2 text-sm text-yellow-600">
                    Rate Limited: {job.progress.rate_limited_count}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Actions */}
          <div className="mt-6 flex gap-2">
            {job.status === 'RUNNING' && (
              <button
                onClick={() => handleAction('pause')}
                disabled={actionLoading === 'pause'}
                className="px-4 py-2 bg-yellow-600 text-white rounded hover:bg-yellow-700 disabled:opacity-50"
              >
                {actionLoading === 'pause' ? 'Pausing...' : 'Pause'}
              </button>
            )}
            {job.status === 'PAUSED' && (
              <button
                onClick={() => handleAction('resume')}
                disabled={actionLoading === 'resume'}
                className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              >
                {actionLoading === 'resume' ? 'Resuming...' : 'Resume'}
              </button>
            )}
            {['QUEUED', 'RUNNING', 'PAUSED'].includes(job.status) && (
              <button
                onClick={() => handleAction('cancel')}
                disabled={actionLoading === 'cancel'}
                className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
              >
                {actionLoading === 'cancel' ? 'Cancelling...' : 'Cancel'}
              </button>
            )}
            {job.results_path && (
              <button
                onClick={downloadResults}
                className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700"
              >
                Download Results
              </button>
            )}
            {job.summary_path && (
              <button
                onClick={downloadSummary}
                className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700"
              >
                Download Summary
              </button>
            )}
          </div>
        </div>

        {/* Recent Errors */}
        {errors.length > 0 && (
          <div className="bg-white rounded-lg shadow p-6 mb-6">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-semibold">Errors ({errors.length})</h2>
              <button
                onClick={() => {
                  // Generate CSV
                  const headers = ['Timestamp', 'RID/Zone', 'Space', 'Step', 'Error', 'Fix'];
                  const rows = errors.map(e => [
                    new Date(e.created_at).toISOString(),
                    e.rid || e.zone || '',
                    e.space || '',
                    e.error_type || '',
                    e.error_message || '',
                    getFixText(e.error_type || '', e.error_message || '')
                  ]);
                  const csv = [headers, ...rows].map(row => 
                    row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')
                  ).join('\n');
                  
                  // Download
                  const blob = new Blob([csv], { type: 'text/csv' });
                  const url = window.URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `job-${jobId}-errors.csv`;
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                  window.URL.revokeObjectURL(url);
                }}
                className="px-4 py-2 text-sm font-semibold text-white bg-blue-600 rounded hover:bg-blue-700"
              >
                Download CSV
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">Timestamp</th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">RID/Zone</th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">Space</th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">Step</th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">Error</th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">Fix</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {errors.map((error) => (
                    <tr key={error.id}>
                      <td className="px-4 py-2 text-sm">{new Date(error.created_at).toLocaleString()}</td>
                      <td className="px-4 py-2 text-sm font-mono text-gray-600">{error.rid || error.zone || '-'}</td>
                      <td className="px-4 py-2 text-sm font-mono text-gray-600">{error.space || '-'}</td>
                      <td className="px-4 py-2 text-sm">{error.error_type || '-'}</td>
                      <td className="px-4 py-2 text-sm text-red-600">{error.error_message}</td>
                      <td className="px-4 py-2 text-sm text-gray-500">{getFixText(error.error_type || '', error.error_message || '')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Logs */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-xl font-semibold mb-4">Logs (Last 100)</h2>
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {logs.map((log) => (
              <div
                key={log.id}
                className={`text-sm p-2 rounded ${
                  log.level === 'error' ? 'bg-red-50 text-red-800' :
                  log.level === 'warn' ? 'bg-yellow-50 text-yellow-800' :
                  'bg-gray-50 text-gray-800'
                }`}
              >
                <span className="text-xs text-gray-500">
                  {new Date(log.created_at).toLocaleString()}
                </span>
                {' '}
                <span className="font-medium">[{log.level.toUpperCase()}]</span>
                {' '}
                {log.message}
                {log.metadata && (
                  <pre className="mt-1 text-xs opacity-75">
                    {JSON.stringify(log.metadata, null, 2)}
                  </pre>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
