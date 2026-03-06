(function () {
  'use strict';

  var screenLanding = document.getElementById('screen-landing');
  var screenChat = document.getElementById('screen-chat');
  var btnGoChat = document.getElementById('btn-go-chat');
  var closeChatBtn = document.getElementById('close-chat');
  var robotFace = document.getElementById('robot-face');
  var robotStatus = document.getElementById('robot-status');
  var robotHeard = document.getElementById('robot-heard');
  var stateLabel = document.getElementById('robot-state-label');
  var fileInput = document.getElementById('file-input');
  var btnUpload = document.getElementById('btn-upload');
  var uploadList = document.getElementById('upload-list');
  var uploadCount = document.getElementById('upload-count');

  // --- Настройки ---
  var VOICE_THRESHOLD = 14;
  var SILENCE_TIMEOUT_SEC = 6;
  var VAD_INTERVAL_MS = 60;
  var RECORDER_TIMESLICE_MS = 300;
  var WS_RECONNECT_MS = 1500;

  // --- Состояние ---
  var active = false;
  var stream = null;
  var audioCtx = null;
  var analyser = null;
  var analyserData = null;
  var recorder = null;
  var recordedChunks = [];
  var vadTimer = null;
  var silenceTimer = null;
  var audioCtxWatchdog = null;
  var isSpeaking = false;
  var hasSpoken = false;
  var currentState = 'idle';
  var currentAudio = null;

  // --- WebSocket ---
  var ws = null;
  var wsReady = false;
  var pendingTTSText = '';

  // -------------------------------------------------------------------
  // UI
  // -------------------------------------------------------------------
  function setState(s) {
    currentState = s;
    if (robotFace) robotFace.className = 'robot-voice-face is-' + s;
    switch (s) {
      case 'idle':
        if (robotStatus) robotStatus.textContent = '';
        if (stateLabel) stateLabel.textContent = 'READY';
        break;
      case 'listening':
        if (robotStatus) robotStatus.textContent = 'Слушаю вас…';
        if (stateLabel) stateLabel.textContent = 'LISTENING';
        break;
      case 'processing':
        if (robotStatus) robotStatus.textContent = 'Обрабатываю…';
        if (stateLabel) stateLabel.textContent = 'THINKING';
        if (robotHeard) robotHeard.textContent = '';
        break;
      case 'speaking':
        if (robotStatus) robotStatus.textContent = 'Отвечаю…';
        if (stateLabel) stateLabel.textContent = 'SPEAKING';
        break;
    }
  }

  // -------------------------------------------------------------------
  // WebSocket
  // -------------------------------------------------------------------
  function connectWS() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var url = proto + '//' + location.host + '/ws';
    ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';

    ws.onopen = function () {
      wsReady = true;
      console.log('[WS] connected');
    };

    ws.onclose = function () {
      wsReady = false;
      console.log('[WS] disconnected');
      if (active) {
        setTimeout(function () {
          if (active) connectWS();
        }, WS_RECONNECT_MS);
      }
    };

    ws.onerror = function (e) {
      console.error('[WS] error', e);
    };

    ws.onmessage = function (evt) {
      if (evt.data instanceof ArrayBuffer) {
        handleTTSAudio(evt.data);
        return;
      }

      var msg;
      try { msg = JSON.parse(evt.data); } catch (e) { return; }

      switch (msg.type) {
        case 'transcription':
          if (robotHeard) robotHeard.textContent = '«' + msg.text + '»';
          break;

        case 'reply':
          pendingTTSText = msg.text || '';
          break;

        case 'tts_start':
          setState('speaking');
          break;

        case 'tts_failed':
          pendingTTSText = msg.text || '';
          fallbackSpeak(pendingTTSText);
          break;

        case 'done':
          break;

        case 'error':
          if (msg.message === 'empty_transcription') {
            if (robotStatus) robotStatus.textContent = 'Не расслышал. Говорите громче.';
            setTimeout(function () { if (active) beginListeningCycle(); }, 1800);
          } else {
            console.error('[WS] server error:', msg.message);
            if (robotStatus) robotStatus.textContent = 'Ошибка: ' + (msg.message || '');
            setTimeout(function () { if (active) beginListeningCycle(); }, 2000);
          }
          break;
      }
    };
  }

  function disconnectWS() {
    if (ws) {
      ws.onclose = null;
      ws.close();
      ws = null;
      wsReady = false;
    }
  }

  function wsSend(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------
  // TTS через WebSocket (binary mp3)
  // -------------------------------------------------------------------
  function handleTTSAudio(arrayBuffer) {
    if (!active) return;
    setState('speaking');
    var blob = new Blob([arrayBuffer], { type: 'audio/mpeg' });
    var url = URL.createObjectURL(blob);
    var audio = new Audio(url);
    currentAudio = audio;
    audio.onended = function () {
      URL.revokeObjectURL(url);
      currentAudio = null;
      if (active) beginListeningCycle();
    };
    audio.onerror = function () {
      URL.revokeObjectURL(url);
      currentAudio = null;
      if (pendingTTSText) fallbackSpeak(pendingTTSText);
      else if (active) beginListeningCycle();
    };
    audio.play().catch(function () {
      URL.revokeObjectURL(url);
      currentAudio = null;
      if (pendingTTSText) fallbackSpeak(pendingTTSText);
      else if (active) beginListeningCycle();
    });
  }

  // -------------------------------------------------------------------
  // Навигация
  // -------------------------------------------------------------------
  function openChat() {
    screenLanding.classList.add('is-hidden');
    screenChat.removeAttribute('hidden');
    screenChat.classList.add('is-active');
    connectWS();
    startVoiceSession();
  }

  function closeChat() {
    stopVoiceSession();
    disconnectWS();
    screenChat.classList.remove('is-active');
    screenChat.setAttribute('hidden', '');
    screenLanding.classList.remove('is-hidden');
  }

  if (btnGoChat) btnGoChat.addEventListener('click', openChat);
  if (closeChatBtn) closeChatBtn.addEventListener('click', closeChat);

  // -------------------------------------------------------------------
  // Утилиты аудио
  // -------------------------------------------------------------------
  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onloadend = function () {
        if (typeof reader.result === 'string') {
          resolve(reader.result.split(',')[1]);
        } else {
          reject(new Error('base64 failed'));
        }
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  function convertWebMToWAV(webmBlob) {
    return new Promise(function (resolve, reject) {
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      var reader = new FileReader();
      reader.onloadend = function () {
        ctx.decodeAudioData(reader.result).then(function (audioBuffer) {
          var targetRate = 16000;
          var ratio = targetRate / audioBuffer.sampleRate;
          var newLen = Math.ceil(audioBuffer.length * ratio);
          var offline = new OfflineAudioContext(1, newLen, targetRate);
          var src = offline.createBufferSource();
          src.buffer = audioBuffer;
          src.connect(offline.destination);
          src.start(0);
          offline.startRendering().then(function (rendered) {
            var ch = rendered.getChannelData(0);
            var wavLen = ch.length * 2 + 44;
            var buf = new ArrayBuffer(wavLen);
            var v = new DataView(buf);
            var o = 0;
            function w(s) { for (var i = 0; i < s.length; i++) v.setUint8(o++, s.charCodeAt(i)); }
            w('RIFF');
            v.setUint32(o, 36 + ch.length * 2, true); o += 4;
            w('WAVE'); w('fmt ');
            v.setUint32(o, 16, true); o += 4;
            v.setUint16(o, 1, true); o += 2;
            v.setUint16(o, 1, true); o += 2;
            v.setUint32(o, targetRate, true); o += 4;
            v.setUint32(o, targetRate * 2, true); o += 4;
            v.setUint16(o, 2, true); o += 2;
            v.setUint16(o, 16, true); o += 2;
            w('data');
            v.setUint32(o, ch.length * 2, true); o += 4;
            for (var i = 0; i < ch.length; i++) {
              var sample = ch[i];
              v.setInt16(o, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
              o += 2;
            }
            resolve(new Blob([v], { type: 'audio/wav' }));
          }).catch(reject);
        }).catch(reject);
      };
      reader.onerror = reject;
      reader.readAsArrayBuffer(webmBlob);
    });
  }

  // -------------------------------------------------------------------
  // VAD (детектор голосовой активности)
  // -------------------------------------------------------------------
  function getVolume() {
    if (!analyser || !analyserData) return 0;
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(function () {});
      return 0;
    }
    analyser.getByteTimeDomainData(analyserData);
    var sum = 0;
    for (var i = 0; i < analyserData.length; i++) {
      var val = analyserData[i] - 128;
      sum += val * val;
    }
    return Math.sqrt(sum / analyserData.length);
  }

  // -------------------------------------------------------------------
  // Запуск/остановка голосовой сессии
  // -------------------------------------------------------------------
  function startVoiceSession() {
    if (active) return;
    active = true;
    if (robotStatus) robotStatus.textContent = 'Подключаю микрофон…';

    var audioOpts = {
      audio: {
        channelCount: 1,
        sampleRate: { ideal: 48000, min: 44100 },
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: true
      }
    };

    navigator.mediaDevices.getUserMedia(audioOpts).then(function (s) {
      if (!active) { s.getTracks().forEach(function (t) { t.stop(); }); return; }
      stream = s;

      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      audioCtx.resume().then(function () {
        var source = audioCtx.createMediaStreamSource(stream);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.25;
        source.connect(analyser);
        analyserData = new Uint8Array(analyser.fftSize);

        audioCtxWatchdog = setInterval(function () {
          if (audioCtx && audioCtx.state === 'suspended') {
            audioCtx.resume().catch(function () {});
          }
        }, 2000);

        setState('listening');
        startFreshRecording();
        startVAD();
      }).catch(function () {
        var source = audioCtx.createMediaStreamSource(stream);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.25;
        source.connect(analyser);
        analyserData = new Uint8Array(analyser.fftSize);
        setState('listening');
        startFreshRecording();
        startVAD();
      });

    }).catch(function (err) {
      active = false;
      setState('idle');
      if (robotStatus) robotStatus.textContent = 'Нет доступа к микрофону. Разрешите в браузере.';
      console.error('getUserMedia error:', err);
    });
  }

  function stopVoiceSession() {
    active = false;
    clearTimers();
    safeStopRecorder();
    stopPlayback();

    if (audioCtxWatchdog) { clearInterval(audioCtxWatchdog); audioCtxWatchdog = null; }

    if (audioCtx) {
      try { audioCtx.close(); } catch (e) {}
      audioCtx = null;
      analyser = null;
      analyserData = null;
    }

    if (stream) {
      stream.getTracks().forEach(function (t) { t.stop(); });
      stream = null;
    }

    recorder = null;
    recordedChunks = [];
    isSpeaking = false;
    hasSpoken = false;
    setState('idle');
  }

  function clearTimers() {
    if (vadTimer) { clearInterval(vadTimer); vadTimer = null; }
    if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
  }

  function stopPlayback() {
    if (currentAudio) {
      try { currentAudio.pause(); } catch (e) {}
      currentAudio.src = '';
      currentAudio = null;
    }
    if (window.speechSynthesis) {
      try { speechSynthesis.cancel(); } catch (e) {}
    }
  }

  // -------------------------------------------------------------------
  // Цикл: слушаю → (6 сек тишины) → отправляю → отвечаю → слушаю
  // -------------------------------------------------------------------
  function beginListeningCycle() {
    if (!active) return;
    if (!stream || stream.getTracks().every(function (t) { return t.readyState === 'ended'; })) {
      active = false;
      startVoiceSession();
      return;
    }

    isSpeaking = false;
    hasSpoken = false;
    recordedChunks = [];
    pendingTTSText = '';
    if (robotHeard) robotHeard.textContent = '';

    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(function () {});
    }

    setState('listening');
    startFreshRecording();
    startVAD();
  }

  function safeStopRecorder() {
    if (recorder) {
      recorder.onstop = null;
      recorder.ondataavailable = null;
      if (recorder.state === 'recording' || recorder.state === 'paused') {
        try { recorder.stop(); } catch (e) {}
      }
      recorder = null;
    }
  }

  function startFreshRecording() {
    safeStopRecorder();
    recordedChunks = [];
    if (!stream) return;

    var opts;
    try {
      opts = { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 320000 };
      recorder = new MediaRecorder(stream, opts);
    } catch (e) {
      try {
        opts = { mimeType: 'audio/webm', audioBitsPerSecond: 320000 };
        recorder = new MediaRecorder(stream, opts);
      } catch (e2) {
        try {
          recorder = new MediaRecorder(stream, { audioBitsPerSecond: 256000 });
        } catch (e3) {
          try { recorder = new MediaRecorder(stream); } catch (e4) {
            console.error('MediaRecorder not available');
            return;
          }
        }
      }
    }

    recorder.ondataavailable = function (e) {
      if (e.data && e.data.size > 0) recordedChunks.push(e.data);
    };

    recorder.onstop = function () {
      if (!active) { recorder = null; return; }
      if (recordedChunks.length === 0) {
        recorder = null;
        beginListeningCycle();
        return;
      }
      var fullBlob = new Blob(recordedChunks, { type: 'audio/webm' });
      recordedChunks = [];
      hasSpoken = false;
      isSpeaking = false;
      recorder = null;
      setState('processing');
      sendAudioViaWS(fullBlob);
    };

    recorder.onerror = function (e) {
      console.error('MediaRecorder error:', e);
      recorder = null;
      if (active) {
        setTimeout(function () { beginListeningCycle(); }, 500);
      }
    };

    try {
      recorder.start(RECORDER_TIMESLICE_MS);
    } catch (e) {
      console.error('recorder.start error:', e);
      recorder = null;
      setTimeout(function () { beginListeningCycle(); }, 1000);
    }
  }

  function startVAD() {
    clearTimers();

    vadTimer = setInterval(function () {
      if (!active) { clearTimers(); return; }
      if (currentState === 'processing' || currentState === 'speaking') return;
      if (!recorder || recorder.state !== 'recording') {
        startFreshRecording();
        return;
      }

      var vol = getVolume();

      if (vol >= VOICE_THRESHOLD) {
        isSpeaking = true;
        hasSpoken = true;
        if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
        if (robotHeard) robotHeard.textContent = 'Говорите…';
      } else {
        if (isSpeaking) isSpeaking = false;
        if (hasSpoken && !silenceTimer) {
          if (robotHeard) robotHeard.textContent = 'Жду окончания…';
          silenceTimer = setTimeout(function () {
            silenceTimer = null;
            onSilenceAfterSpeech();
          }, SILENCE_TIMEOUT_SEC * 1000);
        }
      }
    }, VAD_INTERVAL_MS);
  }

  function onSilenceAfterSpeech() {
    if (!active) return;
    clearTimers();
    if (recorder && recorder.state === 'recording') {
      try { recorder.stop(); } catch (e) {
        recorder = null;
        beginListeningCycle();
      }
    } else {
      beginListeningCycle();
    }
  }

  // -------------------------------------------------------------------
  // Отправка аудио через WebSocket
  // -------------------------------------------------------------------
  function sendAudioViaWS(blob) {
    convertWebMToWAV(blob).then(function (wav) {
      return blobToBase64(wav);
    }).then(function (base64) {
      if (!wsSend({ type: 'audio', data: base64 })) {
        if (robotStatus) robotStatus.textContent = 'WebSocket не подключён, переподключаюсь…';
        connectWS();
        setTimeout(function () {
          if (!wsSend({ type: 'audio', data: base64 })) {
            if (robotStatus) robotStatus.textContent = 'Не удалось отправить. Попробуйте снова.';
            setTimeout(function () { if (active) beginListeningCycle(); }, 2000);
          }
        }, 1500);
      }
    }).catch(function (err) {
      console.error('convertWebMToWAV error:', err);
      if (active) setTimeout(function () { beginListeningCycle(); }, 500);
    });
  }

  // -------------------------------------------------------------------
  // Fallback TTS (browser speechSynthesis)
  // -------------------------------------------------------------------
  function fallbackSpeak(text) {
    if (!window.speechSynthesis) {
      setTimeout(beginListeningCycle, 1500);
      return;
    }
    var u = new SpeechSynthesisUtterance(text);
    u.lang = 'ru-RU';
    u.rate = 0.95;
    u.onend = function () { if (active) beginListeningCycle(); };
    u.onerror = function () { if (active) beginListeningCycle(); };
    function go() {
      var voices = speechSynthesis.getVoices();
      for (var i = 0; i < voices.length; i++) {
        if (voices[i].lang && voices[i].lang.startsWith('ru')) { u.voice = voices[i]; break; }
      }
      speechSynthesis.speak(u);
    }
    if (speechSynthesis.getVoices().length) go();
    else speechSynthesis.onvoiceschanged = go;
  }

  // -------------------------------------------------------------------
  // Загрузка текстов (база знаний) — остаётся на HTTP
  // -------------------------------------------------------------------
  function loadFileList() {
    fetch('/api/texts')
      .then(function (r) { return r.json(); })
      .then(function (data) { renderFileList(data.files || []); })
      .catch(function () { renderFileList([]); });
  }

  function renderFileList(files) {
    if (!uploadList) return;
    uploadList.innerHTML = '';
    if (uploadCount) uploadCount.textContent = files.length ? files.length + ' файл(ов)' : '';
    files.forEach(function (f) {
      var li = document.createElement('li');
      li.className = 'upload-list__item';
      var name = document.createElement('span');
      name.className = 'upload-list__name';
      name.textContent = f.name;
      var size = document.createElement('span');
      size.className = 'upload-list__size';
      size.textContent = formatSize(f.size);
      var del = document.createElement('button');
      del.className = 'upload-list__del';
      del.textContent = '✕';
      del.title = 'Удалить';
      del.addEventListener('click', function () { deleteFile(f.name); });
      li.appendChild(name);
      li.appendChild(size);
      li.appendChild(del);
      uploadList.appendChild(li);
    });
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' Б';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' КБ';
    return (bytes / (1024 * 1024)).toFixed(1) + ' МБ';
  }

  function uploadFile(file) {
    var form = new FormData();
    form.append('file', file);
    fetch('/api/upload-text', { method: 'POST', body: form })
      .then(function (r) { return r.json(); })
      .then(function () { loadFileList(); })
      .catch(function () {});
  }

  function deleteFile(name) {
    fetch('/api/texts', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name })
    })
    .then(function () { loadFileList(); })
    .catch(function () {});
  }

  if (btnUpload && fileInput) {
    btnUpload.addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function () {
      for (var i = 0; i < fileInput.files.length; i++) uploadFile(fileInput.files[i]);
      fileInput.value = '';
    });
  }

  loadFileList();
})();
