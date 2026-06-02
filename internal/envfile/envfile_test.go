package envfile

import (
	"strings"
	"testing"
)

func TestParseEnvFile(t *testing.T) {
	values, err := Parse(strings.NewReader(`
# comment
API_SERVER_KEY=plain
export OPENROUTER_API_KEY='single quoted'
WEBUI_SECRET_KEY="double quoted" # trailing quoted comment
COMMENTED_VALUE=value # trailing comment
ESCAPED_VALUE="double \"quoted\""
EMPTY=
`))
	if err != nil {
		t.Fatalf("parse env file: %v", err)
	}
	expected := map[string]string{
		"API_SERVER_KEY":     "plain",
		"OPENROUTER_API_KEY": "single quoted",
		"WEBUI_SECRET_KEY":   "double quoted",
		"COMMENTED_VALUE":    "value",
		"ESCAPED_VALUE":      "double \"quoted\"",
		"EMPTY":              "",
	}
	for key, value := range expected {
		if values[key] != value {
			t.Fatalf("%s = %q, want %q", key, values[key], value)
		}
	}
}

func TestParseEnvFileRejectsInvalidLines(t *testing.T) {
	if _, err := Parse(strings.NewReader("API_SERVER_KEY\n")); err == nil {
		t.Fatalf("expected invalid line error")
	}
}
