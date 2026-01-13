'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Job } from './types';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:3001';

export default function Home() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [selectedFileName, setSelectedFileName] = useState<string>('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [actionLoading, setActionLoading] = useState<Record<string, string>>({});

  useEffect(() => {
    loadJobs();
    const interval = setInterval(loadJobs, 5000); // Poll every 5s
    return () => clearInterval(interval);
  }, []);

  const loadJobs = async () => {
    try {
      const userEmail = localStorage.getItem('userEmail') || 'test@example.com';
      const response = await fetch(`${API_BASE}/api/jobs?userEmail=${encodeURIComponent(userEmail)}`, {
        headers: {
          'X-User-Email': userEmail,
        },
      });
      const data = await response.json();
      setJobs(data);
    } catch (error) {
      console.error('Failed to load jobs:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    setSelectedFile(file);
    setSelectedFileName(file ? file.name : '');
  };

  const handleFileUpload = async () => {
    if (!selectedFile) return;

    setUploading(true);
    const formData = new FormData();
    formData.append('file', selectedFile);
    
    const modeSelect = document.getElementById('mode') as HTMLSelectElement;
    const mode = modeSelect?.value || 'QUOTE_ONLY';
    formData.append('mode', mode);

    try {
      const userEmail = localStorage.getItem('userEmail') || 'test@example.com';
      const response = await fetch(`${API_BASE}/api/jobs`, {
        method: 'POST',
        headers: {
          'X-User-Email': userEmail,
        },
        body: formData,
      });

      if (!response.ok) {
        const error = await response.json();
        alert(`Upload failed: ${error.error}`);
        return;
      }

      await loadJobs();
      alert('File uploaded successfully!');
      setSelectedFile(null);
      setSelectedFileName('');
      const fileInput = document.getElementById('file-input') as HTMLInputElement;
      if (fileInput) {
        fileInput.value = '';
      }
    } catch (error: any) {
      alert(`Upload failed: ${error.message}`);
    } finally {
      setUploading(false);
    }
  };

  const handleJobAction = async (jobId: string, action: 'pause' | 'resume' | 'cancel' | 'delete') => {
    setActionLoading({ ...actionLoading, [jobId]: action });
    try {
      const userEmail = localStorage.getItem('userEmail') || 'test@example.com';
      const method = action === 'delete' ? 'DELETE' : 'POST';
      const endpoint = action === 'delete' ? '' : `/${action}`;
      
      const response = await fetch(`${API_BASE}/api/jobs/${jobId}${endpoint}`, {
        method,
        headers: {
          'X-User-Email': userEmail,
        },
      });

      if (!response.ok) {
        const error = await response.json();
        alert(`Action failed: ${error.error}`);
        return;
      }

      await loadJobs();
    } catch (error: any) {
      alert(`Action failed: ${error.message}`);
    } finally {
      const newLoading = { ...actionLoading };
      delete newLoading[jobId];
      setActionLoading(newLoading);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'COMPLETED': return 'bg-green-100 text-green-800';
      case 'RUNNING': return 'bg-blue-100 text-blue-800';
      case 'FAILED': return 'bg-red-100 text-red-800';
      case 'CANCELLED': return 'bg-gray-100 text-gray-800';
      case 'PAUSED': return 'bg-yellow-100 text-yellow-800';
      case 'QUEUED': return 'bg-purple-100 text-purple-800';
      default: return 'bg-gray-100 text-gray-800';
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  };

  return (
    <div className="min-h-screen p-8">
      <div className="max-w-7xl mx-auto">
        <h1 className="text-3xl font-bold mb-8">POI Testing - Parkopedia API Validator</h1>

        {/* Upload Section */}
        <div className="bg-white rounded-lg shadow p-6 mb-8">
          <h2 className="text-xl font-semibold mb-4">Upload CSV File</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-2">Mode:</label>
              <select
                id="mode"
                className="border border-gray-300 rounded px-3 py-2 w-full max-w-xs"
                defaultValue="QUOTE_ONLY"
              >
                <option value="QUOTE_ONLY">Quote Only</option>
                <option value="QUOTE_START_STOP">Quote + Start + Stop</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">CSV File (up to 1GB):</label>
              <div className="flex items-center gap-2">
                <label className="cursor-pointer">
                  <span className="inline-block px-4 py-2 text-sm font-semibold text-white bg-blue-600 rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed">
                    Choose File
                  </span>
                  <input
                    type="file"
                    accept=".csv"
                    onChange={handleFileChange}
                    disabled={uploading}
                    className="hidden"
                    id="file-input"
                  />
                </label>
                <span className="text-sm text-gray-600">
                  {selectedFileName || 'No file chosen'}
                </span>
                {selectedFile && !uploading && (
                  <button
                    onClick={handleFileUpload}
                    className="px-4 py-2 text-sm font-semibold text-white bg-green-600 rounded hover:bg-green-700"
                  >
                    Upload
                  </button>
                )}
              </div>
              {uploading && <p className="text-sm text-gray-600 mt-2">Uploading...</p>}
            </div>
          </div>
        </div>

        {/* Jobs Table */}
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200">
            <h2 className="text-xl font-semibold">Jobs</h2>
          </div>
          {loading ? (
            <div className="p-8 text-center text-gray-500">Loading...</div>
          ) : jobs.length === 0 ? (
            <div className="p-8 text-center text-gray-500">No jobs yet. Upload a CSV file to get started.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">ID</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Created</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Filename</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Mode</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Progress</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Counts</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Actions</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {jobs.map((job) => (
                    <tr key={job.id} className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-mono text-gray-600">
                        {job.id.substring(0, 8)}...
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {new Date(job.created_at).toLocaleString()}
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-900">{job.filename}</td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {job.mode === 'QUOTE_ONLY' ? 'Quote Only' : 'Quote+Start+Stop'}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className={`px-2 py-1 text-xs font-semibold rounded-full ${getStatusColor(job.status)}`}>
                          {job.status}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="w-32">
                          {job.percent_progress !== null ? (
                            <>
                              <div className="w-full bg-gray-200 rounded-full h-2 mb-1">
                                <div
                                  className="bg-blue-600 h-2 rounded-full"
                                  style={{ width: `${Math.min(100, job.percent_progress)}%` }}
                                />
                              </div>
                              <span className="text-xs text-gray-600">
                                {job.percent_progress.toFixed(1)}%
                              </span>
                            </>
                          ) : (
                            <span className="text-xs text-gray-500">
                              {job.progress.rows_processed} rows
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                        <div className="text-xs">
                          <div>✓ {job.progress.success_count}</div>
                          <div>✗ {job.progress.error_count}</div>
                          {job.progress.rate_limited_count > 0 && (
                            <div className="text-yellow-600">⚠ {job.progress.rate_limited_count}</div>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm">
                        <div className="flex items-center gap-2">
                          <Link
                            href={`/jobs/${job.id}`}
                            className="text-blue-600 hover:text-blue-800 font-medium"
                          >
                            View
                          </Link>
                          {job.status === 'RUNNING' && (
                            <button
                              onClick={() => handleJobAction(job.id, 'pause')}
                              disabled={actionLoading[job.id] === 'pause'}
                              className="text-yellow-600 hover:text-yellow-800 font-medium disabled:opacity-50"
                              title="Pause job"
                            >
                              {actionLoading[job.id] === 'pause' ? 'Pausing...' : 'Pause'}
                            </button>
                          )}
                          {job.status === 'PAUSED' && (
                            <button
                              onClick={() => handleJobAction(job.id, 'resume')}
                              disabled={actionLoading[job.id] === 'resume'}
                              className="text-blue-600 hover:text-blue-800 font-medium disabled:opacity-50"
                              title="Queue job at the back"
                            >
                              {actionLoading[job.id] === 'resume' ? 'Queuing...' : 'Queue'}
                            </button>
                          )}
                          {['QUEUED', 'RUNNING', 'PAUSED'].includes(job.status) && (
                            <button
                              onClick={() => {
                                if (confirm('Are you sure you want to cancel this job?')) {
                                  handleJobAction(job.id, 'cancel');
                                }
                              }}
                              disabled={actionLoading[job.id] === 'cancel'}
                              className="text-red-600 hover:text-red-800 font-medium disabled:opacity-50"
                              title="Cancel job"
                            >
                              {actionLoading[job.id] === 'cancel' ? 'Cancelling...' : 'Cancel'}
                            </button>
                          )}
                          {['CANCELLED', 'COMPLETED', 'FAILED'].includes(job.status) && (
                            <button
                              onClick={() => {
                                if (confirm('Are you sure you want to delete this job?')) {
                                  handleJobAction(job.id, 'delete');
                                }
                              }}
                              disabled={actionLoading[job.id] === 'delete'}
                              className="text-red-600 hover:text-red-800 font-medium disabled:opacity-50"
                              title="Delete job"
                            >
                              {actionLoading[job.id] === 'delete' ? 'Deleting...' : 'Delete'}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
