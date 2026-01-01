#!/bin/bash
# Create separate database for Langfuse to avoid schema conflicts
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE DATABASE langfuse;
    GRANT ALL PRIVILEGES ON DATABASE langfuse TO squads;
EOSQL

echo "Created langfuse database"
