package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	dbxpluginsdk "github.com/lwai/mdnotes/dbxsdk"
)

func callRaw(t *testing.T, method string, params any) (any, *dbxpluginsdk.PluginError) {
	t.Helper()
	raw, err := json.Marshal(params)
	if err != nil {
		t.Fatalf("marshal params: %v", err)
	}
	return (&plugin{}).Handle(dbxpluginsdk.RequestContext{}, method, raw, nil)
}

// connectParams Construct the shape of the host ' s real downtime life cycle parameters:
// {provider:{...}, connection:{external_config:{...}, connection_secrets:{...}}, runtime:{...}}
func connectParams(dir string, ai map[string]any, key string) map[string]any {
	ec := map[string]any{"storage_dir": dir}
	for k, v := range ai {
		ec[k] = v
	}
	conn := map[string]any{"id": "c-ai", "name": "MD Notes", "external_config": ec}
	if key != "" {
		conn["connection_secrets"] = map[string]any{"ai_api_key": key}
	}
	return map[string]any{"provider": map[string]any{"id": "com.lwai.mdnotes.conn"}, "connection": conn,
		"connectionId": "c-ai", "runtime": map[string]any{"host": "127.0.0.1", "port": 0}}
}

func enableAI(t *testing.T, base, model, provider, key string, extra map[string]any) {
	t.Helper()
	resetAIConfig()
	ai := map[string]any{"ai_enabled": true, "ai_provider": provider, "ai_base_url": base, "ai_model": model}
	for k, v := range extra {
		ai[k] = v
	}
	absorbAIConfig(map[string]any{"connection": map[string]any{
		"external_config":    ai,
		"connection_secrets": map[string]any{"ai_api_key": key},
	}})
}

func fakeModel(t *testing.T, status int, body string, seen *http.Request, seenBody *string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if seen != nil {
			*seen = *r
		}
		if seenBody != nil {
			b, _ := io.ReadAll(r.Body)
			*seenBody = string(b)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}))
	t.Cleanup(srv.Close)
	return srv
}

const openAIJSON = `{"model":"fake-1","choices":[{"message":{"content":"Text after colour"}}],` +
	`"usage":{"prompt_tokens":12,"completion_tokens":7}}`

func TestAIChatOpenAICompatible(t *testing.T) {
	var gotReq http.Request
	var gotBody string
	srv := fakeModel(t, 200, openAIJSON, &gotReq, &gotBody)
	enableAI(t, srv.URL+"/v1", "fake-1", "openai", "sk-secret-1234567890", nil)

	res, perr := callRaw(t, "ai/chat", map[string]any{"task": "polish", "text": "Original", "instruction": "It's simpler."})
	if perr != nil {
		t.Fatalf("ai/chat Failed:%s", perr.Message)
	}
	out := res.(map[string]any)
	if out["content"] != "Text after colour" {
		t.Fatalf("Text is wrong:%v", out["content"])
	}
	if gotReq.URL.Path != "/v1/chat/completions" {
		t.Fatalf("Other Organiser%s", gotReq.URL.Path)
	}
	if gotReq.Header.Get("Authorization") != "Bearer sk-secret-1234567890" {
		t.Fatalf("It's wrong.%q", gotReq.Header.Get("Authorization"))
	}
	if !strings.Contains(gotBody, "Polish") || !strings.Contains(gotBody, "It's simpler.") {
		t.Fatalf("The message does not include tasks and additional requirements:%s", gotBody)
	}
	usage := out["usage"].(map[string]any)
	if usage["promptTokens"] != 12 || usage["completionTokens"] != 7 {
		t.Fatalf("usage Other Organiser%v", usage)
	}
}

func TestAIChatAnthropic(t *testing.T) {
	var gotReq http.Request
	srv := fakeModel(t, 200, `{"model":"claude-x","content":[{"type":"text","text":"Analysis"}],`+
		`"usage":{"input_tokens":3,"output_tokens":4}}`, &gotReq, nil)
	enableAI(t, srv.URL, "claude-x", "anthropic", "sk-ant-1234567890", nil)

	res, perr := callRaw(t, "ai/chat", map[string]any{"task": "analyze", "text": "note body"})
	if perr != nil {
		t.Fatalf("ai/chat Failed:%s", perr.Message)
	}
	if res.(map[string]any)["content"] != "Analysis" {
		t.Fatalf("Text is wrong:%v", res)
	}
	if gotReq.URL.Path != "/v1/messages" {
		t.Fatalf("Other Organiser%s", gotReq.URL.Path)
	}
	if gotReq.Header.Get("x-api-key") == "" || gotReq.Header.Get("anthropic-version") == "" {
		t.Fatalf("Anthropic Required head missing:%v", gotReq.Header)
	}
}

// In case of failure, you must give a readable Chinese.**Could not close temporary folder: %s**。
func TestAIChatAuthErrorRedactsKey(t *testing.T) {
	const key = "sk-super-secret-value-9999"
	srv := fakeModel(t, 401, `{"error":{"message":"invalid api key sk-super-secret-value-9999"}}`, nil, nil)
	enableAI(t, srv.URL+"/v1", "fake-1", "openai", key, nil)

	_, perr := callRaw(t, "ai/chat", map[string]any{"task": "analyze", "text": "note body"})
	if perr == nil {
		t.Fatalf("401 You should have.")
	}
	if !strings.Contains(perr.Message, "Authentication failed") {
		t.Fatalf("The error message is not readable:%s", perr.Message)
	}
	if strings.Contains(perr.Message, key) {
		t.Fatalf("Error message leaked key:%s", perr.Message)
	}
}

func TestAIChatRejectsNonJSON(t *testing.T) {
	srv := fakeModel(t, 200, "<html>gateway error</html>", nil, nil)
	enableAI(t, srv.URL+"/v1", "fake-1", "openai", "sk-1234567890", nil)
	_, perr := callRaw(t, "ai/chat", map[string]any{"task": "analyze", "text": "note body"})
	if perr == nil || !strings.Contains(perr.Message, "Could not parse") {
		t.Fatalf("Not JSON Readable errors should be given, in fact:%v", perr)
	}
}

func TestAIChatTruncatesLongText(t *testing.T) {
	var gotBody string
	srv := fakeModel(t, 200, openAIJSON, nil, &gotBody)
	enableAI(t, srv.URL+"/v1", "fake-1", "openai", "sk-1234567890", map[string]any{"ai_max_chars": 500})

	long := strings.Repeat("Word", 1200)
	res, perr := callRaw(t, "ai/chat", map[string]any{"task": "analyze", "text": long})
	if perr != nil {
		t.Fatalf("ai/chat Failed:%s", perr.Message)
	}
	out := res.(map[string]any)
	if out["truncated"] != true {
		t.Fatalf("It should be marked out:%v", out)
	}
	if int(out["sentChars"].(int)) != 500 {
		t.Fatalf("Sending should be intercepted. 500 Character:%v", out["sentChars"])
	}
	if strings.Contains(gotBody, strings.Repeat("Word", 1000)) {
		t.Fatalf("The super-long text was not cut off.")
	}
}

func TestAIChatRejectsUnknownTask(t *testing.T) {
	enableAI(t, "http://127.0.0.1:1/v1", "m", "openai", "sk-1234567890", nil)
	if _, perr := callRaw(t, "ai/chat", map[string]any{"task": "hack", "text": "x"}); perr == nil {
		t.Fatalf("Unknown task should be rejected")
	}
	if _, perr := callRaw(t, "ai/chat", map[string]any{"task": "analyze", "text": "  "}); perr == nil {
		t.Fatalf("Empty text should be rejected")
	}
}

func TestAIStatusReportsMissing(t *testing.T) {
	resetAIConfig()
	st := aiConfigView()
	if st["ready"] != false || st["enabled"] != false {
		t.Fatalf("When not configured ready=false：%v", st)
	}
	enableAI(t, "http://127.0.0.1:1/v1", "m", "openai", "", nil)
	st = aiConfigView()
	if st["ready"] != false || st["hasKey"] != false {
		t.Fatalf("When a key is missing ready=false：%v", st)
	}
	// Ollama No key required
	enableAI(t, "http://127.0.0.1:11434/v1", "qwen", "ollama", "", nil)
	if st = aiConfigView(); st["ready"] != true {
		t.Fatalf("ollama No key also. ready：%v", st)
	}
}

// Connect Actions「Test AI Connection」：In the parameters,**Unsaved Form Values**，It has to work.
func TestConnectionActionTestAI(t *testing.T) {
	resetAIConfig()
	srv := fakeModel(t, 200, openAIJSON, nil, nil)
	res, err := callRaw(t, "connection/action", map[string]any{
		"action": map[string]any{"id": "test-ai"},
		"connection": map[string]any{
			"external_config": map[string]any{
				"ai_enabled": true, "ai_provider": "openai",
				"ai_base_url": srv.URL + "/v1", "ai_model": "fake-1",
			},
			"connection_secrets": map[string]any{"ai_api_key": "sk-1234567890"},
		},
	})
	if err != nil {
		t.Fatalf("connection/action Failed:%s", err.Message)
	}
	out := res.(map[string]any)
	if out["success"] != true || !strings.Contains(out["message"].(string), "Connection successful") {
		t.Fatalf("The test connection should be successful:%v", out)
	}
	// Not enabled / Unknown Action
	if _, err := callRaw(t, "connection/action", map[string]any{"action": map[string]any{"id": "nope"}}); err == nil {
		t.Fatalf("Unknown action should be reported")
	}
	resetAIConfig()
	res2, _ := callRaw(t, "connection/action", map[string]any{"action": map[string]any{"id": "test-ai"}})
	if res2.(map[string]any)["success"] != false {
		t.Fatalf("Return when not enabled success=false：%v", res2)
	}
}

// connectAIConn Filling only the interface layer (unsure): for validation「Reconnection doesn't flush out changes in the panel.」。
func connectAIConn(t *testing.T, base, model, provider, key string) {
	t.Helper()
	resetAIConn()
	absorbAIConfig(map[string]any{"connection": map[string]any{
		"external_config": map[string]any{"ai_enabled": true, "ai_provider": provider,
			"ai_base_url": base, "ai_model": model},
		"connection_secrets": map[string]any{"ai_api_key": key},
	}})
}

/* ---------------- Layer Configuration: Connect Layer / Level ---------------- */

// The configuration saver of the panel overlays the connecting parameters by field;「Clear local settings」.
func TestAIConfigLocalOverridesConnection(t *testing.T) {
	t.Setenv("DBX_PLUGIN_DATA_DIR", t.TempDir())
	resetAIConfig()
	connectAIConn(t, "http://127.0.0.1:1/v1", "conn-model", "openai", "sk-conn-1234567890")
	if got := aiEffective().Model; got != "conn-model" {
		t.Fatalf("Connection layer not effective:%s", got)
	}

	res, perr := callRaw(t, "ai/setConfig", map[string]any{"model": "panel-model", "persist": true})
	if perr != nil {
		t.Fatalf("ai/setConfig Failed:%s", perr.Message)
	}
	if res.(map[string]any)["model"] != "panel-model" {
		t.Fatalf("Return value does not reflect new configuration:%v", res)
	}
	eff := aiEffective()
	if eff.Model != "panel-model" {
		t.Fatalf("This layer should be covered. model：%s", eff.Model)
	}
	if eff.BaseURL != "http://127.0.0.1:1/v1" || eff.APIKey != "sk-conn-1234567890" {
		t.Fatalf("Unchanged fields should follow the interface layer:%+v", eff)
	}

	// Reconnection. connect）Shouldn't have washed out the changes in the panel.
	connectAIConn(t, "http://127.0.0.1:1/v1", "conn-model", "openai", "sk-conn-1234567890")
	if got := aiEffective().Model; got != "panel-model" {
		t.Fatalf("The reconnection of this layer should remain a priority:%s", got)
	}

	// Clear local settings → Back to connection parameters
	if _, perr := callRaw(t, "ai/resetConfig", map[string]any{}); perr != nil {
		t.Fatalf("ai/resetConfig Failed:%s", perr.Message)
	}
	if got := aiEffective().Model; got != "conn-model" {
		t.Fatalf("After clearance, go back to the connection configuration:%s", got)
	}
}

// Safety bottom line (default): Keys filled in panel are memory only and do not drop discs; visible tick「Remember key on this machine」Other Organiser
func TestAIPanelKeyNotOnDiskUnlessRemembered(t *testing.T) {
	dataDir := t.TempDir()
	t.Setenv("DBX_PLUGIN_DATA_DIR", dataDir)
	resetAIConfig()
	const key = "sk-panel-key-abcdef123456"

	if _, e := callRaw(t, "ai/setConfig", map[string]any{
		"enabled": true, "provider": "openai", "baseUrl": "http://127.0.0.1:1/v1",
		"model": "panel-model", "apiKey": key, "persist": true,
	}); e != nil {
		t.Fatalf("setConfig Failed:%s", e.Message)
	}
	cfgPath := filepath.Join(dataDir, "ai-config.json")
	b, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatalf("Profile should have been generated:%v", err)
	}
	if strings.Contains(string(b), key) {
		t.Fatalf("The default key should not be written on disk:%s", b)
	}
	if aiEffective().APIKey != key {
		t.Fatalf("Session key should be available")
	}
	// Non-key fields must have been dropped
	if !strings.Contains(string(b), "panel-model") {
		t.Fatalf("Non-key fields should be set down:%s", b)
	}

	// Show check before drop
	if _, e := callRaw(t, "ai/setConfig", map[string]any{"rememberKey": true, "persist": true}); e != nil {
		t.Fatalf("setConfig Failed:%s", e.Message)
	}
	b, err = os.ReadFile(cfgPath)
	if err != nil || !strings.Contains(string(b), key) {
		t.Fatalf("Check this out and drop the key:%v / %s", err, b)
	}
	if runtime.GOOS != "windows" {
		if st, _ := os.Stat(cfgPath); st != nil && st.Mode().Perm() != 0o600 {
			t.Fatalf("The configuration file with key should read 0600，Actual %o", st.Mode().Perm())
		}
	}

	// Simulation restart: recovery from disk after emptied memory
	resetAIConfig()
	loadAIConfigFromDisk()
	if got := aiEffective(); got.APIKey != key || got.Model != "panel-model" {
		t.Fatalf("Restart from disk configuration:%+v", got)
	}
	if v := aiConfigView(); v["keyOnDisk"] != true || v["keyFrom"] != "local" {
		t.Fatalf("The state should indicate the key from the machine:%v", v)
	}

	// Clear the configuration: delete files, empty the plane
	if _, e := callRaw(t, "ai/resetConfig", map[string]any{}); e != nil {
		t.Fatalf("resetConfig Failed:%s", e.Message)
	}
	if _, err := os.Stat(cfgPath); !os.IsNotExist(err) {
		t.Fatalf("After clearance profile should be deleted:%v", err)
	}
	if aiEffective().APIKey != "" {
		t.Fatalf("There shouldn't be a key after the cleanup.")
	}
}

// 「Test connection」Try with unsaved parameters, but**No change.**Current effective configuration.
func TestAITestDoesNotMutateConfig(t *testing.T) {
	t.Setenv("DBX_PLUGIN_DATA_DIR", t.TempDir())
	srv := fakeModel(t, 200, openAIJSON, nil, nil)
	resetAIConfig()
	enableAI(t, "http://127.0.0.1:1/v1", "keep-model", "openai", "sk-keep-1234567890", nil)

	res, perr := callRaw(t, "ai/test", map[string]any{
		"enabled": true, "provider": "openai",
		"baseUrl": srv.URL + "/v1", "model": "other-model", "apiKey": "sk-other-1234567890",
	})
	if perr != nil {
		t.Fatalf("ai/test Failed:%s", perr.Message)
	}
	if res.(map[string]any)["success"] != true {
		t.Fatalf("The test shall be successful:%v", res)
	}
	eff := aiEffective()
	if eff.Model != "keep-model" || eff.BaseURL != "http://127.0.0.1:1/v1" {
		t.Fatalf("ai/test changed the effective configuration: %+v", eff)
	}
	if _, err := os.Stat(filepath.Join(os.Getenv("DBX_PLUGIN_DATA_DIR"), "ai-config.json")); !os.IsNotExist(err) {
		t.Fatalf("ai/test Shouldn't write:%v", err)
	}
}

// Keep undelivered fields as they are when the panel is reconfigured (cipher box empty) = Do not change the key.
func TestAISetConfigPartialUpdate(t *testing.T) {
	t.Setenv("DBX_PLUGIN_DATA_DIR", t.TempDir())
	resetAIConfig()
	if _, e := callRaw(t, "ai/setConfig", map[string]any{
		"enabled": true, "provider": "anthropic", "baseUrl": "http://127.0.0.1:1/v1",
		"model": "m1", "apiKey": "sk-keep-me-1234567890", "timeoutSecs": 30, "persist": true,
	}); e != nil {
		t.Fatalf("setConfig Failed:%s", e.Message)
	}
	// Change only the model, no key.
	if _, e := callRaw(t, "ai/setConfig", map[string]any{"model": "m2", "persist": true}); e != nil {
		t.Fatalf("setConfig Failed:%s", e.Message)
	}
	eff := aiEffective()
	if eff.Model != "m2" || eff.APIKey != "sk-keep-me-1234567890" || eff.Provider != "anthropic" || eff.TimeoutSecs != 30 {
		t.Fatalf("Unsigned fields should remain as they are:%+v", eff)
	}
	// clearKey Clear it out.
	if _, e := callRaw(t, "ai/setConfig", map[string]any{"clearKey": true, "persist": true}); e != nil {
		t.Fatalf("setConfig Failed:%s", e.Message)
	}
	if aiEffective().APIKey != "" {
		t.Fatalf("clearKey The key should be cleared.")
	}
	// Illegal provider Ignored (not writing trash value)
	if _, e := callRaw(t, "ai/setConfig", map[string]any{"provider": "hack", "persist": true}); e != nil {
		t.Fatalf("setConfig Failed:%s", e.Message)
	}
	if aiEffective().Provider != "anthropic" {
		t.Fatalf("Illegal provider Should be ignored:%s", aiEffective().Provider)
	}
}

/* ---------------- UI Preferences ---------------- */

func TestPrefsWhitelistAndClamp(t *testing.T) {
	dataDir := t.TempDir()
	t.Setenv("DBX_PLUGIN_DATA_DIR", dataDir)
	if _, e := callRaw(t, "ui/setPrefs", map[string]any{"prefs": map[string]any{
		"sidebarWidth": 300, "aiWidth": 99999, "aiPanelOpen": true, "evil": "x",
	}}); e != nil {
		t.Fatalf("ui/setPrefs Failed:%s", e.Message)
	}
	res, e := callRaw(t, "ui/getPrefs", map[string]any{})
	if e != nil {
		t.Fatalf("ui/getPrefs Failed:%s", e.Message)
	}
	p := res.(map[string]any)["prefs"].(map[string]any)
	if p["sidebarWidth"] != 300 {
		t.Fatalf("sidebarWidth To be retained:%v", p["sidebarWidth"])
	}
	if p["aiWidth"] != 720 {
		t.Fatalf("The width of the hyperscope should be cut. 720：%v", p["aiWidth"])
	}
	if _, ok := p["evil"]; ok {
		t.Fatalf("Keys outside the white list should not be written:%v", p)
	}
	if _, ok := p["aiPanelOpen"]; !ok {
		t.Fatalf("aiPanelOpen To be retained:%v", p)
	}
	// Below lower limit → 180；and partially update without missing existing keys
	if _, e := callRaw(t, "ui/setPrefs", map[string]any{"prefs": map[string]any{"aiWidth": 10}}); e != nil {
		t.Fatalf("ui/setPrefs Failed:%s", e.Message)
	}
	res, _ = callRaw(t, "ui/getPrefs", map[string]any{})
	p = res.(map[string]any)["prefs"].(map[string]any)
	if p["aiWidth"] != 180 || p["sidebarWidth"] != 300 {
		t.Fatalf("Cursor/The merger did not work:%v", p)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "prefs.json")); err != nil {
		t.Fatalf("prefs.json There should be:%v", err)
	}
}

/*
 * Behavior when there are no notes in the text(s)v0.8.3）：
 *   「Ask」Degraded to pure dialogue,「Continue writing」It's degenerated into a free generation as you want -- it works.
 *   「Analyze」「Polish」The semantic is to deal with a text that is ready to be rejected.**And the error message will give us a way out.**
 *   （Just say it."Lack of body to process"，Users do not know what to do next.
 * Plus: When there is no text**Never.**Scramble a blank in the hint."Text of Notes" ——
 * That makes the model think you gave an empty note.
 */
func TestAIChatWithoutNoteText(t *testing.T) {
	var gotBody string
	srv := fakeModel(t, 200, openAIJSON, nil, &gotBody)
	resetAIConfig()
	enableAI(t, srv.URL+"/v1", "fake-1", "openai", "sk-1234567890", nil)

	// Ask + Just the problem. → Pure conversation
	res, perr := callRaw(t, "ai/chat", map[string]any{"task": "ask", "text": "   ", "instruction": "Hello."})
	if perr != nil {
		t.Fatalf("No text.「Ask」Should be available (pure dialogue):%s", perr.Message)
	}
	if res.(map[string]any)["content"] != "Text after colour" {
		t.Fatalf("The result should be a normal return:%v", res)
	}
	if !strings.Contains(gotBody, "haven't provided any note text") || !strings.Contains(gotBody, "Hello.") {
		t.Fatalf("The reminder shall state that there are no notes and there are questions:%s", gotBody)
	}
	if strings.Contains(gotBody, "Note content:") {
		t.Fatalf("We shouldn't be empty without the text.「Text of Notes」Paragraph:%s", gotBody)
	}

	// Continuation: No request → Rejected; requested → Free Generate
	if _, e := callRaw(t, "ai/chat", map[string]any{"task": "continue", "text": ""}); e == nil {
		t.Fatalf("There's nothing to ask for.「Continue writing」It should be rejected.")
	}
	if _, e := callRaw(t, "ai/chat", map[string]any{"task": "continue", "text": "", "instruction": "Write a greeting."}); e != nil {
		t.Fatalf("It's a request.「Continue writing」Should be available (freely generated):%s", e.Message)
	}
	if !strings.Contains(gotBody, "Write a greeting.") {
		t.Fatalf("Request not included:%s", gotBody)
	}

	// Analyze / Motion: Must refuse and tell the user how to fix it
	for _, task := range []string{"analyze", "polish"} {
		_, e := callRaw(t, "ai/chat", map[string]any{"task": task, "text": "   "})
		if e == nil {
			t.Fatalf("%s If you don't have the text, you should be rejected.", task)
		}
		if !strings.Contains(e.Message, "entire note") || !strings.Contains(e.Message, "Ask") {
			t.Fatalf("%s Error messages is for the way out. / Question:%s", task, e.Message)
		}
	}
}

// **Security floor**：Keys should not appear in any file in the data directory or in the notes directory.
func TestAISecretNeverTouchesDisk(t *testing.T) {
	const key = "sk-must-not-be-persisted-42"
	dataDir := t.TempDir()
	storageDir := t.TempDir()
	t.Setenv("DBX_PLUGIN_DATA_DIR", dataDir)
	resetAIConfig()

	if _, err := callRaw(t, "connection/connect", connectParams(storageDir, map[string]any{
		"ai_enabled": true, "ai_provider": "openai",
		"ai_base_url": "http://127.0.0.1:1/v1", "ai_model": "m",
	}, key)); err != nil {
		t.Fatalf("connect Failed:%s", err.Message)
	}
	// Put down a note to confirm that the normal writing path does not carry a key
	if _, err := callRaw(t, "notes/save", map[string]any{"data": map[string]any{
		"version": 2, "nodes": []map[string]any{
			{"id": "n1", "type": "note", "name": "Title", "parentId": nil, "content": "note body",
				"createdAt": "c", "updatedAt": "u"},
		},
	}}); err != nil {
		t.Fatalf("save Failed:%s", err.Message)
	}

	for _, root := range []string{dataDir, storageDir} {
		_ = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return nil
			}
			b, err := os.ReadFile(p)
			if err != nil {
				return nil
			}
			if strings.Contains(string(b), key) {
				t.Fatalf("Key is written into disk file:%s", p)
			}
			return nil
		})
	}
	// The key should not be left in memory after disconnection
	if _, err := callRaw(t, "connection/disconnect", map[string]any{"connectionId": "c-ai"}); err != nil {
		t.Fatalf("disconnect Failed:%s", err.Message)
	}
	if aiSnapshot().APIKey != "" {
		t.Fatalf("Key left after disconnect")
	}
}
