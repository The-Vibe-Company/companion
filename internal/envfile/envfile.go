package envfile

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
)

func LoadOptional(path string) (map[string]string, error) {
	if path == "" {
		return map[string]string{}, nil
	}
	file, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]string{}, nil
		}
		return nil, err
	}
	defer file.Close()
	return Parse(file)
}

func Parse(reader io.Reader) (map[string]string, error) {
	values := map[string]string{}
	scanner := bufio.NewScanner(reader)
	lineNumber := 0
	for scanner.Scan() {
		lineNumber++
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "export ") {
			line = strings.TrimSpace(strings.TrimPrefix(line, "export "))
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			return nil, fmt.Errorf(".env line %d must look like KEY=value", lineNumber)
		}
		key = strings.TrimSpace(key)
		if key == "" {
			return nil, fmt.Errorf(".env line %d has empty key", lineNumber)
		}
		parsed, err := parseValue(strings.TrimSpace(value))
		if err != nil {
			return nil, fmt.Errorf(".env line %d: %w", lineNumber, err)
		}
		values[key] = parsed
	}
	return values, scanner.Err()
}

func parseValue(value string) (string, error) {
	if value == "" {
		return "", nil
	}
	if strings.HasPrefix(value, `"`) {
		quoted, rest, err := splitQuoted(value, '"')
		if err != nil {
			return "", err
		}
		parsed, err := strconv.Unquote(quoted)
		if err != nil {
			return "", err
		}
		if err := validateQuotedRemainder(rest); err != nil {
			return "", err
		}
		return parsed, nil
	}
	if strings.HasPrefix(value, `'`) {
		quoted, rest, err := splitQuoted(value, '\'')
		if err != nil {
			return "", err
		}
		if err := validateQuotedRemainder(rest); err != nil {
			return "", err
		}
		return quoted[1 : len(quoted)-1], nil
	}
	if index := strings.Index(value, " #"); index >= 0 {
		value = value[:index]
	}
	return strings.TrimSpace(value), nil
}

func splitQuoted(value string, quote byte) (string, string, error) {
	for index := 1; index < len(value); index++ {
		if value[index] != quote {
			continue
		}
		if quote == '"' && isEscaped(value, index) {
			continue
		}
		return value[:index+1], value[index+1:], nil
	}
	return "", "", fmt.Errorf("unterminated quoted value")
}

func isEscaped(value string, index int) bool {
	backslashes := 0
	for cursor := index - 1; cursor >= 0 && value[cursor] == '\\'; cursor-- {
		backslashes++
	}
	return backslashes%2 == 1
}

func validateQuotedRemainder(rest string) error {
	rest = strings.TrimSpace(rest)
	if rest == "" || strings.HasPrefix(rest, "#") {
		return nil
	}
	return fmt.Errorf("unexpected trailing content after quoted value")
}
