package speech

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"unicode/utf8"
)

func TestSplitKeepsPiecesUnderTheByteLimit(t *testing.T) {
	text := strings.Repeat("房东应当在租赁合同终止后及时退还押金。", 30) + strings.Repeat("没有标点的一长段文字", 40)
	parts := Split(text, MaxChunkBytes)
	if len(parts) < 2 {
		t.Fatalf("expected several pieces, got %d", len(parts))
	}
	var joined strings.Builder
	for _, p := range parts {
		if len(p) > MaxChunkBytes {
			t.Fatalf("piece of %d bytes > %d", len(p), MaxChunkBytes)
		}
		if !utf8.ValidString(p) {
			t.Fatalf("piece cut a character in half: %q", p)
		}
		joined.WriteString(p)
	}
	if joined.String() != strings.ReplaceAll(text, " ", "") {
		t.Fatal("splitting lost or changed text")
	}
	// Sentences that fit stay whole: the first piece ends at a 。.
	if !strings.HasSuffix(parts[0], "。") {
		t.Fatalf("first piece does not end at a sentence: %q", parts[0])
	}
}

func TestPlainReadsMarkdownAsWords(t *testing.T) {
	md := "## 结论\n\n- **押金**应退还；见[《民法典》第七百零三条](https://example.com)。\n\n| 项目 | 金额 |\n|---|---|\n| 押金 | 5000 |\n\n---\n`#fail`"
	got := Plain(md)
	for _, bad := range []string{"#", "*", "[", "](", "|---", "`", "https://"} {
		if strings.Contains(got, bad) {
			t.Fatalf("%q left in %q", bad, got)
		}
	}
	for _, want := range []string{"结论", "押金应退还", "《民法典》第七百零三条", "5000"} {
		if !strings.Contains(got, want) {
			t.Fatalf("%q missing from %q", want, got)
		}
	}
}

func TestJoinMP3DropsLaterID3Tags(t *testing.T) {
	tag := func(body string) []byte {
		n := len(body)
		return append([]byte{'I', 'D', '3', 4, 0, 0, byte(n >> 21 & 0x7f), byte(n >> 14 & 0x7f), byte(n >> 7 & 0x7f), byte(n & 0x7f)}, body...)
	}
	a := append(tag("first-tag"), []byte("AAAA")...)
	b := append(tag("second-tag"), []byte("BBBB")...)
	got := string(JoinMP3([][]byte{a, b}))
	if !strings.HasPrefix(got, string(tag("first-tag"))) || !strings.HasSuffix(got, "AAAABBBB") || strings.Contains(got, "second-tag") {
		t.Fatalf("joined = %q", got)
	}
}

// A fake TokenHub: ASR returns fixed text, TTS returns a link to an "mp3"
// that names the text it was given, and both check model and key.
func fakeHub(t *testing.T) (*httptest.Server, *int32) {
	var tts int32
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/audio" { // a signed COS link: no API key
			if r.Header.Get("Authorization") != "" {
				t.Error("the API key was sent to the audio host")
			}
			w.Write([]byte("[" + r.URL.Query().Get("t") + "]"))
			return
		}
		if r.Header.Get("Authorization") != "Bearer k" {
			w.WriteHeader(401)
			w.Write([]byte(`{"error":{"message":"bad key"}}`))
			return
		}
		var in map[string]any
		_ = json.NewDecoder(r.Body).Decode(&in)
		switch r.URL.Path {
		case "/v1/wand/asrproxy/sync_transcribe":
			if in["model"] != "asr-m" || in["input_url"] != "https://example.com/clip.mp3" {
				t.Errorf("asr request %v", in)
			}
			w.Write([]byte(`{"status":"completed","output":{"text":" 房东不退押金怎么办 "},"usage":{"total_tokens":48}}`))
		case "/v1/tenlai/ttsproxy/text_to_voice":
			atomic.AddInt32(&tts, 1)
			text, _ := in["text"].(string)
			if len(text) > MaxChunkBytes {
				w.Write([]byte(`{"Response":{"Error":{"Code":"InvalidParameterValue","Message":"field 'text' too long"}}}`))
				return
			}
			if v := in["voice_setting"].(map[string]any)["voice_id"]; v != float64(602003) {
				t.Errorf("voice %v", v)
			}
			json.NewEncoder(w).Encode(map[string]any{"status": "completed", "data": map[string]string{"audio_url": srv.URL + "/audio?t=" + url.QueryEscape(text)}})
		default:
			http.NotFound(w, r)
		}
	}))
	return srv, &tts
}

func TestTranscribeAndSynthesize(t *testing.T) {
	srv, calls := fakeHub(t)
	defer srv.Close()
	c := &Client{BaseURL: srv.URL + "/v1", APIKey: "k", ASRModel: "asr-m", TTSModel: "tts-m", Voice: 602003}
	text, tokens, err := c.Transcribe(context.Background(), "https://example.com/clip.mp3")
	if err != nil || text != "房东不退押金怎么办" || tokens != 48 {
		t.Fatalf("transcribe: %q %d %v", text, tokens, err)
	}
	long := strings.Repeat("押金应当退还。", 40) // ≈840 bytes → 3 calls
	mp3, err := c.Synthesize(context.Background(), long)
	if err != nil {
		t.Fatal(err)
	}
	if *calls < 3 {
		t.Fatalf("%d TTS calls for %d bytes", *calls, len(long))
	}
	// The pieces come back in order.
	if got := strings.NewReplacer("[", "", "]", "").Replace(string(mp3)); got != long {
		t.Fatalf("audio out of order: %q", got[:60])
	}
	bad := &Client{BaseURL: srv.URL + "/v1", APIKey: "wrong", ASRModel: "asr-m"}
	if _, _, err := bad.Transcribe(context.Background(), "https://example.com/clip.mp3"); err == nil || !strings.Contains(err.Error(), "bad key") {
		t.Fatalf("error not surfaced: %v", err)
	}
}
