# POI Testing - Parkopedia API Validator

Internal web application for validating Parkopedia API endpoints at scale. Processes large CSV files (up to 1GB, 1M+ rows) and runs API checks in two modes:

- **Mode A (Quote Only)**: Validates `paymentsquotes` endpoint
- **Mode B (Quote + Start + Stop)**: Validates `paymentsquotes`, `payments` POST, and `payments/{id}` DELETE endpoints

## Features

- ✅ Streaming CSV upload (up to 1GB)
- ✅ Persistent job queue with BullMQ + Redis
- ✅ Sequential row processing with pause/resume/cancel support
- ✅ Progress tracking and real-time updates
- ✅ Retry logic with exponential backoff
- ✅ Rate limiting detection and handling
- ✅ Results stored as NDJSON + summary JSON
- ✅ Clean dashboard UI with job management
- ✅ ID cleaning (removes commas from rid/zone/space)

## Architecture

- **Server** (`/server`): Fastify API server with file upload and job management
- **Worker** (`/worker`): BullMQ worker that processes jobs from queue
- **Web** (`/web`): Next.js frontend with React
- **Shared** (`/shared`): Shared TypeScript types and utilities

## Prerequisites

- Node.js 20+
- PostgreSQL 15+
- Redis 7+
- Docker & Docker Compose (optional, for containerized setup)

## Quick Start

### 1. Clone and Install

```bash
git clone <repo-url>
cd poi-testing
npm install
```

### 2. Set Up Environment Variables

Copy `.env.example` to `.env` and fill in your API credentials:

```bash
cp .env.example .env
```

**Required variables:**
- `API_APIVER`, `API_UID`, `API_CID`, `API_USER_ID`
- `API_BASE_URL`
- `API_CLIENT_ID`, `API_CLIENT_SECRET`
- `API_USERNAME`, `API_PASSWORD`

### 3. Start Services (Docker Compose)

```bash
docker-compose up -d postgres redis
```

Wait for services to be healthy, then:

```bash
# In separate terminals:
npm run dev --workspace=server
npm run dev --workspace=worker
npm run dev --workspace=web
```

Or use Docker Compose for everything:

```bash
docker-compose up
```

### 4. Initialize Database

The database schema is automatically initialized on server start. If you need to manually initialize:

```bash
cd server
npm run migrate
```

### 5. Access the Application

- **Web UI**: http://localhost:3000
- **API Server**: http://localhost:3001

## CSV Format

Your CSV file should have headers with at least one of:
- `rid` or `location_id` (required if zone not present)
- `zone` or `parking_payment_zone_id` (required if rid not present)
- `space` or `location_space_id` (optional)

Example:
```csv
rid,zone,space
12345,,
,67890,
12345,,A1
```

**Note**: Commas in ID values are automatically removed during processing.

## Job Processing

### Job States

- `QUEUED`: Job is waiting to be processed
- `RUNNING`: Job is actively processing rows
- `PAUSED`: Job is paused (can be resumed)
- `CANCELLING`: Job is being cancelled
- `CANCELLED`: Job was cancelled
- `FAILED`: Job failed with an error
- `COMPLETED`: Job finished successfully

### Pause/Resume

Jobs can be paused at any time. The worker will finish processing the current row and save a checkpoint. When resumed, processing continues from the checkpoint.

### Cancel

Cancelling a job sets it to `CANCELLING` status. The worker will stop as soon as it safely can and mark the job as `CANCELLED`.

## API Endpoints

### Jobs

- `POST /api/jobs` - Upload CSV and create job
- `GET /api/jobs` - List jobs (filtered by user)
- `GET /api/jobs/:id` - Get job details
- `POST /api/jobs/:id/pause` - Pause job
- `POST /api/jobs/:id/resume` - Resume job
- `POST /api/jobs/:id/cancel` - Cancel job
- `DELETE /api/jobs/:id` - Remove job (soft delete)
- `GET /api/jobs/:id/logs` - Get job logs
- `GET /api/jobs/:id/errors` - Get recent errors
- `GET /api/jobs/:id/results` - Download results (NDJSON)
- `GET /api/jobs/:id/summary` - Download summary (JSON)

### Health

- `GET /health` - Health check

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DB_HOST` | PostgreSQL host | `localhost` |
| `DB_PORT` | PostgreSQL port | `5432` |
| `DB_NAME` | Database name | `poi_testing` |
| `REDIS_HOST` | Redis host | `localhost` |
| `REDIS_PORT` | Redis port | `6379` |
| `WORKER_CONCURRENCY` | Number of concurrent workers | `1` |
| `START_TIME_OFFSET_HOURS` | Hours to add to current time for start_time_utc | `8` |
| `DURATION_HOURS` | Session duration in hours | `24` |
| `RETRY_MAX_ATTEMPTS` | Max retries for failed requests | `2` |
| `RETRY_BACKOFF_MS` | Base backoff delay in ms | `1000` |
| `RATE_LIMIT_BACKOFF_MS` | Backoff delay for rate limits | `60000` |
| `REQUEST_DELAY_MS` | Delay between requests (throttling) | (none) |
| `STORAGE_TYPE` | Storage backend (`local` or `s3`) | `local` |
| `STORAGE_BASE_DIR` | Base directory for local storage | `./storage` |

## Results Format

### Results File (NDJSON)

Each line is a JSON object with:
```json
{
  "job_id": "uuid",
  "row_number": 1,
  "rid": "12345",
  "zone": null,
  "space": null,
  "mode": "QUOTE_ONLY",
  "start_time_utc": "2024-01-01T12:00:00Z",
  "stop_time_utc": "2024-01-02T12:00:00Z",
  "quote_status_code": 200,
  "quote_ok": true,
  "quote_error": null,
  "start_status_code": null,
  "start_ok": false,
  "payment_id": null,
  "start_error": null,
  "stop_status_code": null,
  "stop_ok": false,
  "stop_error": null,
  "duration_ms": 150,
  "timestamp": "2024-01-01T10:00:00Z"
}
```

### Summary File (JSON)

```json
{
  "job_id": "uuid",
  "total_rows": 1000,
  "processed": 1000,
  "successes": 950,
  "errors": 50,
  "rate_limited": 5,
  "started_at": "2024-01-01T10:00:00Z",
  "finished_at": "2024-01-01T10:30:00Z",
  "failure_reasons_topN": [
    { "reason": "HTTP 404", "count": 30 },
    { "reason": "HTTP 500", "count": 20 }
  ]
}
```

## Development

### Project Structure

```
poi-testing/
├── server/          # Fastify API server
│   ├── src/
│   │   ├── db/      # Database schema and queries
│   │   ├── storage/ # Storage abstraction (local/S3)
│   │   └── index.ts  # API routes
├── worker/          # BullMQ worker
│   └── src/
│       └── index.ts # Job processor
├── web/             # Next.js frontend
│   └── app/         # Pages and components
└── shared/          # Shared types and utilities
```

### Running Locally

```bash
# Install dependencies
npm install

# Start services
docker-compose up -d postgres redis

# Run in development mode (3 terminals)
npm run dev --workspace=server
npm run dev --workspace=worker
npm run dev --workspace=web
```

### Building

```bash
npm run build
```

## Security

- **Never commit `.env` files** - Use `.env.example` as template
- **Secrets**: All API credentials must be in environment variables
- **Auth**: Currently uses header-based auth (`X-User-Email`). Replace with real SSO/OIDC for production
- **RBAC**: Admin role check via `X-User-Role` header (stub implementation)

## Production Deployment

1. **Storage**: Switch to S3 by setting `STORAGE_TYPE=s3` and configuring AWS credentials
2. **Database**: Use managed PostgreSQL (RDS, Cloud SQL, etc.)
3. **Redis**: Use managed Redis (ElastiCache, Memorystore, etc.)
4. **Auth**: Implement real SSO/OIDC authentication
5. **Scaling**: Increase `WORKER_CONCURRENCY` or run multiple worker instances
6. **Monitoring**: Add logging, metrics, and alerting

## Troubleshooting

### Job stuck in QUEUED

- Check worker is running: `docker-compose ps worker`
- Check Redis connection: `redis-cli ping`
- Check worker logs: `docker-compose logs worker`

### Job fails immediately

- Check API credentials in `.env`
- Verify token endpoint is accessible
- Check server logs for errors

### Memory issues with large files

- Ensure streaming is working (check worker logs)
- Verify file is being streamed, not loaded into memory
- Check `STORAGE_BASE_DIR` has enough disk space

## License

Internal use only.
