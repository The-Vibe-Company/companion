package importer

import (
	"fmt"
	"regexp"
	"strings"
)

var (
	resourceTypePattern = regexp.MustCompile(`^[a-z][a-z0-9_-]*$`)
	resourceIDPattern   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:-]*$`)
)

type Address struct {
	Raw       string
	Type      string
	Provider  string
	Kind      string
	DesiredID string
}

func ParseAddress(raw string) (Address, error) {
	raw = strings.TrimSpace(raw)
	resourceType, desiredID, ok := strings.Cut(raw, ".")
	if !ok || resourceType == "" || desiredID == "" {
		return Address{}, fmt.Errorf("resource address must look like fly_app.companion-test")
	}
	provider, kind, ok := strings.Cut(resourceType, "_")
	if !ok || provider == "" || kind == "" {
		return Address{}, fmt.Errorf("resource type must look like provider_kind")
	}
	if !resourceTypePattern.MatchString(resourceType) {
		return Address{}, fmt.Errorf("resource type %q must use lowercase letters, numbers, dashes, or underscores", resourceType)
	}
	if !resourceIDPattern.MatchString(desiredID) {
		return Address{}, fmt.Errorf("desired id %q must use letters, numbers, dashes, underscores, dots, or colons", desiredID)
	}
	return Address{
		Raw:       raw,
		Type:      resourceType,
		Provider:  provider,
		Kind:      kind,
		DesiredID: desiredID,
	}, nil
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

func FormatAddress(provider, kind, desiredID string) string {
	return provider + "_" + kind + "." + desiredID
}
