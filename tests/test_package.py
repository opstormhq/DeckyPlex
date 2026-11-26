"""Test the actual Decky install archive with a stub Decky runtime and Plex server."""

import importlib.util
import json
import logging
import sys
import unittest
import xml
from pathlib import Path, PurePosixPath
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit
from urllib.request import ProxyHandler, Request, build_opener
from zipfile import ZipFile


def track_xml(rating_key, *, item_id=None, source=None):
    queue_id = f' playQueueItemID="{item_id}"' if item_id is not None else ""
    source_uri = f' sourceURI="server://{source}/com.plexapp.plugins.library"' if source else ""
    return (
        f'<Track ratingKey="{rating_key}" key="/library/metadata/{rating_key}" title="Track {rating_key}" '
        f'type="track" duration="90000"{queue_id}{source_uri}><Media audioCodec="mp3" container="mp3">'
        f'<Part id="{rating_key}" key="/library/parts/{rating_key}/file.mp3" container="mp3"/></Media></Track>'
    )


def container(*items):
    return f'<MediaContainer size="{len(items)}">{"".join(items)}</MediaContainer>'


VIDEO_XML = container(
    '<Video ratingKey="31" key="/library/metadata/31" title="Test Film" type="movie" duration="120000" '
    'viewOffset="30000"><Media videoCodec="hevc" audioCodec="aac" audioChannels="6" container="mkv">'
    '<Part id="31" key="/library/parts/31/file.mkv" container="mkv">'
    '<Stream id="38" streamType="2" codec="aac" selected="1" channels="6"/>'
    '<Stream id="33" streamType="3" codec="srt" selected="1" key="/library/streams/33"/>'
    '</Part></Media></Video>'
)
SECTIONS = container('<Directory key="1" title="Music" type="artist"/>',
                     '<Directory key="2" title="Movies" type="movie"/>')


class PackageTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        temp = cls.enterClassContext(TemporaryDirectory())
        cls.root = Path(temp) / "DeckyPlex"
        with ZipFile("DeckyPlex.zip") as archive:
            for name in archive.namelist():
                path = PurePosixPath(name)
                if path.parts[0] != "DeckyPlex" or ".." in path.parts:
                    raise AssertionError(f"Unexpected package path: {name}")
            archive.extractall(temp)

        cls.enterClassContext(patch.object(sys, "path", sys.path[:]))
        cls.enterClassContext(patch.dict(sys.modules, {
            "decky": SimpleNamespace(logger=logging.getLogger("test_deckyplex")),
        }))
        # Decky can preload xml, then leave it without the stdlib XML sources.
        cls.enterClassContext(patch.object(xml, "__path__", []))
        spec = importlib.util.spec_from_file_location("packaged_deckyplex", cls.root / "main.py")
        cls.backend = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.backend)

    def setUp(self):
        temp = self.enterContext(TemporaryDirectory())
        self.preferences = Path(temp) / "settings" / "settings.json"
        self.enterContext(patch.multiple(
            self.backend, _settings_file=str(self.preferences), _plex_cache=(None, None), _pin_state={},
            _settings_installation="test-installation", _settings_stopping=False,
            _settings_update_request="", _settings_update_until=0, _companion_receiver=None,
        ))
        self.plugin = self.backend.Plugin()

    def plex_transport(self, handler=None, *, signed_in=False, pin_login=False):
        import requests

        calls = []
        documents = {"/library": '<MediaContainer identifier="com.plexapp.plugins.library"/>',
                     "/library/sections": SECTIONS, "/library/metadata/30": container(track_xml(30)),
                     "/library/metadata/31": VIDEO_XML}

        def reply(session, request, **_kwargs):
            url = urlsplit(request.url)
            if url.netloc == "plex.tv" and pin_login:
                self.assertEqual(request.headers.get("X-Plex-Product"), "DeckyPlex")
            elif signed_in:
                self.assertIn(url.netloc, ("test.invalid:32400", "source.invalid:32400"))
                self.assertEqual(request.headers.get("X-Plex-Token"), "fixture-token")
            else:
                self.assertIn(url.netloc, ("test.invalid:32400", "source.invalid:32400"))
                self.assertNotIn("X-Plex-Token", request.headers)
                self.assertNotIn("X-Plex-Token", parse_qs(url.query))
                self.assertFalse(session.trust_env)
            calls.append((session, request))
            result = handler(request, url) if handler else None
            if result is not None:
                status, content = result
            elif url.path == "/":
                server_id = "test-server" if url.hostname == "test.invalid" else "source-server"
                status, content = 200, f'<MediaContainer machineIdentifier="{server_id}" friendlyName="Test Plex"/>'
            else:
                status, content = 200, documents[url.path]
            response = requests.Response()
            response.status_code = status
            response.url = request.url
            response._content = content.encode()
            return response

        self.enterContext(patch.object(requests.Session, "send", reply))
        return calls

    def test_archive_has_runtime_files_and_version(self):
        for filename in ("main.py", "video_pip.py", "dist/index.js", "assets/game-pip.js", "assets/hls.min.js",
                         "LICENSE", "LICENSE-hls.js", "py_modules/xml/LICENSE.txt"):
            self.assertGreater((self.root / filename).stat().st_size, 0, filename)
        for path in (self.root / "py_modules").rglob("*"):
            self.assertNotIn(path.suffix, (".so", ".dylib", ".pyd"), path.name)
        manifest = json.loads((self.root / "plugin.json").read_text())
        version = json.loads(Path("package.json").read_text())["version"]
        lockfile = json.loads(Path("package-lock.json").read_text())
        release_versions = json.loads(Path(".release-please-manifest.json").read_text())
        self.assertEqual(manifest["name"], "DeckyPlex")
        self.assertEqual(lockfile["version"], version)
        self.assertEqual(lockfile["packages"][""]["version"], version)
        self.assertEqual(release_versions["."], version)
        self.assertEqual(self.backend.APP_VERSION, version)
        receiver = self.backend.PlexCompanionReceiver("test-player")
        self.assertIn(f"Version: {version}\r\n".encode(), receiver._response_headers())

    async def test_interface_defaults_and_preferences_persist(self):
        defaults = await self.plugin.get_settings()
        self.assertIs(defaults["quick_player_close_tray_on_back"], True)
        self.assertIs(defaults["over_game_pip"], True)
        self.assertEqual(defaults["pip_size"], 30)
        self.assertIs(defaults["mute_ui_sounds"], False)
        self.assertIs(defaults["video_show_extras"], False)
        await self.plugin.set_settings({
            "quick_player_close_tray_on_back": False, "over_game_pip": False, "mute_ui_sounds": True, "pip_size": 29,
        })
        reloaded = await self.backend.Plugin().get_settings()
        self.assertIs(reloaded["quick_player_close_tray_on_back"], False)
        self.assertIs(reloaded["over_game_pip"], False)
        self.assertEqual(reloaded["pip_size"], 29)
        self.assertIs(reloaded["mute_ui_sounds"], True)

    async def test_packaged_plex_sdk_connects_and_prepares_tokenless_music(self):
        import plexapi
        import requests
        from xml.etree import ElementTree

        modules = self.root / "py_modules"
        for dependency in (plexapi, requests, ElementTree):
            self.assertTrue(Path(dependency.__file__).is_relative_to(modules))

        self.plex_transport()
        settings = await self.plugin.connect_local_server("test.invalid")
        self.assertIs(settings["has_plex_token"], False)
        self.assertEqual(settings["library_selection_ids"], ["1"])
        self.assertEqual(settings["catalog"]["selected_ids"], ["1"])
        self.assertEqual([library["id"] for library in settings["catalog"]["libraries"]], ["1", "2"])
        self.assertIs(settings["browse_all_media"], False)
        self.assertIs(settings["video_show_extras"], False)
        music_only = await self.plugin.set_library_selection("test-server", ["1"], True)
        self.assertIs(music_only["video_show_extras"], False)
        video_enabled = await self.plugin.set_library_selection("test-server", ["1", "2"], True)
        self.assertIs(video_enabled["video_show_extras"], True)
        music_again = await self.plugin.set_library_selection("test-server", ["1"])
        self.assertIs(music_again["video_show_extras"], True)
        stream = await self.plugin.play_track("30", "1")
        self.assertTrue(stream["success"], stream)
        self.assertEqual(stream["stream_mode"], "direct-mp3")
        self.assertEqual(stream["stream_url"], "http://test.invalid:32400/library/parts/30/file.mp3")

    async def test_update_keeps_preferences_and_a_later_uninstall_removes_them(self):
        await self.plugin.set_settings({"volume": 87, "grid_columns": 8, "over_game_pip": False})
        await self.plugin.prepare_package_update("update")
        self.assertIn("_update_until", json.loads(self.preferences.read_text()))
        await self.plugin._uninstall()
        self.assertTrue(self.preferences.exists())
        with patch.multiple(self.backend, _settings_installation="replacement", _settings_stopping=False):
            replacement = self.backend.Plugin()
            prefs = await replacement.get_settings()
            self.assertEqual(prefs["volume"], 87)
            self.assertEqual(prefs["grid_columns"], 8)
            self.assertIs(prefs["over_game_pip"], False)
            await replacement.finish_package_update("update")
            self.assertNotIn("_update_until", json.loads(self.preferences.read_text()))
            await replacement._uninstall()
        self.assertFalse(self.preferences.exists())
        defaults = await self.backend.Plugin().get_settings()
        self.assertEqual(defaults["volume"], 50)
        self.assertIs(defaults["over_game_pip"], True)

    async def test_fresh_install_ignores_stale_preferences_with_previous_installation_id(self):
        await self.plugin.set_settings({"volume": 90, "grid_columns": 8, "over_game_pip": False})
        with patch.object(self.backend, "_settings_installation", "reinstalled"):
            defaults = await self.backend.Plugin().get_settings()
        self.assertEqual(defaults["volume"], 50)
        self.assertEqual(defaults["grid_columns"], self.backend.DEFAULT_SETTINGS["grid_columns"])
        self.assertIs(defaults["over_game_pip"], True)

    async def test_frontend_cannot_read_or_overwrite_saved_plex_tokens(self):
        settings = self.backend._load_settings()
        settings.update(plex_token="fixture-account-token", server_access_token="fixture-server-token")
        self.backend._save_settings(settings)
        public = await self.plugin.set_settings({"plex_token": "replacement", "server_access_token": "replacement"})
        self.assertIs(public["has_plex_token"], True)
        self.assertEqual(public["plex_token"], "")
        self.assertEqual(public["server_access_token"], "")
        saved = json.loads(self.preferences.read_text())
        self.assertEqual(saved["plex_token"], "fixture-account-token")
        self.assertEqual(saved["server_access_token"], "fixture-server-token")

    async def test_local_connection_respects_server_sign_in_and_does_not_save_failed_address(self):
        self.plex_transport(lambda _request, _url: (401, "Unauthorized"))
        result = await self.plugin.connect_local_server("test.invalid")
        self.assertIn("requires sign-in", result["error"])
        self.assertFalse(self.preferences.exists())
        self.assertIs((await self.plugin.get_settings())["local_server_enabled"], False)

    async def test_code_sign_in_polls_plex_and_saves_the_chosen_catalog(self):
        def handler(request, url):
            if url.path == "/api/v2/pins":
                self.assertEqual(request.method, "POST")
                return 201, '<pin id="7" code="ABCD"/>'
            if url.path == "/api/v2/pins/7":
                self.assertEqual(request.method, "GET")
                return 200, '<pin id="7" code="ABCD" authToken="fixture-token"/>'
            return None

        calls = self.plex_transport(handler, signed_in=True, pin_login=True)
        servers = [
            {"id": "source-server", "name": "Another Plex", "base_url": "http://source.invalid:32400",
             "access_token": "fixture-token"},
            {"id": "test-server", "name": "Test Plex", "base_url": "http://test.invalid:32400",
             "access_token": "fixture-token"},
        ]
        discovery = AsyncMock(return_value={"servers": servers})
        with patch.object(self.plugin, "_discover_server_resources", discovery):
            result = await self.plugin.plex_login()
            self.assertEqual(result["pin"], "ABCD")
            self.assertEqual(result["url"], "https://plex.tv/link")
            login = result["login_id"]
            await self.backend._pin_state["task"]
        discovery.assert_awaited_once_with("fixture-token")
        state = await self.plugin.plex_login_poll(login)
        self.assertIs(state["logged_in"], True)
        self.assertEqual([server["id"] for server in state["servers"]], ["source-server", "test-server"])
        self.assertNotIn("access_token", state["servers"][1])
        catalog = await self.plugin.get_plex_setup_catalog(login, "test-server")
        self.assertEqual([library["id"] for library in catalog["libraries"]], ["1", "2"])
        saved = await self.plugin.complete_plex_setup(login, "test-server", ["2"], True)
        self.assertEqual(saved["selected_server_id"], "test-server")
        self.assertEqual(saved["library_selection_ids"], ["2"])
        self.assertIs(saved["video_show_extras"], True)
        self.assertEqual(saved["plex_token"], "")
        self.assertEqual([urlsplit(req.url).path for _, req in calls[:2]], ["/api/v2/pins", "/api/v2/pins/7"])

    async def test_failed_code_sign_in_leaves_no_pending_login_or_credentials(self):
        self.plex_transport(lambda _req, _url: (429, "Too Many Requests"), pin_login=True)
        result = await self.plugin.plex_login()
        self.assertIn("limiting sign-in attempts", result["error"])
        self.assertEqual(self.backend._pin_state, {})
        self.assertFalse(self.preferences.exists())

    async def test_local_library_selection_stays_with_its_own_server(self):
        self.plex_transport()
        await self.plugin.connect_local_server("test.invalid")
        first = await self.plugin.set_library_selection("test-server", ["1"])
        self.assertEqual(first["library_selection_ids"], ["1"])
        second = await self.plugin.connect_local_server("source.invalid")
        self.assertEqual(second["library_selection_ids"], ["1"])
        await self.plugin.set_library_selection("source-server", ["2"])
        self.assertEqual((await self.plugin.connect_local_server("test.invalid"))["library_selection_ids"], ["1"])
        self.assertEqual((await self.plugin.connect_local_server("source.invalid"))["library_selection_ids"], ["2"])

    async def test_local_video_only_server_waits_for_a_library_choice(self):
        self.plex_transport(lambda _req, url: (
            (200, container('<Directory key="2" title="Movies" type="movie"/>'))
            if url.path == "/library/sections" else None
        ))
        connected = await self.plugin.connect_local_server("test.invalid")
        self.assertEqual(connected["catalog"]["selected_ids"], [])
        self.assertEqual([library["id"] for library in connected["catalog"]["libraries"]], ["2"])
        chosen = await self.plugin.set_library_selection("test-server", ["2"])
        self.assertEqual(chosen["library_selection_ids"], ["2"])
        self.assertIs(chosen["browse_all_media"], True)

    async def test_video_retries_a_connection_reset_with_a_fresh_session_only_once(self):
        import requests

        reset_count = 1

        def handler(_request, url):
            nonlocal reset_count
            if url.path == "/library/metadata/31" and reset_count:
                reset_count -= 1
                raise requests.ConnectionError("Connection reset by peer")
            return None

        calls = self.plex_transport(handler)
        await self.plugin.connect_local_server("test.invalid")
        source = await self.plugin.get_media_source("31")
        self.assertEqual(source["streams"][0]["kind"], "hls")
        self.assertEqual(source["resume_ms"], 0, "anonymous playback cannot inherit account progress")
        sessions = {session for session, req in calls if urlsplit(req.url).path == "/library/metadata/31"}
        self.assertEqual(len(sessions), 2)
        calls.clear()
        reset_count = 2
        failed = await self.plugin.get_media_source("31")
        self.assertIn("Could not reach Plex", failed["error"])
        sessions = [session for session, req in calls if urlsplit(req.url).path == "/library/metadata/31"]
        self.assertEqual(len(sessions), 2)
        self.assertIsNot(sessions[0], sessions[1])

    async def test_video_uses_saved_quality_allows_an_override_and_binds_decisions_to_the_session(self):
        decision_path = "/video/:/transcode/universal/decision"
        calls = self.plex_transport(
            lambda _request, url: (200, '<MediaContainer generalDecisionCode="1001"/>') if url.path == decision_path else None
        )
        await self.plugin.connect_local_server("test.invalid")
        await self.plugin.set_settings({"video_quality": "adaptive", "video_caption_size": 175})
        source = await self.plugin.get_media_source("31")
        self.assertEqual(source["quality"], "adaptive")
        query = parse_qs(urlsplit(source["streams"][0]["url"]).query)
        self.assertEqual(query["autoAdjustQuality"], ["1"])
        self.assertEqual(query["subtitleSize"], ["175"])
        override = await self.plugin.get_media_source("31", "720p")
        self.assertEqual(override["quality"], "720p")
        self.assertEqual((await self.plugin.get_settings())["video_quality"], "adaptive")
        session_id = query["transcodeSessionId"][0]
        before = len(calls)
        await self.plugin.prepare_video_transcode(source["handoff_key"], "wrong-session")
        self.assertEqual(len(calls), before)
        await self.plugin.prepare_video_transcode(source["handoff_key"], session_id)
        decision = calls[-1][1]
        self.assertEqual(urlsplit(decision.url).path, decision_path)
        self.assertEqual(decision.headers["X-Plex-Session-Identifier"], session_id)
        self.assertEqual(parse_qs(urlsplit(decision.url).query)["path"], ["/library/metadata/31"])

    def test_cross_server_queue_add_uses_source_metadata_and_correct_position(self):
        for play_next in (True, False):
            with self.subTest(play_next=play_next):
                self.check_cross_server_queue_add(play_next)

    def check_cross_server_queue_add(self, play_next):
        current = track_xml(30, item_id=1)
        upcoming = track_xml(32, item_id=2)
        added = track_xml(30, item_id=3, source="source-server")

        def queue(version, *items):
            return (f'<MediaContainer playQueueID="9" playQueueVersion="{version}" playQueueTotalCount="{len(items)}" '
                    f'playQueueSelectedItemID="1" playQueueSelectedItemOffset="0" '
                    f'playQueueLastAddedItemID="3">{"".join(items)}</MediaContainer>')

        def handler(request, url):
            if url.path == "/playQueues/9":
                if request.method == "GET":
                    self.assertEqual(parse_qs(url.query)["center"], ["1"])
                    return 200, queue(1, current, upcoming)
                self.assertEqual(request.method, "PUT")
                self.assertEqual(parse_qs(url.query)["uri"],
                                 ["server://source-server/com.plexapp.plugins.library/library/metadata/30"])
                self.assertEqual(parse_qs(url.query).get("next"), ["1"] if play_next else None)
                # Plex adds to its manual Up Next region even when next=1 is omitted.
                return 200, queue(2, current, added, upcoming)
            if url.path == "/playQueues/9/items/3/move":
                self.assertFalse(play_next)
                self.assertEqual(request.method, "PUT")
                self.assertEqual(parse_qs(url.query)["after"], ["2"])
                return 200, queue(3, current, upcoming, added)
            return None

        calls = self.plex_transport(handler, signed_in=True)
        original = self.backend.PlexHTTP("http://source.invalid:32400", "fixture-token")
        target = self.backend.PlexHTTP("http://test.invalid:32400", "fixture-token")
        track = original.sdk.fetchItem(30)
        result = target.add_companion_queue_item("9", "1", "30", play_next, source_track=track)
        self.assertEqual(result["track"]["sourceServerId"], "source-server")
        self.assertEqual(result["track"]["playQueueItemID"], "3")
        self.assertEqual(result["after_item_id"], "1" if play_next else "2")
        self.assertEqual(result["play_queue_version"], "2" if play_next else "3")
        writes = [urlsplit(req.url).path for _session, req in calls if req.method == "PUT"]
        self.assertEqual(writes, ["/playQueues/9"] if play_next else ["/playQueues/9", "/playQueues/9/items/3/move"])

    def test_queue_removal_targets_exact_item_when_rating_keys_repeat(self):
        def handler(request, url):
            if url.path == "/playQueues/9":
                self.assertEqual(parse_qs(url.query)["center"], ["41"])
                return (200, '<MediaContainer playQueueID="9" playQueueVersion="2" playQueueTotalCount="30" '
                        'playQueueSelectedItemID="10" playQueueSelectedItemOffset="5">'
                        f'{track_xml(30, item_id=40)}{track_xml(30, item_id=41)}</MediaContainer>')
            self.assertEqual((request.method, url.path), ("DELETE", "/playQueues/9/items/41"))
            return (200, '<MediaContainer playQueueID="9" playQueueVersion="3" playQueueTotalCount="29" '
                    'playQueueSelectedItemID="10" playQueueSelectedItemOffset="5">'
                    f'{track_xml(30, item_id=40)}</MediaContainer>')

        calls = self.plex_transport(lambda req, url: None if url.path == "/" else handler(req, url), signed_in=True)
        target = self.backend.PlexHTTP("http://test.invalid:32400", "fixture-token")
        target.remove_companion_queue_item("9", "41")
        self.assertEqual([req.method for _session, req in calls], ["GET", "GET", "DELETE"])

    def pip_video(self, *, active_manifest=None):
        from video_pip import GameVideo

        upstream = ("http://test.invalid:32400/video/:/transcode/universal/start.m3u8"
                    "?X-Plex-Session-Identifier=fixture-session")
        source = {"duration_ms": 600_000, "streams": [{"kind": "hls", "url": upstream}]}
        plex = SimpleNamespace(base_url="http://test.invalid:32400", token="", local_connection=True)
        handoff = (upstream, active_manifest) if active_manifest is not None else None
        video = GameVideo(plex, source, 125, 50, False, active_manifest=handoff, source_identity=("test-server",))
        self.addCleanup(video.close)
        return video, upstream

    def test_pip_relays_an_active_hls_session_and_preserves_position_for_fullscreen(self):
        manifest = b"#EXTM3U\n/video/:/transcode/universal/session/fixture-session/seg1.ts\n"
        video, upstream = self.pip_video(active_manifest=manifest)
        self.assertEqual(video.config["streams"][0]["name"], "hls-active")
        video.start()
        opener = build_opener(ProxyHandler({}))
        with opener.open(f"{video.url}config", timeout=3) as response:
            config = json.load(response)
        self.assertEqual(config["position"], 125)
        route = config["streams"][0]["url"]
        with opener.open(f"http://{video.address}{route}", timeout=3) as response:
            self.assertEqual(response.headers.get_content_type(), "application/vnd.apple.mpegurl")
            rewritten = response.read().decode()
        self.assertNotIn("test.invalid", rewritten)
        self.assertIn(f"/{video.id}/media/", rewritten)
        segment = next(url for url in video.urls.values() if url.endswith("seg1.ts?X-Plex-Session-Identifier=fixture-session"))
        self.assertEqual(urlsplit(segment).netloc, "test.invalid:32400")

        def report(data, origin):
            return Request(f"{video.url}state", data=json.dumps(data).encode(), headers={"Origin": origin})

        with self.assertRaises(HTTPError) as rejected:
            opener.open(report({"status": "ready"}, "https://example.invalid"), timeout=3)
        self.assertEqual(rejected.exception.code, 404)
        rejected.exception.close()
        with opener.open(report({"status": "ready", "position": 125}, f"http://{video.address}"), timeout=3):
            pass
        self.assertTrue(video.command("activate", 125, True))
        video.update({"status": "paused", "stream_path": route, "position": 128, "seek_sequence": 1})
        self.assertEqual(video.snapshot()["position"], 128)
        self.assertEqual(video.fullscreen_hls(), (upstream, manifest.decode()))
        self.assertTrue(video.command("seek", 210, False))
        video.update({"status": "paused", "stream_path": route, "position": 130, "seek_sequence": 1})
        self.assertEqual(video.snapshot()["position"], 210, "stale position messages cannot undo a seek")

    def test_pip_falls_back_when_handoff_manifest_has_an_unrelated_origin(self):
        manifest = b"#EXTM3U\nhttp://another.invalid/video/:/transcode/universal/session/foreign/seg1.ts\n"
        video, _upstream = self.pip_video(active_manifest=manifest)
        self.assertIsNone(video.handoff_manifest)
        self.assertEqual([stream["name"] for stream in video.config["streams"]], ["hls"])
