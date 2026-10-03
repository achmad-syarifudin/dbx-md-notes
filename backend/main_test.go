package main

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	dbxpluginsdk "github.com/lwai/mdnotes/dbxsdk"
)

func call(t *testing.T, method string, params any) any {
	t.Helper()
	raw, err := json.Marshal(params)
	if err != nil {
		t.Fatalf("marshal params: %v", err)
	}
	res, perr := (&plugin{}).Handle(dbxpluginsdk.RequestContext{}, method, raw, nil)
	if perr != nil {
		t.Fatalf("%s error: %s", method, perr.Message)
	}
	return res
}

func TestSaveLoadRenameMove(t *testing.T) {
	dir := t.TempDir()

	snap := map[string]any{
		"version":  2,
		"activeId": "n2",
		"expanded": map[string]bool{"n1": true},
		"view":     "split",
		"nodes": []map[string]any{
			{"id": "n1", "type": "folder", "name": "Example", "parentId": nil, "content": "", "createdAt": "c", "updatedAt": "u"},
			{"id": "n2", "type": "note", "name": "Welcome", "parentId": nil, "content": "# hello", "createdAt": "c", "updatedAt": "u"},
			{"id": "n3", "type": "note", "name": "Child note", "parentId": ptr("n1"), "content": "child body", "createdAt": "c", "updatedAt": "u"},
		},
	}
	call(t, "notes/save", map[string]any{"data": snap, "storage_dir": dir})

	// File should really drop
	rootNote := filepath.Join(dir, "Welcome.md")
	childNote := filepath.Join(dir, "Example", "Child note.md")
	if _, err := os.Stat(rootNote); err != nil {
		t.Fatalf("root note file missing: %v", err)
	}
	if _, err := os.Stat(childNote); err != nil {
		t.Fatalf("child note file missing: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, ".mdnotes", "meta.json")); err != nil {
		t.Fatalf("meta.json missing: %v", err)
	}

	// meta.json Text shall not be included
	metaBytes, _ := os.ReadFile(filepath.Join(dir, ".mdnotes", "meta.json"))
	if contains(string(metaBytes), "child body") || contains(string(metaBytes), "# hello") {
		t.Fatalf("meta.json must NOT contain note content, got:\n%s", metaBytes)
	}

	// load Should read back the text
	loadRes := call(t, "notes/load", map[string]any{"storage_dir": dir}).(map[string]any)
	data := loadRes["data"].(map[string]any)
	nodes := data["nodes"].([]map[string]any)
	if len(nodes) != 3 {
		t.Fatalf("expected 3 nodes, got %d", len(nodes))
	}
	byID := map[string]map[string]any{}
	for _, n := range nodes {
		m := n
		byID[m["id"].(string)] = m
	}
	if byID["n3"]["content"].(string) != "child body" {
		t.Fatalf("child content mismatch: %q", byID["n3"]["content"])
	}
	if byID["n2"]["file"].(string) != "Welcome.md" {
		t.Fatalf("n2 file path wrong: %q", byID["n2"]["file"])
	}

	// Rename n2 -> Documents should be renamed
	snap2 := cloneSnap(snap)
	for _, n := range snap2["nodes"].([]any) {
		m := n.(map[string]any)
		if m["id"] == "n2" {
			m["name"] = "Welcome (renamed)"
		}
	}
	call(t, "notes/save", map[string]any{"data": snap2, "storage_dir": dir})
	if _, err := os.Stat(filepath.Join(dir, "Welcome (renamed).md")); err != nil {
		t.Fatalf("renamed file missing: %v", err)
	}
	if _, err := os.Stat(rootNote); err == nil {
		t.Fatalf("old file should be gone after rename")
	}

	// Move n3 To Root DirectoryparentId=nil）
	snap3 := cloneSnap(snap)
	for _, n := range snap3["nodes"].([]any) {
		m := n.(map[string]any)
		if m["id"] == "n3" {
			m["parentId"] = nil
		}
	}
	call(t, "notes/save", map[string]any{"data": snap3, "storage_dir": dir})
	if _, err := os.Stat(filepath.Join(dir, "Child note.md")); err != nil {
		t.Fatalf("moved child file missing at root: %v", err)
	}
	if _, err := os.Stat(childNote); err == nil {
		t.Fatalf("old child path should be gone after move")
	}

	// Delete n2 After file should be removed
	snap4 := cloneSnap(snap)
	kept := []map[string]any{}
	for _, n := range snap4["nodes"].([]any) {
		m := n.(map[string]any)
		if m["id"] != "n2" {
			kept = append(kept, m)
		}
	}
	snap4["nodes"] = kept
	call(t, "notes/save", map[string]any{"data": snap4, "storage_dir": dir})
	if _, err := os.Stat(filepath.Join(dir, "Welcome (renamed).md")); err == nil {
		t.Fatalf("deleted note file should be gone")
	}
}

// seedLibrary dir Two notes down. + The library of a folder returns the node expectations for the backup.
func seedLibrary(t *testing.T, dir string) {
	t.Helper()
	snap := map[string]any{
		"version":  2,
		"activeId": "a",
		"nodes": []map[string]any{
			{"id": "f1", "type": "folder", "name": "Example", "parentId": nil, "content": "", "createdAt": "c", "updatedAt": "u"},
			{"id": "a", "type": "note", "name": "ANotes", "parentId": nil, "content": "aaa", "createdAt": "c", "updatedAt": "u"},
			{"id": "b", "type": "note", "name": "BNotes", "parentId": ptr("f1"), "content": "bbb", "createdAt": "c", "updatedAt": "u"},
		},
	}
	call(t, "notes/save", map[string]any{"data": snap, "storage_dir": dir})
}

func zipNames(t *testing.T, raw []byte) []string {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		t.Fatalf("zip Parsing failed:%v", err)
	}
	out := []string{}
	for _, f := range zr.File {
		out = append(out, f.Name)
	}
	return out
}

// DefaulttoDisk=false）The byte should be returned to the frontend, with the host 's originals remaining as a dialogue to drop the disc - it cannot be written by itself.
func TestBackupReturnsBytesWithConfig(t *testing.T) {
	dir := t.TempDir()
	seedLibrary(t, dir)

	res := call(t, "notes/backup", map[string]any{"storage_dir": dir}).(map[string]any)
	if res["ok"] != true {
		t.Fatalf("backup Failed:%v", res)
	}
	for _, k := range []string{"fileName", "dataBase64", "bytes", "count", "folders", "storageDir", "version"} {
		if _, ok := res[k]; !ok {
			t.Fatalf("backup Results are missing %q：%v", k, res)
		}
	}
	if _, ok := res["path"]; ok {
		t.Fatalf("Defaults should not write disks. path：%v", res)
	}
	if res["count"].(int) != 2 || res["folders"].(int) != 1 {
		t.Fatalf("Wrong count:count=%v folders=%v", res["count"], res["folders"])
	}

	raw, err := base64.StdEncoding.DecodeString(res["dataBase64"].(string))
	if err != nil {
		t.Fatalf("dataBase64 Not legal. base64：%v", err)
	}
	joined := strings.Join(zipNames(t, raw), "\n")
	// Configure with package: MetaInfo + Directory tree index; backup body only restores a pile of unnamed and ungraded orphan files.
	for _, want := range []string{backupInfoName, backupMetaEntry, "ANotes.md", "Example/BNotes.md"} {
		if !contains(joined, want) {
			t.Fatalf("Backup package missing %s，Actual entries:\n%s", want, joined)
		}
	}
}

// toDisk=true The host didn't. saveFile : Write in the storage directory and replay the path.
func TestBackupToDiskWritesZip(t *testing.T) {
	dir := t.TempDir()
	seedLibrary(t, dir)

	res := call(t, "notes/backup", map[string]any{"storage_dir": dir, "toDisk": true}).(map[string]any)
	if res["ok"] != true {
		t.Fatalf("backup(toDisk) Failed:%v", res)
	}
	path, _ := res["path"].(string)
	if path == "" {
		t.Fatalf("toDisk=true Recoverable path:%v", res)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("Backup zip No Crash:%v", err)
	}
	if !strings.HasSuffix(path, ".zip") {
		t.Fatalf("The backup file name should read .zip：%s", path)
	}
}

// Export a single section: Default returns bytes (self-selected directories)toDisk=true Only when you write in the storage directory.
func TestExportNoteModes(t *testing.T) {
	dir := t.TempDir()
	seedLibrary(t, dir)

	res := call(t, "notes/exportNote", map[string]any{"id": "a", "storage_dir": dir}).(map[string]any)
	if res["fileName"] != "ANotes.md" {
		t.Fatalf("Export filename:%v", res["fileName"])
	}
	b, err := base64.StdEncoding.DecodeString(res["dataBase64"].(string))
	if err != nil || string(b) != "aaa" {
		t.Fatalf("Export content is not correct:%v %q", err, b)
	}
	if _, ok := res["path"]; ok {
		t.Fatalf("Default export should not write disk:%v", res)
	}

	d := call(t, "notes/exportNote", map[string]any{"id": "a", "storage_dir": dir, "toDisk": true}).(map[string]any)
	if p, _ := d["path"].(string); p == "" {
		t.Fatalf("toDisk=true Recoverable path:%v", d)
	}
}

// Backup → Restores to another directory, text, level, index.
func TestRestoreRoundTrip(t *testing.T) {
	src := t.TempDir()
	seedLibrary(t, src)
	b64 := call(t, "notes/backup", map[string]any{"storage_dir": src}).(map[string]any)["dataBase64"].(string)

	dst := t.TempDir()
	call(t, "notes/save", map[string]any{
		"storage_dir": dst,
		"data": map[string]any{
			"version": 2,
			"nodes": []map[string]any{
				{"id": "z", "type": "note", "name": "Old Notes", "parentId": nil, "content": "zzz", "createdAt": "c", "updatedAt": "u"},
			},
		},
	})

	// dryRun Only in return, not in return.
	dry := call(t, "notes/restore", map[string]any{"storage_dir": dst, "dataBase64": b64, "dryRun": true}).(map[string]any)
	if dry["dryRun"] != true || dry["notes"].(int) != 2 || dry["folders"].(int) != 1 {
		t.Fatalf("dryRun The result is incorrect:%v", dry)
	}
	if _, err := os.Stat(filepath.Join(dst, "ANotes.md")); err == nil {
		t.Fatalf("dryRun No disk to write.")
	}

	out := call(t, "notes/restore", map[string]any{"storage_dir": dst, "dataBase64": b64}).(map[string]any)
	if out["ok"] != true {
		t.Fatalf("restore Failed:%v", out)
	}
	if safety, _ := out["safetyPath"].(string); safety == "" {
		t.Fatalf("A secure backup should be left before recovery:%v", out)
	} else if _, err := os.Stat(safety); err != nil {
		t.Fatalf("Secure backup file does not exist:%v", err)
	}

	if b, err := os.ReadFile(filepath.Join(dst, "ANotes.md")); err != nil || string(b) != "aaa" {
		t.Fatalf("The text of the note was not restored:%v %q", err, b)
	}
	if b, err := os.ReadFile(filepath.Join(dst, "Example", "BNotes.md")); err != nil || string(b) != "bbb" {
		t.Fatalf("Subdirectorial notes not recovered:%v %q", err, b)
	}

	loadRes := call(t, "notes/load", map[string]any{"storage_dir": dst}).(map[string]any)
	nodes := loadRes["data"].(map[string]any)["nodes"].([]map[string]any)
	if len(nodes) != 3 {
		t.Fatalf("The number of nodes after restoration shall read 3，Actual %d：%v", len(nodes), nodes)
	}
	var child *map[string]any
	for i := range nodes {
		if nodes[i]["id"] == "b" {
			child = &nodes[i]
		}
	}
	if child == nil {
		t.Fatalf("Not found after recovery id=b：%v", nodes)
	}
	if (*child)["content"].(string) != "bbb" {
		t.Fatalf("After recovery, the text was not answered:%q", (*child)["content"])
	}
	// parentId yes *string（The level must be restored. f1 Move!
	pid, ok := (*child)["parentId"].(*string)
	if !ok || pid == nil || *pid != "f1" {
		t.Fatalf("The recovery level is missing:parentId=%v", (*child)["parentId"])
	}
}

// Normal zip（No index for this plugin) has to be rejected or fed by mistake zip You can write down the library.
func TestRestoreRejectsForeignZip(t *testing.T) {
	var sb strings.Builder
	zw := zip.NewWriter(&writerCapture{&sb})
	w, _ := zw.Create("hello.txt")
	_, _ = w.Write([]byte("hi"))
	_ = zw.Close()
	b64 := base64.StdEncoding.EncodeToString([]byte(sb.String()))

	raw, _ := json.Marshal(map[string]any{"storage_dir": t.TempDir(), "dataBase64": b64})
	if _, perr := (&plugin{}).Handle(dbxpluginsdk.RequestContext{}, "notes/restore", raw, nil); perr == nil {
		t.Fatalf("Missing meta.json Normal zip It has to be rejected.")
	}
}

// The backup package is external input, and the path-crossing entry must be blocked before the writing disk.
func TestRestoreRejectsPathTraversal(t *testing.T) {
	var sb strings.Builder
	zw := zip.NewWriter(&writerCapture{&sb})
	if w, e := zw.Create("../../evil.md"); e == nil {
		_, _ = w.Write([]byte("pwn"))
	}
	if w, e := zw.Create(backupMetaEntry); e == nil {
		_, _ = w.Write([]byte(`{"version":2,"nodes":[]}`))
	}
	_ = zw.Close()
	b64 := base64.StdEncoding.EncodeToString([]byte(sb.String()))

	dir := t.TempDir()
	raw, _ := json.Marshal(map[string]any{"storage_dir": dir, "dataBase64": b64})
	if _, perr := (&plugin{}).Handle(dbxpluginsdk.RequestContext{}, "notes/restore", raw, nil); perr == nil {
		t.Fatalf("Ham ../../ entries must be rejected")
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(dir), "evil.md")); err == nil {
		t.Fatalf("Never write outside the memory directory")
	}
}

func TestSafeRelPath(t *testing.T) {
	for _, s := range []string{"", "/abs.md", "C:/x.md", `..\evil.md`, "a/../../b.md", "../x", "."} {
		if got, ok := safeRelPath(s); ok {
			t.Fatalf("It should be rejected. %q，But I let it go. %q", s, got)
		}
	}
	good := map[string]string{"a.md": "a.md", "Example/b.md": "Example/b.md", "./a.md": "a.md", "a//b.md": "a/b.md"}
	for in, want := range good {
		got, ok := safeRelPath(in)
		if !ok || got != want {
			t.Fatalf("safeRelPath(%q) = %q,%v；Expectations %q", in, got, ok, want)
		}
	}
}

func cloneSnap(s map[string]any) map[string]any {
	b, _ := json.Marshal(s)
	var out map[string]any
	_ = json.Unmarshal(b, &out)
	return out
}

func ptr(s string) *string { return &s }

// ---------------- Data secure return (%)2026-09-21 Accident: Repeated selection of one directory to build connection, notes emptied) ----------------

func metaNames(t *testing.T, dir string) map[string]string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, ".mdnotes", "meta.json"))
	if err != nil {
		t.Fatalf("Read meta Failed:%v", err)
	}
	var m struct {
		Nodes []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"nodes"`
	}
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("Parsing meta Failed:%v", err)
	}
	out := map[string]string{}
	for _, n := range m.Nodes {
		out[n.ID] = n.Name
	}
	return out
}

// Find files by filename in any subdirectories (a copy of the trash can also be found)
func findByName(t *testing.T, root, name string) string {
	t.Helper()
	hit := ""
	_ = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || hit != "" {
			return nil
		}
		if d.Name() == name {
			hit = p
		}
		return nil
	})
	return hit
}

func twoNotesSnapshot() map[string]any {
	return map[string]any{
		"version":  2,
		"activeId": "a",
		"nodes": []map[string]any{
			{"id": "f1", "type": "folder", "name": "Example", "parentId": nil, "createdAt": "c", "updatedAt": "u"},
			{"id": "a", "type": "note", "name": "ANotes", "parentId": nil, "content": "aaa", "createdAt": "c", "updatedAt": "u"},
			{"id": "b", "type": "note", "name": "BNotes", "parentId": ptr("f1"), "content": "bbb", "createdAt": "c", "updatedAt": "u"},
		},
	}
}

// When a directory is used by both connectors, the party that saves it is bound by「Old snapshot.」（Do not include newly created notes by the other party.
// Old realization「It's not in the snapshot.」Consider it...「To delete」，So the notes were actually deleted from the disk.
// New Semantic: Unknown ≠ To delete, only visible. deletedIds Just delete.
func TestSavePreservesNodesMissingFromSnapshot(t *testing.T) {
	dir := t.TempDir()
	seedLibrary(t, dir)

	// Simulate another example to add a new first 4 Nodes
	withNew := twoNotesSnapshot()
	withNew["nodes"] = append(withNew["nodes"].([]map[string]any), map[string]any{
		"id": "new", "type": "note", "name": "Add Note", "parentId": nil,
		"content": "new body", "createdAt": "c", "updatedAt": "u",
	})
	call(t, "notes/save", map[string]any{"storage_dir": dir, "data": withNew})

	// Old Snapshot 3 Save - Never「Add Note」Delete it.
	call(t, "notes/save", map[string]any{"storage_dir": dir, "data": twoNotesSnapshot()})

	if b, err := os.ReadFile(filepath.Join(dir, "Add Note.md")); err != nil || string(b) != "new body" {
		t.Fatalf("The undeclared deleted notes were removed:err=%v content=%q", err, b)
	}
	if _, ok := metaNames(t, dir)["new"]; !ok {
		t.Fatalf("The node should also be retained in the index:%v", metaNames(t, dir))
	}
}

// Node removed by a visible declaration: removed from the index, the text enters the trash (retributable), and is not deleted.
func TestSaveDeletesOnlyExplicitAndGoesToTrash(t *testing.T) {
	dir := t.TempDir()
	seedLibrary(t, dir)

	s := twoNotesSnapshot()
	delete(s, "activeId")
	// Just stay. a and f1，And make a visible statement and delete b
	s["nodes"] = []map[string]any{
		{"id": "f1", "type": "folder", "name": "Example", "parentId": nil, "createdAt": "c", "updatedAt": "u"},
		{"id": "a", "type": "note", "name": "ANotes", "parentId": nil, "content": "aaa", "createdAt": "c", "updatedAt": "u"},
	}
	s["deletedIds"] = []string{"b"}
	call(t, "notes/save", map[string]any{"storage_dir": dir, "data": s})

	names := metaNames(t, dir)
	if _, ok := names["b"]; ok {
		t.Fatalf("Declared deleted nodes are still in the index:%v", names)
	}
	if _, err := os.Stat(filepath.Join(dir, "Example", "BNotes.md")); err == nil {
		t.Fatalf("There should be no paper in place.")
	}
	trashed := findByName(t, filepath.Join(dir, ".mdnotes", "trash"), "BNotes.md")
	if trashed == "" {
		t.Fatalf("Delete should enter the trash instead of destroy, but .mdnotes/trash I can't find it.")
	}
	if b, err := os.ReadFile(trashed); err != nil || string(b) != "bbb" {
		t.Fatalf("The contents of the trash should be complete:err=%v content=%q", err, b)
	}
	// a Not affected
	if _, err := os.Stat(filepath.Join(dir, "ANotes.md")); err != nil {
		t.Fatalf("Notes that do not involve deletion should not be affected:%v", err)
	}
}

// I don't want it in the photo. content = 「Don't move the text this time.」。
// I can't take that as a yes.「The user cleared the text.」，Otherwise, any reading failure will clear the body of the disk.
func TestSaveWithoutContentKeepsFileContent(t *testing.T) {
	dir := t.TempDir()
	seedLibrary(t, dir)

	// Just change your name, no. content Fields
	s := map[string]any{
		"version": 2,
		"nodes": []map[string]any{
			{"id": "f1", "type": "folder", "name": "Example", "parentId": nil, "createdAt": "c", "updatedAt": "u"},
			{"id": "a", "type": "note", "name": "ANote change", "parentId": nil, "createdAt": "c", "updatedAt": "u"},
			{"id": "b", "type": "note", "name": "BNotes", "parentId": ptr("f1"), "createdAt": "c", "updatedAt": "u"},
		},
	}
	call(t, "notes/save", map[string]any{"storage_dir": dir, "data": s})

	b, err := os.ReadFile(filepath.Join(dir, "ANote change.md"))
	if err != nil {
		t.Fatalf("The renamed file should exist:%v", err)
	}
	if string(b) != "aaa" {
		t.Fatalf("Not content The saving changed the text:%q（For aaa）", b)
	}
}

// When the text cannot be read:load Must mark contentMissing，Not an empty string.
// （Empty strings will be used as frontends「The text is empty.」Saves as it is, empties the notes.
func TestLoadMarksMissingContentInsteadOfEmpty(t *testing.T) {
	dir := t.TempDir()
	seedLibrary(t, dir)

	if err := os.Remove(filepath.Join(dir, "ANotes.md")); err != nil {
		t.Fatalf("Could not remove the test note: %v", err)
	}
	res := call(t, "notes/load", map[string]any{"storage_dir": dir}).(map[string]any)
	nodes := res["data"].(map[string]any)["nodes"].([]map[string]any)
	var a map[string]any
	for _, n := range nodes {
		if n["id"] == "a" {
			a = n
		}
	}
	if a == nil {
		t.Fatalf("Nodes not found a")
	}
	if a["contentMissing"] != true {
		t.Fatalf("It must be marked when the text cannot be read contentMissing，Actual: %v", a)
	}
	if _, has := a["content"]; has {
		t.Fatalf("Do not return when the text cannot be read content Fields (empty strings are written back to overwhelm disk):%v", a["content"])
	}

	// Take this.「No text.」Scanning back: Can't create an empty file.
	call(t, "notes/save", map[string]any{"storage_dir": dir, "data": map[string]any{
		"version": 2,
		"nodes": []map[string]any{
			{"id": "f1", "type": "folder", "name": "Example", "parentId": nil, "createdAt": "c", "updatedAt": "u"},
			{"id": "a", "type": "note", "name": "ANotes", "parentId": nil, "createdAt": "c", "updatedAt": "u"},
			{"id": "b", "type": "note", "name": "BNotes", "parentId": ptr("f1"), "createdAt": "c", "updatedAt": "u"},
		},
	}})
	if _, err := os.Stat(filepath.Join(dir, "ANotes.md")); err == nil {
		t.Fatalf("It shouldn't be because「No text.」Just create an empty file.")
	}
	// It's not passive. B Still good.
	if b, err := os.ReadFile(filepath.Join(dir, "Example", "BNotes.md")); err != nil || string(b) != "bbb" {
		t.Fatalf("B The notes should be complete:err=%v %q", err, b)
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
