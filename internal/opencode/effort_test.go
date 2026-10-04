package opencode

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"
)

// fake is an OpenCode server that records each request's path and body.
func fake(t *testing.T, v2 bool) (*server, *[]string) {
	var got []string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		got = append(got, r.URL.Path+" "+string(b))
	}))
	t.Cleanup(ts.Close)
	ready := make(chan struct{})
	close(ready)
	tr := wireTranslator(newTranslator("ses_x", "p/m"))
	if v2 {
		tr = newTranslatorV2("ses_x", "p/m")
	}
	return &server{base: ts.URL, ready: ready, client: ts.Client(), v2: v2, tr: tr, sid: "ses_x", model: "p/m", effort: "high"}, &got
}

// The card's effort is the prompt's variant on v1, and the session model's variant on v2 (#122).
func TestEffortAsVariant(t *testing.T) {
	s, got := fake(t, false)
	if err := s.Send("hi", ""); err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	json.Unmarshal([]byte((*got)[0][len("/session/ses_x/prompt_async "):]), &body)
	if body["variant"] != "high" {
		t.Fatalf("v1 prompt: %s", (*got)[0])
	}

	s, got = fake(t, true)
	s.Send("hi", "")
	s.SetEffort("high") // unchanged: not sent again
	s.Send("again", "")
	want := []string{`/api/session/ses_x/model {"model":{"id":"m","providerID":"p","variant":"high"}}`}
	if len(*got) != 3 || (*got)[0] != want[0] {
		t.Fatalf("v2: %q", *got)
	}
}

func TestVariantKeys(t *testing.T) {
	if k := keys(json.RawMessage(`{"low":{"reasoningEffort":"low"},"xhigh":{},"max":{"a":[1]}}`)); !slices.Equal(k, []string{"low", "xhigh", "max"}) {
		t.Fatal(k)
	}
	if k := keys(nil); k == nil || len(k) != 0 {
		t.Fatal(k)
	}
}
