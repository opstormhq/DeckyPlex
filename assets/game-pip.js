(() => {
  const video = document.querySelector('video');
  let status = 'waiting';
  let sequence = 0;
  let appliedSequence = 0;
  let seekSequence = 0;
  let activated = false;
  let hls;
  let config;
  let streamIndex = 0;
  let startTimeout;
  let streamKind = '';
  let streamPath = '';
  const failures = [];

  const seek = position => {
    video.currentTime = Number.isFinite(video.duration)
      ? Math.min(position, Math.max(0, video.duration - 0.1))
      : position;
  };

  function loadStream() {
    window.clearTimeout(startTimeout);
    hls?.destroy();
    hls = undefined;
    video.onerror = video.onloadedmetadata = video.oncanplay = video.onseeked = null;
    video.pause();
    video.muted = true;
    video.removeAttribute('src');
    video.load();
    const stream = config.streams[streamIndex++];
    if (!stream) {
      status = 'error';
      return;
    }

    streamKind = stream.name;
    streamPath = stream.url;
    status = 'waiting';
    const loadingStream = streamIndex;
    const fail = code => { if (loadingStream === streamIndex) handleFailure(code); };
    const startTimer = (phase, ms) => {
      window.clearTimeout(startTimeout);
      startTimeout = window.setTimeout(() => fail(`startup-timeout-${phase}`), ms);
    };
    startTimer(stream.kind === 'hls' ? 'manifest' : 'metadata', 10000);
    const position = config.position;
    video.onerror = () => fail(`media-error-${video.error?.code || 0}`);
    video.onloadedmetadata = () => { if (!hls && position > 0) seek(position); };
    const ready = () => {
      if (loadingStream !== streamIndex || status !== 'waiting' || video.seeking || video.readyState < 3) return;
      window.clearTimeout(startTimeout);
      status = 'ready';
    };
    video.oncanplay = ready;
    video.onseeked = ready;
    if (stream.kind === 'hls' && window.Hls?.isSupported()) {
      hls = new window.Hls({ enableWorker: false, startPosition: position });
      hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
        if (loadingStream === streamIndex && status === 'waiting') startTimer('segments', 14000);
      });
      hls.on(window.Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) fail(`${data.details}${data.response?.code ? `:${data.response.code}` : ''}`);
      });
      hls.loadSource(stream.url);
      hls.attachMedia(video);
    } else if (stream.kind === 'hls' && !video.canPlayType('application/vnd.apple.mpegurl')) {
      fail('hls-unavailable');
    } else {
      video.src = stream.url;
    }
  }

  function handleFailure(code) {
    failures.push(`${streamKind}:${code}`);
    if (!activated) loadStream();
    else {
      status = 'error';
      video.pause();
    }
  }

  async function update() {
    try {
      const reported = status;
      const response = await fetch('state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: reported, position: video.currentTime, duration: video.duration, seek_sequence: seekSequence,
          stream_path: streamPath,
          applied_sequence: !video.seeking && video.readyState >= 2 ? appliedSequence : undefined,
          code: failures.length ? failures.join('.').slice(-96) : streamKind,
        }),
      });
      if (!response.ok) throw new Error('Video session closed');
      if (reported === 'error' || reported === 'ended') return;
      const command = await response.json();
      if (command.active && command.sequence !== sequence && status !== 'error' && status !== 'ended') {
        sequence = command.sequence;
        activated = true;
        if (command.seek_sequence !== seekSequence && typeof command.position === 'number') {
          seekSequence = command.seek_sequence;
          if (command.action === 'seek' || Math.abs(video.currentTime - command.position) > 1.5) {
            seek(command.position);
          }
        }
        video.volume = command.volume;
        video.muted = !command.audible || command.muted;
        try {
          if (command.playing) await video.play();
          else video.pause();
          if (status !== 'error') {
            appliedSequence = sequence;
            status = video.paused ? 'paused' : 'playing';
          }
        } catch (error) {
          handleFailure(error?.name || 'play-failed');
        }
      }
      window.setTimeout(update, status === 'error' || status === 'ended' ? 0 : 350);
    } catch {
      video.pause();
    }
  }

  video.onpause = () => {
    if (activated && status !== 'error' && status !== 'ended') status = 'paused';
  };
  video.onended = () => { if (activated) status = 'ended'; };
  fetch('config')
    .then(response => {
      if (!response.ok) throw new Error('Video is unavailable');
      return response.json();
    })
    .then(settings => {
      config = settings;
      loadStream();
      void update();
    })
    .catch(() => {
      failures.push('config-request');
      status = 'error';
      void update();
    });
})();
