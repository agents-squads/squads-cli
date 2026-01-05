"""
Squads CLI Telemetry Ping - Public endpoint for anonymous CLI telemetry.
Receives events and publishes to Pub/Sub for BigQuery streaming.
"""
import os
import json
from datetime import datetime
from flask import Flask, request, jsonify
from google.cloud import pubsub_v1

app = Flask(__name__)

# Config
PROJECT_ID = os.environ.get("GCP_PROJECT", "inspired-answer-481202-f6")
TOPIC_ID = os.environ.get("PUBSUB_TOPIC", "squads-cli-telemetry")
DEBUG = os.environ.get("DEBUG", "0") == "1"

# Pub/Sub publisher (lazy init)
publisher = None

def get_publisher():
    global publisher
    if publisher is None:
        publisher = pubsub_v1.PublisherClient()
    return publisher

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

    POST /ping
    Content-Type: application/json

    {"event": "cli.run", "properties": {"squad": "marketing", "durationMs": 1234}}

    Or batch:
    {"events": [{"event": "cli.run", ...}, {"event": "cli.status", ...}]}
    """
    try:
        data = request.get_json(silent=True)
        if not data:
            return jsonify({"error": "invalid json"}), 400

        # Support single event or batch
        events = data.get("events", [data])

        published = 0
        for event in events:
            if publish_event(event):
                published += 1

        return jsonify({
            "status": "ok",
            "received": len(events),
            "published": published,
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
