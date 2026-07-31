(function () {
  var player = document.querySelector('.audio-player');
  if (!player) return;

  var audio = player.querySelector('.audio-player-media');
  var track = player.querySelector('.audio-player-track');
  var toggle = document.querySelector('.audio-player-toggle');
  var progress = player.querySelector('.audio-player-progress');
  var time = player.querySelector('.audio-player-time');
  var canvas = player.querySelector('.audio-player-spectrum');
  var stringContainer = player.querySelector('.audio-player-string-progress');
  var startHandle = player.querySelector('.audio-player-string-handle-start');
  var endHandle = player.querySelector('.audio-player-string-handle-end');
  var resetWireButton = document.querySelector('.audio-player-wire-reset');
  var attributionTitle = player.querySelector('.audio-player-attribution-title');
  var performer = 'Doug Beaumier';
  var context = null;
  var analyser = null;
  var animationFrame = null;
  var stringPoints = null;
  var isPulling = false;
  var dragMode = null;
  var pullStartX = 0;
  var pullStartY = 0;
  var pullPosition = 0.5;
  var pullAmount = 0;
  var pullVelocity = 0;
  var pluckOscillator = null;
  var pluckOvertone = null;
  var pluckGain = null;
  var pluckBaseFrequency = 220;
  var wireEndpoints = null;
  var endpointDrag = null;
  var visualGain = 1;
  var storageKey = 'coal-audio-player';
  var endpointStorageKey = 'coal-audio-wire-endpoints';
  var enabledStorageKey = 'coal-audio-enabled';
  var musicEnabled = false;

  try {
    musicEnabled = localStorage.getItem(enabledStorageKey) === 'true';
  } catch (error) {}

  function enableMusic() {
    musicEnabled = true;

    try {
      localStorage.setItem(enabledStorageKey, 'true');
    } catch (error) {}
  }

  function formatTime(seconds) {
    if (!isFinite(seconds)) return '0:00';

    var minutes = Math.floor(seconds / 60);
    var remainder = Math.floor(seconds % 60).toString().padStart(2, '0');
    return minutes + ':' + remainder;
  }

  function saveState() {
    try {
      localStorage.setItem(storageKey, JSON.stringify({
        track: track.selectedIndex,
        time: audio.currentTime || 0
      }));
    } catch (error) {}
  }

  function updateMediaMetadata() {
    var title = track.options[track.selectedIndex].text;
    player.dataset.currentSong = title;
    player.dataset.performer = performer;
    if (attributionTitle) attributionTitle.textContent = title;

    if (!('mediaSession' in navigator) || !window.MediaMetadata) return;

    navigator.mediaSession.metadata = new MediaMetadata({
      title: title,
      artist: performer,
      album: 'chunkofcoal.com'
    });
  }

  function loadTrack(index, shouldPlay) {
    var count = track.options.length;
    track.selectedIndex = (index + count) % count;
    audio.src = track.value;
    audio.load();
    updateMediaMetadata();
    progress.value = 0;
    time.value = '0:00 / 0:00';
    saveState();

    if (shouldPlay) {
      audio.play().catch(function () {});
    }
  }

  function changeTrack(offset) {
    loadTrack(track.selectedIndex + offset, true);
  }

  function initializeAudioGraph() {
    if (context) {
      if (context.state === 'suspended') context.resume();
      return;
    }

    var AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;

    context = new AudioContext();
    analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.82;

    var source = context.createMediaElementSource(audio);
    source.connect(analyser);
    analyser.connect(context.destination);
    if (context.state === 'suspended') context.resume();
  }

  function stopPluck() {
    if (!context || !pluckGain) return;

    var now = context.currentTime;
    pluckGain.gain.cancelScheduledValues(now);
    pluckGain.gain.setValueAtTime(Math.max(0.0001, pluckGain.gain.value), now);
    pluckGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);

    if (pluckOscillator) pluckOscillator.stop(now + 0.3);
    if (pluckOvertone) pluckOvertone.stop(now + 0.3);

    pluckOscillator = null;
    pluckOvertone = null;
    pluckGain = null;
  }

  function startPluck(position) {
    initializeAudioGraph();
    if (!context) return;
    stopPluck();

    var now = context.currentTime;
    var filter = context.createBiquadFilter();
    var overtoneGain = context.createGain();
    pluckBaseFrequency = 82.41 * Math.pow(2, position * 3);
    pluckOscillator = context.createOscillator();
    pluckOvertone = context.createOscillator();
    pluckGain = context.createGain();

    pluckOscillator.type = 'triangle';
    pluckOscillator.frequency.value = pluckBaseFrequency;
    pluckOvertone.type = 'sine';
    pluckOvertone.frequency.value = pluckBaseFrequency * 2.01;
    overtoneGain.gain.value = 0.22;
    filter.type = 'lowpass';
    filter.frequency.value = 2800;
    filter.Q.value = 0.8;

    pluckOscillator.connect(pluckGain);
    pluckOvertone.connect(overtoneGain);
    overtoneGain.connect(pluckGain);
    pluckGain.connect(filter);
    filter.connect(context.destination);

    pluckGain.gain.setValueAtTime(0.0001, now);
    pluckGain.gain.exponentialRampToValueAtTime(0.055, now + 0.012);
    pluckGain.gain.exponentialRampToValueAtTime(0.018, now + 0.32);
    pluckOscillator.start(now);
    pluckOvertone.start(now);
  }

  function bendPluck(semitones) {
    if (!context || !pluckOscillator || !pluckOvertone) return;

    var now = context.currentTime;
    var frequency = pluckBaseFrequency * Math.pow(2, semitones / 12);
    pluckOscillator.frequency.setTargetAtTime(frequency, now, 0.015);
    pluckOvertone.frequency.setTargetAtTime(frequency * 2.01, now, 0.015);
  }

  function traceString(drawing, points, center, width, strokeStyle, lineWidth) {
    drawing.beginPath();
    drawing.moveTo(0, center);

    for (var i = 1; i < points.length - 1; i++) {
      var midpointX = (points[i].x + points[i + 1].x) / 2;
      var midpointY = (points[i].y + points[i + 1].y) / 2;
      drawing.quadraticCurveTo(points[i].x, points[i].y, midpointX, midpointY);
    }

    drawing.lineTo(width, center);
    drawing.strokeStyle = strokeStyle;
    drawing.lineWidth = lineWidth;
    drawing.stroke();
  }

  function renderString(drawing, width, height) {
    var center = height / 2;
    var points = stringPoints || [
      { x: 0, y: center },
      { x: width, y: center }
    ];
    var displayPoints = points.map(function (point) {
      var position = point.x / width;
      var distance = (position - pullPosition) / 0.16;
      var influence = Math.exp(-(distance * distance)) * Math.sin(Math.PI * position);

      return {
        x: point.x,
        y: point.y + pullAmount * influence
      };
    });
    var played = Number(progress.value) / 1000;
    var playedX = played * width;
    var playheadIndex = Math.min(displayPoints.length - 1, Math.round(played * (displayPoints.length - 1)));
    var playheadY = displayPoints[playheadIndex].y;

    drawing.clearRect(0, 0, width, height);
    traceString(drawing, displayPoints, center, width, '#a2a9b1', 2);

    if (playedX > 0) {
      drawing.save();
      drawing.beginPath();
      drawing.rect(0, 0, playedX, height);
      drawing.clip();
      traceString(drawing, displayPoints, center, width, '#3366cc', 3);
      drawing.restore();
    }

    drawing.fillStyle = '#3366cc';
    drawing.beginPath();
    drawing.arc(playedX, playheadY, 3.5, 0, Math.PI * 2);
    drawing.fill();
  }

  function drawString() {
    var drawing = canvas.getContext('2d');
    var width = canvas.width;
    var height = canvas.height;
    var center = height / 2;

    if (analyser && !audio.paused) {
      var values = new Uint8Array(analyser.fftSize);
      analyser.getByteTimeDomainData(values);
      var points = [];
      var step = 4;
      var peak = 0;

      for (var valueIndex = 0; valueIndex < values.length; valueIndex++) {
        peak = Math.max(peak, Math.abs(values[valueIndex] - 128) / 128);
      }

      var boostedGain = Math.min(7, Math.max(1.4, 0.82 / Math.max(peak, 0.01)));
      var targetGain = 1 + (boostedGain - 1) * 0.5;
      visualGain += (targetGain - visualGain) * 0.08;

      for (var x = 0; x <= width; x += step) {
        var position = x / width;
        var sample = Math.min(values.length - 1, Math.floor(position * values.length));
        var amplitude = Math.max(-1, Math.min(1, ((values[sample] - 128) / 128) * visualGain));
        var anchoredAmplitude = amplitude * Math.sin(Math.PI * position);
        var targetY = center + anchoredAmplitude * (height * 0.55);
        var pointIndex = points.length;
        var previousY = stringPoints && stringPoints[pointIndex]
          ? stringPoints[pointIndex].y
          : targetY;
        points.push({
          x: x,
          y: previousY + (targetY - previousY) * 0.25
        });
      }

      stringPoints = points;
    }

    if (!isPulling && Math.abs(pullAmount) > 0.01) {
      pullVelocity += -pullAmount * 0.16;
      pullVelocity *= 0.72;
      pullAmount += pullVelocity;
    } else if (!isPulling) {
      pullAmount = 0;
      pullVelocity = 0;
    }

    renderString(drawing, width, height);
    animationFrame = requestAnimationFrame(drawString);
  }

  function updatePlaybackUI() {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing';
    }

    if (!musicEnabled) {
      toggle.textContent = 'play music';
      toggle.setAttribute('aria-label', 'Play music');
      return;
    }

    toggle.textContent = audio.paused ? 'resume' : 'pause';
    toggle.setAttribute('aria-label', audio.paused ? 'Resume' : 'Pause');
  }

  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.setActionHandler('play', function () {
        enableMusic();
        initializeAudioGraph();
        audio.play().catch(updatePlaybackUI);
      });
      navigator.mediaSession.setActionHandler('pause', function () {
        audio.pause();
        saveState();
      });
      navigator.mediaSession.setActionHandler('previoustrack', function () {
        enableMusic();
        initializeAudioGraph();
        changeTrack(-1);
      });
      navigator.mediaSession.setActionHandler('nexttrack', function () {
        enableMusic();
        initializeAudioGraph();
        changeTrack(1);
      });
    } catch (error) {}
  }

  toggle.addEventListener('click', function () {
    enableMusic();
    initializeAudioGraph();

    if (audio.paused) {
      audio.play().catch(updatePlaybackUI);
    } else {
      audio.pause();
      saveState();
    }
  });

  track.addEventListener('change', function () {
    enableMusic();
    initializeAudioGraph();
    loadTrack(track.selectedIndex, true);
  });

  progress.addEventListener('input', function () {
    if (!isFinite(audio.duration)) return;
    audio.currentTime = (Number(progress.value) / 1000) * audio.duration;
  });

  function seekFromPointer(event) {
    if (!isFinite(audio.duration)) return;

    var position = wirePositionFromPointer(event);
    progress.value = Math.round(position * 1000);
    audio.currentTime = position * audio.duration;
  }

  function wirePositionFromPointer(event) {
    if (wireEndpoints) {
      var start = wireEndpoints[0];
      var end = wireEndpoints[1];
      var deltaX = end.x - start.x;
      var deltaY = end.y - start.y;
      var lengthSquared = deltaX * deltaX + deltaY * deltaY;
      var projected = ((event.clientX - start.x) * deltaX + (event.clientY - start.y) * deltaY) / lengthSquared;
      return Math.max(0, Math.min(1, projected));
    }

    var bounds = canvas.getBoundingClientRect();
    return Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
  }

  function dragDistances(event) {
    var deltaX = event.clientX - pullStartX;
    var deltaY = event.clientY - pullStartY;

    if (!wireEndpoints) {
      return {
        along: deltaX,
        perpendicular: deltaY
      };
    }

    var wireX = wireEndpoints[1].x - wireEndpoints[0].x;
    var wireY = wireEndpoints[1].y - wireEndpoints[0].y;
    var wireLength = Math.hypot(wireX, wireY);
    var tangentX = wireX / wireLength;
    var tangentY = wireY / wireLength;

    return {
      along: deltaX * tangentX + deltaY * tangentY,
      perpendicular: deltaX * -tangentY + deltaY * tangentX
    };
  }

  function updateWireGeometry() {
    if (!wireEndpoints) return;

    var start = wireEndpoints[0];
    var end = wireEndpoints[1];
    var deltaX = end.x - start.x;
    var deltaY = end.y - start.y;
    var distance = Math.hypot(deltaX, deltaY);
    var angle = Math.atan2(deltaY, deltaX) * 180 / Math.PI;
    var height = canvas.offsetHeight || 36;

    stringContainer.classList.add('is-detached');
    stringContainer.style.left = start.x + 'px';
    stringContainer.style.top = (start.y - height / 2) + 'px';
    stringContainer.style.width = distance + 'px';
    stringContainer.style.transform = 'rotate(' + angle + 'deg)';
    if (resetWireButton) resetWireButton.hidden = false;
  }

  function saveWireEndpoints() {
    if (!wireEndpoints) return;

    try {
      localStorage.setItem(endpointStorageKey, JSON.stringify(wireEndpoints));
    } catch (error) {}
  }

  function beginEndpointDrag(event, index) {
    event.preventDefault();
    event.stopPropagation();

    if (!wireEndpoints) {
      var bounds = stringContainer.getBoundingClientRect();
      var centerY = bounds.top + bounds.height / 2;
      wireEndpoints = [
        { x: bounds.left, y: centerY },
        { x: bounds.right, y: centerY }
      ];
    }

    endpointDrag = index;
    event.currentTarget.setPointerCapture(event.pointerId);
    updateWireGeometry();
  }

  function moveEndpoint(event) {
    if (endpointDrag === null) return;

    event.preventDefault();
    var nextEndpoint = {
      x: Math.max(0, Math.min(window.innerWidth, event.clientX)),
      y: Math.max(0, Math.min(window.innerHeight, event.clientY))
    };
    var otherEndpoint = wireEndpoints[endpointDrag === 0 ? 1 : 0];

    if (Math.hypot(nextEndpoint.x - otherEndpoint.x, nextEndpoint.y - otherEndpoint.y) < 24) return;

    wireEndpoints[endpointDrag] = nextEndpoint;
    updateWireGeometry();
  }

  function finishEndpointDrag() {
    if (endpointDrag === null) return;

    endpointDrag = null;
    saveWireEndpoints();
  }

  function resetWire() {
    wireEndpoints = null;
    endpointDrag = null;
    stringContainer.classList.remove('is-detached');
    stringContainer.style.left = '';
    stringContainer.style.top = '';
    stringContainer.style.width = '';
    stringContainer.style.transform = '';
    if (resetWireButton) resetWireButton.hidden = true;

    try {
      localStorage.removeItem(endpointStorageKey);
    } catch (error) {}
  }

  startHandle.addEventListener('pointerdown', function (event) {
    beginEndpointDrag(event, 0);
  });
  endHandle.addEventListener('pointerdown', function (event) {
    beginEndpointDrag(event, 1);
  });
  startHandle.addEventListener('pointermove', moveEndpoint);
  endHandle.addEventListener('pointermove', moveEndpoint);
  startHandle.addEventListener('pointerup', finishEndpointDrag);
  endHandle.addEventListener('pointerup', finishEndpointDrag);
  startHandle.addEventListener('pointercancel', finishEndpointDrag);
  endHandle.addEventListener('pointercancel', finishEndpointDrag);
  window.addEventListener('pointerup', finishEndpointDrag);
  if (resetWireButton) resetWireButton.addEventListener('click', resetWire);

  canvas.addEventListener('pointerdown', function (event) {
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    initializeAudioGraph();

    isPulling = true;
    dragMode = null;
    pullStartX = event.clientX;
    pullStartY = event.clientY;
    pullPosition = wirePositionFromPointer(event);
    pullVelocity = 0;
    startPluck(pullPosition);
    player.classList.add('is-pulling');
  });

  canvas.addEventListener('pointermove', function (event) {
    if (!isPulling) return;

    var distances = dragDistances(event);
    var horizontalDistance = distances.along;
    var verticalDistance = distances.perpendicular;

    if (!dragMode && Math.max(Math.abs(horizontalDistance), Math.abs(verticalDistance)) > 4) {
      dragMode = Math.abs(verticalDistance) > Math.abs(horizontalDistance) ? 'pull' : 'seek';
    }

    if (dragMode === 'seek') {
      seekFromPointer(event);
      pullAmount = 0;
      stopPluck();
      return;
    }

    if (dragMode !== 'pull') return;

    var visualHeight = canvas.offsetHeight || 36;
    var normalizedPull = Math.max(-1, Math.min(1, -verticalDistance / (visualHeight * 1.5)));
    var semitones = normalizedPull * 3;

    pullPosition = wirePositionFromPointer(event);
    pullAmount = Math.max(-canvas.height * 0.45, Math.min(canvas.height * 0.45, verticalDistance * (canvas.height / visualHeight)));
    bendPluck(semitones);
  });

  function releaseString(event) {
    if (!isPulling) return;

    if (!dragMode && event && typeof event.clientX === 'number') {
      seekFromPointer(event);
    }

    isPulling = false;
    dragMode = null;
    stopPluck();
    player.classList.remove('is-pulling');
  }

  canvas.addEventListener('pointerup', releaseString);
  canvas.addEventListener('pointercancel', releaseString);
  canvas.addEventListener('lostpointercapture', releaseString);
  window.addEventListener('pointerup', releaseString);
  window.addEventListener('blur', releaseString);

  audio.addEventListener('play', updatePlaybackUI);
  audio.addEventListener('pause', updatePlaybackUI);
  audio.addEventListener('ended', function () {
    loadTrack(track.selectedIndex + 1, true);
  });
  audio.addEventListener('timeupdate', function () {
    if (isFinite(audio.duration) && audio.duration > 0) {
      progress.value = Math.round((audio.currentTime / audio.duration) * 1000);

      if ('mediaSession' in navigator && navigator.mediaSession.setPositionState) {
        navigator.mediaSession.setPositionState({
          duration: audio.duration,
          playbackRate: audio.playbackRate,
          position: Math.min(audio.currentTime, audio.duration)
        });
      }
    }
    time.value = formatTime(audio.currentTime) + ' / ' + formatTime(audio.duration);
  });

  var saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(storageKey));
  } catch (error) {}

  if (saved) {
    track.selectedIndex = Math.min(saved.track || 0, track.options.length - 1);
  }
  audio.volume = 0.8;

  audio.src = track.value;
  updateMediaMetadata();
  updatePlaybackUI();

  audio.play().then(function () {
    enableMusic();
    updatePlaybackUI();
  }).catch(updatePlaybackUI);

  audio.addEventListener('loadedmetadata', function restorePosition() {
    if (saved && saved.track === track.selectedIndex && saved.time < audio.duration) {
      audio.currentTime = saved.time;
    }
    saved = null;
  });

  window.addEventListener('beforeunload', saveState);

  try {
    var savedEndpoints = JSON.parse(localStorage.getItem(endpointStorageKey));
    if (Array.isArray(savedEndpoints) && savedEndpoints.length === 2) {
      wireEndpoints = savedEndpoints.map(function (endpoint) {
        return {
          x: Math.max(0, Math.min(window.innerWidth, Number(endpoint.x))),
          y: Math.max(0, Math.min(window.innerHeight, Number(endpoint.y)))
        };
      });
      requestAnimationFrame(updateWireGeometry);
    }
  } catch (error) {}

  drawString();

  function canNavigate(anchor, event) {
    if (!anchor || event.defaultPrevented || event.button !== 0) return false;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
    if (anchor.target || anchor.download) return false;

    var url = new URL(anchor.href, location.href);
    if (url.origin !== location.origin) return false;
    if (url.pathname === location.pathname && url.search === location.search) return false;
    return true;
  }

  function updatePage(url, push) {
    document.documentElement.classList.add('page-loading');

    return fetch(url, { headers: { 'X-Requested-With': 'audio-player-navigation' } })
      .then(function (response) {
        if (!response.ok) throw new Error('navigation failed');
        return response.text();
      })
      .then(function (html) {
        var incoming = new DOMParser().parseFromString(html, 'text/html');
        var content = incoming.querySelector('#page-content');
        var footer = incoming.querySelector('#page-footer');
        if (!content || !footer) throw new Error('page content missing');

        document.querySelector('#page-content').replaceWith(content);
        document.querySelector('#page-footer').replaceWith(footer);
        document.title = incoming.title;

        if (push) history.pushState({}, '', url);
        window.scrollTo(0, 0);

        if (window.renderMathInElement) {
          window.renderMathInElement(content, {
            delimiters: [
              { left: '$$', right: '$$', display: true },
              { left: '$', right: '$', display: false }
            ]
          });
        }

        document.dispatchEvent(new CustomEvent('blog:navigate'));
      })
      .catch(function () {
        location.href = url;
      })
      .finally(function () {
        document.documentElement.classList.remove('page-loading');
      });
  }

  document.addEventListener('click', function (event) {
    var anchor = event.target.closest('a');
    if (!canNavigate(anchor, event)) return;

    event.preventDefault();
    updatePage(anchor.href, true);
  });

  window.addEventListener('popstate', function () {
    updatePage(location.href, false);
  });
})();
