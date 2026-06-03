package importer

import (
	"fmt"
	"regexp"
	"strings"
)

var addressPartPattern = regexp.MustCompile(`^[a-z][a-z0-9_-]*$`)

type Address struct {
	Raw   string
	Type  string
	Group string
	Name  string
}

func ParseAddress(raw string) (Address, error) {
	raw = strings.TrimSpace(raw)
	parts := strings.Split(raw, ".")
	if len(parts) != 2 && len(parts) != 3 {
		return Address{}, fmt.Errorf("resource address must look like fly_app.agent.victor or openwebui_config.main")
	}
	for _, part := range parts {
		if !addressPartPattern.MatchString(part) {
			return Address{}, fmt.Errorf("resource address part %q must use lowercase letters, numbers, dashes, or underscores", part)
		}
	}
	if len(parts) == 2 {
		return Address{Raw: raw, Type: parts[0], Name: parts[1]}, nil
	}
	return Address{Raw: raw, Type: parts[0], Group: parts[1], Name: parts[2]}, nil
}

func ParseAttrs(values []string) (map[string]string, error) {
	attrs := map[string]string{}
	for _, value := range values {
		key, attrValue, ok := strings.Cut(value, "=")
		key = strings.TrimSpace(key)
		if !ok || key == "" {
			return nil, fmt.Errorf("attribute must look like key=value")
		}
		attrs[key] = attrValue
	}
	return attrs, nil
}

func FormatAddress(resourceType, group, name string) string {
	if group == "" {
		return resourceType + "." + name
	}
	return resourceType + "." + group + "." + name
}
