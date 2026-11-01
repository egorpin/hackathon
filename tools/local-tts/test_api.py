"""Protocol checks without model downloads or GPU use."""
import json
import threading
import unittest
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from local_tts import handler_for


class FakeSynth:
    def __init__(self):
        self.calls = 0
        self.entered = threading.Event()
        self.release = threading.Event()

    def generate(self, text):
        self.calls += 1
        if text == "hold":
            self.entered.set()
            if not self.release.wait(5):
                raise TimeoutError("test stalled")
        return b"RIFF-test-wave"


class ProtocolTest(unittest.TestCase):
    def test_protocol(self):
        fake = FakeSynth()
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler_for(fake, ["http://localhost:5173"]))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.addCleanup(fake.release.set)

        def request(path, body=None, origin="http://localhost:5173", method=None):
            data = None if body is None else json.dumps(body).encode()
            req = Request(f"http://127.0.0.1:{server.server_port}{path}", data=data,
                          headers={"Origin": origin, "Content-Type": "application/json"}, method=method)
            try:
                with urlopen(req, timeout=8) as res:
                    return res.status, dict(res.headers), res.read()
            except HTTPError as error:
                return error.code, dict(error.headers), error.read()

        self.assertEqual(request("/health")[0], 200)
        self.assertEqual(request("/health", origin="https://unrelated.example")[0], 403)
        self.assertEqual(request("/speech", method="OPTIONS")[0], 204)
        first = request("/speech", {"text": "hello"})
        self.assertEqual(first[0], 200)
        self.assertEqual(first[1]["Content-Type"], "audio/wav")
        self.assertEqual(first[1]["X-TTS-Cache"], "miss")
        self.assertEqual(request("/speech", {"text": "hello"})[1]["X-TTS-Cache"], "hit")
        self.assertEqual(fake.calls, 1)
        for body in ({"text": ""}, {"text": "x" * 201}, [1]):
            self.assertEqual(request("/speech", body)[0], 400)
        self.assertEqual(request("/missing", {})[0], 404)
        result = []
        worker = threading.Thread(target=lambda: result.append(request("/speech", {"text": "hold"})))
        worker.start()
        self.assertTrue(fake.entered.wait(3))
        try:
            self.assertEqual(request("/speech", {"text": "another"})[0], 429)
        finally:
            fake.release.set()
            worker.join(5)
        self.assertEqual(result[0][0], 200)


if __name__ == "__main__":
    unittest.main()
