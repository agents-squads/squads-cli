"""
Anthropic API Proxy
Forwards requests to Anthropic API and captures rate limit headers.
Stores rate limits in Redis for real-time dashboard display.
Includes rate limiting queue to prevent parallel agents from hitting limits.
"""
import os
import json
import time
import threading
import requests
from datetime import datetime
from flask import Flask, request, Response, jsonify
import redis

app = Flask(__name__)

# Configuration
ANTHROPIC_API_URL = os.environ.get("ANTHROPIC_API_URL", "https://api.anthropic.com")
BRIDGE_URL = os.environ.get("SQUADS_BRIDGE_URL", "http://squads-bridge:8080")
REDIS_URL = os.environ.get("REDIS_URL", "redis://redis:6379/0")
DEBUG_MODE = os.environ.get("DEBUG", "0") == "1"

# Rate limiting configuration
RATE_LIMIT_ENABLED = os.environ.get("RATE_LIMIT_ENABLED", "1") == "1"
MIN_REQUESTS_REMAINING = int(os.environ.get("MIN_REQUESTS_REMAINING", "10"))  # Queue if fewer remaining
MIN_TOKENS_REMAINING = int(os.environ.get("MIN_TOKENS_REMAINING", "10000"))  # Queue if fewer remaining
QUEUE_WAIT_TIME = float(os.environ.get("QUEUE_WAIT_TIME", "5.0"))  # Seconds between queued requests

# Thread-safe request queue
request_lock = threading.Lock()
last_request_time = 0

# Redis connection
redis_client = None
try:
    redis_client = redis.from_url(REDIS_URL, decode_responses=True)
    redis_client.ping()
    print(f"[PROXY] Redis connected: {REDIS_URL}")
except Exception as e:
    print(f"[PROXY] Redis unavailable: {e}")
    redis_client = None


def extract_model_family(model: str) -> str:
    """Extract model family from full model name."""
    if "opus" in model.lower():
        return "opus"
    elif "sonnet" in model.lower():
        return "sonnet"
    elif "haiku" in model.lower():
        return "haiku"
    return "unknown"


def store_rate_limits(model: str, headers: dict):
    """Store rate limit headers in Redis."""
    if not redis_client:
        return

    # Extract rate limit headers
    rate_limits = {}
    header_mapping = {
        "anthropic-ratelimit-requests-limit": "requests_limit",
        "anthropic-ratelimit-requests-remaining": "requests_remaining",
        "anthropic-ratelimit-requests-reset": "requests_reset",
        "anthropic-ratelimit-tokens-limit": "tokens_limit",
        "anthropic-ratelimit-tokens-remaining": "tokens_remaining",
        "anthropic-ratelimit-tokens-reset": "tokens_reset",
        "anthropic-ratelimit-input-tokens-limit": "input_tokens_limit",
        "anthropic-ratelimit-input-tokens-remaining": "input_tokens_remaining",
        "anthropic-ratelimit-input-tokens-reset": "input_tokens_reset",
        "anthropic-ratelimit-output-tokens-limit": "output_tokens_limit",
        "anthropic-ratelimit-output-tokens-remaining": "output_tokens_remaining",
        "anthropic-ratelimit-output-tokens-reset": "output_tokens_reset",
    }

    for header_name, key in header_mapping.items():
        value = headers.get(header_name)
        if value:
            # Parse numeric values
            if "remaining" in key or "limit" in key:
                try:
                    rate_limits[key] = int(value)
                except ValueError:
                    rate_limits[key] = value
            else:
                rate_limits[key] = value

    if not rate_limits:
        return

    rate_limits["captured_at"] = datetime.now().isoformat()
    rate_limits["model"] = model

    # Store in Redis with 5 minute TTL
    family = extract_model_family(model)
    key = f"ratelimit:latest:{family}"
    redis_client.set(key, json.dumps(rate_limits), ex=300)

    # Also store by full model name
    key_full = f"ratelimit:latest:{model}"
    redis_client.set(key_full, json.dumps(rate_limits), ex=300)

    if DEBUG_MODE:
        print(f"[PROXY] Rate limits stored for {model}: {rate_limits}")


def check_rate_limits(model: str) -> dict:
    """Check current rate limits and return status."""
    if not redis_client:
        return {"should_wait": False, "reason": "no_redis"}

    family = extract_model_family(model)
    key = f"ratelimit:latest:{family}"
    data = redis_client.get(key)

    if not data:
        return {"should_wait": False, "reason": "no_data"}

    limits = json.loads(data)
    requests_remaining = limits.get("requests_remaining", 999)
    tokens_remaining = limits.get("tokens_remaining", 999999)

    if requests_remaining < MIN_REQUESTS_REMAINING:
        return {
            "should_wait": True,
            "reason": f"requests_remaining={requests_remaining} < {MIN_REQUESTS_REMAINING}",
            "wait_until": limits.get("requests_reset"),
        }

    if tokens_remaining < MIN_TOKENS_REMAINING:
        return {
            "should_wait": True,
            "reason": f"tokens_remaining={tokens_remaining} < {MIN_TOKENS_REMAINING}",
            "wait_until": limits.get("tokens_reset"),
        }

    return {"should_wait": False, "reason": "ok"}


def wait_for_rate_limit():
    """Enforce minimum time between requests (queue)."""
    global last_request_time

    with request_lock:
        now = time.time()
        elapsed = now - last_request_time

        if elapsed < QUEUE_WAIT_TIME:
            wait_time = QUEUE_WAIT_TIME - elapsed
            if DEBUG_MODE:
                print(f"[PROXY] Rate limit queue: waiting {wait_time:.2f}s")
            time.sleep(wait_time)

        last_request_time = time.time()


@app.route("/v1/messages", methods=["POST"])
def proxy_messages():
    """Proxy /v1/messages endpoint to Anthropic API."""
    try:
        # Get request data
        body = request.get_json()
        model = body.get("model", "unknown") if body else "unknown"

        # Rate limiting check
        if RATE_LIMIT_ENABLED:
            limit_status = check_rate_limits(model)
            if limit_status["should_wait"]:
                if DEBUG_MODE:
                    print(f"[PROXY] Rate limit warning: {limit_status['reason']}")
                # Add extra delay when approaching limits
                time.sleep(QUEUE_WAIT_TIME * 2)

            # Enforce queue spacing
            wait_for_rate_limit()

        # Forward headers (except Host)
        forward_headers = {
            key: value for key, value in request.headers
            if key.lower() not in ("host", "content-length")
        }

        # Make request to Anthropic
        response = requests.post(
            f"{ANTHROPIC_API_URL}/v1/messages",
            headers=forward_headers,
            json=body,
            stream=True,  # Support streaming responses
            timeout=300,
        )

        # Capture rate limit headers
        store_rate_limits(model, dict(response.headers))

        # Stream response back
        def generate():
            for chunk in response.iter_content(chunk_size=1024):
                yield chunk

        # Build response with original headers
        proxy_response = Response(
            generate(),
            status=response.status_code,
            content_type=response.headers.get("content-type"),
        )

        # Copy relevant headers
        for header in ["x-request-id", "anthropic-ratelimit-requests-remaining",
                       "anthropic-ratelimit-tokens-remaining"]:
            if header in response.headers:
                proxy_response.headers[header] = response.headers[header]

        return proxy_response

    except requests.exceptions.Timeout:
        return jsonify({"error": "Request to Anthropic API timed out"}), 504
    except requests.exceptions.RequestException as e:
        return jsonify({"error": f"Proxy error: {str(e)}"}), 502
    except Exception as e:
        return jsonify({"error": f"Internal error: {str(e)}"}), 500


@app.route("/v1/complete", methods=["POST"])
def proxy_complete():
    """Proxy /v1/complete endpoint (legacy)."""
    try:
        body = request.get_json()
        model = body.get("model", "unknown") if body else "unknown"

        forward_headers = {
            key: value for key, value in request.headers
            if key.lower() not in ("host", "content-length")
        }

        response = requests.post(
            f"{ANTHROPIC_API_URL}/v1/complete",
            headers=forward_headers,
            json=body,
            stream=True,
            timeout=300,
        )

        store_rate_limits(model, dict(response.headers))

        def generate():
            for chunk in response.iter_content(chunk_size=1024):
                yield chunk

        return Response(
            generate(),
            status=response.status_code,
            content_type=response.headers.get("content-type"),
        )

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/rate-limits", methods=["GET"])
def get_rate_limits():
    """Get current rate limits from Redis."""
    if not redis_client:
        return jsonify({"error": "Redis not available"}), 503

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
        })

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/health", methods=["GET"])
def health():
    """Health check endpoint."""
    status = {
        "status": "healthy",
        "anthropic_url": ANTHROPIC_API_URL,
        "redis": "connected" if redis_client else "unavailable",
    }

    if redis_client:
        try:
            redis_client.ping()
        except Exception:
            status["redis"] = "error"
            status["status"] = "degraded"

    return jsonify(status), 200 if status["status"] == "healthy" else 503


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8089))
    print(f"[PROXY] Starting Anthropic Proxy on port {port}")
    print(f"[PROXY] Forwarding to: {ANTHROPIC_API_URL}")
    print(f"[PROXY] Redis: {'connected' if redis_client else 'unavailable'}")

    app.run(host="0.0.0.0", port=port)
