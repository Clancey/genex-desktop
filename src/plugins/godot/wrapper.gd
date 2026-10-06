# The GDScript Studio runs inside headless Godot for the check and export jobs.
# Contract: one stdout line, `STUDIO_GODOT_RESULT {json}`, with ok, mode and per-step issues.
# Modes: `check <report.json>`, `export <index.html> <templatesDir> <preset or "">` and the
# internal `scan`, which the check re-runs to load every project script.
extends SceneTree

const RESULT_PREFIX := "STUDIO_GODOT_RESULT "
const BOOT_FRAMES := 120
const MAX_ISSUES := 40
const POLL_MS := 50
const ISSUE_MARKERS := ["SCRIPT ERROR", "USER SCRIPT ERROR", "ERROR:", "Parse Error"]
# The job sandbox has no keychain: Godot logs this on every start, and it is not the project's error.
const IGNORED_ISSUES := ["get_system_ca_certificates"]
const WEB_PLATFORM := "Web"
const TEMPLATE_FILE := "templates/web_nothreads_release.zip"
const DEBUG_TEMPLATE_FILE := "templates/web_nothreads_debug.zip"


func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	var mode: String = args[0] if args.size() > 0 else ""
	var code := 2
	if mode == "scan":
		code = _scan()
	elif mode == "check" and args.size() == 2:
		code = _check(args[1])
	elif mode == "export" and args.size() == 4:
		code = _export(args[1], args[2], args[3])
	else:
		_finish({"ok": false, "mode": mode, "error": "Unknown wrapper call"})
	quit(code)


func _project() -> String:
	return ProjectSettings.globalize_path("res://")


# Without an output array OS.execute starts Godot directly; with one it goes through /bin/sh,
# which the job sandbox does not allow. The step's messages come back through its log file.
func _run(step: String, args: PackedStringArray) -> Dictionary:
	var log := ProjectSettings.globalize_path("user://studio-%s.log" % step)
	var full := PackedStringArray(["--log-file", log])
	full.append_array(args)
	var pid := OS.create_process(OS.get_executable_path(), full)
	if pid <= 0:
		return {"step": step, "exitCode": -1, "issues": ["ERROR: could not start Godot for %s" % step]}
	while OS.is_process_running(pid):
		OS.delay_msec(POLL_MS)
	var exit_code := OS.get_process_exit_code(pid)
	var text := FileAccess.get_file_as_string(log)
	return {"step": step, "exitCode": exit_code, "issues": _issues(text)}


func _issues(text: String) -> Array:
	var found := []
	var lines := text.split("\n")
	for i in lines.size():
		var line := lines[i].strip_edges()
		if not _is_issue(line):
			continue
		var next := lines[i + 1].strip_edges() if i + 1 < lines.size() else ""
		var issue := line + (" " + next if next.begins_with("at:") else "")
		if _is_ignored(issue):
			continue
		found.append(issue)
		if found.size() >= MAX_ISSUES:
			break
	return found


func _is_issue(line: String) -> bool:
	for marker in ISSUE_MARKERS:
		if line.contains(marker):
			return true
	return false


func _is_ignored(issue: String) -> bool:
	for marker in IGNORED_ISSUES:
		if issue.contains(marker):
			return true
	return false


func _scripts(dir: String, into: Array) -> void:
	for sub in DirAccess.get_directories_at(dir):
		if sub.begins_with(".") or (dir == "res://" and sub == "addons"):
			continue
		_scripts(dir.path_join(sub), into)
	for file in DirAccess.get_files_at(dir):
		if file.get_extension() == "gd":
			into.append(dir.path_join(file))


func _scan() -> int:
	var scripts := []
	_scripts("res://", scripts)
	var failed := 0
	for path in scripts:
		var script := load(path) as Script
		if script == null or not script.can_instantiate():
			failed += 1
			printerr("SCRIPT ERROR: Cannot load script %s" % path)
	print("scanned %d scripts" % scripts.size())
	return 1 if failed else 0


func _ok(steps: Array) -> bool:
	for step in steps:
		if step.exitCode != 0 or not step.issues.is_empty():
			return false
	return true


func _check(report: String) -> int:
	var project := _project()
	var wrapper: String = get_script().resource_path
	var steps := [
		_run("import", ["--headless", "--path", project, "--import"]),
		_run("scripts", ["--headless", "--path", project, "--script", wrapper, "--", "scan"]),
	]
	var main_scene: String = ProjectSettings.get_setting("application/run/main_scene", "")
	if main_scene != "":
		steps.append(_run("boot", ["--headless", "--path", project, "--quit-after", str(BOOT_FRAMES)]))
	var result := {"ok": _ok(steps), "mode": "check", "mainScene": main_scene, "steps": steps}
	var file := FileAccess.open(report, FileAccess.WRITE)
	if file:
		file.store_string(JSON.stringify(result))
		file.close()
	_finish(result)
	return 0 if result.ok else 1


func _web_preset(config: ConfigFile, wanted: String) -> String:
	var index := 0
	while config.has_section("preset.%d" % index):
		var section := "preset.%d" % index
		var is_web: bool = config.get_value(section, "platform", "") == WEB_PLATFORM
		if is_web and (wanted == "" or config.get_value(section, "name", "") == wanted):
			return section
		index += 1
	if wanted != "":
		return ""
	var created := "preset.%d" % index
	config.set_value(created, "name", WEB_PLATFORM)
	config.set_value(created, "platform", WEB_PLATFORM)
	config.set_value(created, "runnable", true)
	config.set_value(created, "export_filter", "all_resources")
	config.set_value(created, "include_filter", "")
	config.set_value(created, "exclude_filter", "")
	config.set_value(created, "export_path", "")
	return created


func _export(html: String, templates: String, wanted: String) -> int:
	var template := templates.path_join(TEMPLATE_FILE)
	if not FileAccess.file_exists(template):
		return _fail("export", "The web export template is missing: %s" % TEMPLATE_FILE)
	var presets := "res://export_presets.cfg"
	var config := ConfigFile.new()
	if FileAccess.file_exists(presets) and config.load(presets) != OK:
		return _fail("export", "export_presets.cfg does not parse")
	var section := _web_preset(config, wanted)
	if section == "":
		return _fail("export", "No Web export preset named %s" % wanted)
	var options := section + ".options"
	config.set_value(options, "custom_template/debug", templates.path_join(DEBUG_TEMPLATE_FILE))
	config.set_value(options, "custom_template/release", template)
	config.set_value(options, "variant/thread_support", false)
	config.set_value(options, "variant/extensions_support", false)
	config.save(presets)
	DirAccess.make_dir_recursive_absolute(html.get_base_dir())
	var project := _project()
	var name: String = config.get_value(section, "name")
	var steps := [
		_run("import", ["--headless", "--path", project, "--import"]),
		_run("export", ["--headless", "--path", project, "--export-release", name, html]),
	]
	var exported := FileAccess.file_exists(html) and FileAccess.file_exists(html.get_basename() + ".pck")
	# Godot reports some failures only in its log (a project.binary it could not save still
	# exports, exit 0, as a game without its settings), so any export-step error fails the export.
	var ok: bool = exported and steps[1].exitCode == 0 and steps[1].issues.is_empty()
	_finish({"ok": ok, "mode": "export", "preset": name, "steps": steps})
	return 0 if ok else 1


func _fail(mode: String, error: String) -> int:
	_finish({"ok": false, "mode": mode, "error": error})
	return 1


func _finish(result: Dictionary) -> void:
	print(RESULT_PREFIX + JSON.stringify(result))
