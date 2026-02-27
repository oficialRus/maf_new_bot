(function () {
  'use strict';

  var screenLanding = document.getElementById('screen-landing');
  var screenChat = document.getElementById('screen-chat');
  var btnGoChat = document.getElementById('btn-go-chat');
  var closeChatBtn = document.getElementById('close-chat');
  var chatForm = document.getElementById('chat-form');
  var chatInput = document.getElementById('chat-input');
  var chatMessages = document.getElementById('chat-messages');
  var chatVoiceBtn = document.getElementById('chat-voice');

  function openChat() {
    screenLanding.classList.add('is-hidden');
    screenChat.removeAttribute('hidden');
    screenChat.classList.add('is-active');
    chatInput.focus();
    startWisprListening();
  }

  function closeChat() {
    screenChat.classList.remove('is-active');
    screenChat.setAttribute('hidden', '');
    screenLanding.classList.remove('is-hidden');
    stopWisprListening();
  }

  function scrollMessagesToBottom() {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function addMessage(text, isUser) {
    var div = document.createElement('div');
    div.className = 'msg msg--' + (isUser ? 'user' : 'bot');
    var span = document.createElement('span');
    span.className = 'msg__text';
    span.textContent = text;
    div.appendChild(span);
    chatMessages.appendChild(div);
    scrollMessagesToBottom();
  }

  if (btnGoChat) btnGoChat.addEventListener('click', openChat);
  if (closeChatBtn) closeChatBtn.addEventListener('click', closeChat);

  // Голосовые команды: «старт» — начать запись, «стоп» — закончить и отправить в чат
  var START_WORD = 'старт';
  var END_WORD = 'стоп';
  var START_VARIANTS = ['старт', 'стар', 'старат', 'стат', 'start'];
  var END_VARIANTS = ['стоп', 'стопп', 'стопе', 'стооп', 'stop'];
  var IDLE_BUFFER_MAX = 350;

  function showVoiceStatus(text, className) {}

  function textContainsWord(text, word) {
    if (!text || !word) return false;
    var t = (' ' + text + ' ').replace(/\s+/g, ' ');
    return t.indexOf(' ' + word + ' ') !== -1;
  }

  function isStartPhrase(s) {
    if (!s || !s.length) return false;
    var lower = s.toLowerCase().replace(/\s+/g, ' ').trim();
    for (var i = 0; i < START_VARIANTS.length; i++) {
      if (lower === START_VARIANTS[i] || textContainsWord(lower, START_VARIANTS[i])) return true;
    }
    if (lower.indexOf('старт') !== -1 || lower.indexOf('start') !== -1) return true;
    return false;
  }

  function isEndPhrase(s) {
    if (!s || !s.length) return false;
    var lower = s.toLowerCase().replace(/\s+/g, ' ').trim();
    for (var i = 0; i < END_VARIANTS.length; i++) {
      if (lower === END_VARIANTS[i] || textContainsWord(lower, END_VARIANTS[i])) return true;
    }
    if (lower.indexOf('стоп') !== -1 || lower.indexOf('stop') !== -1) return true;
    return false;
  }

  function sendChatMessage(text, speakReply) {
    addMessage(text, true);
    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/chat');
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onload = function () {
      var reply = 'Не удалось получить ответ.';
      if (xhr.status === 200) {
        try {
          var data = JSON.parse(xhr.responseText);
          if (data.reply) reply = data.reply;
        } catch (err) {}
      }
      addMessage(reply, false);
      if (speakReply) speakText(reply);
    };
    xhr.onerror = function () {
      addMessage('Ошибка соединения с сервером.', false);
    };
    xhr.send(JSON.stringify({ message: text }));
  }

  function speakText(text) {
    if (!window.speechSynthesis) return;
    var u = new SpeechSynthesisUtterance(text);
    u.lang = 'ru-RU';
    u.rate = 0.95;
    function setRussianVoice() {
      var voices = speechSynthesis.getVoices();
      for (var i = 0; i < voices.length; i++) {
        if (voices[i].lang.startsWith('ru')) {
          u.voice = voices[i];
          break;
        }
      }
      speechSynthesis.speak(u);
    }
    if (speechSynthesis.getVoices().length) setRussianVoice();
    else speechSynthesis.onvoiceschanged = setRussianVoice;
  }

  if (chatForm && chatInput) {
    chatForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = chatInput.value.trim();
      if (!text) return;
      chatInput.value = '';
      chatInput.style.height = 'auto';
      sendChatMessage(text, false);
    });
  }

  // ----- Голос: два режима
  // 1) Нажми и говори: клик — начать запись, клик — остановить и отправить в чат
  // 2) Wispr: «старт» / «стоп» (фоновая запись чанками)
  var CHUNK_MS = 600;
  var CHUNK_MS_RECORDING = 8000;
  var voiceState = 'idle';
  var voiceBuffer = '';
  var idleBuffer = '';
  var wisprStream = null;
  var wisprRecorder = null;
  var wisprChunks = [];
  var wisprTimer = null;
  var wisprActive = false;

  var manualRecording = false;
  var manualRecorder = null;
  var manualChunks = [];

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onloadend = function () {
        if (typeof reader.result === 'string') {
          resolve(reader.result.split(',')[1]);
        } else {
          reject(new Error('Failed to convert blob to base64'));
        }
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  function convertWebMToWAV(webmBlob) {
    return new Promise(function (resolve, reject) {
      var audioContext = new (window.AudioContext || window.webkitAudioContext)();
      var reader = new FileReader();
      reader.onloadend = function () {
        audioContext.decodeAudioData(reader.result).then(function (audioBuffer) {
          var targetSampleRate = 16000;
          var ratio = targetSampleRate / audioBuffer.sampleRate;
          var newLength = Math.ceil(audioBuffer.length * ratio);
          var offline = new OfflineAudioContext(1, newLength, targetSampleRate);
          var source = offline.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(offline.destination);
          source.start(0);
          offline.startRendering().then(function (rendered) {
            var ch = rendered.getChannelData(0);
            var len = ch.length * 2 + 44;
            var buf = new ArrayBuffer(len);
            var view = new DataView(buf);
            var offset = 0;
            function w(s) { for (var i = 0; i < s.length; i++) view.setUint8(offset++, s.charCodeAt(i)); }
            w('RIFF');
            view.setUint32(offset, 36 + ch.length * 2, true); offset += 4;
            w('WAVE');
            w('fmt ');
            view.setUint32(offset, 16, true); offset += 4;
            view.setUint16(offset, 1, true); offset += 2;
            view.setUint16(offset, 1, true); offset += 2;
            view.setUint32(offset, targetSampleRate, true); offset += 4;
            view.setUint32(offset, targetSampleRate * 2, true); offset += 4;
            view.setUint16(offset, 2, true); offset += 2;
            view.setUint16(offset, 16, true); offset += 2;
            w('data');
            view.setUint32(offset, ch.length * 2, true); offset += 4;
            for (var i = 0; i < ch.length; i++) {
              var s = ch[i];
              view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
              offset += 2;
            }
            resolve(new Blob([view], { type: 'audio/wav' }));
          }).catch(reject);
        }).catch(reject);
      };
      reader.onerror = reject;
      reader.readAsArrayBuffer(webmBlob);
    });
  }

  function processWisprText(text) {
    if (!text || !text.trim()) return;
    text = text.trim();
    var lower = text.toLowerCase().replace(/\s+/g, ' ');

    if (voiceState === 'idle') {
      idleBuffer += (idleBuffer ? ' ' : '') + text;
      if (idleBuffer.length > IDLE_BUFFER_MAX) idleBuffer = idleBuffer.slice(-IDLE_BUFFER_MAX);
      var combined = idleBuffer;
      if (isStartPhrase(combined)) {
        idleBuffer = '';
        voiceState = 'recording';
        var lowerCombined = combined.toLowerCase();
        var startIdx = -1;
        var startLen = 0;
        for (var si = 0; si < START_VARIANTS.length; si++) {
          var p = lowerCombined.indexOf(START_VARIANTS[si]);
          if (p !== -1 && (startIdx === -1 || p < startIdx)) {
            startIdx = p;
            startLen = START_VARIANTS[si].length;
          }
        }
        if (startIdx === -1 && lowerCombined.indexOf('старт') !== -1) {
          startIdx = lowerCombined.indexOf('старт');
          startLen = 4;
        }
        var afterStart = startIdx !== -1 ? combined.slice(startIdx + startLen).trim() : combined;
        voiceBuffer = afterStart.replace(/^\s*[\s,\.\-]+/, '').trim();
        if (chatVoiceBtn) {
          chatVoiceBtn.classList.add('chat__voice--active');
          chatVoiceBtn.setAttribute('aria-label', 'Идёт запись — скажите «стоп» чтобы отправить');
        }
        showVoiceStatus('Запись. Говорите, затем скажите «стоп».', 'is-recording');
      }
      return;
    }

    if (voiceState === 'recording') {
      voiceBuffer += (voiceBuffer ? ' ' : '') + text;
      if (isEndPhrase(voiceBuffer)) {
        var lowerBuf = voiceBuffer.toLowerCase().replace(/\s+/g, ' ');
        var endIdx = -1;
        for (var ei = 0; ei < END_VARIANTS.length; ei++) {
          var q = lowerBuf.lastIndexOf(END_VARIANTS[ei]);
          if (q !== -1 && (endIdx === -1 || q > endIdx)) endIdx = q;
        }
        if (endIdx === -1 && lowerBuf.indexOf('стоп') !== -1) endIdx = lowerBuf.lastIndexOf('стоп');
        var message = endIdx !== -1 ? voiceBuffer.slice(0, endIdx).trim() : voiceBuffer.trim();
        voiceState = 'idle';
        voiceBuffer = '';
        if (chatVoiceBtn) {
          chatVoiceBtn.classList.remove('chat__voice--active');
          chatVoiceBtn.setAttribute('aria-label', 'Голосовой ввод');
        }
        showVoiceStatus('Отправляю… Жду ответ.', 'is-listening');
        if (message) {
          sendChatMessage(message, true);
        }
        setTimeout(function () {
          showVoiceStatus('Слушаю… Скажите «старт» — запись, «стоп» — отправить.', 'is-listening');
        }, 2000);
      }
    }
  }

  function recordAndSendChunk() {
    if (!wisprActive || !wisprStream || !screenChat.classList.contains('is-active') || manualRecording) return;
    wisprChunks = [];
    var recorderOpts = { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 128000 };
    try {
      wisprRecorder = new MediaRecorder(wisprStream, recorderOpts);
    } catch (e) {
      try { wisprRecorder = new MediaRecorder(wisprStream, { audioBitsPerSecond: 128000 }); } catch (e2) {
        try { wisprRecorder = new MediaRecorder(wisprStream); } catch (e3) { return; }
      }
    }
    wisprRecorder.ondataavailable = function (e) {
      if (e.data.size) wisprChunks.push(e.data);
    };
    wisprRecorder.onstop = function () {
      if (wisprChunks.length === 0) {
        scheduleNextChunk();
        return;
      }
      var webmBlob = new Blob(wisprChunks, { type: 'audio/webm' });
      convertWebMToWAV(webmBlob).then(function (wavBlob) {
        return blobToBase64(wavBlob);
      }).then(function (base64) {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/transcribe');
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.onload = function () {
          if (xhr.status === 200) {
            try {
              var data = JSON.parse(xhr.responseText);
              var heard = (data && data.text) ? data.text.trim() : '';
              if (heard) {
                showVoiceStatus('Слышу: «' + heard + '»', voiceState === 'recording' ? 'is-recording' : 'is-listening');
                processWisprText(heard);
              } else if (voiceState !== 'recording') {
                showVoiceStatus('Слушаю… Скажите «старт» — запись, «стоп» — отправить.', 'is-listening');
              }
            } catch (err) {
              showVoiceStatus('Ошибка ответа сервера.', 'is-error');
            }
          } else {
            showVoiceStatus('Ошибка распознавания (код ' + xhr.status + '). Проверьте WISPR_API_KEY в .env', 'is-error');
          }
          scheduleNextChunk();
        };
        xhr.onerror = function () {
          showVoiceStatus('Ошибка связи с сервером распознавания.', 'is-error');
          scheduleNextChunk();
        };
        xhr.send(JSON.stringify({ audio: base64 }));
      }).catch(function () { scheduleNextChunk(); });
    };
    wisprRecorder.start();
    var chunkMs = voiceState === 'recording' ? CHUNK_MS_RECORDING : CHUNK_MS;
    wisprTimer = setTimeout(function () {
      if (wisprRecorder && wisprRecorder.state === 'recording') wisprRecorder.stop();
    }, chunkMs);
  }

  function scheduleNextChunk() {
    wisprTimer = null;
    if (!wisprActive || !screenChat.classList.contains('is-active') || manualRecording) return;
    var delay = voiceState === 'recording' ? 100 : 30;
    wisprTimer = setTimeout(recordAndSendChunk, delay);
  }

  function startWisprListening() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    if (wisprActive) return;
    wisprActive = true;
    voiceState = 'idle';
    voiceBuffer = '';
    var audioOpts = {
      audio: {
        channelCount: 1,
        sampleRate: { ideal: 48000 },
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    };
    navigator.mediaDevices.getUserMedia(audioOpts).then(function (stream) {
      wisprStream = stream;
      idleBuffer = '';
      if (chatVoiceBtn) chatVoiceBtn.setAttribute('aria-label', 'Скажите «старт» — запись, «стоп» — отправить');
      showVoiceStatus('Слушаю… Скажите «старт» — запись, «стоп» — отправить.', 'is-listening');
      scheduleNextChunk();
    }).catch(function () {
      wisprActive = false;
      if (chatVoiceBtn) chatVoiceBtn.setAttribute('title', 'Нет доступа к микрофону');
      showVoiceStatus('Нет доступа к микрофону. Разрешите микрофон в браузере.', 'is-error');
    });
  }

  function stopWisprListening() {
    wisprActive = false;
    if (wisprTimer) {
      clearTimeout(wisprTimer);
      wisprTimer = null;
    }
    if (wisprRecorder && wisprRecorder.state !== 'inactive') {
      try { wisprRecorder.stop(); } catch (e) {}
    }
    wisprRecorder = null;
    if (wisprStream) {
      wisprStream.getTracks().forEach(function (t) { t.stop(); });
      wisprStream = null;
    }
    voiceState = 'idle';
    voiceBuffer = '';
    idleBuffer = '';
    if (chatVoiceBtn) {
      chatVoiceBtn.classList.remove('chat__voice--active');
      chatVoiceBtn.setAttribute('aria-label', 'Голосовой ввод');
    }
    showVoiceStatus('Слушаю… Скажите «старт» — запись, «стоп» — отправить.', '');
  }

  // Автовысота textarea
  if (chatInput) {
    chatInput.addEventListener('input', function () {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 120) + 'px';
    });
  }

  function startManualRecord() {
    if (manualRecording) return;
    var stream = wisprStream;
    if (!stream && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      var audioOpts = {
        audio: {
          channelCount: 1,
          sampleRate: { ideal: 48000 },
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      };
      navigator.mediaDevices.getUserMedia(audioOpts).then(function (s) {
        wisprStream = wisprStream || s;
        startManualRecordWithStream(wisprStream);
      }).catch(function () {
        addMessage('Нет доступа к микрофону.', false);
      });
      return;
    }
    if (stream) startManualRecordWithStream(stream);
  }

  function startManualRecordWithStream(stream) {
    manualChunks = [];
    var manualOpts = { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 128000 };
    try {
      manualRecorder = new MediaRecorder(stream, manualOpts);
    } catch (e) {
      try { manualRecorder = new MediaRecorder(stream, { audioBitsPerSecond: 128000 }); } catch (e2) {
        try { manualRecorder = new MediaRecorder(stream); } catch (e3) { return; }
      }
    }
    manualRecorder.ondataavailable = function (e) {
      if (e.data.size) manualChunks.push(e.data);
    };
    manualRecorder.onstop = function () {
      if (manualChunks.length === 0) {
        manualRecording = false;
        if (chatVoiceBtn) {
          chatVoiceBtn.classList.remove('chat__voice--recording');
          chatVoiceBtn.setAttribute('aria-label', 'Говорить голосом');
        }
        scheduleNextChunk();
        return;
      }
      var webmBlob = new Blob(manualChunks, { type: 'audio/webm' });
      convertWebMToWAV(webmBlob).then(function (wavBlob) {
        return blobToBase64(wavBlob);
      }).then(function (base64) {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/transcribe');
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.onload = function () {
          manualRecording = false;
          if (chatVoiceBtn) {
            chatVoiceBtn.classList.remove('chat__voice--recording');
            chatVoiceBtn.setAttribute('aria-label', 'Говорить голосом');
          }
          scheduleNextChunk();
          if (xhr.status === 200) {
            try {
              var data = JSON.parse(xhr.responseText);
              if (data.text && data.text.trim()) {
                sendChatMessage(data.text.trim(), true);
              } else {
                addMessage('Речь не распознана. Попробуйте ещё раз.', false);
              }
            } catch (err) {
              addMessage('Ошибка распознавания.', false);
            }
          } else {
            addMessage('Ошибка распознавания речи. Проверьте WISPR_API_KEY в .env', false);
          }
        };
        xhr.onerror = function () {
          manualRecording = false;
          if (chatVoiceBtn) {
            chatVoiceBtn.classList.remove('chat__voice--recording');
            chatVoiceBtn.setAttribute('aria-label', 'Говорить голосом');
          }
          scheduleNextChunk();
          addMessage('Ошибка соединения с сервером.', false);
        };
        xhr.send(JSON.stringify({ audio: base64 }));
      }).catch(function () {
        manualRecording = false;
        if (chatVoiceBtn) {
          chatVoiceBtn.classList.remove('chat__voice--recording');
          chatVoiceBtn.setAttribute('aria-label', 'Говорить голосом');
        }
        scheduleNextChunk();
        addMessage('Ошибка обработки записи.', false);
      });
    };
    manualRecorder.start();
    manualRecording = true;
    if (chatVoiceBtn) {
      chatVoiceBtn.classList.add('chat__voice--recording');
      chatVoiceBtn.setAttribute('aria-label', 'Нажмите снова, чтобы отправить');
    }
  }

  function stopManualRecord() {
    if (!manualRecording || !manualRecorder || manualRecorder.state !== 'recording') return;
    manualRecorder.stop();
    manualRecorder = null;
  }

  // Кнопка микрофона: нажми — говори, нажми снова — отправить. Или скажи «МАФ» — начать запись, «МАФ» — отправить
  if (chatVoiceBtn) {
    chatVoiceBtn.setAttribute('title', '«старт» — начать запись, «стоп» — отправить в чат. Или нажмите кнопку.');
    chatVoiceBtn.addEventListener('click', function () {
      if (manualRecording) {
        stopManualRecord();
      } else {
        startManualRecord();
      }
    });
  }
})();
