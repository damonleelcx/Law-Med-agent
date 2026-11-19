package tools

import (
	"strings"
	"testing"
)

// The China copy must never tell anyone to call a US number.
func TestEmergencyTextMainlandHasNoUSNumbers(t *testing.T) {
	MainlandOnly = true
	defer func() { MainlandOnly = false }()
	for _, lang := range []string{"zh", "en"} {
		for _, cat := range []string{"crisis", "cardiac"} {
			for _, paged := range []bool{false, true} {
				got := EmergencyText([]RedFlag{{Category: cat}}, lang, paged)
				for _, bad := range []string{"911", "988", "美国", "US"} {
					if strings.Contains(got, bad) {
						t.Errorf("%s/%s/paged=%v contains %q: %s", lang, cat, paged, bad, got)
					}
				}
				if !strings.Contains(got, "120") {
					t.Errorf("%s/%s: no 120: %s", lang, cat, got)
				}
			}
		}
	}
}

func TestEmergencyTextGlobalKeeps911(t *testing.T) {
	if got := EmergencyText([]RedFlag{{Category: "cardiac"}}, "en", false); !strings.Contains(got, "911") {
		t.Fatalf("global text lost 911: %s", got)
	}
}
