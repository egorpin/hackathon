"""Check trusted HTTPS + WSS against a disposable deployment, without TLS bypasses.

Requires server/requirements-dev.txt. Creates a player and sends chat messages.
"""
import argparse
import json
from pathlib import Path
import ssl
import uuid
from urllib.parse import urlsplit

import httpx
from websockets.exceptions import InvalidStatus
from websockets.sync.client import connect


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("url", help="e.g. https://192.168.1.10:8443")
    parser.add_argument("--ca", type=Path, default=Path("certs/ca.crt"))
    args = parser.parse_args()
    origin = args.url.rstrip("/")
    parsed = urlsplit(origin)
    if parsed.scheme != "https" or not parsed.netloc or parsed.path or parsed.query or parsed.fragment:
        parser.error("URL must be an HTTPS origin without a path, query or fragment")
    context = ssl.create_default_context(cafile=str(args.ca))
    socket_url = "wss://" + parsed.netloc + "/ws"
    with httpx.Client(base_url=origin, verify=context, trust_env=False, timeout=10) as client:
        assert client.get("/api/health").json()["status"] == "ok"
        page = client.get("/")
        assert page.status_code == 200 and "/@vite/client" not in page.text
        username, password = "tls_" + uuid.uuid4().hex[:16], uuid.uuid4().hex
        result = client.post("/api/auth/register", headers={"Origin": origin},
                             json={"username": username, "password": password})
        assert result.status_code == 201, result.text
        session = next(cookie for cookie in client.cookies.jar if cookie.name == "mars_session")
        assert session.secure, "Session cookie must have the Secure flag"
        identity = result.json()
        assert client.get("/api/auth/me").json() == identity
        assert client.post("/api/auth/login", headers={"Origin": "https://evil.example"},
                           json={"username": username, "password": password}).status_code == 403
        options = dict(ssl=context, origin=origin, open_timeout=10,
                       additional_headers={"Cookie": f"mars_session={session.value}"})
        for attempt in range(2):
            with connect(socket_url, **options) as ws:
                ready = json.loads(ws.recv(timeout=5))
                assert ready["type"] == "session.ready" and ready["payload"] == identity
                request_id = str(uuid.uuid4())
                ws.send(json.dumps({"type": "chat.send", "request_id": request_id,
                                    "payload": {"text": f"Trusted WSS check {attempt}"}}))
                for _ in range(20):
                    message = json.loads(ws.recv(timeout=5))
                    if message.get("request_id") == request_id:
                        assert message["payload"]["ok"], message
                        break
                else:
                    raise AssertionError("No chat acknowledgement")
        try:
            with connect(socket_url, **{**options, "origin": "https://evil.example"}):
                raise AssertionError("Cross-origin WebSocket was accepted")
        except InvalidStatus as error:
            assert error.response.status_code == 403
    print("PASS: trusted HTTPS, Secure cookie, auth, WSS chat/reconnect and Origin rejection")


if __name__ == "__main__":
    main()
