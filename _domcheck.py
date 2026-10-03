# -*- coding: utf-8 -*-
"""Static Verification Frontend DOM References (with) _buildpkg.js The built-in self-censorship and the rules allow for a single quick run).

Rules:
  1) app.js Come in. `$("x").` —— Yeah. getElementById The result takes the attribute directly.x When it does not exist.
     `Cannot set properties of null`，And it's usually in... bindEvents/boot It starts with the whole thing.
     The interface sits dead.2026-09-21 Actual accident: all buttons fail + The notes never drop.
  2) `click("x", fn)` / `on("x", ev, fn)` It's secure, but if it doesn't, optional=true，
     Annotations「Elements that should exist」Missing, same as the police.
  3) index.html It was dropped. id They are listed separately (the category most easily missed).
"""
import re, io, os, sys

BASE = os.path.dirname(os.path.abspath(__file__))
html = io.open(os.path.join(BASE, "ui/index.html"), encoding="utf-8").read()
js = io.open(os.path.join(BASE, "ui/app.js"), encoding="utf-8").read()

html_live = re.sub(r"<!--.*?-->", "", html, flags=re.S)
live_ids = set(re.findall(r'\bid="([^"]+)"', html_live))
commented_ids = sorted(set(re.findall(r'\bid="([^"]+)"', html)) - live_ids)

# Remove the comment before scanning: the historical error code is quoted in the note, not taken seriously
js_code = re.sub(r"/\*.*?\*/", "", js, flags=re.S)
js_code = re.sub(r"^[ \t]*//.*$", "", js_code, flags=re.M)

bad = []            # (id, Annotations, Line Number)
for m in re.finditer(r'\$\("([^"]+)"\)\s*\.', js_code):
    rid = m.group(1)
    if rid not in live_ids:
        bad.append((rid, 'Right on. $("id") Remove Properties TypeError）', js_code[:m.start()].count("\n") + 1))

print("HTML Available id (%d)" % len(live_ids))
if commented_ids:
    print("It's been dropped. id: %s" % ", ".join(commented_ids))
print()
if bad:
    print("!! Unsafe citation (must be repaired):")
    for rid, why, ln in bad:
        print("   - #%-16s %s  (app.js Okay. %d)" % (rid, why, ln))
    sys.exit(1)
print("OK：No code to extract properties from missing elements.")

# The same name statement will be overridden by the later declaration: the silence that was first declared is invalid.
# 2026-09-21 Actual accidents:confirmModal Defined twice (a string, a array),
# The latter takes over the former. → Remove a string in the button and go straight in. `lines.join is not a function` Throw the wrong one.
# Assemble「Point deletes are not responding.」。The function name crashes do not have any hints, but only through static checks.
sigs = {}
for m in re.finditer(r'^  function (\w+)\s*\(', js_code, flags=re.M):
    sigs.setdefault(m.group(1), []).append(js_code[:m.start()].count("\n") + 1)
dupes = {k: v for k, v in sigs.items() if len(v) > 1}
if dupes:
    print("!! Duplicate function statement (the latter will cover the former and must change name):")
    for name, lines in dupes.items():
        print("   - %s  Defined on app.js Okay. %s" % (name, ", ".join(str(x) for x in lines)))
    sys.exit(1)
print("OK：No duplicate function declaration.")

# List of key elements (top diagnostic bars are offline and no longer required diag-* Elements)
CRITICAL = ["main", "store-status", "store-text",
            "tree", "editor", "title",
            "ai-panel", "aip-scroll", "aip-log", "aip-go", "aip-target", "aip-mode-none",
            "aip-view-chat", "aip-view-create", "ai-cfg-modal", "aic-save",
            "gutter-side", "gutter-ai"]
missing = [c for c in CRITICAL if c not in live_ids]
if missing:
    print("!! index.html Missing Key Elements: %s" % ", ".join(missing))
    sys.exit(1)
print("OK：Key elements are ready.")
