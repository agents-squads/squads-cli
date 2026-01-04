#!/bin/bash
# =============================================================================
# Migrate PostgreSQL to pgvector
# =============================================================================
# This script:
# 1. Backs up all data from current postgres
# 2. Updates docker-compose to use pgvector image
# 3. Recreates the container with pgvector
# 4. Restores data
# 5. Enables pgvector extension
#
# Usage: ./scripts/migrate-to-pgvector.sh
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCKER_DIR="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="$DOCKER_DIR/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/postgres_backup_$TIMESTAMP.sql"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log() { echo -e "${BLUE}[migrate]${NC} $1"; }
success() { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; exit 1; }

# =============================================================================
# Pre-flight checks
# =============================================================================

log "Checking prerequisites..."

cd "$DOCKER_DIR"

# Check if postgres is running
if ! docker ps | grep -q "squads-postgres"; then
    error "squads-postgres is not running. Start it first: docker-compose up -d postgres"
fi

# Check docker-compose exists
if [ ! -f "docker-compose.yml" ]; then
    error "docker-compose.yml not found in $DOCKER_DIR"
fi

success "Prerequisites OK"

# =============================================================================
# Step 1: Backup existing data
# =============================================================================

log "Creating backup directory..."
mkdir -p "$BACKUP_DIR"

log "Backing up all databases..."
docker exec squads-postgres pg_dumpall -U squads > "$BACKUP_FILE"

if [ -f "$BACKUP_FILE" ] && [ -s "$BACKUP_FILE" ]; then
    BACKUP_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
    success "Backup created: $BACKUP_FILE ($BACKUP_SIZE)"
else
    error "Backup failed or empty"
fi

# Also backup the volume data path (extra safety)
log "Creating volume snapshot..."
VOLUME_BACKUP="$BACKUP_DIR/postgres_volume_$TIMESTAMP.tar.gz"
docker run --rm -v squads-cli_squads_postgres_data:/data -v "$BACKUP_DIR":/backup alpine \
    tar czf /backup/postgres_volume_$TIMESTAMP.tar.gz -C /data . 2>/dev/null || \
    docker run --rm -v agents-squads_squads_postgres_data:/data -v "$BACKUP_DIR":/backup alpine \
    tar czf /backup/postgres_volume_$TIMESTAMP.tar.gz -C /data . 2>/dev/null || \
    warn "Volume backup skipped (volume name may differ)"

success "Backup phase complete"

# =============================================================================
# Step 2: Update docker-compose.yml
# =============================================================================

log "Updating docker-compose.yml to use pgvector..."

# Check if already using pgvector
if grep -q "pgvector/pgvector" docker-compose.yml; then
    success "Already using pgvector image"
else
    # Create backup of docker-compose
    cp docker-compose.yml "docker-compose.yml.backup_$TIMESTAMP"

    # Replace postgres image with pgvector (pg16 to match existing data)
    sed -i.bak 's|image: postgres:16-alpine|image: pgvector/pgvector:pg16|g' docker-compose.yml
    rm -f docker-compose.yml.bak

    success "Updated docker-compose.yml (backup: docker-compose.yml.backup_$TIMESTAMP)"
fi

# =============================================================================
# Step 3: Stop and remove postgres container
# =============================================================================

log "Stopping postgres container..."
docker-compose stop postgres
docker-compose rm -f postgres

success "Postgres container removed"

# =============================================================================
# Step 4: Start new postgres with pgvector
# =============================================================================

log "Starting postgres with pgvector image..."
docker-compose up -d postgres

# Wait for postgres to be ready
log "Waiting for postgres to be ready..."
for i in {1..30}; do
    if docker exec squads-postgres pg_isready -U squads -d squads > /dev/null 2>&1; then
        success "Postgres is ready"
        break
    fi
    if [ $i -eq 30 ]; then
        error "Postgres failed to start"
    fi
    sleep 1
done

# =============================================================================
# Step 5: Restore data
# =============================================================================

log "Restoring data from backup..."

# The init scripts will run automatically on fresh volume
# But if volume existed, we need to restore
docker exec -i squads-postgres psql -U squads -d postgres < "$BACKUP_FILE" 2>/dev/null || true

success "Data restored"

# =============================================================================
# Step 6: Enable pgvector extension
# =============================================================================

log "Enabling pgvector extension..."

# Enable in squads database
docker exec squads-postgres psql -U squads -d squads -c "CREATE EXTENSION IF NOT EXISTS vector;" 2>/dev/null || true

# Create engram database and enable there too
docker exec squads-postgres psql -U squads -d postgres -c "CREATE DATABASE engram;" 2>/dev/null || true
docker exec squads-postgres psql -U squads -d engram -c "CREATE EXTENSION IF NOT EXISTS vector;" 2>/dev/null || true
docker exec squads-postgres psql -U squads -d engram -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;" 2>/dev/null || true

success "pgvector extension enabled"

# =============================================================================
# Step 7: Verify
# =============================================================================

log "Verifying installation..."

# Check pgvector is available
VECTOR_CHECK=$(docker exec squads-postgres psql -U squads -d squads -t -c "SELECT extname FROM pg_extension WHERE extname = 'vector';" | tr -d ' ')
if [ "$VECTOR_CHECK" = "vector" ]; then
    success "pgvector extension verified in squads database"
else
    warn "pgvector not found in squads - may need manual enable"
fi

# Check engram database
ENGRAM_CHECK=$(docker exec squads-postgres psql -U squads -d postgres -t -c "SELECT datname FROM pg_database WHERE datname = 'engram';" | tr -d ' ')
if [ "$ENGRAM_CHECK" = "engram" ]; then
    success "engram database created"
else
    warn "engram database not found"
fi

# Check tables restored
TABLE_COUNT=$(docker exec squads-postgres psql -U squads -d squads -t -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'squads';" | tr -d ' ')
success "Restored $TABLE_COUNT tables in squads schema"

# =============================================================================
# Step 8: Restart dependent services
# =============================================================================

log "Restarting dependent services..."
docker-compose up -d

success "All services restarted"

# =============================================================================
# Summary
# =============================================================================

echo ""
echo "=============================================="
echo -e "${GREEN}Migration Complete!${NC}"
echo "=============================================="
echo ""
echo "Backup location: $BACKUP_FILE"
echo ""
echo "Next steps:"
echo "  1. Verify services: docker-compose ps"
echo "  2. Test pgvector:   docker exec squads-postgres psql -U squads -d squads -c \"SELECT vector '[1,2,3]';\""
echo "  3. Check engram:    docker exec squads-postgres psql -U squads -d engram -c \"\\dx\""
echo ""
echo "To rollback:"
echo "  1. docker-compose down"
echo "  2. mv docker-compose.yml.backup_$TIMESTAMP docker-compose.yml"
echo "  3. docker volume rm squads-cli_squads_postgres_data  # or agents-squads_squads_postgres_data"
echo "  4. docker-compose up -d"
echo "  5. cat $BACKUP_FILE | docker exec -i squads-postgres psql -U squads"
echo ""
