"""
Squads Telemetry Bridge
Receives OpenTelemetry metrics/logs from Claude Code.
Saves to PostgreSQL (durable), Redis (real-time), Langfuse (optional).
Forwards conversations to engram/mem0 for embeddings and graph storage.
"""
import os
import json
import gzip
import threading
import time
import requests
from datetime import datetime, date
from collections import deque
from flask import Flask, request, jsonify
import psycopg2
from psycopg2.extras import RealDictCursor
import redis

app = Flask(__name__)

# Configuration
DEBUG_MODE = os.environ.get("DEBUG", "1") == "1"
LANGFUSE_ENABLED = os.environ.get("LANGFUSE_ENABLED", "false").lower() == "true"
DAILY_BUDGET = float(os.environ.get("SQUADS_DAILY_BUDGET", "200.0"))
recent_logs = deque(maxlen=50)

# Engram/mem0 configuration for memory extraction
ENGRAM_URL = os.environ.get("ENGRAM_URL", "http://host.docker.internal:8000")
ENGRAM_ENABLED = os.environ.get("ENGRAM_ENABLED", "false").lower() == "true"
ENGRAM_USER_ID = os.environ.get("ENGRAM_USER_ID", "local")

# PostgreSQL connection (durable storage)
DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql://squads:squads_local_dev@postgres:5432/squads"
)

# Redis connection (real-time cache)
REDIS_URL = os.environ.get("REDIS_URL", "redis://redis:6379/0")
redis_client = None
try:
    redis_client = redis.from_url(REDIS_URL, decode_responses=True)
    redis_client.ping()
    print(f"Redis connected: {REDIS_URL}")
except Exception as e:
    print(f"Redis unavailable (degraded mode): {e}")
    redis_client = None

def get_db():
    """Get database connection."""
    return psycopg2.connect(DATABASE_URL)


# =============================================================================
# Redis Keys & Helpers
# =============================================================================
def redis_key(prefix: str, *parts) -> str:
    """Build Redis key: prefix:part1:part2:..."""
    return ":".join([prefix] + [str(p) for p in parts])

def today_str() -> str:
    """Get today's date as string for Redis keys."""
    return date.today().isoformat()

def incr_cost(squad: str, cost_usd: float, input_tokens: int, output_tokens: int):
    """Increment real-time cost counters in Redis."""
    if not redis_client:
        return

    today = today_str()
    pipe = redis_client.pipeline()

    # Global daily counters
    pipe.incrbyfloat(redis_key("cost", "daily", today), cost_usd)
    pipe.incrby(redis_key("tokens", "input", today), input_tokens)
    pipe.incrby(redis_key("tokens", "output", today), output_tokens)
    pipe.incr(redis_key("generations", today))

    # Per-squad counters
    pipe.incrbyfloat(redis_key("cost", "squad", squad, today), cost_usd)
    pipe.incrby(redis_key("generations", "squad", squad, today), 1)

    # Set expiry (48h) for all keys
    for key in [
        redis_key("cost", "daily", today),
        redis_key("tokens", "input", today),
        redis_key("tokens", "output", today),
        redis_key("generations", today),
        redis_key("cost", "squad", squad, today),
        redis_key("generations", "squad", squad, today),
    ]:
        pipe.expire(key, 172800)  # 48 hours

    pipe.execute()

def get_realtime_stats() -> dict:
    """Get real-time stats from Redis (fast path)."""
    if not redis_client:
        return None

    today = today_str()
    try:
        cost = float(redis_client.get(redis_key("cost", "daily", today)) or 0)
        input_tokens = int(redis_client.get(redis_key("tokens", "input", today)) or 0)
        output_tokens = int(redis_client.get(redis_key("tokens", "output", today)) or 0)
        generations = int(redis_client.get(redis_key("generations", today)) or 0)

        # Get per-squad costs
        squad_keys = redis_client.keys(redis_key("cost", "squad", "*", today))
        by_squad = []
        for key in squad_keys:
            parts = key.split(":")
            squad_name = parts[2] if len(parts) > 2 else "unknown"
            squad_cost = float(redis_client.get(key) or 0)
            squad_gens = int(redis_client.get(redis_key("generations", "squad", squad_name, today)) or 0)
            by_squad.append({
                "squad": squad_name,
                "cost_usd": squad_cost,
                "generations": squad_gens,
            })

        by_squad.sort(key=lambda x: x["cost_usd"], reverse=True)

        return {
            "cost_usd": cost,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "generations": generations,
            "by_squad": by_squad,
            "budget_remaining": DAILY_BUDGET - cost,
            "budget_pct": (cost / DAILY_BUDGET) * 100 if DAILY_BUDGET > 0 else 0,
        }
    except Exception as e:
        print(f"Redis stats error: {e}")
        return None

def cache_session(session_id: str, squad: str, agent: str):
    """Cache session info in Redis for fast lookups."""
    if not redis_client:
        return

    key = redis_key("session", session_id)
    redis_client.hset(key, mapping={"squad": squad, "agent": agent, "last_seen": datetime.now().isoformat()})
    redis_client.expire(key, 86400)  # 24h

def get_cached_session(session_id: str) -> dict | None:
    """Get cached session from Redis."""
    if not redis_client:
        return None

    key = redis_key("session", session_id)
    data = redis_client.hgetall(key)
    return data if data else None


# =============================================================================
# Conversation Buffer (Redis -> Postgres + Engram)
# =============================================================================
CONV_BUFFER_KEY = "conversations:pending"
CONV_RECENT_KEY = "conversations:recent"

def buffer_conversation(conv_data: dict):
    """Push conversation to Redis buffer for async processing."""
    if not redis_client:
        return False

    try:
        # Add to pending queue
        redis_client.lpush(CONV_BUFFER_KEY, json.dumps(conv_data))

        # Also add to recent (circular buffer of last 100)
        redis_client.lpush(CONV_RECENT_KEY, json.dumps(conv_data))
        redis_client.ltrim(CONV_RECENT_KEY, 0, 99)

        if DEBUG_MODE:
            print(f"[BUFFER] Queued conversation: {conv_data.get('role')} - {len(conv_data.get('content', ''))} chars")
        return True
    except Exception as e:
        print(f"[BUFFER] Error: {e}")
        return False

def forward_to_engram(conv_data: dict) -> bool:
    """Forward conversation to engram/mem0 for extraction."""
    if not ENGRAM_ENABLED:
        return False

    try:
        # Format for mem0 API
        payload = {
            "messages": [{"role": conv_data.get("role", "user"), "content": conv_data.get("content", "")}],
            "user_id": conv_data.get("user_id", ENGRAM_USER_ID),
            "metadata": {
                "session_id": conv_data.get("session_id", ""),
                "type": conv_data.get("message_type", "message"),
                "importance": conv_data.get("importance", "normal"),
                "source": "squads-bridge",
            }
        }

        response = requests.post(
            f"{ENGRAM_URL}/memories",
            json=payload,
            timeout=30
        )

        if response.ok:
            if DEBUG_MODE:
                print(f"[ENGRAM] Forwarded: {conv_data.get('role')} -> mem0")
            return True
        else:
            print(f"[ENGRAM] Error {response.status_code}: {response.text[:100]}")
            return False

    except requests.exceptions.ConnectionError:
        if DEBUG_MODE:
            print(f"[ENGRAM] Not available at {ENGRAM_URL}")
        return False
    except Exception as e:
        print(f"[ENGRAM] Error: {e}")
        return False

def process_conversation_queue():
    """Background worker to process conversation buffer."""
    print("[WORKER] Conversation processor started")

    while True:
        try:
            if not redis_client:
                time.sleep(5)
                continue

            # Block-pop from queue (timeout 5s)
            result = redis_client.brpop(CONV_BUFFER_KEY, timeout=5)
            if not result:
                continue

            _, conv_json = result
            conv_data = json.loads(conv_json)

            # 1. Save to local postgres (for CLI search)
            try:
                conn = get_db()
                save_conversation(
                    conn,
                    conv_data.get("session_id", ""),
                    conv_data.get("user_id", "local"),
                    conv_data.get("role", "user"),
                    conv_data.get("content", ""),
                    conv_data.get("message_type", "message"),
                    conv_data.get("importance", "normal"),
                    conv_data.get("metadata", {})
                )
                conn.commit()
                conn.close()
                if DEBUG_MODE:
                    print(f"[WORKER] Saved to postgres")
            except Exception as e:
                print(f"[WORKER] Postgres error: {e}")

            # 2. Forward to engram/mem0 (for vectors + graph)
            if ENGRAM_ENABLED:
                forward_to_engram(conv_data)

        except Exception as e:
            print(f"[WORKER] Error: {e}")
            time.sleep(1)

# Start background worker thread
conv_worker_thread = None

def start_conversation_worker():
    """Start the background conversation processor."""
    global conv_worker_thread
    if conv_worker_thread is None or not conv_worker_thread.is_alive():
        conv_worker_thread = threading.Thread(target=process_conversation_queue, daemon=True)
        conv_worker_thread.start()
        print("[WORKER] Background thread started")


# Optional Langfuse client
langfuse = None
if LANGFUSE_ENABLED:
    try:
        from langfuse import Langfuse
        langfuse = Langfuse(
            public_key=os.environ.get("LANGFUSE_PUBLIC_KEY"),
            secret_key=os.environ.get("LANGFUSE_SECRET_KEY"),
            host=os.environ.get("LANGFUSE_HOST", "https://cloud.langfuse.com"),
        )
        print(f"Langfuse forwarding enabled: {os.environ.get('LANGFUSE_HOST')}")
    except Exception as e:
        print(f"Langfuse initialization failed: {e}")
        langfuse = None


def get_json_data():
    """Get JSON data, handling gzip compression if present."""
    raw_data = request.get_data()

    if raw_data[:2] == b'\x1f\x8b':
        try:
            raw_data = gzip.decompress(raw_data)
        except Exception as e:
            print(f"Gzip decompress error: {e}")
            return {}

    try:
        return json.loads(raw_data)
    except json.JSONDecodeError as e:
        print(f"JSON decode error: {e}")
        return {}


def extract_attributes(attrs_list):
    """Extract attributes from OTel attribute list format."""
    result = {}
    for attr in attrs_list:
        key = attr.get("key", "")
        val = attr.get("value", {})
        value = (
            val.get("stringValue") or
            val.get("intValue") or
            val.get("doubleValue") or
            val.get("boolValue") or
            ""
        )
        result[key] = value
    return result


def safe_int(val, default=0):
    """Safely convert to int."""
    try:
        return int(val) if val else default
    except (ValueError, TypeError):
        return default


def safe_float(val, default=0.0):
    """Safely convert to float."""
    try:
        return float(val) if val else default
    except (ValueError, TypeError):
        return default


def extract_token_data(attrs):
    """Extract token counts from OTel attributes (handles multiple formats)."""
    input_keys = [
        "input_tokens", "usage.input_tokens", "prompt_tokens",
        "usage.prompt_tokens", "inputTokens", "promptTokens",
        "llm.usage.prompt_tokens", "gen_ai.usage.input_tokens"
    ]
    output_keys = [
        "output_tokens", "usage.output_tokens", "completion_tokens",
        "usage.completion_tokens", "outputTokens", "completionTokens",
        "llm.usage.completion_tokens", "gen_ai.usage.output_tokens"
    ]
    cache_read_keys = [
        "cache_read_tokens", "cache_read", "cacheReadTokens",
        "usage.cache_read_tokens", "cache_read_input_tokens"
    ]
    cache_creation_keys = [
        "cache_creation_tokens", "cache_creation", "cacheCreationTokens",
        "usage.cache_creation_tokens", "cache_creation_input_tokens"
    ]
    cost_keys = [
        "cost_usd", "cost", "total_cost", "usage.cost",
        "llm.usage.cost", "gen_ai.usage.cost"
    ]

    def find_value(keys, default=0):
        for key in keys:
            if key in attrs and attrs[key]:
                return attrs[key]
        return default

    return {
        "input_tokens": safe_int(find_value(input_keys)),
        "output_tokens": safe_int(find_value(output_keys)),
        "cache_read": safe_int(find_value(cache_read_keys)),
        "cache_creation": safe_int(find_value(cache_creation_keys)),
        "cost_usd": safe_float(find_value(cost_keys, 0.0)),
    }


def ensure_session(conn, session_id, squad, agent, user_id):
    """Create or update session record."""
    with conn.cursor() as cur:
        cur.execute("""
            INSERT INTO squads.sessions (id, squad, agent, user_id, last_activity_at)
            VALUES (%s, %s, %s, %s, NOW())
            ON CONFLICT (id) DO UPDATE SET
                last_activity_at = NOW(),
                squad = COALESCE(EXCLUDED.squad, squads.sessions.squad),
                agent = COALESCE(EXCLUDED.agent, squads.sessions.agent)
        """, (session_id, squad, agent, user_id or None))


def save_generation(conn, session_id, squad, agent, user_id, model, token_data):
    """Save LLM generation to postgres + Redis."""
    with conn.cursor() as cur:
        cur.execute("""
            INSERT INTO squads.llm_generations
                (session_id, squad, agent, user_id, model,
                 input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id
        """, (
            session_id, squad, agent, user_id or None, model,
            token_data["input_tokens"], token_data["output_tokens"],
            token_data["cache_read"], token_data["cache_creation"],
            token_data["cost_usd"]
        ))
        gen_id = cur.fetchone()[0]

        # Update session aggregates
        cur.execute("""
            UPDATE squads.sessions SET
                total_input_tokens = total_input_tokens + %s,
                total_output_tokens = total_output_tokens + %s,
                total_cost_usd = total_cost_usd + %s,
                generation_count = generation_count + 1,
                last_activity_at = NOW()
            WHERE id = %s
        """, (
            token_data["input_tokens"], token_data["output_tokens"],
            token_data["cost_usd"], session_id
        ))

    # Update Redis real-time counters
    incr_cost(squad, token_data["cost_usd"], token_data["input_tokens"], token_data["output_tokens"])
    cache_session(session_id, squad, agent)

    return gen_id


def save_tool_execution(conn, session_id, squad, agent, tool_name, success, duration_ms):
    """Save tool execution to postgres."""
    with conn.cursor() as cur:
        cur.execute("""
            INSERT INTO squads.tool_executions
                (session_id, squad, agent, tool_name, success, duration_ms)
            VALUES (%s, %s, %s, %s, %s, %s)
            RETURNING id
        """, (session_id, squad, agent, tool_name, success, duration_ms))
        tool_id = cur.fetchone()[0]

        # Update session tool count
        cur.execute("""
            UPDATE squads.sessions SET
                tool_count = tool_count + 1,
                last_activity_at = NOW()
            WHERE id = %s
        """, (session_id,))

        return tool_id


@app.route("/v1/metrics", methods=["POST"])
def receive_metrics():
    """Receive OTel metrics - acknowledge for now."""
    try:
        get_json_data()
        return jsonify({"status": "ok"}), 200
    except Exception as e:
        print(f"Error processing metrics: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/v1/logs", methods=["POST"])
def receive_logs():
    """Receive OTel logs - save to postgres, optionally forward to Langfuse."""
    try:
        data = get_json_data()
        conn = get_db()

        for resource_log in data.get("resourceLogs", []):
            resource_attrs = extract_attributes(
                resource_log.get("resource", {}).get("attributes", [])
            )

            service_name = resource_attrs.get("service.name", "claude-code")

            # Detect squad/agent context
            squad_name = (
                resource_attrs.get("squad") or
                resource_attrs.get("squads.squad") or
                os.environ.get("SQUADS_SQUAD") or
                "hq"
            )
            agent_name = (
                resource_attrs.get("agent") or
                resource_attrs.get("squads.agent") or
                os.environ.get("SQUADS_AGENT") or
                "coo"
            )

            for scope_log in resource_log.get("scopeLogs", []):
                for log_record in scope_log.get("logRecords", []):
                    log_attrs = extract_attributes(log_record.get("attributes", []))

                    event_name = log_attrs.get("event.name", "unknown")
                    session_id = log_attrs.get("session.id", "unknown")
                    user_id = log_attrs.get("user.id", "")

                    # Debug logging
                    if DEBUG_MODE:
                        recent_logs.append({
                            "timestamp": datetime.now().isoformat(),
                            "event_name": event_name,
                            "log_attrs": dict(log_attrs),
                            "resource_attrs": dict(resource_attrs),
                        })
                        if event_name == "api_request":
                            print(f"[DEBUG] api_request: session={session_id} squad={squad_name} agent={agent_name}")

                    # Ensure session exists
                    ensure_session(conn, session_id, squad_name, agent_name, user_id)

                    # Handle LLM API requests
                    if event_name == "api_request":
                        model = log_attrs.get("model", "claude")
                        token_data = extract_token_data(log_attrs)

                        # Save to postgres (primary)
                        gen_id = save_generation(
                            conn, session_id, squad_name, agent_name,
                            user_id, model, token_data
                        )
                        print(f"[PG] Generation #{gen_id}: {model} {token_data['input_tokens']}+{token_data['output_tokens']} tokens ${token_data['cost_usd']:.4f}")

                        # Forward to Langfuse (optional)
                        if langfuse:
                            try:
                                trace = langfuse.trace(
                                    name=f"llm:{model}",
                                    user_id=user_id or None,
                                    session_id=session_id,
                                    metadata={
                                        "squad": squad_name,
                                        "agent": agent_name,
                                        "service": service_name,
                                    },
                                )
                                trace.generation(
                                    name=f"llm:{model}",
                                    model=model,
                                    usage={
                                        "input": token_data["input_tokens"],
                                        "output": token_data["output_tokens"],
                                        "total": token_data["input_tokens"] + token_data["output_tokens"],
                                    },
                                    metadata={
                                        "cache_read": token_data["cache_read"],
                                        "cache_creation": token_data["cache_creation"],
                                        "cost_usd": token_data["cost_usd"],
                                    },
                                )
                            except Exception as e:
                                print(f"[Langfuse] Forward error: {e}")

                    # Handle tool results
                    elif event_name == "tool_result":
                        tool_name = log_attrs.get("tool_name", "unknown")
                        duration_ms = safe_int(log_attrs.get("duration_ms", 0))
                        success = log_attrs.get("success", "true") in ["true", True, "1"]

                        # Save to postgres (primary)
                        tool_id = save_tool_execution(
                            conn, session_id, squad_name, agent_name,
                            tool_name, success, duration_ms
                        )

                        # Only log non-trivial tools
                        if tool_name not in ["Read", "Glob", "Grep"]:
                            print(f"[PG] Tool #{tool_id}: {tool_name} success={success}")

                        # Forward to Langfuse (optional)
                        if langfuse:
                            try:
                                trace = langfuse.trace(
                                    name=f"tool:{tool_name}",
                                    session_id=session_id,
                                    metadata={
                                        "squad": squad_name,
                                        "agent": agent_name,
                                    },
                                )
                                trace.span(
                                    name=f"tool:{tool_name}",
                                    metadata={
                                        "tool_name": tool_name,
                                        "success": success,
                                        "duration_ms": duration_ms,
                                    },
                                )
                            except Exception as e:
                                print(f"[Langfuse] Forward error: {e}")

        conn.commit()
        conn.close()

        if langfuse:
            langfuse.flush()

        return jsonify({"status": "ok"}), 200

    except Exception as e:
        import traceback
        print(f"Error processing logs: {e}")
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/health", methods=["GET"])
def health():
    """Health check endpoint."""
    status = {"status": "healthy"}

    # Check Postgres
    try:
        conn = get_db()
        with conn.cursor() as cur:
            cur.execute("SELECT 1")
        conn.close()
        status["postgres"] = "connected"
    except Exception as e:
        status["postgres"] = f"error: {e}"
        status["status"] = "degraded"

    # Check Redis
    if redis_client:
        try:
            redis_client.ping()
            status["redis"] = "connected"
        except Exception as e:
            status["redis"] = f"error: {e}"
            status["status"] = "degraded"
    else:
        status["redis"] = "disabled"

    status["langfuse"] = "enabled" if langfuse else "disabled"

    return jsonify(status), 200 if status["status"] == "healthy" else 503


@app.route("/stats", methods=["GET"])
def stats():
    """Get telemetry statistics - Redis (fast) or Postgres (fallback)."""
    # Try Redis first (real-time, fast)
    realtime = get_realtime_stats()
    if realtime:
        return jsonify({
            "status": "running",
            "source": "redis",
            "today": {
                "generations": realtime["generations"],
                "input_tokens": realtime["input_tokens"],
                "output_tokens": realtime["output_tokens"],
                "cost_usd": realtime["cost_usd"],
            },
            "budget": {
                "daily": DAILY_BUDGET,
                "used": realtime["cost_usd"],
                "remaining": realtime["budget_remaining"],
                "used_pct": realtime["budget_pct"],
            },
            "by_squad": realtime["by_squad"],
            "langfuse_enabled": langfuse is not None,
            "redis_enabled": True,
        }), 200

    # Fallback to Postgres
    try:
        conn = get_db()
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            # Session count
            cur.execute("SELECT COUNT(*) as count FROM squads.sessions")
            sessions = cur.fetchone()["count"]

            # Today's generations
            cur.execute("""
                SELECT
                    COUNT(*) as count,
                    COALESCE(SUM(input_tokens), 0) as input_tokens,
                    COALESCE(SUM(output_tokens), 0) as output_tokens,
                    COALESCE(SUM(cost_usd), 0) as cost_usd
                FROM squads.llm_generations
                WHERE created_at >= CURRENT_DATE
            """)
            today = cur.fetchone()

            # By squad (today)
            cur.execute("""
                SELECT
                    squad,
                    COUNT(*) as generations,
                    COALESCE(SUM(cost_usd), 0) as cost_usd
                FROM squads.llm_generations
                WHERE created_at >= CURRENT_DATE
                GROUP BY squad
                ORDER BY cost_usd DESC
            """)
            by_squad = cur.fetchall()

        conn.close()
        cost_usd = float(today["cost_usd"])

        return jsonify({
            "status": "running",
            "source": "postgres",
            "sessions": sessions,
            "today": {
                "generations": today["count"],
                "input_tokens": today["input_tokens"],
                "output_tokens": today["output_tokens"],
                "cost_usd": cost_usd,
            },
            "budget": {
                "daily": DAILY_BUDGET,
                "used": cost_usd,
                "remaining": DAILY_BUDGET - cost_usd,
                "used_pct": (cost_usd / DAILY_BUDGET) * 100 if DAILY_BUDGET > 0 else 0,
            },
            "by_squad": [dict(r) for r in by_squad],
            "langfuse_enabled": langfuse is not None,
            "redis_enabled": False,
        }), 200

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/cost/summary", methods=["GET"])
def cost_summary():
    """Get cost summary for dashboard (replaces Langfuse MCP calls)."""
    try:
        period = request.args.get("period", "day")
        squad = request.args.get("squad")

        conn = get_db()
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            # Determine time filter
            if period == "day":
                time_filter = "created_at >= CURRENT_DATE"
            elif period == "week":
                time_filter = "created_at >= CURRENT_DATE - INTERVAL '7 days'"
            else:  # month
                time_filter = "created_at >= CURRENT_DATE - INTERVAL '30 days'"

            # Squad filter
            squad_filter = f"AND squad = '{squad}'" if squad else ""

            # Aggregated stats
            cur.execute(f"""
                SELECT
                    COUNT(*) as generation_count,
                    COALESCE(SUM(input_tokens), 0) as input_tokens,
                    COALESCE(SUM(output_tokens), 0) as output_tokens,
                    COALESCE(SUM(cost_usd), 0) as total_cost_usd
                FROM squads.llm_generations
                WHERE {time_filter} {squad_filter}
            """)
            totals = cur.fetchone()

            # By squad
            cur.execute(f"""
                SELECT
                    squad,
                    COUNT(*) as generations,
                    COALESCE(SUM(input_tokens), 0) as input_tokens,
                    COALESCE(SUM(output_tokens), 0) as output_tokens,
                    COALESCE(SUM(cost_usd), 0) as cost_usd
                FROM squads.llm_generations
                WHERE {time_filter}
                GROUP BY squad
                ORDER BY cost_usd DESC
            """)
            by_squad = cur.fetchall()

            # By model
            cur.execute(f"""
                SELECT
                    model,
                    COUNT(*) as generations,
                    COALESCE(SUM(cost_usd), 0) as cost_usd
                FROM squads.llm_generations
                WHERE {time_filter} {squad_filter}
                GROUP BY model
                ORDER BY cost_usd DESC
            """)
            by_model = cur.fetchall()

        conn.close()

        return jsonify({
            "period": period,
            "squad_filter": squad,
            "totals": {
                "generations": totals["generation_count"],
                "input_tokens": totals["input_tokens"],
                "output_tokens": totals["output_tokens"],
                "cost_usd": float(totals["total_cost_usd"]),
            },
            "by_squad": [{
                "squad": r["squad"],
                "generations": r["generations"],
                "input_tokens": r["input_tokens"],
                "output_tokens": r["output_tokens"],
                "cost_usd": float(r["cost_usd"]),
            } for r in by_squad],
            "by_model": [{
                "model": r["model"],
                "generations": r["generations"],
                "cost_usd": float(r["cost_usd"]),
            } for r in by_model],
        }), 200

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/rate-limits", methods=["GET"])
def get_rate_limits():
    """Get current rate limits from Redis (captured by anthropic proxy)."""
    if not redis_client:
        return jsonify({"error": "Redis not available", "source": "none"}), 503

    try:
        # Get all rate limit keys
        keys = redis_client.keys("ratelimit:latest:*")
        limits = {}

        for key in keys:
            family = key.split(":")[-1]
            data = redis_client.get(key)
            if data:
                limits[family] = json.loads(data)

        return jsonify({
            "rate_limits": limits,
            "source": "redis",
            "fetched_at": datetime.now().isoformat(),
        }), 200

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/telemetry", methods=["POST"])
def receive_cli_telemetry():
    """Receive anonymous CLI telemetry events."""
    try:
        data = request.get_json()
        if not data:
            return jsonify({"error": "No JSON data"}), 400

        events = data.get("events", [data])  # Support single event or batch

        conn = get_db()
        with conn.cursor() as cur:
            for event in events:
                cur.execute("""
                    INSERT INTO squads.cli_events
                        (anonymous_id, event_name, cli_version, properties)
                    VALUES (%s, %s, %s, %s)
                """, (
                    event.get("properties", {}).get("anonymousId", ""),
                    event.get("event", "unknown"),
                    event.get("properties", {}).get("cliVersion", "unknown"),
                    json.dumps(event.get("properties", {})),
                ))

        conn.commit()
        conn.close()

        return jsonify({
            "status": "ok",
            "received": len(events),
        }), 200

    except Exception as e:
        if DEBUG_MODE:
            print(f"[TELEMETRY] Error: {e}")
        return jsonify({"error": str(e)}), 500


# =============================================================================
# Conversations API - Captures from engram hook
# =============================================================================

def save_conversation(conn, session_id, user_id, role, content, message_type, importance, metadata):
    """Save conversation message to postgres."""
    with conn.cursor() as cur:
        cur.execute("""
            INSERT INTO squads.conversations
                (session_id, user_id, role, content, message_type, importance, metadata)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            RETURNING id
        """, (
            session_id, user_id or 'local', role, content,
            message_type, importance, json.dumps(metadata or {})
        ))
        return cur.fetchone()[0]


@app.route("/api/conversations", methods=["POST"])
def receive_conversation():
    """Receive conversation capture from engram hook.

    Fast path: Buffer to Redis, return immediately.
    Background worker saves to Postgres and forwards to engram/mem0.

    Supports two formats:
    1. Direct format (new): {session_id, user_id, role, content, message_type, importance, metadata}
    2. Legacy format (mem0): {messages: [{role, content}], user_id, metadata: {session_id, type, importance}}
    """
    try:
        data = request.get_json()
        if not data:
            return jsonify({"error": "No JSON data"}), 400

        queued = 0

        # Check for direct format (has content field at top level)
        if "content" in data:
            # Direct format from updated engram hook
            content = data.get("content", "")
            if content and len(content) >= 5:
                conv_data = {
                    "session_id": data.get("session_id", ""),
                    "user_id": data.get("user_id", "local"),
                    "role": data.get("role", "user"),
                    "content": content,
                    "message_type": data.get("message_type", "message"),
                    "importance": data.get("importance", "normal"),
                    "metadata": data.get("metadata", {}),
                }
                if data.get("working_dir"):
                    conv_data["metadata"]["working_dir"] = data.get("working_dir")

                if buffer_conversation(conv_data):
                    queued += 1
        else:
            # Legacy format (mem0 compatible)
            messages = data.get("messages", [])
            user_id = data.get("user_id", "local")
            metadata = data.get("metadata", {})
            session_id = metadata.get("session_id", "")
            message_type = metadata.get("type", "message")
            importance = metadata.get("importance", "normal")

            for msg in messages:
                role = msg.get("role", "user")
                content = msg.get("content", "")

                if not content or len(content) < 5:
                    continue

                conv_data = {
                    "session_id": session_id,
                    "user_id": user_id,
                    "role": role,
                    "content": content,
                    "message_type": message_type,
                    "importance": importance,
                    "metadata": metadata,
                }

                if buffer_conversation(conv_data):
                    queued += 1

        return jsonify({
            "status": "ok",
            "queued": queued,
        }), 200

    except Exception as e:
        import traceback
        print(f"Error saving conversation: {e}")
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/conversations/search", methods=["GET"])
def search_conversations():
    """Full-text search over conversations."""
    try:
        query = request.args.get("q", "")
        limit = min(int(request.args.get("limit", 20)), 100)
        user_id = request.args.get("user_id")
        message_type = request.args.get("type")

        if not query:
            return jsonify({"error": "Query parameter 'q' required"}), 400

        conn = get_db()
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            # Build WHERE clause
            conditions = ["to_tsvector('english', content) @@ plainto_tsquery('english', %s)"]
            params = [query]

            if user_id:
                conditions.append("user_id = %s")
                params.append(user_id)

            if message_type:
                conditions.append("message_type = %s")
                params.append(message_type)

            where_clause = " AND ".join(conditions)
            params.append(limit)

            cur.execute(f"""
                SELECT
                    id, session_id, user_id, role, content,
                    message_type, importance, created_at,
                    ts_rank(to_tsvector('english', content), plainto_tsquery('english', %s)) as rank
                FROM squads.conversations
                WHERE {where_clause}
                ORDER BY rank DESC, created_at DESC
                LIMIT %s
            """, [query] + params)

            results = cur.fetchall()

        conn.close()

        return jsonify({
            "query": query,
            "count": len(results),
            "results": [{
                "id": r["id"],
                "session_id": r["session_id"],
                "role": r["role"],
                "content": r["content"][:500] + "..." if len(r["content"]) > 500 else r["content"],
                "type": r["message_type"],
                "importance": r["importance"],
                "created_at": r["created_at"].isoformat() if r["created_at"] else None,
                "rank": float(r["rank"]),
            } for r in results],
        }), 200

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/conversations/recent", methods=["GET"])
def recent_conversations():
    """Get recent conversations (for debugging/review)."""
    try:
        limit = min(int(request.args.get("limit", 20)), 100)
        user_id = request.args.get("user_id")

        conn = get_db()
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            if user_id:
                cur.execute("""
                    SELECT id, session_id, user_id, role, content, message_type, importance, created_at
                    FROM squads.conversations
                    WHERE user_id = %s
                    ORDER BY created_at DESC
                    LIMIT %s
                """, (user_id, limit))
            else:
                cur.execute("""
                    SELECT id, session_id, user_id, role, content, message_type, importance, created_at
                    FROM squads.conversations
                    ORDER BY created_at DESC
                    LIMIT %s
                """, (limit,))

            results = cur.fetchall()

        conn.close()

        return jsonify({
            "count": len(results),
            "conversations": [{
                "id": r["id"],
                "session_id": r["session_id"],
                "role": r["role"],
                "content": r["content"][:300] + "..." if len(r["content"]) > 300 else r["content"],
                "type": r["message_type"],
                "importance": r["importance"],
                "created_at": r["created_at"].isoformat() if r["created_at"] else None,
            } for r in results],
        }), 200

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/debug/logs", methods=["GET"])
def debug_logs():
    """Get recent log attributes for debugging."""
    if not DEBUG_MODE:
        return jsonify({"error": "Debug mode disabled"}), 403
    return jsonify({
        "debug_mode": True,
        "recent_logs": list(recent_logs),
        "count": len(recent_logs),
    }), 200


# =============================================================================
# Task Tracking API - Track task completion, retries, quality
# =============================================================================

@app.route("/api/tasks", methods=["POST"])
def create_or_update_task():
    """Create or update a task."""
    try:
        data = request.get_json()
        if not data:
            return jsonify({"error": "No JSON data"}), 400

        task_id = data.get("task_id")
        if not task_id:
            return jsonify({"error": "task_id required"}), 400

        conn = get_db()
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            # Check if task exists
            cur.execute("SELECT id, retry_count FROM squads.tasks WHERE task_id = %s", (task_id,))
            existing = cur.fetchone()

            if existing:
                # Update existing task
                retry_count = existing["retry_count"]
                if data.get("status") == "started" and data.get("is_retry"):
                    retry_count += 1

                cur.execute("""
                    UPDATE squads.tasks SET
                        status = COALESCE(%s, status),
                        success = COALESCE(%s, success),
                        retry_count = %s,
                        output_type = COALESCE(%s, output_type),
                        output_ref = COALESCE(%s, output_ref),
                        total_tokens = COALESCE(%s, total_tokens),
                        total_cost_usd = COALESCE(%s, total_cost_usd),
                        peak_context_tokens = GREATEST(peak_context_tokens, COALESCE(%s, 0)),
                        context_utilization_pct = GREATEST(context_utilization_pct, COALESCE(%s, 0)),
                        completed_at = CASE WHEN %s IN ('completed', 'failed', 'cancelled') THEN NOW() ELSE completed_at END,
                        duration_ms = CASE WHEN %s IN ('completed', 'failed', 'cancelled')
                            THEN EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000 ELSE duration_ms END,
                        metadata = metadata || %s::jsonb
                    WHERE task_id = %s
                    RETURNING *
                """, (
                    data.get("status"),
                    data.get("success"),
                    retry_count,
                    data.get("output_type"),
                    data.get("output_ref"),
                    data.get("total_tokens"),
                    data.get("total_cost_usd"),
                    data.get("peak_context_tokens"),
                    data.get("context_utilization_pct"),
                    data.get("status"),
                    data.get("status"),
                    json.dumps(data.get("metadata", {})),
                    task_id,
                ))
                result = cur.fetchone()
                action = "updated"
            else:
                # Create new task
                cur.execute("""
                    INSERT INTO squads.tasks
                        (task_id, session_id, squad, agent, task_type, description,
                         status, output_type, output_ref, total_tokens, total_cost_usd,
                         peak_context_tokens, context_utilization_pct, metadata)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    RETURNING *
                """, (
                    task_id,
                    data.get("session_id"),
                    data.get("squad", "hq"),
                    data.get("agent"),
                    data.get("task_type", "goal"),
                    data.get("description"),
                    data.get("status", "started"),
                    data.get("output_type"),
                    data.get("output_ref"),
                    data.get("total_tokens", 0),
                    data.get("total_cost_usd", 0),
                    data.get("peak_context_tokens", 0),
                    data.get("context_utilization_pct"),
                    json.dumps(data.get("metadata", {})),
                ))
                result = cur.fetchone()
                action = "created"

        conn.commit()
        conn.close()

        return jsonify({
            "status": "ok",
            "action": action,
            "task": {
                "task_id": result["task_id"],
                "squad": result["squad"],
                "status": result["status"],
                "retry_count": result["retry_count"],
            }
        }), 200

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/tasks/<task_id>/feedback", methods=["POST"])
def add_task_feedback(task_id):
    """Add feedback for a task."""
    try:
        data = request.get_json()
        if not data:
            return jsonify({"error": "No JSON data"}), 400

        conn = get_db()
        with conn.cursor() as cur:
            # Verify task exists
            cur.execute("SELECT id FROM squads.tasks WHERE task_id = %s", (task_id,))
            if not cur.fetchone():
                conn.close()
                return jsonify({"error": f"Task {task_id} not found"}), 404

            # Insert feedback
            tags = data.get("tags", [])
            cur.execute("""
                INSERT INTO squads.task_feedback
                    (task_id, quality_score, was_helpful, required_fixes, fix_description, tags, notes)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                RETURNING id
            """, (
                task_id,
                data.get("quality_score"),
                data.get("was_helpful"),
                data.get("required_fixes", False),
                data.get("fix_description"),
                tags if tags else None,
                data.get("notes"),
            ))
            feedback_id = cur.fetchone()[0]

        conn.commit()
        conn.close()

        return jsonify({
            "status": "ok",
            "feedback_id": feedback_id,
        }), 200

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/insights", methods=["GET"])
def get_insights():
    """Get aggregated insights for dashboard."""
    try:
        squad = request.args.get("squad")
        period = request.args.get("period", "week")  # day, week, month
        days = {"day": 1, "week": 7, "month": 30}.get(period, 7)

        conn = get_db()
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            # Squad filter
            squad_filter = "AND t.squad = %s" if squad else ""
            params = [days, squad] if squad else [days]

            # Task completion metrics
            cur.execute(f"""
                SELECT
                    COALESCE(t.squad, 'all') as squad,
                    COUNT(*) as tasks_total,
                    COUNT(*) FILTER (WHERE t.status = 'completed') as tasks_completed,
                    COUNT(*) FILTER (WHERE t.status = 'failed') as tasks_failed,
                    COUNT(*) FILTER (WHERE t.success = true) as tasks_successful,
                    ROUND(100.0 * COUNT(*) FILTER (WHERE t.success = true) / NULLIF(COUNT(*), 0), 1) as success_rate,
                    SUM(t.retry_count) as total_retries,
                    COUNT(*) FILTER (WHERE t.retry_count > 0) as tasks_with_retries,
                    ROUND(AVG(t.retry_count)::numeric, 2) as avg_retries,
                    ROUND(AVG(t.duration_ms)::numeric, 0) as avg_duration_ms,
                    ROUND(AVG(t.total_tokens)::numeric, 0) as avg_tokens,
                    ROUND(AVG(t.total_cost_usd)::numeric, 4) as avg_cost,
                    ROUND(AVG(t.context_utilization_pct)::numeric, 1) as avg_context_pct,
                    MAX(t.peak_context_tokens) as max_context_tokens
                FROM squads.tasks t
                WHERE t.started_at >= NOW() - INTERVAL '%s days' {squad_filter}
                GROUP BY t.squad
                ORDER BY tasks_total DESC
            """, params)
            task_metrics = cur.fetchall()

            # Quality metrics from feedback
            cur.execute(f"""
                SELECT
                    COALESCE(t.squad, 'all') as squad,
                    COUNT(f.id) as feedback_count,
                    ROUND(AVG(f.quality_score)::numeric, 2) as avg_quality,
                    ROUND(100.0 * COUNT(*) FILTER (WHERE f.was_helpful = true) / NULLIF(COUNT(*), 0), 1) as helpful_pct,
                    ROUND(100.0 * COUNT(*) FILTER (WHERE f.required_fixes = true) / NULLIF(COUNT(*), 0), 1) as fix_required_pct
                FROM squads.tasks t
                LEFT JOIN squads.task_feedback f ON t.task_id = f.task_id
                WHERE t.started_at >= NOW() - INTERVAL '%s days' {squad_filter}
                    AND f.id IS NOT NULL
                GROUP BY t.squad
            """, params)
            quality_metrics = cur.fetchall()

            # Tool usage metrics
            cur.execute(f"""
                SELECT
                    tool_name,
                    COUNT(*) as usage_count,
                    ROUND(100.0 * COUNT(*) FILTER (WHERE success = true) / NULLIF(COUNT(*), 0), 1) as success_rate,
                    ROUND(AVG(duration_ms)::numeric, 0) as avg_duration_ms
                FROM squads.tool_executions
                WHERE created_at >= NOW() - INTERVAL '%s days'
                GROUP BY tool_name
                ORDER BY usage_count DESC
                LIMIT 15
            """, [days])
            top_tools = cur.fetchall()

            # Overall tool failure rate
            cur.execute("""
                SELECT
                    ROUND(100.0 * COUNT(*) FILTER (WHERE success = false) / NULLIF(COUNT(*), 0), 1) as failure_rate
                FROM squads.tool_executions
                WHERE created_at >= NOW() - INTERVAL '%s days'
            """, [days])
            tool_failure = cur.fetchone()

            # Session efficiency
            cur.execute(f"""
                SELECT
                    COALESCE(squad, 'all') as squad,
                    COUNT(*) as sessions,
                    ROUND(AVG(total_cost_usd)::numeric, 4) as avg_session_cost,
                    ROUND(AVG(generation_count)::numeric, 1) as avg_generations,
                    ROUND(AVG(tool_count)::numeric, 1) as avg_tools
                FROM squads.sessions
                WHERE started_at >= NOW() - INTERVAL '%s days' {squad_filter.replace('t.', '')}
                GROUP BY squad
            """, params)
            session_metrics = cur.fetchall()

        conn.close()

        return jsonify({
            "period": period,
            "days": days,
            "squad_filter": squad,
            "task_metrics": [dict(r) for r in task_metrics],
            "quality_metrics": [dict(r) for r in quality_metrics],
            "top_tools": [dict(r) for r in top_tools],
            "tool_failure_rate": float(tool_failure["failure_rate"] or 0) if tool_failure else 0,
            "session_metrics": [dict(r) for r in session_metrics],
        }), 200

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/insights/compute", methods=["POST"])
def compute_insights():
    """Compute and cache insights into agent_insights table."""
    try:
        period = request.args.get("period", "day")  # day, week, month

        conn = get_db()
        with conn.cursor() as cur:
            # Compute for each squad
            cur.execute("""
                INSERT INTO squads.agent_insights
                    (period, period_start, squad, agent,
                     tasks_started, tasks_completed, tasks_failed, success_rate,
                     total_retries, avg_retries_per_task, tasks_with_retries,
                     avg_quality_score, feedback_count, helpful_pct, fix_required_pct,
                     avg_duration_ms, avg_tokens_per_task, avg_cost_per_task, avg_context_utilization,
                     top_tools, tool_failure_rate)
                SELECT
                    %s as period,
                    CURRENT_DATE as period_start,
                    t.squad,
                    t.agent,
                    COUNT(*) as tasks_started,
                    COUNT(*) FILTER (WHERE t.status = 'completed') as tasks_completed,
                    COUNT(*) FILTER (WHERE t.status = 'failed') as tasks_failed,
                    ROUND(100.0 * COUNT(*) FILTER (WHERE t.success = true) / NULLIF(COUNT(*), 0), 2),
                    SUM(t.retry_count),
                    ROUND(AVG(t.retry_count)::numeric, 2),
                    COUNT(*) FILTER (WHERE t.retry_count > 0),
                    (SELECT ROUND(AVG(f.quality_score)::numeric, 2) FROM squads.task_feedback f WHERE f.task_id = ANY(ARRAY_AGG(t.task_id))),
                    (SELECT COUNT(*) FROM squads.task_feedback f WHERE f.task_id = ANY(ARRAY_AGG(t.task_id))),
                    NULL, NULL,
                    ROUND(AVG(t.duration_ms)::numeric, 0),
                    ROUND(AVG(t.total_tokens)::numeric, 0),
                    ROUND(AVG(t.total_cost_usd)::numeric, 6),
                    ROUND(AVG(t.context_utilization_pct)::numeric, 2),
                    '[]'::jsonb,
                    NULL
                FROM squads.tasks t
                WHERE t.started_at >= CURRENT_DATE - INTERVAL '1 day' * %s
                GROUP BY t.squad, t.agent
                ON CONFLICT (period, period_start, squad, agent) DO UPDATE SET
                    tasks_started = EXCLUDED.tasks_started,
                    tasks_completed = EXCLUDED.tasks_completed,
                    tasks_failed = EXCLUDED.tasks_failed,
                    success_rate = EXCLUDED.success_rate,
                    total_retries = EXCLUDED.total_retries,
                    avg_retries_per_task = EXCLUDED.avg_retries_per_task,
                    tasks_with_retries = EXCLUDED.tasks_with_retries,
                    avg_quality_score = EXCLUDED.avg_quality_score,
                    feedback_count = EXCLUDED.feedback_count,
                    avg_duration_ms = EXCLUDED.avg_duration_ms,
                    avg_tokens_per_task = EXCLUDED.avg_tokens_per_task,
                    avg_cost_per_task = EXCLUDED.avg_cost_per_task,
                    avg_context_utilization = EXCLUDED.avg_context_utilization,
                    captured_at = NOW()
            """, (period, {"day": 1, "week": 7, "month": 30}.get(period, 7)))

        conn.commit()
        conn.close()

        return jsonify({"status": "ok", "period": period}), 200

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    print(f"Starting Squads Bridge on port {port}")
    print(f"  PostgreSQL: {DATABASE_URL.split('@')[1] if '@' in DATABASE_URL else DATABASE_URL}")
    print(f"  Redis:      {'connected' if redis_client else 'disabled'}")
    print(f"  Langfuse:   {'enabled' if LANGFUSE_ENABLED else 'disabled'}")
    print(f"  Engram:     {'enabled -> ' + ENGRAM_URL if ENGRAM_ENABLED else 'disabled'}")
    print(f"  Budget:     ${DAILY_BUDGET}/day")

    # Start background conversation processor
    if redis_client:
        start_conversation_worker()

    app.run(host="0.0.0.0", port=port)
