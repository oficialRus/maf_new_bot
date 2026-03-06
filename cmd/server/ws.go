package main

import (
	"encoding/base64"
	"encoding/json"
	"log"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  512 * 1024,
	WriteBufferSize: 512 * 1024,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

type wsIncoming struct {
	Type string `json:"type"`
	Data string `json:"data,omitempty"`
}

type wsOutgoing struct {
	Type    string `json:"type"`
	Text    string `json:"text,omitempty"`
	Message string `json:"message,omitempty"`
}

func handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("ws upgrade: %v", err)
		return
	}
	defer conn.Close()

	var writeMu sync.Mutex

	sendJSON := func(msg wsOutgoing) {
		writeMu.Lock()
		defer writeMu.Unlock()
		conn.WriteJSON(msg)
	}

	sendBinary := func(data []byte) {
		writeMu.Lock()
		defer writeMu.Unlock()
		conn.WriteMessage(websocket.BinaryMessage, data)
	}

	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			break
		}

		var msg wsIncoming
		if err := json.Unmarshal(raw, &msg); err != nil {
			sendJSON(wsOutgoing{Type: "error", Message: "invalid json"})
			continue
		}

		switch msg.Type {
		case "audio":
			go processVoicePipeline(msg.Data, sendJSON, sendBinary)
		default:
			sendJSON(wsOutgoing{Type: "error", Message: "unknown type: " + msg.Type})
		}
	}
}

func processVoicePipeline(audioBase64 string, sendJSON func(wsOutgoing), sendBinary func([]byte)) {
	// 1. Транскрипция
	text, err := transcribeWispr(audioBase64)
	if err != nil {
		log.Printf("ws wispr: %v", err)
		sendJSON(wsOutgoing{Type: "error", Message: "transcription failed"})
		sendJSON(wsOutgoing{Type: "done"})
		return
	}
	if text == "" {
		sendJSON(wsOutgoing{Type: "error", Message: "empty_transcription"})
		sendJSON(wsOutgoing{Type: "done"})
		return
	}

	sendJSON(wsOutgoing{Type: "transcription", Text: text})

	// 2. GPT
	ctx := loadTextContext()
	reply, err := callOpenAI(text, ctx)
	if err != nil {
		log.Printf("ws openai: %v", err)
		sendJSON(wsOutgoing{Type: "error", Message: "chat error: " + err.Error()})
		sendJSON(wsOutgoing{Type: "done"})
		return
	}
	if reply == "" {
		reply = "Не удалось получить ответ."
	}

	sendJSON(wsOutgoing{Type: "reply", Text: reply})

	// 3. TTS
	audioBytes, err := synthesizeSpeech(reply)
	if err != nil {
		log.Printf("ws tts: %v", err)
		audioB64 := ""
		if audioBytes != nil {
			audioB64 = base64.StdEncoding.EncodeToString(audioBytes)
		}
		_ = audioB64
		sendJSON(wsOutgoing{Type: "tts_failed", Text: reply})
		sendJSON(wsOutgoing{Type: "done"})
		return
	}

	sendJSON(wsOutgoing{Type: "tts_start"})
	sendBinary(audioBytes)
	sendJSON(wsOutgoing{Type: "done"})
}
