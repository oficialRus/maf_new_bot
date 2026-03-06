package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
)

const ttsURL = "https://api.openai.com/v1/audio/speech"

func synthesizeSpeech(text string) ([]byte, error) {
	apiKey := os.Getenv("OPENAI_API_KEY")
	if apiKey == "" {
		return nil, fmt.Errorf("OPENAI_API_KEY не задан")
	}

	payload, _ := json.Marshal(map[string]interface{}{
		"model": "tts-1-hd",
		"voice": "onyx",
		"input": text,
	})

	req, err := http.NewRequest(http.MethodPost, ttsURL, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		errBody, _ := io.ReadAll(resp.Body)
		return nil, &openAIError{code: resp.StatusCode, msg: string(errBody)}
	}

	return io.ReadAll(resp.Body)
}
