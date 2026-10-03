// DBX MD Note — Native sidecarGo，Pure Standard Library + Official Go SDK）
//
// Storage Modelv2 Start:
//   - Every note. = Real under Storage Directory .md File「Folder Level/Title.md」Discard
//   - Each Folder = Real Subdirectories under Storage Directory
//   - Structure/Index = Under Storage Directory .mdnotes/meta.json（Only id/Name/parent relationship/Path/timestamp + UI Status, without text)
//
// Why are you doing this?
//   - Single notes.json Read and write when data is big/High risk of damage; independent of each note after breaking into a real file, open directly in an external editor, accessible grep。
//   - notes/save Rewrite Only「Change of content.」, the rest of the note file (Hashi Cache) remains unmovable and is written to be controlled.
//
// Plugin for Enduring Channels: UI Run in sandboxed iframe The only reliable persistence path is
// dbxPlugin.invoke(...) → This process writes disks. The frontend does not touch the disk.
package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	dbxpluginsdk "github.com/lwai/mdnotes/dbxsdk"
)

// must match manifest.json id / version It's all the same, or the host decides. Sidecar Identity does not match and is discarded.
const (
	pluginID      = "com.lwai.mdnotes"
	pluginVersion = "0.8.4" // only for the bottom;run in packages manifest.json Other Organiser resolveMetadata）
)

type plugin struct {
	mutex       sync.Mutex
	connections map[string]struct{}
}

type RPCError = dbxpluginsdk.PluginError

func badParams(format string, args ...any) *dbxpluginsdk.PluginError {
	return dbxpluginsdk.NewError(-32602, fmt.Sprintf(format, args...))
}

func failed(code int, err error) *dbxpluginsdk.PluginError {
	return dbxpluginsdk.NewError(code, err.Error())
}

// ---------------- Distribution requested ----------------

func (plugin *plugin) Handle(
	_ dbxpluginsdk.RequestContext,
	method string,
	params json.RawMessage,
	_ *dbxpluginsdk.Emitter,
) (any, *dbxpluginsdk.PluginError) {
	if method != "notes/save" {
		absorbParams(params)
	}

	var values map[string]any
	if len(params) > 0 {
		if err := json.Unmarshal(params, &values); err != nil {
			return nil, badParams("Invalid request parameters")
		}
	} else {
		values = map[string]any{}
	}

	switch method {
	case "connection/test":
		where := notesDir()
		if err := os.MkdirAll(where, 0o755); err != nil {
			return map[string]any{"success": false, "message": "Cannot write to the notes storage directory: " + err.Error()}, nil
		}
		return map[string]any{
			"success": true,
			"message": "MD Notes is ready. Notes will be saved as .md files and subfolders in the storage directory.",
		}, nil

	case "connection/connect":
		connectionID, pluginError := requestConnectionID(values)
		if pluginError != nil {
			return nil, pluginError
		}
		plugin.mutex.Lock()
		if plugin.connections == nil {
			// Defense:main() It'll be initialized, but any of it is. &plugin{} Constructed Caller (test, future reuse)
			// Write directly. nil map panic And take the whole side of the car.
			plugin.connections = map[string]struct{}{}
		}
		plugin.connections[connectionID] = struct{}{}
		plugin.mutex.Unlock()
		// absorbParams（Handle It's on the way. storage_dir；Here's another one.
		// Overwrite config The scene entered in string form.
		if d := connDirFromValues(values); d != "" {
			setDir(d)
		}
		// AI Configure also only from connecting parameters (filled) connection_secrets）。
		// First clear a bridge layer left by the previous connection: the current layer (panette save) is the user ' s choice in the machine and is retained.
		resetAIConn()
		absorbAIConfig(values)
		_ = os.MkdirAll(notesDir(), 0o755)
		_ = os.MkdirAll(metaDir(), 0o755)
		sidecarTrace(fmt.Sprintf("connection/connect id=%s configured=%v dir=%s",
			connectionID, dirConfigured(), notesDir()))
		// First Connection: Before Reconstruct notes.json Migration to reality .md File. Avoid old notes."Disappear."。
		tryMigrate()
		return map[string]any{
			"success":     true,
			"storagePath": notesDir(),
			"configured":  dirConfigured(),
		}, nil

	case "connection/disconnect":
		connectionID, pluginError := requestConnectionID(values)
		if pluginError != nil {
			return nil, pluginError
		}
		plugin.mutex.Lock()
		delete(plugin.connections, connectionID)
		plugin.mutex.Unlock()
		// Disconnect to empty memory AI key, avoids the previous connection certificate being reused by the next connection.
		resetAIConfig()
		return map[string]any{"success": true}, nil

	case "notes/ping":
		// The version must be reported. resolveMetadata()（In Run-time Read Package manifest）Other Organiser
		// The constant floats on the hair. ping The version is the frontend and the test to judge."Is it a new code to run?"Basis.
		return map[string]any{
			"ok": true, "plugin": pluginID, "version": resolveMetadata().Version,
			"storagePath": notesDir(),
			"configured":  dirConfigured(),
		}, nil

	case "notes/path":
		return map[string]any{"path": metaPath(), "dir": notesDir(), "configured": dirConfigured()}, nil

	case "notes/probe":
		// Light Scriptability Detection: Go Only .mdnotes/ Write a probe file, no index, no text.
		// Replace it with the front-end startup「Save a complete snapshot」——The latter will push the old snapshot of the example into a state of authority.
		// When multiple examples share the same directory, data is rolled back./Deletes the trigger point.
		if err := os.MkdirAll(metaDir(), 0o755); err != nil {
			return map[string]any{"ok": false, "dir": notesDir(), "error": err.Error()}, nil
		}
		probe := filepath.Join(metaDir(), ".write-probe")
		if err := os.WriteFile(probe, []byte(time.Now().Format(time.RFC3339)), 0o644); err != nil {
			return map[string]any{"ok": false, "dir": notesDir(), "error": err.Error()}, nil
		}
		return map[string]any{"ok": true, "dir": notesDir(), "configured": dirConfigured()}, nil

	case "notes/setDir":
		var p struct {
			Dir        string `json:"dir"`
			StorageDir string `json:"storage_dir"`
			Connection struct {
				ID string `json:"id"`
			} `json:"connection"`
		}
		if e := json.Unmarshal(params, &p); e != nil {
			return nil, badParams("invalid params: %v", e)
		}
		dir := firstNonEmpty(p.Dir, p.StorageDir)
		if strings.TrimSpace(dir) == "" {
			return nil, badParams("dir is empty")
		}
		setDir(dir)
		_ = os.MkdirAll(notesDir(), 0o755)
		_ = os.MkdirAll(metaDir(), 0o755)
		return map[string]any{"ok": true, "path": metaPath(), "dir": notesDir()}, nil

	case "notes/load":
		return notesLoad()

	case "notes/save":
		var p struct {
			Data       json.RawMessage `json:"data"`
			StorageDir string          `json:"storage_dir"`
			Dir        string          `json:"dir"`
		}
		if e := json.Unmarshal(params, &p); e != nil {
			return nil, badParams("invalid params: %v", e)
		}
		if dir := firstNonEmpty(p.StorageDir, p.Dir); dir != "" {
			setDir(dir)
		}
		if len(p.Data) == 0 {
			return nil, badParams("missing data")
		}
		if err := saveNotes(p.Data); err != nil {
			sidecarTrace(fmt.Sprintf("notes/save FAILED dir=%s bytes=%d err=%v", notesDir(), len(p.Data), err))
			return nil, failed(-32002, fmt.Errorf("save failed: %w", err))
		}
		sidecarTrace(fmt.Sprintf("notes/save ok dir=%s bytes=%d", notesDir(), len(p.Data)))
		return map[string]any{"ok": true, "path": metaPath(), "dir": notesDir()}, nil

	case "notes/exportNote":
		var p struct {
			ID string `json:"id"`
			// ToDisk=false（Default: Turn the byte back to the frontend by the host's original「Save As」dialogue box,
			// A user can choose a directory.ToDisk=true：Old behavior. Write it in the notes.
			// saveFile The bottom of the power.
			ToDisk bool `json:"toDisk"`
		}
		if e := json.Unmarshal(params, &p); e != nil {
			return nil, badParams("invalid params: %v", e)
		}
		return exportNote(p.ID, p.ToDisk)

	case "notes/backup":
		var p struct {
			Scope  string `json:"scope"`
			ToDisk bool   `json:"toDisk"`
		}
		if e := json.Unmarshal(params, &p); e != nil {
			return nil, badParams("invalid params: %v", e)
		}
		return backupNotes(p.Scope, p.ToDisk)

	case "notes/restore":
		var p struct {
			DataBase64 string `json:"dataBase64"`
			DryRun     bool   `json:"dryRun"`
		}
		if e := json.Unmarshal(params, &p); e != nil {
			return nil, badParams("invalid params: %v", e)
		}
		return restoreNotes(p.DataBase64, p.DryRun)

	case "ai/config":
		return aiConfigView(), nil

	case "ai/setConfig":
		return aiSetConfigHandler(params)

	case "ai/resetConfig":
		return aiResetConfigHandler()

	case "ai/test":
		// Parameters with a group"Unsaved Configuration"For trial reconnection (empty fields follow current active values)
		return aiTestHandler(params)

	case "ai/chat":
		return aiChatHandler(params)

	case "ui/getPrefs":
		return map[string]any{"prefs": loadPrefs()}, nil

	case "ui/setPrefs":
		return setPrefsHandler(params)

	case "connection/action":
		// Connect custom actions in the form (e. g.「Test AI Connection」）。Parameters are also complete connection
		// （It's perfect. connection_secrets），So absorb configurations before execution -- users can measure without saving them.
		var p struct {
			Action     map[string]any `json:"action"`
			Values     map[string]any `json:"values"`
			Connection map[string]any `json:"connection"`
			Provider   map[string]any `json:"provider"`
			Runtime    map[string]any `json:"runtime"`
		}
		_ = json.Unmarshal(params, &p)
		absorbAIConfig(map[string]any{
			"action": p.Action, "values": p.Values,
			"connection": p.Connection, "provider": p.Provider, "runtime": p.Runtime,
		})
		id := ""
		if p.Action != nil {
			id, _ = p.Action["id"].(string)
		}
		switch id {
		case "test-ai":
			return aiTest()
		default:
			return nil, badParams("Unknown connection action: %s", id)
		}

	case "filesystem/list":
		return callFs(fsList, params)
	case "filesystem/read":
		return callFs(fsRead, params)
	case "filesystem/write":
		return callFs(fsWrite, params)
	case "filesystem/createDirectory":
		return callFs(fsCreateDirectory, params)
	case "filesystem/delete":
		return callFs(fsDelete, params)
	case "filesystem/rename":
		return callFs(fsRename, params)

	case "contextMenu/com.lwai.mdnotes.newNoteForTable":
		return handleNewNoteForTable(params)

	default:
		return nil, dbxpluginsdk.MethodNotFound(method)
	}
}

type fsMethod func(json.RawMessage) (any, error)

func callFs(fn fsMethod, params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	res, err := fn(params)
	if err != nil {
		return nil, failed(-32003, err)
	}
	return res, nil
}

func requestConnectionID(values map[string]any) (string, *dbxpluginsdk.PluginError) {
	connection, _ := values["connection"].(map[string]any)
	if connectionID, _ := connection["id"].(string); connectionID != "" {
		return connectionID, nil
	}
	if connectionID, _ := values["connectionId"].(string); connectionID != "" {
		return connectionID, nil
	}
	return "", badParams("Missing connection id")
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

// ---------------- Storage Directory ----------------

var dirMu sync.Mutex
var currentDir string

var dirKeys = map[string]bool{
	"storage_dir":  true,
	"storageDir":   true,
	"storage_path": true,
	"storagePath":  true,
	"notes_dir":    true,
	"notesDir":     true,
	"notesdir":     true,
	"notes_dirs":   true,
}

func dataDir() string {
	if d := strings.TrimSpace(os.Getenv("DBX_PLUGIN_DATA_DIR")); d != "" {
		return d
	}
	if d := strings.TrimSpace(os.Getenv("DBX_PLUGIN_SPACE")); d != "" {
		return d
	}
	if base, err := os.UserConfigDir(); err == nil && base != "" {
		return filepath.Join(base, "dbx", "plugins", pluginID)
	}
	return filepath.Join(".", "data")
}

func metaDir() string  { return filepath.Join(notesDir(), ".mdnotes") }
func metaPath() string { return filepath.Join(metaDir(), "meta.json") }

// sidecarTrace Add a line of diagnostic records to <dataDir>/sidecar-trace.log（best-effort，I'll never stop my business.
//
// Why do you need it? Did the sidecar actually get pulled up by the host? Did you get it? storage_dir、Did you come? notes/save，
// Only the sidecar knows. It's a problem. It's a good way to locate the link. UI Side blind guess.
// Over 64KB The whole of the time is emptied to prevent unlimited growth.
func sidecarTrace(msg string) {
	path := filepath.Join(dataDir(), "sidecar-trace.log")
	if st, err := os.Stat(path); err == nil && st.Size() > 64*1024 {
		_ = os.Remove(path)
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer func() { _ = f.Close() }()
	_, _ = fmt.Fprintf(f, "%s  %s\n", time.Now().Format("2006-01-02 15:04:05"), msg)
}

func loadConfig() {
	b, err := os.ReadFile(filepath.Join(dataDir(), "config.json"))
	if err != nil {
		return
	}
	var c map[string]any
	if json.Unmarshal(b, &c) != nil {
		return
	}
	if v, ok := c["storage_dir"].(string); ok && strings.TrimSpace(v) != "" {
		currentDir = strings.TrimSpace(v)
	}
}

func setDir(d string) {
	d = strings.TrimSpace(d)
	if d == "" {
		return
	}
	dirMu.Lock()
	same := currentDir == d
	currentDir = d
	dirMu.Unlock()
	if same {
		return
	}
	if err := os.MkdirAll(dataDir(), 0o755); err == nil {
		if b, e := json.Marshal(map[string]any{"storage_dir": d}); e == nil {
			_ = os.WriteFile(filepath.Join(dataDir(), "config.json"), b, 0o644)
		}
	}
}

func absorbDir(v any) {
	switch t := v.(type) {
	case map[string]any:
		for k, val := range t {
			if dirKeys[k] {
				if s, ok := val.(string); ok && strings.TrimSpace(s) != "" {
					setDir(s)
				}
			}
		}
		for _, val := range t {
			absorbDir(val)
		}
	case []any:
		for _, item := range t {
			absorbDir(item)
		}
	}
}

func absorbParams(raw json.RawMessage) {
	if len(raw) == 0 {
		return
	}
	var v any
	if json.Unmarshal(raw, &v) != nil {
		return
	}
	absorbDir(v)
}

func notesDir() string {
	dirMu.Lock()
	d := currentDir
	dirMu.Unlock()
	if strings.TrimSpace(d) == "" {
		return dataDir()
	}
	return d
}

// dirConfigured Whether the report really has a user specified memory directory (not back to hidden default) dataDir）。
// This is how the frontends determine whether to pop up.「Unconfigured Storage Directory」Visible alarm.
func dirConfigured() bool {
	dirMu.Lock()
	d := currentDir
	dirMu.Unlock()
	return strings.TrimSpace(d) != ""
}

/* ---------------- UI Preferences<dataDir>/prefs.json） ----------------
 *
 * Here, not here. localStorage：In the sandbox. window.origin yes "null"（opaque origin），
 * Visits localStorage It'll just throw. SecurityError。
 * Put it here instead of the notes. / meta.json：Panel width is"The interface on this machine is preferred."，
 * It's not a note data -- it's not supposed to follow the notes directory, let alone overlay each other in multiple cases.
 */
var prefKeys = map[string]bool{"sidebarWidth": true, "aiWidth": true, "aiPanelOpen": true}

func prefsPath() string { return filepath.Join(dataDir(), "prefs.json") }

func clampPrefWidth(v int) int {
	if v < 180 {
		return 180
	}
	if v > 720 {
		return 720
	}
	return v
}

// sanitizePrefs Only the white list key is maintained and the value is applied to a reasonable range (bad value should not be stuck).
//
// Note: This function will be called twice (after readout, combined with the previous one) and the width obtained twice already is
// int Not JSON It's solved. float64 —— So values must be recognized for both types. Just admit it. float64 And then,
// The second time, they'll be the keys."Bad value"Dropped (quietly disassembled, measured).
func sanitizePrefs(in map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range in {
		if !prefKeys[k] {
			continue
		}
		switch k {
		case "sidebarWidth", "aiWidth":
			n, ok := prefInt(v)
			if !ok {
				continue
			}
			out[k] = clampPrefWidth(n)
		case "aiPanelOpen":
			b, ok := v.(bool)
			if !ok {
				continue
			}
			out[k] = b
		}
	}
	return out
}

func prefInt(v any) (int, bool) {
	switch t := v.(type) {
	case float64:
		return int(t), true
	case int:
		return t, true
	case json.Number:
		if n, err := t.Int64(); err == nil {
			return int(n), true
		}
	}
	return 0, false
}

func loadPrefs() map[string]any {
	out := map[string]any{}
	b, err := os.ReadFile(prefsPath())
	if err != nil {
		return out
	}
	var m map[string]any
	if json.Unmarshal(b, &m) != nil {
		return out
	}
	return sanitizePrefs(m)
}

func setPrefsHandler(raw json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var p struct {
		Prefs map[string]any `json:"prefs"`
	}
	if e := json.Unmarshal(raw, &p); e != nil {
		return nil, badParams("invalid params: %v", e)
	}
	cur := loadPrefs()
	for k, v := range p.Prefs {
		if prefKeys[k] {
			cur[k] = v
		}
	}
	cur = sanitizePrefs(cur) // Write it when it's normalized, and avoid dropping the bad value from the frontend.
	if err := os.MkdirAll(dataDir(), 0o755); err != nil {
		return nil, failed(-32012, fmt.Errorf("Cannot save interface preferences: %v", err))
	}
	b, err := json.MarshalIndent(cur, "", "  ")
	if err != nil {
		return nil, failed(-32012, fmt.Errorf("Cannot save interface preferences: %v", err))
	}
	if err := writeAtomic(prefsPath(), append(b, '\n')); err != nil {
		return nil, failed(-32012, fmt.Errorf("Cannot save interface preferences: %v", err))
	}
	return map[string]any{"prefs": cur}, nil
}

// connDirFromValues From connection/connect The parameters to be taken out as smoothly as possible. storage_dir。
// Overwrite: Top Layer storage_dir、config/external_config/connection Embedded objects, and config Here.
// String in ("storage_dir=..." or JSON The situation.absorbParams I've done a back scan.
// This is complemented by avoiding silent loss of the directory when the host passes in an unexpected form.
func connDirFromValues(values map[string]any) string {
	cands := []any{
		values["storage_dir"], values["storageDir"],
		values["config"], values["external_config"], values["connection"],
	}
	for _, c := range cands {
		if c == nil {
			continue
		}
		switch t := c.(type) {
		case string:
			s := strings.TrimSpace(t)
			if s != "" && !strings.ContainsAny(s, "={}:") {
				return s
			}
			// Like "storage_dir=D:\notes&name=..."
			if i := strings.Index(t, "storage_dir="); i >= 0 {
				rest := t[i+len("storage_dir="):]
				if e := strings.IndexAny(rest, "&\""); e >= 0 {
					rest = rest[:e]
				}
				if v := strings.TrimSpace(rest); v != "" {
					return v
				}
			}
		case map[string]any:
			for _, k := range []string{"storage_dir", "storageDir", "storage_path", "storagePath", "notes_dir", "notesDir"} {
				if v, ok := t[k].(string); ok && strings.TrimSpace(v) != "" {
					return strings.TrimSpace(v)
				}
			}
		}
	}
	return ""
}

// tryMigrate Rebuild the pre-reform. notes.json（Single file, front-end snapshot. Move to new.
// 「Real .md Documentation + .mdnotes/meta.json」Models. Only when meta.json It's not there yet.
// Duplication of migration; any resolution/Write error skips and does not prevent normal startup.
func tryMigrate() {
	if metaExists() {
		return
	}
	seen := map[string]bool{}
	for _, base := range []string{dataDir(), notesDir()} {
		old := filepath.Join(base, "notes.json")
		if seen[old] {
			continue
		}
		seen[old] = true
		b, err := os.ReadFile(old)
		if err != nil {
			continue
		}
		var s snap
		if json.Unmarshal(b, &s) != nil || len(s.Nodes) == 0 {
			continue
		}
		if err := saveNotes(b); err != nil {
			continue
		}
		_ = os.Rename(old, old+".migrated")
		return
	}
}

// ---------------- Metadata structure ----------------

type MetaNode struct {
	ID        string  `json:"id"`
	Type      string  `json:"type"` // "folder" | "note"
	Name      string  `json:"name"`
	ParentID  *string `json:"parentId"`
	CreatedAt string  `json:"createdAt,omitempty"`
	UpdatedAt string  `json:"updatedAt,omitempty"`
	File      string  `json:"file"` // Path to relative store directory: Notes "x.md"，Folder "x"
}

type Meta struct {
	Version  int             `json:"version"`
	Nodes    []MetaNode      `json:"nodes"`
	ActiveID string          `json:"activeId,omitempty"`
	Expanded map[string]bool `json:"expanded,omitempty"`
	View     string          `json:"view,omitempty"`
}

func loadMeta() Meta {
	b, err := os.ReadFile(metaPath())
	if err != nil {
		return Meta{Version: 2, Nodes: []MetaNode{}}
	}
	var m Meta
	if json.Unmarshal(b, &m) != nil {
		return Meta{Version: 2, Nodes: []MetaNode{}}
	}
	if m.Nodes == nil {
		m.Nodes = []MetaNode{}
	}
	return m
}

func metaExists() bool {
	_, err := os.Stat(metaPath())
	return err == nil
}

func saveMeta(m Meta) error {
	if m.Version == 0 {
		m.Version = 2
	}
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(metaPath(), b)
}

// ---------------- Filename Tool ----------------

func sanitizeName(name string) string {
	s := strings.TrimSpace(name)
	if s == "" {
		s = "untitled"
	}
	repl := strings.NewReplacer("/", "_", "\\", "_", ":", "_", "*", "_", "?", "_",
		"\"", "_", "<", "_", ">", "_", "|", "_")
	s = repl.Replace(s)
	s = strings.Trim(s, ". ")
	if s == "" {
		s = "untitled"
	}
	if len(s) > 120 {
		s = s[:120]
	}
	return s
}

// absUnique Back abs original value when it does not exist; if it exists, add " (2)" Wait a minute.
func absUnique(abs string) string {
	if _, err := os.Stat(abs); os.IsNotExist(err) {
		return abs
	}
	ext := filepath.Ext(abs)
	base := abs[:len(abs)-len(ext)]
	for i := 2; ; i++ {
		cand := base + " (" + strconv.Itoa(i) + ")" + ext
		if _, err := os.Stat(cand); os.IsNotExist(err) {
			return cand
		}
	}
}

func toRel(root, abs string) string {
	r, err := filepath.Rel(root, abs)
	if err != nil {
		return filepath.Base(abs)
	}
	return r
}

// ---------------- Content Hashi Cache (duplicate disk) ----------------

var hashMu sync.Mutex

// contentHashes key It's the absolute path, not the node. id。
//
// Use id Do it. key There's a real scene missing: users put「Note Storage Directory」After the new directory, the same id The notes are here.
// The new directory doesn't exist yet, but the cache is still in the memory.「Here. id The content hasn't changed.」→ Skip the entire writing disk while saving → Notes in the new directory
// It just disappeared. By Path key It fits.「Same file. Same text.」The true semantic of that sentence.
var contentHashes = map[string]string{}

func contentHash(content string) string {
	h := sha256.Sum256([]byte(content))
	return fmt.Sprintf("%x", h)
}

// isUnchanged Back true configuration abs Document content and content Unanimously (does not need to be rewritten).
func isUnchanged(abs, hs string) bool {
	hashMu.Lock()
	if c, ok := contentHashes[abs]; ok && c == hs {
		hashMu.Unlock()
		return true
	}
	hashMu.Unlock()
	if data, err := os.ReadFile(abs); err == nil {
		if contentHash(string(data)) == hs {
			hashMu.Lock()
			contentHashes[abs] = hs
			hashMu.Unlock()
			return true
		}
	}
	return false
}

func writeContent(abs, content string) error {
	if err := writeAtomic(abs, []byte(content)); err != nil {
		return err
	}
	hashMu.Lock()
	contentHashes[abs] = contentHash(content)
	hashMu.Unlock()
	return nil
}

// ---------------- Note snapshot (frontend in) ----------------

type snapNode struct {
	ID       string  `json:"id"`
	Type     string  `json:"type"`
	Name     string  `json:"name"`
	ParentID *string `json:"parentId"`
	// Content With a pointer:nil = 「No text this time.」，Backends never write disks.
	//
	// Why not? string：string Zero values are empty, with「The user really cleared the text.」Can't be distinguished.
	// Once the frontend can't get the text because a file can't read it, the snapshot will be an empty string.
	// Overwrite the text on the disk while saving -- this is「The notes were emptied.」Mechanisms.
	// I don't know.「Ignore Fields」You can express it."Don't touch it."，No additional markers are required.
	Content   *string `json:"content"`
	CreatedAt string  `json:"createdAt"`
	UpdatedAt string  `json:"updatedAt"`
}

type snap struct {
	Version int        `json:"version"`
	Nodes   []snapNode `json:"nodes"`
	// DeletedIDs It's the node to be deleted from the front-end declaration. id（Deletes a folder containing all its children.
	//
	// Never.「No, I'm not. Nodes Lee.」Considers it deleted: a storage directory may be linked to multiple at the same time/The example is used.
	// The snapshots in the old ones are naturally missing the notes that the other party just built, and it deletes them as soon as it's saved.
	// （2026-09-21 Accident: Repeat connection to one directory → Some of the notes were emptied.
	// Replace semantic with「Unknown ≠ To delete」Thereafter, such acts cannot be repeated.
	DeletedIDs []string        `json:"deletedIds"`
	ActiveID   string          `json:"activeId"`
	Expanded   map[string]bool `json:"expanded"`
	View       string          `json:"view"`
}

// computeRelPath Directed relative path by parent-son chain (file name already exists) sanitize）。
func computeRelPath(n snapNode, byID map[string]snapNode) string {
	var segs []string
	pid := n.ParentID
	guard := 0
	for pid != nil && guard < 64 {
		p, ok := byID[*pid]
		if !ok {
			break
		}
		segs = append([]string{sanitizeName(p.Name)}, segs...)
		pid = p.ParentID
		guard++
	}
	name := sanitizeName(n.Name)
	if n.Type == "note" {
		return filepath.Join(append(segs, name+".md")...)
	}
	return filepath.Join(segs...)
}

// trashPath Give「Trash」is the target path.
//
// Delete without mandatory deletion: Move to <storage_dir>/.mdnotes/trash/<timestamp>/<Original relative path>。
// Any such error (old snapshots, examples, later logic) bug）It's still coming back.
// The price is just an extra historical copy on the disk.
func trashPath(root, rel string) string {
	stamp := time.Now().Format("20060102-150405")
	return filepath.Join(root, ".mdnotes", "trash", stamp, rel)
}

func saveNotes(raw json.RawMessage) error {
	var s snap
	if err := json.Unmarshal(raw, &s); err != nil {
		return err
	}
	if s.Nodes == nil {
		s.Nodes = []snapNode{}
	}
	root := notesDir()
	if err := os.MkdirAll(metaDir(), 0o755); err != nil {
		return err
	}

	prev := loadMeta()
	prevByID := map[string]MetaNode{}
	for _, n := range prev.Nodes {
		prevByID[n.ID] = n
	}
	inByID := map[string]snapNode{}
	incomingSet := map[string]bool{}
	for _, n := range s.Nodes {
		inByID[n.ID] = n
		incomingSet[n.ID] = true
	}
	deletedSet := map[string]bool{}
	for _, id := range s.DeletedIDs {
		deletedSet[id] = true
	}

	// 1) Delete: Only for the front-end [manifest] declaration to delete id，And move to the trash, not delete.
	//
	// It used to be here.「If you're not in the snapshot, delete the file.」，Semantic equals「I haven't seen it.」Consider it...
	// 「User to delete」—— When a memory directory is opened with two connections, the example that is then opened only once
	// （Open the counter and save it) and remove the newly created notes from the disk.
	// Now: Unknown ≠ To delete; to delete really has to be explicit.
	trashed := 0
	seenTrashDir := false
	for id := range deletedSet {
		old, ok := prevByID[id]
		if !ok || strings.TrimSpace(old.File) == "" {
			continue
		}
		abs := filepath.Join(root, old.File)
		if _, err := os.Stat(abs); err != nil {
			continue // It's not on the disk.
		}
		dst := trashPath(root, old.File)
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			continue
		}
		if err := os.Rename(abs, dst); err != nil {
			// [No deletion]: It is preferable to leave an orphan document without irreversible destruction.
			sidecarTrace(fmt.Sprintf("notes/save trash FAILED rel=%s err=%v (original file preserved)", old.File, err))
			continue
		}
		trashed++
		seenTrashDir = true
	}
	if seenTrashDir {
		sidecarTrace(fmt.Sprintf("notes/save trashed=%d dir=%s", trashed, filepath.Join(root, ".mdnotes", "trash")))
	}

	// 2) Notes: New/Move File + Write disks only when content changes
	result := []MetaNode{}
	for _, n := range s.Nodes {
		if n.Type != "note" || deletedSet[n.ID] {
			continue
		}
		mn := MetaNode{ID: n.ID, Type: "note", Name: n.Name, ParentID: n.ParentID, CreatedAt: n.CreatedAt, UpdatedAt: n.UpdatedAt}
		rel := computeRelPath(n, inByID)
		absTarget := filepath.Join(root, rel)
		old, existed := prevByID[n.ID]
		if !existed {
			absTarget = absUnique(absTarget)
			_ = os.MkdirAll(filepath.Dir(absTarget), 0o755)
		} else if rel != old.File {
			absTarget = absUnique(filepath.Join(root, rel))
			_ = os.MkdirAll(filepath.Dir(absTarget), 0o755)
			_ = os.Rename(filepath.Join(root, old.File), absTarget)
		}
		mn.File = toRel(root, absTarget)
		// Content == nil：No text this time. / I'm not going to change.→ No blanks will be used to overwrite disks.
		if n.Content != nil {
			hs := contentHash(*n.Content)
			if !isUnchanged(absTarget, hs) {
				if err := writeContent(absTarget, *n.Content); err != nil {
					return err
				}
			}
		}
		result = append(result, mn)
	}

	// 3) Folder: New/Move directory (subheading already 2 Step to new position, just clean the old directory)
	for _, n := range s.Nodes {
		if n.Type != "folder" || deletedSet[n.ID] {
			continue
		}
		mn := MetaNode{ID: n.ID, Type: "folder", Name: n.Name, ParentID: n.ParentID, CreatedAt: n.CreatedAt, UpdatedAt: n.UpdatedAt}
		rel := computeRelPath(n, inByID)
		old, existed := prevByID[n.ID]
		if !existed {
			_ = os.MkdirAll(filepath.Join(root, rel), 0o755)
			mn.File = rel
		} else if rel != old.File {
			_ = os.MkdirAll(filepath.Join(root, rel), 0o755)
			// os.Remove Only empty directories; if there are retained subpoints (not in the snapshot) that cannot be deleted -- that's what we want.
			_ = os.Remove(filepath.Join(root, old.File))
			mn.File = rel
		} else {
			mn.File = old.File
		}
		result = append(result, mn)
	}

	// 4) Reservations: Nodes that are neither in snapshots nor explicitly deleted are retained as they are.
	//    They usually are.「Another connection./I just built it in the case.」——This example has not been seen and does not mean that users want to delete it.
	preserved := 0
	for _, old := range prev.Nodes {
		if incomingSet[old.ID] || deletedSet[old.ID] {
			continue
		}
		result = append(result, old)
		preserved++
	}

	if preserved > 0 {
		sidecarTrace(fmt.Sprintf("notes/save preserved=%d (absent from snapshot but not marked for deletion)", preserved))
	}

	newMeta := Meta{Version: s.Version, ActiveID: s.ActiveID, Expanded: s.Expanded, View: s.View, Nodes: result}
	return saveMeta(newMeta)
}

func notesLoad() (any, *dbxpluginsdk.PluginError) {
	tryMigrate()
	m := loadMeta()
	if len(m.Nodes) == 0 && !metaExists() {
		// First run: There is no data yet, let the frontend put the example pen Remember
		return map[string]any{
			"data":       nil,
			"path":       metaPath(),
			"dir":        notesDir(),
			"ok":         true,
			"configured": dirConfigured(),
			"pending":    takePending(),
		}, nil
	}
	nodes := []map[string]any{}
	for _, mn := range m.Nodes {
		node := map[string]any{
			"id":        mn.ID,
			"type":      mn.Type,
			"name":      mn.Name,
			"parentId":  mn.ParentID,
			"createdAt": mn.CreatedAt,
			"updatedAt": mn.UpdatedAt,
		}
		if mn.Type == "note" {
			if data, err := os.ReadFile(filepath.Join(notesDir(), mn.File)); err == nil {
				node["content"] = string(data)
			} else {
				// When you can't read the text, you can't return an empty string: the frontend will use it as an empty string."The body of the note."
				// Save it as it is and the body on the disk is emptied. It's clearly marked here. missing，
				// The frontend thus neither displays an editable empty note nor returns the blank.
				node["contentMissing"] = true
				sidecarTrace(fmt.Sprintf("notes/load content not availableable (frozen; will not write back): rel=%s err=%v", mn.File, err))
			}
			node["file"] = mn.File
		}
		nodes = append(nodes, node)
	}
	return map[string]any{
		"data": map[string]any{
			"version":  m.Version,
			"nodes":    nodes,
			"activeId": m.ActiveID,
			"expanded": m.Expanded,
			"view":     m.View,
		},
		"path":       metaPath(),
		"dir":        notesDir(),
		"ok":         true,
		"configured": dirConfigured(),
		"pending":    takePending(),
	}, nil
}

// ---------------- Export / Backup ----------------

// exportNote Export a single note.
//
// toDisk=false（Default: Return {name, fileName, dataBase64}，The frontend to the host's original.「Save As」
// Dialogue Writing Disk - This allows users to select their own directory and filename, rather than being plugged into the Note Storage Directory.
// toDisk=true：Old behavior. Generates a copy of it in the notes. .md A copy of the loop path (for the bottom).
func exportNote(id string, toDisk bool) (any, *dbxpluginsdk.PluginError) {
	if id == "" {
		return nil, badParams("missing id")
	}
	m := loadMeta()
	var node *MetaNode
	for i := range m.Nodes {
		if m.Nodes[i].ID == id && m.Nodes[i].Type == "note" {
			node = &m.Nodes[i]
			break
		}
	}
	if node == nil {
		return nil, badParams("note not found: " + id)
	}
	root := notesDir()
	src := filepath.Join(root, node.File)
	data, err := os.ReadFile(src)
	if err != nil {
		return nil, failed(-32004, fmt.Errorf("read note: %w", err))
	}
	fileName := sanitizeName(node.Name) + ".md"

	if !toDisk {
		return map[string]any{
			"ok":         true,
			"name":       node.Name,
			"fileName":   fileName,
			"dataBase64": base64.StdEncoding.EncodeToString(data),
			"bytes":      len(data),
		}, nil
	}

	dst := absUnique(filepath.Join(root, fileName))
	if dst != src {
		if err := writeAtomic(dst, data); err != nil {
			return nil, failed(-32004, fmt.Errorf("export note: %w", err))
		}
	}
	return map[string]any{"ok": true, "path": dst, "name": node.Name, "fileName": fileName}, nil
}

func subtreeIDs(m Meta, rootID string) map[string]bool {
	inc := map[string]bool{rootID: true}
	changed := true
	round := 0
	for changed && round < 64 {
		changed = false
		round++
		for _, n := range m.Nodes {
			if n.ParentID != nil && inc[*n.ParentID] && !inc[n.ID] {
				inc[n.ID] = true
				changed = true
			}
		}
	}
	return inc
}

// ---------------- Backup package format ----------------
//
// Package Layout and Disk Layout 1:1，So recovery is a simple copy, without any map:
//
//	mdnotes-backup.json    Backup meta-information (version) / Export Time / Current Storage Directory / Counted)
//	.mdnotes/meta.json     Directory tree index (structure, name, spread)
//	<Real .md Relative Path>     Text, with meta.json file Field by Word
//
// Backup is a collection of orphan files with no name and level -- so the index must go with the package.
const backupInfoName = "mdnotes-backup.json"
const backupMetaEntry = ".mdnotes/meta.json"

// backupInfo It's with the backup bag.「Configure」，For recovery to confirm where the bag came from and whether it was usable.
type backupInfo struct {
	Schema     string `json:"schema"`
	PluginID   string `json:"pluginId"`
	Version    string `json:"version"`
	ExportedAt string `json:"exportedAt"`
	StorageDir string `json:"storageDir"`
	Scope      string `json:"scope,omitempty"`
	Notes      int    `json:"notes"`
	Folders    int    `json:"folders"`
	MetaFile   string `json:"metaFile"`
}

// buildBackupZip Builds a backup package in memory.notes It's about packing the notes.scope is empty for the whole library.
func buildBackupZip(root string, m Meta, notes []MetaNode, folders int, scope string) []byte {
	var sb strings.Builder
	zw := zip.NewWriter(&writerCapture{&sb})

	info := backupInfo{
		Schema:     "dbx-md-notes/backup@1",
		PluginID:   pluginID,
		Version:    resolveMetadata().Version,
		ExportedAt: time.Now().Format(time.RFC3339),
		StorageDir: root,
		Scope:      scope,
		Notes:      len(notes),
		Folders:    folders,
		MetaFile:   backupMetaEntry,
	}
	if b, e := json.MarshalIndent(info, "", "  "); e == nil {
		if w, e2 := zw.Create(backupInfoName); e2 == nil {
			_, _ = w.Write(b)
		}
	}
	if b, e := os.ReadFile(metaPath()); e == nil {
		if w, e2 := zw.Create(backupMetaEntry); e2 == nil {
			_, _ = w.Write(b)
		}
	}
	for _, n := range notes {
		data, err := os.ReadFile(filepath.Join(root, n.File))
		if err != nil {
			data = []byte("")
		}
		// zip All entries with a positive slashzip I'm sorry.Windows filepath.Join Will give the back slash.
		w, e := zw.Create(filepath.ToSlash(n.File))
		if e != nil {
			continue
		}
		_, _ = w.Write(data)
	}
	_ = zw.Close()
	return []byte(sb.String())
}

func backupFileName(m Meta, scope string) string {
	if scope != "" {
		for _, n := range m.Nodes {
			if n.ID == scope {
				return sanitizeName(n.Name) + ".zip"
			}
		}
	}
	now := time.Now()
	return fmt.Sprintf("md-notes-backup-%04d%02d%02d-%02d%02d.zip",
		now.Year(), now.Month(), now.Day(), now.Hour(), now.Minute())
}

// backupNotes Construct a backup package.toDisk=false（Bytes returned to the frontend by the host's original「Save As」
// dialogue box (user-selected directory);toDisk=true is written into the Note Storage Directory and replays the path.
func backupNotes(scope string, toDisk bool) (any, *dbxpluginsdk.PluginError) {
	m := loadMeta()
	root := notesDir()

	var inc map[string]bool
	if scope != "" {
		inc = subtreeIDs(m, scope)
	}
	var notes []MetaNode
	folders := 0
	for _, n := range m.Nodes {
		if scope != "" && !inc[n.ID] {
			continue
		}
		if n.Type == "note" {
			notes = append(notes, n)
		} else {
			folders++
		}
	}
	if len(notes) == 0 && folders == 0 {
		return nil, failed(-32005, fmt.Errorf("nothing to backup"))
	}

	buf := buildBackupZip(root, m, notes, folders, scope)
	if len(buf) == 0 {
		return nil, failed(-32005, fmt.Errorf("nothing to backup"))
	}
	filename := backupFileName(m, scope)

	if toDisk {
		dst := absUnique(filepath.Join(root, filename))
		if err := writeAtomic(dst, buf); err != nil {
			return nil, failed(-32005, fmt.Errorf("write backup: %w", err))
		}
		return map[string]any{"ok": true, "path": dst, "dir": root, "count": len(notes)}, nil
	}
	return map[string]any{
		"ok":         true,
		"fileName":   filename,
		"dataBase64": base64.StdEncoding.EncodeToString(buf),
		"bytes":      len(buf),
		"count":      len(notes),
		"folders":    folders,
		"storageDir": root,
		"version":    resolveMetadata().Version,
	}, nil
}

// ---------------- Restore from Backup ----------------

// safeRelPath Put zip in which the entry name is standardized to「Secure Path to Relative Storage Directory」。
// Backup packages can be replaced by input and must be treated as untrustworthy data: absolute path, disc,`..` All rejected.
func safeRelPath(name string) (string, bool) {
	n := strings.TrimSpace(strings.ReplaceAll(name, "\\", "/"))
	if n == "" || strings.HasPrefix(n, "/") {
		return "", false
	}
	if len(n) >= 2 && n[1] == ':' {
		return "", false // "C:/..." Or something.
	}
	out := make([]string, 0, 8)
	for _, p := range strings.Split(n, "/") {
		switch p {
		case "", ".":
			continue
		case "..":
			return "", false
		}
		out = append(out, p)
	}
	if len(out) == 0 {
		return "", false
	}
	return strings.Join(out, "/"), true
}

// insideRoot Resolve the relative path to the absolute path and confirm that it did not eject root。
func insideRoot(root, rel string) (string, bool) {
	abs := filepath.Join(root, filepath.FromSlash(rel))
	r, err := filepath.Rel(root, abs)
	if err != nil || r == ".." || strings.HasPrefix(r, ".."+string(filepath.Separator)) {
		return "", false
	}
	if filepath.IsAbs(r) {
		return "", false
	}
	return abs, true
}

// restoreNotes From Backup zip Restore notes and configuration.
//
// dryRun=true Just parse and return what's in the bag. UI Let the user confirm) , don't leave the plate.
//
// Security design:
//  1. Article by Article Validation entry Path (see safeRelPath / insideRoot），Denys jump-out of entries in the storage directory;
//  2. Limit the number of entries and the total amount of depressed, avoid zip bomb；
//  3. Must contain .mdnotes/meta.json，Otherwise, you won't recognize this bag. zip Write down the library;
//  4. Automatically save a current status before overwrite pre-restore-*.zip，If you are wrong, you can go back.
//  5. Empty Hashi Cache after recovery, otherwise the subsequent storage will be due to「Cache says it hasn't changed.」And skip the writing disk.
func restoreNotes(dataBase64 string, dryRun bool) (any, *dbxpluginsdk.PluginError) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(dataBase64))
	if err != nil {
		return nil, badParams("Backup data is not valid base64: %v", err)
	}
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		return nil, badParams("Not a valid ZIP backup: %v", err)
	}

	const maxEntries = 20000
	const maxTotal = uint64(256) << 20 // Maximum total after depressure 256 MiB
	const maxFile = uint64(32) << 20   // Single file ceiling 32 MiB
	if len(zr.File) > maxEntries {
		return nil, badParams("Backup contains too many entries (%d)", len(zr.File))
	}

	root := notesDir()
	type item struct {
		zipName string
		rel     string
	}
	var items []item
	var metaBytes []byte
	var info backupInfo
	var total uint64

	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		rel, ok := safeRelPath(f.Name)
		if !ok {
			return nil, badParams("Backup contains an unsafe path: %s", f.Name)
		}
		if _, ok := insideRoot(root, rel); !ok {
			return nil, badParams("Backup path escapes the storage directory: %s", f.Name)
		}
		total += f.UncompressedSize64
		if total > maxTotal {
			return nil, badParams("Backup exceeds the maximum uncompressed size")
		}
		if f.UncompressedSize64 > maxFile {
			return nil, badParams("Backup file is too large: %s", f.Name)
		}

		switch rel {
		case backupInfoName:
			if rc, e := f.Open(); e == nil {
				b, _ := io.ReadAll(io.LimitReader(rc, 1<<20))
				_ = rc.Close()
				_ = json.Unmarshal(b, &info)
			}
			continue // meta-information is used only for echoes, and does not leave a disk
		case backupMetaEntry:
			rc, e := f.Open()
			if e != nil {
				return nil, failed(-32006, fmt.Errorf("read backup index: %w", e))
			}
			metaBytes, _ = io.ReadAll(io.LimitReader(rc, int64(maxFile)))
			_ = rc.Close()
			continue
		}
		if !strings.HasSuffix(strings.ToLower(rel), ".md") {
			continue // Accept only .md Text; the rest of the entries ignored, avoiding the inclusion of all sorts of things Library
		}
		items = append(items, item{zipName: f.Name, rel: rel})
	}

	if len(metaBytes) == 0 {
		return nil, badParams("Not an MD Notes backup (missing %s)", backupMetaEntry)
	}
	var bm Meta
	if err := json.Unmarshal(metaBytes, &bm); err != nil {
		return nil, badParams("Backup index is corrupt: %v", err)
	}
	// Backup may come from another operating system: the path separator in the index is unified by the current platform.
	// Otherwise...「Windows Backup → macOS Restore」You get a bunch of weird files with a backslash in the file name.
	migrated := false
	for i := range bm.Nodes {
		if bm.Nodes[i].File == "" {
			continue
		}
		fixed := filepath.FromSlash(strings.ReplaceAll(bm.Nodes[i].File, "\\", "/"))
		if fixed != bm.Nodes[i].File {
			bm.Nodes[i].File = fixed
			migrated = true
		}
	}
	if migrated {
		if b, e := json.MarshalIndent(bm, "", "  "); e == nil {
			metaBytes = b
		}
	}
	notes, folders := 0, 0
	for _, n := range bm.Nodes {
		if n.Type == "note" {
			notes++
		} else {
			folders++
		}
	}

	if dryRun {
		return map[string]any{
			"ok": true, "dryRun": true, "info": info,
			"files": len(items), "notes": notes, "folders": folders,
			"storageDir": root,
		}, nil
	}

	// Save a copy of the current state before overlaying, so that the wrong recovery can be returned.
	safety := ""
	if metaExists() {
		cur := loadMeta()
		var cnotes []MetaNode
		cf := 0
		for _, n := range cur.Nodes {
			if n.Type == "note" {
				cnotes = append(cnotes, n)
			} else {
				cf++
			}
		}
		if len(cnotes) > 0 {
			b := buildBackupZip(root, cur, cnotes, cf, "")
			p := absUnique(filepath.Join(root, "pre-restore-"+time.Now().Format("20060102-150405")+".zip"))
			if err := writeAtomic(p, b); err == nil {
				safety = p
			}
		}
	}

	byName := map[string]*zip.File{}
	for _, f := range zr.File {
		byName[f.Name] = f
	}

	written := 0
	for _, it := range items {
		f := byName[it.zipName]
		if f == nil {
			continue
		}
		abs, ok := insideRoot(root, it.rel)
		if !ok {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			return nil, failed(-32006, fmt.Errorf("create dir: %w", err))
		}
		rc, e := f.Open()
		if e != nil {
			return nil, failed(-32006, fmt.Errorf("open entry %s: %w", it.zipName, e))
		}
		data, e := io.ReadAll(io.LimitReader(rc, int64(maxFile)))
		_ = rc.Close()
		if e != nil {
			return nil, failed(-32006, fmt.Errorf("read entry %s: %w", it.zipName, e))
		}
		if e := writeAtomic(abs, data); e != nil {
			return nil, failed(-32006, fmt.Errorf("restore %s: %w", it.rel, e))
		}
		written++
	}

	// Index final: The whole text is in place and the index is switched.「Index to non-existent files」。
	if err := os.MkdirAll(metaDir(), 0o755); err != nil {
		return nil, failed(-32006, fmt.Errorf("create meta dir: %w", err))
	}
	if err := writeAtomic(metaPath(), metaBytes); err != nil {
		return nil, failed(-32006, fmt.Errorf("restore index: %w", err))
	}

	// The body of the disk has just been rewrited from the outside, and the Hashi cache must be invalidated, otherwise the subsequent memory will skip the writing disk.
	hashMu.Lock()
	contentHashes = map[string]string{}
	hashMu.Unlock()

	sidecarTrace(fmt.Sprintf("notes/restore ok dir=%s files=%d notes=%d safety=%s",
		root, written, notes, safety))
	return map[string]any{
		"ok": true, "files": written, "notes": notes, "folders": folders,
		"storageDir": root, "safetyPath": safety, "backup": info,
	}, nil
}

// writerCapture Put zip Write Memorystrings.Builder Byte packagings only.
type writerCapture struct{ w *strings.Builder }

func (c *writerCapture) Write(p []byte) (int, error) { return c.w.Write(p) }

// ---------------- Context to be addressed (table) -> New Notes)----------------

var pendingMu sync.Mutex
var pendingContext any

func setPending(v any) {
	pendingMu.Lock()
	pendingContext = v
	pendingMu.Unlock()
}

func takePending() any {
	pendingMu.Lock()
	defer pendingMu.Unlock()
	v := pendingContext
	pendingContext = nil
	return v
}

// ---------------- File System Protocolmdnotes://，Based on authentic documents)----------------
//
// Storage directories are the root of the virtual file system;.mdnotes The internal directory is hidden. Synchronize all writing operations meta.json，
// Ensure that the desk directory tree is consistent with what the file manager sees.

func splitURI(uri string) ([]string, error) {
	s := uri
	if i := strings.Index(s, "://"); i >= 0 {
		s = s[i+3:]
	} else if i := strings.Index(s, ":/"); i >= 0 {
		s = s[i+2:]
	}
	s = strings.Trim(s, "/")
	if s == "" {
		return nil, nil
	}
	segs := strings.Split(s, "/")
	for _, seg := range segs {
		if seg == ".." || seg == "" {
			return nil, fmt.Errorf("invalid path")
		}
	}
	return segs, nil
}

func entryOf(name, rel, kind string, size int, ct string) map[string]any {
	e := map[string]any{"name": name, "uri": "mdnotes:/" + rel, "kind": kind}
	if kind == "file" {
		e["size"] = size
		if ct != "" {
			e["contentType"] = ct
		}
	}
	return e
}

func fsList(params json.RawMessage) (any, error) {
	var p struct {
		URI string `json:"uri"`
	}
	if e := json.Unmarshal(params, &p); e != nil {
		return nil, e
	}
	segs, err := splitURI(p.URI)
	if err != nil {
		return nil, err
	}
	root := notesDir()
	dir := root
	if len(segs) > 0 {
		dir = filepath.Join(append([]string{root}, segs...)...)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	out := []map[string]any{}
	for _, e := range entries {
		if e.Name() == ".mdnotes" {
			continue
		}
		rel := filepath.Join(append(segs, e.Name())...)
		if e.IsDir() {
			out = append(out, entryOf(e.Name(), rel, "directory", 0, ""))
		} else if strings.EqualFold(filepath.Ext(e.Name()), ".md") {
			info, _ := e.Info()
			sz := 0
			if info != nil {
				sz = int(info.Size())
			}
			out = append(out, entryOf(e.Name(), rel, "file", sz, "text/markdown"))
		}
	}
	sort.Slice(out, func(i, j int) bool {
		return fmt.Sprint(out[i]["name"]) < fmt.Sprint(out[j]["name"])
	})
	return map[string]any{"entries": out}, nil
}

func fsRead(params json.RawMessage) (any, error) {
	var p struct {
		URI      string `json:"uri"`
		MaxBytes int    `json:"maxBytes"`
	}
	if e := json.Unmarshal(params, &p); e != nil {
		return nil, e
	}
	segs, err := splitURI(p.URI)
	if err != nil {
		return nil, err
	}
	if len(segs) == 0 {
		return nil, fmt.Errorf("not a file")
	}
	name := segs[len(segs)-1]
	if !strings.EqualFold(filepath.Ext(name), ".md") {
		return nil, fmt.Errorf("only .md files can be read")
	}
	root := notesDir()
	abs := filepath.Join(append([]string{root}, segs...)...)
	data, err := os.ReadFile(abs)
	if err != nil {
		return nil, err
	}
	truncated := false
	if p.MaxBytes > 0 && len(data) > p.MaxBytes {
		data = data[:p.MaxBytes]
		truncated = true
	}
	rel := filepath.Join(segs...)
	syncMetaFile(rel, string(data))
	return map[string]any{
		"dataBase64":  base64.StdEncoding.EncodeToString(data),
		"contentType": "text/markdown",
		"truncated":   truncated,
	}, nil
}

func fsWrite(params json.RawMessage) (any, error) {
	var p struct {
		URI        string `json:"uri"`
		DataBase64 string `json:"dataBase64"`
		Create     bool   `json:"create"`
		Overwrite  bool   `json:"overwrite"`
	}
	if e := json.Unmarshal(params, &p); e != nil {
		return nil, e
	}
	segs, err := splitURI(p.URI)
	if err != nil {
		return nil, err
	}
	if len(segs) == 0 {
		return nil, fmt.Errorf("cannot write root")
	}
	name := segs[len(segs)-1]
	if !strings.EqualFold(filepath.Ext(name), ".md") {
		return nil, fmt.Errorf("only .md files can be written")
	}
	raw, err := base64.StdEncoding.DecodeString(p.DataBase64)
	if err != nil {
		return nil, fmt.Errorf("invalid dataBase64: %v", err)
	}
	root := notesDir()
	abs := filepath.Join(append([]string{root}, segs...)...)
	rel := filepath.Join(segs...)
	_, statErr := os.Stat(abs)
	if statErr == nil && !p.Overwrite && !p.Create {
		return map[string]any{"success": false, "message": "target exists, overwrite not requested"}, nil
	}
	if statErr != nil && !p.Create && !p.Overwrite {
		return map[string]any{"success": false, "message": "file not found, create not requested"}, nil
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return nil, err
	}
	if err := writeAtomic(abs, raw); err != nil {
		return nil, err
	}
	syncMetaFile(rel, string(raw))
	nm := filepath.Base(rel)
	return map[string]any{
		"success": true,
		"entry":   entryOf(nm, rel, "file", len(raw), "text/markdown"),
	}, nil
}

func fsCreateDirectory(params json.RawMessage) (any, error) {
	var p struct {
		URI string `json:"uri"`
	}
	if e := json.Unmarshal(params, &p); e != nil {
		return nil, e
	}
	segs, err := splitURI(p.URI)
	if err != nil {
		return nil, err
	}
	if len(segs) == 0 {
		return nil, fmt.Errorf("cannot create root")
	}
	root := notesDir()
	abs := filepath.Join(append([]string{root}, segs...)...)
	rel := filepath.Join(segs...)
	if err := os.MkdirAll(abs, 0o755); err != nil {
		return nil, err
	}
	syncMetaDir(rel)
	nm := filepath.Base(rel)
	return map[string]any{"success": true, "entry": entryOf(nm, rel, "directory", 0, "")}, nil
}

func fsDelete(params json.RawMessage) (any, error) {
	var p struct {
		URI       string `json:"uri"`
		Recursive bool   `json:"recursive"`
	}
	if e := json.Unmarshal(params, &p); e != nil {
		return nil, e
	}
	segs, err := splitURI(p.URI)
	if err != nil {
		return nil, err
	}
	if len(segs) == 0 {
		return nil, fmt.Errorf("cannot delete root")
	}
	root := notesDir()
	abs := filepath.Join(append([]string{root}, segs...)...)
	rel := filepath.Join(segs...)
	info, statErr := os.Stat(abs)
	if statErr != nil {
		return map[string]any{"success": false, "message": "not found"}, nil
	}
	if info.IsDir() {
		if !p.Recursive {
			entries, _ := os.ReadDir(abs)
			for _, en := range entries {
				if en.Name() == ".mdnotes" {
					continue
				}
				return map[string]any{"success": false, "message": "directory not empty"}, nil
			}
		}
		if err := os.RemoveAll(abs); err != nil {
			return nil, err
		}
		removeMetaUnder(rel, true)
	} else {
		if err := os.Remove(abs); err != nil {
			return nil, err
		}
		removeMetaUnder(rel, false)
	}
	return map[string]any{"success": true}, nil
}

func fsRename(params json.RawMessage) (any, error) {
	var p struct {
		SourceURI string `json:"sourceUri"`
		TargetURI string `json:"targetUri"`
		Overwrite bool   `json:"overwrite"`
	}
	if e := json.Unmarshal(params, &p); e != nil {
		return nil, e
	}
	srcSegs, err := splitURI(p.SourceURI)
	if err != nil || len(srcSegs) == 0 {
		return nil, fmt.Errorf("invalid source")
	}
	dstSegs, err := splitURI(p.TargetURI)
	if err != nil || len(dstSegs) == 0 {
		return nil, fmt.Errorf("invalid target")
	}
	root := notesDir()
	srcAbs := filepath.Join(append([]string{root}, srcSegs...)...)
	dstAbs := filepath.Join(append([]string{root}, dstSegs...)...)
	srcRel := filepath.Join(srcSegs...)
	// If the target is an existing directory, move the source into it
	if dstInfo, e := os.Stat(dstAbs); e == nil && dstInfo.IsDir() {
		dstAbs = filepath.Join(dstAbs, filepath.Base(srcAbs))
	}
	if _, e := os.Stat(dstAbs); e == nil && !p.Overwrite {
		return map[string]any{"success": false, "message": "target exists"}, nil
	}
	if err := os.MkdirAll(filepath.Dir(dstAbs), 0o755); err != nil {
		return nil, err
	}
	if err := os.Rename(srcAbs, dstAbs); err != nil {
		return nil, err
	}
	dstRel := toRel(root, dstAbs)
	renameMeta(srcRel, dstRel)
	nm := filepath.Base(dstRel)
	kind := "directory"
	if !strings.EqualFold(filepath.Ext(nm), ".md") {
		kind = "directory"
	} else {
		kind = "file"
	}
	return map[string]any{"success": true, "entry": entryOf(nm, dstRel, kind, 0, "text/markdown")}, nil
}

// ---------------- meta Synchronize in two directions with the filesystem ----------------

func parentIDOf(rel string) *string {
	d := filepath.Dir(rel)
	if d == "." || d == "" || d == string(filepath.Separator) {
		return nil
	}
	root := notesDir()
	m := loadMeta()
	for i := range m.Nodes {
		if m.Nodes[i].File == d {
			id := m.Nodes[i].ID
			return &id
		}
	}
	_ = root
	return nil
}

func nameFromFile(rel string) string {
	base := filepath.Base(rel)
	return strings.TrimSuffix(base, filepath.Ext(base))
}

func syncMetaFile(rel, content string) {
	m := loadMeta()
	found := false
	for i := range m.Nodes {
		if m.Nodes[i].File == rel && m.Nodes[i].Type == "note" {
			m.Nodes[i].Name = nameFromFile(rel)
			m.Nodes[i].UpdatedAt = time.Now().Format(time.RFC3339)
			found = true
			break
		}
	}
	if !found {
		id := newID()
		m.Nodes = append(m.Nodes, MetaNode{
			ID:        id,
			Type:      "note",
			Name:      nameFromFile(rel),
			ParentID:  parentIDOf(rel),
			CreatedAt: time.Now().Format(time.RFC3339),
			UpdatedAt: time.Now().Format(time.RFC3339),
			File:      rel,
		})
		_ = content
	}
	_ = saveMeta(m)
}

func syncMetaDir(rel string) {
	m := loadMeta()
	for i := range m.Nodes {
		if m.Nodes[i].File == rel && m.Nodes[i].Type == "folder" {
			m.Nodes[i].Name = filepath.Base(rel)
			return
		}
	}
	m.Nodes = append(m.Nodes, MetaNode{
		ID:        newID(),
		Type:      "folder",
		Name:      filepath.Base(rel),
		ParentID:  parentIDOf(rel),
		CreatedAt: time.Now().Format(time.RFC3339),
		UpdatedAt: time.Now().Format(time.RFC3339),
		File:      rel,
	})
	_ = saveMeta(m)
}

func removeMetaUnder(rel string, isDir bool) {
	m := loadMeta()
	kept := m.Nodes[:0]
	for _, n := range m.Nodes {
		if isDir {
			if n.File == rel || strings.HasPrefix(n.File, rel+"/") {
				continue
			}
		} else {
			if n.File == rel {
				continue
			}
		}
		kept = append(kept, n)
	}
	m.Nodes = kept
	_ = saveMeta(m)
}

func renameMeta(srcRel, dstRel string) {
	m := loadMeta()
	for i := range m.Nodes {
		if m.Nodes[i].File == srcRel {
			m.Nodes[i].File = dstRel
			m.Nodes[i].Name = nameFromFile(dstRel)
			m.Nodes[i].ParentID = parentIDOf(dstRel)
		} else if strings.HasPrefix(m.Nodes[i].File, srcRel+"/") {
			m.Nodes[i].File = dstRel + m.Nodes[i].File[len(srcRel):]
		}
	}
	_ = saveMeta(m)
}

func newID() string {
	return fmt.Sprintf("n%d%x", time.Now().UnixNano(), rand.Uint32())
}

// ---------------- Right-click connection: for this table/View New Note ----------------

func handleNewNoteForTable(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var p struct {
		Connection struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"connection"`
		Object struct {
			Name    string `json:"name"`
			Type    string `json:"type"`
			Columns []struct {
				Name string `json:"name"`
				Type string `json:"type"`
			} `json:"columns"`
		} `json:"object"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, badParams("invalid params: %v", err)
	}

	tableName := firstNonEmpty(p.Object.Name, p.Connection.Name, p.Connection.ID)
	cols := make([]map[string]string, 0, len(p.Object.Columns))
	for _, c := range p.Object.Columns {
		cols = append(cols, map[string]string{"name": c.Name, "type": c.Type})
	}

	setPending(map[string]any{
		"tableName":  tableName,
		"objectType": firstNonEmpty(p.Object.Type, "table"),
		"columns":    cols,
		"at":         time.Now().UnixMilli(),
	})

	return map[string]any{
		"success": true,
		"message": "Table recorded: " + tableName + ". Open the MD Notes workbench to prefill a note template.",
	}, nil
}

// ---------------- Atom Writing ----------------

var tmpSeq uint64

func writeAtomic(path string, b []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	// tmp The name must be unique: the same memory directory may be written at the same time as the example of multiple sidecars (recreated)「Same directory」It's the connection.
	// Share a fixed namepath+".tmp"）It will allow both processes to cover each other's semi-finished products.
	// Even half of each other's content. rename As an official document - The result of the index damage may be that the vault has been wrongly deleted.
	tmp := fmt.Sprintf("%s.%d.%d.tmp", path, os.Getpid(), atomic.AddUint64(&tmpSeq, 1))
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// resolveMetadata Construct the identity declared to the host on startup.
//
// Key: Inside the bag manifest.json , the version takes precedence over the constant. The host refuses to shake hands when the two are incompatible.
// （Sidecar identity does not match manifest），And the number changes with each release.
// —— Once the hard-coding constant forgets to synchronize, the sidecar is discarded as a whole.「UI There's nothing in there.」。
// Look up from the directory where the executable is located manifest.json，Found and id Match it in its version.
// （Same dbx-plugin-NintyAPI resolveMetadata practice.
func resolveMetadata() dbxpluginsdk.Metadata {
	caps := []string{"connections", "notes", "filesystem"}
	fallback := dbxpluginsdk.Metadata{ID: pluginID, Version: pluginVersion, Capabilities: caps}
	exe, err := os.Executable()
	if err != nil {
		return fallback
	}
	dir := filepath.Dir(exe)
	for i := 0; i < 6; i++ {
		data, readErr := os.ReadFile(filepath.Join(dir, "manifest.json"))
		if readErr == nil {
			var m struct {
				ID      string `json:"id"`
				Version string `json:"version"`
			}
			// Only  id Same as this plugin manifest It's the right to rewrite the version and avoid misreading the rest of the host directory. manifest。
			if json.Unmarshal(data, &m) == nil && m.ID == pluginID && strings.TrimSpace(m.Version) != "" {
				fallback.Version = strings.TrimSpace(m.Version)
			}
			return fallback
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return fallback
}

func main() {
	loadConfig()
	loadAIConfigFromDisk()
	_ = os.MkdirAll(dataDir(), 0o755)
	cwd, _ := os.Getwd()
	sidecarTrace(fmt.Sprintf("start pid=%d dataDir=%s configured=%v dir=%s cwd=%s",
		os.Getpid(), dataDir(), dirConfigured(), notesDir(), cwd))

	metadata := resolveMetadata()
	server := dbxpluginsdk.NewServer(metadata, &plugin{connections: map[string]struct{}{}})
	if err := server.Serve(); err != nil {
		fmt.Fprintf(os.Stderr, "[mdnotes] %v\n", err)
		os.Exit(1)
	}
}
