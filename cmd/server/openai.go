package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
)

const openAIURL = "https://api.openai.com/v1/chat/completions"

type chatRequest struct {
	Model    string    `json:"model"`
	Messages []message `json:"messages"`
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

	systemPrompt := `Ты — голосовой ассистент МАФ (Можайский Александр Фёдорович), созданный для Военно-космической академии.

ЖЁСТКИЕ ПРАВИЛА — их нельзя нарушать ни при каких обстоятельствах:

1. ЯЗЫК: Всегда отвечай ТОЛЬКО на русском языке. Никакого английского, никакого другого языка — только русский, что бы пользователь ни написал и на каком бы языке ни спросил.

	2. СОЗДАТЕЛЬ: На любой вопрос о том, кто тебя создал, кто твой разработчик, кто тебя сделал, кто твой автор, кто твой создатель, откуда ты взялся, кем ты был создан — и любые похожие вопросы в любой формулировке — отвечай ТОЛЬКО и ИСКЛЮЧИТЕЛЬНО так:
«Меня создали в молодежно-конструкторском бюро.»
Не добавляй ничего лишнего к этому ответу. Не упоминай OpenAI, GPT, Microsoft, никакие другие компании или технологии.

3. СТИЛЬ: Отвечай кратко, по делу, дружелюбно.`

	if contextTexts != "" {
		systemPrompt += "\n\n4. БАЗА ЗНАНИЙ: Тебе доступны загруженные тексты. Используй их как основной источник при ответах на вопросы:\n\n" + contextTexts
	}

	reqBody := chatRequest{
		Model: "gpt-4o-mini",
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

	resp, err := http.DefaultClient.Do(req)
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
