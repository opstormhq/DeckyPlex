"""Serve a single authenticated Plex video to a local Steam browser view."""

import json
import math
import re
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qsl, unquote, urlencode, urljoin, urlsplit, urlunsplit

import requests


ASSETS = Path(__file__).resolve().parent / "assets"
URI_ATTRIBUTE = re.compile(r'URI="([^"]+)"')
SESSION_HEADERS = ("X-Plex-Client-Identifier", "X-Plex-Session-Identifier")
PLAYER_PAGE = b"""<!doctype html>
<meta charset="utf-8">
<title>DeckyPlex video</title>
<style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000}
video{width:100%;height:100%;object-fit:contain;pointer-events:none}
</style>
<video playsinline muted></video>
<script src="hls.min.js"></script><script src="game-pip.js"></script>
"""


def _seconds(value):
    if isinstance(value, (int, float)) and math.isfinite(value):
        return min(86400, max(0, value))
    return 0


class GameVideo:
    def __init__(self, plex, source, position, volume, muted, preferred_source="", active_manifest=None,
                 source_identity=None):
        self.id = secrets.token_urlsafe(32)
        self.plex = plex
        self.source_identity = source_identity
        self.hls_urls = {}
        self.hls_manifests = {}
        self.active_hls_url = None
        self.origin = urlsplit(plex.base_url)
        self.lock = threading.Lock()
        self.closed = threading.Event()
        self.urls = {}
        self.keys = {}
        self.updated = time.monotonic()
        self.status = "waiting"
        self.committed = False
        self.diagnostic = ""
        self.upstream_error = ""
        self.position = _seconds(position)
        self.media_duration = _seconds((source.get("duration_ms") or 0) / 1000)
        self.duration = self.media_duration
        self.control = {
            "sequence": 0, "seek_sequence": 0, "active": False, "playing": False, "audible": False,
            "volume": min(100, _seconds(volume)) / 100, "muted": muted is True,
        }
        streams = []
        for stream in source["streams"]:
            kind = stream["kind"]
            if kind not in ("direct", "hls", "http"):
                continue
            name = {"audio-conversion": "hls-audio", "direct-stream": "hls-copy"}.get(stream.get("mode"), kind)
            route = self._media_url(stream["url"])
            streams.append({"kind": kind, "url": route, "name": name})
            if kind == "hls":
                self.hls_urls[route] = stream["url"]
                if stream.get("fallback_url"):
                    fallback = self._media_url(stream["fallback_url"])
                    self.hls_urls[fallback] = stream["fallback_url"]
                    streams.append({"kind": kind, "url": fallback, "name": "hls-proxy"})
        streams.sort(key=lambda candidate: candidate["name"] != preferred_source)
        self.handoff_manifest = None
        if active_manifest:
            try:
                upstream, content = active_manifest
                self.handoff_manifest = self._playlist(upstream, content, session_only=True)
            except (ValueError, UnicodeError):
                # A manifest from a different endpoint cannot be relayed.
                pass
            else:
                route = f"/{self.id}/handoff.m3u8"
                self.hls_urls[route] = upstream
                self.remember_hls_manifest(upstream, content)
                streams.insert(0, {"kind": "hls", "url": route, "name": "hls-active"})
        self.config = {
            "streams": streams,
            "position": self.position,
            "volume": self.control["volume"],
            "muted": muted is True,
        }
        self.http = ThreadingHTTPServer(("127.0.0.1", 0), _GameVideoHandler)
        self.http.video = self
        self.address = f"127.0.0.1:{self.http.server_port}"
        self.thread = threading.Thread(target=self.http.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True)

    def _media_url(self, upstream):
        parsed = urlsplit(upstream)
        path = unquote(parsed.path)
        if ((parsed.scheme, parsed.netloc) != (self.origin.scheme, self.origin.netloc)
                or not parsed.path.startswith(("/library/parts/", "/video/:/transcode/"))
                or "\\" in path or any(part in (".", "..") for part in path.split("/"))):
            raise ValueError("Unsupported Plex streaming URL")
        with self.lock:
            key = self.keys.get(upstream)
            if key is None:
                key = str(len(self.urls))
                self.urls[key] = upstream
                self.keys[upstream] = key
        return f"/{self.id}/media/{key}"

    def _playlist(self, upstream, content, session_only=False):
        session = {name: value for name, value in parse_qsl(urlsplit(upstream).query)
                   if name in SESSION_HEADERS}

        def route(uri):
            if uri.startswith("data:"):
                return uri
            target = urlsplit(urljoin(upstream, uri))
            if session_only and not target.path.startswith("/video/:/transcode/universal/session/"):
                raise ValueError("Expected a Plex session playlist")
            query = parse_qsl(target.query, keep_blank_values=True)
            keys = {name for name, _ in query}
            query.extend((name, value) for name, value in session.items() if name not in keys)
            return self._media_url(urlunsplit(target._replace(query=urlencode(query))))

        lines = []
        for line in content.decode("utf-8-sig").splitlines():
            if not line or line.startswith("#"):
                lines.append(URI_ATTRIBUTE.sub(lambda match: f'URI="{route(match[1])}"', line))
            else:
                lines.append(route(line.strip()))
        return ("\n".join(lines) + "\n").encode()

    def start(self):
        self.thread.start()
        threading.Thread(target=self._expire, daemon=True).start()

    def close(self):
        with self.lock:
            if self.closed.is_set():
                return
            self.closed.set()
        if self.thread.is_alive():
            self.http.shutdown()
        self.http.server_close()

    def _expire(self):
        while not self.closed.wait(5):
            with self.lock:
                expired = time.monotonic() - self.updated > 30
            if expired:
                self.close()

    @property
    def url(self):
        return f"http://{self.address}/{self.id}/"

    def snapshot(self):
        with self.lock:
            status = "error" if self.closed.is_set() else self.status
            code = ".".join(filter(None, (self.diagnostic, self.upstream_error)))
            return {"status": status, "position": self.position, "duration": self.duration,
                    "code": code[-96:], "committed": self.committed}

    def remember_hls_manifest(self, upstream, content):
        if not self.source_identity or not self.plex.local_connection or len(content) > 65536 or upstream not in self.hls_urls.values():
            return
        manifest = content.decode("utf-8-sig")
        if manifest.lstrip().startswith("#EXTM3U"):
            with self.lock:
                self.hls_manifests[upstream] = manifest

    def fullscreen_hls(self):
        with self.lock:
            if self.closed.is_set() or self.status not in ("playing", "paused"):
                return None
            manifest = self.hls_manifests.get(self.active_hls_url)
            return (self.active_hls_url, manifest) if manifest else None

    def record_upstream_error(self, code):
        with self.lock:
            self.upstream_error = code

    def update(self, data):
        with self.lock:
            self.updated = time.monotonic()
            status = data.get("status")
            if status in ("waiting", "ready", "playing", "paused", "ended", "error"):
                self.status = status
                route = data.get("stream_path")
                self.active_hls_url = self.hls_urls.get(route) if isinstance(route, str) else None
                if self.control["audible"] and status in ("playing", "paused"):
                    self.committed = self.committed or data.get("applied_sequence") == self.control["sequence"]
                if data.get("seek_sequence", 0) == self.control["seek_sequence"]:
                    self.position = _seconds(data.get("position"))
                self.duration = self.media_duration or _seconds(data.get("duration")) or self.duration
                code = data.get("code")
                if isinstance(code, str) and re.fullmatch(r"[a-zA-Z0-9_.:-]{0,96}", code):
                    self.diagnostic = code
            return self.control

    def command(self, action, position, playing):
        with self.lock:
            if self.closed.is_set():
                return False
            if action == "activate":
                if self.status != "ready" or self.control["active"]:
                    return False
            elif not self.control["active"] or self.status not in ("playing", "paused"):
                return False
            next_control = {**self.control, "sequence": self.control["sequence"] + 1, "active": True, "action": action}
            if action in ("activate", "commit", "playback"):
                next_control["playing"] = playing is True
            if action == "commit":
                self.committed = False
                next_control["audible"] = True
            if action in ("activate", "commit", "seek"):
                next_control.update(position=_seconds(position), seek_sequence=self.control["seek_sequence"] + 1)
                self.position = next_control["position"]
            if action == "volume":
                next_control["volume"] = min(100, _seconds(position)) / 100
                if next_control["volume"] > 0:
                    next_control["muted"] = False
            if action == "mute":
                next_control["muted"] = position == 1
            self.control = next_control
            return True


class _GameVideoHandler(BaseHTTPRequestHandler):
    def setup(self):
        self.request.settimeout(10)
        super().setup()

    def log_message(self, *_args):
        pass

    def _response(self, status, content_type, content):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'unsafe-inline'; media-src 'self' blob:; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(content)

    def _path(self):
        video = self.server.video
        prefix = f"/{video.id}/"
        if self.headers.get("Host") != video.address or not self.path.startswith(prefix):
            return None
        return self.path[len(prefix):]

    def do_GET(self):
        path = self._path()
        try:
            if path == "":
                self._response(200, "text/html; charset=utf-8", PLAYER_PAGE)
            elif path == "config":
                self._response(200, "application/json", json.dumps(self.server.video.config).encode())
            elif path == "handoff.m3u8" and self.server.video.handoff_manifest:
                self._response(200, "application/vnd.apple.mpegurl", self.server.video.handoff_manifest)
            elif path in ("game-pip.js", "hls.min.js"):
                self._response(200, "text/javascript", (ASSETS / path).read_bytes())
            elif path and path.startswith("media/"):
                self._media(path.removeprefix("media/"))
            else:
                self.send_error(404)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except FileNotFoundError:
            self.send_error(404)

    def do_POST(self):
        video = self.server.video
        if self._path() != "state" or self.headers.get("Origin") != f"http://{video.address}":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 1024:
                self.send_error(400)
                return
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                self.send_error(400)
                return
            self._response(200, "application/json", json.dumps(video.update(data)).encode())
        except (ValueError, TypeError):
            self.send_error(400)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _media(self, key):
        video = self.server.video
        with video.lock:
            upstream = video.urls.get(key)
        if not upstream:
            self.send_error(404)
            return
        headers = {"Accept-Encoding": "identity"}
        if video.plex.token:
            headers["X-Plex-Token"] = video.plex.token
        headers.update((name, value) for name, value in parse_qsl(urlsplit(upstream).query)
                       if name in SESSION_HEADERS)
        if self.headers.get("Range"):
            headers["Range"] = self.headers["Range"]
        sent_headers = False
        try:
            with video.plex.session.get(upstream, headers=headers, stream=True, allow_redirects=False,
                                        timeout=video.plex.timeout) as response:
                if response.status_code not in (200, 206):
                    video.record_upstream_error(f"upstream-http-{response.status_code}")
                    self.send_error(502 if response.status_code < 400 else response.status_code)
                    return
                content_type = response.headers.get("Content-Type", "application/octet-stream")
                if urlsplit(upstream).path.endswith(".m3u8") or "mpegurl" in content_type.lower():
                    content = bytearray()
                    for chunk in response.iter_content(chunk_size=65536):
                        content.extend(chunk)
                        if len(content) > 2 * 1024 * 1024:
                            video.record_upstream_error("playlist-too-large")
                            self.send_error(502)
                            return
                    manifest = video._playlist(upstream, content)
                    video.remember_hls_manifest(upstream, content)
                    sent_headers = True
                    self._response(200, "application/vnd.apple.mpegurl", manifest)
                    return
                self.send_response(response.status_code)
                self.send_header("Content-Type", content_type)
                for header in ("Content-Range", "Accept-Ranges"):
                    if header in response.headers:
                        self.send_header(header, response.headers[header])
                if "Content-Length" in response.headers and not response.headers.get("Content-Encoding"):
                    self.send_header("Content-Length", response.headers["Content-Length"])
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                sent_headers = True
                for chunk in response.iter_content(chunk_size=65536):
                    if video.closed.is_set():
                        break
                    self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except (ValueError, requests.RequestException, OSError) as error:
            if not sent_headers:
                video.record_upstream_error(f"upstream-{type(error).__name__}")
                self.send_error(502)
