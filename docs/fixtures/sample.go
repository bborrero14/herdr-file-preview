// sample.go — Go highlighting fixture
package main

import (
	"bytes"
	"fmt"
	"os"
)

const limit = 1_000_000

type Source struct {
	Path      string
	Truncated bool
}

func (s *Source) Read() (string, error) {
	data, err := os.ReadFile(s.Path)
	if err != nil {
		return "", err
	}
	if bytes.IndexByte(data, 0) >= 0 {
		return "", fmt.Errorf("binary file: %s", s.Path)
	}
	if len(data) > limit {
		s.Truncated = true
		data = data[:limit]
	}
	return string(data), nil
}

func main() {
	s := &Source{Path: "sample.go"}
	text, err := s.Read()
	fmt.Println(len(text), err)
}
