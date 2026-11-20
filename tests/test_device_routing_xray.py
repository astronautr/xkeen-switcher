"""Optional real-core integration: XRAY_TEST_BINARY=/path/to/xray pytest this file.

All destinations and exit proxies are local. No router or subscription is used.
"""
import json
import os
from pathlib import Path
import socket
import socketserver
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
import pytest
from xk_switcher.device_routing import compile_overlay
from xk_switcher.subscription import Location

XRAY = os.environ.get("XRAY_TEST_BINARY")
pytestmark = pytest.mark.skipif(not XRAY, reason="Set XRAY_TEST_BINARY for real Xray integration")

class ExitProxy(socketserver.StreamRequestHandler):
    def handle(self):
        self.connection.settimeout(5)
        first = self.rfile.readline()
        while self.rfile.readline() not in (b"\r\n", b"\n", b""): pass
        if first.startswith(b"CONNECT "):
            self.wfile.write(b"HTTP/1.1 200 Connection established\r\n\r\n"); self.wfile.flush()
            self.rfile.readline()
            while self.rfile.readline() not in (b"\r\n", b"\n", b""): pass
        body = self.server.label.encode()
        self.wfile.write(b"HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body)
        self.wfile.flush()

class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True

def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]

def receive(sock, size):
    data = b""
    while len(data) < size:
        chunk = sock.recv(size - len(data))
        if not chunk: raise EOFError("SOCKS connection closed")
        data += chunk
    return data

def request(port, source, destination="192.0.2.2", target_port=80):
    with socket.socket() as sock:
        sock.settimeout(5); sock.bind((source, 0)); sock.connect(("127.0.0.1", port))
        sock.sendall(b"\x05\x01\x00")
        assert receive(sock, 2) == b"\x05\x00"
        sock.sendall(b"\x05\x01\x00\x01" + socket.inet_aton(destination) + target_port.to_bytes(2, "big"))
        response = receive(sock, 4)
        assert response[1] == 0
        receive(sock, (4 if response[3] == 1 else 16) + 2)
        sock.sendall(b"GET / HTTP/1.1\r\nHost: fixture.test\r\nConnection: close\r\n\r\n")
        chunks = []
        while chunk := sock.recv(8192): chunks.append(chunk)
        return b"".join(chunks).split(b"\r\n\r\n")[-1].decode()

@pytest.mark.parametrize("main_sequence", [(0,), (0, 4, 0)], ids=["initial-routing", "main-a-b-a"])
def test_two_device_sources_main_and_direct_in_one_xray(tmp_path, main_sequence):
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        # A UDP connect only selects a local route; it sends no packets.
        sock.connect(("192.0.2.1", 9)); second_ip = sock.getsockname()[0]
    if second_ip == "127.0.0.1": pytest.skip("A second local IPv4 address is needed")
    servers = []
    process = None
    try:
        for label in ("main", "turkey", "netherlands", "direct", "main-b"):
            server = Server(("127.0.0.1", 0), ExitProxy); server.label = label
            threading.Thread(target=server.serve_forever, daemon=True).start(); servers.append(server)
        def outbound(index, tag):
            return {"tag":tag,"protocol":"http","settings":{"servers":[{"address":"127.0.0.1","port":servers[index].server_address[1]}]}}
        main = {"outbounds":[outbound(0,"vless-reality"),{"tag":"direct","protocol":"freedom"},{"tag":"block","protocol":"blackhole"}]}
        rules = {"routing":{"rules":[
            {"type":"field","inboundTag":["redirect"],"ip":["127.0.0.1"],"outboundTag":"direct"},
            {"type":"field","inboundTag":["redirect"],"ip":["192.0.2.9"],"outboundTag":"block"},
            {"type":"field","inboundTag":["redirect"],"outboundTag":"vless-reality"}]}}
        raw = ("// keep exact bytes\r\n" + json.dumps(rules)).encode()
        main_raw = json.dumps(main).encode()
        locations = {code:asdict(Location(code=code,name=code,protocol="http",host="127.0.0.1",port=servers[i].server_address[1],outbound=outbound(i,"proxy"))) for code,i in (("tr",1),("nl",2))}
        assignments = {"first":{"code":"tr","ip":"127.0.0.1"},"second":{"code":"nl","ip":second_ip}}
        (tmp_path/"04_outbounds.json").write_bytes(main_raw)
        (tmp_path/"05_routing.json").write_bytes(raw)
        overlay_raw = compile_overlay(raw, assignments, locations, main_raw)
        (tmp_path/"99_xk_devices_tail.json").write_bytes(overlay_raw)
        unchanged = {}
        for name in ("05_routing.json", "99_xk_devices_tail.json"):
            stat = (tmp_path/name).stat()
            unchanged[name] = ((tmp_path/name).read_bytes(), stat.st_ino, stat.st_mtime_ns)
        ports = [free_port(),free_port()]
        inbounds = [{"tag":tag,"port":port,"listen":"127.0.0.1","protocol":"socks","settings":{"auth":"noauth"}} for tag,port in zip(("redirect","main-test"),ports)]
        (tmp_path/"03_inbounds.json").write_text(json.dumps({"inbounds":inbounds}))
        with (tmp_path/"core.log").open("wb") as log:
            for step, main_index in enumerate(main_sequence):
                if step:
                    # A Main-only transaction replaces just this file. The
                    # already applied fixed exits and rules are deliberately reused.
                    main["outbounds"][0] = outbound(main_index, "vless-reality")
                    staged = tmp_path/".outbound-candidate"
                    staged.write_bytes(json.dumps(main).encode())
                    staged.replace(tmp_path/"04_outbounds.json")
                check = subprocess.run([XRAY,"run","-test","-confdir",str(tmp_path)],capture_output=True,timeout=20)
                assert check.returncode == 0, check.stderr
                process = subprocess.Popen([XRAY,"run","-confdir",str(tmp_path)],stdout=log,stderr=log)
                for _ in range(100):
                    try:
                        with socket.create_connection(("127.0.0.1",ports[0]),timeout=.1): break
                    except OSError:
                        assert process.poll() is None, (tmp_path/"core.log").read_text()
                        time.sleep(.05)
                else:
                    pytest.fail("Xray did not start listening: " + (tmp_path/"core.log").read_text())
                with ThreadPoolExecutor(max_workers=3) as pool:
                    first = pool.submit(request, ports[0], "127.0.0.1")
                    second = pool.submit(request, ports[0], second_ip)
                    default = pool.submit(request, ports[1], "127.0.0.1")
                    assert first.result() == "turkey"
                    assert second.result() == "netherlands"
                    assert default.result() == servers[main_index].label
                assert request(ports[0],"127.0.0.1","127.0.0.1",servers[3].server_address[1]) == "direct"
                try:
                    blocked = request(ports[0],"127.0.0.1","192.0.2.9")
                except ConnectionResetError:
                    blocked = ""
                assert blocked == ""
                for name, expected in unchanged.items():
                    stat = (tmp_path/name).stat()
                    assert ((tmp_path/name).read_bytes(), stat.st_ino, stat.st_mtime_ns) == expected
                process.terminate(); process.wait(timeout=10); process = None
    finally:
        if process is not None:
            process.terminate(); process.wait(timeout=10)
        for server in servers: server.shutdown(); server.server_close()
