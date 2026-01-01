"""
OTel to Langfuse Bridge (v3 API)
Receives OpenTelemetry metrics/logs and forwards to Langfuse.
Enriches spans with agent/squad metadata for cost tracking.
"""
import os
import json
import gzip
from datetime import datetime
from flask import Flask, request, jsonify
from langfuse import Langfuse

app = Flask(__name__)

# Initialize Langfuse client
langfuse = Langfuse(
    public_key=os.environ.get("LANGFUSE_PUBLIC_KEY"),
    secret_key=os.environ.get("LANGFUSE_SECRET_KEY"),
    host=os.environ.get("LANGFUSE_HOST", os.environ.get("LANGFUSE_BASE_URL", "https://cloud.langfuse.com")),
)

# Track sessions for grouping
sessions = {}


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


@app.route("/v1/metrics", methods=["POST"])
def receive_metrics():
    """Receive OTel metrics - acknowledge for now."""
    try:
        get_json_data()  # Parse but don't process yet
        return jsonify({"status": "ok"}), 200
    except Exception as e:
        print(f"Error processing metrics: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/v1/logs", methods=["POST"])
def receive_logs():
    """Receive OTel logs and forward to Langfuse with enrichment."""
    try:
        data = get_json_data()

        for resource_log in data.get("resourceLogs", []):
            resource_attrs = extract_attributes(
                resource_log.get("resource", {}).get("attributes", [])
            )

            # Get service info for agent/squad tagging
            service_name = resource_attrs.get("service.name", "claude-code")
            team = resource_attrs.get("team", "agents-squads")

            # Detect squad context (from OTEL attrs, env, or default to "hq" for direct sessions)
            squad_name = (
                resource_attrs.get("squad") or
                resource_attrs.get("squads.squad") or
                os.environ.get("SQUADS_SQUAD") or
                "hq"  # Default: direct COO session, not a squad run
            )
            agent_name = (
                resource_attrs.get("agent") or
                resource_attrs.get("squads.agent") or
                os.environ.get("SQUADS_AGENT") or
                "coo"  # Default: COO role for direct sessions
            )

            for scope_log in resource_log.get("scopeLogs", []):
                for log_record in scope_log.get("logRecords", []):
                    log_attrs = extract_attributes(log_record.get("attributes", []))

                    event_name = log_attrs.get("event.name", "unknown")
                    session_id = log_attrs.get("session.id", "unknown")
                    user_id = log_attrs.get("user.id", "")

                    # Common metadata for all spans
                    base_metadata = {
                        "session_id": session_id,
                        "user_id": user_id,
                        "service": service_name,
                        "team": team,
                        "agent": agent_name,  # Detected agent or "coo" for direct sessions
                        "squad": squad_name,  # Detected squad or "hq" for direct sessions
                    }

                    # Handle API requests (with token/cost data)
                    if event_name == "api_request":
                        model = log_attrs.get("model", "claude")
                        input_tokens = safe_int(log_attrs.get("input_tokens"))
                        output_tokens = safe_int(log_attrs.get("output_tokens"))
                        cache_read = safe_int(log_attrs.get("cache_read_tokens"))
                        cache_creation = safe_int(log_attrs.get("cache_creation_tokens"))
                        cost_usd = safe_float(log_attrs.get("cost_usd"))

                        try:
                            gen = langfuse.start_generation(
                                name=f"llm:{model}",
                                model=model,
                                usage_details={
                                    "input": input_tokens,
                                    "output": output_tokens,
                                    "cache_read": cache_read,
                                    "cache_creation": cache_creation,
                                    "total": input_tokens + output_tokens,
                                },
                                cost_details={
                                    "input_cost": cost_usd * 0.7,  # Approximate split
                                    "output_cost": cost_usd * 0.3,
                                    "total_cost": cost_usd,
                                },
                                metadata={
                                    **base_metadata,
                                    "event_type": "api_request",
                                    "cost_usd": cost_usd,
                                },
                            )
                            gen.end()
                            print(f"Created generation: {model} tokens={input_tokens}+{output_tokens} cost=${cost_usd:.4f}")
                        except Exception as e:
                            print(f"Error creating generation: {e}")

                    # Handle tool results
                    elif event_name == "tool_result":
                        tool_name = log_attrs.get("tool_name", "unknown")
                        duration_ms = log_attrs.get("duration_ms", "")
                        success = log_attrs.get("success", "")

                        try:
                            span = langfuse.start_span(
                                name=f"tool:{tool_name}",
                                metadata={
                                    **base_metadata,
                                    "event_type": "tool_result",
                                    "tool_name": tool_name,
                                    "success": success,
                                    "duration_ms": duration_ms,
                                },
                            )
                            span.end()
                            # Only log non-trivial tools
                            if tool_name not in ["Read", "Glob", "Grep"]:
                                print(f"Created span: tool:{tool_name}")
                        except Exception as e:
                            print(f"Error creating span: {e}")

        # Flush to Langfuse
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
    return jsonify({"status": "healthy", "sessions": len(sessions)}), 200


@app.route("/flush", methods=["POST"])
def flush():
    """Flush all pending data to Langfuse."""
    try:
        langfuse.flush()
        return jsonify({"status": "flushed"}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/stats", methods=["GET"])
def stats():
    """Get bridge statistics."""
    return jsonify({
        "status": "running",
        "sessions_tracked": len(sessions),
    }), 200


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    print(f"Starting Langfuse bridge on port {port}")
    app.run(host="0.0.0.0", port=port)
