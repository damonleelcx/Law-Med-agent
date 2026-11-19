package llm

import "testing"

// Each host has its own switch for turning thinking off; sending the wrong one
// is silently ignored and every reply pays for hidden reasoning tokens.
func TestBodyDisablesThinkingPerHost(t *testing.T) {
	r := Request{Model: "m", Messages: []Message{{Role: "user", Content: "hi"}}}

	hy := New("https://tokenhub.tencentmaas.com/v1", "k").body(r, false)
	if th, ok := hy["thinking"].(map[string]string); !ok || th["type"] != "disabled" {
		t.Fatalf("hunyuan: thinking = %v, want disabled", hy["thinking"])
	}
	if _, ok := hy["enable_thinking"]; ok {
		t.Fatal("hunyuan: enable_thinking should not be sent")
	}

	qw := New("https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", "k").body(r, false)
	if qw["enable_thinking"] != false {
		t.Fatalf("qwen: enable_thinking = %v, want false", qw["enable_thinking"])
	}
	if _, ok := qw["thinking"]; ok {
		t.Fatal("qwen: thinking should not be sent")
	}

	other := New("http://localhost:8090/v1", "k").body(r, false)
	if _, ok := other["thinking"]; ok {
		t.Fatal("other host: thinking should not be sent")
	}
}
