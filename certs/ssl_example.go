package main

import (
	"fmt"
	"log"
	"net/http"
)

func main() {
	// Создаем простой обработчик
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "SSL сервер работает! 🔒")
	})

	fmt.Println("HTTPS сервер запущен на https://localhost:8443")
	fmt.Println("Для доступа к сайту через HTTPS откройте: https://localhost:8443")
	
	// Запуск HTTPS сервера с сертификатом
	// Если у вас есть .crt и .key файлы:
	// log.Fatal(http.ListenAndServeTLS(":8443", "certs/localhost.crt", "certs/localhost.key", nil))
	
	// Пока используем HTTP (нужно добавить извлечение ключа из PFX)
	log.Fatal(http.ListenAndServe(":8443", nil))
}