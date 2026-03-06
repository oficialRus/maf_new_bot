package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"time"
)

const openAIURL = "https://api.openai.com/v1/chat/completions"

// Быстрый HTTP клиент с таймаутом
var fastClient = &http.Client{
	Timeout: 8 * time.Second,
}

type chatRequest struct {
	Model       string    `json:"model"`
	Messages    []message `json:"messages"`
	MaxTokens   int       `json:"max_tokens"`
	Temperature float32   `json:"temperature"`
}

type message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatResponse struct {
	Choices []struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
	} `json:"choices"`
	Error *struct {
		Message string `json:"message"`
		Type    string `json:"type"`
		Code    string `json:"code"`
	} `json:"error,omitempty"`
}

func callOpenAI(userMessage string, contextTexts string) (string, error) {
	apiKey := os.Getenv("OPENAI_API_KEY")
	if apiKey == "" {
		return "", nil
	}

	systemPrompt := `Ты МАФ - голосовой ассистент ВКА. Правила: 1)Только русский язык 2)На вопросы о создателе: "Меня создали в молодежно-конструкторском бюро" 3)Отвечай кратко и по делу.`

	if contextTexts != "" {
		systemPrompt += "\n4.БАЗА:" + contextTexts[:min(len(contextTexts), 1000)] // Обрезаем контекст
	}

	reqBody := chatRequest{
		Model:       "gpt-4o-mini",
		MaxTokens:   150,        // Ограничиваем длину ответа
		Temperature: 0.3,        // Меньше креативности = быстрее
		Messages: []message{
			{Role: "system", Content: systemPrompt},
			{Role: "user", Content: userMessage},
		},
	}
	body, _ := json.Marshal(reqBody)

	req, err := http.NewRequest(http.MethodPost, openAIURL, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)

	resp, err := fastClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	var out chatResponse
	_ = json.Unmarshal(respBody, &out)

	if resp.StatusCode != http.StatusOK {
		msg := string(respBody)
		if out.Error != nil && out.Error.Message != "" {
			msg = out.Error.Message
		}
		return "", &openAIError{code: resp.StatusCode, msg: msg}
	}
	if len(out.Choices) == 0 {
		return "", nil
	}
	return out.Choices[0].Message.Content, nil
}

type openAIError struct {
	code int
	msg  string
}

func (e *openAIError) Error() string {
	return e.msg
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
