// AI Access: handing over notes to third-party models for analysis / Polish / Continue writing / Questions and answers.
//
// Why the sidecar instead of the frontend:
//   - Plugin UI There's no network in the sandbox. The front-end straight-end company wants to state. host.network:https://origin（≤8 One, just... HTTPS、
//     Path not allowed/wildcard, still received CORS），The third-party gateway often carries a custom path -- side-car network is not subject to these restrictions.
//   - The connection key will only be filled by the host.「Backend life cycle request」（connection/test|connect|action），
//     Front End Only connectionId。So the key can only be used in the sidecar and never enter the log. / Error message / Front-end response.
//
// Why don't you use the host's? host.ai（Internal AI Panel:
//
//	That interface was just...「Open a conversation with a data snapshot」，I don't want to go back to the model or expose the model configuration.
//	I can't.「AI And then I wrote back.」The core thing; the statement of authority is static and the old host will encounter unknown privileges
//	The installation phase is directly rejected -- equal to an unused entry point <0.6.20 The users are all blocked out.
//
// Configure in two layers (the core design of this document):
//
//	aiConn  —— Linking Parametersexternal_config.ai_* / connection_secrets.ai_api_key），Vulnerability;
//	           Every time connection/connect It's empty.disconnect Time clear.
//	aiLocal —— User in「AI Helpbar → Configure」It's changed. <dataDir>/ai-config.json。
//	Valid value = Base Level of Connection → This layer covers non-empty values by field.
//	So: the person who's connected doesn't have to do anything; the person who's changed in the panel doesn't have to go back to the connection; the person who's changed in the panel.「Clear local settings」
//	One key back.「Based on connection configuration」。
//
// Key boundary (security bottom):
//
//	Default is only in memory. Only if the user is visible in the panel「Remember key on this machine」It'll be written when it's done.
//	<dataDir>/ai-config.json（0600，Plugin private directory, not in the Note Storage Directory.
//	In either case, the key does not appear in the log, the error message,RPC Response hasKey In the notes.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	dbxpluginsdk "github.com/lwai/mdnotes/dbxsdk"
)

const (
	aiDefaultProvider    = "openai"
	aiDefaultTimeoutSecs = 60
	aiMinTimeoutSecs     = 5
	aiMaxTimeoutSecs     = 300
	aiDefaultMaxChars    = 12000
	aiMinMaxChars        = 500
	aiMaxMaxChars        = 200000
	aiMaxResponseBytes   = 4 << 20 // Single-responder caps to prevent super-heavy. Response Drag Down.
)

// aiSettings is a layer configuration.Enabled The pointer is to distinguish.「I didn't mention it.」（nil）with「Clear Close」（false）。
type aiSettings struct {
	Enabled      *bool  `json:"enabled,omitempty"`
	Provider     string `json:"provider,omitempty"`
	BaseURL      string `json:"baseUrl,omitempty"`
	Model        string `json:"model,omitempty"`
	APIKey       string `json:"apiKey,omitempty"`
	SystemPrompt string `json:"systemPrompt,omitempty"`
	TimeoutSecs  int    `json:"timeoutSecs,omitempty"`
	MaxChars     int    `json:"maxChars,omitempty"`
}

// aiConfigFile It's the way this plane is falling.
type aiConfigFile struct {
	aiSettings
	Version     int    `json:"version"`
	RememberKey bool   `json:"rememberKey,omitempty"`
	UpdatedAt   string `json:"updatedAt,omitempty"`
}

var (
	aiMu           sync.RWMutex
	aiConn         aiSettings // Connect layer (failible)
	aiLocal        aiSettings // This layer (panel saved, sustainable)
	aiLocalHasFile bool       // Do you have a record on this machine? AI Configure
	aiRememberKey  bool       // Does this machine file contain a key?
	aiLoaded       bool       // Have you tried to read the machine layer from the disk?
)

func aiConfigPath() string { return filepath.Join(dataDir(), "ai-config.json") }

/* ---------------- Read and write on this floor ---------------- */

func loadAIConfigFromDisk() {
	aiMu.Lock()
	defer aiMu.Unlock()
	aiLoaded = true

	b, err := os.ReadFile(aiConfigPath())
	if err != nil {
		return
	}
	var f aiConfigFile
	if json.Unmarshal(b, &f) != nil {
		// If the file is damaged, do not block startup (next save will be covered)
		sidecarTrace("ai-config.json parse failed; ignoring file")
		return
	}
	aiLocal = f.aiSettings
	aiRememberKey = f.RememberKey && f.APIKey != ""
	aiLocalHasFile = true
	sidecarTrace(fmt.Sprintf("ai-config loaded provider=%s model=%s hasKey=%v",
		aiLocal.Provider, aiLocal.Model, aiLocal.APIKey != ""))
}

// ensureAILoaded Lazy: Production environment main() We'll do it first; the test runs. Handler It's on this side.
func ensureAILoaded() {
	aiMu.RLock()
	done := aiLoaded
	aiMu.RUnlock()
	if done {
		return
	}
	loadAIConfigFromDisk()
}

// saveAILocalLocked Write disks on this floor.**Only held by Caller aiMu use**。
// remember=false Do not write keys from time to time (and erase old keys from the file together).
func saveAILocalLocked(remember bool) error {
	if err := os.MkdirAll(dataDir(), 0o755); err != nil {
		return err
	}
	out := aiConfigFile{aiSettings: aiLocal, Version: 1,
		RememberKey: remember && aiLocal.APIKey != "", UpdatedAt: time.Now().Format(time.RFC3339)}
	if !out.RememberKey {
		out.APIKey = ""
	}
	b, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		return err
	}
	path := aiConfigPath()
	if err := writeAtomic(path, append(b, '\n')); err != nil {
		return err
	}
	// Keys are in there. Permissions are tightened.Windows Mostly. no-op，Unix It's working.
	_ = os.Chmod(path, 0o600)
	return nil
}

/* ---------------- Valid value ---------------- */

// applyOver Use src Non-empty Field Overwrite dst（This function is the basis of the interconnection layer, which is covered by the in-house layer.
func applyOver(dst *aiSettings, src aiSettings) {
	if src.Enabled != nil {
		v := *src.Enabled
		dst.Enabled = &v
	}
	if src.Provider != "" {
		dst.Provider = src.Provider
	}
	if src.BaseURL != "" {
		dst.BaseURL = src.BaseURL
	}
	if src.Model != "" {
		dst.Model = src.Model
	}
	if src.APIKey != "" {
		dst.APIKey = src.APIKey
	}
	if src.SystemPrompt != "" {
		dst.SystemPrompt = src.SystemPrompt
	}
	if src.TimeoutSecs > 0 {
		dst.TimeoutSecs = src.TimeoutSecs
	}
	if src.MaxChars > 0 {
		dst.MaxChars = src.MaxChars
	}
}

// aiMergeLocked Calculates the effective value.**Only held by Caller aiMu（Use when reading or writing)**。
func aiMergeLocked() aiSettings {
	out := aiSettings{Provider: aiDefaultProvider, TimeoutSecs: aiDefaultTimeoutSecs, MaxChars: aiDefaultMaxChars}
	applyOver(&out, aiConn)
	applyOver(&out, aiLocal)
	if out.TimeoutSecs <= 0 {
		out.TimeoutSecs = aiDefaultTimeoutSecs
	}
	if out.MaxChars <= 0 {
		out.MaxChars = aiDefaultMaxChars
	}
	if out.Provider == "" {
		out.Provider = aiDefaultProvider
	}
	return out
}

func aiEffective() aiSettings {
	ensureAILoaded()
	aiMu.RLock()
	defer aiMu.RUnlock()
	return aiMergeLocked()
}

// aiSnapshot Keeps the name for log and test: returns the current active value.
func aiSnapshot() aiSettings { return aiEffective() }

func aiIsEnabled(c aiSettings) bool { return c.Enabled != nil && *c.Enabled }

/* ---------------- Absorption from connecting parameters (connection layers) ---------------- */

var aiConnKeys = map[string]bool{
	"ai_enabled": true, "ai_provider": true, "ai_base_url": true, "ai_model": true,
	"ai_api_key": true, "ai_system_prompt": true, "ai_timeout_secs": true, "ai_max_chars": true,
}

// lookupKeys It's all in the bag. map/Press in array key Name value (and storage_dir It's the same method of extraction, priority for error).
func lookupKeys(v any, keys map[string]bool, out map[string]any) {
	switch t := v.(type) {
	case map[string]any:
		for k, val := range t {
			if keys[k] {
				if _, seen := out[k]; !seen {
					out[k] = val
				}
			}
		}
		for _, val := range t {
			lookupKeys(val, keys, out)
		}
	case []any:
		for _, item := range t {
			lookupKeys(item, keys, out)
		}
	}
}

func asString(v any) string {
	switch t := v.(type) {
	case string:
		return strings.TrimSpace(t)
	case json.Number:
		return t.String()
	case float64:
		if t == float64(int64(t)) {
			return fmt.Sprintf("%d", int64(t))
		}
		return fmt.Sprintf("%v", t)
	case int:
		return fmt.Sprintf("%d", t)
	case bool:
		if t {
			return "true"
		}
		return "false"
	}
	return ""
}

func asBool(v any) bool {
	switch t := v.(type) {
	case bool:
		return t
	case string:
		s := strings.ToLower(strings.TrimSpace(t))
		return s == "true" || s == "1" || s == "yes" || s == "on"
	case float64:
		return t != 0
	}
	return false
}

func asInt(v any, def, min, max int) int {
	n := 0
	switch t := v.(type) {
	case float64:
		n = int(t)
	case int:
		n = t
	case string:
		_, err := fmt.Sscanf(strings.TrimSpace(t), "%d", &n)
		if err != nil {
			return def
		}
	default:
		return def
	}
	return clampInt(n, def, min, max)
}

// absorbAIConfig Absorption from connecting parameters AI Configure, write only connect layers (failible), and do not leave a disk.
func absorbAIConfig(values map[string]any) {
	if len(values) == 0 {
		return
	}
	found := map[string]any{}
	lookupKeys(values, aiConnKeys, found)
	if len(found) == 0 {
		return
	}

	aiMu.Lock()
	defer aiMu.Unlock()
	if v, ok := found["ai_enabled"]; ok {
		b := asBool(v)
		aiConn.Enabled = &b
	}
	if v, ok := found["ai_provider"]; ok {
		if p := normalizeProvider(asString(v)); p != "" {
			aiConn.Provider = p
		}
	}
	if v, ok := found["ai_base_url"]; ok {
		if s := asString(v); s != "" {
			aiConn.BaseURL = s
		}
	}
	if v, ok := found["ai_model"]; ok {
		if s := asString(v); s != "" {
			aiConn.Model = s
		}
	}
	if v, ok := found["ai_api_key"]; ok {
		// Empty string does not overwrite existing keys: leave empty when user edits connection"Do Not Change Password"。
		if s := asString(v); s != "" {
			aiConn.APIKey = s
		}
	}
	if v, ok := found["ai_system_prompt"]; ok {
		if s := asString(v); s != "" {
			aiConn.SystemPrompt = s
		}
	}
	if v, ok := found["ai_timeout_secs"]; ok {
		aiConn.TimeoutSecs = clampInt(asInt(v, aiDefaultTimeoutSecs, aiMinTimeoutSecs, aiMaxTimeoutSecs),
			aiDefaultTimeoutSecs, aiMinTimeoutSecs, aiMaxTimeoutSecs)
	}
	if v, ok := found["ai_max_chars"]; ok {
		aiConn.MaxChars = clampInt(asInt(v, aiDefaultMaxChars, aiMinMaxChars, aiMaxMaxChars),
			aiDefaultMaxChars, aiMinMaxChars, aiMaxMaxChars)
	}
}

func normalizeProvider(s string) string {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "openai", "anthropic", "ollama":
		return strings.ToLower(strings.TrimSpace(s))
	}
	return ""
}

func clampInt(n, def, min, max int) int {
	if n <= 0 {
		return def
	}
	if n < min {
		return min
	}
	if n > max {
		return max
	}
	return n
}

// resetAIConn Clears the interface layer when the connection is disconnected (this layer is the user ' s choice on the machine, keeping).
func resetAIConn() {
	aiMu.Lock()
	aiConn = aiSettings{}
	aiMu.Unlock()
}

// resetAIConfig Empty two layers of memory and mark"Loaded"To avoid going back to the machine.
// Only for testing and internal use -- it does not delete this machine file.
func resetAIConfig() {
	aiMu.Lock()
	defer aiMu.Unlock()
	aiConn = aiSettings{}
	aiLocal = aiSettings{}
	aiLocalHasFile = false
	aiRememberKey = false
	aiLoaded = true
}

/* ---------------- Status and Configuration View ---------------- */

// aiConfigView Full configuration view for the frontend.**Never Without Key Body**，Only  hasKey Boole.
func aiConfigView() map[string]any {
	ensureAILoaded()
	aiMu.RLock()
	eff := aiMergeLocked()
	conn, local := aiConn, aiLocal
	hasFile, remember := aiLocalHasFile, aiRememberKey
	aiMu.RUnlock()

	missing := []string{}
	if !aiIsEnabled(eff) {
		missing = append(missing, "enabled")
	}
	if eff.BaseURL == "" {
		missing = append(missing, "baseUrl")
	}
	if eff.Model == "" {
		missing = append(missing, "model")
	}
	if eff.Provider != "ollama" && eff.APIKey == "" {
		missing = append(missing, "apiKey")
	}

	// Which fields are capped by the configuration of the machine (panel) - this is the basis for the interface.「Clear local settings」Return to Connection Configuration
	overridden := []string{}
	if local.Enabled != nil {
		overridden = append(overridden, "enabled")
	}
	if local.Provider != "" {
		overridden = append(overridden, "provider")
	}
	if local.BaseURL != "" {
		overridden = append(overridden, "baseUrl")
	}
	if local.Model != "" {
		overridden = append(overridden, "model")
	}
	if local.SystemPrompt != "" {
		overridden = append(overridden, "systemPrompt")
	}
	if local.TimeoutSecs > 0 {
		overridden = append(overridden, "timeoutSecs")
	}
	if local.MaxChars > 0 {
		overridden = append(overridden, "maxChars")
	}
	keyFrom := ""
	if local.APIKey != "" {
		keyFrom = "local"
		overridden = append(overridden, "apiKey")
	} else if conn.APIKey != "" {
		keyFrom = "connection"
	}

	out := map[string]any{
		"enabled":        aiIsEnabled(eff),
		"provider":       eff.Provider,
		"baseUrl":        eff.BaseURL,
		"model":          eff.Model,
		"systemPrompt":   eff.SystemPrompt,
		"timeoutSecs":    eff.TimeoutSecs,
		"maxChars":       eff.MaxChars,
		"hasKey":         eff.APIKey != "",
		"keyFrom":        keyFrom,
		"keyOnDisk":      remember,
		"rememberKey":    remember,
		"hasLocalConfig": hasFile,
		"overridden":     overridden,
		"ready":          len(missing) == 0,
		"missing":        missing,
		"dataDir":        dataDir(),
	}
	return out
}

/* ---------------- Request Construction ---------------- */

const aiDefaultSystem = "You are a precise technical writing assistant for database engineers. " +
	"Answer directly and specifically without pleasantries. Do not repeat source text or add unrelated advice."

// aiTaskLabel The name of the voice job for which the error message was given. analyze/polish/... This one. id）。
func aiTaskLabel(task string) string {
	switch task {
	case "analyze":
		return "Analyze"
	case "polish":
		return "Polish"
	case "continue":
		return "Continue writing"
	case "ask":
		return "Ask"
	}
	return task
}

// aiTaskNeedsText Report whether the mission is...**There must be text**。
// 「Analyze」「Polish」The semantic is to deal with a ready-made text without the text;
// 「Ask」and「Continue writing」Still meaningful in the absence of text (pure dialogue) / Make it as you wish.
func aiTaskNeedsText(task string) bool {
	return task == "analyze" || task == "polish"
}

// aiTaskPrompt Constructs the hint.text is empty**I can't.**One more piece."Text of Notes" ——
// That makes the model think you gave it an empty note, and then you keep asking or making it up.
func aiTaskPrompt(task, text, instruction string) (system, user string) {
	has := strings.TrimSpace(text) != ""
	switch task {
	case "analyze":
		if !has {
			return aiDefaultSystem, "I haven't provided a note to analyze. Please tell me what you need to analyze."
		}
		return aiDefaultSystem,
			"Analyze the following note and provide:\n1) 3–6 key points (one per line, starting with -)\n2) Items requiring follow-up (write \"None\" if there are none)\n3) Contradictions or clear factual errors (write \"None\" if there are none)\n\nNote content:\n\n" + text
	case "polish":
		if !has {
			return aiDefaultSystem, "I haven't provided text to polish. Please send the text you want polished."
		}
		extra := ""
		if instruction != "" {
			extra = "\nAdditional instructions: " + instruction
		}
		return aiDefaultSystem,
			"Polish the following Markdown note. Preserve its meaning, Markdown structure, and code blocks while improving clarity and word choice. " +
				"Do not add or remove facts or include explanations. **Output only the polished text.**" + extra + "\n\nNote content:\n\n" + text
	case "continue":
		if !has {
			dir := "Write some Markdown content"
			if instruction != "" {
				dir = "Write Markdown content following these instructions (" + instruction + ")"
			}
			return aiDefaultSystem, dir + ". **Output only the content**, without explanations, prefixes, or suffixes."
		}
		extra := ""
		if instruction != "" {
			extra = " (writing direction: " + instruction + ")"
		}
		return aiDefaultSystem,
			"Continue this Markdown note naturally at the end" + extra +
				", preserving its style and Markdown structure. **Output only the new content**; do not repeat existing content or add explanations.\n\nExisting content:\n\n" + text
	case "ask":
		q := instruction
		if q == "" {
			q = "What is this note about?"
		}
		if !has {
			return aiDefaultSystem,
				"Answer my question. **I haven't provided any note text**, so answer based only on the question and do not pretend to have read a note.\n\nQuestion: " + q
		}
		return aiDefaultSystem,
			"Answer my question using the note below. If the note lacks the information, say so; do not invent it.\n\nQuestion: " + q + "\n\nNote content:\n\n" + text
	default:
		return aiDefaultSystem, text
	}
}

func aiEndpoint(c aiSettings) (string, error) {
	base := strings.TrimRight(strings.TrimSpace(c.BaseURL), "/")
	if base == "" {
		return "", fmt.Errorf("API URL is not configured")
	}
	u, err := url.Parse(base)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return "", fmt.Errorf("API URL is invalid: %s", c.BaseURL)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", fmt.Errorf("API URL must use HTTP or HTTPS")
	}
	path := strings.TrimRight(u.Path, "/")
	if c.Provider == "anthropic" {
		switch {
		case strings.HasSuffix(path, "/messages"):
		case strings.HasSuffix(path, "/v1"):
			path += "/messages"
		default:
			path += "/v1/messages"
		}
	} else {
		switch {
		case strings.HasSuffix(path, "/chat/completions"):
		case strings.HasSuffix(path, "/v1"):
			path += "/chat/completions"
		default:
			path += "/v1/chat/completions"
		}
	}
	u.Path = path
	return u.String(), nil
}

func redact(s string, c aiSettings) string {
	if c.APIKey != "" && len(c.APIKey) >= 8 {
		s = strings.ReplaceAll(s, c.APIKey, "***")
	}
	return s
}

// truncateChars By Characterrune）Cut it off. UTF-8。
func truncateChars(s string, limit int) (string, bool) {
	if limit <= 0 || utf8.RuneCountInString(s) <= limit {
		return s, false
	}
	r := []rune(s)
	return string(r[:limit]), true
}

type aiResult struct {
	Content   string
	Model     string
	PromptTok int
	OutTok    int
	Truncated bool
	SentChars int
}

// aiCall Send a request with the given configuration (rather than the global) - the configuration is determined by the caller.
// 「Test connection」An unsaved set of parameters can therefore be tested without changing the effective configuration.
func aiCall(reqText aiRequest, maxTokens int, c aiSettings) (*aiResult, error) {
	if !aiIsEnabled(c) {
		return nil, fmt.Errorf("AI is disabled. Enable AI in the connection settings or AI assistant settings.")
	}
	if c.Model == "" {
		return nil, fmt.Errorf("Model name is not configured")
	}
	endpoint, err := aiEndpoint(c)
	if err != nil {
		return nil, err
	}

	system := c.SystemPrompt
	if system == "" {
		system = aiTaskPromptSystem(reqText.Task)
	}
	text, truncated := truncateChars(reqText.Text, c.MaxChars)

	var body map[string]any
	headers := map[string]string{"Content-Type": "application/json"}

	if c.Provider == "anthropic" {
		body = map[string]any{
			"model":      c.Model,
			"max_tokens": maxTokens,
			"system":     system,
			"messages":   []map[string]any{{"role": "user", "content": aiTaskPromptUser(reqText, text)}},
		}
		if c.APIKey == "" {
			return nil, fmt.Errorf("API key is not configured")
		}
		headers["x-api-key"] = c.APIKey
		headers["anthropic-version"] = "2023-06-01"
	} else {
		body = map[string]any{
			"model":      c.Model,
			"max_tokens": maxTokens,
			"messages": []map[string]any{
				{"role": "system", "content": system},
				{"role": "user", "content": aiTaskPromptUser(reqText, text)},
			},
		}
		if c.Provider != "ollama" {
			if c.APIKey == "" {
				return nil, fmt.Errorf("API key is not configured")
			}
			headers["Authorization"] = "Bearer " + c.APIKey
		}
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("Could not create request: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(c.TimeoutSecs)*time.Second)
	defer cancel()
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("Could not create request: %v", err)
	}
	for k, v := range headers {
		httpReq.Header.Set(k, v)
	}

	client := &http.Client{Timeout: time.Duration(c.TimeoutSecs) * time.Second}
	resp, err := client.Do(httpReq)
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return nil, fmt.Errorf("Request timed out after %d seconds. Increase the timeout in AI assistant settings if the model needs more time.", c.TimeoutSecs)
		}
		return nil, fmt.Errorf("Could not connect to the model service: %s", redact(err.Error(), c))
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, aiMaxResponseBytes))

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("%s", aiHTTPError(resp.StatusCode, raw, c))
	}

	out := &aiResult{Truncated: truncated, SentChars: utf8.RuneCountInString(text)}
	if c.Provider == "anthropic" {
		var r struct {
			Model   string `json:"model"`
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
			Usage struct {
				Input  int `json:"input_tokens"`
				Output int `json:"output_tokens"`
			} `json:"usage"`
		}
		if err := json.Unmarshal(raw, &r); err != nil {
			return nil, fmt.Errorf("Could not parse the model response: %s", redact(snippet(raw), c))
		}
		for _, part := range r.Content {
			if part.Type == "text" || part.Type == "" {
				out.Content += part.Text
			}
		}
		out.Model, out.PromptTok, out.OutTok = r.Model, r.Usage.Input, r.Usage.Output
	} else {
		var r struct {
			Model   string `json:"model"`
			Choices []struct {
				Message struct {
					Content string `json:"content"`
				} `json:"message"`
				Text string `json:"text"`
			} `json:"choices"`
			Usage struct {
				Prompt     int `json:"prompt_tokens"`
				Completion int `json:"completion_tokens"`
			} `json:"usage"`
			Error any `json:"error"`
		}
		if err := json.Unmarshal(raw, &r); err != nil {
			return nil, fmt.Errorf("Could not parse the model response: %s", redact(snippet(raw), c))
		}
		if len(r.Choices) > 0 {
			out.Content = r.Choices[0].Message.Content
			if out.Content == "" {
				out.Content = r.Choices[0].Text
			}
		}
		out.Model, out.PromptTok, out.OutTok = r.Model, r.Usage.Prompt, r.Usage.Completion
	}
	out.Content = strings.TrimSpace(out.Content)
	if out.Content == "" {
		return nil, fmt.Errorf("The model returned an empty response")
	}
	return out, nil
}

func aiTaskPromptSystem(task string) string {
	s, _ := aiTaskPrompt(task, "", "")
	return s
}

func aiTaskPromptUser(req aiRequest, text string) string {
	_, u := aiTaskPrompt(req.Task, text, req.Instruction)
	return u
}

// snippet Gives a response context to the error, but does not leak the key.
func snippet(b []byte) string {
	s := strings.TrimSpace(string(b))
	if len(s) > 300 {
		s = s[:300] + "…"
	}
	if s == "" {
		return "(empty response)"
	}
	return s
}

func aiHTTPError(status int, body []byte, c aiSettings) string {
	detail := snippet(body)
	switch status {
	case 401, 403:
		return fmt.Sprintf("Authentication failed (HTTP %d): The API key is invalid or lacks permission. %s", status, redact(detail, c))
	case 404:
		return fmt.Sprintf("Endpoint not found (HTTP 404): Check the API URL, including any required version path such as /v1. %s", redact(detail, c))
	case 429:
		return fmt.Sprintf("Rate limited (HTTP 429): Too many requests or quota exhausted. %s", redact(detail, c))
	}
	if status >= 500 {
		return fmt.Sprintf("Model service error (HTTP %d): Try again later. %s", status, redact(detail, c))
	}
	return fmt.Sprintf("Request failed (HTTP %d): %s", status, redact(detail, c))
}

/* ---------------- RPC ---------------- */

type aiRequest struct {
	Task        string `json:"task"`
	Text        string `json:"text"`
	Instruction string `json:"instruction"`
}

func aiChatHandler(raw json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var req aiRequest
	if e := json.Unmarshal(raw, &req); e != nil {
		return nil, badParams("invalid params: %v", e)
	}
	if strings.TrimSpace(req.Text) == "" {
		if aiTaskNeedsText(req.Task) {
			// 「Analyze/Polish」Can't do it without the text: give an actionable statement, don't just say"Lack of body to process"
			return nil, badParams("%s requires note text. Select some content or switch the scope to the entire note. "+
				"(To chat without a note, use Ask.)", aiTaskLabel(req.Task))
		}
		if strings.TrimSpace(req.Instruction) == "" {
			return nil, badParams("Nothing to process. Enter a question or instruction below.")
		}
	}
	switch req.Task {
	case "analyze", "polish", "continue", "ask":
	default:
		return nil, badParams("Unsupported AI task: %s", req.Task)
	}
	cfg := aiEffective()
	started := time.Now()
	maxTokens := 2048
	if req.Task == "analyze" || req.Task == "continue" {
		maxTokens = 1600
	}
	res, err := aiCall(req, maxTokens, cfg)
	if err != nil {
		sidecarTrace("ai/chat FAILED task=" + req.Task + " model=" + cfg.Model + " err=" + err.Error())
		return nil, failed(-32010, err)
	}
	sidecarTrace(fmt.Sprintf("ai/chat ok task=%s model=%s chars=%d truncated=%v ms=%d",
		req.Task, res.Model, res.SentChars, res.Truncated, time.Since(started).Milliseconds()))
	return map[string]any{
		"content":   res.Content,
		"model":     res.Model,
		"usage":     map[string]any{"promptTokens": res.PromptTok, "completionTokens": res.OutTok},
		"truncated": res.Truncated,
		"sentChars": res.SentChars,
		"latencyMs": time.Since(started).Milliseconds(),
	}, nil
}

// setConfigParams Deal only"Passed Fields"，Unspoiled keep as it is. = Do not change the key.
type setConfigParams struct {
	Enabled      *bool   `json:"enabled"`
	Provider     *string `json:"provider"`
	BaseURL      *string `json:"baseUrl"`
	Model        *string `json:"model"`
	APIKey       string  `json:"apiKey"`
	ClearKey     bool    `json:"clearKey"`
	SystemPrompt *string `json:"systemPrompt"`
	TimeoutSecs  *int    `json:"timeoutSecs"`
	MaxChars     *int    `json:"maxChars"`
	RememberKey  *bool   `json:"rememberKey"`
	Persist      *bool   `json:"persist"`
}

// aiSetConfigHandler Updates the current layer.persist=false Only memory is changed.
func aiSetConfigHandler(raw json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var p setConfigParams
	if e := json.Unmarshal(raw, &p); e != nil {
		return nil, badParams("invalid params: %v", e)
	}
	ensureAILoaded()

	aiMu.Lock()
	if p.Enabled != nil {
		v := *p.Enabled
		aiLocal.Enabled = &v
	}
	if p.Provider != nil {
		if v := normalizeProvider(*p.Provider); v != "" {
			aiLocal.Provider = v
		}
	}
	if p.BaseURL != nil {
		aiLocal.BaseURL = strings.TrimSpace(*p.BaseURL)
	}
	if p.Model != nil {
		aiLocal.Model = strings.TrimSpace(*p.Model)
	}
	if p.SystemPrompt != nil {
		aiLocal.SystemPrompt = *p.SystemPrompt
	}
	if p.TimeoutSecs != nil {
		aiLocal.TimeoutSecs = clampInt(*p.TimeoutSecs, aiDefaultTimeoutSecs, aiMinTimeoutSecs, aiMaxTimeoutSecs)
	}
	if p.MaxChars != nil {
		aiLocal.MaxChars = clampInt(*p.MaxChars, aiDefaultMaxChars, aiMinMaxChars, aiMaxMaxChars)
	}
	if p.ClearKey {
		aiLocal.APIKey = ""
	} else if k := strings.TrimSpace(p.APIKey); k != "" {
		aiLocal.APIKey = k
	}
	remember := aiRememberKey
	if p.RememberKey != nil {
		remember = *p.RememberKey
	}
	// A key already exists in the connection parameter and the user fills a new one in the panel."Remember."Handle? No...
	// Whether or not to set a disk must be determined by a user ' s explicit tick, without a hidden inference.
	persist := p.Persist == nil || *p.Persist
	var saveErr error
	if persist {
		if saveErr = saveAILocalLocked(remember); saveErr == nil {
			aiLocalHasFile = true
			aiRememberKey = remember && aiLocal.APIKey != ""
		}
	}
	keyOnDisk := aiRememberKey
	model := aiLocal.Model
	aiMu.Unlock()

	if saveErr != nil {
		sidecarTrace("ai/setConfig save failed: " + saveErr.Error())
		return nil, failed(-32011, fmt.Errorf("Could not save AI settings: %v", saveErr))
	}
	sidecarTrace(fmt.Sprintf("ai/setConfig ok persist=%v enabled=%v model=%s hasKey=%v keyOnDisk=%v",
		persist, p.Enabled != nil && *p.Enabled, model, p.APIKey != "", keyOnDisk))
	out := aiConfigView()
	out["saved"] = persist
	return out, nil
}

// aiResetConfigHandler Clear the floor. Go back.「Based on connection configuration」。
func aiResetConfigHandler() (any, *dbxpluginsdk.PluginError) {
	ensureAILoaded()
	aiMu.Lock()
	aiLocal = aiSettings{}
	aiLocalHasFile = false
	aiRememberKey = false
	aiMu.Unlock()
	if err := os.Remove(aiConfigPath()); err != nil && !os.IsNotExist(err) {
		return nil, failed(-32011, fmt.Errorf("Could not remove local AI settings: %v", err))
	}
	sidecarTrace("ai/resetConfig ok")
	out := aiConfigView()
	out["saved"] = true
	return out, nil
}

// testParams Allow「Test a set of unsaved parameters」：The empty field follows the current active value.
type testParams struct {
	Enabled      *bool  `json:"enabled"`
	Provider     string `json:"provider"`
	BaseURL      string `json:"baseUrl"`
	Model        string `json:"model"`
	APIKey       string `json:"apiKey"`
	SystemPrompt string `json:"systemPrompt"`
	TimeoutSecs  int    `json:"timeoutSecs"`
}

// aiTestHandler Sends a minimum request with the given parameter (suspension with current effective configuration).
// **Do not change effective configuration** —— It doesn't break the user's original configuration.
func aiTestHandler(raw json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var p testParams
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &p)
	}
	cfg := aiEffective()
	ov := aiSettings{Enabled: p.Enabled, Provider: normalizeProvider(p.Provider),
		BaseURL: strings.TrimSpace(p.BaseURL), Model: strings.TrimSpace(p.Model),
		APIKey: strings.TrimSpace(p.APIKey), SystemPrompt: p.SystemPrompt, TimeoutSecs: p.TimeoutSecs}
	applyOver(&cfg, ov)

	if !aiIsEnabled(cfg) {
		return map[string]any{"success": false, "message": "AI is disabled. Enable AI to test the connection."}, nil
	}
	if cfg.BaseURL == "" || cfg.Model == "" {
		return map[string]any{"success": false, "message": "Enter an API URL and model name first."}, nil
	}
	started := time.Now()
	res, err := aiCall(aiRequest{Task: "ask", Text: "ping", Instruction: "Reply with only: OK"}, 32, cfg)
	if err != nil {
		sidecarTrace("ai/test FAILED err=" + err.Error())
		return map[string]any{"success": false, "message": err.Error()}, nil
	}
	model := res.Model
	if model == "" {
		model = cfg.Model
	}
	return map[string]any{
		"success": true,
		"message": fmt.Sprintf("Connection successful: %s (%s) · %d ms · Response: %s",
			model, cfg.Provider, time.Since(started).Milliseconds(), snippet([]byte(res.Content))),
	}, nil
}

// aiTest To connect the forms「Test AI Connection」Action use: Try with the currently absorbed connecting parameters.
func aiTest() (any, *dbxpluginsdk.PluginError) { return aiTestHandler(nil) }
