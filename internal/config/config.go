// Package config reads every knob the process has from the environment. There
// is no config file: a deployment should be readable from its manifest alone.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Addr         string
	DatabaseURL  string
	PublicOrigin string // absolute origin every emailed link is built against
	SessionTTL   time.Duration
	CookieSecure bool

	LLMBaseURL   string
	LLMAPIKey    string
	LLMModel     string // reasoning, drafting, planning
	LLMFastModel string // routing, judging, summarising

	// Voice (TokenHub). An empty model turns that direction off.
	SpeechBaseURL string
	ASRModel      string
	TTSModel      string
	TTSVoice      int

	SMTPHost    string
	SMTPPort    int
	SMTPUser    string
	SMTPPass    string
	SMTPFrom    string
	SMTPReplyTo string

	// AdminEmails may verify professional licences. Comma separated.
	AdminEmails []string

	WorkerCount   int
	LeaseDuration time.Duration

	// Spending ceilings in tokens. Per-goal limits live on the goal; these
	// bound a whole account and the whole deployment per UTC day.
	AccountDailyTokens    int
	DeploymentDailyTokens int

	// CourtListenerToken is optional; the anonymous API is rate limited but works.
	CourtListenerToken string

	// WeChat mini program. AppID + AppSecret turn on WeChat sign-in; OfferID
	// + PayAppKey turn on virtual payment, and with it 1 stamp per message
	// for WeChat accounts. PayEnv 0 is production, 1 the sandbox.
	WXAppID     string
	WXAppSecret string
	WXOfferID   string
	WXPayAppKey string
	WXPayEnv    int
	// WXAPIBase is api.weixin.qq.com unless pointed at a stand-in for local
	// testing (cmd/devmock).
	WXAPIBase string

	// Region "cn" is the mainland China copy (vera.zhiyuwujie.top): the site
	// opens in Chinese, loads no Google Fonts (blocked there), and shows the
	// ICP filing number in its footer, as mainland rules require.
	Region     string
	ICPBeian   string // the domain's filing number, e.g. 苏ICP备XXXXXXXX号-1
	ICPLicence string // the telecom operating licence, e.g. 苏B2-20262623
}

// China reports whether this is the mainland copy.
func (c Config) China() bool { return c.Region == "cn" }

func Load() (Config, error) {
	c := Config{
		Addr:                  env("ACT_ADDR", ":8080"),
		DatabaseURL:           os.Getenv("ACT_DATABASE_URL"),
		PublicOrigin:          strings.TrimRight(os.Getenv("ACT_PUBLIC_ORIGIN"), "/"),
		SessionTTL:            envDur("ACT_SESSION_TTL", 30*24*time.Hour),
		CookieSecure:          envBool("ACT_COOKIE_SECURE", true),
		LLMBaseURL:            env("ACT_LLM_BASE_URL", "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"),
		LLMAPIKey:             os.Getenv("ACT_LLM_API_KEY"),
		LLMModel:              env("ACT_LLM_MODEL", "qwen3.8-max"),
		LLMFastModel:          env("ACT_LLM_FAST_MODEL", "qwen3.8-flash"),
		ASRModel:              strings.TrimSpace(os.Getenv("ACT_ASR_MODEL")),
		TTSModel:              strings.TrimSpace(os.Getenv("ACT_TTS_MODEL")),
		TTSVoice:              envInt("ACT_TTS_VOICE", 603002), // 软萌心心
		SMTPHost:              os.Getenv("ACT_SMTP_HOST"),
		SMTPPort:              envInt("ACT_SMTP_PORT", 587),
		SMTPUser:              os.Getenv("ACT_SMTP_USERNAME"),
		SMTPPass:              os.Getenv("ACT_SMTP_PASSWORD"),
		SMTPFrom:              os.Getenv("ACT_SMTP_FROM"),
		SMTPReplyTo:           os.Getenv("ACT_SMTP_REPLY_TO"),
		WorkerCount:           envInt("ACT_WORKERS", 2),
		LeaseDuration:         envDur("ACT_LEASE", 90*time.Second),
		AccountDailyTokens:    envInt("ACT_ACCOUNT_DAILY_TOKENS", 1_500_000),
		DeploymentDailyTokens: envInt("ACT_DEPLOYMENT_DAILY_TOKENS", 40_000_000),
		CourtListenerToken:    os.Getenv("ACT_COURTLISTENER_TOKEN"),
		WXAppID:               os.Getenv("ACT_WX_APPID"),
		WXAppSecret:           os.Getenv("ACT_WX_APPSECRET"),
		WXOfferID:             os.Getenv("ACT_WX_OFFER_ID"),
		WXPayAppKey:           os.Getenv("ACT_WX_PAY_APPKEY"),
		WXPayEnv:              envInt("ACT_WX_PAY_ENV", 0),
		WXAPIBase:             strings.TrimRight(env("ACT_WX_API_BASE", "https://api.weixin.qq.com"), "/"),
		Region:                strings.ToLower(strings.TrimSpace(os.Getenv("ACT_REGION"))),
		ICPBeian:              strings.TrimSpace(os.Getenv("ACT_ICP_BEIAN")),
		ICPLicence:            strings.TrimSpace(os.Getenv("ACT_ICP_LICENCE")),
	}
	for _, e := range strings.Split(os.Getenv("ACT_ADMIN_EMAILS"), ",") {
		if e = strings.ToLower(strings.TrimSpace(e)); e != "" {
			c.AdminEmails = append(c.AdminEmails, e)
		}
	}
	// The relay only lets a login send as its own address (spoof protection),
	// so the login IS the From address unless one is set explicitly.
	if c.SMTPFrom == "" {
		c.SMTPFrom = c.SMTPUser
	}
	// Speech runs on the same TokenHub endpoint and key as the chat model
	// unless told otherwise.
	c.SpeechBaseURL = strings.TrimRight(env("ACT_SPEECH_BASE_URL", c.LLMBaseURL), "/")
	if c.DatabaseURL == "" {
		return c, fmt.Errorf("ACT_DATABASE_URL is required")
	}
	return c, nil
}

// MailEnabled is false unless every piece a real message needs is present. A
// half-configured relay would fail per message; this fails once, at startup.
func (c Config) MailEnabled() bool {
	return c.SMTPHost != "" && c.SMTPUser != "" && c.SMTPPass != "" && c.SMTPFrom != "" && c.PublicOrigin != ""
}

func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func envInt(k string, d int) int {
	if v, err := strconv.Atoi(os.Getenv(k)); err == nil {
		return v
	}
	return d
}

func envBool(k string, d bool) bool {
	if v, err := strconv.ParseBool(os.Getenv(k)); err == nil {
		return v
	}
	return d
}

func envDur(k string, d time.Duration) time.Duration {
	if v, err := time.ParseDuration(os.Getenv(k)); err == nil {
		return v
	}
	return d
}
