package httpapi

import (
	"strings"
	"testing"
)

const testShell = `<!doctype html>
<html lang="en">
  <head>
    <title>ACT · Vera — counsel & care</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Inter&display=swap" rel="stylesheet" />
    <link rel="icon" type="image/png" href="/favicon.png" />
  </head>
  <body><div id="root"></div></body>
</html>`

func TestShellMainlandCopy(t *testing.T) {
	us := (&Server{}).shell([]byte(testShell))
	if string(us) != testShell {
		t.Fatal("the US copy's shell must be served unchanged")
	}

	cn := string((&Server{Region: "cn", ICPBeian: `浙ICP备12345678号-1 <x>`, ICPLicence: "苏B2-20262623"}).shell([]byte(testShell)))
	if !strings.Contains(cn, `<meta name="act-icp-licence" content="苏B2-20262623" />`) {
		t.Errorf("cn shell lacks the licence meta:\n%s", cn)
	}
	for _, bad := range []string{"googleapis", "gstatic", `lang="en"`, "<x>"} {
		if strings.Contains(cn, bad) {
			t.Errorf("cn shell still contains %q:\n%s", bad, cn)
		}
	}
	for _, want := range []string{`<html lang="zh-CN">`, `<meta name="act-region" content="cn" />`,
		`<meta name="act-icp" content="浙ICP备12345678号-1 &lt;x&gt;" />`, "维拉", `href="/favicon.png"`} {
		if !strings.Contains(cn, want) {
			t.Errorf("cn shell lacks %q:\n%s", want, cn)
		}
	}
	// No ICP number configured yet: no empty meta tag.
	if strings.Contains(string((&Server{Region: "cn"}).shell([]byte(testShell))), "act-icp") {
		t.Error("empty ICP number should not be emitted")
	}
}
