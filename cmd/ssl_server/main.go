package main

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"embed"
	"encoding/pem"
	"io/fs"
	"log"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/joho/godotenv"
)

//go:embed static/*
var staticFS embed.FS

const textsDir = "data/texts"
const maxContextLen = 30000

// Импортируем функции из основного сервера
// Для простоты - дублируем необходимые функции

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

// Генерируем самоподписанный сертификат
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
	certOut, err := os.Create("certs/server.crt")
	if err == nil {
		pem.Encode(certOut, &pem.Block{Type: "CERTIFICATE", Bytes: certDER})
		certOut.Close()
	}

	// Сохраняем ключ в файл для информации  
	keyOut, err := os.Create("certs/server.key")
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

func main() {
	if err := godotenv.Load(); err != nil {
		log.Printf("Загрузка .env: %v (работаем без .env)", err)
	}

	if err := os.MkdirAll(textsDir, 0755); err != nil {
		log.Printf("Не удалось создать директорию %s: %v", textsDir, err)
	}

	// Настройка статических файлов
	staticContent, err := fs.Sub(staticFS, "static")
	if err != nil {
		log.Fatal(err)
	}
	http.Handle("/", http.FileServer(http.FS(staticContent)))

	// API endpoints (упрощенные версии)
	http.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"status":"ok","ssl":true}`))
	})

	http.HandleFunc("/api/ssl-test", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"message":"SSL сервер работает! 🔒✅","protocol":"` + r.Proto + `"}`))
	})

	// Генерируем самоподписанный сертификат
	cert, err := generateSelfSignedCert()
	if err != nil {
		log.Fatalf("Не удалось создать сертификат: %v", err)
	}

	// Настройка TLS сервера
	server := &http.Server{
		Addr: ":8443",
		TLSConfig: &tls.Config{
			Certificates: []tls.Certificate{cert},
		},
	}

	log.Println("🔒 HTTPS сервер запущен на https://localhost:8443")
	log.Println("📁 Сертификаты сохранены в certs/server.crt и certs/server.key")
	log.Println("⚠️  Это самоподписанный сертификат - браузер покажет предупреждение")
	log.Println("🌐 Откройте: https://localhost:8443")

	if err := server.ListenAndServeTLS("", ""); err != nil {
		log.Fatal(err)
	}
}