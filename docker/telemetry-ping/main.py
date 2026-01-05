"""
Squads CLI Telemetry Ping - Public endpoint for anonymous CLI telemetry.
Receives events and publishes to Pub/Sub for BigQuery streaming.
"""
import os
import json
import hashlib
import hmac
from datetime import datetime
from flask import Flask, request, jsonify
from google.cloud import pubsub_v1

app = Flask(__name__)

# Config
PROJECT_ID = os.environ.get("GCP_PROJECT", "inspired-answer-481202-f6")
TOPIC_ID = os.environ.get("PUBSUB_TOPIC", "squads-cli-telemetry")
DEBUG = os.environ.get("DEBUG", "0") == "1"

# API Key for validation (prevents spam/contamination)
# CLI embeds this key (obfuscated) - not true security, but adds friction
API_KEY = os.environ.get("TELEMETRY_API_KEY", "sq_tel_v1_7f8a9b2c3d4e5f6a")

# Valid event prefixes (reject unknown events)
VALID_EVENT_PREFIXES = ("cli.", "agent.", "squad.", "error.")

# Pub/Sub publisher (lazy init)
publisher = None

def get_publisher():
    global publisher
    if publisher is None:
        publisher = pubsub_v1.PublisherClient()
    return publisher

def validate_request() -> tuple[bool, str]:
    """Validate API key and basic structure."""
    # Check API key header
    api_key = request.headers.get("X-Squads-Key") or request.headers.get("Authorization", "").replace("Bearer ", "")
    if not api_key or not hmac.compare_digest(api_key, API_KEY):
        return False, "invalid_key"
    return True, ""

def validate_event(event: dict) -> bool:
    """Validate event structure."""
    if not isinstance(event, dict):
        return False

    event_name = event.get("event", "")
    if not event_name or not any(event_name.startswith(p) for p in VALID_EVENT_PREFIXES):
        return False

    # Must have properties dict (can be empty)
    if "properties" in event and not isinstance(event.get("properties"), dict):
        return False

    return True

def publish_event(event: dict) -> bool:
    """Publish event to Pub/Sub."""
    try:
        pub = get_publisher()
        topic_path = pub.topic_path(PROJECT_ID, TOPIC_ID)

        # Add server metadata
        event["server_ts"] = datetime.utcnow().isoformat() + "Z"
        event["source"] = "squads-cli"

        data = json.dumps(event).encode("utf-8")
        future = pub.publish(topic_path, data)
        future.result(timeout=5)  # Wait for ack
        return True
    except Exception as e:
        if DEBUG:
            print(f"Pub/Sub error: {e}")
        return False

@app.route("/", methods=["GET"])
def health():
    """Health check."""
    return jsonify({"status": "ok", "service": "squads-telemetry"}), 200

@app.route("/ping", methods=["POST"])
def ping():
    """
    Receive telemetry ping from CLI.

    Headers:
        X-Squads-Key: <api_key>

    POST /ping
    Content-Type: application/json

    {"event": "cli.run", "properties": {"squad": "marketing", "durationMs": 1234}}
    """
    # Validate API key
    valid, error = validate_request()
    if not valid:
        return jsonify({"error": error}), 401

    try:
        data = request.get_json(silent=True)
        if not data:
            return jsonify({"error": "invalid json"}), 400

        # Support single event or batch
        events = data.get("events", [data])

        # Validate and publish
        published = 0
        rejected = 0
        for event in events:
            if validate_event(event):
                if publish_event(event):
                    published += 1
            else:
                rejected += 1

        return jsonify({
            "status": "ok",
            "received": len(events),
            "published": published,
            "rejected": rejected,
        }), 200

    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/ping", methods=["GET"])
def ping_get():
    """Simple GET ping for uptime checks."""
    return jsonify({"pong": True, "ts": datetime.utcnow().isoformat()}), 200

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port, debug=DEBUG)
