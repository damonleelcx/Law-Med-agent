package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	neturl "net/url"
	"regexp"
	"strings"
)

const userAgent = "ACT-Vera/1.0 (+https://act.heros-agent.space)"

// MainlandOnly is set on the mainland China copy (ACT_REGION=cn). Its privacy
// policy lists only mainland providers, so no tool may send a query to a
// service outside mainland China: every public source the tools use today
// (CourtListener, openFDA, NLM, PubMed, Cornell LII) is in the United States.
// The tool fails with a plain reason and Vera answers without it.
var MainlandOnly bool

// ErrRegion is what a tool returns for a source the region may not use.
var ErrRegion = fmt.Errorf("这项检索使用中国大陆以外的服务，维拉的中国版不会把你的信息发送到境外，因此不可用 (source outside mainland China is disabled in this region)")

func allowed(raw string) error {
	if !MainlandOnly {
		return nil
	}
	u, err := neturl.Parse(raw)
	if err != nil {
		return ErrRegion
	}
	h := strings.ToLower(u.Hostname())
	for _, suffix := range mainlandHosts {
		if h == suffix || strings.HasSuffix(h, "."+suffix) {
			return nil
		}
	}
	return ErrRegion
}

// mainlandHosts may be reached from the China copy. None of today's tools
// needs one; add a mainland source here when a tool gains one.
var mainlandHosts = []string{}

// getJSON fetches and decodes, classifying 429/5xx/network failures as
// transient so the contract's retry policy applies to them and only them.
func getJSON(ctx context.Context, env *Env, url string, headers map[string]string, out any) error {
	if err := allowed(url); err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := client(env).Do(req)
	if err != nil {
		return &Transient{err}
	}
	defer res.Body.Close()
	if res.StatusCode == 404 {
		return errNotFound
	}
	if res.StatusCode == 429 || res.StatusCode >= 500 {
		return &Transient{fmt.Errorf("%s: HTTP %d", url, res.StatusCode)}
	}
	if res.StatusCode >= 300 {
		b, _ := io.ReadAll(io.LimitReader(res.Body, 512))
		return fmt.Errorf("%s: HTTP %d %s", url, res.StatusCode, b)
	}
	return json.NewDecoder(io.LimitReader(res.Body, 8<<20)).Decode(out)
}

func getText(ctx context.Context, env *Env, url string) (string, error) {
	if err := allowed(url); err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", userAgent)
	res, err := client(env).Do(req)
	if err != nil {
		return "", &Transient{err}
	}
	defer res.Body.Close()
	if res.StatusCode == 404 {
		return "", errNotFound
	}
	if res.StatusCode == 429 || res.StatusCode >= 500 {
		return "", &Transient{fmt.Errorf("HTTP %d", res.StatusCode)}
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	return string(b), err
}

var errNotFound = fmt.Errorf("not found")

func client(env *Env) *http.Client {
	if env != nil && env.HTTP != nil {
		return env.HTTP
	}
	return http.DefaultClient
}

var (
	reScript = regexp.MustCompile(`(?is)<(script|style|nav|header|footer)[^>]*>.*?</(script|style|nav|header|footer)>`)
	reTag    = regexp.MustCompile(`(?s)<[^>]+>`)
	reSpace  = regexp.MustCompile(`[ \t]+`)
	reLines  = regexp.MustCompile(`\n\s*\n+`)
)

func htmlToText(s string) string {
	s = reScript.ReplaceAllString(s, " ")
	s = strings.NewReplacer("<br>", "\n", "<br/>", "\n", "</p>", "\n", "</div>", "\n", "</li>", "\n").Replace(s)
	s = reTag.ReplaceAllString(s, " ")
	s = strings.NewReplacer("&nbsp;", " ", "&amp;", "&", "&lt;", "<", "&gt;", ">", "&quot;", `"`, "&#39;", "'", "&sect;", "§").Replace(s)
	s = reSpace.ReplaceAllString(s, " ")
	s = reLines.ReplaceAllString(s, "\n\n")
	return strings.TrimSpace(s)
}
