// A local relay between Codex and a custom model's server. Many local servers
// (llama.cpp with Gemma's chat template, among others) reject a request with more than
// one system message, and Codex always sends several developer messages. The relay
// folds the leading system/developer messages (and `instructions`) into one, turns any
// later ones into user messages, and streams the reply back untouched.
//
// It runs as `python3 -I -c RELAY_PY <upstream base url> <port file>`, writes the port it
// listens on (127.0.0.1, chosen by the OS) to the port file, and lives as long as the
// agent's shell. Embedded here rather than shipped as a .py so it also runs on another
// machine. Standard library only.
export const RELAY_PY = String.raw`
import http.server, http.client, json, sys, urllib.parse

UP = urllib.parse.urlsplit(sys.argv[1].rstrip("/"))
SYSTEM = ("system", "developer")
HOP = {"connection", "keep-alive", "transfer-encoding", "content-length", "host", "proxy-connection", "upgrade", "te", "trailer"}

def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("text"))
    return ""

def fold(items, first_text, make):
    # Leading system/developer items (plus first_text) become one; later ones become user.
    head, out = ([first_text] if first_text else []), []
    for it in items:
        if isinstance(it, dict) and it.get("role") in SYSTEM:
            if not out:
                head.append(text_of(it.get("content")))
                continue
            it = dict(it, role="user")
        out.append(it)
    head = [h for h in head if h]
    return ([make("\n\n".join(head))] if head else []) + out

def fix(body):
    if isinstance(body.get("input"), list):  # Responses API
        body["input"] = fold(body["input"], body.pop("instructions", None),
            lambda t: {"type": "message", "role": "developer", "content": [{"type": "input_text", "text": t}]})
    elif isinstance(body.get("messages"), list):  # Chat Completions
        body["messages"] = fold(body["messages"], None, lambda t: {"role": "system", "content": t})
    return body

class Relay(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"  # the reply body ends when the connection closes

    def forward(self, method):
        body = None
        if method == "POST":
            body = self.rfile.read(int(self.headers.get("content-length") or 0))
            if not self.headers.get("content-encoding"):
                try:
                    body = json.dumps(fix(json.loads(body))).encode()
                except ValueError:
                    pass
        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP}
        if body is not None:
            headers["Content-Length"] = str(len(body))
        Conn = http.client.HTTPSConnection if UP.scheme == "https" else http.client.HTTPConnection
        try:
            conn = Conn(UP.hostname, UP.port, timeout=600)
            conn.request(method, UP.path + self.path, body=body, headers=headers)
            r = conn.getresponse()
        except OSError as e:
            msg = json.dumps({"error": {"message": "coderwriter relay: cannot reach %s (%s)" % (sys.argv[1], e), "type": "relay_error"}}).encode()
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(msg)
            return
        self.send_response(r.status)
        for k, v in r.getheaders():
            if k.lower() not in HOP:
                self.send_header(k, v)
        self.end_headers()
        while True:
            chunk = r.read1(65536)
            if not chunk:
                break
            self.wfile.write(chunk)
            self.wfile.flush()
        conn.close()

    def do_POST(self):
        self.forward("POST")

    def do_GET(self):
        self.forward("GET")

    def log_message(self, *args):
        pass

server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Relay)
server.daemon_threads = True
with open(sys.argv[2], "w") as f:
    f.write(str(server.server_address[1]))
server.serve_forever()
`;
