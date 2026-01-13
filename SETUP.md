# Setup Instructions

## Option 1: Using Docker (Recommended)

1. **Start Docker Desktop**
   - Open Docker Desktop application
   - Wait until it shows "Docker is running"

2. **Start services**
   ```bash
   docker-compose up -d postgres redis
   ```

3. **Install dependencies and run**
   ```bash
   npm install
   npm run dev
   ```

## Option 2: Local Installation (No Docker)

### Install PostgreSQL

**macOS (using Homebrew):**
```bash
brew install postgresql@15
brew services start postgresql@15
createdb poi_testing
```

**Or download from:** https://www.postgresql.org/download/

### Install Redis

**macOS (using Homebrew):**
```bash
brew install redis
brew services start redis
```

**Or download from:** https://redis.io/download

### Verify Services

```bash
# Check PostgreSQL
psql -U postgres -d poi_testing -c "SELECT version();"

# Check Redis
redis-cli ping
# Should return: PONG
```

### Run the Application

```bash
# Install dependencies
npm install

# In separate terminals, run:
npm run dev --workspace=server
npm run dev --workspace=worker
npm run dev --workspace=web
```

## Troubleshooting

### Docker not starting?
- Make sure Docker Desktop is installed and running
- Check system requirements for Docker Desktop
- Try restarting Docker Desktop

### PostgreSQL connection issues?
- Verify PostgreSQL is running: `brew services list` (macOS) or `systemctl status postgresql` (Linux)
- Check if port 5432 is available: `lsof -i :5432`
- Verify credentials in `.env` match your PostgreSQL setup

### Redis connection issues?
- Verify Redis is running: `brew services list` (macOS) or `systemctl status redis` (Linux)
- Check if port 6379 is available: `lsof -i :6379`
- Test connection: `redis-cli ping`
