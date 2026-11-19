package tools

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

// On the mainland copy no tool request may leave mainland China: the request
// is refused before anything is sent.
func TestMainlandOnlyRefusesOverseasSources(t *testing.T) {
	var hits atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Write([]byte(`{}`))
	}))
	defer srv.Close()

	MainlandOnly = true
	defer func() { MainlandOnly = false }()

	for _, u := range []string{
		"https://www.courtlistener.com/api/rest/v4/search/?q=x",
		"https://api.fda.gov/drug/label.json",
		"https://rxnav.nlm.nih.gov/REST/rxcui.json",
		"https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi",
		"https://www.law.cornell.edu/uscode/text/42/1983",
		srv.URL,
	} {
		var out map[string]any
		if err := getJSON(context.Background(), nil, u, nil, &out); !errors.Is(err, ErrRegion) {
			t.Errorf("getJSON(%s) = %v, want ErrRegion", u, err)
		}
		if _, err := getText(context.Background(), nil, u); !errors.Is(err, ErrRegion) {
			t.Errorf("getText(%s) = %v, want ErrRegion", u, err)
		}
	}
	if hits.Load() != 0 {
		t.Fatalf("%d requests left the process", hits.Load())
	}

	// Elsewhere nothing changes.
	MainlandOnly = false
	var out map[string]any
	if err := getJSON(context.Background(), nil, srv.URL, nil, &out); err != nil || hits.Load() != 1 {
		t.Fatalf("US copy: err=%v hits=%d", err, hits.Load())
	}
}
