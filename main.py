import json
import asyncio
import base64
import html
import ipaddress
import os
import random
import re
import secrets
import socket
import sys
import tempfile
import threading
import time
import urllib.parse
import uuid
from copy import copy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional

# Add py_modules to Python path so bundled dependencies (plexapi, requests) are available
_plugin_dir = os.path.dirname(os.path.abspath(__file__))
if _plugin_dir not in sys.path:
    sys.path.insert(0, _plugin_dir)
_py_modules_dir = os.path.join(_plugin_dir, "py_modules")
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
    "browser_layouts": {},
    "library_selections": {},
    "video_quality": "auto",
    "video_autoplay": True,
    "over_game_pip": False,
    "pip_position": "bottom-left",
    "pip_size": 29,
    "volume": 50,
    "manual_server_url": "",
    "manual_server_id": "",
    "playback_target": "local",
    "connection_timeout": 8,
    "verify_tls": False,
    "logged_in_username": "",
    "server_access_token": "",
    "companion_id": "",
    "companion_receiver_enabled": False,
    "companion_device_name": "DeckyPlex",
    "allow_signed_out_companion": False,
    "hide_quick_login": False,
    "quick_player_maintain_x": False,
    "quick_player_show_idle": True,
}

LIBRARY_TYPES = ("artist", "movie", "show", "photo")
VIDEO_TYPES = ("movie", "episode", "clip")
PIP_POSITIONS = ("top-left", "top-center", "top-right", "center-left", "center",
                 "center-right", "bottom-left", "bottom-center", "bottom-right")
VIDEO_SORTS = {
    "titleSort:asc", "titleSort:desc", "addedAt:desc", "originallyAvailableAt:desc",
}
VIDEO_QUALITY = {
    "auto": (None, None),
    "1080p": ("1920x1080", 8000),
    "720p": ("1280x720", 4000),
    "480p": ("854x480", 1500),
}
VIDEO_DIRECT_AUDIO = {"mp4": {"aac", "mp3"}, "m4v": {"aac", "mp3"}, "webm": {"opus", "vorbis"}}
MUSIC_BROWSER_TABS = {"artists", "albums", "tracks", "recent", "recentlyAdded", "playlists"}


def _browser_layouts(value: Any) -> Dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    layouts = {}
    for scope, layout in value.items():
        if not isinstance(scope, str) or not isinstance(layout, dict):
            continue
        music = scope == "music"
        if not music and not (scope.startswith("video:") and 6 < len(scope) <= 134):
            continue
        cleaned = {}
        for field in ("order", "hidden"):
            keys = layout.get(field)
            if not isinstance(keys, list):
                keys = []
            cleaned[field] = list(dict.fromkeys(
                key for key in keys if isinstance(key, str) and
                (key in MUSIC_BROWSER_TABS if music else
                 key in ("videoHome", "videoWatchlist") or (key.startswith("library:") and 8 < len(key) <= 136))
            ))
        layouts[scope] = cleaned
    return layouts


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
_settings_stopping = False
_settings_update_request = ""
_settings_update_until = 0
try:
    _manifest_stat = os.stat(os.path.join(_plugin_dir, "plugin.json"))
    _manifest_stamp = [_manifest_stat.st_ino, _manifest_stat.st_mtime_ns]
except OSError:
    _manifest_stamp = None
_settings_installation = None


def _installation_id() -> Optional[str]:
    # Decky's ZIP overlay leaves extra files in dist intact. Removing the
    # plugin directory removes this ID even if the uninstall hook is missed.
    path = os.path.join(_plugin_dir, "dist", ".deckyplex-installation")
    try:
        try:
            with open(path, encoding="utf-8") as marker:
                return str(uuid.UUID(marker.read(37)))
        except FileNotFoundError:
            installation = str(uuid.uuid4())
            with tempfile.NamedTemporaryFile(mode="w", dir=os.path.dirname(path)) as pending:
                pending.write(installation)
                pending.flush()
                try:
                    os.link(pending.name, path)
                except FileExistsError:
                    with open(path, encoding="utf-8") as marker:
                        return str(uuid.UUID(marker.read(37)))
            return installation
    except (OSError, ValueError) as exc:
        logger.warning("Could not initialize installation ID: %s", exc)
    return None


def _load_settings() -> Dict[str, Any]:
    """Load settings from JSON file, merging with defaults."""
    try:
        if os.path.exists(_settings_file):
            with open(_settings_file, "r") as f:
                saved = json.load(f)
                if _manifest_stamp is not None:
                    installation = saved.get("_installation")
                    update_until = saved.get("_update_until")
                    updating = isinstance(update_until, int) and time.time() < update_until
                    # Existing builds used the manifest inode and mtime. An
                    # overlay rewrites the manifest in place on those builds.
                    old_stamp = isinstance(installation, list) and len(installation) == 2
                    same_manifest = old_stamp and installation[0] == _manifest_stamp[0]
                    legacy = installation is None and os.fstat(f.fileno()).st_mtime_ns >= _manifest_stamp[1]
                    if installation != (_settings_installation or _manifest_stamp) and not (
                        updating or same_manifest or legacy
                    ):
                        logger.info("Ignoring DeckyPlex preferences from a previous installation")
                        return dict(DEFAULT_SETTINGS)
            # Merge with defaults so new keys are present
            merged = {**DEFAULT_SETTINGS, **saved}
            server_id = merged["selected_server_id"]
            if saved.get("media_scope") == "all" and server_id:
                selections = merged["library_selections"]
                selections = dict(selections) if isinstance(selections, dict) else {}
                selections.setdefault(server_id, "all")
                merged["library_selections"] = selections
            if merged["manual_server_url"] and "manual_server_id" not in saved:
                merged["manual_server_id"] = server_id
            # Filter to known keys only
            known_keys = set(DEFAULT_SETTINGS.keys())
            return {k: v for k, v in merged.items() if k in known_keys}
    except Exception as e:
        logger.error(f"Failed to load settings: {e}")
    return dict(DEFAULT_SETTINGS)


def _save_settings(settings: Dict[str, Any]) -> None:
    """Save settings to JSON file. Only saves known keys."""
    if _settings_stopping:
        raise OSError("DeckyPlex is unloading.")
    try:
        known_keys = set(DEFAULT_SETTINGS.keys())
        filtered = {k: v for k, v in settings.items() if k in known_keys}
        if _settings_installation or _manifest_stamp:
            filtered["_installation"] = _settings_installation or _manifest_stamp
        if time.time() < _settings_update_until:
            filtered["_update_until"] = _settings_update_until
        settings_dir = os.path.dirname(_settings_file)
        if settings_dir:
            os.makedirs(settings_dir, exist_ok=True)
        pending_path = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", dir=settings_dir or ".", delete=False) as pending:
                pending_path = pending.name
                json.dump(filtered, pending, indent=4)
            os.replace(pending_path, _settings_file)
        finally:
            if pending_path and os.path.exists(pending_path):
                os.unlink(pending_path)
        logger.debug(f"Settings saved to: {_settings_file}")
    except Exception as e:
        logger.error(f"Failed to save settings: {e}")
        raise


def _allow_decky_shutdown_at_rpc_eof() -> None:
    # Older Decky socket listeners spin on an empty read after the loader
    # disconnects, preventing the plugin's uninstall hook from running.
    module = sys.modules.get("decky_loader.localplatform.localsocket")
    socket_type = getattr(module, "LocalSocket", None)
    if socket_type is None or "_read_single_line" in vars(socket_type):
        return
    listen = getattr(socket_type, "_listen_for_method_call", None)
    names = getattr(getattr(listen, "__code__", None), "co_names", ())
    if "_read_single_line" not in names or "at_eof" in names:
        return
    read_line = socket_type._read_single_line

    async def read_line_or_wait_for_shutdown(sock, reader):
        line = await read_line(sock, reader)
        if not line and reader.at_eof():
            await asyncio.Future()
        return line

    socket_type._read_single_line = read_line_or_wait_for_shutdown


def _manual_server_url(settings):
    if settings["manual_server_id"] == settings["selected_server_id"]:
        return settings["manual_server_url"].strip()
    return ""


def _server_settings(server, account_token):
    return {
        "selected_server_id": server["id"],
        "selected_server_name": server.get("name", ""),
        "selected_server_url": server.get("base_url", ""),
        "server_access_token": server.get("access_token") or account_token,
    }


def _library_choice(settings):
    selections = settings["library_selections"]
    return selections.get(settings["selected_server_id"]) if isinstance(selections, dict) else None


def _set_library_choice(settings, server_id, libraries):
    selections = settings["library_selections"]
    settings["library_selections"] = {**(selections if isinstance(selections, dict) else {}), server_id: libraries}


def _private_plex_base_url(address: str, port: int, protocol: str) -> str:
    """Validate a Companion Plex endpoint as private LAN or secure plex.direct."""
    host = str(address or "").strip().strip("[]")
    scheme = str(protocol or "http").lower()
    port = int(port or 32400)
    if scheme not in ("http", "https"):
        raise ValueError("Unsupported Plex server protocol")
    if not 1 <= port <= 65535:
        raise ValueError("Invalid Plex server port")
    if not host or any(char in host for char in "/\\?#@"):
        raise ValueError("Plexamp supplied an invalid server address")
    try:
        resolved_ips = [ipaddress.ip_address(host)]
    except ValueError:
        # Plex commonly advertises secure servers as
        # <encoded-private-ip>.<certificate-id>.plex.direct. Keep the hostname
        # for TLS/SNI, but ensure it resolves only to a private address.
        answers = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        resolved_ips = list({ipaddress.ip_address(answer[4][0]) for answer in answers})
        if not resolved_ips:
            raise ValueError("Plex server hostname did not resolve")
        plex_direct = host.lower().endswith(".plex.direct")
        advertised_ip = None
        if plex_direct:
            encoded_ip = host.split(".", 1)[0].replace("-", ".")
            try:
                advertised_ip = ipaddress.ip_address(encoded_ip)
            except ValueError:
                advertised_ip = None
            if advertised_ip and advertised_ip not in resolved_ips:
                raise ValueError("Plex server hostname resolved to a different address")
        if any(not ip.is_private for ip in resolved_ips):
            # Plex's own plex.direct hostname encodes the server IP and is
            # required for valid TLS on remote servers. Only trust the public
            # address when it matches that encoded IP exactly.
            if not plex_direct or not advertised_ip or any(ip != advertised_ip for ip in resolved_ips):
                raise ValueError("Public Plex servers must use a matching plex.direct hostname")
    if any(ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_unspecified
           for ip in resolved_ips):
        raise ValueError("Plex server address is not usable")
    try:
        literal_ip = ipaddress.ip_address(host)
    except ValueError:
        literal_ip = None
    formatted_host = f"[{host}]" if literal_ip and literal_ip.version == 6 else host
    return f"{scheme}://{formatted_host}:{port}"


# Store PIN state across calls
_pin_state: Dict[str, Any] = {}
_plex_cache = (None, None)
_plex_connect_lock = threading.Lock()
_companion_receiver = None
_companion_event_loop = None
_next_account_check = 0.0


def _cancel_plex_login() -> None:
    task = _pin_state.get("task")
    if task:
        task.cancel()
    _pin_state.clear()


def _check_plex_account(token: str) -> None:
    import requests
    from plexapi.myplex import MyPlexAccount

    with requests.Session() as session:
        MyPlexAccount(token=token, session=session, timeout=5)


class PlexCompanionReceiver:
    """Minimal local Plex Companion player endpoint for Plexamp casting."""
    HTTP_PORT = int(os.environ.get("DECKYPLEX_COMPANION_PORT", "32435"))
    GDM_PORT = 32412
    POLL_DISCONNECT_GRACE = 1.25

    def __init__(self, machine_id: str, event_loop=None, device_name="DeckyPlex"):
        self.machine_id = machine_id
        self.device_name = device_name
        self.event_loop = event_loop
        self.httpd = None
        self.http_thread = None
        self.gdm_socket = None
        self.gdm_thread = None
        self.lock = threading.Lock()
        self.timeline_changed = threading.Condition(self.lock)
        self.commands: List[Dict[str, Any]] = []
        self.controllers: Dict[str, Dict[str, Any]] = {}
        self.polling_controllers: Dict[tuple[str, str], float] = {}
        self.poll_disconnects: Dict[tuple[str, str], threading.Event] = {}
        self.outgoing_play = None
        self.shutting_down = False
        self.timeline: Dict[str, Any] = {"state": "stopped", "time": 0, "duration": 0}
        self.last_polled_queue_revision = None
        self.error = ""

    def _response_headers(self) -> bytes:
        return ("HTTP/1.0 200 OK\r\n"
                "Content-Type: plex/media-player\r\n"
                f"Name: {self.device_name}\r\n"
                f"Port: {self.HTTP_PORT}\r\n"
                "Product: DeckyPlex\r\n"
                "Protocol: plex\r\n"
                "Protocol-Version: 1\r\n"
                "Protocol-Capabilities: timeline,playback,playqueues\r\n"
                f"Resource-Identifier: {self.machine_id}\r\n"
                "Device-Class: stb\r\n"
                "Version: 1.0.0\r\n\r\n").encode("utf-8")

    def enqueue(self, name: str, params: Dict[str, Any], client_host: str = "", client_id: str = "") -> None:
        try:
            command_id = int(params.get("commandID", ["0"])[0])
        except (TypeError, ValueError):
            command_id = 0
        command = {"command": name, "params": params, "client_host": client_host,
                   "client_id": client_id, "delivery_id": uuid.uuid4().hex}
        with self.lock:
            if self.shutting_down:
                return
            outgoing = self.outgoing_play
            if (name == "playMedia" and outgoing and time.monotonic() < outgoing["until"]
                    and params.get("key", [""])[0] == outgoing["key"]
                    and self._matches_controller(client_id, client_host, outgoing["client_id"], outgoing["host"])):
                self.outgoing_play = None
                outgoing["echo"].set()
                logger.info("Plexamp routed outgoing playback back to DeckyPlex")
                return
            self.commands.append(command)
            self.commands = self.commands[-32:]
            if client_id in self.controllers:
                self.controllers[client_id]["commandId"] = command_id
            else:
                for controller in self.controllers.values():
                    if controller.get("host") == client_host:
                        controller["commandId"] = command_id
        if name == "playMedia":
            logger.info("Companion received playMedia from %s: key=%s containerKey=%s mediaIndex=%s offset=%s",
                        client_host, params.get("key", [""])[0], params.get("containerKey", [""])[0],
                        params.get("mediaIndex", [""])[0], params.get("offset", [""])[0])
            # Plexamp waits for the receiver's timeline after playMedia. A music
            # queue can take several seconds to resolve through PlexAPI, so report
            # buffering now and replace it with playing/paused once playback starts.
            try:
                self.set_timeline({
                    "key": params.get("key", [""])[0],
                    "state": "buffering",
                    "time": max(0, int(params.get("offset", ["0"])[0] or 0)),
                    "duration": 0,
                    "serverId": params.get("machineIdentifier", [""])[0],
                    "address": params.get("address", [""])[0],
                    "port": int(params.get("port", ["32400"])[0] or 32400),
                    "protocol": params.get("protocol", ["http"])[0],
                    "token": params.get("token", [""])[0],
                    "volume": self.timeline.get("volume", 50),
                })
            except (TypeError, ValueError) as exc:
                logger.warning("Could not publish initial Companion buffering timeline: %s", exc)
        else:
            logger.info("Companion received %s from %s (commandID=%s)", name, client_host, command_id)
        # Push after updating the immediate buffering timeline. Keep the queued
        # copy too, so polling can recover if the frontend event listener was
        # not mounted when this event was emitted.
        if self.event_loop and self.event_loop.is_running():
            try:
                future = asyncio.run_coroutine_threadsafe(
                    decky.emit("companion_command", command), self.event_loop
                )
                future.add_done_callback(self._log_event_delivery_error)
            except Exception as exc:
                logger.warning("Could not dispatch Companion command event: %s", exc)

    @staticmethod
    def _log_event_delivery_error(future) -> None:
        try:
            future.result()
        except Exception as exc:
            logger.warning("Decky Companion command event failed: %s", exc)

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
            controller_key = client_id or f"{host}:{port}"
            with self.lock:
                new_controller = controller_key not in self.controllers
                disconnected = self.shutting_down
                if not disconnected:
                    self.controllers[controller_key] = controller
                timeline = dict(self.timeline)
            if disconnected:
                timeline = {"state": "stopped", "volume": timeline.get("volume", 50)}
            elif new_controller:
                logger.info("Plex Companion controller connected: state=%s queue=%s",
                            timeline.get("state"), timeline.get("playQueueID") or "-")
            self._notify_controllers([controller], timeline, disconnected=disconnected)

    def set_timeline(self, timeline: Dict[str, Any], notify: bool = True) -> None:
        with self.timeline_changed:
            self.timeline = timeline
            self.timeline_changed.notify_all()
        if notify:
            self.notify_timeline(timeline)

    def notify_timeline(self, timeline: Dict[str, Any]) -> None:
        with self.lock:
            if self.timeline is not timeline:
                return
            controllers = list(self.controllers.values())
        self._notify_controllers(controllers, timeline)

    @staticmethod
    def _matches_controller(client_id: str, host: str, target_id: str, target_host: str) -> bool:
        return bool((target_id and client_id == target_id) or (target_host and host == target_host))

    def poll_timeline(self, host: str, client_id: str, command_id: int,
                      wait: bool = False) -> tuple[bytes, Optional[threading.Event]]:
        key = (client_id, host)
        now = time.monotonic()
        with self.timeline_changed:
            self.polling_controllers = {k: at for k, at in self.polling_controllers.items() if now - at < 90}
            self.poll_disconnects = {k: event for k, event in self.poll_disconnects.items()
                                     if k in self.polling_controllers}
            known_controller = key in self.polling_controllers
            if not self.shutting_down and key not in self.poll_disconnects:
                self.polling_controllers[key] = now
                if wait and known_controller:
                    previous = self.timeline
                    self.timeline_changed.wait_for(
                        lambda: self.timeline is not previous or self.shutting_down or key in self.poll_disconnects,
                        timeout=1,
                    )
            pending_disconnect = self.poll_disconnects.get(key)
            disconnected = self.shutting_down or pending_disconnect is not None
            timeline = dict(self.timeline)
            revision = (timeline.get("playQueueID"), timeline.get("playQueueVersion"))
            if not disconnected and all(revision) and revision != self.last_polled_queue_revision:
                self.last_polled_queue_revision = revision
                logger.info("Companion poll served queue %s version %s while item %s was active",
                            *revision, timeline.get("playQueueItemID"))
        if disconnected:
            timeline = {"state": "stopped", "volume": timeline.get("volume", 50)}
        return self._timeline_xml(timeline, command_id, disconnected), pending_disconnect

    def disconnect_controllers(self, target_id: str = "", target_host: str = "", *, shutting_down: bool = False) -> None:
        def targeted(client_id, host):
            return shutting_down or not (target_id or target_host) or self._matches_controller(
                client_id, host, target_id, target_host)

        with self.lock:
            if shutting_down:
                self.shutting_down = True
            controllers = [self.controllers.pop(key) for key, entry in list(self.controllers.items())
                           if targeted(entry.get("clientId") or key, entry["host"])]
            now = time.monotonic()
            polling = {key: self.poll_disconnects.setdefault(key, threading.Event())
                       for key, seen in self.polling_controllers.items() if now - seen < 90 and targeted(*key)}
            timeline = {"state": "stopped", "volume": self.timeline.get("volume", 50)}
            self.timeline_changed.notify_all()
        if controllers:
            self._notify_controllers(controllers, timeline, disconnected=True)
        if polling:
            deadline = time.monotonic() + self.POLL_DISCONNECT_GRACE
            for event in polling.values():
                event.wait(max(0, deadline - time.monotonic()))
            with self.lock:
                for key, event in polling.items():
                    if event.is_set():
                        self.polling_controllers.pop(key, None)
                    if self.poll_disconnects.get(key) is event:
                        self.poll_disconnects.pop(key, None)
        if controllers or polling:
            logger.info("Released Plex Companion controllers: push=%d poll=%d poll_delivered=%d",
                        len(controllers), len(polling), sum(event.is_set() for event in polling.values()))

    def expect_outgoing_play(self, client_id: str, host: str, rating_key: int) -> threading.Event:
        echo = threading.Event()
        with self.lock:
            self.outgoing_play = {"client_id": client_id, "host": host, "key": f"/library/metadata/{rating_key}",
                                  "until": time.monotonic() + 10, "echo": echo}
        return echo

    def _notify_controllers(self, controllers: List[Dict[str, Any]], timeline: Dict[str, Any],
                            disconnected: bool = False) -> None:
        if not controllers:
            return
        try:
            import requests
            for controller in controllers:
                scheme = "https" if controller.get("protocol") == "https" else "http"
                url = f"{scheme}://{controller['host']}:{controller['port']}/:/timeline"
                media = self._timeline_xml(timeline, controller.get("commandId", 0), disconnected)
                try:
                    requests.post(url, data=media, timeout=0.35,
                                  headers={"Content-Type": "application/xml",
                                           "X-Plex-Client-Identifier": self.machine_id,
                                           "X-Plex-Device-Name": self.device_name.encode("utf-8")})
                except Exception as exc:
                    logger.debug("Companion timeline delivery failed: %s", exc)
        except Exception as exc:
            logger.debug("Could not publish Companion timeline: %s", exc)

    @staticmethod
    def _timeline_xml(state: Dict[str, Any], command_id: int = 0, disconnected: bool = False) -> bytes:
        actions = ["volume", "seekTo", "skipTo", "skipPrevious", "stop", "playPause"]
        if state.get("canSkipNext") is not False:
            actions.append("skipNext")
        attrs = {
            "type": "music", "state": state.get("state", "stopped"),
            "time": int(state.get("time", 0)), "duration": int(state.get("duration", 0)),
            "key": state.get("key", ""), "machineIdentifier": state.get("serverId", ""),
            "address": state.get("address", ""), "port": state.get("port", 32400),
            "protocol": state.get("protocol", "http"), "token": state.get("token", ""),
            "volume": int(state.get("volume", 50)),
            "controllable": ",".join(actions),
        }
        if state.get("ratingKey"):
            attrs["ratingKey"] = state["ratingKey"]
        if state.get("playQueueID"):
            attrs["playQueueID"] = state["playQueueID"]
            attrs["playQueueItemID"] = state.get("playQueueItemID", "")
            attrs["containerKey"] = state.get("containerKey", "")
            if state.get("playQueueVersion"):
                attrs["playQueueVersion"] = state["playQueueVersion"]
        values = " ".join(f'{name}=\"{html.escape(str(value), quote=True)}\"' for name, value in attrs.items())
        disconnect = ' disconnected="1"' if disconnected else ''
        return (f'<MediaContainer location="fullScreenMusic" commandID="{int(command_id)}"{disconnect}>'
                f'<Timeline {values}/></MediaContainer>').encode("utf-8")

    def start(self) -> None:
        if self.is_active():
            return
        if self.httpd or self.gdm_socket:
            self.stop()
        self.error = ""
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
                    name = html.escape(receiver.device_name, quote=True)
                    root = (f'<MediaContainer friendlyName="{name}" machineIdentifier="{receiver.machine_id}">'
                            f'<Player title="{name}" machineIdentifier="{receiver.machine_id}" '
                            'product="DeckyPlex" version="1.0.0" platform="SteamOS" '
                            'protocolVersion="1" protocolCapabilities="timeline,playback,playqueues" deviceClass="stb">'
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
                        receiver.polling_controllers.pop((client_id, self.client_address[0]), None)
                        pending_disconnect = receiver.poll_disconnects.pop((client_id, self.client_address[0]), None)
                        if pending_disconnect:
                            pending_disconnect.set()
                        if client_id:
                            receiver.controllers.pop(client_id, None)
                        else:
                            receiver.controllers = {key: value for key, value in receiver.controllers.items()
                                                    if value.get("host") != self.client_address[0]}
                    return self._send(b"", "application/xml")
                if parsed.path == "/player/timeline/poll":
                    params = urllib.parse.parse_qs(parsed.query)
                    try:
                        command_id = int(params.get("commandID", ["0"])[0])
                    except (TypeError, ValueError):
                        command_id = 0
                    body, pending_disconnect = receiver.poll_timeline(
                        self.client_address[0], self.headers.get("X-Plex-Client-Identifier", ""), command_id,
                        wait=params.get("wait", ["0"])[0] == "1")
                    self.send_response(200)
                    self.send_header("Content-Type", "application/xml")
                    self.send_header("Content-Length", str(len(body)))
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("X-Plex-Client-Identifier", receiver.machine_id)
                    self.send_header("Access-Control-Expose-Headers", "X-Plex-Client-Identifier")
                    self.end_headers()
                    self.wfile.write(body)
                    if pending_disconnect:
                        pending_disconnect.set()
                    return
                if parsed.path.startswith("/player/playback/"):
                    command = parsed.path.rsplit("/", 1)[-1]
                    aliases = {"playMedia": "playMedia", "play": "play", "pause": "pause",
                               "stop": "stop", "skipNext": "next", "skipPrevious": "previous",
                               "skipTo": "skipTo", "seekTo": "seek", "setParameters": "parameters",
                               "refreshPlayQueue": "refreshQueue"}
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
        while self.gdm_socket:
            try:
                packet, address = self.gdm_socket.recvfrom(2048)
                if packet.startswith(b"M-SEARCH") and not self.shutting_down:
                    self.gdm_socket.sendto(self._response_headers(), address)
            except socket.timeout:
                continue
            except OSError:
                break
            except Exception as exc:
                logger.debug("Plex GDM responder error: %s", exc)

    def stop(self) -> None:
        server, self.httpd = self.httpd, None
        if server:
            if self.http_thread and self.http_thread.is_alive():
                server.shutdown()
            server.server_close()
        thread, self.http_thread = self.http_thread, None
        if thread and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=2)
        sock, self.gdm_socket = self.gdm_socket, None
        if sock:
            try:
                sock.close()
            except Exception:
                pass
        thread, self.gdm_thread = self.gdm_thread, None
        if thread and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=2)

    def is_active(self) -> bool:
        return bool(self.httpd and self.http_thread and self.http_thread.is_alive()
                    and self.gdm_socket and self.gdm_thread and self.gdm_thread.is_alive())


class RemotePlaybackError(RuntimeError):
    """An actionable remote playback error safe to show in the UI."""


def _plex_error_code(error: Exception) -> str:
    # SDK exceptions can include the full command URL and its transient token.
    status = re.match(r"^\((\d{3})\)", str(error))
    return f"{type(error).__name__} HTTP {status[1]}" if status else type(error).__name__


class PlexHTTP:
    """Small Decky-facing adapter around the bundled python-plexapi SDK."""

    def __init__(self, base_url: str, token: str, timeout: int = 8, verify_tls: bool = False,
                 account_token: str = "", *, connected_server=None):
        import requests
        from plexapi.server import PlexServer

        self.base_url = base_url.rstrip("/")
        self.token = token
        self.account_token = account_token or token
        self.timeout = timeout
        self.session = connected_server._session if connected_server is not None else requests.Session()
        if connected_server is None:
            self.session.verify = bool(verify_tls)
        self._remote_client_cache = {}
        self._lan_players = {}
        self._lan_player_scan_until = 0.0
        self._lan_player_scan_lock = threading.Lock()
        self._remote_timeline_track = {}
        self._remote_timeline_track_key = None
        self._remote_metadata_servers = {}
        self.sdk = (connected_server if connected_server is not None
                    else PlexServer(self.base_url, token, session=self.session, timeout=timeout))
        self._account = None

    @property
    def account(self):
        if self._account is None:
            from plexapi.myplex import MyPlexAccount
            self._account = MyPlexAccount(token=self.account_token, session=self.session, timeout=self.timeout)
        return self._account

    @staticmethod
    def _item_dict(item: Any, *, from_listing: bool = False) -> Dict[str, Any]:
        from plexapi.base import PlexPartialObject

        if from_listing and isinstance(item, PlexPartialObject):
            # SDK objects from listings can fetch full metadata on every missing field.
            # Cards can use the data from the listing; opening an item fetches its details.
            item = copy(item)
            item._autoReload = False

        def attr(name, default=""):
            value = getattr(item, name, default)
            return default if value is None else value

        item_type = attr("type")
        artist = attr("grandparentTitle")
        episode_card = from_listing and item_type == "episode"
        # An Episode's parentThumb property can query the season even with auto-reload off.
        episode_season_thumb = ""
        if episode_card:
            episode_season_thumb = vars(item).get("_parentThumb") or vars(item).get("parentThumb") or ""
        thumb_path = ""
        if from_listing:
            thumb_path = attr("thumb") or (episode_season_thumb if episode_card else attr("parentThumb")) or attr("grandparentThumb")
        thumb = attr("thumbUrl") if not episode_card else ""
        if episode_card and thumb_path:
            thumb = item._server.url(thumb_path, includeToken=True)
        poster_path = ""
        poster = ""
        if item_type == "episode":
            poster_path = attr("grandparentThumb") or (episode_season_thumb if episode_card else attr("parentThumb"))
            if poster_path:
                poster = item._server.url(poster_path, includeToken=True)
        if item_type == "album":
            artist = artist or attr("parentTitle")
            if not artist and not from_listing:
                try:
                    artist = item.artist().title or ""
                except Exception:
                    artist = ""

        result = {
            "id": str(attr("ratingKey")), "key": attr("key"),
            "title": attr("title"), "titleSort": attr("titleSort"), "type": item_type, "artist": artist,
            "thumb": thumb, "art": attr("artUrl"), "poster": poster,
            "summary": attr("summary"), "year": attr("year"),
            "index": attr("index"), "parentIndex": attr("parentIndex"), "parentTitle": attr("parentTitle"),
            "grandparentTitle": attr("grandparentTitle"),
            "leafCount": attr("leafCount", 0), "viewCount": attr("viewCount", 0),
            "viewOffset": attr("viewOffset", 0),
            "duration": attr("duration", 0), "sectionId": str(attr("librarySectionID", "") or ""),
        }
        if item_type in ("show", "season"):
            result["viewedLeafCount"] = attr("viewedLeafCount", None)
        if item_type in ("movie", "show", "season", "episode"):
            result["userRating"] = attr("userRating", None)
        if item_type == "episode":
            # The SDK can fetch the season if its ID is absent. Use IDs already in the listing.
            result["parentId"] = str(vars(item).get("_parentRatingKey") or "")
            result["grandparentId"] = str(attr("grandparentRatingKey") or "")
        if from_listing and hasattr(item, "_server") and hasattr(item._server, "transcodeImage"):
            # Request appropriately sized artwork using Plex's cacheable image endpoint.
            def thumbnail(path, height):
                if isinstance(path, str) and path.startswith("/library/"):
                    return item._server.transcodeImage(path, height=height, width=320, minSize=False, upscale=False)
                return ""

            if item_type == "artist":
                thumb_path = attr("art") or thumb_path
            height = 480 if item_type in ("movie", "show", "season") else 180 if item_type in ("episode", "clip") else 320
            result["gridThumb"] = thumbnail(thumb_path, height)
            result["gridPoster"] = thumbnail(poster_path, 480)
        return result

    def _discover_lan_deckyplex(self, refresh: bool = False) -> Dict[str, Dict[str, str]]:
        from plexapi.gdm import GDM

        with self._lan_player_scan_lock:
            if not refresh and time.monotonic() < self._lan_player_scan_until:
                return self._lan_players
            own_id = _load_settings()["companion_id"]
            players = {}
            try:
                entries = GDM().all(scan_for_clients=True)
            except (OSError, ValueError) as error:
                logger.debug("Local Plex player discovery failed (%s)", _plex_error_code(error))
                return self._lan_players
            finally:
                self._lan_player_scan_until = time.monotonic() + 15
            for entry in entries:
                data = entry["data"]
                machine_id = data.get("Resource-Identifier", "")
                if (not machine_id or machine_id == own_id or data.get("Product") != "DeckyPlex"
                        or data.get("Content-Type") != "plex/media-player"
                        or "playback" not in data.get("Protocol-Capabilities", "").split(",")):
                    continue
                try:
                    address = ipaddress.IPv4Address(entry["from"][0])
                    port = int(data.get("Port", ""))
                except ValueError:
                    continue
                if (not address.is_private or address.is_unspecified or address.is_reserved
                        or not 1 <= port <= 65535):
                    continue
                players[machine_id] = {
                    "title": data.get("Name") or "DeckyPlex",
                    "product": "DeckyPlex", "platform": "SteamOS",
                    "machineIdentifier": machine_id, "key": machine_id,
                    "url": f"http://{address}:{port}",
                }
            self._lan_players = players
            return players

    def _connect_lan_deckyplex(self, machine_id: str, refused_url: str = ""):
        import requests
        from plexapi.client import PlexClient

        player = self._lan_players.get(machine_id)
        url = player["url"] if player else ""
        if not url or url == refused_url:
            return None

        class CompanionSession(requests.Session):
            def prepare_request(self, request):
                prepared = super().prepare_request(request)
                # PlexAPI can reuse a token header from another PlexClient.
                # LAN Companion requests use only the playMedia delegation token.
                prepared.headers.pop("X-Plex-Token", None)
                return prepared

        session = CompanionSession()
        session.trust_env = False
        session.max_redirects = 0
        try:
            client = PlexClient(baseurl=url, identifier=machine_id, session=session, timeout=2)
            if client.product == "DeckyPlex" and "playback" in client.protocolCapabilities:
                return client
        except Exception as error:
            logger.debug("Could not reach local DeckyPlex receiver (%s)", _plex_error_code(error))
        session.close()
        return None

    def discover_players(self) -> List[Dict[str, Any]]:
        own_id = _load_settings()["companion_id"]
        sessions = {}
        try:
            for session in self.sdk.sessions():
                player = getattr(session, "player", None)
                if player and player.machineIdentifier:
                    sessions[player.machineIdentifier] = session
        except Exception as e:
            logger.debug("Unable to include active session state in player list: %s", e)
        players = {}
        try:
            clients = self.sdk.clients()
        except Exception as error:
            logger.debug("Could not discover players through the Plex server (%s)", _plex_error_code(error))
            clients = []
        for client in clients:
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
        for machine_id, peer in self._discover_lan_deckyplex(refresh=True).items():
            session = sessions.get(machine_id)
            players[machine_id] = {key: value for key, value in peer.items() if key != "url"}
            players[machine_id].update(state=getattr(session, "state", "idle") or "idle", available=True)
        players.pop(own_id, None)
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
        items = [self._item_dict(item, from_listing=True) for item in tracks if getattr(item, "type", "") == "track"]
        return {"items": items, "has_more": len(items) == limit}

    def get_sessions(self) -> List[Any]:
        return self.sdk.sessions()

    def _client(self, machine_id: str, refused_url: str = ""):
        def usable(player):
            return player is not None and (not refused_url or player._baseurl != refused_url)

        client = self._remote_client_cache.get(machine_id)
        if usable(client):
            return client
        lan_url = self._lan_players.get(machine_id, {}).get("url")
        client = self._connect_lan_deckyplex(machine_id, refused_url)
        if client is None:
            try:
                client = next((c for c in self.sdk.clients() if c.machineIdentifier == machine_id and usable(c)), None)
            except Exception as error:
                logger.debug("Could not look up the Plex server's clients (%s)", _plex_error_code(error))
        if client is None:
            try:
                account = self.account
                resource = next((r for r in account.resources()
                                 if r.clientIdentifier == machine_id
                                 and set((r.provides or "").split(",")) & {"client", "player", "pubsub-player"}), None)
                if resource:
                    client = resource.connect(timeout=5, locations=["local", "remote", "relay"])
                else:
                    device = next((item for item in account.devices()
                                   if item.clientIdentifier == machine_id), None)
                    if device:
                        client = device.connect(timeout=5)
            except Exception as e:
                logger.debug("Could not connect to Plex player resource %s: %s", machine_id, _plex_error_code(e))
        if not usable(client):
            players = self._discover_lan_deckyplex(refresh=bool(refused_url))
            if players.get(machine_id, {}).get("url") != lan_url:
                client = self._connect_lan_deckyplex(machine_id, refused_url)
        if not usable(client):
            raise RemotePlaybackError("Could not connect to the selected player. Open it and try again.")
        self._remote_client_cache[machine_id] = client
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

    def play_remote_queue(self, machine_id: str, rating_keys: List[str], start_rating_key: str,
                          receiver: Optional[PlexCompanionReceiver] = None) -> None:
        from requests.exceptions import ConnectionError, ConnectTimeout, ReadTimeout
        from urllib3.exceptions import NewConnectionError

        track_ids = [int(key) for key in rating_keys]
        items = {}
        # PlexAPI supports fetching multiple metadata keys in one request. Keep
        # each batch bounded so large shuffle queues do not create oversized URLs.
        for start in range(0, len(track_ids), 200):
            items.update((item.ratingKey, item) for item in self.sdk.fetchItems(track_ids[start:start + 200])
                         if getattr(item, "type", "") == "track")
        tracks = [items[key] for key in track_ids if key in items]
        if not tracks:
            raise RemotePlaybackError("The selected queue contains no playable tracks.")
        start_item = next((track for track in tracks if str(track.ratingKey) == str(start_rating_key)), tracks[0])

        def create_queue():
            return self.sdk.createPlayQueue(tracks, startItem=start_item, shuffle=False, repeat=False,
                                            includeChapters=False, includeRelated=False)

        def send_direct(client):
            logger.info("Sending queue to %s (%s) via direct Companion connection", client.title, machine_id)
            client.proxyThroughServer(False)
            if client.product == "DeckyPlex":
                client.playMedia(create_queue())
                return
            host = urllib.parse.urlparse(client._baseurl or "").hostname or ""
            echo = None
            if receiver:
                receiver.disconnect_controllers(machine_id, host)
                echo = receiver.expect_outgoing_play(machine_id, host, start_item.ratingKey)
            try:
                client.createPlayQueue(self.sdk, tracks, startItem=start_item, shuffle=False, repeat=False)
            except (ConnectionError, ReadTimeout):
                # A read timeout can occur after delivery. Never replay it.
                raise
            except Exception as error:
                logger.warning("Direct createPlayQueue failed for %s (%s); trying SDK playMedia",
                               machine_id, _plex_error_code(error))
                queue = create_queue()
                try:
                    client.playMedia(queue)
                except (ConnectionError, ReadTimeout):
                    raise
                except Exception as direct_error:
                    logger.warning("Direct playMedia failed for %s (%s); trying Plex server proxy",
                                   machine_id, _plex_error_code(direct_error))
                    client.proxyThroughServer(True, server=self.sdk)
                    try:
                        client.playMedia(queue)
                    finally:
                        client.proxyThroughServer(False)
            if echo and echo.wait(0.4):
                raise RemotePlaybackError("Plexamp sent playback back to the Deck. Select This Device in Plexamp and retry.")

        client = self._client(machine_id)
        try:
            send_direct(client)
        except ConnectionError as error:
            self._remote_client_cache.pop(machine_id, None)
            reason = getattr(error.args[0], "reason", None) if error.args else None
            if not isinstance(error, ConnectTimeout) and not isinstance(reason, NewConnectionError):
                raise
            logger.info("Refreshing Plex player address after connection failure for %s (%s)",
                        machine_id, _plex_error_code(error))
            try:
                send_direct(self._client(machine_id, refused_url=client._baseurl))
            except ConnectionError as retry_error:
                self._remote_client_cache.pop(machine_id, None)
                raise RemotePlaybackError("Could not reach the selected player. Open it and try again.") from retry_error

    def remote_player_status(self, machine_id: str, known_queue_id: str = "", known_version: str = "",
                             known_item_id: str = "") -> Dict[str, Any]:
        # The player timeline carries the real queue ID and revision. PMS
        # sessions are a fallback for players without a readable timeline.
        player_error = None
        try:
            client = self._client(machine_id)
            music = self._remote_music_timeline(client)
        except Exception as error:
            self._remote_client_cache.pop(machine_id, None)
            player_error = error
        else:
            if music and music.state in ("playing", "paused") and music.ratingKey:
                return self._remote_music_status(client, music, known_queue_id, known_version, known_item_id)

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
                        "sourceServerId": self.sdk.machineIdentifier,
                },
                "progress": (getattr(session, "viewOffset", 0) or 0) / 1000,
                "duration": (getattr(session, "duration", 0) or 0) / 1000,
                "volume": getattr(player, "volume", None),
            }
        if player_error:
            raise player_error
        return {"state": "stopped", "track": None, "progress": 0, "duration": 0}

    @staticmethod
    def _remote_music_timeline(client):
        return next((entry for entry in client.timelines() if entry.type == "music"), None)

    @staticmethod
    def _remote_queue_id(music) -> str:
        queue_id = getattr(music, "playQueueID", None)
        if queue_id:
            return str(queue_id)
        match = re.match(r"^/playQueues/(\d+)(?:\?|$)", getattr(music, "containerKey", "") or "")
        return match[1] if match else ""

    def _remote_music_status(self, client, music, known_queue_id: str, known_version: str,
                             known_item_id: str) -> Dict[str, Any]:
        track = {"id": str(music.ratingKey), "duration": music.duration or 0,
                 "sourceServerId": music.machineIdentifier or ""}
        same_server = music.machineIdentifier == self.sdk.machineIdentifier
        metadata_key = (music.machineIdentifier, track["id"])
        if getattr(self, "_remote_timeline_track_key", None) != metadata_key:
            try:
                server = self.sdk if same_server else self._account_plex_server(music.machineIdentifier)
                if server:
                    item = server.fetchItem(music.ratingKey)
                    data = self._item_dict(item, from_listing=True)
                    cover = data.get("gridThumb") or data.get("thumb")
                    if not cover and getattr(item, "parentRatingKey", None):
                        cover = item.album().thumbUrl
                    self._remote_timeline_track = {
                        "title": item.title, "artist": item.grandparentTitle, "album": item.parentTitle,
                        "thumb": cover or "", "duration": item.duration,
                    }
                    self._remote_timeline_track_key = metadata_key
            except Exception as e:
                logger.debug("Could not load remote music metadata (%s)", _plex_error_code(e))
        if getattr(self, "_remote_timeline_track_key", None) == metadata_key:
            track.update(self._remote_timeline_track)
        status = {"state": music.state, "track": track, "volume": music.volume,
                  "progress": (music.time or 0) / 1000, "duration": (music.duration or track["duration"] or 0) / 1000}
        queue_id = self._remote_queue_id(music) if same_server else ""
        if not queue_id:
            return status
        item_id = str(getattr(music, "playQueueItemID", None) or "")
        version = str(getattr(music, "playQueueVersion", None) or "")
        status.update(play_queue_id=queue_id, play_queue_item_id=item_id, play_queue_version=version)
        if not version or (queue_id, version, item_id) != (known_queue_id, known_version, known_item_id):
            try:
                snapshot = self.get_companion_queue(queue_id, item_id, own=False)
                status["queue"] = snapshot["queue"]
                status["play_queue_version"] = snapshot["play_queue_version"] or version
                if not item_id and snapshot["selected_rating_key"] == track["id"]:
                    item_id = snapshot["selected_item_id"]
                    status["play_queue_item_id"] = item_id
            except Exception as error:
                logger.debug("Could not read remote play queue %s (%s)", queue_id, _plex_error_code(error))
                return status
        status["queue_editable"] = bool(item_id and "playqueues" in client.protocolCapabilities)
        return status

    def _account_plex_server(self, machine_id: str):
        # Use servers available to DeckyPlex's linked account. The phone's
        # playback timeline identifies the server but grants no access to it.
        if not machine_id or machine_id == "node":
            return None
        cached, expires = self._remote_metadata_servers.get(machine_id, (None, 0))
        if time.monotonic() < expires:
            return cached
        server = None
        try:
            resource = next((resource for resource in self.account.resources()
                             if resource.clientIdentifier == machine_id
                             and "server" in (resource.provides or "").split(",")), None)
            if resource:
                server = resource.connect(timeout=3, locations=["local", "remote", "relay"])
                if server.machineIdentifier != machine_id:
                    server = None
        except Exception as error:
            logger.debug("Could not connect to remote artwork server (%s)", _plex_error_code(error))
        self._remote_metadata_servers[machine_id] = (server, time.monotonic() + (300 if server else 30))
        return server

    def music_artwork(self, rating_key: int, *, server=None) -> str:
        sdk = server if server is not None else self.sdk
        item = sdk.fetchItem(rating_key)
        if getattr(item, "type", "") != "track":
            return ""
        artwork = self._item_dict(item, from_listing=True)
        candidates = [artwork.get("gridThumb"), artwork.get("thumb")]
        if getattr(item, "parentRatingKey", None):
            try:
                candidates.append(item.album().thumbUrl)
            except Exception:
                pass
        base = urllib.parse.urlsplit(sdk._baseurl)
        max_bytes = 1024 * 1024
        for candidate in dict.fromkeys(url for url in candidates if url):
            try:
                image = urllib.parse.urlsplit(candidate)
                if image.scheme != base.scheme or image.netloc != base.netloc:
                    continue
                with sdk._session.get(candidate, timeout=min(self.timeout, 4), stream=True, allow_redirects=False) as response:
                    content_type = response.headers.get("Content-Type", "").split(";", 1)[0].lower()
                    if response.status_code != 200 or content_type not in (
                            "image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"):
                        continue
                    data = bytearray()
                    for chunk in response.iter_content(chunk_size=16384):
                        data.extend(chunk)
                        if len(data) > max_bytes:
                            break
                    if 0 < len(data) <= max_bytes:
                        return f"data:{content_type};base64,{base64.b64encode(data).decode('ascii')}"
            except Exception as error:
                logger.debug("Could not load Plex artwork (%s)", _plex_error_code(error))
        return ""

    def edit_remote_music_queue(self, machine_id: str, queue_id: str, action: str, item_id: str) -> Dict[str, Any]:
        client = self._client(machine_id)
        music = self._remote_music_timeline(client)
        if (not music or music.state not in ("playing", "paused")
                or music.machineIdentifier != self.sdk.machineIdentifier
                or self._remote_queue_id(music) != queue_id or "playqueues" not in client.protocolCapabilities):
            raise RemotePlaybackError("The selected player no longer has this queue.")
        current_id = str(getattr(music, "playQueueItemID", None) or "")
        if not current_id:
            snapshot = self.get_companion_queue(queue_id, own=False)
            if snapshot["selected_rating_key"] == str(music.ratingKey):
                current_id = snapshot["selected_item_id"]
        if not current_id or (action == "remove" and item_id == current_id):
            raise RemotePlaybackError("The current track changed. Try editing the queue again.")
        result = {"success": True}
        if action == "remove":
            self.remove_companion_queue_item(queue_id, item_id)
        else:
            added = self.add_companion_queue_item(queue_id, current_id, item_id, action == "next", own=False)
            if added.get("warning"):
                result["warning"] = added["warning"]
        try:
            client.refreshPlayQueue(queue_id, mtype="music")
        except Exception as error:
            # The write already succeeded. Report it distinctly so the user
            # does not retry and accidentally add a second copy.
            logger.warning("Could not refresh the player for queue %s (%s)", queue_id, _plex_error_code(error))
            return {"success": True, "warning": "Plex saved the edit, but the player did not confirm the queue refresh."}
        logger.info("Updated queue %s on %s (%s)", queue_id, client.title, action)
        return result

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
            self._remote_client_cache.pop(machine_id, None)
            if client.product == "DeckyPlex":
                raise RemotePlaybackError("Could not reach the DeckyPlex receiver. Refresh players and try again.") from direct_error
            logger.warning("Direct playback command failed for %s (%s); retrying via Plex server",
                           machine_id, _plex_error_code(direct_error))
            client.proxyThroughServer(True, server=self.sdk)
            try:
                send()
            finally:
                client.proxyThroughServer(False)

    def get_library_sections(self) -> List[Dict[str, Any]]:
        return [{"id": str(section.key), "name": section.title, "type": section.type}
                for section in self.sdk.library.sections()]

    def get_section_contents(self, section_id: str, type_filter: str = "", limit: int = 100,
                             offset: int = 0, sort: str = "titleSort:asc") -> Dict[str, Any]:
        section = self.sdk.library.sectionByID(int(section_id))
        section_type = section.type
        if section_type not in LIBRARY_TYPES:
            raise ValueError("This Plex library type is unsupported")
        if type_filter and (section_type != "artist" or type_filter not in ("artist", "album", "track")):
            raise ValueError("Media type does not match this library")
        limit = max(1, min(int(limit), 250))
        offset = max(0, int(offset))
        if section_type not in ("movie", "show") or sort not in VIDEO_SORTS:
            sort = "titleSort:asc"
        options = {"sort": sort, "container_start": offset, "container_size": limit + 1, "maxresults": limit + 1}
        results = section.search(libtype=type_filter, **options) if type_filter else section.all(**options)
        items = [self._item_dict(item, from_listing=True) for item in results[:limit]]
        return {"items": items, "has_more": len(results) > limit, "next_offset": offset + len(items)}

    def get_video_home(self, row: str, libraries: List[Dict[str, Any]], full_watchlist: bool = False) -> List[Dict[str, Any]]:
        limit = 8
        if not libraries:
            return []
        library_ids = {library["id"] for library in libraries}
        if row == "continue":
            items = [item for item in self.sdk.continueWatching()
                     if item.type in ("movie", "episode") and str(vars(item).get("librarySectionID")) in library_ids]
            # Plex's hub contains resumed titles as well as the next available episodes.
            watch_next = [item for item in items if item.type == "episode" and not vars(item).get("viewOffset")]
            resumes = [item for item in items if vars(item).get("viewOffset")]
            items = [*resumes, *watch_next]
        elif row in ("movies", "shows"):
            kind = "movie" if row == "movies" else "show"
            items = [item for library in libraries if library["type"] == kind
                     for item in self.sdk.library.sectionByID(int(library["id"])).recentlyAdded(
                         maxresults=limit, libtype=kind)]
            items.sort(key=lambda item: item.addedAt.timestamp() if item.addedAt else 0, reverse=True)
        else:
            watchlist = self.account.watchlist(sort="watchlistedAt:desc", maxresults=None if full_watchlist else limit)
            matches = {}
            guids_by_type = {kind: [item.guid for item in watchlist if item.type == kind and item.guid]
                             for kind in ("movie", "show")}
            for library in libraries:
                guids = guids_by_type[library["type"]]
                if guids:
                    section = self.sdk.library.sectionByID(int(library["id"]))
                    for start in range(0, len(guids), 50):
                        batch = guids[start:start + 50]
                        for item in section.search(guid=batch):
                            matches.setdefault(item.guid, item)
            items = [matches[item.guid] for item in watchlist if item.guid in matches]
        cards = []
        show_art = {}
        for item in (items if row == "continue" or full_watchlist else items[:limit]):
            card = self._item_dict(item, from_listing=True)
            show_key = vars(item).get("grandparentKey")
            if item.type == "episode" and not card["poster"] and show_key:
                if show_key not in show_art:
                    try:
                        show_art[show_key] = self._item_dict(item.show(), from_listing=True)
                    except Exception:
                        show_art[show_key] = {}
                show = show_art[show_key]
                card["poster"] = show.get("thumb", "")
                card["gridPoster"] = show.get("gridThumb", "")
            cards.append(card)
        return cards

    def get_recent_video_page(self, row: str, libraries: List[Dict[str, Any]], offsets: Dict[str, Any]) -> Dict[str, Any]:
        limit = 18
        kind = "movie" if row == "movies" else "show"
        candidates = []
        next_offsets = {}
        remaining = {}
        for library in libraries:
            if library["type"] != kind:
                continue
            section_id = library["id"]
            offset = offsets.get(section_id, 0)
            if offset is None:
                next_offsets[section_id] = None
                continue
            if type(offset) is not int or offset < 0:
                raise ValueError("Invalid video shelf offset.")
            section = self.sdk.library.sectionByID(int(section_id))
            entries = section.search(sort="addedAt:desc", libtype=kind, container_start=offset,
                                     container_size=limit + 1, maxresults=limit + 1)
            next_offsets[section_id] = offset
            remaining[section_id] = len(entries)
            candidates.extend((entry, section_id) for entry in entries)

        candidates.sort(key=lambda pair: pair[0].addedAt.timestamp() if pair[0].addedAt else 0, reverse=True)
        cards = []
        for item, section_id in candidates[:limit]:
            cards.append(self._item_dict(item, from_listing=True))
            next_offsets[section_id] += 1
            remaining[section_id] -= 1
        for section_id, count in remaining.items():
            if not count:
                next_offsets[section_id] = None
        return {"items": cards, "recent_offsets": next_offsets}

    def get_music_artists(self, sections: List[Dict[str, Any]], limit: int, offset: int) -> Dict[str, Any]:
        """Page through the selected music sections in Plex library order."""
        limit = max(1, min(int(limit), 250))
        offset = max(0, int(offset))
        items = []
        for section_info in sections:
            section_id = section_info["id"]
            if offset:
                section = self.sdk.library.sectionByID(int(section_id))
                count = section.totalViewSize(libtype="artist", includeCollections=False)
                if offset >= count:
                    offset -= count
                    continue
            page = self.get_section_contents(section_id, "artist", limit - len(items), offset)
            items.extend({**item, "sectionId": section_id} for item in page["items"])
            if len(items) == limit:
                return {"items": items, "has_more": True}
            offset = 0
        return {"items": items, "has_more": False}

    def get_shuffled_tracks(self, section_id: str) -> List[Dict[str, Any]]:
        """Return every track in a music section in randomized queue order."""
        section = self.sdk.library.sectionByID(int(section_id))
        if getattr(section, "type", "") != "artist":
            raise ValueError("Selected library is not a music library")
        tracks = section.search(libtype="track", sort="titleSort:asc")
        if not tracks:
            return []
        random.shuffle(tracks)
        return [self._item_dict(track, from_listing=True) for track in tracks if getattr(track, "type", "") == "track"]

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
        elif item.type == "show":
            children = item.seasons()
        elif item.type == "season":
            children = item.episodes()
        elif item.type == "photoalbum":
            children = item.albums() + item.photos() + item.clips()
        else:
            children = item.fetchItems(f"{item.key}/children")
        return [self._item_dict(child, from_listing=True) for child in children]

    def get_artist_tracks(self, artist_id: str) -> List[Dict[str, Any]]:
        artist = self.sdk.fetchItem(int(artist_id))
        if getattr(artist, "type", "") != "artist":
            raise ValueError("Selected Plex item is not an artist")
        tracks = artist.tracks(maxresults=1000)
        return [self._item_dict(track, from_listing=True) for track in tracks]

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
            result.append(self._item_dict(history_item, from_listing=True))
        return result

    def get_recently_added(self, section_id: str, limit: int = 50) -> List[Dict[str, Any]]:
        """Return the newest albums in a music library, using PlexAPI sorting."""
        section = self.sdk.library.sectionByID(int(section_id))
        albums = section.search(libtype="album", sort="addedAt:desc", maxresults=max(1, min(int(limit), 100)))
        return [self._item_dict(album, from_listing=True) for album in albums]

    def get_audio_playlists(self, limit: int = 100) -> List[Dict[str, Any]]:
        playlists = self.sdk.playlists(playlistType="audio", sort="titleSort:asc")
        result = []
        for playlist in playlists[:max(1, min(int(limit), 100))]:
            composite = getattr(playlist, "composite", "") or ""
            result.append({
                "id": str(playlist.ratingKey), "key": playlist.key,
                "title": playlist.title or "Untitled playlist", "titleSort": getattr(playlist, "titleSort", "") or "", "type": "playlist",
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
        return [self._item_dict(item, from_listing=True) for item in playlist.items(libtype="track")[:max(1, min(int(limit), 200))]]

    def search_library(self, query: str, section_id: str = "", limit: int = 20,
                       library_ids=None, include_other_media: bool = False) -> List[Dict[str, Any]]:
        if section_id:
            results = self.sdk.library.sectionByID(int(section_id)).search(title=query, maxresults=limit)
        else:
            results = self.sdk.search(query, limit=limit)
        supported = ("artist", "album", "track")
        if include_other_media:
            supported += VIDEO_TYPES + ("show", "season", "photoalbum", "photo")
        if library_ids is not None:
            return [self._item_dict(item, from_listing=True) for item in results
                    if getattr(item, "type", "") in supported
                    and str(getattr(item, "librarySectionID", "")) in library_ids]
        return [self._item_dict(item, from_listing=True) for item in results if getattr(item, "type", "") in supported]

    @staticmethod
    def _video_track_options(tracks, label: str):
        options = []
        for track in tracks:
            if not track.id:
                continue
            title = track.extendedDisplayTitle or track.displayTitle or track.language or label
            for attribute, badge in (("forced", "Forced"), ("hearingImpaired", "SDH")):
                if getattr(track, attribute, False) and badge.lower() not in title.lower():
                    title += f" · {badge}"
            options.append({"data": track.id, "label": title})
        return options

    def get_media_source(self, rating_key: str, quality: str = "auto", media_index: int = 0) -> Dict[str, Any]:
        item = self.sdk.fetchItem(int(rating_key), params={"includeChapters": 1})
        if item.type not in (*VIDEO_TYPES, "photo"):
            raise ValueError("This Plex item cannot be played directly")
        versions = item.media or []
        if versions and not 0 <= media_index < len(versions):
            raise ValueError("That video version is unavailable.")
        primary_media = versions[media_index] if versions else None
        parts = [part for part in getattr(primary_media, "parts", []) if part.key]
        part = parts[0] if parts else None
        direct_url = self.sdk.url(part.key, includeToken=True) if part else ""
        if item.type == "photo":
            images = list(dict.fromkeys(url for url in (direct_url, item.thumbUrl) if url))
            return {"streams": [{"kind": "image", "url": url} for url in images]}

        resolution, bitrate = VIDEO_QUALITY.get(quality, VIDEO_QUALITY["auto"])
        if quality == "auto":
            width = getattr(primary_media, "width", None)
            height = getattr(primary_media, "height", None)
            if width and height:
                resolution = f"{width}x{height}"
            bitrate = getattr(primary_media, "bitrate", None) or None
        audio_tracks = part.audioStreams() if part else []
        default_audio = next((track for track in audio_tracks if getattr(track, "default", False)),
                             audio_tracks[0] if audio_tracks else None)
        audio = next((track for track in audio_tracks if track.selected), default_audio)
        subtitle_tracks = part.subtitleStreams() if part else []
        subtitle = next((track for track in subtitle_tracks if track.selected), None)
        codec = str(getattr(audio, "codec", None) or getattr(primary_media, "audioCodec", "") or "").lower()
        video_codec = str(getattr(primary_media, "videoCodec", "") or "").lower()
        channels = getattr(audio, "channels", None) or getattr(primary_media, "audioChannels", None)
        container = str(getattr(part, "container", "") or "").lower()
        compatible_audio = not codec or (codec in VIDEO_DIRECT_AUDIO.get(container, ()) and (channels or 2) <= 2)

        def transcode(protocol, container, session_id, copy_video=False, copy_audio=False):
            return item.getStreamURL(protocol=protocol, mediaIndex=media_index, directPlay=0,
                                     directStream=int(copy_video), directStreamAudio=int(copy_audio),
                                     subtitles="burn" if subtitle else "none",
                                     audioChannelCount=2, partIndex=0 if len(parts) == 1 else -1,
                                     videoResolution=(resolution or "") if not copy_video else "",
                                     maxVideoBitrate=bitrate if not copy_video else None,
                                     videoBitrate=bitrate if not copy_video else None,
                                     transcodeSessionId=session_id,
                                     **{"X-Plex-Client-Identifier": self.sdk._headers()["X-Plex-Client-Identifier"],
                                        "X-Plex-Session-Identifier": session_id,
                                        "X-Plex-Client-Profile-Name": "Generic",
                                        "X-Plex-Client-Profile-Extra":
                                            "add-transcode-target(type=videoProfile&context=streaming&"
                                            f"protocol={protocol}&container={container}&videoCodec=h264&audioCodec=aac&replace=true)"})

        hls_url = transcode("hls", "mpegts", str(uuid.uuid4()))
        # The SDK builds a manifest path. Use the documented binary HTTP
        # response as another fallback when the webview can't load HLS.
        url = urllib.parse.urlsplit(transcode("http", "mp4", str(uuid.uuid4())))
        mp4_url = urllib.parse.urlunsplit(url._replace(path=url.path.removesuffix(".m3u8") + ".mp4"))
        streams = [{"kind": "hls", "url": hls_url, "fallback_url": transcode("hls", "mpegts", str(uuid.uuid4()))},
                   {"kind": "http", "url": mp4_url}]
        if quality == "auto" and len(parts) == 1 and not subtitle:
            if container in VIDEO_DIRECT_AUDIO and compatible_audio and audio is default_audio:
                streams.insert(0, {"kind": "direct", "url": direct_url})
            elif video_codec == "h264":
                # Preserve H.264 in the compatibility stream where Plex can copy it. Convert incompatible audio to AAC.
                copy_audio = codec in ("aac", "mp3") and (channels or 2) <= 2
                streams.insert(0, {"kind": "hls", "mode": "direct-stream" if copy_audio else "audio-conversion",
                                   "url": transcode("hls", "mpegts", str(uuid.uuid4()), copy_video=True, copy_audio=copy_audio)})
        logger.info("Video source item=%d quality=%s container=%s video=%s audio=%s channels=%s candidates=%s",
                    int(rating_key), quality, re.sub(r"[^a-z0-9_-]", "", container)[:32] or "unknown",
                    re.sub(r"[^a-z0-9_-]", "", video_codec)[:32] or "unknown",
                    re.sub(r"[^a-z0-9_-]", "", codec)[:32] or "unknown", channels,
                    ",".join(stream.get("mode", stream["kind"]) for stream in streams))
        chapters = [{"title": chapter.title or "", "start": chapter.start / 1000}
                    for chapter in getattr(item, "chapters", []) if chapter.start is not None and chapter.start >= 0]
        version_options = []
        for index, version in enumerate(versions):
            label = " · ".join(str(value).upper() for value in
                               (getattr(version, "videoResolution", None), getattr(version, "videoCodec", None),
                                getattr(version, "container", None)) if value)
            version_options.append({"data": index, "label": f"{index + 1}. {label}" if label else f"Version {index + 1}"})
        preview_path = f"/library/parts/{part.id}/indexes/sd" if part and getattr(part, "hasPreviewThumbnails", False) else ""
        return {"streams": streams, "resume_ms": getattr(item, "viewOffset", 0) or 0,
                "duration_ms": getattr(primary_media, "duration", None) or getattr(item, "duration", 0) or 0,
                "has_audio": bool(codec), "media_index": media_index, "versions": version_options,
                "audio_tracks": self._video_track_options(audio_tracks, "Audio"),
                "subtitle_tracks": self._video_track_options(subtitle_tracks, "Subtitles"),
                "audio_track": getattr(audio, "id", None), "subtitle_track": getattr(subtitle, "id", 0),
                "video_codec": video_codec, "audio_codec": codec, "channels": channels, "container": container,
                "bitrate": getattr(primary_media, "bitrate", None), "chapters": chapters,
                "preview_url": self.sdk.url(preview_path, includeToken=True) if preview_path else ""}

    def set_video_stream(self, rating_key: str, media_index: int, kind: str, stream_id: int):
        item = self.sdk.fetchItem(int(rating_key))
        if item.type not in VIDEO_TYPES or not 0 <= media_index < len(item.media or []):
            raise ValueError("Video version unavailable.")
        part = next((part for part in item.media[media_index].parts if part.key), None)
        if not part:
            raise ValueError("Video part unavailable.")
        if kind == "subtitle" and stream_id == 0:
            part.resetSelectedSubtitleStream()
            return
        tracks = part.audioStreams() if kind == "audio" else part.subtitleStreams()
        track = next((track for track in tracks if track.id == stream_id), None)
        if not track:
            raise ValueError("Track unavailable for this video version.")
        if kind == "audio":
            part.setSelectedAudioStream(track)
        else:
            part.setSelectedSubtitleStream(track)

    def video_skip_markers(self, rating_key: str):
        item = self.sdk.fetchItem(int(rating_key), params={"includeMarkers": 1})
        if item.type not in ("movie", "episode"):
            return []
        markers = [{"type": marker.type, "start": marker.start / 1000, "end": marker.end / 1000}
                   for marker in item.markers if marker.type in ("intro", "credits")
                   and marker.start is not None and marker.end is not None and marker.end > marker.start >= 0]
        return markers if markers and self.account.subscriptionActive else []

    def video_library_action(self, rating_key: str, action: str, rating: Optional[int] = None) -> Dict[str, Any]:
        item = self.sdk.fetchItem(int(rating_key))
        if action == "rate" and item.type in ("movie", "show", "season", "episode"):
            from plexapi.mixins import RatingMixin
            RatingMixin.rate(item, rating)
            return {"user_rating": rating}
        watchlist = action in ("add_watchlist", "remove_watchlist")
        supported = ("movie", "show") if watchlist else ("movie", "episode")
        if item.type not in supported:
            raise ValueError("This Plex title does not support the requested action.")
        if watchlist:
            from plexapi.exceptions import BadRequest
            added = action == "add_watchlist"
            try:
                change = item.addToWatchlist if added else item.removeFromWatchlist
                change(account=self.account)
            except BadRequest:
                if item.onWatchlist(account=self.account) != added:
                    raise
            return {"on_watchlist": added}
        if action == "remove_continue":
            item.removeFromContinueWatching()
            return {}
        if action == "mark_watched":
            item.markWatched()
        elif action == "mark_unwatched":
            item.markUnwatched()
        else:
            raise ValueError("Unknown video action.")
        return self._video_watch_state(item)

    def _video_watch_state(self, item) -> Dict[str, Any]:
        item.reload()
        state = {"view_count": int(getattr(item, "viewCount", None) or 0),
                 "view_offset": int(getattr(item, "viewOffset", None) or 0)}
        if item.type == "episode":
            metadata = vars(item)
            ids = list(dict.fromkeys(key for key in
                       (metadata.get("_parentRatingKey"), metadata.get("grandparentRatingKey")) if key))
            if ids:
                try:
                    state["collections"] = {
                        str(collection.ratingKey): viewed
                        for collection in self.sdk.fetchItems(ids)
                        if collection.type in ("show", "season")
                        and (viewed := vars(collection).get("viewedLeafCount")) is not None
                    }
                except Exception:
                    logger.debug("Could not refresh Plex collection watch counts", exc_info=True)
        return state

    def report_video_progress(self, rating_key: str, time_ms: int, duration_ms: int, state: str) -> Optional[Dict[str, Any]]:
        item = self.sdk.fetchItem(int(rating_key))
        if item.type in VIDEO_TYPES and state in ("playing", "paused", "stopped"):
            item.updateTimeline(max(0, int(time_ms)), state=state, duration=max(0, int(duration_ms)))
            if state == "stopped" and item.type in ("movie", "episode"):
                return self._video_watch_state(item)
        return None

    def get_episode_queue(self, rating_key: str) -> List[Dict[str, Any]]:
        item = self.sdk.fetchItem(int(rating_key))
        if item.type == "episode":
            item = item.season()
        if item.type not in ("season", "show"):
            return []
        episodes = sorted(item.episodes(),
                          key=lambda entry: (entry.parentIndex or 0, entry.index or 0, entry.ratingKey))
        return [self._item_dict(entry, from_listing=True) for entry in episodes]

    def get_hubs(self, section_ids: Optional[List[str]] = None) -> List[Dict[str, Any]]:
        hubs = self.sdk.library.hubs(sectionID=section_ids or None)
        result = []
        for hub in hubs:
            items = [self._item_dict(item, from_listing=True) for item in hub.items()]
            if items:
                result.append({"title": hub.title or "", "key": hub.key or "",
                               "type": hub.type or "", "items": items})
        return result

    def get_server_identity(self) -> Dict[str, str]:
        return {"machineIdentifier": self.sdk.machineIdentifier or "",
                "friendlyName": self.sdk.friendlyName or "", "version": self.sdk.version or ""}

    def get_stream_urls(self, rating_key: str, *, track=None, media_server=None) -> Dict[str, str]:
        """Prefer PlexAPI's direct media URL for common codecs, with MP3 transcode fallback."""
        sdk = media_server if media_server is not None else self.sdk
        if track is None:
            track = sdk.fetchItem(int(rating_key))
        if getattr(track, "type", "") != "track":
            raise ValueError("Selected Plex item is not a music track")
        media = list(getattr(track, "media", []) or [])
        part = next((part for item in media for part in (getattr(item, "parts", []) or [])
                     if getattr(part, "key", "")), None)
        direct_url = sdk.url(part.key, includeToken=True) if part else ""
        codec = str(getattr(media[0], "audioCodec", "") or "").lower() if media else ""
        # The transcoder requires a client identifier. Reuse PlexAPI's
        # configured identifier and advertise an MP3 target profile so the
        # response is an audio/mpeg byte stream, not a manifest/error document.
        client_identifier = sdk._headers().get("X-Plex-Client-Identifier", "deckyplex")
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
        transcode_url = sdk.url(f"/music/:/transcode/universal/start.m4a?{params}", includeToken=True)
        if direct_url and codec in ("mp3", "flac"):
            return {"stream_url": direct_url, "fallback_stream_url": transcode_url,
                    "stream_mode": f"direct-{codec}"}
        return {"stream_url": transcode_url,
                "fallback_stream_url": direct_url if codec in ("mp3", "flac") else "",
                "stream_mode": "transcode-aac"}

    def _companion_media_server(self, source_id: str, account_plex=None):
        if not source_id or source_id == self.sdk.machineIdentifier:
            return self.sdk
        if account_plex:
            server = (account_plex.sdk if source_id == account_plex.sdk.machineIdentifier
                      else account_plex._account_plex_server(source_id))
            if server:
                return server
        raise RemotePlaybackError("This track is on another Plex server. Cast it directly from Plexamp or sign in to an account with access to that server.")

    @staticmethod
    def _companion_server_context(sdk, token: str) -> Dict[str, Any]:
        url = urllib.parse.urlparse(sdk._baseurl)
        return {"source": "companion", "machine_identifier": sdk.machineIdentifier or "",
                "address": url.hostname or "", "port": url.port or 32400,
                "protocol": url.scheme or "http", "token": token}

    def companion_track_streams(self, rating_key: str, source_server_id: str = "", account_plex=None, *, track=None):
        server = self._companion_media_server(source_server_id, account_plex)
        streams = self.get_stream_urls(rating_key, track=track, media_server=server)
        if server is not self.sdk:
            # The linked account authorizes Deck playback. The receiver's
            # timeline must not send that account's token to LAN controllers.
            streams["media_context"] = self._companion_server_context(server, "")
        return streams

    def prepare_companion_playback(self, key: str, container_key: str = "", account_plex=None) -> Dict[str, Any]:
        parsed = urllib.parse.urlparse(key or "")
        match = re.search(r"/library/metadata/(\d+)", parsed.path or key or "")
        if not match:
            raise ValueError("Plexamp sent an unsupported media key")
        requested_rating_key = match.group(1)
        rating_key = requested_rating_key
        queue = []
        active_queue_id = ""
        active_item_id = ""
        active_queue_version = ""
        queue_id = re.search(r"/playQueues/(\d+)", container_key or "")
        if queue_id:
            try:
                from plexapi.playqueue import PlayQueue
                queue_params = urllib.parse.parse_qs(urllib.parse.urlparse(container_key).query)
                own_queue = queue_params.get("own", ["0"])[0] == "1"
                play_queue = PlayQueue.get(self.sdk, int(queue_id.group(1)), own=own_queue,
                                           window=200, includeBefore=True, includeAfter=True)
                active_queue_id = str(play_queue.playQueueID or "")
                active_queue_version = str(play_queue.playQueueVersion or "")
                queue_selected_key = str(getattr(play_queue, "playQueueSelectedMetadataItemID", "") or "")
                queue_selected_offset = getattr(play_queue, "playQueueSelectedItemOffset", "")
                def queue_track_matches(track: Any) -> bool:
                    if str(getattr(track, "ratingKey", "") or "") == rating_key:
                        return True
                    track_key = str(getattr(track, "key", "") or "")
                    track_match = re.search(r"/library/metadata/(\d+)", track_key)
                    return bool(track_match and track_match.group(1) == rating_key)

                # Some Plexamp playMedia requests retain the old queue's key
                # while the newly created queue identifies the tapped song in
                # playQueueSelectedMetadataItemID. Prefer that queue selection
                # only when the selected item is actually present in the queue.
                selected_queue_item = next(
                    (track for track in play_queue.items
                     if str(getattr(track, "ratingKey", "") or "") == queue_selected_key), None
                ) if queue_selected_key else None
                if selected_queue_item and queue_selected_key != requested_rating_key:
                    logger.info("Companion key %s differs from queue-selected track %s; using the queue selection",
                                requested_rating_key, queue_selected_key)
                    rating_key = queue_selected_key
                requested_queue_item = selected_queue_item or next(
                    (track for track in play_queue.items if queue_track_matches(track)), None
                )
                center_item_id = str(
                    getattr(requested_queue_item, "playQueueItemID", "")
                    or getattr(play_queue, "playQueueSelectedItemID", "") or ""
                )
                if center_item_id:
                    play_queue = PlayQueue.get(
                        self.sdk, int(queue_id.group(1)), own=own_queue, window=200,
                        includeBefore=True, includeAfter=True,
                        center=int(center_item_id),
                    )
                tracks = self._companion_queue_tracks(play_queue.items)
                selected_index = next((index for index, track in enumerate(tracks)
                                       if center_item_id and track.get("playQueueItemID") == center_item_id
                                       and track.get("id") == rating_key), -1)
                if selected_index < 0:
                    selected_index = next((index for index, track in enumerate(tracks)
                                           if track.get("id") == rating_key), -1)
                logger.info("Incoming play queue %s requested ratingKey=%s; using ratingKey=%s matched position=%s/%s (window size=%s)",
                            queue_id.group(1), requested_rating_key, rating_key,
                            selected_index + 1 if selected_index >= 0 else "not found",
                            getattr(play_queue, "playQueueTotalCount", len(tracks)), len(tracks))
                logger.info("Incoming play queue %s server selection: ratingKey=%s offset=%s own=%s",
                            queue_id.group(1), queue_selected_key, queue_selected_offset, int(own_queue))
                if selected_index >= 0:
                    # The phone selected this item from somewhere inside the
                    # play queue. Keep it first so Decky never restarts at the
                    # queue's first track and doesn't replay earlier songs.
                    queue = tracks[selected_index:]
                    active_item_id = str(queue[0].get("playQueueItemID") or active_item_id)
                elif tracks:
                    # If Plex returned a trimmed queue window without the
                    # selected item, still start the requested item rather
                    # than silently falling back to the first item in window.
                    logger.warning("Selected Companion track %s was not present in play queue %s; using a single-track queue",
                                   rating_key, queue_id.group(1))
            except Exception as exc:
                logger.warning("Could not load incoming Plex play queue %s (%s)", queue_id.group(1), _plex_error_code(exc))
        source_server_id = queue[0].get("sourceServerId", "") if queue else ""
        media_server = self._companion_media_server(source_server_id, account_plex)
        item = media_server.fetchItem(int(rating_key))
        if getattr(item, "type", "") != "track":
            raise ValueError("Plexamp target currently supports music tracks only")
        selected = self._item_dict(item)
        streams = self.companion_track_streams(rating_key, source_server_id, account_plex, track=item)
        selected["playQueueItemID"] = active_item_id
        if source_server_id:
            selected["sourceServerId"] = source_server_id
        if not queue:
            queue = [selected]
        server_context = self._companion_server_context(self.sdk, self.token)
        return {"success": True, "track": selected, "queue": queue,
                "play_queue_id": active_queue_id,
                "play_queue_item_id": active_item_id,
                "play_queue_version": active_queue_version,
                "container_key": f"/playQueues/{active_queue_id}?window=200&own=1" if active_queue_id else "",
                "server_context": server_context,
                **streams}

    def _companion_queue_entries(self, queue) -> List[Any]:
        from plexapi.playqueue import PlayQueue
        entries = list(queue.items)
        known = {entry.playQueueItemID for entry in entries}
        while entries and len(entries) < (getattr(queue, "playQueueTotalCount", None) or 0):
            page = PlayQueue.get(self.sdk, queue.playQueueID, center=entries[-1].playQueueItemID,
                                 window=200, includeBefore=False)
            more = [entry for entry in page.items if entry.playQueueItemID not in known]
            if not more:
                break
            entries.extend(more)
            known.update(entry.playQueueItemID for entry in more)
        return entries

    def _companion_queue_tracks(self, entries) -> List[Dict[str, Any]]:
        tracks = []
        for track in entries:
            if getattr(track, "type", "") != "track":
                continue
            track_dict = self._item_dict(track, from_listing=True)
            if not track_dict["id"]:
                key = re.match(r"/library/metadata/(\d+)", track_dict.get("key", ""))
                if key:
                    track_dict["id"] = key[1]
            track_dict["playQueueItemID"] = str(getattr(track, "playQueueItemID", "") or "")
            source = re.match(r"^server://([a-zA-Z0-9-]+)/com\.plexapp\.plugins\.library(?:/|$)",
                              vars(track).get("sourceURI") or "")
            if source and source[1] not in ("local", "node"):
                track_dict["sourceServerId"] = source[1]
            tracks.append(track_dict)
        return tracks

    def get_companion_queue(self, play_queue_id: str, center_item_id: str = "",
                            include_remaining: bool = False, own: bool = True) -> Dict[str, Any]:
        """Fetch the active Companion play queue around its current item."""
        from plexapi.playqueue import PlayQueue
        queue = PlayQueue.get(self.sdk, int(play_queue_id), own=own,
                              window=200, includeBefore=True, includeAfter=True,
                              center=int(center_item_id) if str(center_item_id).isdigit() else None)
        entries = self._companion_queue_entries(queue) if include_remaining else queue.items
        tracks = self._companion_queue_tracks(entries)
        return {"queue": tracks, "play_queue_id": str(queue.playQueueID or play_queue_id),
                "play_queue_version": str(queue.playQueueVersion or ""),
                "selected_item_id": str(queue.playQueueSelectedItemID or ""),
                "selected_rating_key": str(queue.playQueueSelectedMetadataItemID or ""),
                "selected_offset": int(queue.playQueueSelectedItemOffset or 0)}

    def create_local_companion_queue(self, rating_keys: List[int]) -> Dict[str, Any]:
        """Publish the currently playing track followed by the Deck's upcoming tracks."""
        keys = list(dict.fromkeys(rating_keys))
        tracks = {}
        for offset in range(0, len(keys), 100):
            for item in self.sdk.fetchItems(keys[offset:offset + 100]):
                if item.type == "track":
                    tracks[item.ratingKey] = item
        if any(key not in tracks for key in keys):
            raise ValueError("An item in the current queue is unavailable on this Plex server.")
        queue = self.sdk.createPlayQueue([tracks[key] for key in rating_keys], includeRelated=False, window=200)
        entries = self._companion_queue_entries(queue)
        if (not queue.playQueueID or [entry.ratingKey for entry in entries] != rating_keys
                or any(not entry.playQueueItemID for entry in entries)):
            raise ValueError("Plex did not return the same tracks in the requested queue order.")
        server_url = urllib.parse.urlparse(self.base_url)
        try:
            token = self.sdk.createToken() or ""
        except Exception:
            token = ""
            logger.debug("Could not delegate a server token for the local Companion queue")
        return {
            "play_queue_id": str(queue.playQueueID),
            "play_queue_version": str(queue.playQueueVersion or ""),
            "container_key": f"/playQueues/{queue.playQueueID}?window=200",
            "item_ids": [str(entry.playQueueItemID) for entry in entries],
            "server_context": {"source": "local", "machine_identifier": self.sdk.machineIdentifier,
                               "address": server_url.hostname or "", "port": server_url.port or 32400,
                               "protocol": server_url.scheme, "token": token},
        }

    def report_companion_queue_timeline(self, timeline: Dict[str, Any]) -> None:
        # PlexAPI's Playable.updateTimeline does not accept play queue identifiers.
        # Use the documented timeline endpoint through the SDK's authenticated session.
        params = {"ratingKey": timeline["ratingKey"], "key": timeline["key"],
                  "identifier": "com.plexapp.plugins.library", "state": timeline["state"],
                  "time": timeline["time"], "duration": timeline["duration"],
                  "playQueueID": timeline["playQueueID"], "playQueueItemID": timeline["playQueueItemID"],
                  "playQueueVersion": timeline["playQueueVersion"],
                  "containerKey": f"/playQueues/{timeline['playQueueID']}"}
        self.sdk.query(f"/:/timeline?{urllib.parse.urlencode(params)}", method=self.session.post,
                       timeout=min(self.timeout, 2))

    def add_companion_queue_item(self, play_queue_id: str, current_item_id: str,
                                 rating_key: str, play_next: bool, own: bool = True, *, source_track=None) -> Dict[str, Any]:
        """Add a track to Plex's shared queue and return its real queue item ID."""
        from plexapi.playqueue import PlayQueue
        window_options = {"own": own, "window": 200, "includeBefore": True, "includeAfter": True,
                          "center": int(current_item_id) if str(current_item_id).isdigit() else None}
        queue = PlayQueue.get(self.sdk, int(play_queue_id), **window_options)
        old_item_ids = {str(getattr(item, "playQueueItemID", "") or "") for item in queue.items}
        old_version = queue.playQueueVersion
        track = source_track if source_track is not None else self.sdk.fetchItem(int(rating_key))
        if getattr(track, "type", "") != "track":
            raise ValueError("Only music tracks can be added to the Plexamp queue")
        source_id = getattr(getattr(track, "_server", None), "machineIdentifier", self.sdk.machineIdentifier)
        foreign_track = source_id != self.sdk.machineIdentifier
        source_uri = f"server://{source_id}/com.plexapp.plugins.library"
        # The queue's copy of a foreign track is a partial SDK object bound to
        # the queue server. Serializing it can reload the wrong metadata after
        # a successful write. Use the original track from its source server.
        added_track = self._item_dict(track, from_listing=True)

        def added_item(play_queue):
            new_items = [item for item in play_queue.items if getattr(item, "playQueueItemID", None)
                         and str(item.playQueueItemID) not in old_item_ids]
            last_added = getattr(play_queue, "playQueueLastAddedItemID", None)
            for item in new_items:
                if (str(getattr(item, "ratingKey", "") or "") == str(rating_key)
                        and (not foreign_track or vars(item).get("sourceURI") == source_uri)):
                    return item
            if foreign_track and len(new_items) == 1 and new_items[0].playQueueItemID == last_added:
                return new_items[0]
            return None

        queue.addItem(track, playNext=bool(play_next), refresh=False)
        added = added_item(queue)
        if added is None:
            # Some servers acknowledge an edit with a window that omits the
            # new entry. Reread the queue once without replaying the write.
            try:
                queue = PlayQueue.get(self.sdk, int(play_queue_id), **window_options)
                added = added_item(queue)
            except Exception as error:
                logger.warning("Could not verify Companion queue %s after add (%s)", play_queue_id, _plex_error_code(error))
        if added is None:
            logger.warning("Plex did not confirm track %s from %s in queue %s on %s (version %s to %s)",
                           rating_key, source_id, play_queue_id, self.sdk.machineIdentifier, old_version, queue.playQueueVersion)
            raise RemotePlaybackError("Plex did not confirm that it added this track to the queue.")
        entries = queue.items
        position = next(index for index, entry in enumerate(entries) if entry.playQueueItemID == added.playQueueItemID)
        after_item_id = str(entries[position - 1].playQueueItemID) if position else ""
        warning = ""
        destination = "Play Next" if play_next else "the end of the queue"
        try:
            if play_next:
                anchor = next((item for item in entries if str(item.playQueueItemID) == current_item_id), None)
            else:
                # Plex's Add to Up Next ends the manual Up Next group. The
                # Deck browser's Add to Queue appends to the full play queue.
                anchor = self._companion_queue_entries(queue)[-1]
                if anchor not in queue:
                    # The SDK requires both items in the loaded window to move by ID.
                    entries.append(anchor)
            if anchor is None:
                warning = "Plex added the track, but the current track changed before it could play next."
            elif anchor.playQueueItemID != added.playQueueItemID and str(anchor.playQueueItemID) != after_item_id:
                queue.moveItem(added, after=anchor, refresh=False)
                after_item_id = str(anchor.playQueueItemID)
        except Exception as error:
            logger.warning("Could not move the newly added item to %s (%s)", destination, _plex_error_code(error))
            warning = f"Plex added the track, but could not move it to {destination}."
        added_track["playQueueItemID"] = str(getattr(added, "playQueueItemID", "") or "")
        if foreign_track:
            added_track["sourceServerId"] = source_id
        return {"track": added_track, "play_queue_id": str(queue.playQueueID or play_queue_id),
                "play_queue_version": str(queue.playQueueVersion or ""),
                "after_item_id": after_item_id, "warning": warning}

    def remove_companion_queue_item(self, play_queue_id: str, item_id: str) -> None:
        from plexapi.playqueue import PlayQueue
        queue = PlayQueue.get(self.sdk, int(play_queue_id), center=int(item_id), window=1)
        item = next((entry for entry in queue.items if str(entry.playQueueItemID) == item_id), None)
        if item is None:
            raise RemotePlaybackError("Plex could not find this item in the queue.")
        queue.removeItem(item, refresh=False)

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
            return {
                "status": response.status_code,
                "content_type": content_type,
                "content_range": response.headers.get("Content-Range", ""),
                "bytes": len(body),
            }
        finally:
            response.close()


class Plugin:
    """Decky plugin backend for Plexamp integration."""

    _game_video = None
    _game_video_revision = 0
    _video_handoff_sources = None
    _resource_cache = None
    _resource_lock = threading.Lock()
    _playback_report_lock = None
    _companion_report_lock = None
    _companion_config_lock = None
    _companion_report_key = None
    _companion_queue_edit_lock = None
    _companion_report_at = 0.0
    _latest_companion_timeline = None

    async def _main(self):
        """Called when the plugin is loaded."""
        global _settings_stopping, _settings_installation, _companion_receiver, _companion_event_loop
        _settings_stopping = False
        _allow_decky_shutdown_at_rpc_eof()
        logger.info(f"DeckyPlex plugin loaded, settings file: {_settings_file}")
        logger.info("DeckyPlex preference file present at startup: %s", os.path.isfile(_settings_file))
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
        _companion_event_loop = asyncio.get_running_loop()
        _settings_installation = _installation_id()
        settings = _load_settings()
        receiver_id = str(settings.get("companion_id") or "").strip()
        if not receiver_id:
            receiver_id = str(uuid.uuid4())
            settings["companion_id"] = receiver_id
        # Adopt preferences under this installation ID and consume any update marker.
        try:
            _save_settings(settings)
        except OSError:
            pass
        if settings["companion_receiver_enabled"]:
            self._configure_companion_receiver(receiver_id, True, settings["companion_device_name"])
        else:
            logger.info("Plex Companion receiver is disabled in settings")

    def _configure_companion_receiver(self, receiver_id: str, enabled: bool, device_name: str) -> None:
        global _companion_receiver
        if not enabled:
            receiver, _companion_receiver = _companion_receiver, None
            self._latest_companion_timeline = None
            if receiver:
                receiver.disconnect_controllers(shutting_down=True)
                receiver.stop()
            logger.info("Plex Companion receiver disabled")
            return
        if _companion_receiver and _companion_receiver.is_active():
            _companion_receiver.device_name = device_name
            return
        if _companion_receiver:
            _companion_receiver.stop()
        _companion_receiver = PlexCompanionReceiver(receiver_id, _companion_event_loop, device_name)
        _companion_receiver.start()

    async def _unload(self):
        """Called when the plugin is unloaded."""
        global _settings_stopping, _companion_receiver, _companion_event_loop
        _settings_stopping = True
        _cancel_plex_login()
        await self.stop_game_pip()
        if _companion_receiver:
            _companion_receiver.stop()
            _companion_receiver = None
        _companion_event_loop = None
        logger.info("DeckyPlex plugin unloaded")

    async def _uninstall(self):
        """Called when the plugin is uninstalled. Clean up saved settings."""
        global _settings_stopping
        _settings_stopping = True
        if time.time() < _settings_update_until:
            logger.info("Keeping DeckyPlex preferences for the confirmed update")
            return
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

    async def prepare_package_update(self, request_id: str):
        global _settings_update_request, _settings_update_until
        settings = _load_settings()
        _settings_update_request = request_id
        _settings_update_until = int(time.time()) + 600
        try:
            _save_settings(settings)
        except OSError:
            _settings_update_request = ""
            _settings_update_until = 0
            raise

    async def finish_package_update(self, request_id: str):
        global _settings_update_request, _settings_update_until
        if _settings_update_request == request_id and not _settings_stopping:
            _settings_update_request = ""
            _settings_update_until = 0
            _save_settings(_load_settings())

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

    async def get_quick_player_settings(self) -> Dict[str, Any]:
        """Check for account revocation without treating a network outage as logout."""
        from plexapi.exceptions import Unauthorized

        global _next_account_check
        settings = _load_settings()
        token = settings["plex_token"]
        if token and time.monotonic() >= _next_account_check:
            _next_account_check = time.monotonic() + 300
            try:
                await asyncio.to_thread(_check_plex_account, token)
            except Unauthorized:
                if _load_settings()["plex_token"] == token:
                    return await self.logout()
            except Exception:
                logger.debug("Could not check the Plex account session")
            settings = _load_settings()
        return self._public_settings(settings)

    @staticmethod
    def _public_settings(settings: Dict[str, Any]) -> Dict[str, Any]:
        result = dict(settings)
        result.pop("companion_id", None)
        result.pop("library_selections", None)
        result.pop("manual_server_id", None)
        result["browser_layouts"] = _browser_layouts(settings.get("browser_layouts"))
        result["manual_server_url"] = _manual_server_url(settings)
        choice = _library_choice(settings)
        result["library_selection_configured"] = isinstance(choice, list)
        result["library_selection_ids"] = [entry["id"] for entry in choice] if isinstance(choice, list) else []
        result["browse_all_media"] = (any(entry["type"] != "artist" for entry in choice)
                                      if isinstance(choice, list) else choice == "all")
        result["has_plex_token"] = bool(settings.get("plex_token"))
        result["plex_token"] = ""
        result["server_access_token"] = ""
        return result

    async def set_settings(self, settings: Dict[str, Any]) -> Dict[str, Any]:
        """Save user-editable preferences without accepting auth tokens from the UI."""
        try:
            merged = _load_settings()
            for key in ("selected_player_id", "selected_player_name", "manual_server_url", "grid_columns", "volume",
                        "playback_target", "connection_timeout", "verify_tls", "companion_receiver_enabled",
                        "allow_signed_out_companion", "companion_device_name", "hide_quick_login",
                        "quick_player_maintain_x", "quick_player_show_idle", "video_quality", "video_autoplay",
                        "over_game_pip", "pip_position", "pip_size"):
                if key in settings:
                    merged[key] = settings[key]
            if "browser_layouts" in settings:
                merged["browser_layouts"] = {
                    **_browser_layouts(merged.get("browser_layouts")),
                    **_browser_layouts(settings["browser_layouts"]),
                }
            merged["companion_receiver_enabled"] = bool(merged["companion_receiver_enabled"])
            merged["hide_quick_login"] = bool(merged["hide_quick_login"])
            merged["quick_player_maintain_x"] = bool(merged["quick_player_maintain_x"])
            merged["quick_player_show_idle"] = merged["quick_player_show_idle"] is not False
            merged["over_game_pip"] = merged["over_game_pip"] is True
            merged["video_autoplay"] = merged["video_autoplay"] is not False
            if merged["pip_position"] not in PIP_POSITIONS:
                merged["pip_position"] = DEFAULT_SETTINGS["pip_position"]
            try:
                merged["pip_size"] = max(20, min(50, int(merged["pip_size"])))
            except (TypeError, ValueError, OverflowError):
                merged["pip_size"] = DEFAULT_SETTINGS["pip_size"]
            if not isinstance(merged["video_quality"], str) or merged["video_quality"] not in VIDEO_QUALITY:
                merged["video_quality"] = DEFAULT_SETTINGS["video_quality"]
            name = "".join(char for char in str(merged["companion_device_name"] or "") if char.isprintable())
            merged["companion_device_name"] = name[:48].strip() or DEFAULT_SETTINGS["companion_device_name"]
            merged["allow_signed_out_companion"] = bool(merged.get("allow_signed_out_companion", False))
            if "manual_server_url" in settings:
                merged["manual_server_url"] = self._normalize_server_url(merged["manual_server_url"])
                merged["manual_server_id"] = merged["selected_server_id"] if merged["manual_server_url"] else ""
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
                merged["grid_columns"] = columns if columns == 0 else max(3, min(9, columns))
            except (TypeError, ValueError):
                merged["grid_columns"] = 0
            _save_settings(merged)
            if "over_game_pip" in settings and not merged["over_game_pip"]:
                await self.stop_game_pip()
            receiver_id = str(merged.get("companion_id") or "").strip()
            if receiver_id and ("companion_receiver_enabled" in settings or "companion_device_name" in settings):
                if self._companion_config_lock is None:
                    self._companion_config_lock = asyncio.Lock()
                async with self._companion_config_lock:
                    current = _load_settings()
                    await asyncio.to_thread(self._configure_companion_receiver, receiver_id,
                                            current["companion_receiver_enabled"], current["companion_device_name"])
                merged = _load_settings()
            return self._public_settings(merged)
        except Exception as e:
            logger.error(f"Failed to save settings: {e}")
            return {"error": str(e)}

    async def logout(self) -> Dict[str, Any]:
        """Clear Plex credentials and selected devices while keeping UI preferences."""
        global _plex_cache
        _cancel_plex_login()
        settings = _load_settings()
        settings.update({
            "plex_token": "", "server_access_token": "", "logged_in_username": "",
            "plexamp_url": "", "selected_server_id": "", "selected_server_name": "",
            "selected_server_url": "", "selected_player_id": "", "selected_player_name": "",
            "playback_target": "local",
        })
        _save_settings(settings)
        await self.stop_game_pip()
        _plex_cache = (None, None)
        self._resource_cache = None
        self._video_handoff_sources = None
        return self._public_settings(settings)

    async def select_server(self, server_id: str) -> Dict[str, Any]:
        """Resolve a discovered Plex resource and keep its access token backend-side."""
        settings = _load_settings()
        token = settings.get("plex_token", "").strip()
        if not token:
            return {"success": False, "error": "Log in to Plex before selecting a server."}
        try:
            info = await asyncio.to_thread(self._account_resources, token)
            settings = _load_settings()
            if settings.get("plex_token", "").strip() != token:
                return {"success": False, "error": "Plex account changed while choosing the server."}
            server = next((item for item in info.get("servers", []) if str(item.get("id")) == str(server_id)), None)
            if not server:
                return {"success": False, "error": "That Plex server is no longer available. Refresh the list."}
            settings.update(_server_settings(server, token))
            _save_settings(settings)
            await self.stop_game_pip()
            global _plex_cache
            _plex_cache = (None, None)
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
        return self._plex_for_settings(_load_settings())

    def _plex_for_settings(self, settings: Dict[str, Any]) -> Optional[PlexHTTP]:
        global _plex_cache
        url = self._get_plex_server_url(settings)
        # Use server-specific access token if available, otherwise fall back to user token
        token = settings["server_access_token"] or settings.get("plex_token", "").strip()
        account_token = settings.get("plex_token", "").strip()
        if not url or not token:
            # Only log once at DEBUG level — this is expected when no server is configured
            logger.debug(f"_get_plex: missing url or token (url={bool(url)}, token={bool(token)}), plex_token in settings={bool(settings.get('plex_token', '').strip())}")
            return None
        timeout = int(settings.get("connection_timeout", 8) or 8)
        verify_tls = bool(settings.get("verify_tls", False))
        cache_key = (url.rstrip("/"), token, account_token, timeout, verify_tls)
        previous_key, previous_plex = _plex_cache
        if previous_key == cache_key:
            return previous_plex
        with _plex_connect_lock:
            previous_key, previous_plex = _plex_cache
            if previous_key == cache_key:
                return previous_plex
            try:
                # PlexServer validates the connection and retains the authenticated session.
                plex = PlexHTTP(url, token, timeout=timeout, verify_tls=verify_tls, account_token=account_token)
                _plex_cache = (cache_key, plex)
                return plex
            except Exception as error:
                logger.debug("Plex connection failed: %s", type(error).__name__)
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
        plex = await asyncio.to_thread(self._get_plex)
        if not plex:
            return {"players": [], "error": "Not connected to Plex server"}
        try:
            clients = await asyncio.to_thread(plex.discover_players)
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
        plex = await asyncio.to_thread(self._get_plex)
        if not plex:
            return {"success": False, "error": "Not connected to Plex server"}
        try:
            await asyncio.to_thread(plex.play_remote_queue, machine_id, rating_keys, start_rating_key,
                                    _companion_receiver)
            return {"success": True, "machineIdentifier": machine_id}
        except RemotePlaybackError as e:
            return {"success": False, "error": str(e)}
        except Exception as e:
            logger.warning("Failed to start remote Plex queue on %s (%s)", machine_id, _plex_error_code(e))
            return {"success": False, "error": "Could not start playback. Open the selected Plex player and try again."}

    async def control_remote_player(self, machine_id: str, command: str, value: int = 0) -> Dict[str, Any]:
        plex = await asyncio.to_thread(self._get_plex)
        if not plex:
            return {"success": False, "error": "Not connected to Plex server"}
        try:
            await asyncio.to_thread(plex.control_remote_player, machine_id, command, value)
            return {"success": True}
        except RemotePlaybackError as e:
            return {"success": False, "error": str(e)}
        except Exception as e:
            logger.warning("Remote player command failed for %s (%s)", machine_id, _plex_error_code(e))
            return {"success": False, "error": "Could not control the selected Plex player."}

    async def get_remote_player_status(self, machine_id: str, known_queue_id: str = "", known_version: str = "",
                                       known_item_id: str = "") -> Dict[str, Any]:
        plex = await asyncio.to_thread(self._get_plex)
        if not plex:
            return {"state": "disconnected", "error": "Not connected to Plex server"}
        try:
            return await asyncio.to_thread(plex.remote_player_status, machine_id, known_queue_id, known_version, known_item_id)
        except RemotePlaybackError as e:
            return {"state": "error", "error": str(e)}
        except Exception as e:
            logger.debug("Failed to read remote player %s (%s)", machine_id, _plex_error_code(e))
            return {"state": "error", "error": "Could not read the selected Plex player's status."}

    async def edit_remote_music_queue(self, machine_id: str, queue_id: str, action: str,
                                      item_id: str) -> Dict[str, Any]:
        if action not in ("next", "append", "remove") or not all(
                isinstance(value, str) and re.fullmatch(r"[0-9]{1,20}", value) for value in (queue_id, item_id)):
            return {"success": False, "error": "Invalid play queue edit."}
        plex = await asyncio.to_thread(self._get_plex)
        if not plex:
            return {"success": False, "error": "Not connected to Plex server."}
        try:
            return await asyncio.to_thread(plex.edit_remote_music_queue, machine_id, queue_id, action, item_id)
        except RemotePlaybackError as error:
            return {"success": False, "error": str(error)}
        except Exception as error:
            code = _plex_error_code(error)
            logger.warning("Plex could not edit remote music queue %s (%s)", queue_id, code)
            message = "Plex could not edit this queue. Try editing it on the device playing the music."
            if code.endswith(("HTTP 401", "HTTP 403")):
                message = "Plex denied permission to edit this queue. Edit it on the device playing the music."
            return {"success": False, "error": message}

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
        enabled = bool(_load_settings()["companion_receiver_enabled"])
        if not enabled:
            return {"active": False, "enabled": False, "error": "Receiver disabled in settings"}
        if not receiver:
            return {"active": False, "enabled": True, "error": "Receiver has not initialized yet"}
        return {"active": receiver.is_active(), "enabled": True,
                "port": receiver.HTTP_PORT, "error": receiver.error}

    async def poll_companion_commands(self) -> Dict[str, Any]:
        receiver = _companion_receiver
        commands = receiver.drain_commands() if receiver else []
        if commands:
            logger.info("Dispatching %d Plex Companion command(s) to frontend: %s",
                        len(commands), ", ".join(command.get("command", "?") for command in commands))
        return {"commands": commands}

    async def prepare_companion_playback(self, key: str, container_key: str = "",
                                        server_machine_id: str = "", controller_token: str = "",
                                        server_address: str = "", server_port: int = 32400,
                                        server_protocol: str = "http") -> Dict[str, Any]:
        context = {"source": "companion", "machine_identifier": server_machine_id,
                   "token": controller_token, "address": server_address, "port": server_port,
                   "protocol": server_protocol}

        def prepare():
            plex, owns_session = self._companion_plex_for_context(context, for_playback=True)
            try:
                return plex.prepare_companion_playback(key, container_key, account_plex=self._get_plex())
            finally:
                if owns_session:
                    plex.session.close()
        try:
            return await asyncio.to_thread(prepare)
        except RemotePlaybackError as error:
            return {"success": False, "error": str(error)}
        except Exception as error:
            code = _plex_error_code(error)
            logger.warning("Could not prepare incoming Plex playback (%s)", code)
            return {"success": False, "error": self._companion_track_error(code)}

    @staticmethod
    def _companion_track_error(code: str) -> str:
        if code.endswith(("HTTP 401", "HTTP 403")):
            return "Plex denied access to this track for the current playback session."
        if code.endswith("HTTP 404"):
            return "Plex could not find this track on the server for this queue."
        return "Could not load this track from Plex."

    def _companion_plex_for_context(self, context: Dict[str, Any], *, for_playback: bool = False):
        """Resolve the authorized Plex server for an active Companion session."""
        settings = _load_settings()
        plex = self._get_plex()
        expected_id = str(plex.sdk.machineIdentifier or "") if plex else ""
        requested_id = str(context.get("machine_identifier") or "")
        token = str(context.get("token") or "")
        source = context.get("source")
        allow_sender = settings.get("allow_signed_out_companion", False) and source != "local"
        linked_plex = plex
        if plex and requested_id and requested_id != expected_id:
            server = plex._account_plex_server(requested_id)
            linked_plex = (PlexHTTP(server._baseurl, server._token, timeout=plex.timeout,
                                    account_token=plex.account_token, connected_server=server) if server else None)
        if linked_plex:
            # A linked account already authorizes requests to this server.
            # Preserve Plexamp's session credential for streaming, and use the
            # linked account for queue edits so a read-only cast token is not
            # the only credential sent to PMS.
            if not (for_playback and source != "local" and token) or token == linked_plex.token:
                return linked_plex, False
            base_url = linked_plex.base_url
        elif allow_sender:
            if not token or not requested_id or requested_id == "node":
                raise RemotePlaybackError("Plexamp did not provide authorization for a Plex Media Server.")
            base_url = _private_plex_base_url(
                str(context.get("address") or ""), int(context.get("port") or 32400),
                str(context.get("protocol") or "http"),
            )
        elif plex:
            raise RemotePlaybackError("Plexamp is using a server your linked account could not access. Enable ‘Accept playback from any Plex account’ to receive it with Plexamp’s credentials.")
        else:
            raise RemotePlaybackError("Sign in to DeckyPlex or enable ‘Accept playback from any Plex account’ in Players settings.")
        client = PlexHTTP(base_url, token, timeout=int(settings.get("connection_timeout", 8) or 8),
                          verify_tls=bool(settings.get("verify_tls", False)), account_token=token)
        if requested_id and client.sdk.machineIdentifier != requested_id:
            client.session.close()
            raise RemotePlaybackError("Plexamp's server identity did not match the playback request.")
        return client, True

    async def share_local_companion_queue(self, server_id: str, rating_keys: List[str]) -> Dict[str, Any]:
        receiver = _companion_receiver
        settings = _load_settings()
        if not receiver or not receiver.is_active() or not server_id or server_id != settings["selected_server_id"]:
            return {"success": False, "error": "The Plex Companion receiver or selected server changed."}
        if (not isinstance(rating_keys, list) or not rating_keys or
                any(not isinstance(key, str) or not re.fullmatch(r"[0-9]{1,20}", key) for key in rating_keys)):
            return {"success": False, "error": "The current queue contains a track without a valid Plex ID."}

        def create():
            plex = self._get_plex()
            if not plex or plex.sdk.machineIdentifier != server_id:
                raise ValueError("The selected Plex server changed before the queue was shared.")
            return plex.create_local_companion_queue([int(key) for key in rating_keys])

        try:
            result = await asyncio.to_thread(create)
            if _companion_receiver is not receiver or _load_settings()["selected_server_id"] != server_id:
                return {"success": False, "error": "The receiver or selected server changed while sharing the queue."}
            logger.info("Shared Deck music queue %s with Plex Companion (%d tracks)", result["play_queue_id"], len(rating_keys))
            return {"success": True, **result}
        except Exception as error:
            logger.warning("Could not share the Deck music queue: %s", type(error).__name__)
            return {"success": False, "error": "Plex could not create a shared music queue."}

    async def play_companion_track(self, rating_key: str,
                                   server_context: Optional[Dict[str, Any]] = None,
                                   source_server_id: str = "") -> Dict[str, Any]:
        """Get the next Companion queue item's stream using its authorized server context."""
        def load():
            plex, owns_session = self._companion_plex_for_context(server_context or {}, for_playback=True)
            try:
                account_plex = self._get_plex() if source_server_id else None
                return plex.companion_track_streams(str(rating_key), source_server_id, account_plex)
            finally:
                if owns_session:
                    plex.session.close()

        try:
            streams = await asyncio.to_thread(load)
            return {"success": True, **streams}
        except RemotePlaybackError as error:
            logger.warning("Could not load Companion queue track %s: %s", rating_key, error)
            return {"success": False, "error": str(error)}
        except Exception as error:
            code = _plex_error_code(error)
            logger.warning("Could not load Companion queue track %s (%s)", rating_key, code)
            return {"success": False, "error": self._companion_track_error(code)}

    async def get_music_artwork(self, rating_key: str, server_context: Optional[Dict[str, Any]] = None,
                                source_server_id: str = "") -> str:
        if not isinstance(rating_key, str) or not re.fullmatch(r"[0-9]{1,20}", rating_key):
            return ""

        def load():
            plex, owns_session = self._companion_plex_for_context(server_context or {})
            try:
                server = plex._companion_media_server(source_server_id, self._get_plex())
                return plex.music_artwork(int(rating_key), server=server)
            finally:
                if owns_session:
                    plex.session.close()

        try:
            return await asyncio.to_thread(load)
        except Exception as error:
            logger.debug("Could not resolve music artwork (%s)", _plex_error_code(error))
            return ""

    async def refresh_companion_queue(self, play_queue_id: str, current_item_id: str,
                                      server_context: Optional[Dict[str, Any]] = None,
                                      include_remaining: bool = False) -> Dict[str, Any]:
        context = server_context or {}

        def load():
            plex, owns_session = self._companion_plex_for_context(context, for_playback=True)
            try:
                return plex.get_companion_queue(play_queue_id, current_item_id,
                                                 include_remaining=include_remaining or context.get("source") == "local")
            finally:
                if owns_session:
                    plex.session.close()
        try:
            result = await asyncio.to_thread(load)
            tracks = result.get("queue", [])
            current_index = next((index for index, item in enumerate(tracks)
                                  if str(item.get("playQueueItemID") or "") == str(current_item_id)), -1)
            if current_index < 0:
                selected_id = str(result.get("selected_item_id") or "")
                current_index = next((index for index, item in enumerate(tracks)
                                      if str(item.get("playQueueItemID") or "") == selected_id), 0)
            return {"success": True, **result, "queue": tracks[current_index:],
                    "current_index": current_index}
        except Exception as exc:
            logger.warning("Could not refresh Companion queue %s: %s", play_queue_id, exc)
            return {"success": False, "error": str(exc)}

    async def add_companion_queue_track(self, rating_key: str, play_queue_id: str,
                                        current_item_id: str,
                                        server_context: Optional[Dict[str, Any]] = None,
                                        play_next: bool = False, source_server_id: str = "") -> Dict[str, Any]:
        context = server_context or {}
        def add():
            plex, owns_session = self._companion_plex_for_context(context)
            try:
                account_plex = self._get_plex()
                if not account_plex:
                    raise RemotePlaybackError("Sign in to DeckyPlex to add tracks from your library.")
                source_id = source_server_id or account_plex.sdk.machineIdentifier
                source_server = (account_plex.sdk if source_id == account_plex.sdk.machineIdentifier
                                 else account_plex._account_plex_server(source_id))
                if not source_server:
                    raise RemotePlaybackError("DeckyPlex could not access the server for this track.")
                track = source_server.fetchItem(int(rating_key))
                return plex.add_companion_queue_item(play_queue_id, current_item_id, rating_key, play_next,
                                                       source_track=track)
            finally:
                if owns_session:
                    plex.session.close()
        try:
            if self._companion_queue_edit_lock is None:
                self._companion_queue_edit_lock = asyncio.Lock()
            async with self._companion_queue_edit_lock:
                result = await asyncio.to_thread(add)
            if result.get("track"):
                logger.info("Added track %s to Companion queue %s at version %s",
                            rating_key, play_queue_id, result["play_queue_version"])
            return {"success": True, **result}
        except RemotePlaybackError as error:
            return {"success": False, "error": str(error)}
        except Exception as error:
            code = _plex_error_code(error)
            logger.warning("Could not add track %s to Companion queue %s (%s)", rating_key, play_queue_id, code)
            if code.endswith(("HTTP 401", "HTTP 403")):
                message = "Plex denied permission to add this track. Edit the queue in Plexamp."
            elif source_server_id and context.get("machine_identifier") not in ("", None, source_server_id):
                message = "Plex could not add this track from another server to the queue. Try adding it in Plexamp."
            else:
                message = "Plex could not add this track to the queue."
            return {"success": False, "error": message}

    async def remove_companion_queue_track(self, play_queue_id: str, item_id: str,
                                           server_context: Dict[str, Any]) -> Dict[str, Any]:
        def remove():
            plex, owns_session = self._companion_plex_for_context(server_context)
            try:
                plex.remove_companion_queue_item(play_queue_id, item_id)
            finally:
                if owns_session:
                    plex.session.close()
        try:
            if self._companion_queue_edit_lock is None:
                self._companion_queue_edit_lock = asyncio.Lock()
            async with self._companion_queue_edit_lock:
                await asyncio.to_thread(remove)
            logger.info("Removed item %s from Companion queue %s", item_id, play_queue_id)
            return {"success": True}
        except RemotePlaybackError as error:
            return {"success": False, "error": str(error)}
        except Exception as error:
            code = _plex_error_code(error)
            logger.warning("Could not remove a shared queue item: %s", code)
            if code.endswith(("HTTP 401", "HTTP 403")):
                return {"success": False, "error": "Plex denied permission to remove this track. Remove it in Plexamp."}
            return {"success": False, "error": "Plex could not remove the queued track."}

    async def report_companion_timeline(self, rating_key: str, time_ms: int, duration_ms: int,
                                        state: str, volume: int = 50,
                                        play_queue_id: str = "", play_queue_item_id: str = "",
                                        container_key: str = "", play_queue_version: str = "",
                                        server_context: Optional[Dict[str, Any]] = None,
                                        can_skip_next: Optional[bool] = None,
                                        media_context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        receiver = _companion_receiver
        if receiver:
            settings = _load_settings()
            server_url = urllib.parse.urlparse(self._get_plex_server_url(settings))
            context = server_context or {}
            timeline = {"key": f"/library/metadata/{rating_key}" if rating_key else "", "ratingKey": str(rating_key),
                        "state": state, "time": max(0, int(time_ms)), "duration": max(0, int(duration_ms)),
                        "playQueueID": str(play_queue_id or ""), "playQueueItemID": str(play_queue_item_id or ""),
                        "containerKey": str(container_key or ""), "playQueueVersion": str(play_queue_version or ""),
                        "serverId": context.get("machine_identifier") or settings.get("selected_server_id", ""),
                        "address": context.get("address") or server_url.hostname or "",
                        "port": int(context.get("port") or server_url.port or 32400),
                        "protocol": context.get("protocol") or server_url.scheme or "http",
                        "token": context.get("token") or (
                            "" if context.get("source") == "local" else self._get_server_access_token()),
                        "volume": max(0, min(100, int(volume))), "canSkipNext": can_skip_next}
            if media_context:
                # Plexamp uses the timeline's server to fetch the active play queue.
                if not timeline["playQueueID"]:
                    timeline.update(serverId=media_context["machine_identifier"], address=media_context["address"],
                                    port=media_context["port"], protocol=media_context["protocol"])
                timeline["token"] = ""
            identity = ("serverId", "playQueueID", "playQueueItemID")
            current_track = tuple(timeline[key] for key in identity)
            version = timeline["playQueueVersion"]
            latest = self._latest_companion_timeline or {}
            latest_version = latest.get("playQueueVersion", "")
            if (version.isdigit() and latest_version.isdigit() and int(version) < int(latest_version)
                    and current_track == tuple(latest.get(key) for key in identity)):
                return {"success": True}
            previous = receiver.timeline
            previous_version = previous.get("playQueueVersion", "")
            queue_edited = (not media_context and bool(previous_version and version) and previous_version != version
                            and current_track == tuple(previous.get(key) for key in identity))
            self._latest_companion_timeline = timeline
            # When an edit changes the version mid-track, report it to PMS
            # before a polling or subscribed Plexamp fetches the new queue.
            # Initial playback still appears as soon as the receiver is ready.
            if not queue_edited:
                receiver.set_timeline(timeline, notify=False)
            if not media_context:
                await self._report_companion_queue_position(timeline, context)
            if _companion_receiver is receiver and self._latest_companion_timeline is timeline:
                if queue_edited:
                    if receiver.timeline is not previous:
                        return {"success": True}
                    receiver.set_timeline(timeline, notify=False)
                    logger.info("Published Companion queue %s version %s during playback",
                                timeline["playQueueID"], timeline["playQueueVersion"])
                await asyncio.to_thread(receiver.notify_timeline, timeline)
        return {"success": True}

    async def _report_companion_queue_position(self, timeline: Dict[str, Any], context: Dict[str, Any]) -> None:
        ids = (timeline["playQueueID"], timeline["playQueueItemID"], timeline["ratingKey"])
        if not all(re.fullmatch(r"[0-9]{1,20}", value) for value in ids) or timeline["state"] not in (
                "playing", "paused", "stopped"):
            return
        key = (timeline["serverId"], *ids, timeline["state"], timeline["playQueueVersion"])
        def send():
            plex, owns_session = self._companion_plex_for_context(context)
            try:
                plex.report_companion_queue_timeline(timeline)
            finally:
                if owns_session:
                    plex.session.close()

        try:
            if self._companion_report_lock is None:
                self._companion_report_lock = asyncio.Lock()
            async with self._companion_report_lock:
                now = time.monotonic()
                if self._latest_companion_timeline is not timeline or (
                        key == self._companion_report_key and now - self._companion_report_at < 10):
                    return
                await asyncio.to_thread(send)
                self._companion_report_key = key
                self._companion_report_at = time.monotonic()
        except Exception as error:
            logger.debug("Could not update Plex queue %s playback position: %s", ids[0], type(error).__name__)

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

    @staticmethod
    def _visible_libraries(sections, settings, include_other_media):
        choice = _library_choice(settings)
        library_types = LIBRARY_TYPES if include_other_media else ("artist",)
        if isinstance(choice, list):
            chosen_ids = {entry["id"] for entry in choice}
            return [section for section in sections if section["id"] in chosen_ids and section["type"] in library_types]
        if choice != "all":
            library_types = ("artist",)
        return [section for section in sections if section["type"] in library_types]

    def _library_catalog(self, settings) -> Dict[str, Any]:
        plex = self._plex_for_settings(settings)
        if not plex:
            return {"error": "Could not connect to the selected Plex server." if settings["selected_server_id"]
                    else "Select a Plex server first."}
        try:
            libraries = [section for section in plex.get_library_sections() if section["type"] in LIBRARY_TYPES]
            selected_ids = [section["id"] for section in self._visible_libraries(libraries, settings, True)]
            return {"libraries": libraries, "selected_ids": selected_ids, "server_id": settings["selected_server_id"]}
        except Exception:
            logger.warning("Could not load the Plex library catalog", exc_info=True)
            return {"error": "Could not load libraries from this Plex server."}

    async def get_library_catalog(self) -> Dict[str, Any]:
        return await asyncio.to_thread(self._library_catalog, _load_settings())

    async def set_library_selection(self, server_id: str, selected_ids: List[str]) -> Dict[str, Any]:
        if not isinstance(selected_ids, list) or not all(isinstance(section_id, str) for section_id in selected_ids):
            return {"error": "Invalid Plex library selection."}
        original = _load_settings()
        if not server_id or server_id != original["selected_server_id"]:
            return {"error": "Your Plex server changed. Reload the library list and try again."}
        catalog = await asyncio.to_thread(self._library_catalog, original)
        if catalog.get("error"):
            return catalog
        settings = _load_settings()
        if server_id != settings["selected_server_id"] or original["plex_token"] != settings["plex_token"]:
            return {"error": "Your Plex server changed. Reload the library list and try again."}
        selected = [section for section in catalog["libraries"] if section["id"] in selected_ids]
        if not selected:
            return {"error": "Choose at least one Plex library."}
        _set_library_choice(settings, server_id, selected)
        try:
            _save_settings(settings)
            return self._public_settings(settings)
        except OSError:
            return {"error": "Could not save the selected Plex libraries."}

    async def get_library_sections(self, include_other_media: bool = False) -> Dict[str, Any]:
        """Return the supported library sections for the requested browser mode."""
        plex = await asyncio.to_thread(self._get_plex)
        if not plex:
            return {"sections": [], "error": "Not connected to Plex server"}
        try:
            sections = await asyncio.to_thread(plex.get_library_sections)
            logger.debug(f"get_library_sections: found {len(sections)} sections")
            return {"sections": self._visible_libraries(sections, _load_settings(), include_other_media)}
        except Exception as e:
            logger.error(f"Failed to get library sections: {e}")
            return {"sections": [], "error": str(e)}

    async def get_section_contents(self, section_id: str, item_type: str = "", limit: int = 100,
                                   offset: int = 0, sort: str = "titleSort:asc") -> Dict[str, Any]:
        """Load a page of items using the SDK's section-specific media types."""
        plex = await asyncio.to_thread(self._get_plex)
        if not plex:
            return {"items": [], "error": "Not connected to Plex server"}
        try:
            return await asyncio.to_thread(plex.get_section_contents, section_id, item_type, limit, offset, sort)
        except Exception as e:
            logger.error(f"Failed to get section contents: {e}")
            return {"items": [], "error": str(e)}

    async def get_video_home(self, row: str, full_watchlist: bool = False,
                             recent_offsets: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        if row not in ("continue", "movies", "shows", "watchlist"):
            return {"items": [], "error": "Unknown video home section."}
        settings = _load_settings()

        def load():
            plex = self._plex_for_settings(settings)
            if not plex:
                raise ValueError("Not connected to Plex server")
            visible = self._visible_libraries(plex.get_library_sections(), settings, True)
            libraries = [library for library in visible if library["type"] in ("movie", "show")]
            if row in ("movies", "shows") and isinstance(recent_offsets, dict):
                return plex.get_recent_video_page(row, libraries, recent_offsets)
            return {"items": plex.get_video_home(row, libraries, full_watchlist is True and row == "watchlist")}

        try:
            return await asyncio.to_thread(load)
        except Exception as error:
            logger.warning("Could not load Plex video home row=%s error=%s", row, type(error).__name__)
            return {"items": [], "error": "Could not load this section."}

    async def video_library_action(self, rating_key: str, server_id: str, action: str, rating: Optional[int] = None) -> Dict[str, Any]:
        if (not isinstance(rating_key, str) or not rating_key.isdecimal() or len(rating_key) > 20
                or action not in ("add_watchlist", "remove_watchlist", "mark_watched", "mark_unwatched", "remove_continue", "rate")
                or (action == "rate" and rating is not None and (type(rating) is not int or not 0 <= rating <= 10))):
            return {"error": "Unknown Plex video action."}
        settings = _load_settings()
        if not server_id or server_id != settings["selected_server_id"] or not settings["plex_token"]:
            return {"error": "Connect to the item's Plex server first."}

        def update():
            plex = self._plex_for_settings(settings)
            if not plex:
                raise ValueError("Plex server unavailable.")
            return plex.video_library_action(rating_key, action, rating)

        try:
            return await asyncio.to_thread(update)
        except Exception as error:
            logger.warning("Plex video action %s failed for %s: %s", action, rating_key, type(error).__name__)
            return {"error": "Plex could not complete this video action."}

    async def get_music_artists(self, limit: int = 100, offset: int = 0) -> Dict[str, Any]:
        plex = await asyncio.to_thread(self._get_plex)
        if not plex:
            return {"items": [], "error": "Not connected to Plex server"}
        try:
            settings = _load_settings()

            def load_artists():
                sections = self._visible_libraries(plex.get_library_sections(), settings, False)
                return plex.get_music_artists(sections, limit, offset)

            return await asyncio.to_thread(load_artists)
        except Exception as e:
            logger.error("Failed to get music artists: %s", e)
            return {"items": [], "error": str(e)}

    async def get_shuffled_tracks(self, section_id: str) -> Dict[str, Any]:
        """Load and shuffle every track in the selected music library."""
        plex = await asyncio.to_thread(self._get_plex)
        if not plex:
            return {"items": [], "error": "Not connected to Plex server"}
        try:
            tracks = await asyncio.to_thread(plex.get_shuffled_tracks, section_id)
            logger.info("Prepared shuffle-all queue with %d tracks from section %s", len(tracks), section_id)
            return {"items": tracks}
        except Exception as e:
            logger.error("Failed to load shuffle-all tracks: %s", e, exc_info=True)
            return {"items": [], "error": str(e)}

    async def get_track_page(self, section_id: str, offset: int = 0, limit: int = 25,
                             randomize: bool = False) -> Dict[str, Any]:
        plex = await asyncio.to_thread(self._get_plex)
        if not plex:
            return {"items": [], "total": 0, "error": "Not connected to Plex server"}
        try:
            return await asyncio.to_thread(plex.get_track_page, section_id, offset, limit, randomize)
        except Exception as e:
            logger.error("Failed to load shuffle page: %s", e, exc_info=True)
            return {"items": [], "total": 0, "error": str(e)}

    async def get_metadata_children(self, metadata_id: str) -> Dict[str, Any]:
        """Get children of a metadata item (album tracks, artist albums)."""
        plex = await asyncio.to_thread(self._get_plex)
        if not plex:
            return {"items": [], "error": "Not connected to Plex server"}
        try:
            items = await asyncio.to_thread(plex.get_metadata_children, metadata_id)
            return {"items": items}
        except Exception as e:
            logger.error(f"Failed to get metadata children: {e}")
            return {"items": [], "error": str(e)}

    async def get_artist_tracks(self, artist_id: str) -> Dict[str, Any]:
        plex = await asyncio.to_thread(self._get_plex)
        if not plex:
            return {"items": [], "error": "Not connected to Plex server"}
        try:
            return {"items": await asyncio.to_thread(plex.get_artist_tracks, artist_id)}
        except Exception as e:
            logger.error(f"Failed to get tracks for artist {artist_id}: {e}")
            return {"items": [], "error": str(e)}

    async def get_recently_played(self, section_id: str = "", limit: int = 50) -> Dict[str, Any]:
        plex = await asyncio.to_thread(self._get_plex)
        if not plex:
            return {"items": [], "error": "Not connected to Plex server"}
        try:
            return {"items": await asyncio.to_thread(plex.get_recently_played, section_id, limit)}
        except Exception as e:
            logger.error(f"Failed to get recently played tracks: {e}")
            return {"items": [], "error": str(e)}

    async def get_recently_added(self, section_id: str, limit: int = 50) -> Dict[str, Any]:
        plex = await asyncio.to_thread(self._get_plex)
        if not plex:
            return {"items": [], "error": "Not connected to Plex server"}
        try:
            return {"items": await asyncio.to_thread(plex.get_recently_added, section_id, limit)}
        except Exception as e:
            logger.error(f"Failed to get recently added albums: {e}")
            return {"items": [], "error": str(e)}

    async def get_audio_playlists(self, limit: int = 100) -> Dict[str, Any]:
        plex = await asyncio.to_thread(self._get_plex)
        if not plex:
            return {"items": [], "error": "Not connected to Plex server"}
        try:
            return {"items": await asyncio.to_thread(plex.get_audio_playlists, limit)}
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
        plex = await asyncio.to_thread(self._get_plex)
        if not plex:
            return {"items": [], "error": "Not connected to Plex server"}
        try:
            return {"items": await asyncio.to_thread(plex.get_playlist_tracks, playlist_id, limit)}
        except Exception as e:
            logger.error(f"Failed to get tracks from playlist {playlist_id}: {e}")
            return {"items": [], "error": str(e)}

    async def search_library(self, query: str, section_id: str = "", limit: int = 20,
                             include_other_media: bool = False) -> Dict[str, Any]:
        """Search music or all supported library media."""
        plex = await asyncio.to_thread(self._get_plex)
        if not plex:
            return {"items": [], "error": "Not connected to Plex server"}
        try:
            sections = await asyncio.to_thread(plex.get_library_sections)
            allowed = self._visible_libraries(sections, _load_settings(), include_other_media)
            allowed_ids = {section["id"] for section in allowed}
            if section_id and section_id not in allowed_ids:
                return {"items": []}
            items = await asyncio.to_thread(plex.search_library, query, section_id, limit,
                                            allowed_ids if not section_id else None, include_other_media)
            return {"items": items}
        except Exception as e:
            logger.error(f"Failed to search library: {e}")
            return {"items": [], "error": str(e)}

    async def get_media_source(self, rating_key: str, requested_quality: str = "", media_index: int = 0) -> Dict[str, Any]:
        settings = _load_settings()
        plex = await asyncio.to_thread(self._plex_for_settings, settings)
        if not plex:
            return {"error": "Not connected to Plex server"}
        try:
            quality = requested_quality or settings["video_quality"]
            if not isinstance(quality, str) or quality not in VIDEO_QUALITY:
                quality = "auto"
            if type(media_index) is not int or media_index < 0:
                raise ValueError("Invalid video version.")
            result = await asyncio.to_thread(plex.get_media_source, rating_key, quality, media_index)
            if any(stream["kind"] == "hls" for stream in result.get("streams", [])):
                if self._video_handoff_sources is None:
                    self._video_handoff_sources = {}
                cache = self._video_handoff_sources
                if len(cache) >= 8:
                    cache.pop(next(iter(cache)))
                key = secrets.token_urlsafe(18)
                identity = (settings["selected_server_id"], settings["plex_token"],
                            self._get_plex_server_url(settings), rating_key, quality, media_index)
                cache[key] = (identity, result)
                result = {**result, "handoff_key": key}
            return {**result, "server_id": settings["selected_server_id"], "quality": quality}
        except Exception as error:
            logger.warning("Could not prepare Plex video item=%s error=%s",
                           rating_key if str(rating_key).isdigit() else "invalid", type(error).__name__)
            return {"error": "Plex could not prepare this item for playback."}

    async def set_video_stream(self, rating_key: str, server_id: str, index: int, kind: str, stream_id: int) -> Dict[str, Any]:
        settings = _load_settings()
        if (not server_id or server_id != settings["selected_server_id"] or kind not in ("audio", "subtitle")
                or not isinstance(rating_key, str) or not rating_key.isdecimal() or len(rating_key) > 20
                or type(index) is not int or index < 0 or type(stream_id) is not int or stream_id < 0):
            return {"error": "The Plex video track is unavailable."}
        try:
            plex = await asyncio.to_thread(self._plex_for_settings, settings)
            if not plex:
                return {"error": "Not connected to Plex server."}
            await asyncio.to_thread(plex.set_video_stream, rating_key, index, kind, stream_id)
            return {"success": True}
        except Exception as error:
            logger.warning("Could not select Plex %s track: %s", kind, type(error).__name__)
            return {"error": "Plex could not change this track."}

    async def get_video_skip_markers(self, rating_key: str, server_id: str):
        settings = _load_settings()
        if not server_id or server_id != settings["selected_server_id"]:
            return []
        try:
            plex = await asyncio.to_thread(self._plex_for_settings, settings)
            return await asyncio.to_thread(plex.video_skip_markers, rating_key) if plex else []
        except Exception as error:
            logger.debug("Could not read Plex skip markers: %s", type(error).__name__)
            return []

    async def log_video_event(self, rating_key: str, quality: str, source: str, event: str, code: str = "") -> None:
        if event not in ("attempt", "ready", "failed", "quality-restored", "autoplay", "waiting"):
            return
        if not all(isinstance(value, str) for value in (rating_key, quality, source, code)):
            return
        if not rating_key.isdecimal() or len(rating_key) > 20 or not re.fullmatch(r"[a-zA-Z0-9_.:-]{0,96}", code):
            return
        if source not in ("source", "direct", "hls", "hls-audio", "hls-copy", "hls-proxy", "http", "pip"):
            return
        logger.log(30 if event in ("failed", "quality-restored") else 20,
                   "Video %s item=%s quality=%s source=%s code=%s",
                   event, rating_key, quality if quality in VIDEO_QUALITY else "auto", source, code or "-")

    async def get_episode_queue(self, rating_key: str, server_id: str) -> List[Dict[str, Any]]:
        if not server_id or _load_settings()["selected_server_id"] != server_id:
            return []
        plex = await asyncio.to_thread(self._get_plex)
        if not plex:
            return []
        try:
            return await asyncio.to_thread(plex.get_episode_queue, rating_key)
        except Exception as error:
            logger.debug("Could not read Plex episode queue error=%s", type(error).__name__)
            return []

    def _find_video_handoff(self, reuse, identity, preferred_source):
        if not isinstance(reuse, dict) or not isinstance(reuse.get("key"), str):
            return None, None
        manifest = reuse.get("manifest")
        if not isinstance(manifest, str) or len(manifest) > 65536 or not manifest.lstrip("\ufeff").startswith("#EXTM3U"):
            return None, None
        saved = (self._video_handoff_sources or {}).get(reuse["key"])
        if not saved or saved[0] != identity:
            return None, None
        source = saved[1]
        for stream in source["streams"]:
            if stream["kind"] != "hls":
                continue
            name = {"audio-conversion": "hls-audio", "direct-stream": "hls-copy"}.get(stream.get("mode"), "hls")
            if preferred_source == name:
                return source, (stream["url"], manifest.encode())
            if preferred_source == "hls-proxy" and stream.get("fallback_url"):
                return source, (stream["fallback_url"], manifest.encode())
        return None, None

    async def start_game_pip(self, rating_key: str, server_id: str, quality: str, position: float,
                             volume: float, muted: bool, replacing_id: str = "", preferred_source: str = "",
                             reuse=None, media_index: int = 0) -> Dict[str, Any]:
        settings = _load_settings()
        if settings.get("over_game_pip") is not True:
            return {"error": "Over-game picture-in-picture is turned off."}
        if not server_id or server_id != settings["selected_server_id"]:
            return {"error": "Your Plex server changed. Reopen this video to try again."}
        if self._game_video and self._game_video.closed.is_set():
            self._game_video = None
        previous = self._game_video
        if previous and previous.id != replacing_id:
            return {"error": "Close the over-game video before opening another one."}
        if replacing_id and not previous:
            return {"error": "The over-game video has already closed."}
        revision = self._game_video_revision
        plex = await asyncio.to_thread(self._get_plex)
        if not plex:
            return {"error": "Not connected to Plex server."}
        try:
            from video_pip import GameVideo

            if not isinstance(quality, str) or quality not in VIDEO_QUALITY:
                quality = "auto"
            if type(media_index) is not int or media_index < 0:
                raise ValueError("Invalid video version.")
            identity = (server_id, settings["plex_token"], self._get_plex_server_url(settings), rating_key, quality, media_index)
            source, manifest = self._find_video_handoff(reuse, identity, preferred_source)
            if source is None:
                source = await asyncio.wait_for(asyncio.to_thread(plex.get_media_source, rating_key, quality, media_index), 18)
            if revision != self._game_video_revision or self._game_video is not previous:
                return {"error": "The over-game video request was canceled."}
            if not source.get("streams") or source["streams"][0]["kind"] == "image":
                return {"error": "Over-game picture-in-picture requires a video."}
            video = GameVideo(plex, source, position, volume, muted, preferred_source, manifest)
            video.start()
            self._game_video = video
            if previous:
                await asyncio.to_thread(previous.close)
            return {"id": video.id, "url": video.url,
                    "video_autoplay": settings["video_autoplay"],
                    "pip_position": settings["pip_position"], "pip_size": settings["pip_size"]}
        except Exception as error:
            logger.warning("Could not prepare PiP item=%s error=%s",
                           rating_key if str(rating_key).isdecimal() else "invalid", type(error).__name__)
            return {"error": "Could not prepare the Plex stream for over-game picture-in-picture."}

    async def get_game_pip_status(self, video_id: str) -> Dict[str, Any]:
        video = self._game_video
        if not video or video.id != video_id:
            return {"status": "closed"}
        return video.snapshot()

    async def control_game_pip(self, video_id: str, action: str, position: float, playing: bool) -> bool:
        video = self._game_video
        return bool(action in ("activate", "commit", "playback", "seek", "volume") and video and video.id == video_id
                    and video.command(action, position, playing))

    async def stop_game_pip(self, video_id: str = "") -> None:
        video = self._game_video
        if video_id and (not video or video.id != video_id):
            return
        self._game_video_revision += 1
        self._game_video = None
        if video:
            await asyncio.to_thread(video.close)

    async def report_video_progress(self, rating_key: str, server_id: str, time_ms: int,
                                    duration_ms: int, state: str) -> Optional[Dict[str, Any]]:
        if not server_id or _load_settings()["selected_server_id"] != server_id:
            return None
        plex = await asyncio.to_thread(self._get_plex)
        if plex:
            try:
                return await asyncio.to_thread(plex.report_video_progress, rating_key, time_ms, duration_ms, state)
            except Exception:
                logger.debug("Could not report Plex video progress for %s", rating_key, exc_info=True)
        return None

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
        plex = await asyncio.to_thread(self._get_plex)
        if not plex:
            return {"success": False, "error": "Not connected to Plex server"}
        try:
            # PlexAPI's getStreamURL() is HLS-only; our adapter uses the SDK's
            # authenticated URL builder for the single-file MP3 transcode.
            streams = await asyncio.to_thread(plex.get_stream_urls, rating_key)
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
                "Stream diagnostic for track %s: status=%s range=%s bytes=%s",
                rating_key, result.get("status"), bool(result.get("content_range")), result.get("bytes"),
            )
            return {"success": True, **result}
        except Exception as e:
            logger.warning("Stream diagnostic failed for track %s: %s", rating_key, type(e).__name__)
            return {"success": False, "error": "Could not inspect the Plex stream."}

    async def report_playback(self, rating_key: str, time_ms: int, state: str,
                              duration_ms: int = 0) -> Dict[str, Any]:
        """Report this local player's timeline through PlexAPI for sessions/history."""
        if state not in ("playing", "paused", "stopped"):
            return {"success": False, "error": "Invalid playback state"}

        def send():
            plex = self._get_plex()
            if not plex:
                raise ValueError("Not connected to Plex server")
            track = plex.sdk.fetchItem(int(rating_key))
            track.updateTimeline(max(0, int(time_ms)), state=state, duration=max(0, int(duration_ms)) or None)

        try:
            if self._playback_report_lock is None:
                self._playback_report_lock = asyncio.Lock()
            async with self._playback_report_lock:
                await asyncio.to_thread(send)
            logger.debug(f"Reported Plex timeline: track={rating_key}, state={state}, time={time_ms}")
            return {"success": True}
        except Exception as e:
            logger.warning(f"Failed to report Plex timeline for track {rating_key}: {e}")
            return {"success": False, "error": str(e)}

    async def plex_login(self) -> Dict[str, Any]:
        """Start PlexAPI link-code authentication."""
        from plexapi.myplex import MyPlexPinLogin

        _cancel_plex_login()
        login_id = secrets.token_hex(16)
        _pin_state["id"] = login_id
        try:
            headers = {
                "X-Plex-Client-Identifier": login_id,
                "X-Plex-Product": "DeckyPlex",
                "X-Plex-Version": "1.0.0",
                "X-Plex-Platform": "SteamOS",
                "X-Plex-Device": "Steam Machine",
                "X-Plex-Device-Name": "DeckyPlex",
            }
            pin_login = MyPlexPinLogin(requestTimeout=15, headers=headers)
            pin = await asyncio.to_thread(lambda: pin_login.pin)
            if not pin:
                raise ValueError("Plex did not return a login code.")
            if _pin_state.get("id") != login_id:
                return {"error": "This sign-in attempt was replaced."}
            _pin_state["task"] = asyncio.create_task(self._finish_plex_login(pin_login, login_id))
            return {"pin": pin, "url": "https://plex.tv/link", "login_id": login_id}
        except Exception:
            if _pin_state.get("id") == login_id:
                _pin_state.clear()
            logger.warning("Could not start Plex login through PlexAPI", exc_info=True)
            return {"error": "Could not start Plex sign-in. Try again."}

    def _account_resources(self, auth_token: str) -> Dict[str, Any]:
        # Discovery and server selection can be invoked together by Settings.
        with self._resource_lock:
            cached = self._resource_cache
            if cached and cached[0] == auth_token and cached[1] > time.monotonic():
                return cached[2]
            info = self._probe_account_resources(auth_token)
            if _load_settings().get("plex_token") == auth_token and info["servers"]:
                self._resource_cache = (auth_token, time.monotonic() + 90, info)
            return info

    def _probe_account_resources(self, auth_token: str) -> Dict[str, Any]:
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
                    _, saved = _plex_cache
                    if (saved and saved.account_token == auth_token
                            and saved.sdk.machineIdentifier == resource.clientIdentifier
                            and saved.base_url in connections):
                        connected_server = saved.sdk
                    else:
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

    async def _finish_plex_login(self, pin_login, login_id: str) -> None:
        """Complete PlexAPI polling and discovery independently of the UI."""
        try:
            deadline = time.monotonic() + 300
            while time.monotonic() < deadline:
                if await asyncio.to_thread(pin_login.checkLogin):
                    break
                if pin_login.expired:
                    break
                await asyncio.sleep(2)
            if _pin_state.get("id") != login_id:
                return
            if not pin_login.token:
                _pin_state["result"] = {"error": "Plex sign-in expired or could not be verified. Try again."}
                return

            settings = _load_settings()
            settings.update({
                "plex_token": pin_login.token, "logged_in_username": "",
                "selected_player_id": "", "selected_player_name": "", "playback_target": "local",
                "selected_server_id": "", "selected_server_name": "", "selected_server_url": "",
                "server_access_token": "", "plexamp_url": "",
            })
            _save_settings(settings)
            _pin_state["result"] = {"connecting": True}
            try:
                resources = await self._discover_server_resources(pin_login.token)
            except Exception:
                logger.warning("Could not discover Plex servers during sign-in", exc_info=True)
                resources = {"servers": []}
            if _pin_state.get("id") == login_id:
                _pin_state["setup_token"] = pin_login.token
                _pin_state["setup_servers"] = {server["id"]: server for server in resources["servers"]}
                _pin_state["setup_catalogs"] = {}
                _pin_state["result"] = {"logged_in": True, "servers": self._public_servers(resources["servers"])}
        except Exception:
            logger.warning("Could not complete Plex login", exc_info=True)
            if _pin_state.get("id") == login_id:
                _pin_state["result"] = {"error": "Could not complete Plex sign-in. Try again."}
        finally:
            if _pin_state.get("id") == login_id:
                _pin_state.pop("task", None)

    async def plex_login_poll(self, login_id: str) -> Dict[str, Any]:
        """Return the status of the sign-in attempt shown in Settings."""
        if not login_id or _pin_state.get("id") != login_id:
            return {"error": "No active Plex sign-in. Try again."}
        return _pin_state.get("result", {})

    def _plex_setup_server(self, login_id, server_id, settings):
        if (isinstance(server_id, str) and login_id and _pin_state.get("id") == login_id
                and _pin_state.get("setup_token") == settings["plex_token"]):
            return _pin_state.get("setup_servers", {}).get(server_id)
        return None

    async def get_plex_setup_catalog(self, login_id: str, server_id: str) -> Dict[str, Any]:
        settings = _load_settings()
        server = self._plex_setup_server(login_id, server_id, settings)
        if not server:
            return {"error": "This Plex setup has ended. Choose libraries in Settings › Server."}
        candidate = {**settings, **_server_settings(server, settings["plex_token"])}
        catalog = await asyncio.to_thread(self._library_catalog, candidate)
        if not self._plex_setup_server(login_id, server_id, _load_settings()):
            return {"error": "This Plex setup has ended. Choose libraries in Settings › Server."}
        if not catalog.get("error"):
            _pin_state["setup_catalogs"][server_id] = catalog["libraries"]
        return catalog

    async def complete_plex_setup(self, login_id: str, server_id: str, selected_ids: List[str]) -> Dict[str, Any]:
        settings = _load_settings()
        server = self._plex_setup_server(login_id, server_id, settings)
        if not server:
            return {"error": "This Plex setup has ended. Choose libraries in Settings › Server."}
        libraries = _pin_state["setup_catalogs"].get(server_id)
        if libraries is None:
            return {"error": "This Plex setup has ended. Choose libraries in Settings › Server."}
        if not isinstance(selected_ids, list) or not all(isinstance(item, str) for item in selected_ids):
            return {"error": "Invalid Plex library selection."}
        selected = [library for library in libraries if library["id"] in selected_ids]
        if not selected:
            return {"error": "Choose at least one Plex library."}
        if {library["id"] for library in selected} != set(selected_ids):
            return {"error": "Your Plex libraries changed. Try again."}

        changed_server = settings["selected_server_id"] != server_id
        settings.update(_server_settings(server, settings["plex_token"]))
        _set_library_choice(settings, server_id, selected)
        try:
            _save_settings(settings)
        except OSError:
            return {"error": "Could not save your Plex setup."}
        await self.dismiss_plex_setup(login_id)
        if changed_server:
            await self.stop_game_pip()
        return self._public_settings(settings)

    async def dismiss_plex_setup(self, login_id: str) -> None:
        if login_id and _pin_state.get("id") == login_id:
            for key in ("setup_token", "setup_servers", "setup_catalogs"):
                _pin_state.pop(key, None)

    @staticmethod
    def _public_servers(servers):
        return [{key: server.get(key, "") for key in ("id", "name", "base_url")} for server in servers]

    async def _discover_server_resources(self, token):
        info = await asyncio.to_thread(self._account_resources, token)
        settings = _load_settings()
        if settings.get("plex_token", "").strip() != token:
            raise ValueError("Plex account changed during discovery.")
        settings["logged_in_username"] = info.get("username", "")
        if info["plexamp_url"]:
            settings["plexamp_url"] = info["plexamp_url"]
        servers = info["servers"]
        current_id = settings.get("selected_server_id")
        if current_id and settings.get("selected_server_url") and not any(server["id"] == current_id for server in servers):
            servers = [*servers, {
                "id": settings["selected_server_id"],
                "name": settings.get("selected_server_name") or "Saved Plex server",
                "base_url": settings["selected_server_url"],
                "access_token": settings.get("server_access_token") or token,
            }]
        if servers:
            default = next((server for server in servers if server["id"] == settings["selected_server_id"]), servers[0])
            settings.update(_server_settings(default, token))
        _save_settings(settings)
        return {**info, "servers": servers}

    async def discover_servers(self) -> Dict[str, Any]:
        """Discover Plex servers with PlexAPI account and resource objects."""
        settings = _load_settings()
        token = settings.get("plex_token", "").strip()
        if not token:
            return {"servers": [], "error": "Not logged in to Plex"}
        try:
            info = await self._discover_server_resources(token)
            return {
                "servers": self._public_servers(info["servers"]),
                "plexamp_url": info["plexamp_url"],
            }
        except Exception as e:
            logger.error(f"PlexAPI server discovery failed: {e}", exc_info=True)
            return {"servers": [], "error": f"Could not discover Plex servers: {e}"}

    async def validate_connection(self) -> Dict[str, Any]:
        """Validate the selected connection through PlexServer's SDK session."""
        try:
            plex = await asyncio.to_thread(self._get_plex)
            if not plex:
                return {"valid": False, "error": "Select a Plex server in Settings first."}
            identity = await asyncio.to_thread(plex.get_server_identity)
            return {
                "valid": True,
                "serverName": identity.get("friendlyName", ""),
                "machineIdentifier": identity.get("machineIdentifier", ""),
            }
        except Exception as e:
            logger.error(f"PlexAPI connection validation failed: {e}", exc_info=True)
            return {"valid": False, "error": str(e)}

    def _get_plex_server_url(self, settings=None) -> str:
        """Get the Plex server URL from saved settings.

        Uses the saved server URL directly instead of calling plex.tv every time.
        """
        if settings is None:
            settings = _load_settings()
        manual_url = _manual_server_url(settings)
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

