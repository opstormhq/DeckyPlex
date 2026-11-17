import json
import html
import ipaddress
import os
import random
import re
import secrets
import socket
import sys
import threading
import time
import urllib.parse
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional

# Add py_modules to Python path so bundled dependencies (plexapi, requests) are available
_py_modules_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "py_modules")
if os.path.isdir(_py_modules_dir):
    if _py_modules_dir in sys.path:
        sys.path.remove(_py_modules_dir)
    sys.path.insert(0, _py_modules_dir)
    # Decky can preload an `xml` package before loading plugins, leaving its
    # package path pointed at a stripped stdlib directory. Add our bundled
    # ElementTree implementation to that already-loaded package explicitly.
    _bundled_xml_dir = os.path.join(_py_modules_dir, "xml")
    try:
        import xml
        xml_path = getattr(xml, "__path__", None)
        xml_paths = list(xml_path or [])
        xml.__path__ = [_bundled_xml_dir] + [p for p in xml_paths if p != _bundled_xml_dir]
    except ModuleNotFoundError:
        # The bundled `xml` package will be discovered from sys.path normally.
        pass

import decky

logger = decky.logger


DEFAULT_SETTINGS = {
    "plexamp_url": "",
    "plex_server_url": "",
    "plex_token": "",
    "selected_server_id": "",
    "selected_server_name": "",
    "selected_server_url": "",
    "selected_player_id": "",
    "selected_player_name": "",
    "grid_columns": 0,
    "volume": 50,
    "manual_server_url": "",
    "playback_target": "local",
    "connection_timeout": 8,
    "verify_tls": False,
    "logged_in_username": "",
    "server_access_token": "",
    "companion_id": "",
}

# Settings file path — Decky provides this directory
try:
    _settings_dir = decky.DECKY_PLUGIN_SETTINGS_DIR
except Exception:
    _settings_dir = ""
if not _settings_dir:
    _settings_dir = os.environ.get("DECKY_PLUGIN_SETTINGS_DIR", "")
if not _settings_dir:
    _settings_dir = os.path.join(os.environ.get("HOME", "/home/deck"), "homebrew", "settings", "DeckyPlex")
_settings_file = os.path.join(_settings_dir, "settings.json")


def _load_settings() -> Dict[str, Any]:
    """Load settings from JSON file, merging with defaults."""
    try:
        if os.path.exists(_settings_file):
            with open(_settings_file, "r") as f:
                saved = json.load(f)
            # Merge with defaults so new keys are present
            merged = {**DEFAULT_SETTINGS, **saved}
            # Filter to known keys only
            known_keys = set(DEFAULT_SETTINGS.keys())
            return {k: v for k, v in merged.items() if k in known_keys}
    except Exception as e:
        logger.error(f"Failed to load settings: {e}")
    return dict(DEFAULT_SETTINGS)


def _save_settings(settings: Dict[str, Any]) -> None:
    """Save settings to JSON file. Only saves known keys."""
    try:
        known_keys = set(DEFAULT_SETTINGS.keys())
        filtered = {k: v for k, v in settings.items() if k in known_keys}
        settings_dir = os.path.dirname(_settings_file)
        if settings_dir:
            os.makedirs(settings_dir, exist_ok=True)
        with open(_settings_file, "w") as f:
            json.dump(filtered, f, indent=4)
        logger.debug(f"Settings saved to: {_settings_file}")
    except Exception as e:
        logger.error(f"Failed to save settings: {e}")
        raise


# Store PIN state across calls
_pin_state: Dict[str, Any] = {}
_plex_cache_key = None
_plex_cache_instance = None
_companion_receiver = None


class PlexCompanionReceiver:
    """Minimal local Plex Companion player endpoint for Plexamp casting."""
    HTTP_PORT = int(os.environ.get("DECKYPLEX_COMPANION_PORT", "32435"))
    GDM_PORT = 32412

    def __init__(self, machine_id: str):
        self.machine_id = machine_id
        self.httpd = None
        self.http_thread = None
        self.gdm_socket = None
        self.gdm_thread = None
        self.lock = threading.Lock()
        self.commands: List[Dict[str, Any]] = []
        self.controllers: Dict[str, Dict[str, Any]] = {}
        self.timeline: Dict[str, Any] = {"state": "stopped", "time": 0, "duration": 0}
        self.error = ""

    def _response_headers(self) -> bytes:
        return ("HTTP/1.0 200 OK\r\n"
                "Content-Type: plex/media-player\r\n"
                "Name: DeckyPlex\r\n"
                f"Port: {self.HTTP_PORT}\r\n"
                "Product: DeckyPlex\r\n"
                "Protocol: plex\r\n"
                "Protocol-Version: 1\r\n"
                "Protocol-Capabilities: timeline,playback\r\n"
                f"Resource-Identifier: {self.machine_id}\r\n"
                "Device-Class: stb\r\n"
                "Version: 1.0.0\r\n\r\n").encode("utf-8")

    def enqueue(self, name: str, params: Dict[str, Any], client_host: str = "", client_id: str = "") -> None:
        try:
            command_id = int(params.get("commandID", ["0"])[0])
        except (TypeError, ValueError):
            command_id = 0
        with self.lock:
            self.commands.append({"command": name, "params": params, "client_host": client_host,
                                  "client_id": client_id, "received_at": time.time()})
            self.commands = self.commands[-32:]
            if client_id in self.controllers:
                self.controllers[client_id]["commandId"] = command_id
            else:
                for controller in self.controllers.values():
                    if controller.get("host") == client_host:
                        controller["commandId"] = command_id
        if name == "playMedia":
            logger.info("Companion received playMedia from %s: key=%s containerKey=%s",
                        client_host, params.get("key", [""])[0], params.get("containerKey", [""])[0])
        else:
            logger.info("Companion received %s from %s (commandID=%s)", name, client_host, command_id)

    def drain_commands(self) -> List[Dict[str, Any]]:
        with self.lock:
            commands, self.commands = self.commands, []
        return commands

    def subscribe(self, host: str, params: Dict[str, Any], client_id: str = "") -> None:
        try:
            port = int(params.get("port", [""])[0])
        except (TypeError, ValueError):
            return
        if host and port:
            try:
                command_id = int(params.get("commandID", ["0"])[0])
            except (TypeError, ValueError):
                command_id = 0
            controller = {"host": host, "port": port, "clientId": client_id, "commandId": command_id,
                          "protocol": params.get("protocol", ["http"])[0]}
            with self.lock:
                self.controllers[client_id or f"{host}:{port}"] = controller
                timeline = dict(self.timeline)
            self._notify_controllers([controller], timeline)

    def set_timeline(self, timeline: Dict[str, Any]) -> None:
        with self.lock:
            self.timeline = dict(timeline)
            controllers = list(self.controllers.values())
        self._notify_controllers(controllers, timeline)

    def _notify_controllers(self, controllers: List[Dict[str, Any]], timeline: Dict[str, Any]) -> None:
        if not controllers:
            return
        try:
            import requests
            for controller in controllers:
                scheme = "https" if controller.get("protocol") == "https" else "http"
                url = f"{scheme}://{controller['host']}:{controller['port']}/:/timeline"
                media = self._timeline_xml(timeline, controller.get("commandId", 0))
                try:
                    requests.post(url, data=media, timeout=0.35,
                                  headers={"Content-Type": "application/xml",
                                           "X-Plex-Client-Identifier": self.machine_id,
                                           "X-Plex-Device-Name": "DeckyPlex"})
                except Exception as exc:
                    logger.debug("Companion timeline delivery failed: %s", exc)
        except Exception as exc:
            logger.debug("Could not publish Companion timeline: %s", exc)

    @staticmethod
    def _timeline_xml(state: Dict[str, Any], command_id: int = 0) -> bytes:
        attrs = {
            "type": "music", "state": state.get("state", "stopped"),
            "time": int(state.get("time", 0)), "duration": int(state.get("duration", 0)),
            "key": state.get("key", ""), "machineIdentifier": state.get("serverId", ""),
            "address": state.get("address", ""), "port": state.get("port", 32400),
            "protocol": state.get("protocol", "http"), "token": state.get("token", ""),
            "volume": int(state.get("volume", 50)),
            "controllable": "volume,seekTo,skipNext,skipPrevious,stop,playPause",
        }
        if state.get("playQueueID"):
            attrs["playQueueID"] = state["playQueueID"]
            attrs["playQueueItemID"] = state.get("playQueueItemID", "")
            attrs["containerKey"] = state.get("containerKey", "")
            if state.get("playQueueVersion"):
                attrs["playQueueVersion"] = state["playQueueVersion"]
        values = " ".join(f'{name}=\"{html.escape(str(value), quote=True)}\"' for name, value in attrs.items())
        return (f'<MediaContainer location="fullScreenMusic" commandID="{int(command_id)}"><Timeline {values}/></MediaContainer>').encode("utf-8")

    def start(self) -> None:
        receiver = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, fmt, *args):
                logger.debug("Companion HTTP: " + fmt, *args)

            def _send(self, body: bytes = b"", content_type: str = "text/plain", status: int = 200):
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                if body:
                    self.wfile.write(body)

            def _is_lan_client(self) -> bool:
                try:
                    return ipaddress.ip_address(self.client_address[0]).is_private or ipaddress.ip_address(self.client_address[0]).is_loopback
                except ValueError:
                    return False

            def _local_address(self) -> str:
                try:
                    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                    try:
                        probe.connect((self.client_address[0], 9))
                        return probe.getsockname()[0]
                    finally:
                        probe.close()
                except Exception:
                    return "127.0.0.1"

            def do_OPTIONS(self):
                self.send_response(204)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Plex-Client-Identifier")
                self.end_headers()

            def do_GET(self):
                if not self._is_lan_client():
                    return self._send(b"Local network clients only", status=403)
                parsed = urllib.parse.urlparse(self.path)
                if parsed.path in ("/", "/resources"):
                    local_address = self._local_address()
                    root = (f'<MediaContainer friendlyName="DeckyPlex" machineIdentifier="{receiver.machine_id}">'
                            f'<Player title="DeckyPlex" machineIdentifier="{receiver.machine_id}" '
                            'product="DeckyPlex" version="1.0.0" platform="SteamOS" '
                            'protocolVersion="1" protocolCapabilities="timeline,playback" deviceClass="stb">'
                            f'<Connection protocol="http" address="{local_address}" port="{receiver.HTTP_PORT}" '
                            f'uri="http://{local_address}:{receiver.HTTP_PORT}" />'
                            '</Player></MediaContainer>').encode("utf-8")
                    return self._send(root, "application/xml")
                if parsed.path == "/player/timeline/subscribe":
                    receiver.subscribe(self.client_address[0], urllib.parse.parse_qs(parsed.query),
                                       self.headers.get("X-Plex-Client-Identifier", ""))
                    return self._send(b"", "application/xml")
                if parsed.path == "/player/timeline/unsubscribe":
                    with receiver.lock:
                        client_id = self.headers.get("X-Plex-Client-Identifier", "")
                        if client_id:
                            receiver.controllers.pop(client_id, None)
                        else:
                            receiver.controllers = {key: value for key, value in receiver.controllers.items()
                                                    if value.get("host") != self.client_address[0]}
                    return self._send(b"", "application/xml")
                if parsed.path == "/player/timeline/poll":
                    with receiver.lock:
                        state = dict(receiver.timeline)
                    try:
                        command_id = int(urllib.parse.parse_qs(parsed.query).get("commandID", ["0"])[0])
                    except (TypeError, ValueError):
                        command_id = 0
                    body = receiver._timeline_xml(state, command_id)
                    self.send_response(200)
                    self.send_header("Content-Type", "application/xml")
                    self.send_header("Content-Length", str(len(body)))
                    self.send_header("X-Plex-Client-Identifier", receiver.machine_id)
                    self.send_header("Access-Control-Expose-Headers", "X-Plex-Client-Identifier")
                    self.end_headers()
                    return self.wfile.write(body)
                if parsed.path.startswith("/player/playback/"):
                    command = parsed.path.rsplit("/", 1)[-1]
                    aliases = {"playMedia": "playMedia", "play": "play", "pause": "pause",
                               "stop": "stop", "skipNext": "next", "skipPrevious": "previous",
                               "seekTo": "seek", "setParameters": "parameters"}
                    if command not in aliases:
                        return self._send(b"", status=404)
                    receiver.enqueue(aliases[command], urllib.parse.parse_qs(parsed.query), self.client_address[0],
                                     self.headers.get("X-Plex-Client-Identifier", ""))
                    return self._send(b"", "application/xml")
                return self._send(b"", status=404)

            def do_POST(self):
                return self.do_GET()

        try:
            self.httpd = ThreadingHTTPServer(("0.0.0.0", self.HTTP_PORT), Handler)
            self.httpd.daemon_threads = True
            self.http_thread = threading.Thread(target=self.httpd.serve_forever, name="DeckyPlex-Companion-HTTP", daemon=True)
            self.http_thread.start()
            self.gdm_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            self.gdm_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            self.gdm_socket.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
            self.gdm_socket.bind(("0.0.0.0", self.GDM_PORT))
            self.gdm_thread = threading.Thread(target=self._serve_gdm, name="DeckyPlex-Companion-GDM", daemon=True)
            self.gdm_thread.start()
            logger.info("Plex Companion receiver active on TCP %s and GDM UDP %s", self.HTTP_PORT, self.GDM_PORT)
        except Exception as exc:
            self.error = str(exc)
            logger.error("Could not start Plex Companion receiver: %s", exc)
            self.stop()

    def _serve_gdm(self) -> None:
        if not self.gdm_socket:
            return
        self.gdm_socket.settimeout(1.0)
        response = self._response_headers()
        while self.gdm_socket:
            try:
                packet, address = self.gdm_socket.recvfrom(2048)
                if packet.startswith(b"M-SEARCH"):
                    self.gdm_socket.sendto(response, address)
            except socket.timeout:
                continue
            except OSError:
                break
            except Exception as exc:
                logger.debug("Plex GDM responder error: %s", exc)

    def stop(self) -> None:
        server, self.httpd = self.httpd, None
        if server:
            server.shutdown()
            server.server_close()
        sock, self.gdm_socket = self.gdm_socket, None
        if sock:
            try:
                sock.close()
            except Exception:
                pass


class PlexHTTP:
    """Small Decky-facing adapter around the bundled python-plexapi SDK."""

    def __init__(self, base_url: str, token: str, timeout: int = 8, verify_tls: bool = False,
                 account_token: str = ""):
        import requests
        from plexapi.server import PlexServer

        self.base_url = base_url.rstrip("/")
        self.token = token
        self.account_token = account_token or token
        self.timeout = timeout
        self.session = requests.Session()
        self.session.verify = bool(verify_tls)
        self._remote_client_cache = {}
        self.sdk = PlexServer(self.base_url, token, session=self.session, timeout=timeout)
        self._account = None

    @property
    def account(self):
        if self._account is None:
            from plexapi.myplex import MyPlexAccount
            self._account = MyPlexAccount(token=self.account_token, session=self.session, timeout=self.timeout)
        return self._account

    @staticmethod
    def _item_dict(item: Any) -> Dict[str, Any]:
        def attr(name, default=""):
            value = getattr(item, name, default)
            return default if value is None else value

        item_type = attr("type")
        artist = attr("grandparentTitle")
        if item_type == "album":
            artist = artist or attr("parentTitle")
            if not artist:
                try:
                    artist = item.artist().title or ""
                except Exception:
                    artist = ""

        return {
            "id": str(attr("ratingKey")), "key": attr("key"),
            "title": attr("title"), "type": item_type, "artist": artist,
            "thumb": attr("thumbUrl"), "art": attr("artUrl"),
            "summary": attr("summary"), "year": attr("year"),
            "index": attr("index"), "parentTitle": attr("parentTitle"),
            "grandparentTitle": attr("grandparentTitle"),
            "leafCount": attr("leafCount", 0), "viewCount": attr("viewCount", 0),
            "duration": attr("duration", 0), "sectionId": str(attr("librarySectionID", "") or ""),
        }

    def discover_players(self) -> List[Dict[str, str]]:
        sessions = {}
        try:
            for session in self.sdk.sessions():
                player = getattr(session, "player", None)
                if player and player.machineIdentifier:
                    sessions[player.machineIdentifier] = session
        except Exception as e:
            logger.debug("Unable to include active session state in player list: %s", e)
        players = {}
        for client in self.sdk.clients():
            session = sessions.get(client.machineIdentifier)
            players[client.machineIdentifier] = {
                "title": client.title or "", "product": client.product or "",
                "machineIdentifier": client.machineIdentifier or "",
                "key": client.machineIdentifier or "",
                "state": getattr(session, "state", "idle") or "idle",
                "platform": client.platform or "",
                "available": True,
            }
        # /clients only contains devices currently connected to this server.
        # Plex account resources also expose online clients that have not yet
        # opened this library, including clients on another LAN.
        try:
            for resource in self.account.resources():
                provides = set((resource.provides or "").split(","))
                machine_id = resource.clientIdentifier or ""
                if not machine_id or not (provides & {"client", "player", "pubsub-player"}):
                    continue
                if machine_id in players:
                    continue
                players[machine_id] = {
                    "title": resource.name or resource.product or "Plex player",
                    "product": resource.product or "",
                    "machineIdentifier": machine_id,
                    "key": machine_id,
                    "state": "idle" if resource.presence else "offline",
                    "platform": resource.platform or "",
                    "available": True,
                }
        except Exception as e:
            logger.debug("Could not discover Plex account player resources: %s", e)
        # Some Plex clients appear in the account's device registry but are
        # absent from /clients and /resources until they contact a server.
        try:
            for device in self.account.devices():
                provides = set((device.provides or "").split(","))
                machine_id = device.clientIdentifier or ""
                if not machine_id or machine_id in players or not (provides & {"client", "player", "pubsub-player"}):
                    continue
                players[machine_id] = {
                    "title": device.name or device.product or "Plex player",
                    "product": device.product or "",
                    "machineIdentifier": machine_id,
                    "key": machine_id,
                    "state": "registered",
                    "platform": device.platform or "",
                    "available": False,
                }
        except Exception as e:
            logger.debug("Could not discover registered Plex devices: %s", e)
        return list(players.values())

    def get_track_page(self, section_id: str, offset: int = 0, limit: int = 25,
                       randomize: bool = False) -> Dict[str, Any]:
        """Fetch one SDK-paginated page of tracks for shuffle playback."""
        section = self.sdk.library.sectionByID(int(section_id))
        if getattr(section, "type", "") != "artist":
            raise ValueError("Selected library is not a music library")
        limit = max(1, min(int(limit), 100))
        offset = max(0, int(offset)) if not randomize else 0
        # Fetch only one SDK page. Avoid a separate count request here because
        # some Plex servers treat a zero-sized container as their default size.
        sort = "random" if randomize else "titleSort:asc"
        tracks = section.search(libtype="track", sort=sort, container_start=offset,
                                container_size=limit, maxresults=limit)
        items = [self._item_dict(item) for item in tracks if getattr(item, "type", "") == "track"]
        return {"items": items, "has_more": len(items) == limit}

    def get_sessions(self) -> List[Any]:
        return self.sdk.sessions()

    def _client(self, machine_id: str):
        client = self._remote_client_cache.get(machine_id)
        if client is not None:
            return client
        client = next((c for c in self.sdk.clients() if c.machineIdentifier == machine_id), None)
        if client is None:
            try:
                account = self.account
                resource = next((r for r in account.resources()
                                 if r.clientIdentifier == machine_id
                                 and set((r.provides or "").split(",")) & {"client", "player", "pubsub-player"}), None)
                if resource:
                    client = resource.connect(timeout=5, locations=["local", "remote", "relay"])
                    self._remote_client_cache[machine_id] = client
                else:
                    device = next((item for item in account.devices()
                                   if item.clientIdentifier == machine_id), None)
                    if device:
                        client = device.connect(timeout=5)
                        self._remote_client_cache[machine_id] = client
            except Exception as e:
                logger.debug("Could not connect to Plex player resource %s: %s", machine_id, e)
        if client is None:
            raise RuntimeError("Plex player is no longer connected")
        return client

    def play(self, machine_id: str) -> None:
        self._client(machine_id).play(mtype="music")

    def pause(self, machine_id: str) -> None:
        self._client(machine_id).pause(mtype="music")

    def skip_next(self, machine_id: str) -> None:
        self._client(machine_id).skipNext(mtype="music")

    def skip_previous(self, machine_id: str) -> None:
        self._client(machine_id).skipPrevious(mtype="music")

    def set_volume(self, machine_id: str, volume: int) -> None:
        self._client(machine_id).setVolume(volume, mtype="music")

    def play_remote_queue(self, machine_id: str, rating_keys: List[str], start_rating_key: str) -> None:
        client = self._client(machine_id)
        track_ids = [int(key) for key in rating_keys]
        tracks = []
        # PlexAPI supports fetching multiple metadata keys in one request. Keep
        # each batch bounded so large shuffle queues do not create oversized URLs.
        for start in range(0, len(track_ids), 200):
            tracks.extend(self.sdk.fetchItems(track_ids[start:start + 200]))
        tracks = [track for track in tracks if getattr(track, "type", "") == "track"]
        if not tracks:
            raise ValueError("The selected queue contains no playable tracks")
        start_item = next((track for track in tracks if str(track.ratingKey) == str(start_rating_key)), tracks[0])
        # Modern clients expose createPlayQueue on their own Companion endpoint.
        # Plex Media Server's /player proxy does not implement this newer command
        # consistently (it returns 404 even for a live /clients player). Try the
        # direct SDK client first, then use PlexAPI's legacy playMedia flow, which
        # creates the queue on the server and sends its containerKey to the player.
        logger.info("Sending queue to %s (%s) via direct Companion connection", client.title, machine_id)
        try:
            client.proxyThroughServer(False)
            client.createPlayQueue(self.sdk, tracks, startItem=start_item, shuffle=False, repeat=False)
            return
        except Exception as direct_error:
            logger.warning("Direct createPlayQueue failed for %s: %s; trying SDK playMedia", machine_id, direct_error)

        play_queue = self.sdk.createPlayQueue(
            tracks, startItem=start_item, shuffle=False, repeat=False,
            includeChapters=False, includeRelated=False,
        )
        # The SDK constructs the correct /playback/playMedia command including
        # server address, transient token, selected key and containerKey.
        # Use server proxy as a fallback for players that aren't directly reachable.
        try:
            client.proxyThroughServer(False)
            client.playMedia(play_queue)
        except Exception as direct_error:
            logger.warning("Direct playMedia failed for %s: %s; retrying via Plex server", machine_id, direct_error)
            client.proxyThroughServer(True, server=self.sdk)
            client.playMedia(play_queue)

    def remote_player_status(self, machine_id: str) -> Dict[str, Any]:
        client = self._client(machine_id)
        try:
            for session in self.sdk.sessions():
                player = getattr(session, "player", None)
                if not player or player.machineIdentifier != machine_id or getattr(session, "type", "") != "track":
                    continue
                return {
                    "state": getattr(session, "state", "playing") or "playing",
                    "track": {
                        "id": str(getattr(session, "ratingKey", "") or ""),
                        "title": getattr(session, "title", "") or "",
                        "artist": getattr(session, "grandparentTitle", "") or "",
                        "album": getattr(session, "parentTitle", "") or "",
                        "duration": getattr(session, "duration", 0) or 0,
                        "thumb": getattr(session, "thumbUrl", "") or "",
                    },
                    "progress": (getattr(session, "viewOffset", 0) or 0) / 1000,
                    "duration": (getattr(session, "duration", 0) or 0) / 1000,
                    "volume": getattr(client, "volume", 50) or 50,
                }
        except Exception as e:
            logger.warning("Could not read remote player status for %s: %s", machine_id, e)
            return {"state": "error", "error": str(e)}
        return {"state": "stopped", "track": None, "progress": 0, "duration": 0,
                "volume": getattr(client, "volume", 50) or 50}

    def control_remote_player(self, machine_id: str, command: str, value: int = 0) -> None:
        client = self._client(machine_id)
        # A discovered /clients endpoint is a live Companion URL. Talk to it
        # directly; proxying through PMS can produce false 404s for commands.
        def send():
            if command == "play":
                client.play(mtype="music")
            elif command == "pause":
                client.pause(mtype="music")
            elif command == "stop":
                client.stop(mtype="music")
            elif command == "next":
                client.skipNext(mtype="music")
            elif command == "previous":
                client.skipPrevious(mtype="music")
            elif command == "seek":
                client.seekTo(max(0, int(value)), mtype="music")
            elif command == "volume":
                client.setVolume(max(0, min(100, int(value))), mtype="music")
            else:
                raise ValueError("Unsupported remote player command")
        client.proxyThroughServer(False)
        try:
            send()
        except Exception as direct_error:
            logger.warning("Direct %s command failed for %s: %s; retrying via Plex server",
                           command, machine_id, direct_error)
            client.proxyThroughServer(True, server=self.sdk)
            send()

    def get_library_sections(self) -> List[Dict[str, Any]]:
        return [{"id": str(section.key), "name": section.title, "type": section.type}
                for section in self.sdk.library.sections()]

    def get_section_contents(self, section_id: str, type_filter: str = "", limit: int = 100,
                             offset: int = 0) -> Dict[str, Any]:
        section = self.sdk.library.sectionByID(int(section_id))
        item_type = type_filter if type_filter in ("artist", "album", "track") else "artist"
        limit = max(1, min(int(limit), 250))
        offset = max(0, int(offset))
        items = [self._item_dict(item) for item in section.search(
            libtype=item_type, sort="titleSort:asc", container_start=offset,
            container_size=limit, maxresults=limit)]
        return {"items": items, "has_more": len(items) == limit}

    def get_shuffled_tracks(self, section_id: str) -> List[Dict[str, Any]]:
        """Return every track in a music section in randomized queue order."""
        section = self.sdk.library.sectionByID(int(section_id))
        if getattr(section, "type", "") != "artist":
            raise ValueError("Selected library is not a music library")
        tracks = section.search(libtype="track", sort="titleSort:asc")
        if not tracks:
            return []
        random.shuffle(tracks)
        return [self._item_dict(track) for track in tracks if getattr(track, "type", "") == "track"]

    def get_metadata_children(self, metadata_id: str) -> List[Dict[str, Any]]:
        item = self.sdk.fetchItem(int(metadata_id))
        if getattr(item, "type", "") == "artist":
            try:
                children = item.albums(sort="titleSort:asc")
            except Exception:
                children = []
            if not children:
                children = item.fetchItems(f"{item.key}/children")
        elif getattr(item, "type", "") == "album":
            children = item.tracks()
            if not children:
                children = item.fetchItems(f"{item.key}/children")
        else:
            children = item.fetchItems(f"{item.key}/children")
        return [self._item_dict(child) for child in children]

    def get_artist_tracks(self, artist_id: str) -> List[Dict[str, Any]]:
        artist = self.sdk.fetchItem(int(artist_id))
        if getattr(artist, "type", "") != "artist":
            raise ValueError("Selected Plex item is not an artist")
        tracks = artist.tracks(maxresults=1000)
        return [self._item_dict(track) for track in tracks]

    def get_recently_played(self, section_id: str = "", limit: int = 50) -> List[Dict[str, Any]]:
        """Return recently played tracks using PlexAPI's server history endpoint."""
        history = self.sdk.history(
            maxresults=max(1, min(int(limit), 100)),
            librarySectionID=int(section_id) if section_id else None,
        )
        result = []
        for history_item in history:
            if getattr(history_item, "type", "") != "track":
                continue
            try:
                source = history_item.source()
                if source is not None:
                    history_item = source
            except Exception:
                pass
            result.append(self._item_dict(history_item))
        return result

    def get_recently_added(self, section_id: str, limit: int = 50) -> List[Dict[str, Any]]:
        """Return the newest albums in a music library, using PlexAPI sorting."""
        section = self.sdk.library.sectionByID(int(section_id))
        albums = section.search(libtype="album", sort="addedAt:desc", maxresults=max(1, min(int(limit), 100)))
        return [self._item_dict(album) for album in albums]

    def get_audio_playlists(self, limit: int = 100) -> List[Dict[str, Any]]:
        playlists = self.sdk.playlists(playlistType="audio", sort="titleSort:asc")
        result = []
        for playlist in playlists[:max(1, min(int(limit), 100))]:
            composite = getattr(playlist, "composite", "") or ""
            result.append({
                "id": str(playlist.ratingKey), "key": playlist.key,
                "title": playlist.title or "Untitled playlist", "type": "playlist",
                "thumb": self.sdk.url(composite, includeToken=True) if composite else "",
                "summary": playlist.summary or "", "leafCount": playlist.leafCount or 0,
                "duration": playlist.duration or 0,
            })
        return result

    def add_track_to_playlist(self, playlist_id: str, rating_key: str) -> Dict[str, Any]:
        """Add one library track to an existing audio playlist via PlexAPI."""
        playlist = next((item for item in self.sdk.playlists(playlistType="audio")
                         if str(item.ratingKey) == str(playlist_id)), None)
        if playlist is None:
            raise ValueError("Audio playlist not found")
        track = self.sdk.fetchItem(int(rating_key))
        playlist.addItems([track])
        return {"success": True, "playlist": playlist.title}

    def remove_track_from_playlist(self, playlist_id: str, rating_key: str) -> Dict[str, Any]:
        """Remove a library track from an audio playlist using PlexAPI."""
        playlist = next((item for item in self.sdk.playlists(playlistType="audio")
                         if str(item.ratingKey) == str(playlist_id)), None)
        if playlist is None:
            raise ValueError("Audio playlist not found")
        track = self.sdk.fetchItem(int(rating_key))
        playlist.removeItems([track])
        return {"success": True, "playlist": playlist.title}

    def create_audio_playlist(self, title: str, rating_key: str) -> Dict[str, Any]:
        """Create an audio playlist containing the requested track via PlexAPI."""
        title = str(title or "").strip()
        if not title:
            raise ValueError("Enter a playlist name")
        track = self.sdk.fetchItem(int(rating_key))
        playlist = self.sdk.createPlaylist(title, items=[track])
        return {"success": True, "playlist": playlist.title, "id": str(playlist.ratingKey)}

    def delete_audio_playlist(self, playlist_id: str) -> Dict[str, Any]:
        """Delete an audio playlist using PlexAPI."""
        playlist = next((item for item in self.sdk.playlists(playlistType="audio")
                         if str(item.ratingKey) == str(playlist_id)), None)
        if playlist is None:
            raise ValueError("Audio playlist not found")
        title = playlist.title or "Untitled playlist"
        playlist.delete()
        return {"success": True, "playlist": title, "id": str(playlist_id)}

    def get_playlist_tracks(self, playlist_id: str, limit: int = 100) -> List[Dict[str, Any]]:
        playlists = self.sdk.playlists(playlistType="audio")
        playlist = next((item for item in playlists if str(item.ratingKey) == str(playlist_id)), None)
        if playlist is None:
            raise ValueError("Audio playlist not found")
        return [self._item_dict(item) for item in playlist.items(libtype="track")[:max(1, min(int(limit), 200))]]

    def search_library(self, query: str, section_id: str = "", limit: int = 20) -> List[Dict[str, Any]]:
        if section_id:
            results = self.sdk.library.sectionByID(int(section_id)).search(title=query, maxresults=limit)
        else:
            results = self.sdk.search(query, mediatype="audio", limit=limit)
        return [self._item_dict(item) for item in results]

    def get_hubs(self, section_ids: Optional[List[str]] = None) -> List[Dict[str, Any]]:
        hubs = self.sdk.library.hubs(sectionID=section_ids or None)
        result = []
        for hub in hubs:
            items = [self._item_dict(item) for item in hub.items()]
            if items:
                result.append({"title": hub.title or "", "key": hub.key or "",
                               "type": hub.type or "", "items": items})
        return result

    def get_server_identity(self) -> Dict[str, str]:
        return {"machineIdentifier": self.sdk.machineIdentifier or "",
                "friendlyName": self.sdk.friendlyName or "", "version": self.sdk.version or ""}

    def get_stream_urls(self, rating_key: str) -> Dict[str, str]:
        """Prefer PlexAPI's direct media URL for common codecs, with MP3 transcode fallback."""
        track = self.sdk.fetchItem(int(rating_key))
        if getattr(track, "type", "") != "track":
            raise ValueError("Selected Plex item is not a music track")
        media = list(getattr(track, "media", []) or [])
        part = next((part for item in media for part in (getattr(item, "parts", []) or [])
                     if getattr(part, "key", "")), None)
        direct_url = self.sdk.url(part.key, includeToken=True) if part else ""
        codec = str(getattr(media[0], "audioCodec", "") or "").lower() if media else ""
        # The transcoder requires a client identifier. Reuse PlexAPI's
        # configured identifier and advertise an MP3 target profile so the
        # response is an audio/mpeg byte stream, not a manifest/error document.
        client_identifier = self.sdk._headers().get("X-Plex-Client-Identifier", "deckyplex")
        # Use AAC in an MP4 container as the browser-safe alternate. Some MP3
        # parts in Plex libraries are legal MPEG audio but fail intermittently
        # in the embedded media element; a server-side AAC transcode avoids
        # relying on that source file's exact MPEG framing/profile.
        profile_extra = (
            "add-transcode-target(type=musicProfile&context=streaming&"
            "protocol=http&container=m4a&audioCodec=aac)"
        )
        params = urllib.parse.urlencode({
            "path": track.key, "mediaIndex": 0, "partIndex": 0,
            "protocol": "http", "audioCodec": "aac",
            "directPlay": 0, "directStream": 0, "directStreamAudio": 0,
            "musicBitrate": 320,
            "X-Plex-Client-Identifier": client_identifier,
            "X-Plex-Client-Profile-Name": "Generic",
            "X-Plex-Client-Profile-Extra": profile_extra,
            "X-Plex-Platform": "Chrome",
            "X-Plex-Product": "DeckyPlex",
            "X-Plex-Version": "1.0.0",
        })
        transcode_url = self.sdk.url(f"/music/:/transcode/universal/start.m4a?{params}", includeToken=True)
        if direct_url and codec in ("mp3", "flac"):
            return {"stream_url": direct_url, "fallback_stream_url": transcode_url,
                    "stream_mode": f"direct-{codec}"}
        return {"stream_url": transcode_url,
                "fallback_stream_url": direct_url if codec in ("mp3", "flac") else "",
                "stream_mode": "transcode-aac"}

    def prepare_companion_playback(self, key: str, container_key: str = "") -> Dict[str, Any]:
        parsed = urllib.parse.urlparse(key or "")
        match = re.search(r"/library/metadata/(\d+)", parsed.path or key or "")
        if not match:
            raise ValueError("Plexamp sent an unsupported media key")
        rating_key = match.group(1)
        item = self.sdk.fetchItem(int(rating_key))
        if getattr(item, "type", "") != "track":
            raise ValueError("Plexamp target currently supports music tracks only")
        queue = [self._item_dict(item)]
        active_queue_id = ""
        active_item_id = ""
        active_queue_version = ""
        queue_id = re.search(r"/playQueues/(\d+)", container_key or "")
        if queue_id:
            try:
                from plexapi.playqueue import PlayQueue
                play_queue = PlayQueue.get(self.sdk, int(queue_id.group(1)), window=200, includeBefore=True, includeAfter=True)
                active_queue_id = str(play_queue.playQueueID or "")
                active_queue_version = str(play_queue.playQueueVersion or "")
                tracks = []
                for track in play_queue.items:
                    if getattr(track, "type", "") != "track":
                        continue
                    track_dict = self._item_dict(track)
                    track_dict["playQueueItemID"] = str(getattr(track, "playQueueItemID", "") or "")
                    tracks.append(track_dict)
                    if str(track.ratingKey) == rating_key:
                        active_item_id = track_dict["playQueueItemID"]
                if tracks:
                    queue = tracks
            except Exception as exc:
                logger.warning("Could not load incoming Plex play queue %s: %s", queue_id.group(1), exc)
        streams = self.get_stream_urls(rating_key)
        selected = self._item_dict(item)
        selected["playQueueItemID"] = active_item_id
        return {"success": True, "track": selected, "queue": queue,
                "play_queue_id": active_queue_id,
                "play_queue_item_id": active_item_id,
                "play_queue_version": active_queue_version,
                "container_key": f"/playQueues/{active_queue_id}?window=200&own=1" if active_queue_id else "",
                **streams}

    def inspect_stream(self, rating_key: str, stream_url: str) -> Dict[str, Any]:
        """Read a tiny range from the exact stream URL the client rejected."""
        expected = urllib.parse.urlparse(self.sdk._baseurl)
        supplied = urllib.parse.urlparse(stream_url)
        if supplied.scheme not in ("http", "https") or supplied.netloc != expected.netloc:
            raise ValueError("Stream diagnostic URL does not match the connected Plex server")
        response = self.sdk._session.get(
            stream_url, headers={"Range": "bytes=0-255"}, stream=True, timeout=(4, 8)
        )
        try:
            body = next(response.iter_content(256), b"")
            content_type = response.headers.get("Content-Type", "")
            result = {
                "status": response.status_code,
                "content_type": content_type,
                "content_range": response.headers.get("Content-Range", ""),
                "prefix_hex": body[:32].hex(),
            }
            if "text" in content_type or "json" in content_type or "xml" in content_type:
                result["body_preview"] = body[:256].decode("utf-8", errors="replace")
            return result
        finally:
            response.close()


class Plugin:
    """Decky plugin backend for Plexamp integration."""

    async def _main(self):
        """Called when the plugin is loaded."""
        logger.info(f"DeckyPlex plugin loaded, settings file: {_settings_file}")
        settings_dir = os.path.dirname(_settings_file)
        if settings_dir:
            logger.info(f"Settings dir exists: {os.path.exists(settings_dir)}")
            try:
                os.makedirs(settings_dir, exist_ok=True)
                logger.info(f"Settings dir ensured: {settings_dir}")
            except Exception as e:
                logger.error(f"Failed to create settings dir: {e}")
        else:
            logger.warning(f"Settings file has no directory: {_settings_file}")
        global _companion_receiver
        settings = _load_settings()
        receiver_id = str(settings.get("companion_id") or "").strip()
        if not receiver_id:
            receiver_id = str(uuid.uuid4())
            settings["companion_id"] = receiver_id
            _save_settings(settings)
        _companion_receiver = PlexCompanionReceiver(receiver_id)
        _companion_receiver.start()

    async def _unload(self):
        """Called when the plugin is unloaded."""
        global _companion_receiver
        if _companion_receiver:
            _companion_receiver.stop()
            _companion_receiver = None
        logger.info("DeckyPlex plugin unloaded")

    async def _uninstall(self):
        """Called when the plugin is uninstalled. Clean up saved settings."""
        logger.info("DeckyPlex plugin uninstalled")
        try:
            if os.path.exists(_settings_file):
                os.remove(_settings_file)
                logger.info(f"Removed settings file: {_settings_file}")
            settings_dir = os.path.dirname(_settings_file)
            if os.path.exists(settings_dir) and not os.listdir(settings_dir):
                os.rmdir(settings_dir)
                logger.info(f"Removed empty settings directory: {settings_dir}")
        except Exception as e:
            logger.error(f"Failed to clean up settings on uninstall: {e}")

    async def log_message(self, message: str) -> Dict[str, Any]:
        """Log a message from the frontend to the backend log file.
        
        Used for debugging browser-side events (audio playback) that don't
        appear in backend logs.
        """
        logger.info(f"[frontend] {message}")
        return {"ok": True}

    async def health_check(self) -> Dict[str, Any]:
        """Simple health check to verify the backend is running."""
        return {"ok": True, "settings_file": _settings_file}

    async def get_settings(self) -> Dict[str, Any]:
        """Return UI settings without exposing Plex authentication tokens."""
        settings = _load_settings()
        return self._public_settings(settings)

    @staticmethod
    def _public_settings(settings: Dict[str, Any]) -> Dict[str, Any]:
        result = dict(settings)
        result.pop("companion_id", None)
        result["has_plex_token"] = bool(settings.get("plex_token"))
        result["plex_token"] = ""
        result["server_access_token"] = ""
        return result

    async def set_settings(self, settings: Dict[str, Any]) -> Dict[str, Any]:
        """Save user-editable preferences without accepting auth tokens from the UI."""
        try:
            merged = _load_settings()
            for key in ("selected_player_id", "selected_player_name", "manual_server_url", "grid_columns", "volume",
                        "playback_target", "connection_timeout", "verify_tls"):
                if key in settings:
                    merged[key] = settings[key]
            merged["manual_server_url"] = self._normalize_server_url(merged.get("manual_server_url", ""))
            merged["playback_target"] = "remote" if merged.get("playback_target") == "remote" and merged.get("selected_player_id") else "local"
            try:
                merged["connection_timeout"] = max(4, min(30, int(merged.get("connection_timeout", 8))))
            except (TypeError, ValueError):
                merged["connection_timeout"] = 8
            merged["verify_tls"] = bool(merged.get("verify_tls", False))
            try:
                merged["volume"] = max(0, min(100, int(merged.get("volume", 50))))
            except (TypeError, ValueError):
                merged["volume"] = 50
            try:
                columns = int(merged.get("grid_columns", 0))
                merged["grid_columns"] = columns if columns == 0 else max(3, min(8, columns))
            except (TypeError, ValueError):
                merged["grid_columns"] = 0
            _save_settings(merged)
            return self._public_settings(merged)
        except Exception as e:
            logger.error(f"Failed to save settings: {e}")
            return {"error": str(e)}

    async def logout(self) -> Dict[str, Any]:
        """Clear Plex credentials and selected devices while keeping UI preferences."""
        global _plex_cache_key, _plex_cache_instance
        settings = _load_settings()
        settings.update({
            "plex_token": "", "server_access_token": "", "logged_in_username": "",
            "plexamp_url": "", "selected_server_id": "", "selected_server_name": "",
            "selected_server_url": "", "selected_player_id": "", "selected_player_name": "",
            "playback_target": "local",
        })
        _save_settings(settings)
        _plex_cache_key = None
        _plex_cache_instance = None
        return self._public_settings(settings)

    async def select_server(self, server_id: str) -> Dict[str, Any]:
        """Resolve a discovered Plex resource and keep its access token backend-side."""
        settings = _load_settings()
        token = settings.get("plex_token", "").strip()
        if not token:
            return {"success": False, "error": "Log in to Plex before selecting a server."}
        try:
            info = self._account_resources(token)
            server = next((item for item in info.get("servers", []) if str(item.get("id")) == str(server_id)), None)
            if not server:
                return {"success": False, "error": "That Plex server is no longer available. Refresh the list."}
            settings.update({
                "selected_server_id": server["id"],
                "selected_server_name": server.get("name", ""),
                "selected_server_url": server.get("base_url", ""),
                "server_access_token": server.get("access_token") or token,
            })
            _save_settings(settings)
            global _plex_cache_key, _plex_cache_instance
            _plex_cache_key = None
            _plex_cache_instance = None
            return {"success": True, "settings": self._public_settings(settings)}
        except Exception as e:
            logger.error("Failed to select Plex server %s: %s", server_id, e, exc_info=True)
            return {"success": False, "error": str(e)}

    @staticmethod
    def _normalize_server_url(value: str) -> str:
        value = str(value or "").strip()
        if not value:
            return ""
        if "://" not in value:
            value = f"http://{value}"
        parsed = urllib.parse.urlparse(value)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            raise ValueError("Enter a server IP or an http(s) URL")
        if parsed.path not in ("", "/") or parsed.query or parsed.fragment or parsed.username:
            raise ValueError("Enter only the server address, without a path or credentials")
        try:
            port = parsed.port or 32400
        except ValueError as e:
            raise ValueError("Server port must be between 1 and 65535") from e
        hostname = f"[{parsed.hostname}]" if ":" in parsed.hostname else parsed.hostname
        return f"{parsed.scheme}://{hostname}:{port}"

    def _get_plex(self) -> Optional[PlexHTTP]:
        """Connect to the Plex server using saved settings."""
        global _plex_cache_key, _plex_cache_instance
        settings = _load_settings()
        url = self._get_plex_server_url()
        # Use server-specific access token if available, otherwise fall back to user token
        token = self._get_server_access_token() or settings.get("plex_token", "").strip()
        account_token = settings.get("plex_token", "").strip()
        if not url or not token:
            # Only log once at DEBUG level — this is expected when no server is configured
            logger.debug(f"_get_plex: missing url or token (url={bool(url)}, token={bool(token)}), plex_token in settings={bool(settings.get('plex_token', '').strip())}")
            return None
        timeout = int(settings.get("connection_timeout", 8) or 8)
        verify_tls = bool(settings.get("verify_tls", False))
        cache_key = (url.rstrip("/"), token, account_token, timeout, verify_tls)
        if _plex_cache_instance is not None and _plex_cache_key == cache_key:
            return _plex_cache_instance
        try:
            plex = PlexHTTP(url, token, timeout=timeout, verify_tls=verify_tls,
                            account_token=account_token)
            # PlexServer validates the connection during construction and keeps
            # the authenticated session for every subsequent SDK request.
            logger.debug(f"_get_plex: connected to server at {url}")
            _plex_cache_key = cache_key
            _plex_cache_instance = plex
            return plex
        except Exception as e:
            logger.debug(f"_get_plex: cannot connect to {url}: {e}")
            return None

    def _find_plexamp_player(self, plex: PlexHTTP) -> Optional[Dict[str, str]]:
        """Find the Plexamp/Caldera player on the Plex server."""
        settings = _load_settings()
        selected_id = settings.get("selected_player_id", "").strip()

        try:
            clients = plex.discover_players()
            # If a specific player is selected, match by machineIdentifier
            if selected_id:
                for client in clients:
                    if client.get("machineIdentifier") == selected_id:
                        return client
            # Otherwise, find the first Plexamp/Caldera player
            for client in clients:
                product = (client.get("product") or "").lower()
                if "caldera" in product or "plexamp" in product:
                    return client
        except Exception as e:
            logger.error(f"Failed to find Plexamp player: {e}")
        return None

    async def discover_players(self) -> Dict[str, Any]:
        """List all connected Plex clients for player selection."""
        plex = self._get_plex()
        if not plex:
            return {"players": [], "error": "Not connected to Plex server"}
        try:
            clients = plex.discover_players()
            players = []
            for client in clients:
                players.append({
                    "name": client.get("title") or client.get("product") or "Unknown",
                    "product": client.get("product", ""),
                    "machineIdentifier": client.get("machineIdentifier", ""),
                    "key": client.get("key", ""),
                    "state": client.get("state", "idle"),
                    "platform": client.get("platform", ""),
                })
            return {"players": players}
        except Exception as e:
            logger.error(f"Failed to discover players: {e}")
            return {"players": [], "error": str(e)}

    async def play_remote_queue(self, machine_id: str, rating_keys: List[str], start_rating_key: str) -> Dict[str, Any]:
        plex = self._get_plex()
        if not plex:
            return {"success": False, "error": "Not connected to Plex server"}
        try:
            plex.play_remote_queue(machine_id, rating_keys, start_rating_key)
            return {"success": True, "machineIdentifier": machine_id}
        except Exception as e:
            logger.error("Failed to start remote Plex queue on %s: %s", machine_id, e, exc_info=True)
            return {"success": False, "error": str(e)}

    async def control_remote_player(self, machine_id: str, command: str, value: int = 0) -> Dict[str, Any]:
        plex = self._get_plex()
        if not plex:
            return {"success": False, "error": "Not connected to Plex server"}
        try:
            plex.control_remote_player(machine_id, command, value)
            return {"success": True}
        except Exception as e:
            logger.error("Remote player command %s failed for %s: %s", command, machine_id, e, exc_info=True)
            return {"success": False, "error": str(e)}

    async def get_remote_player_status(self, machine_id: str) -> Dict[str, Any]:
        plex = self._get_plex()
        if not plex:
            return {"state": "disconnected", "error": "Not connected to Plex server"}
        try:
            return plex.remote_player_status(machine_id)
        except Exception as e:
            logger.error("Failed to read remote player %s: %s", machine_id, e)
            return {"state": "error", "error": str(e)}

    async def get_playback_state(self) -> Dict[str, Any]:
        """Get current playback state from server sessions.
        
        Uses /status/sessions to check what's playing, which works regardless
        of which player is controlling playback (e.g., Plexamp on iPhone).
        """
        plex = self._get_plex()
        if not plex:
            return {"state": "disconnected", "error": "Not connected to Plex server"}
        try:
            sessions = plex.get_sessions()
            for meta in sessions:
                if getattr(meta, "type", "") == "track":
                    return {"state": "playing"}
            return {"state": "stopped"}
        except Exception as e:
            logger.error(f"Failed to get playback state: {e}")
            return {"state": "error", "error": str(e)}

    async def get_current_track(self) -> Dict[str, Any]:
        """Get the currently playing track information from server sessions.
        
        Uses /status/sessions which works regardless of which player is controlling playback.
        """
        plex = self._get_plex()
        if not plex:
            return {"error": "Not connected to Plex server"}
        try:
            sessions = plex.get_sessions()
            for meta in sessions:
                if getattr(meta, "type", "") == "track":
                    return {
                        "title": meta.title or "",
                        "artist": meta.grandparentTitle or "",
                        "album": meta.parentTitle or "",
                        "duration": meta.duration or 0,
                        "thumb": meta.thumbUrl or "",
                    }
            return {"title": "", "artist": "", "album": ""}
        except Exception as e:
            logger.error(f"Failed to get current track: {e}")
            return {"error": str(e)}

    async def get_companion_status(self) -> Dict[str, Any]:
        receiver = _companion_receiver
        if not receiver:
            return {"active": False, "error": "Companion receiver is not running"}
        return {"active": bool(receiver.httpd and receiver.gdm_socket),
                "port": receiver.HTTP_PORT, "error": receiver.error}

    async def poll_companion_commands(self) -> Dict[str, Any]:
        receiver = _companion_receiver
        return {"commands": receiver.drain_commands() if receiver else []}

    async def prepare_companion_playback(self, key: str, container_key: str = "") -> Dict[str, Any]:
        plex = self._get_plex()
        if not plex:
            return {"success": False, "error": "Connect to a Plex server before receiving playback."}
        try:
            return plex.prepare_companion_playback(key, container_key)
        except Exception as exc:
            logger.error("Could not prepare incoming Plex playback: %s", exc, exc_info=True)
            return {"success": False, "error": str(exc)}

    async def report_companion_timeline(self, rating_key: str, time_ms: int, duration_ms: int,
                                        state: str, volume: int = 50,
                                        play_queue_id: str = "", play_queue_item_id: str = "",
                                        container_key: str = "", play_queue_version: str = "") -> Dict[str, Any]:
        receiver = _companion_receiver
        if receiver:
            settings = _load_settings()
            server_url = urllib.parse.urlparse(self._get_plex_server_url())
            receiver.set_timeline({"key": f"/library/metadata/{rating_key}" if rating_key else "",
                                   "state": state, "time": max(0, int(time_ms)),
                                   "duration": max(0, int(duration_ms)),
                                   "playQueueID": str(play_queue_id or ""),
                                   "playQueueItemID": str(play_queue_item_id or ""),
                                   "containerKey": str(container_key or ""),
                                   "playQueueVersion": str(play_queue_version or ""),
                                   "serverId": settings.get("selected_server_id", ""),
                                   "address": server_url.hostname or "", "port": server_url.port or 32400,
                                   "protocol": server_url.scheme or "http",
                                   "token": self._get_server_access_token(),
                                   "volume": max(0, min(100, int(volume)))})
        return {"success": True}

    def _find_active_player(self, plex: PlexHTTP) -> Optional[Dict[str, str]]:
        """Find the player currently controlling playback.
        
        First tries to get the player key from the active session.
        Falls back to discovering Plexamp/Caldera players.
        """
        # Try to find the player from the current session
        try:
            sessions = plex.get_sessions()
            for meta in sessions:
                client = getattr(meta, "player", None)
                if client and client.machineIdentifier:
                    return {"key": client.machineIdentifier, "title": client.title or "Unknown",
                            "product": client.product or ""}
        except Exception as e:
            logger.debug(f"Could not find player from session: {e}")
        
        # Fall back to Plexamp/Caldera discovery
        return self._find_plexamp_player(plex)

    async def play(self) -> Dict[str, Any]:
        """Play or resume playback."""
        plex = self._get_plex()
        if not plex:
            return {"success": False, "error": "Not connected to Plex server"}
        try:
            player = self._find_active_player(plex)
            if not player:
                return {"success": False, "error": "No active player found"}
            plex.play(player["key"])
            return {"success": True}
        except Exception as e:
            logger.error(f"Failed to play: {e}")
            return {"success": False, "error": str(e)}

    async def pause(self) -> Dict[str, Any]:
        """Pause playback."""
        plex = self._get_plex()
        if not plex:
            return {"success": False, "error": "Not connected to Plex server"}
        try:
            player = self._find_active_player(plex)
            if not player:
                return {"success": False, "error": "No active player found"}
            plex.pause(player["key"])
            return {"success": True}
        except Exception as e:
            logger.error(f"Failed to pause: {e}")
            return {"success": False, "error": str(e)}

    async def skip_next(self) -> Dict[str, Any]:
        """Skip to the next track."""
        plex = self._get_plex()
        if not plex:
            return {"success": False, "error": "Not connected to Plex server"}
        try:
            player = self._find_active_player(plex)
            if not player:
                return {"success": False, "error": "No active player found"}
            plex.skip_next(player["key"])
            return {"success": True}
        except Exception as e:
            logger.error(f"Failed to skip next: {e}")
            return {"success": False, "error": str(e)}

    async def skip_previous(self) -> Dict[str, Any]:
        """Skip to the previous track."""
        plex = self._get_plex()
        if not plex:
            return {"success": False, "error": "Not connected to Plex server"}
        try:
            player = self._find_active_player(plex)
            if not player:
                return {"success": False, "error": "No active player found"}
            plex.skip_previous(player["key"])
            return {"success": True}
        except Exception as e:
            logger.error(f"Failed to skip previous: {e}")
            return {"success": False, "error": str(e)}

    async def set_volume(self, volume: int) -> Dict[str, Any]:
        """Set the player volume (0-100)."""
        plex = self._get_plex()
        if not plex:
            return {"success": False, "error": "Not connected to Plex server"}
        try:
            player = self._find_active_player(plex)
            if not player:
                return {"success": False, "error": "No active player found"}
            plex.set_volume(player["key"], volume)
            return {"success": True}
        except Exception as e:
            logger.error(f"Failed to set volume: {e}")
            return {"success": False, "error": str(e)}

    # ---- Library browsing ----

    async def get_library_sections(self) -> Dict[str, Any]:
        """Get all library sections, filtering for music sections."""
        plex = self._get_plex()
        if not plex:
            return {"sections": [], "error": "Not connected to Plex server"}
        try:
            sections = plex.get_library_sections()
            logger.debug(f"get_library_sections: found {len(sections)} sections")
            # Filter for music sections only
            music_sections = [s for s in sections if s.get("type") == "artist"]
            logger.debug(f"get_library_sections: {len(music_sections)} music sections")
            return {"sections": music_sections}
        except Exception as e:
            logger.error(f"Failed to get library sections: {e}")
            return {"sections": [], "error": str(e)}

    async def get_section_contents(self, section_id: str, item_type: str = "", limit: int = 100,
                                   offset: int = 0) -> Dict[str, Any]:
        """Get contents of a music library section (artists, albums, etc.)."""
        plex = self._get_plex()
        if not plex:
            return {"items": [], "error": "Not connected to Plex server"}
        try:
            return plex.get_section_contents(section_id, item_type, limit, offset)
        except Exception as e:
            logger.error(f"Failed to get section contents: {e}")
            return {"items": [], "error": str(e)}

    async def get_shuffled_tracks(self, section_id: str) -> Dict[str, Any]:
        """Load and shuffle every track in the selected music library."""
        plex = self._get_plex()
        if not plex:
            return {"items": [], "error": "Not connected to Plex server"}
        try:
            tracks = plex.get_shuffled_tracks(section_id)
            logger.info("Prepared shuffle-all queue with %d tracks from section %s", len(tracks), section_id)
            return {"items": tracks}
        except Exception as e:
            logger.error("Failed to load shuffle-all tracks: %s", e, exc_info=True)
            return {"items": [], "error": str(e)}

    async def get_track_page(self, section_id: str, offset: int = 0, limit: int = 25,
                             randomize: bool = False) -> Dict[str, Any]:
        plex = self._get_plex()
        if not plex:
            return {"items": [], "total": 0, "error": "Not connected to Plex server"}
        try:
            return plex.get_track_page(section_id, offset, limit, randomize)
        except Exception as e:
            logger.error("Failed to load shuffle page: %s", e, exc_info=True)
            return {"items": [], "total": 0, "error": str(e)}

    async def get_metadata_children(self, metadata_id: str) -> Dict[str, Any]:
        """Get children of a metadata item (album tracks, artist albums)."""
        plex = self._get_plex()
        if not plex:
            return {"items": [], "error": "Not connected to Plex server"}
        try:
            items = plex.get_metadata_children(metadata_id)
            return {"items": items}
        except Exception as e:
            logger.error(f"Failed to get metadata children: {e}")
            return {"items": [], "error": str(e)}

    async def get_artist_tracks(self, artist_id: str) -> Dict[str, Any]:
        plex = self._get_plex()
        if not plex:
            return {"items": [], "error": "Not connected to Plex server"}
        try:
            return {"items": plex.get_artist_tracks(artist_id)}
        except Exception as e:
            logger.error(f"Failed to get tracks for artist {artist_id}: {e}")
            return {"items": [], "error": str(e)}

    async def get_recently_played(self, section_id: str = "", limit: int = 50) -> Dict[str, Any]:
        plex = self._get_plex()
        if not plex:
            return {"items": [], "error": "Not connected to Plex server"}
        try:
            return {"items": plex.get_recently_played(section_id, limit)}
        except Exception as e:
            logger.error(f"Failed to get recently played tracks: {e}")
            return {"items": [], "error": str(e)}

    async def get_recently_added(self, section_id: str, limit: int = 50) -> Dict[str, Any]:
        plex = self._get_plex()
        if not plex:
            return {"items": [], "error": "Not connected to Plex server"}
        try:
            return {"items": plex.get_recently_added(section_id, limit)}
        except Exception as e:
            logger.error(f"Failed to get recently added albums: {e}")
            return {"items": [], "error": str(e)}

    async def get_audio_playlists(self, limit: int = 100) -> Dict[str, Any]:
        plex = self._get_plex()
        if not plex:
            return {"items": [], "error": "Not connected to Plex server"}
        try:
            return {"items": plex.get_audio_playlists(limit)}
        except Exception as e:
            logger.error(f"Failed to get audio playlists: {e}")
            return {"items": [], "error": str(e)}

    async def add_track_to_playlist(self, playlist_id: str, rating_key: str) -> Dict[str, Any]:
        plex = self._get_plex()
        if not plex:
            return {"success": False, "error": "Not connected to Plex server"}
        try:
            return plex.add_track_to_playlist(playlist_id, rating_key)
        except Exception as e:
            logger.error(f"Failed to add track {rating_key} to playlist {playlist_id}: {e}")
            return {"success": False, "error": str(e)}

    async def remove_track_from_playlist(self, playlist_id: str, rating_key: str) -> Dict[str, Any]:
        plex = self._get_plex()
        if not plex:
            return {"success": False, "error": "Not connected to Plex server"}
        try:
            return plex.remove_track_from_playlist(playlist_id, rating_key)
        except Exception as e:
            logger.error(f"Failed to remove track {rating_key} from playlist {playlist_id}: {e}")
            return {"success": False, "error": str(e)}

    async def create_audio_playlist(self, title: str, rating_key: str) -> Dict[str, Any]:
        plex = self._get_plex()
        if not plex:
            return {"success": False, "error": "Not connected to Plex server"}
        try:
            return plex.create_audio_playlist(title, rating_key)
        except Exception as e:
            logger.error(f"Failed to create audio playlist {title!r}: {e}")
            return {"success": False, "error": str(e)}

    async def delete_audio_playlist(self, playlist_id: str) -> Dict[str, Any]:
        plex = self._get_plex()
        if not plex:
            return {"success": False, "error": "Not connected to Plex server"}
        try:
            return plex.delete_audio_playlist(playlist_id)
        except Exception as e:
            logger.error(f"Failed to delete audio playlist {playlist_id}: {e}")
            return {"success": False, "error": str(e)}

    async def get_playlist_tracks(self, playlist_id: str, limit: int = 100) -> Dict[str, Any]:
        plex = self._get_plex()
        if not plex:
            return {"items": [], "error": "Not connected to Plex server"}
        try:
            return {"items": plex.get_playlist_tracks(playlist_id, limit)}
        except Exception as e:
            logger.error(f"Failed to get tracks from playlist {playlist_id}: {e}")
            return {"items": [], "error": str(e)}

    async def search_library(self, query: str, section_id: str = "", limit: int = 20) -> Dict[str, Any]:
        """Search the library for tracks, albums, or artists."""
        plex = self._get_plex()
        if not plex:
            return {"items": [], "error": "Not connected to Plex server"}
        try:
            items = plex.search_library(query, section_id, limit)
            return {"items": items}
        except Exception as e:
            logger.error(f"Failed to search library: {e}")
            return {"items": [], "error": str(e)}

    async def get_hubs(self) -> Dict[str, Any]:
        """Get hubs (recently played, on deck, etc.), limited to music sections only."""
        plex = self._get_plex()
        if not plex:
            return {"hubs": [], "error": "Not connected to Plex server"}
        try:
            # Get music library section IDs so /hubs only returns music content
            sections = plex.get_library_sections()
            music_section_ids = [s["id"] for s in sections if s.get("type") == "artist"]
            logger.debug(f"get_hubs: {len(music_section_ids)} music section(s): {music_section_ids}")
            
            if not music_section_ids:
                return {"hubs": []}
            
            hubs = plex.get_hubs(section_ids=music_section_ids)
            logger.debug(f"get_hubs: found {len(hubs)} music hubs")
            return {"hubs": hubs}
        except Exception as e:
            logger.error(f"Failed to get hubs: {e}")
            return {"hubs": [], "error": str(e)}

    async def get_server_identity(self) -> Dict[str, Any]:
        """Get server identity info including machineIdentifier."""
        plex = self._get_plex()
        if not plex:
            return {"error": "Not connected to Plex server"}
        try:
            identity = plex.get_server_identity()
            return identity
        except Exception as e:
            logger.error(f"Failed to get server identity: {e}")
            return {"error": str(e)}

    async def play_track(self, rating_key: str, section_id: str) -> Dict[str, Any]:
        """Get a stream URL for a track so the frontend can play it.

        Creates a play queue on the server, then starts an audio transcode session
        to get a playable stream URL. The frontend uses an HTML5 <audio> element
        to play the stream — this plugin IS the player, not a remote control.
        """
        plex = self._get_plex()
        if not plex:
            return {"success": False, "error": "Not connected to Plex server"}
        try:
            # PlexAPI's getStreamURL() is HLS-only; our adapter uses the SDK's
            # authenticated URL builder for the single-file MP3 transcode.
            streams = plex.get_stream_urls(rating_key)
            logger.info("play_track: using %s for track %s", streams.get("stream_mode"), rating_key)
            play_queue_id = ""
            selected_item_id = ""
            container_key = ""
            logger.info(f"play_track: stream URL obtained for track {rating_key}")

            return {
                "success": True,
                **streams,
                "play_queue_id": play_queue_id,
                "selected_item_id": selected_item_id,
                "container_key": container_key,
                "rating_key": rating_key,
            }
        except Exception as e:
            logger.error(f"Failed to get stream for track: {e}", exc_info=True)
            return {"success": False, "error": str(e)}

    async def inspect_stream(self, rating_key: str, stream_url: str) -> Dict[str, Any]:
        """Inspect Plex's response for a track the Decky audio element rejected."""
        plex = self._get_plex()
        if not plex:
            return {"success": False, "error": "Not connected to Plex server"}
        try:
            result = plex.inspect_stream(rating_key, stream_url)
            logger.info(
                "Stream diagnostic for track %s: status=%s content_type=%s content_range=%s prefix=%s",
                rating_key, result.get("status"), result.get("content_type"),
                result.get("content_range"), result.get("prefix_hex"),
            )
            preview = result.get("body_preview")
            if preview:
                logger.info("Stream diagnostic response preview for track %s: %s", rating_key, preview[:256])
            return {"success": True, **result}
        except Exception as e:
            logger.error(f"Stream diagnostic failed for track {rating_key}: {e}", exc_info=True)
            return {"success": False, "error": str(e)}

    async def report_playback(self, rating_key: str, time_ms: int, state: str,
                              duration_ms: int = 0) -> Dict[str, Any]:
        """Report this local player's timeline through PlexAPI for sessions/history."""
        plex = self._get_plex()
        if not plex:
            return {"success": False, "error": "Not connected to Plex server"}
        if state not in ("playing", "paused", "stopped"):
            return {"success": False, "error": "Invalid playback state"}
        try:
            track = plex.sdk.fetchItem(int(rating_key))
            track.updateTimeline(
                max(0, int(time_ms)),
                state=state,
                duration=max(0, int(duration_ms)) or None,
            )
            logger.debug(f"Reported Plex timeline: track={rating_key}, state={state}, time={time_ms}")
            return {"success": True}
        except Exception as e:
            logger.warning(f"Failed to report Plex timeline for track {rating_key}: {e}")
            return {"success": False, "error": str(e)}

    async def plex_login(self) -> Dict[str, Any]:
        """Start PIN authentication with python-plexapi's login helper."""
        try:
            import requests
            from plexapi.myplex import MyPlexPinLogin

            client_id = secrets.token_hex(16)
            session = requests.Session()
            session.verify = False
            headers = {
                "X-Plex-Client-Identifier": client_id,
                "X-Plex-Product": "DeckyPlex",
                "X-Plex-Version": "1.0.0",
                "X-Plex-Platform": "SteamOS",
                "X-Plex-Device": "Steam Machine",
                "X-Plex-Device-Name": "DeckyPlex",
            }
            pin_login = MyPlexPinLogin(session=session, requestTimeout=15, headers=headers)
            pin = pin_login.pin
            if not pin:
                return {"error": "Plex did not return a login PIN."}
            _pin_state.clear()
            _pin_state.update({"login": pin_login, "client_id": client_id})
            logger.info("Started Plex PIN login through PlexAPI")
            return {"pin": pin, "url": "https://plex.tv/link"}
        except Exception as e:
            logger.error(f"Failed to start Plex login through PlexAPI: {e}", exc_info=True)
            return {"error": f"Plex login failed: {e}"}

    def _account_resources(self, auth_token: str) -> Dict[str, Any]:
        """Read account identity and Plex servers through PlexAPI resource objects."""
        import requests
        from plexapi.myplex import MyPlexAccount

        session = requests.Session()
        session.verify = False
        account = MyPlexAccount(token=auth_token, session=session, timeout=10)
        servers = []
        plexamp_url = ""
        plexamp_client_id = ""
        for resource in account.resources():
            product = (resource.product or "").lower()
            connections = resource.preferred_connections(
                locations=["local", "remote"], schemes=["http", "https"], ipvs=["ipv4", "ipv6"])
            if not connections:
                continue
            if "server" in (resource.provides or "").split(","):
                try:
                    connected_server = resource.connect(timeout=4, locations=["local", "remote"])
                    servers.append({
                        "id": connected_server.machineIdentifier or resource.clientIdentifier,
                        "name": connected_server.friendlyName or resource.name or "Plex Media Server",
                        "base_url": connected_server._baseurl.rstrip("/"),
                        "access_token": resource.accessToken or auth_token,
                    })
                except Exception as e:
                    logger.warning("Could not connect to Plex server resource %s: %s", resource.name, e)
            elif "plexamp" in product or "caldera" in product:
                plexamp_url = connections[0].rstrip("/")
                plexamp_client_id = resource.clientIdentifier or ""
        return {
            "username": account.username or account.title or "",
            "servers": servers,
            "plexamp_url": plexamp_url,
            "plexamp_client_id": plexamp_client_id,
        }

    async def plex_login_poll(self) -> Dict[str, Any]:
        """Poll PIN approval and save the account token before resource discovery."""
        pin_login = _pin_state.get("login")
        if pin_login is None:
            return {"error": "No active Plex login. Start login again."}

        try:
            if not pin_login.checkLogin():
                if pin_login.expired:
                    _pin_state.clear()
                    return {"error": "Plex login expired or could not be verified. Start again."}
                return {}

            auth_token = pin_login.token
            settings = _load_settings()
            settings["plex_token"] = auth_token
            settings["logged_in_username"] = ""
            settings["selected_player_id"] = ""
            settings["selected_player_name"] = ""
            settings["playback_target"] = "local"
            settings["selected_server_id"] = ""
            settings["selected_server_name"] = ""
            settings["selected_server_url"] = ""
            settings["server_access_token"] = ""
            settings["plexamp_url"] = ""
            _save_settings(settings)

            _pin_state.clear()
            logger.info("Plex PIN login approved; account token saved, starting server discovery")
            return {
                "logged_in": True,
                "username": "",
                "servers": [],
                "discovery_pending": True,
            }
        except Exception as e:
            logger.error(f"Plex PIN polling failed: {e}", exc_info=True)
            return {"error": f"Plex login check failed: {e}"}

    async def discover_servers(self) -> Dict[str, Any]:
        """Discover Plex servers with PlexAPI account and resource objects."""
        settings = _load_settings()
        token = settings.get("plex_token", "").strip()
        if not token:
            return {"servers": [], "error": "Not logged in to Plex"}
        try:
            info = self._account_resources(token)
            settings["logged_in_username"] = info.get("username", "")
            if info["plexamp_url"]:
                settings["plexamp_url"] = info["plexamp_url"]
                _save_settings(settings)
            servers = info["servers"]
            if not servers and settings.get("selected_server_url") and settings.get("selected_server_id"):
                servers = [{
                    "id": settings["selected_server_id"],
                    "name": settings.get("selected_server_name") or "Saved Plex server",
                    "base_url": settings["selected_server_url"],
                    "access_token": settings.get("server_access_token") or token,
                }]
            if servers:
                selected = next((server for server in servers if server["id"] == settings.get("selected_server_id")), servers[0])
                settings.update({
                    "selected_server_id": selected["id"],
                    "selected_server_name": selected["name"],
                    "selected_server_url": selected["base_url"],
                    "server_access_token": selected.get("access_token") or token,
                })
            _save_settings(settings)
            public_servers = [{key: server.get(key, "") for key in ("id", "name", "base_url")}
                              for server in servers]
            return {
                "servers": public_servers,
                "plexamp_url": info["plexamp_url"],
            }
        except Exception as e:
            logger.error(f"PlexAPI server discovery failed: {e}", exc_info=True)
            return {"servers": [], "error": f"Could not discover Plex servers: {e}"}

    async def validate_connection(self) -> Dict[str, Any]:
        """Validate the selected connection through PlexServer's SDK session."""
        try:
            plex = self._get_plex()
            if not plex:
                return {"valid": False, "error": "Select a Plex server in Settings first."}
            identity = plex.get_server_identity()
            return {
                "valid": True,
                "serverName": identity.get("friendlyName", ""),
                "machineIdentifier": identity.get("machineIdentifier", ""),
            }
        except Exception as e:
            logger.error(f"PlexAPI connection validation failed: {e}", exc_info=True)
            return {"valid": False, "error": str(e)}

    def _get_plex_server_url(self) -> str:
        """Get the Plex server URL from saved settings.

        Uses the saved server URL directly instead of calling plex.tv every time.
        """
        settings = _load_settings()
        manual_url = settings.get("manual_server_url", "").strip()
        if manual_url:
            return manual_url
        # Prefer the saved server URL
        url = settings.get("selected_server_url", "").strip()
        if url:
            return url
        # Fallback to the legacy plex_server_url field
        url = settings.get("plex_server_url", "").strip()
        return url

    def _get_server_access_token(self) -> str:
        """Get the server-specific access token from settings."""
        settings = _load_settings()
        return settings.get("server_access_token", "")

