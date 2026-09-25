"""The server's riskiest small pieces: merging GitHub checks, and the canvas MCP endpoint. Run: python3 test_server.py"""
import http.client, json, sys, tempfile, threading, unittest
from http.server import ThreadingHTTPServer

argv, sys.argv = sys.argv, ["server.py", tempfile.mkdtemp()]  # server.py reads the project folder from argv when imported
import server  # noqa: E402
sys.argv = argv


class Checks(unittest.TestCase):
    def test_newest_run_per_name(self):
        rollup = [
            {"__typename": "CheckRun", "workflowName": "CI", "name": "test", "status": "COMPLETED", "conclusion": "FAILURE",
             "startedAt": "2026-01-01T10:00:00Z", "detailsUrl": "old"},
            {"__typename": "CheckRun", "workflowName": "CI", "name": "test", "status": "COMPLETED", "conclusion": "SUCCESS",
             "startedAt": "2026-01-01T11:00:00Z", "detailsUrl": "rerun"},  # a re-run: the old failure must not stay
            {"__typename": "CheckRun", "name": "lint", "status": "COMPLETED", "conclusion": "SKIPPED", "startedAt": "2026-01-01T10:00:00Z"},
            {"__typename": "StatusContext", "context": "deploy", "state": "PENDING", "targetUrl": "d"},
        ]
        self.assertEqual(server.checks(rollup), [
            {"name": "CI / test", "state": "pass", "url": "rerun"},
            {"name": "lint", "state": "skip", "url": ""},
            {"name": "deploy", "state": "pending", "url": "d"},
        ])


class FakeLive:
    token = "t" * 32

    def __init__(self):
        self.readers, self.calls = ["r1"], {}

    def canvas_call(self, name, args):
        return server.tool_error(f"called {name}")


class Mcp(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.H)
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        server.LIVE["card"] = FakeLive()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def post(self, body):
        c = http.client.HTTPConnection("127.0.0.1", self.httpd.server_port)
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        c.request("POST", f"/mcp/card/{FakeLive.token}", data, {"Host": f"127.0.0.1:{server.PORT}", "Content-Type": "application/json"})
        r = c.getresponse()
        return r.status, r.read()

    def test_round_trip(self):
        status, body = self.post({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}})
        self.assertEqual(json.loads(body)["result"]["serverInfo"]["name"], "claude-ui-canvas")
        self.assertEqual(self.post({"jsonrpc": "2.0", "method": "notifications/initialized"})[0], 202)
        tools = json.loads(self.post({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})[1])["result"]["tools"]
        self.assertIn("canvas_create", [t["name"] for t in tools])
        call = json.loads(self.post({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "canvas_list", "arguments": "nope"}})[1])
        self.assertEqual(call["result"]["content"][0]["text"], "called canvas_list")

    def test_bad_requests(self):
        self.assertEqual(json.loads(self.post(b"{not json")[1])["error"]["code"], -32700)
        self.assertEqual(json.loads(self.post([1, 2])[1])["error"]["code"], -32600)

    def test_detach_fails_pending_calls(self):
        lv = server.Live.__new__(server.Live)  # just the call bookkeeping, no claude process
        lv.readers, done = ["a", "b"], threading.Event()
        lv.calls = {"x": [done, None, "a"], "y": [threading.Event(), None, "b"]}
        lv.detach("a")
        self.assertTrue(done.is_set())
        self.assertTrue(lv.calls["x"][1]["isError"])
        self.assertFalse(lv.calls["y"][0].is_set())


class Stream(unittest.TestCase):
    """One stream per page carries every card's lines, tagged with the card, from each card's own offset."""

    def live(self, lines):
        lv = server.Live.__new__(server.Live)  # the buffer only, no claude process
        lv.lines, lv.base, lv.size, lv.asks, lv.busy, lv.readers, lv.calls = [], 0, 0, {}, False, [], {}
        lv.cond, lv.last, lv.gen = threading.Condition(), 0, "g1"
        for line in lines:
            lv.push(json.dumps(line) + "\n")
        return lv

    def test_two_cards_one_stream(self):
        a, b = "a" * 8 + "-0000-0000-0000-" + "0" * 12, "b" * 8 + "-0000-0000-0000-" + "0" * 12
        server.LIVE[a] = self.live([{"type": "x", "i": 0}, {"type": "x", "i": 1}])
        server.LIVE[b] = self.live([{"type": "y", "i": 0}, {"type": "y", "i": 1}])
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.H)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        try:
            c = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
            c.request("GET", f"/api/events?page=abcd1234&c={a}:0,{b}:1", headers={"Host": f"127.0.0.1:{server.PORT}"})
            r = c.getresponse()
            got = [json.loads(r.fp.readline()) for _ in range(5)]  # 2 attach lines + 2 of a's + 1 of b's
            self.assertEqual([(g["_c"][0], g["type"], g.get("i", g.get("from"))) for g in got],
                             [("a", "attach", 0), ("a", "x", 0), ("a", "x", 1), ("b", "attach", 1), ("b", "y", 1)])
            self.assertEqual(server.LIVE[a].readers, ["abcd1234"])
            server.LIVE[b].push(json.dumps({"type": "y", "i": 2}) + "\n")  # later output wakes the stream
            self.assertEqual(json.loads(r.fp.readline())["i"], 2)
            c.close()
            # an offset from an older process of the card: this one is read from its first line
            c = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
            c.request("GET", f"/api/events?page=abcd1234&c={a}:2:oldgen", headers={"Host": f"127.0.0.1:{server.PORT}"})
            r = c.getresponse()
            self.assertEqual(json.loads(r.fp.readline())["from"], 0)
            c.close()
        finally:
            httpd.shutdown()
            server.LIVE.pop(a), server.LIVE.pop(b)

    def test_trim_live_line(self):
        line = json.dumps({"type": "user", "message": {"content": [{"type": "tool_result", "content": "x" * 50_000}]},
                           "tool_use_result": {"stdout": "x" * 50_000}}) + "\n"
        d = json.loads(server.trimmed(line))
        self.assertNotIn("tool_use_result", d)
        self.assertLess(len(d["message"]["content"][0]["content"]), 21_000)


if __name__ == "__main__":
    unittest.main()
