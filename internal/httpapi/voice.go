package httpapi

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/damonleelcx/Law-Med-agent/internal/auth"
	"github.com/damonleelcx/Law-Med-agent/internal/engine"
	"github.com/damonleelcx/Law-Med-agent/internal/speech"
)

// Voice: a person holds the mic button and speaks; the recording becomes text
// in the message box (they read it, then send). Vera's replies can be read
// aloud. Both run on TokenHub (internal/speech).
//
// Speech recognition fetches the audio from a URL, so a recording is kept in
// memory for a few minutes under an unguessable name and served at
// /api/voice/clip/{name} to TokenHub, then dropped. Nothing is written to disk
// or to the database.

const (
	maxClipBytes  = 2 << 20 // 60 s of 48 kbps MP3 is ~360 KB
	clipTTL       = 5 * time.Minute
	maxSpeakRunes = 1200 // ≈12 TTS calls; longer replies are read up to here
)

type clip struct {
	data []byte
	ct   string
	exp  time.Time
}

type clipStore struct {
	mu sync.Mutex
	m  map[string]clip
}

func (c *clipStore) put(data []byte, ct, ext string) string {
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	name := hex.EncodeToString(b) + ext
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.m == nil {
		c.m = map[string]clip{}
	}
	now := time.Now()
	for k, v := range c.m {
		if now.After(v.exp) {
			delete(c.m, k)
		}
	}
	c.m[name] = clip{data: data, ct: ct, exp: now.Add(clipTTL)}
	return name
}

func (c *clipStore) get(name string) (clip, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	v, ok := c.m[name]
	if !ok || time.Now().After(v.exp) {
		return clip{}, false
	}
	return v, true
}

func (c *clipStore) drop(name string) {
	c.mu.Lock()
	delete(c.m, name)
	c.mu.Unlock()
}

// speechCache keeps the last few synthesized replies, so replaying one (or a
// second tap) does not pay again.
type speechCache struct {
	mu    sync.Mutex
	order []int64
	m     map[int64][]byte
}

const speechCacheSize = 32

func (c *speechCache) get(id int64) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	b, ok := c.m[id]
	return b, ok
}

func (c *speechCache) put(id int64, b []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.m == nil {
		c.m = map[int64][]byte{}
	}
	if _, ok := c.m[id]; !ok {
		c.order = append(c.order, id)
	}
	c.m[id] = b
	for len(c.order) > speechCacheSize {
		delete(c.m, c.order[0])
		c.order = c.order[1:]
	}
}

// audioKind recognises the formats the mini program's recorder produces.
func audioKind(b []byte) (ct, ext string, ok bool) {
	switch {
	case len(b) >= 3 && string(b[:3]) == "ID3", len(b) >= 2 && b[0] == 0xFF && b[1]&0xE6 == 0xE2: // MP3 (tag or MPEG-1/2 layer III frame)
		return "audio/mpeg", ".mp3", true
	case len(b) >= 2 && b[0] == 0xFF && b[1]&0xF6 == 0xF0: // AAC ADTS
		return "audio/aac", ".aac", true
	case len(b) >= 12 && string(b[4:8]) == "ftyp": // M4A
		return "audio/mp4", ".m4a", true
	case len(b) >= 12 && string(b[:4]) == "RIFF" && string(b[8:12]) == "WAVE":
		return "audio/wav", ".wav", true
	}
	return "", "", false
}

// budgetErr answers 429 when the account or the service has used its daily
// allowance, the same limit chat obeys.
func budgetErr(w http.ResponseWriter, err error) bool {
	var b *engine.ErrBudget
	if errors.As(err, &b) {
		writeErr(w, 429, b.Reason)
		return true
	}
	return false
}

func (s *Server) voiceFeatures() map[string]bool {
	return map[string]bool{"input": s.Speech.CanListen() && s.PublicOrigin != "", "output": s.Speech.CanSpeak()}
}

func (s *Server) model() *engine.Model {
	if s.Agent != nil && s.Agent.Model != nil {
		return s.Agent.Model
	}
	return nil
}

// POST /api/voice/transcribe (multipart "file") → {"text": "..."}
func (s *Server) transcribe(w http.ResponseWriter, r *http.Request, u *auth.User) {
	if !s.voiceFeatures()["input"] {
		writeErr(w, 404, "voice input is not available")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxClipBytes+64<<10)
	if err := r.ParseMultipartForm(maxClipBytes + 64<<10); err != nil {
		writeErr(w, 400, "recording too large (60 seconds max)")
		return
	}
	f, _, err := r.FormFile("file")
	if err != nil {
		writeErr(w, 400, "no recording")
		return
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxClipBytes+1))
	if err != nil || len(data) == 0 {
		writeErr(w, 400, "could not read the recording")
		return
	}
	if len(data) > maxClipBytes {
		writeErr(w, 400, "recording too large (60 seconds max)")
		return
	}
	ct, ext, ok := audioKind(data)
	if !ok {
		writeErr(w, 400, "unsupported audio format")
		return
	}
	name := s.clips.put(data, ct, ext)
	defer s.clips.drop(name)
	url := strings.TrimRight(s.PublicOrigin, "/") + "/api/voice/clip/" + name
	var text string
	call := func() (int, error) {
		t, n, err := s.Speech.Transcribe(r.Context(), url)
		text = t
		return n, err
	}
	meta := engine.CallMeta{Purpose: "voice-in", UserID: u.ID}
	if m := s.model(); m != nil {
		err = m.Metered(r.Context(), meta, s.Speech.ASRModel, call)
	} else {
		_, err = call()
	}
	if budgetErr(w, err) {
		return
	}
	if err != nil {
		slog.Error("transcribe", "err", err)
		writeErr(w, 502, "could not recognise the recording; please try again")
		return
	}
	writeJSON(w, 200, map[string]string{"text": text})
}

// GET /api/voice/clip/{name}: the recording, for the speech service to fetch.
// Unauthenticated by necessity; the name is 192 random bits and lives minutes.
func (s *Server) voiceClip(w http.ResponseWriter, r *http.Request) {
	c, ok := s.clips.get(r.PathValue("name"))
	if !ok {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", c.ct)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Length", strconv.Itoa(len(c.data)))
	w.Write(c.data)
}

// GET /api/messages/{id}/speech → audio/mpeg: one of Vera's replies, read
// aloud. Only the owner of the conversation can ask for it.
func (s *Server) speak(w http.ResponseWriter, r *http.Request, u *auth.User) {
	if !s.Speech.CanSpeak() {
		writeErr(w, 404, "voice replies are not available")
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeErr(w, 404, "not found")
		return
	}
	var content string
	err = s.Pool.QueryRow(r.Context(), `SELECT m.content FROM messages m JOIN conversations c ON c.id = m.conversation_id
		WHERE m.id = $1 AND c.user_id = $2 AND m.role IN ('assistant','event')`, id, u.ID).Scan(&content)
	if err != nil {
		writeErr(w, 404, "not found")
		return
	}
	audio, ok := s.speechCache.get(id)
	if !ok {
		text := speech.Plain(content)
		if utf8.RuneCountInString(text) > maxSpeakRunes {
			text = string([]rune(text)[:maxSpeakRunes])
		}
		if strings.TrimSpace(text) == "" {
			writeErr(w, 400, "nothing to read")
			return
		}
		call := func() (int, error) {
			b, err := s.Speech.Synthesize(r.Context(), text)
			audio = b
			// TokenHub reports no usage for speech synthesis; count one token
			// per character, a conservative stand-in for the daily budgets.
			return utf8.RuneCountInString(text), err
		}
		meta := engine.CallMeta{Purpose: "voice-out", UserID: u.ID}
		if m := s.model(); m != nil {
			err = m.Metered(r.Context(), meta, s.Speech.TTSModel, call)
		} else {
			_, err = call()
		}
		if budgetErr(w, err) {
			return
		}
		if err != nil {
			slog.Error("speak", "message", id, "err", err)
			writeErr(w, 502, "could not read this reply aloud; please try again")
			return
		}
		s.speechCache.put(id, audio)
	}
	w.Header().Set("Content-Type", "audio/mpeg")
	w.Header().Set("Cache-Control", "private, max-age=3600")
	http.ServeContent(w, r, "reply.mp3", time.Time{}, bytes.NewReader(audio))
}
