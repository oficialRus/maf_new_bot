package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"time"
)

const wisprAPIURL = "https://platform-api.wisprflow.ai/api/v1/dash/api"

// Быстрый HTTP клиент для Wispr
var fastWisprClient = &http.Client{
	Timeout: 5 * time.Second,
}

type wisprRequest struct {
	Audio   string   `json:"audio"`
	Language []string `json:"language"`
	Context *struct {
		App *struct {
			Type string `json:"type"`
		} `json:"app"`
	} `json:"context,omitempty"`
}

type wisprResponse struct {
	Text             string `json:"text"`
	DetectedLanguage string `json:"detected_language"`
}

func transcribeWispr(base64Audio string) (string, error) {
	apiKey := os.Getenv("WISPR_API_KEY")
	if apiKey == "" {
		return "", nil
	}

	reqBody := wisprRequest{
		Audio:   base64Audio,
		Language: []string{"ru"},
		Context: &struct {
			App *struct {
				Type string `json:"type"`
			} `json:"app"`
		}{
			App: &struct {
				Type string `json:"type"`
			}{Type: "ai"},
		},
	}
	body, err := json.Marshal(reqBody)
	if err != nil {
		return "", err
	}

	req, err := http.NewRequest(http.MethodPost, wisprAPIURL, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)

	resp, err := fastWisprClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	var out wisprResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", err
	}
	return out.Text, nil
}
