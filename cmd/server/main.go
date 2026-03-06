package main

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"embed"
	"encoding/json"
	"encoding/pem"
	"io"
	"io/fs"
	"log"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/joho/godotenv"
)

//go:embed static/*
var staticFS embed.FS

const textsDir = "data/texts"
const maxContextLen = 30000

// Генерируем самоподписанный сертификат для HTTPS
func generateSelfSignedCert() (tls.Certificate, error) {
	// Создаем приватный ключ
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return tls.Certificate{}, err
	}

	// Создаем шаблон сертификата
	template := x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject: pkix.Name{
			CommonName: "localhost",
		},
		DNSNames:    []string{"localhost"},
		IPAddresses: []net.IP{net.IPv4(127, 0, 0, 1), net.IPv6loopback},
		NotBefore:   time.Now(),
		NotAfter:    time.Now().Add(365 * 24 * time.Hour), // 1 год
		KeyUsage:    x509.KeyUsageKeyEncipherment | x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}

	// Создаем сертификат
	certDER, err := x509.CreateCertificate(rand.Reader, &template, &template, &priv.PublicKey, priv)
	if err != nil {
		return tls.Certificate{}, err
	}

	// Сохраняем сертификат в файл для информации
	os.MkdirAll("certs", 0755)
	certOut, err := os.Create("certs/localhost.crt")
	if err == nil {
		pem.Encode(certOut, &pem.Block{Type: "CERTIFICATE", Bytes: certDER})
		certOut.Close()
	}

	// Сохраняем ключ в файл для информации  
	keyOut, err := os.Create("certs/localhost.key")
	if err == nil {
		pem.Encode(keyOut, &pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(priv)})
		keyOut.Close()
	}

	// Возвращаем TLS сертификат
	return tls.X509KeyPair(
		pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER}),
		pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(priv)}),
	)
}

func loadTextContext() string {
	entries, err := os.ReadDir(textsDir)
	if err != nil {
		return ""
	}
	var sb strings.Builder
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		data, err := os.ReadFile(filepath.Join(textsDir, entry.Name()))
		if err != nil {
			continue
		}
		sb.WriteString("--- " + entry.Name() + " ---\n")
		sb.Write(data)
		sb.WriteString("\n\n")
	}
	result := sb.String()
	if len(result) > maxContextLen {
		result = result[:maxContextLen] + "\n...(текст обрезан)..."
	}
	return result
}

func main() {
	if err := godotenv.Load(); err != nil {
		log.Printf("Загрузка .env: %v (работаем без .env)", err)
	}
	if os.Getenv("OPENAI_API_KEY") == "" {
		log.Printf("Предупреждение: OPENAI_API_KEY не задан, чат с GPT не будет работать")
	}

	if err := os.MkdirAll(textsDir, 0755); err != nil {
		log.Printf("Не удалось создать директорию %s: %v", textsDir, err)
	}

	staticContent, err := fs.Sub(staticFS, "static")
	if err != nil {
		log.Fatal(err)
	}
	http.Handle("/", http.FileServer(http.FS(staticContent)))

	// WebSocket — голосовой конвейер (transcribe → chat → tts)
	http.HandleFunc("/ws", handleWS)

	http.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"status":"ok"}`))
	})

	http.HandleFunc("/api/check-key", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if os.Getenv("OPENAI_API_KEY") == "" {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]interface{}{
				"ok":    false,
				"error": "OPENAI_API_KEY не задан. Добавьте ключ в .env и перезапустите сервер.",
			})
			return
		}
		reply, err := callOpenAI("Ответь одним словом: ок", "")
		if err != nil {
			msg := err.Error()
			if e, ok := err.(*openAIError); ok {
				if e.code == 401 {
					msg = "Ключ недействителен или отозван (401)"
				} else if e.code == 429 {
					msg = "Превышена квота / лимит (429). Проверьте баланс на platform.openai.com"
				}
			}
			w.WriteHeader(http.StatusUnauthorized)
			json.NewEncoder(w).Encode(map[string]interface{}{"ok": false, "error": msg})
			return
		}
		if reply == "" {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(map[string]interface{}{"ok": false, "error": "Пустой ответ от OpenAI"})
			return
		}
		json.NewEncoder(w).Encode(map[string]interface{}{"ok": true, "reply": reply})
	})

	// Чат с ChatGPT (с контекстом загруженных текстов)
	http.HandleFunc("/api/chat", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
			return
		}
		var req struct {
			Message string `json:"message"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Message == "" {
			http.Error(w, `{"error":"message required"}`, http.StatusBadRequest)
			return
		}

		ctx := loadTextContext()
		reply, err := callOpenAI(req.Message, ctx)
		if err != nil {
			log.Printf("openai: %v", err)
			msg := err.Error()
			if e, ok := err.(*openAIError); ok && e.code == 401 {
				msg = "Неверный или недействительный ключ OpenAI (401). Проверьте OPENAI_API_KEY в .env"
			} else if e, ok := err.(*openAIError); ok && e.code == 429 {
				msg = "Превышена квота или лимит запросов OpenAI (429). Проверьте баланс на platform.openai.com"
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(map[string]string{"error": msg, "reply": ""})
			return
		}
		if reply == "" {
			reply = "Не удалось получить ответ. Проверьте OPENAI_API_KEY в .env и перезапустите сервер."
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"reply": reply})
	})

	// Транскрипция через Wispr
	http.HandleFunc("/api/transcribe", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
			return
		}
		var req struct {
			Audio string `json:"audio"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Audio == "" {
			http.Error(w, `{"error":"audio (base64) required"}`, http.StatusBadRequest)
			return
		}
		text, err := transcribeWispr(req.Audio)
		if err != nil {
			log.Printf("wispr: %v", err)
			http.Error(w, `{"error":"transcription failed"}`, http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"text": text})
	})

	// TTS — озвучка текста через OpenAI
	http.HandleFunc("/api/tts", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
			return
		}
		var req struct {
			Text string `json:"text"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Text == "" {
			http.Error(w, `{"error":"text required"}`, http.StatusBadRequest)
			return
		}
		audio, err := synthesizeSpeech(req.Text)
		if err != nil {
			log.Printf("tts: %v", err)
			http.Error(w, `{"error":"tts failed"}`, http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "audio/mpeg")
		w.Header().Set("Content-Length", strconv.Itoa(len(audio)))
		w.Write(audio)
	})

	// Загрузка текстовых файлов
	http.HandleFunc("/api/upload-text", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
			return
		}
		r.ParseMultipartForm(10 << 20) // 10 MB
		file, header, err := r.FormFile("file")
		if err != nil {
			http.Error(w, `{"error":"file required"}`, http.StatusBadRequest)
			return
		}
		defer file.Close()

		name := filepath.Base(header.Filename)
		name = strings.ReplaceAll(name, "..", "")
		if name == "" || name == "." {
			name = "document.txt"
		}

		dst, err := os.Create(filepath.Join(textsDir, name))
		if err != nil {
			http.Error(w, `{"error":"cannot save file"}`, http.StatusInternalServerError)
			return
		}
		defer dst.Close()

		if _, err := io.Copy(dst, file); err != nil {
			http.Error(w, `{"error":"cannot write file"}`, http.StatusInternalServerError)
			return
		}

		log.Printf("Загружен текст: %s", name)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"ok": "true", "name": name})
	})

	// Список загруженных текстов
	http.HandleFunc("/api/texts", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			var req struct {
				Name string `json:"name"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Name == "" {
				http.Error(w, `{"error":"name required"}`, http.StatusBadRequest)
				return
			}
			safe := filepath.Base(req.Name)
			path := filepath.Join(textsDir, safe)
			if err := os.Remove(path); err != nil {
				http.Error(w, `{"error":"delete failed"}`, http.StatusInternalServerError)
				return
			}
			log.Printf("Удалён текст: %s", safe)
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]string{"ok": "true"})
			return
		}

		entries, err := os.ReadDir(textsDir)
		if err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"files":[]}`))
			return
		}
		var files []map[string]interface{}
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			info, err := e.Info()
			if err != nil {
				continue
			}
			files = append(files, map[string]interface{}{
				"name": e.Name(),
				"size": info.Size(),
			})
		}
		if files == nil {
			files = []map[string]interface{}{}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"files": files})
	})

	// Проверяем, нужно ли запускать HTTPS
	useHTTPS := os.Getenv("USE_HTTPS") == "true"
	
	if useHTTPS {
		// Генерируем самоподписанный сертификат или загружаем существующий
		cert, err := generateSelfSignedCert()
		if err != nil {
			log.Fatalf("Не удалось создать SSL сертификат: %v", err)
		}

		// Настройка TLS сервера
		server := &http.Server{
			Addr: ":8443",
			TLSConfig: &tls.Config{
				Certificates: []tls.Certificate{cert},
			},
		}

		log.Println("🔒 HTTPS сервер запущен на https://localhost:8443")
		log.Println("📁 SSL сертификаты сохранены в certs/localhost.crt и certs/localhost.key")
		log.Println("⚠️  Это самоподписанный сертификат - браузер покажет предупреждение")
		log.Println("🌐 Откройте: https://localhost:8443")

		if err := server.ListenAndServeTLS("", ""); err != nil {
			log.Fatal(err)
		}
	} else {
		// Запуск обычного HTTP сервера
		addr := ":8080"
		log.Printf("HTTP сервер запущен на http://localhost%s", addr)
		log.Println("💡 Для HTTPS режима установите переменную USE_HTTPS=true в .env")
		if err := http.ListenAndServe(addr, nil); err != nil {
			log.Fatal(err)
		}
	}
}
