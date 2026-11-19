// Package speech is Vera's voice: speech-to-text for what a person says and
// text-to-speech for what she answers, both on Tencent Cloud TokenHub.
//
//	ASR  POST {base}/wand/asrproxy/sync_transcribe  {model, input_url}
//	     → output.text, usage.total_tokens. The audio is fetched by TokenHub
//	     from input_url, so it must be reachable from the internet.
//	TTS  POST {base}/tenlai/ttsproxy/text_to_voice  {model, text, voice_setting,
//	     audio_setting, output_format} → data.audio_url (a signed COS link).
//	     text is at most 300 UTF-8 bytes (≈100 Chinese characters) per call, so
//	     longer text is split at sentence ends, synthesized in parallel, and
//	     the MP3s joined.
package speech

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// MaxChunkBytes is TokenHub's per-call TTS text limit.
const MaxChunkBytes = 300

type Client struct {
	BaseURL  string // e.g. https://tokenhub.tencentmaas.com/v1
	APIKey   string
	ASRModel string // "" = voice input off
	TTSModel string // "" = voice output off
	Voice    int    // TTS voice_id
	HTTP     *http.Client
}

func (c *Client) CanListen() bool { return c != nil && c.ASRModel != "" && c.APIKey != "" }
func (c *Client) CanSpeak() bool  { return c != nil && c.TTSModel != "" && c.APIKey != "" }

func (c *Client) http() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return &http.Client{Timeout: 60 * time.Second}
}

// Transcribe turns the audio at audioURL into text. tokens is what TokenHub
// billed (≈22 per second of audio).
func (c *Client) Transcribe(ctx context.Context, audioURL string) (text string, tokens int, err error) {
	var out struct {
		Status string `json:"status"`
		Output struct {
			Text string `json:"text"`
		} `json:"output"`
		Usage struct {
			TotalTokens int `json:"total_tokens"`
		} `json:"usage"`
	}
	if err := c.post(ctx, "/wand/asrproxy/sync_transcribe", map[string]any{"model": c.ASRModel, "input_url": audioURL}, &out); err != nil {
		return "", 0, err
	}
	if out.Status != "" && out.Status != "completed" {
		return "", out.Usage.TotalTokens, fmt.Errorf("speech recognition %s", out.Status)
	}
	return strings.TrimSpace(out.Output.Text), out.Usage.TotalTokens, nil
}

// Synthesize speaks text as one MP3. Text longer than one call allows is
// split; at most four pieces are synthesized at once (the service allows 5).
func (c *Client) Synthesize(ctx context.Context, text string) ([]byte, error) {
	chunks := Split(text, MaxChunkBytes)
	if len(chunks) == 0 {
		return nil, errors.New("nothing to say")
	}
	parts := make([][]byte, len(chunks))
	errs := make([]error, len(chunks))
	sem := make(chan struct{}, 4)
	var wg sync.WaitGroup
	for i, ch := range chunks {
		wg.Add(1)
		go func(i int, ch string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			parts[i], errs[i] = c.synthesizeOne(ctx, ch)
		}(i, ch)
	}
	wg.Wait()
	for _, e := range errs {
		if e != nil {
			return nil, e
		}
	}
	return JoinMP3(parts), nil
}

func (c *Client) synthesizeOne(ctx context.Context, text string) ([]byte, error) {
	var out struct {
		Status string `json:"status"`
		Data   struct {
			AudioURL string `json:"audio_url"`
		} `json:"data"`
	}
	body := map[string]any{
		"model":         c.TTSModel,
		"text":          text,
		"voice_setting": map[string]any{"voice_id": c.Voice, "speed": 1, "volume": 0},
		"audio_setting": map[string]any{"sample_rate": 16000},
		"output_format": "mp3",
	}
	if err := c.post(ctx, "/tenlai/ttsproxy/text_to_voice", body, &out); err != nil {
		return nil, err
	}
	if out.Data.AudioURL == "" {
		return nil, fmt.Errorf("speech synthesis returned no audio (status %q)", out.Status)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, out.Data.AudioURL, nil)
	if err != nil {
		return nil, err
	}
	res, err := c.http().Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, fmt.Errorf("speech audio download: HTTP %d", res.StatusCode)
	}
	return io.ReadAll(io.LimitReader(res.Body, 8<<20))
}

// post sends a JSON request and decodes the reply. TokenHub reports errors in
// two shapes: {"error":{"message"}} from its gateway and
// {"Response":{"Error":{"Code","Message"}}} from the speech backends.
func (c *Client) post(ctx context.Context, path string, in, out any) error {
	buf, _ := json.Marshal(in)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(c.BaseURL, "/")+path, bytes.NewReader(buf))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.APIKey)
	req.Header.Set("Content-Type", "application/json")
	res, err := c.http().Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	var e struct {
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
		Response *struct {
			Error *struct {
				Code, Message string
			} `json:"Error"`
		} `json:"Response"`
	}
	_ = json.Unmarshal(raw, &e)
	switch {
	case e.Error != nil && e.Error.Message != "":
		return fmt.Errorf("speech service: %s", e.Error.Message)
	case e.Response != nil && e.Response.Error != nil:
		return fmt.Errorf("speech service: %s: %s", e.Response.Error.Code, e.Response.Error.Message)
	case res.StatusCode >= 300:
		return fmt.Errorf("speech service: HTTP %d", res.StatusCode)
	}
	return json.Unmarshal(raw, out)
}

var (
	reSentenceEnd = regexp.MustCompile(`[。！？!?；;\n]+|[.](\s|$)`)
	reMDLink      = regexp.MustCompile(`\[([^\]]*)\]\([^)]*\)`)
	reMDMarks     = regexp.MustCompile("[*_`#>|~]+")
	reMDRule      = regexp.MustCompile(`(?m)^\s*([-*_]\s*){3,}$|^\s*\|?\s*:?-{3,}.*$`)
	reMDBullet    = regexp.MustCompile(`(?m)^\s*(?:[-+]|\d+[.)])\s+`)
	reSpaces      = regexp.MustCompile(`[ \t]+`)
	reBlankLines  = regexp.MustCompile(`\n{2,}`)
)

// Plain turns Vera's Markdown into text worth reading aloud: no symbols,
// links read as their words, table rules and list markers dropped.
func Plain(md string) string {
	s := reMDLink.ReplaceAllString(md, "$1")
	s = reMDRule.ReplaceAllString(s, "")
	s = reMDBullet.ReplaceAllString(s, "")
	s = reMDMarks.ReplaceAllString(s, "")
	s = reSpaces.ReplaceAllString(s, " ")
	s = reBlankLines.ReplaceAllString(s, "\n")
	return strings.TrimSpace(s)
}

// Split cuts text into pieces of at most max UTF-8 bytes, preferring to end
// a piece at the end of a sentence and never cutting a character in half.
func Split(text string, max int) []string {
	text = strings.TrimSpace(text)
	var out []string
	var cur strings.Builder
	flush := func() {
		if t := strings.TrimSpace(cur.String()); t != "" {
			out = append(out, t)
		}
		cur.Reset()
	}
	for _, sent := range sentences(text) {
		if cur.Len()+len(sent) <= max {
			cur.WriteString(sent)
			continue
		}
		flush()
		for len(sent) > max { // one sentence longer than a piece: cut by characters
			cut := max
			for cut > 0 && !utf8.RuneStart(sent[cut]) {
				cut--
			}
			out = append(out, strings.TrimSpace(sent[:cut]))
			sent = sent[cut:]
		}
		cur.WriteString(sent)
	}
	flush()
	return out
}

func sentences(text string) []string {
	var out []string
	last := 0
	for _, m := range reSentenceEnd.FindAllStringIndex(text, -1) {
		out = append(out, text[last:m[1]])
		last = m[1]
	}
	if last < len(text) {
		out = append(out, text[last:])
	}
	return out
}

// JoinMP3 concatenates MP3 files into one stream. MP3 is a sequence of
// self-contained frames, so files of the same format can be joined; each
// file's leading ID3v2 tag is dropped after the first so players do not stop
// at it.
func JoinMP3(parts [][]byte) []byte {
	var out bytes.Buffer
	for i, p := range parts {
		if i > 0 {
			p = stripID3(p)
		}
		out.Write(p)
	}
	return out.Bytes()
}

func stripID3(p []byte) []byte {
	if len(p) < 10 || string(p[:3]) != "ID3" {
		return p
	}
	// Tag size: four 7-bit bytes, plus the 10-byte header (and 10 more if a
	// footer is flagged).
	size := int(p[6])<<21 | int(p[7])<<14 | int(p[8])<<7 | int(p[9])
	end := 10 + size
	if p[5]&0x10 != 0 {
		end += 10
	}
	if end > len(p) {
		return p
	}
	return p[end:]
}
