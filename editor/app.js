"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const backend = window.Algo2LeanBackend;
  const request = (path, options) => backend ? backend.request(path, options) : fetch(path, options);
  const source = $("source");
  const sourceViewport = $("source-editor");
  const filename = $("filename");
  const analysis = $("analysis");
  const analysisViewport = $("analysis-editor");
  const analysisFilename = $("analysis-filename");
  const proofOutline = window.Algo2LeanProofOutline.create($("analysis-outline"), { document, onJump: jumpToAnalysis });
  const analysisSearch = window.Algo2LeanCodeSearch?.create({ textarea: analysis, viewport: analysisViewport,
    document, scope: $("analysis-workspace"), label: "analysis" });
  if (analysisSearch) analysisViewport.before(analysisSearch.element);
  const clearedDrafts = new Map();
  let draftStore = null;
  let draftBaseline;
  const initialSource = "# Stable merge sort of a finite interval within an infinite integer sequence.\n# Indices are integers; [lo, hi) includes lo and excludes hi.\n# Every element outside the interval keeps its original value.\n# The merge_sort clock counts one unit per sort call and merged output element.\n# copy(a) is an abstract constant-time snapshot of a mathematical sequence;\n# the cost model excludes integer bit complexity and eager physical copying.\n\n\ndef merge(a: Seq, lo: Int, mid: Int, hi: Int) -> Seq:\n    # The adjacent intervals [lo, mid) and [mid, hi) must already be sorted.\n    # Clone a so stores to result cannot overwrite values still being read.\n    result: Seq = copy(a)\n    left: Int = lo\n    right: Int = mid\n    output: Int = lo\n\n    # @both_remaining\n    while left < mid and right < hi:\n        # Taking the left value on equality makes the merge stable.\n        if a[left] <= a[right]:\n            result[output] = a[left]\n            left += 1\n        else:\n            result[output] = a[right]\n            right += 1\n        output += 1\n        tick(\"merge_sort\")\n\n    # @left_remaining\n    while left < mid:\n        result[output] = a[left]\n        left += 1\n        output += 1\n        tick(\"merge_sort\")\n\n    # @right_remaining\n    while right < hi:\n        result[output] = a[right]\n        right += 1\n        output += 1\n        tick(\"merge_sort\")\n\n    return result\n\n\ndef merge_sort(a: Seq, lo: Int, hi: Int) -> Seq:\n    tick(\"merge_sort\")\n    # Empty, reversed, and one-element intervals need no changes.\n    if hi - lo <= 1:\n        return a\n\n    mid: Int = lo + (hi - lo) // 2\n    left_sorted: Seq = merge_sort(a, lo, mid)\n    both_sorted: Seq = merge_sort(left_sorted, mid, hi)\n    return merge(both_sorted, lo, mid, hi)\n\n\ndef demo_merge_sort() -> Seq:\n    # Sort [3, 1, 4, 1] into [1, 1, 3, 4] on the interval [0, 4).\n    a: Seq = const(0)\n    a[-1] = 99\n    a[0] = 3\n    a[1] = 1\n    a[2] = 4\n    a[3] = 1\n    a[4] = 77\n    # The two markers outside the interval stay 99 and 77.\n    return merge_sort(a, 0, 4)\n";
  let savedSource = initialSource;
  let savedFilename = "merge_sort.algo";
  let revision = 0;
  let requestSerial = 0;
  let activeRequest = null;
  let lastResult = null;
  let draftTimer;
  let draftFailed = false;
  let examples = [];
  let savedAnalysis = "";
  let savedAnalysisFilename = "Analysis.lean";
  let analysisRevision = 0;
  let analysisRequestSerial = 0;
  let activeAnalysisRequest = null;
  let generationController = null;
  let analysisTouched = false;
  let generatedModule = "MergeSortGenerated";
  let generatedPointsModule = "MergeSortGeneratedPoints";
  const PROJECT_PREFIX = "algo2lean.editor.project.v1.";
  const PROJECT_SESSION = "algo2lean.editor.active-project.v1";
  const EXAMPLE_SESSION = "algo2lean.editor.example.v1";
  const PROJECT_BYTES = 6 * 1024 * 1024;
  let currentProject = null;
  let standaloneDocument = null;
  let projectBaseline = "";
  let projectWritable = false;
  let projectOpening = 0;
  let folderOpening = null;
  let projectExport = null;
  const apple = /Mac|iPhone|iPad/.test(navigator.platform || "");
  $("compile-button").querySelector("kbd").textContent = apple ? "⌘ ↵" : "Ctrl ↵";
  $("analyze-button").querySelector("kbd").textContent = apple ? "⌘ ↵" : "Ctrl ↵";

  function projectModule(path) { return `Algo.${path.slice(0, -5).replace(/\//g, ".")}`; }

  function validProjectPath(path, extension) {
    if (typeof path !== "string" || !path.endsWith(extension) || path.length > 255) return false;
    return path.slice(0, -extension.length).split("/").every((part) => /^[A-Za-z_][A-Za-z_0-9]*$/.test(part));
  }

  function projectSnapshot() {
    currentProject.files[currentProject.selected] = draftSnapshot();
    return { version: 1, name: currentProject.name, selected: currentProject.selected,
      files: currentProject.files, analyses: currentProject.analyses };
  }

  function validProjectRecord(record) {
    const data = record?.data;
    if (!record || typeof record.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(record.id) || !data || data.version !== 1 ||
        typeof data.name !== "string" || typeof data.files !== "object" || !data.files || Array.isArray(data.files)) return false;
    const paths = Object.keys(data.files);
    if (!paths.length || paths.length > 256 || !paths.includes(data.selected) || JSON.stringify(data).length > 4 * PROJECT_BYTES) return false;
    if (!paths.every((path) => validProjectPath(path, ".algo") && ["source", "filename", "savedSource", "savedFilename", "analysis", "analysisFilename", "savedAnalysis", "savedAnalysisFilename"].every((key) => typeof data.files[path]?.[key] === "string"))) return false;
    return data.analyses && typeof data.analyses === "object" && !Array.isArray(data.analyses) && Object.entries(data.analyses).every(([name, text]) => /^Algo(?:\.[A-Za-z_][A-Za-z_0-9]*)+\.Analysis$/.test(name) && typeof text === "string");
  }

  function projectDrafts() {
    const records = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(PROJECT_PREFIX)) continue;
      try {
        const record = JSON.parse(localStorage.getItem(key));
        if (validProjectRecord(record) && key === PROJECT_PREFIX + record.id) records.push(record);
      } catch (_) { /* Leave unreadable records untouched. */ }
    }
    return records.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  function writeProjectDraft() {
    const data = projectSnapshot();
    const snapshot = JSON.stringify(data);
    if (snapshot === projectBaseline) return true;
    try {
      // Recoveries and duplicated tabs fork before their first write.
      const id = projectWritable ? currentProject.id : crypto.randomUUID();
      localStorage.setItem(PROJECT_PREFIX + id, JSON.stringify({ id, updatedAt: Date.now(), data }));
      currentProject.id = id;
      projectWritable = true;
      projectBaseline = snapshot;
      try { window.sessionStorage.setItem(PROJECT_SESSION, id); } catch (_) { /* Recovery picker remains available. */ }
      draftStatus("Project draft saved in this browser");
      refreshDrafts();
      return true;
    } catch (_) {
      draftStatus("Project draft could not be saved. Download the project to keep all module edits.", true);
      return false;
    }
  }

  function projectControls() {
    $("project-toolbar").hidden = !currentProject;
    filename.readOnly = Boolean(currentProject);
    analysisFilename.readOnly = Boolean(currentProject);
    $("export-button").hidden = Boolean(currentProject);
    $("export-points-button").hidden = Boolean(currentProject);
    $("standalone-button").hidden = Boolean(currentProject);
    if (!currentProject) return;
    $("project-name").textContent = currentProject.name;
    $("project-count").textContent = `${Object.keys(currentProject.files).length} modules`;
    $("project-module").replaceChildren();
    for (const path of Object.keys(currentProject.files).sort()) {
      const option = document.createElement("option");
      option.value = path;
      option.textContent = path;
      $("project-module").append(option);
    }
    $("project-module").value = currentProject.selected;
  }

  function selectProjectModule(path, { save = true, compileNow = true } = {}) {
    if (!currentProject || !Object.hasOwn(currentProject.files, path)) return;
    if (save) projectSnapshot();
    currentProject.selected = path;
    const file = currentProject.files[path];
    source.value = file.source;
    filename.value = path;
    savedSource = file.savedSource;
    savedFilename = path;
    generatedModule = projectModule(path) + ".Generated";
    generatedPointsModule = projectModule(path) + ".Points";
    showModuleNames();
    loadAnalysis(file.analysis, file.analysisFilename, "Project file", file);
    source.setSelectionRange(0, 0);
    sourceViewport.scrollTop = 0;
    sourceViewport.scrollLeft = 0;
    lastResult = null;
    $("lean-output").hidden = true;
    $("output-empty").hidden = false;
    $("points-output").hidden = true;
    $("points-empty").hidden = false;
    invalidate();
    setLeanState("Not generated");
    renderSource();
    updateSaveState("Project file");
    projectControls();
    scheduleDraft();
    if (compileNow) compile(false);
  }

  function loadProject(data, record = null) {
    if (!currentProject) standaloneDocument = { ...draftSnapshot(), id: draftStore?.activeId || null };
    currentProject = { ...data, id: record?.id || null };
    projectWritable = false;
    projectBaseline = record ? JSON.stringify(data) : "";
    selectProjectModule(data.selected, { save: false, compileNow: false });
    writeDraft();
    try { if (currentProject.id) window.sessionStorage.setItem(PROJECT_SESSION, currentProject.id); } catch (_) { /* Optional pointer only. */ }
    fileMessage(`Opened ${data.name}. Each module keeps its own source and analysis draft.`);
  }

  function appendProjectDrafts(records) {
    for (const record of records) {
      const card = document.createElement("article");
      card.className = "draft-card";
      const heading = document.createElement("h3");
      heading.textContent = `${record.data.name} · Project`;
      const detail = document.createElement("p");
      detail.className = "draft-meta";
      detail.textContent = `${Object.keys(record.data.files).length} modules · ${new Date(record.updatedAt).toLocaleString()}`;
      const preview = document.createElement("pre");
      preview.textContent = Object.keys(record.data.files).slice(0, 5).join("\n");
      const actions = document.createElement("div");
      actions.className = "draft-actions";
      const recover = document.createElement("button");
      recover.type = "button";
      recover.className = "button button-quiet";
      recover.textContent = "Recover project";
      recover.addEventListener("click", () => {
        if (!canReplace()) return;
        try {
          const latest = JSON.parse(localStorage.getItem(PROJECT_PREFIX + record.id));
          if (!validProjectRecord(latest)) throw new Error("This project draft is no longer available.");
          loadProject(latest.data, latest);
          $("draft-picker").open = false;
          compile(false);
        } catch (error) { fileMessage(error.message, true); }
      });
      const discard = document.createElement("button");
      discard.type = "button";
      discard.className = "button button-quiet draft-discard";
      discard.textContent = "Discard";
      discard.addEventListener("click", () => {
        if (!window.confirm(`Discard the browser project draft for ${record.data.name}? Open editor text will remain.`)) return;
        try {
          localStorage.removeItem(PROJECT_PREFIX + record.id);
          if (currentProject?.id === record.id) {
            projectBaseline = JSON.stringify(projectSnapshot());
            currentProject.id = null;
            projectWritable = false;
            clearTimeout(draftTimer);
          }
          refreshDrafts();
        } catch (_) { fileMessage("This project draft could not be discarded.", true); }
      });
      actions.append(recover, discard);
      card.append(heading, detail, preview, actions);
      $("draft-list").append(card);
    }
  }

  function projectRequest(snapshot) {
    const payload = { source: snapshot.source, filename: snapshot.filename };
    if (typeof snapshot.analysis === "string") payload.analysis = snapshot.analysis;
    if (currentProject) {
      const project = projectSnapshot();
      payload.project_sources = {};
      payload.project_analyses = { ...project.analyses };
      for (const [path, file] of Object.entries(project.files)) {
        payload.project_sources[path] = file.source;
        payload.project_analyses[projectModule(path) + ".Analysis"] = file.analysis;
      }
      if (Object.keys(payload.project_analyses).length > 256) throw new Error("A project can contain at most 256 analysis modules, including a companion for each source file.");
      if (new Blob([JSON.stringify(payload)]).size > 8 * 1024 * 1024) throw new Error("This project exceeds the 8 MB request limit. Open a smaller project folder.");
    }
    return payload;
  }

  function requestHeaders() {
    return { "Content-Type": "application/json", ...(currentProject ? { "X-Algo2Lean-Project": "1" } : {}) };
  }

  async function requireProjectSupport(signal) {
    const response = await request("/api/capabilities", { signal });
    const capabilities = response.ok ? await response.json() : null;
    if (capabilities?.project_protocol !== 1) {
      const error = new Error("This editor server is older than the project compiler. Stop the existing server, run python3 -m algo2lean serve --open from the Algo2Lean project folder, then reload this page.");
      error.name = "ServerUpdateError";
      throw error;
    }
  }

  async function readProjectFiles(files, name) {
    const sources = {}, analyses = {}, proofPaths = {}, spellings = new Map();
    const relevant = files.filter(({ path }) => path.endsWith(".algo") || (path.endsWith(".lean") && !path.startsWith("Algo/")));
    const sourceFiles = relevant.filter(({ path }) => path.endsWith(".algo"));
    if (!sourceFiles.length) throw new Error("Choose a folder containing .algo source files.");
    if (sourceFiles.length > 256 || relevant.length > 512) throw new Error("Choose a project with at most 256 source modules and 256 companion analyses.");
    let bytes = 0;
    for (const { path, file } of relevant.sort((a, b) => a.path.localeCompare(b.path))) {
      if (path.startsWith("Algo/") && path.endsWith(".lean")) continue;
      const isSource = path.endsWith(".algo");
      const relative = !isSource && path.startsWith("analysis/") ? path.slice(9) : path;
      if (!validProjectPath(relative, isSource ? ".algo" : ".lean")) {
        if (isSource) throw new Error(`Source paths must use identifier names: ${path}`);
        continue;
      }
      const module = relative.replace(/\.(algo|lean)$/, "").replace(/\//g, ".");
      const parts = module.split(".");
      for (let length = 1; length <= parts.length; length += 1) {
        const prefix = parts.slice(0, length).join(".");
        const previous = spellings.get(prefix.toLowerCase());
        if (previous && previous !== prefix) throw new Error(`Module paths differ only in letter case: ${previous} and ${prefix}.`);
        spellings.set(prefix.toLowerCase(), prefix);
      }
      bytes += file.size;
      if (file.size > (isSource ? 256 * 1024 : 1024 * 1024) || bytes > PROJECT_BYTES) throw new Error("Choose sources smaller than 256 KB, analyses smaller than 1 MB, and a project smaller than 6 MB.");
      const text = (await file.text()).replace(/\r\n?/g, "\n");
      if (isSource) {
        if (Object.hasOwn(sources, path)) throw new Error(`The project contains duplicate source path ${path}.`);
        sources[path] = text;
      }
      else {
        const key = `Algo.${module}.Analysis`;
        if (Object.hasOwn(analyses, key)) throw new Error(`Two companion analyses have the same module: ${proofPaths[key]} and ${path}.`);
        analyses[key] = text;
        proofPaths[key] = path;
      }
    }
    const proofModules = new Set([...Object.keys(analyses), ...Object.keys(sources).map((path) => projectModule(path) + ".Analysis")]);
    if (proofModules.size > 256) throw new Error("Choose a project with at most 256 analysis modules, including a companion for each source file.");
    const documents = {};
    for (const path of Object.keys(sources).sort()) {
      const module = projectModule(path);
      const proof = analyses[module + ".Analysis"] ?? starterAnalysis(module + ".Generated");
      const proofPath = proofPaths[module + ".Analysis"] || "analysis/" + path.replace(/\.algo$/, ".lean");
      documents[path] = { source: sources[path], filename: path, savedSource: sources[path], savedFilename: path,
        analysis: proof, analysisFilename: proofPath, savedAnalysis: proof, savedAnalysisFilename: proofPath };
    }
    return { version: 1, name, selected: Object.keys(documents).includes("main.algo") ? "main.algo" : Object.keys(documents)[0], files: documents, analyses };
  }

  function openingSnapshot() { return { serial: ++projectOpening, revision, analysisRevision, filename: filename.value, analysisFilename: analysisFilename.value }; }

  async function finishProjectOpen(files, name, opening, selected = null) {
    const data = await readProjectFiles(files, name);
    if (selected !== null) {
      if (!Object.hasOwn(data.files, selected)) throw new Error("The example's entry module is missing.");
      data.selected = selected;
    }
    if (opening.serial !== projectOpening || opening.revision !== revision || opening.analysisRevision !== analysisRevision || opening.filename !== filename.value || opening.analysisFilename !== analysisFilename.value) {
      fileMessage("The workspace changed while the folder was opening. Open the project again when you are ready.", true);
      return;
    }
    if (!canReplace()) return;
    loadProject(data);
    compile(false);
  }

  async function openProjectExample(example) {
    const opening = openingSnapshot();
    fileMessage("Loading the example and its imported files…");
    try {
      await requireProjectSupport();
      const response = await request(`/api/example-project/${encodeURIComponent(example.project_id)}`);
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || error.message || error.diagnostics?.[0]?.message || "This project example could not be loaded. Restart the editor server and try again.");
      }
      const project = await response.json();
      if (!project.sources || !project.analyses || typeof project.entry !== "string") throw new Error("The project example is incomplete.");
      const files = [];
      const add = (path, text) => {
        if (typeof text !== "string") throw new Error("The project example contains an invalid file.");
        files.push({ path, file: { size: new Blob([text]).size, text: async () => text } });
      };
      for (const [path, text] of Object.entries(project.sources)) add(path, text);
      for (const [module, text] of Object.entries(project.analyses)) {
        if (!/^Algo(?:\.[A-Za-z_][A-Za-z_0-9]*)+\.Analysis$/.test(module)) throw new Error("The project example contains an invalid analysis name.");
        add("analysis/" + module.slice(5, -9).replace(/\./g, "/") + ".lean", text);
      }
      await finishProjectOpen(files, project.name || example.name, opening, project.entry);
    } catch (error) {
      if (opening.serial === projectOpening) fileMessage(`Could not open the example: ${error.message}`, true);
    }
  }

  async function openProjectFolder() {
    const opening = openingSnapshot();
    if (!window.showDirectoryPicker) { folderOpening = opening; $("project-picker").click(); return; }
    $("open-project-button").disabled = true;
    try {
      const directory = await window.showDirectoryPicker({ mode: "read" });
      const files = [];
      let entries = 0;
      async function visit(handle, prefix = "", depth = 0) {
        if (depth > 32) throw new Error("Project folders can be at most 32 levels deep.");
        for await (const entry of handle.values()) {
          if (++entries > 4096) throw new Error("This folder has too many entries. Choose a smaller project folder.");
          if (entry.name.startsWith(".") || ["node_modules", "build", "dist"].includes(entry.name)) continue;
          const path = prefix + entry.name;
          if (entry.kind === "directory") await visit(entry, path + "/", depth + 1);
          else if (/\.(algo|lean)$/.test(path)) files.push({ path, file: await entry.getFile() });
        }
      }
      fileMessage("Reading the selected project folder…");
      await visit(directory);
      await finishProjectOpen(files, directory.name, opening);
    } catch (error) {
      if (error.name !== "AbortError") fileMessage(`Could not open the project: ${error.message}`, true);
    } finally { $("open-project-button").disabled = false; }
  }

  async function downloadProject() {
    if (!currentProject) return;
    if (projectExport) projectExport.abort();
    const controller = new AbortController();
    projectExport = controller;
    const project = currentProject;
    const snapshot = { source: source.value, filename: filename.value, analysis: analysis.value, revision, analysisRevision };
    $("project-export-button").disabled = true;
    $("project-export-button").textContent = "Preparing download…";
    try {
      await requireProjectSupport(controller.signal);
      if (project !== currentProject || snapshot.revision !== revision || snapshot.analysisRevision !== analysisRevision) return;
      const response = await request("/api/project-export", { method: "POST", headers: requestHeaders(),
        body: JSON.stringify(projectRequest(snapshot)), signal: controller.signal });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || error.message || error.diagnostics?.[0]?.message || "Project export failed.");
      }
      const archive = await response.blob();
      if (controller.signal.aborted || project !== currentProject || snapshot.revision !== revision || snapshot.analysisRevision !== analysisRevision) return;
      download(archive, "Algo2Lean-project.zip");
      writeDraft();
      fileMessage("Downloaded all project drafts. The archive README describes generated files and any export diagnostics.");
    } catch (error) {
      if (error.name !== "AbortError") fileMessage(`Could not download the project: ${error.message}`, true);
    } finally {
      if (projectExport === controller) {
        projectExport = null;
        $("project-export-button").disabled = false;
        $("project-export-button").textContent = "Download project";
      }
    }
  }

  function escapeHtml(value) {
    return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function highlight(value, lean = false) {
    const words = lean
      ? new Set(["def", "inductive", "where", "namespace", "end", "abbrev", "import", "if", "then", "else", "let", "in", "match", "with", "by", "fun", "open", "set_option", "deriving", "theorem", "example", "private", "mutual"])
      : new Set(["class", "def", "import", "from", "as", "if", "else", "elif", "while", "for", "in", "return", "pass", "and", "or", "not", "is", "None", "True", "False", "break", "continue"]);
    const pattern = lean ? /--[^\n]*|"(?:[^"\\]|\\.)*"|\b\d+\b|\b[A-Za-z_][A-Za-z_0-9']*\b/g : /#[^\n]*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\b\d+\b|\b[A-Za-z_][A-Za-z_0-9]*\b/g;
    let cursor = 0;
    let html = "";
    for (const match of value.matchAll(pattern)) {
      html += escapeHtml(value.slice(cursor, match.index));
      const token = match[0];
      let kind = "";
      if (token.startsWith("#") || token.startsWith("--")) kind = "comment";
      else if (token.startsWith('"') || token.startsWith("'")) kind = "string";
      else if (/^\d/.test(token)) kind = "number";
      else if (words.has(token)) kind = "keyword";
      else if (["Int", "Seq", "Bool", "Prop", "Nat", "Unit", "True", "False"].includes(token)) kind = "type";
      else if (/^\s*\(/.test(value.slice(match.index + token.length)) || token.startsWith("is_Output_") ||
        (lean && ["Returns", "ReturnsWithCost", "Run", "Call", "CallFrom", "ValidTranscript", "ValidHeapTranscript"].includes(token))) kind = "function";
      html += kind ? `<span class="token-${kind}">${escapeHtml(token)}</span>` : escapeHtml(token);
      cursor = match.index + token.length;
    }
    return html + escapeHtml(value.slice(cursor));
  }

  function renderSource() {
    $("highlight-code").innerHTML = highlight(source.value) + "\n";
    const lines = source.value.split("\n").length;
    $("line-numbers").textContent = Array.from({ length: lines }, (_, i) => i + 1).join("\n");
    updatePosition();
  }

  function updatePosition() {
    const before = source.value.slice(0, source.selectionStart);
    const line = before.split("\n").length;
    const column = before.length - before.lastIndexOf("\n");
    $("cursor-position").textContent = `Ln ${line}, Col ${column}`;
  }

  function dirty() {
    return source.value !== savedSource || filename.value !== savedFilename;
  }

  function analysisDirty() {
    return analysis.value !== savedAnalysis || analysisFilename.value !== savedAnalysisFilename;
  }

  function workspaceDirty() {
    if (!currentProject) return dirty() || analysisDirty();
    return Object.values(projectSnapshot().files).some((file) => file.source !== file.savedSource || file.analysis !== file.savedAnalysis);
  }

  function moduleForFilename(name) {
    const basename = name.split(/[\\/]/).pop().replace(/\.[^.]*$/, "");
    const words = basename.match(/[A-Za-z0-9]+/g) || [];
    let module = words.map((word) => word[0].toUpperCase() + word.slice(1)).join("");
    if (!module || /^\d/.test(module)) module = "Algorithm" + module;
    return module + "Generated";
  }

  function starterAnalysis(module) {
    if (module.startsWith("Algo.") && module.endsWith(".Generated")) {
      const prefix = module.slice(0, -10);
      const namespace = prefix.split(".").map((part) => `«${part}»`).join(".");
      return `import ${module}\nimport ${prefix}.Points\nimport ${prefix}.Facts\n\nopen Algo2LeanCore _root_.Algo2LeanGenerated\nopen ${namespace} ${namespace}.Algo2LeanGenerated\n\n-- State output theorems using the public relations shown by the compiler.\n-- Use the generated call interface for guarantees reusable by other algorithms.\n-- Import Algo.<module>.Analysis to reuse a companion proof.\n-- Points and Facts are optional when the proof does not use their helpers.\n`;
    }
    return `import ${module}\nimport ${module}Points\n\nopen Algo2LeanCore Algo2LeanGenerated\n\n-- State output theorems using the public relations shown by the compiler.\n-- Use the generated call interface for guarantees reusable by other algorithms.\n-- Points adds named locations and local values; omit this import if unused.\n`;
  }

  function showModuleNames() {
    $("analysis-module").textContent = generatedModule;
    $("analysis-points-module").textContent = generatedPointsModule;
  }

  function setModule(module, pointsModule = `${module}Points`) {
    if (!module || (module === generatedModule && pointsModule === generatedPointsModule)) return;
    const wasStarter = analysis.value === starterAnalysis(generatedModule) && !analysisDirty();
    generatedModule = module;
    generatedPointsModule = pointsModule;
    showModuleNames();
    if (wasStarter) {
      analysis.value = starterAnalysis(module);
      savedAnalysis = analysis.value;
      invalidateAnalysis("Generated module changed. Check the analysis again.");
      renderAnalysis();
      scheduleDraft();
    }
  }

  function updateSaveState(label) {
    $("save-state").textContent = dirty() ? "Unsaved file" : (label || "Saved file");
    $("save-state").classList.toggle("dirty", dirty());
    updateExampleNotice();
  }

  function updateAnalysisSaveState(label) {
    $("analysis-save-state").textContent = analysisDirty() ? "Unsaved file" : (label || "Saved file");
    $("analysis-save-state").classList.toggle("dirty", analysisDirty());
    updateExampleNotice();
  }

  function currentExample() {
    return !currentProject && examples.find((example) => !example.project_id && example.filename === filename.value);
  }

  function updateExampleNotice() {
    const example = currentExample();
    const differs = example && (source.value !== example.source ||
      analysis.value !== analysisForExample(example, generatedModule));
    $("example-update").hidden = !differs;
    $("example-update-message").textContent = differs
      ? `This copy differs from the current ${example.name || example.filename} example. Your saved drafts remain in Browser drafts.` : "";
  }

  function draftSnapshot() {
    return { source: source.value, filename: filename.value, savedSource, savedFilename,
      analysis: analysis.value, analysisFilename: analysisFilename.value, savedAnalysis, savedAnalysisFilename };
  }

  function draftNeedsSaving() {
    if (currentProject) return JSON.stringify(projectSnapshot()) !== projectBaseline;
    return draftStore ? draftStore.hasChanges(draftSnapshot()) : JSON.stringify(draftSnapshot()) !== draftBaseline;
  }

  function hasDraftBackup() {
    try {
      if (currentProject) {
        const record = JSON.parse(localStorage.getItem(PROJECT_PREFIX + currentProject.id));
        return validProjectRecord(record) && JSON.stringify(record.data) === JSON.stringify(projectSnapshot());
      }
      const draft = draftStore && (draftStore.read(draftStore.activeId) ||
        JSON.parse(localStorage.getItem(Algo2LeanDrafts.LEGACY_KEY)));
      if (!draft || draft.source !== source.value || draft.filename !== filename.value) return false;
      // Source-only drafts can reconstruct their untouched starter analysis.
      const text = typeof draft.analysis === "string" ? draft.analysis : starterAnalysis(moduleForFilename(draft.filename));
      const name = typeof draft.analysisFilename === "string" ? draft.analysisFilename : "Analysis.lean";
      return text === analysis.value && name === analysisFilename.value;
    } catch (_) { return false; }
  }

  function draftStatus(message, failed = false) {
    draftFailed = failed;
    $("draft-status").textContent = message;
    $("draft-status").classList.toggle("error", failed);
  }

  function writeDraft() {
    clearTimeout(draftTimer);
    if (currentProject) return writeProjectDraft();
    if (!draftNeedsSaving()) return true;
    try {
      if (!draftStore) throw new Error("Browser storage unavailable");
      draftStore.write(draftSnapshot());
      draftStatus("Draft saved in this browser");
      refreshDrafts();
      return true;
    } catch (_) {
      draftStatus("Draft could not be saved. Save source and analysis to keep your work.", true);
      return false;
    }
  }

  function scheduleDraft() {
    clearTimeout(draftTimer);
    if (!draftNeedsSaving()) {
      draftStatus(hasDraftBackup() ? "Draft saved in this browser" : "No pending draft changes");
      return;
    }
    if (!draftFailed) $("draft-status").textContent = "Saving browser draft…";
    draftTimer = setTimeout(writeDraft, 350);
  }

  function refreshDrafts() {
    if (!draftStore) return [];
    try {
      const drafts = draftStore.list();
      const projects = projectDrafts();
      $("draft-list").replaceChildren();
      $("draft-count").textContent = String(drafts.length + projects.length);
      $("draft-empty").hidden = drafts.length + projects.length !== 0;
      for (const draft of drafts) {
        const card = document.createElement("article");
        card.className = "draft-card";
        const heading = document.createElement("h3");
        heading.textContent = draft.filename || "untitled.algo";
        const detail = document.createElement("p");
        detail.className = "draft-meta";
        detail.textContent = new Date(draft.updatedAt).toLocaleString() + (draft.id === draftStore.activeId ? " · Loaded in this tab" : "");
        if (typeof draft.analysis === "string") detail.textContent += ` · ${draft.analysisFilename || "Analysis.lean"}`;
        const preview = document.createElement("pre");
        preview.textContent = draft.source.split("\n").slice(0, 4).join("\n").slice(0, 500) || "(Empty source)";
        const analysisPreview = document.createElement("pre");
        analysisPreview.textContent = draft.analysis?.split("\n").slice(0, 4).join("\n").slice(0, 500) || "(Empty analysis)";
        const actions = document.createElement("div");
        actions.className = "draft-actions";
        const recover = document.createElement("button");
        recover.type = "button";
        recover.className = "button button-quiet";
        recover.textContent = "Recover";
        recover.setAttribute("aria-label", `Recover ${draft.filename}`);
        recover.addEventListener("click", () => {
          try {
            if (!canReplace()) return;
            const latest = draftStore.read(draft.id);
            if (!latest) { refreshDrafts(); fileMessage("This draft was discarded in another tab."); return; }
            loadDocument(latest.source, latest.filename, "Recovered draft", { draft: latest });
            $("draft-picker").open = false;
            source.focus();
            compile(false);
          } catch (_) { fileMessage("This draft could not be read. Browser storage may be unavailable.", true); }
        });
        const discard = document.createElement("button");
        discard.type = "button";
        discard.className = "button button-quiet draft-discard";
        discard.textContent = "Discard";
        discard.setAttribute("aria-label", `Discard ${draft.filename}`);
        discard.addEventListener("click", () => {
          if (!window.confirm(`Discard the browser draft for ${draft.filename}? This cannot be undone. Any open editor text will remain.`)) return;
          try {
            const active = draft.id === draftStore.activeId;
            draftStore.remove(draft.id);
            if (active) {
              clearTimeout(draftTimer);
              draftStore.start(draftSnapshot());
              draftStatus("Draft discarded. Edit to create a new draft, or save source and analysis.");
            }
            refreshDrafts();
            $("drafts-button").focus();
            fileMessage(`Discarded the browser draft for ${draft.filename}.`);
          } catch (_) { fileMessage("The draft could not be discarded. Try again when browser storage is available.", true); }
        });
        actions.append(recover, discard);
        card.append(heading, detail, preview);
        if (typeof draft.analysis === "string") card.append(analysisPreview);
        card.append(actions);
        $("draft-list").append(card);
      }
      appendProjectDrafts(projects);
      if (drafts.length + projects.length) $("draft-picker").hidden = false;
      return drafts;
    } catch (_) {
      fileMessage("Browser drafts could not be listed. Save source and analysis to keep your current work.", true);
      return [];
    }
  }

  function clearDrafts() {
    try {
      // Read every record before deleting any. The archive lives only in this
      // page's memory and supports Undo until the page is closed or reloaded.
      const records = [];
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (key === Algo2LeanDrafts.LEGACY_KEY || key?.startsWith(Algo2LeanDrafts.PREFIX) || key?.startsWith(PROJECT_PREFIX)) {
          records.push([key, localStorage.getItem(key)]);
        }
      }
      for (const [key, value] of records) {
        clearedDrafts.set(key, value);
        localStorage.removeItem(key);
      }
      clearTimeout(draftTimer);
      draftBaseline = JSON.stringify(draftSnapshot());
      draftStore?.start(draftSnapshot());
      if (currentProject) {
        currentProject.id = null;
        projectWritable = false;
        projectBaseline = JSON.stringify(projectSnapshot());
      }
      if (standaloneDocument) standaloneDocument.id = null;
      try { window.sessionStorage.removeItem(PROJECT_SESSION); } catch (_) { /* Optional recovery pointer. */ }
      draftStatus("Browser drafts cleared. New edits create a new draft.");
      fileMessage("All browser drafts cleared. Open code is unchanged. Undo clear is available until you reload or close this page.");
    } catch (_) {
      fileMessage("Some drafts could not be cleared. Undo clear can restore any removed drafts; try again when browser storage is available.", true);
    }
    $("undo-clear-drafts-button").hidden = !clearedDrafts.size;
    refreshDrafts();
  }

  function undoClearDrafts() {
    try {
      for (const [key, value] of clearedDrafts) {
        // Later edits have their own records. Never overwrite a newer record.
        const current = localStorage.getItem(key);
        if (current === null) localStorage.setItem(key, value);
        if (current === null || current === value) clearedDrafts.delete(key);
      }
      fileMessage(clearedDrafts.size ? "Restored available drafts. Newer records were kept." : "Browser drafts restored. Use Recover to open one.");
    } catch (_) {
      fileMessage("Some drafts could not be restored. Keep this page open and try Undo clear again when browser storage is available.", true);
    }
    $("undo-clear-drafts-button").hidden = !clearedDrafts.size;
    refreshDrafts();
  }

  function setStatus(text, tone = "") {
    $("compile-status").textContent = text;
    $("compile-status").className = `compile-status ${tone}`;
  }

  function setLeanState(text, tone = "") {
    for (const id of ["lean-state", "points-state"]) {
      $(id).textContent = text;
      $(id).className = `state-tag ${tone}`;
    }
  }

  function setOutputActions(enabled) {
    for (const id of ["export-button", "copy-button"]) $(id).disabled = !enabled;
    for (const id of ["export-points-button", "copy-points-button"]) $(id).disabled = !enabled || !lastResult?.points;
    for (const id of ["library-button", "standalone-button"]) $(id).disabled = !enabled || !lastResult?.shared;
  }

  function rejectOutput() {
    if (lastResult) lastResult.available = false;
    setOutputActions(false);
    $("shared-details").hidden = true;
    $("relations").hidden = true;
  }

  function invalidateGeneration() {
    if (!generationController) return;
    generationController.abort();
    generationController = null;
    $("generation-status").textContent = "Workspace changed. Verify generated files again for the current source.";
    $("generation-details").textContent = "";
  }

  function invalidate() {
    revision += 1;
    invalidateAnalysis("Source changed. Check the analysis against the updated algorithm.");
    setModule(currentProject ? projectModule(filename.value) + ".Generated" : moduleForFilename(filename.value),
      currentProject ? projectModule(filename.value) + ".Points" : undefined);
    if (activeRequest) {
      activeRequest.abort();
      activeRequest = null;
      requestSerial += 1;
      setBusy(false);
    }
    if (lastResult) {
      setLeanState("Source changed", "stale");
      $("output-summary").textContent = "Compile again to update this output";
      $("points-summary").textContent = "Compile again to update this output";
    }
    rejectOutput();
    $("lean-details").hidden = true;
    $("diagnostics").replaceChildren();
    const p = document.createElement("p");
    p.textContent = "Source changed. Compile to update the generated Lean code.";
    $("diagnostics").append(p);
    setStatus("Changes awaiting compilation");
  }

  function changed() {
    invalidate();
    renderSource();
    updateSaveState();
    scheduleDraft();
  }

  function fileMessage(text, error = false) {
    $("file-message").textContent = text;
    $("file-message").classList.toggle("error", error);
    $("file-message").hidden = !text;
  }

  function safeFilename(value, extension) {
    const base = value.trim().split(/[\\/]/).pop().replace(/[<>:"|?*\u0000-\u001f]/g, "_") || "untitled";
    return base.replace(/\.(algo|lean)$/i, "") + extension;
  }

  function download(content, name) {
    const url = URL.createObjectURL(content instanceof Blob ? content : new Blob([content], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function saveSource() {
    const name = safeFilename(filename.value, ".algo");
    if (!currentProject && filename.value !== name) { filename.value = name; invalidate(); }
    try {
      download(source.value, name);
      savedSource = source.value;
      savedFilename = currentProject ? filename.value : name;
      updateSaveState("Downloaded");
      writeDraft();
      fileMessage(currentProject ? `Downloaded ${name}. Save it as ${filename.value} in your project folder.` : `Downloaded ${name}. Your browser chooses where the file is saved.`);
    } catch (error) { fileMessage(`Could not download the source: ${error.message}`, true); }
  }

  function canReplace() {
    writeDraft();
    return !workspaceDirty() || hasDraftBackup() || window.confirm(currentProject
      ? "Some project edits have no complete browser backup. Replace the project anyway? Choose Cancel and download the project first to keep every module."
      : "The current source and analysis have no complete browser backup. Replace them anyway? Choose Cancel and save each file first to keep your changes.");
  }

  function loadDocument(text, name, label, { draft = null, example = null } = {}) {
    clearTimeout(draftTimer);
    currentProject = null;
    standaloneDocument = null;
    projectControls();
    try { window.sessionStorage.removeItem(PROJECT_SESSION); } catch (_) { /* Optional pointer only. */ }
    try {
      if (example && !draft) window.sessionStorage.setItem(EXAMPLE_SESSION, example.filename);
      else window.sessionStorage.removeItem(EXAMPLE_SESSION);
    } catch (_) { /* Choosing examples still works without session storage. */ }
    source.value = draft ? text : text.replace(/\r\n?/g, "\n");
    filename.value = draft ? name : safeFilename(name, ".algo");
    savedSource = draft ? draft.savedSource : source.value;
    savedFilename = draft ? draft.savedFilename : filename.value;
    generatedModule = example?.module || moduleForFilename(filename.value);
    generatedPointsModule = `${generatedModule}Points`;
    showModuleNames();
    if (draft && typeof draft.analysis === "string") {
      loadAnalysis(draft.analysis, typeof draft.analysisFilename === "string" ? draft.analysisFilename : "Analysis.lean", "Recovered draft", draft);
    } else {
      const matching = draft ? null : example || examples.find((item) => !item.project_id && item.source === source.value);
      loadAnalysis(analysisForExample(matching, generatedModule), "Analysis.lean", matching?.analysis ? "Example" : "Starter");
    }
    draftBaseline = JSON.stringify(draftSnapshot());
    if (draftStore) draftStore.start(draftSnapshot(), draft ? draft.id : null);
    source.setSelectionRange(0, 0);
    sourceViewport.scrollTop = 0;
    sourceViewport.scrollLeft = 0;
    lastResult = null;
    $("lean-output").hidden = true;
    $("output-empty").hidden = false;
    $("points-output").hidden = true;
    $("points-empty").hidden = false;
    invalidate();
    setLeanState("Not generated");
    $("output-summary").textContent = "Generated code is read only";
    $("points-summary").textContent = "Generated code is read only";
    renderSource();
    updateSaveState(label);
    draftStatus(draft ? "Browser draft restored" : "Draft stays in this browser", !draftStore);
    refreshDrafts();
    fileMessage("");
  }

  function analysisForExample(example, module) {
    if (typeof example?.analysis !== "string") return starterAnalysis(module);
    if (!example.module || example.module === module) return example.analysis;
    return example.analysis.replace(new RegExp(`^import ${example.module}(Points)?[ \\t]*$`, "gm"),
      (_, points) => `import ${module}${points || ""}`);
  }

  function setBusy(busy, check = false) {
    $("compile-button").disabled = busy;
    $("check-button").disabled = busy;
    $("compile-button").querySelector("span").textContent = busy && !check ? "Compiling…" : "Compile";
    $("check-button").textContent = backend?.hosted ? "Check locally" : currentProject ? (busy && check ? "Checking project…" : "Check project ↗") : (busy && check ? "Checking both files…" : "Check both files ↗");
    $("lean-output").setAttribute("aria-busy", String(busy));
    $("points-output").setAttribute("aria-busy", String(busy));
    setOutputActions(!busy && currentOutput());
  }

  function showDiagnostics(diagnostics) {
    $("diagnostics").replaceChildren();
    for (const diagnostic of diagnostics) {
      const hasLocation = Number.isInteger(diagnostic.line) && diagnostic.line > 0;
      const item = document.createElement(hasLocation ? "button" : "div");
      item.className = "diagnostic";
      if (hasLocation) {
        item.type = "button";
        const location = document.createElement("span");
        location.className = "diagnostic-location";
        location.textContent = `${diagnostic.file || "Line"} ${diagnostic.line}:${diagnostic.column || 1}`;
        item.append(location);
        item.addEventListener("click", () => {
          if (currentProject && diagnostic.file && Object.hasOwn(currentProject.files, diagnostic.file)) {
            selectProjectModule(diagnostic.file, { compileNow: false });
          }
          if (!currentProject || !diagnostic.file || diagnostic.file === filename.value) jumpTo(diagnostic.line, diagnostic.column || 1);
        });
      }
      const message = document.createElement("span");
      message.className = "diagnostic-message";
      message.textContent = diagnostic.message || "Compilation failed.";
      item.append(message);
      $("diagnostics").append(item);
    }
  }

  function jumpTo(line, column) {
    const lines = source.value.split("\n");
    const safeLine = Math.max(1, Math.min(line, lines.length));
    const start = lines.slice(0, safeLine - 1).reduce((total, text) => total + text.length + 1, 0);
    const position = start + Math.min(Math.max(column - 1, 0), lines[safeLine - 1].length);
    source.focus({ preventScroll: true });
    source.setSelectionRange(position, Math.min(position + 1, source.value.length));
    sourceViewport.scrollTop = Math.max(0, (safeLine - 3) * 24);
    sourceViewport.scrollLeft = Math.max(0, (column - 12) * 8.4);
    sourceViewport.scrollIntoView({ block: "nearest" });
    updatePosition();
  }

  function showRelations(functions) {
    window.Algo2LeanInterface.render($("relations"), functions, {
      document, goToSource: jumpTo,
      generatedFile: `${generatedModule}.lean`, pointsFile: `${generatedPointsModule}.lean`,
      factsFile: generatedModule.endsWith(".Generated") ? `${generatedModule.slice(0, -10)}.Facts.lean` : undefined,
    });
  }

  function showGenerated(result, snapshot) {
    const module = result.module || moduleForFilename(snapshot.filename);
    lastResult = { lean: result.lean, shared: result.shared_lean || "", program: result.program_lean || "",
      points: result.points_lean || "", pointsModule: result.points_module || `${module}Points`,
      module, source: snapshot.source, filename: snapshot.filename, revision: snapshot.revision, available: true };
    setModule(lastResult.module, lastResult.pointsModule);
    // Reserve the final empty line so selecting to EOF never scrolls the textarea
    // independently of its measuring/highlight layer.
    $("lean-code").innerHTML = highlight(result.lean + "\n", true);
    $("lean-selection").value = result.lean;
    $("lean-output").hidden = false;
    $("output-empty").hidden = true;
    $("points-code").innerHTML = highlight(lastResult.points + "\n", true);
    $("points-selection").value = lastResult.points;
    $("points-output").hidden = !lastResult.points;
    $("points-empty").hidden = Boolean(lastResult.points);
    setOutputActions(true);
    $("shared-details").hidden = !lastResult.shared;
    $("shared-code").textContent = "";
    $("shared-summary").textContent = `Shared Lean library · ${result.stats?.shared_lines || 0} reusable lines`;
    if ($("shared-details").open) $("shared-code").innerHTML = highlight(lastResult.shared, true);
    const modulePath = (name) => currentProject ? name.replace(/\./g, "/") : name;
    $("output-summary").textContent = `${result.stats?.program_lines || result.lean.trimEnd().split("\n").length} program lines · ${modulePath(lastResult.module)}.lean`;
    const pointsLines = result.stats?.points_lines ?? (lastResult.points ? lastResult.points.trimEnd().split("\n").length : 0);
    $("points-summary").textContent = `${pointsLines} interface lines · ${modulePath(lastResult.pointsModule)}.lean`;
    showRelations(result.functions);
  }

  async function compile(check = false) {
    if (check && backend?.hosted) {
      setStatus("Lean checking requires the local editor.");
      fileMessage("Download the generation bundle to check these files with the pinned Lean toolchain. This website verifies generation, not Lean proofs.");
      return;
    }
    if (activeRequest) activeRequest.abort();
    const serial = ++requestSerial;
    const snapshot = { source: source.value, filename: filename.value, revision };
    const controller = new AbortController();
    activeRequest = controller;
    setBusy(true, check);
    setStatus(check ? "Checking generated definitions with Lean…" : "Compiling source…");
    fileMessage("");
    $("lean-details").hidden = true;
    try {
      if (currentProject) await requireProjectSupport(controller.signal);
      if (serial !== requestSerial || snapshot.revision !== revision) return;
      const response = await request(check ? "/api/check" : "/api/compile", {
        method: "POST", headers: requestHeaders(),
        body: JSON.stringify(projectRequest(snapshot)), signal: controller.signal,
      });
      let result;
      try { result = await response.json(); }
      catch (_) { throw new Error("The compiler returned an unreadable response. Restart the local editor server and try again."); }
      if (serial !== requestSerial || snapshot.revision !== revision) return;
      if (result.scope === "setup") {
        setStatus("Compiler setup needs attention", "error");
        setLeanState("Compilation unavailable", "error");
        rejectOutput();
        showDiagnostics([{ message: result.message || "Check the compiler installation and try again." }]);
        return;
      }
      if (typeof result.lean === "string") {
        showGenerated(result, snapshot);
      }
      if (result.diagnostics && result.diagnostics.length) {
        showDiagnostics(result.diagnostics);
        setStatus(`${result.diagnostics.length} ${result.diagnostics.length === 1 ? "error" : "errors"} to resolve`, "error");
        setLeanState(lastResult ? "Compilation failed" : "Not generated", "error");
        rejectOutput();
        return;
      }
      if (!response.ok && !check) throw new Error(result.error || result.message || `Compilation failed (HTTP ${response.status}).`);
      if (!result.lean && !check) throw new Error(result.error || result.message || "The compiler did not return Lean code.");
      $("diagnostics").replaceChildren();
      const note = document.createElement("p");
      if (check && result.available === false) {
        setStatus("Lean checker unavailable");
        setLeanState("Generated · unchecked", "generated");
        note.textContent = currentProject ? "The project files were generated. A local Lean installation is needed to check the definitions." : "Both Lean files were generated. A local Lean installation is needed to check the definitions.";
      } else if (check && result.ok) {
        setStatus("Lean accepted the generated definitions", "success");
        setLeanState("Lean checked", "checked");
        note.textContent = currentProject ? "Lean checked the generated modules and their named-line interfaces. This checks the definitions; it does not prove termination or a specification." : "Lean checked both generated files successfully. This checks the definitions; it does not prove termination or a specification.";
      } else if (check) {
        setStatus("Lean reported a problem", "error");
        setLeanState("Lean check failed", "error");
        note.textContent = "Lean could not accept the generated definitions. See the checker output below.";
      } else {
        setStatus("Compilation successful", "success");
        setLeanState("Generated · unchecked", "generated");
        note.textContent = backend?.hosted ? "Generated in your browser. Verify claimed files or download a generation bundle below. Lean proof checking requires a local installation." : currentProject ? "The selected module and its dependencies were compiled. Check project to validate their definitions and named-line interfaces." : "Algorithm definitions and the named-line interface were generated separately. Check both files to validate the Lean definitions.";
      }
      $("diagnostics").append(note);
      if (check) {
        $("check-output").textContent = result.output || result.message || (result.ok ? "Lean completed without errors." : "No checker output was returned.");
        $("lean-details").hidden = false;
        $("lean-details").open = !result.ok;
      }
    } catch (error) {
      if (error.name === "AbortError" || serial !== requestSerial || snapshot.revision !== revision) return;
      setStatus(error.name === "ServerUpdateError" ? "Editor server needs restarting" : "Could not reach the compiler", "error");
      setLeanState("Compilation failed", "error");
      rejectOutput();
      showDiagnostics([{ message: error.message || "Start the local editor server and try again." }]);
    } finally {
      if (serial === requestSerial) { activeRequest = null; setBusy(false); }
    }
  }

  function currentOutput() {
    return lastResult && lastResult.available && lastResult.revision === revision && lastResult.source === source.value && lastResult.filename === filename.value;
  }

  function setAnalysisStatus(text, tone = "", badge = "Not checked") {
    $("analysis-status").textContent = text;
    $("analysis-status").className = `analysis-status ${tone}`;
    $("analysis-state").textContent = badge;
    $("analysis-state").className = `state-tag ${tone === "success" ? "checked" : tone}`;
  }

  function setAnalysisBusy(busy) {
    $("analyze-button").disabled = busy;
    $("analyze-button").firstChild.textContent = busy ? "Checking analysis… " : "Check analysis ";
    analysis.setAttribute("aria-busy", String(busy));
  }

  function invalidateAnalysis(message = "Analysis changed. Check it again to verify these changes.") {
    invalidateGeneration();
    analysisRevision += 1;
    analysisRequestSerial += 1;
    if (activeAnalysisRequest) activeAnalysisRequest.abort();
    activeAnalysisRequest = null;
    setAnalysisBusy(false);
    $("analysis-details").hidden = true;
    $("analysis-diagnostics").replaceChildren();
    setAnalysisStatus(message, "stale", "Needs check");
  }

  function analysisFileMessage(text, error = false) {
    $("analysis-file-message").textContent = text;
    $("analysis-file-message").classList.toggle("error", error);
    $("analysis-file-message").hidden = !text;
  }

  function updateAnalysisPosition() {
    const before = analysis.value.slice(0, analysis.selectionStart);
    $("analysis-cursor-position").textContent = `Ln ${before.split("\n").length}, Col ${before.length - before.lastIndexOf("\n")}`;
  }

  function renderAnalysis() {
    $("analysis-line-numbers").textContent = Array.from({ length: analysis.value.split("\n").length }, (_, index) => index + 1).join("\n");
    $("analysis-measure").textContent = analysis.value + "\n";
    proofOutline.update(analysis.value);
    analysisSearch?.refresh();
    updateAnalysisPosition();
  }

  function analysisChanged() {
    analysisTouched = true;
    invalidateAnalysis();
    renderAnalysis();
    updateAnalysisSaveState();
    scheduleDraft();
  }

  function loadAnalysis(text, name, label, draft = null) {
    analysis.value = draft ? text : text.replace(/\r\n?/g, "\n");
    analysisFilename.value = draft || currentProject ? name : safeFilename(name, ".lean");
    savedAnalysis = draft ? (typeof draft.savedAnalysis === "string" ? draft.savedAnalysis : "") : analysis.value;
    savedAnalysisFilename = draft ? (typeof draft.savedAnalysisFilename === "string" ? draft.savedAnalysisFilename : "") : analysisFilename.value;
    analysisTouched = true;
    analysis.setSelectionRange(0, 0);
    analysisViewport.scrollTop = 0;
    analysisViewport.scrollLeft = 0;
    invalidateAnalysis("Check this analysis against the current source.");
    renderAnalysis();
    updateAnalysisSaveState(label);
    analysisFileMessage("");
  }

  function saveAnalysis() {
    const name = safeFilename(analysisFilename.value, ".lean");
    const reserved = ["Algo2Lean.lean", `${generatedModule}.lean`, `${generatedPointsModule}.lean`];
    if (reserved.some((file) => file.toLowerCase() === name.toLowerCase())) {
      analysisFileMessage(`Choose an analysis filename different from ${reserved.join(", ")}.`, true);
      analysisFilename.focus();
      return;
    }
    try {
      download(analysis.value, name);
      if (!currentProject) analysisFilename.value = name;
      savedAnalysis = analysis.value;
      savedAnalysisFilename = currentProject ? analysisFilename.value : name;
      updateAnalysisSaveState("Downloaded");
      writeDraft();
      analysisFileMessage(currentProject ? `Downloaded ${name}. Save it as ${analysisFilename.value} in your project folder, or use Download project to keep the folder layout.` : `Downloaded ${name}. Include ${generatedModule}.lean and Algo2Lean.lean in your Lean project. Export ${generatedPointsModule}.lean too if your proof imports named-line helpers.`);
    } catch (error) { analysisFileMessage(`Could not save the analysis: ${error.message}`, true); }
  }

  function jumpToAnalysis(line, column) {
    const lines = analysis.value.split("\n");
    const safeLine = Math.max(1, Math.min(line, lines.length));
    const start = lines.slice(0, safeLine - 1).reduce((total, text) => total + text.length + 1, 0);
    const position = start + Math.min(Math.max(column - 1, 0), lines[safeLine - 1].length);
    analysis.focus({ preventScroll: true });
    analysis.setSelectionRange(position, Math.min(position + 1, analysis.value.length));
    analysisViewport.scrollTop = Math.max(0, (safeLine - 3) * 24);
    analysisViewport.scrollLeft = Math.max(0, (column - 12) * 8.4);
    analysisViewport.scrollIntoView({ block: "nearest" });
    renderAnalysis();
  }

  function showAnalysisDiagnostics(diagnostics) {
    $("analysis-diagnostics").replaceChildren();
    for (const diagnostic of diagnostics || []) {
      const hasLocation = Number.isInteger(diagnostic.line) && diagnostic.line > 0;
      const item = document.createElement(hasLocation ? "button" : "div");
      item.className = "diagnostic";
      if (hasLocation) {
        item.type = "button";
        const location = document.createElement("span");
        location.className = "diagnostic-location";
        location.textContent = `Analysis.lean · ${diagnostic.line}:${diagnostic.column || 1}`;
        item.append(location);
        item.addEventListener("click", () => jumpToAnalysis(diagnostic.line, diagnostic.column || 1));
      }
      const message = document.createElement("span");
      message.className = "diagnostic-message";
      message.textContent = diagnostic.message || "Lean reported a problem with the analysis.";
      item.append(message);
      $("analysis-diagnostics").append(item);
    }
  }

  async function analyze() {
    if (backend?.hosted) {
      setAnalysisStatus("Save this analysis and check it in the local Algo2Lean editor with Lean installed.", "", "Local checking required");
      return;
    }
    if (activeAnalysisRequest) activeAnalysisRequest.abort();
    const serial = ++analysisRequestSerial;
    const snapshot = { source: source.value, filename: filename.value, revision, analysis: analysis.value, analysisRevision };
    const controller = new AbortController();
    activeAnalysisRequest = controller;
    setAnalysisBusy(true);
    setAnalysisStatus("Checking your analysis against the current algorithm…", "", "Checking…");
    $("analysis-details").hidden = true;
    $("analysis-diagnostics").replaceChildren();
    analysisFileMessage("");
    const isCurrent = () => serial === analysisRequestSerial && snapshot.revision === revision && snapshot.analysisRevision === analysisRevision;
    try {
      if (currentProject) await requireProjectSupport(controller.signal);
      if (!isCurrent()) return;
      const response = await request("/api/analyze", {
        method: "POST", headers: requestHeaders(),
        body: JSON.stringify(projectRequest(snapshot)), signal: controller.signal,
      });
      let result;
      try { result = await response.json(); }
      catch (_) { throw new Error("The analysis checker returned an unreadable response. Restart the local editor server and try again."); }
      if (!isCurrent()) return;
      if (result.scope === "setup") {
        setStatus("Compiler setup needs attention", "error");
        setLeanState("Compilation unavailable", "error");
        rejectOutput();
        setAnalysisStatus("Compiler setup needs attention. Your source and analysis remain available to save.", "error", "Not checked");
        showAnalysisDiagnostics([{ message: result.message || "Check the compiler installation and try again." }]);
        return;
      }
      if (typeof result.lean === "string" && !currentOutput()) {
        showGenerated(result, snapshot);
        setLeanState("Generated", "generated");
        setStatus("Compilation successful", "success");
      }
      if (!isCurrent()) return;
      if (result.diagnostics?.length) {
        showDiagnostics(result.diagnostics);
        setStatus("Source errors to resolve", "error");
        setLeanState("Compilation failed", "error");
        rejectOutput();
        setAnalysisStatus("Fix the source errors in the Lean Interface panel, then check the analysis again.", "error", "Source error");
        return;
      }
      showAnalysisDiagnostics(result.analysis_diagnostics);
      $("analysis-output").textContent = result.output || result.message || result.error || (result.ok ? "Lean completed without errors." : "No checker output was returned.");
      $("analysis-details").hidden = false;
      $("analysis-details").open = !result.ok;
      if (result.available === false) {
        setAnalysisStatus("Lean checker unavailable. Your source and analysis remain available to save.", "", "Not checked");
      } else if (response.ok && result.ok) {
        setAnalysisStatus("Lean accepted this analysis for the current source.", "success", "Lean checked");
      } else {
        setAnalysisStatus(result.error || result.message || "Lean reported a problem in the analysis. Review the messages below.", "error", "Check failed");
      }
    } catch (error) {
      if (error.name === "AbortError" || !isCurrent()) return;
      setAnalysisStatus(error.name === "ServerUpdateError" ? "Editor server needs restarting." : "Could not reach the analysis checker.", "error", "Not checked");
      showAnalysisDiagnostics([{ message: error.message || "Start the local editor server and try again." }]);
    } finally {
      if (serial === analysisRequestSerial) { activeAnalysisRequest = null; setAnalysisBusy(false); }
    }
  }

  // Native insertText retains the textarea undo history in browsers that support it.
  function insertText(text, start = source.selectionStart, end = source.selectionEnd) {
    source.focus();
    source.setSelectionRange(start, end);
    const before = source.value;
    const beforeRevision = revision;
    let inserted = false;
    try { inserted = document.execCommand("insertText", false, text); } catch (_) { /* setRangeText handles browsers without native insertion. */ }
    if (!inserted) { source.setRangeText(text, start, end, "end"); changed(); }
    else if (source.value !== before && revision === beforeRevision) { changed(); }
    else if (source.value === before) { renderSource(); }
  }

  for (const id of ["lean-selection", "points-selection", "shared-output", "check-output", "analysis-output"]) {
    $(id).addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); $(id).blur(); }
    });
  }

  source.addEventListener("input", changed);
  source.addEventListener("click", updatePosition);
  source.addEventListener("keyup", updatePosition);
  source.addEventListener("select", updatePosition);
  source.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (event.key === "Escape") { event.preventDefault(); source.blur(); return; }
    if (event.key === "Tab") {
      event.preventDefault();
      const start = source.selectionStart;
      const end = source.selectionEnd;
      const lineStart = source.value.lastIndexOf("\n", start - 1) + 1;
      if (start === end && !event.shiftKey) {
        insertText(" ".repeat(4 - ((start - lineStart) % 4)));
      } else {
        const selected = source.value.slice(lineStart, end);
        const transformed = selected.split("\n").map((line, index, lines) => {
          if (index === lines.length - 1 && !line && end > start) return line;
          return event.shiftKey ? line.replace(/^( {1,4}|\t)/, "") : "    " + line;
        }).join("\n");
        insertText(transformed, lineStart, end);
        source.setSelectionRange(lineStart, lineStart + transformed.length);
      }
      updatePosition();
    } else {
      if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        const before = source.value.slice(0, source.selectionStart);
        const line = before.slice(before.lastIndexOf("\n") + 1);
        const indent = line.match(/^\s*/)[0];
        insertText("\n" + indent + (/:\s*(?:#.*)?$/.test(line) ? "    " : ""));
      }
    }
  });

  function insertAnalysisText(text, start = analysis.selectionStart, end = analysis.selectionEnd) {
    analysis.focus();
    analysis.setSelectionRange(start, end);
    const before = analysis.value;
    const beforeRevision = analysisRevision;
    let inserted = false;
    try { inserted = document.execCommand("insertText", false, text); } catch (_) { /* setRangeText handles browsers without native insertion. */ }
    if (!inserted) { analysis.setRangeText(text, start, end, "end"); analysisChanged(); }
    else if (analysis.value !== before && analysisRevision === beforeRevision) analysisChanged();
    else if (analysis.value === before) renderAnalysis();
  }

  analysis.addEventListener("input", analysisChanged);
  for (const event of ["click", "keyup", "select"]) analysis.addEventListener(event, updateAnalysisPosition);
  analysis.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (event.key === "Escape") { event.preventDefault(); analysis.blur(); return; }
    if (event.key === "Tab") {
      event.preventDefault();
      const start = analysis.selectionStart;
      const end = analysis.selectionEnd;
      const lineStart = analysis.value.lastIndexOf("\n", start - 1) + 1;
      if (start === end && !event.shiftKey) insertAnalysisText(" ".repeat(2 - ((start - lineStart) % 2)));
      else {
        const selected = analysis.value.slice(lineStart, end);
        const transformed = selected.split("\n").map((line, index, lines) => {
          if (index === lines.length - 1 && !line && end > start) return line;
          return event.shiftKey ? line.replace(/^( {1,2}|\t)/, "") : "  " + line;
        }).join("\n");
        insertAnalysisText(transformed, lineStart, end);
        analysis.setSelectionRange(lineStart, lineStart + transformed.length);
      }
      updateAnalysisPosition();
    } else {
      if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        const before = analysis.value.slice(0, analysis.selectionStart);
        const line = before.slice(before.lastIndexOf("\n") + 1);
        const indent = line.match(/^ */)[0];
        insertAnalysisText("\n" + indent + (/\b(by|where|do)\s*$/.test(line) ? "  " : ""));
      }
    }
  });

  document.addEventListener("keydown", (event) => {
    if (!event.isComposing && (event.metaKey || event.ctrlKey) && !event.altKey) {
      const inAnalysis = Boolean(document.activeElement?.closest("#analysis-workspace"));
      if (event.key.toLowerCase() === "s") { event.preventDefault(); inAnalysis ? saveAnalysis() : saveSource(); }
      if (event.key === "Enter") { event.preventDefault(); inAnalysis ? analyze() : compile(false); }
    }
  });
  filename.addEventListener("input", () => { invalidate(); updateSaveState(); scheduleDraft(); });
  $("compile-button").addEventListener("click", () => compile(false));
  $("check-button").addEventListener("click", () => compile(true));
  $("save-button").addEventListener("click", saveSource);
  $("open-project-button").addEventListener("click", openProjectFolder);
  $("project-picker").addEventListener("change", async (event) => {
    const chosen = Array.from(event.target.files || []);
    event.target.value = "";
    if (!chosen.length) return;
    const opening = folderOpening || openingSnapshot();
    folderOpening = null;
    $("open-project-button").disabled = true;
    try {
      if (chosen.length > 4096) throw new Error("This folder has too many entries. Choose a smaller project folder.");
      const rootName = chosen[0].webkitRelativePath?.split("/")[0];
      if (!rootName) throw new Error("Choose a folder using Open project.");
      const files = [];
      for (const file of chosen) {
        const parts = file.webkitRelativePath.split("/");
        if (parts.shift() !== rootName) throw new Error("Choose one project folder at a time.");
        if (parts.some((part) => part.startsWith(".") || ["node_modules", "build", "dist"].includes(part))) continue;
        files.push({ path: parts.join("/"), file });
      }
      await finishProjectOpen(files, rootName, opening);
    } catch (error) { fileMessage(`Could not open the project: ${error.message}`, true); }
    finally { $("open-project-button").disabled = false; }
  });
  $("project-module").addEventListener("change", (event) => selectProjectModule(event.target.value));
  $("project-export-button").addEventListener("click", downloadProject);
  $("close-project-button").addEventListener("click", () => {
    if (!currentProject || !canReplace()) return;
    const previous = standaloneDocument;
    if (previous) loadDocument(previous.source, previous.filename, "Restored file", { draft: previous });
    else loadDocument(initialSource, "merge_sort.algo", "Example");
    compile(false);
  });
  $("analyze-button").addEventListener("click", analyze);
  $("analysis-save-button").addEventListener("click", saveAnalysis);
  analysisFilename.addEventListener("input", () => { analysisTouched = true; updateAnalysisSaveState(); scheduleDraft(); });
  $("analysis-open-button").addEventListener("click", () => $("analysis-file-picker").click());
  $("analysis-file-picker").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 1024 * 1024) { analysisFileMessage("Choose a Lean file smaller than 1 MB.", true); return; }
    const opening = { revision, analysisRevision, analysisFilename: analysisFilename.value };
    try {
      const text = await file.text();
      if (opening.revision !== revision || opening.analysisRevision !== analysisRevision || opening.analysisFilename !== analysisFilename.value) {
        analysisFileMessage("The workspace changed while the file was opening. Open it again when you are ready.", true); return;
      }
      if (!canReplace()) return;
      // Keep the previous source/analysis pair available under its original ID.
      if (!currentProject && draftStore) draftStore.start(draftSnapshot());
      loadAnalysis(text, currentProject ? analysisFilename.value : file.name, "Opened file");
      writeDraft();
      analysis.focus();
    } catch (error) { analysisFileMessage(`Could not open the analysis: ${error.message}`, true); }
  });
  $("open-button").addEventListener("click", () => $("file-picker").click());
  $("file-picker").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 1024 * 1024) { fileMessage("Choose an Algo2Lean file smaller than 1 MB.", true); return; }
    const opening = { revision, analysisRevision, analysisFilename: analysisFilename.value };
    try {
      const text = await file.text();
      if (revision !== opening.revision || analysisRevision !== opening.analysisRevision || opening.analysisFilename !== analysisFilename.value) { fileMessage("The workspace changed while the file was opening. Open the file again when you are ready.", true); return; }
      if (!canReplace()) return;
      loadDocument(text, file.name, "Opened file");
      source.focus();
      compile(false);
    } catch (error) { fileMessage(`Could not open the file: ${error.message}`, true); }
  });
  $("export-button").addEventListener("click", () => {
    if (!currentOutput()) { fileMessage("Compile the current source before exporting Lean.", true); return; }
    const name = leanFilename();
    try { download(lastResult.lean, name); fileMessage(`Downloaded algorithm definitions ${name}. Include Algo2Lean.lean in your Lean project; export ${lastResult.pointsModule}.lean separately for named-line helpers.`); }
    catch (error) { fileMessage(`Could not export Lean: ${error.message}`, true); }
  });
  $("export-points-button").addEventListener("click", () => {
    if (!currentOutput() || !lastResult.points) { fileMessage("Compile the current source before exporting the named-line interface.", true); return; }
    const name = `${lastResult.pointsModule}.lean`;
    try { download(lastResult.points, name); fileMessage(`Downloaded named-line interface ${name}. This file imports ${lastResult.module}; keep it alongside ${leanFilename()} in your Lean project.`); }
    catch (error) { fileMessage(`Could not export the named-line interface: ${error.message}`, true); }
  });
  function leanFilename() {
    return `${lastResult.module}.lean`;
  }
  $("shared-details").addEventListener("toggle", () => {
    if ($("shared-details").open && currentOutput() && !$("shared-code").textContent) {
      $("shared-code").innerHTML = highlight(lastResult.shared, true);
    }
  });
  $("library-button").addEventListener("click", () => {
    if (!currentOutput()) return;
    download(lastResult.shared, "Algo2Lean.lean");
    fileMessage("Downloaded Algo2Lean.lean. Add it to your Lean project and build the library before checking generated imports.");
  });
  $("standalone-button").addEventListener("click", () => {
    if (!currentOutput()) return;
    const name = leanFilename();
    download(lastResult.shared.trimEnd() + "\n\n" + lastResult.program, name);
    fileMessage(`Downloaded standalone algorithm definitions ${name}, including the shared library. Export ${lastResult.pointsModule}.lean separately if your proof uses named-line helpers.`);
  });
  $("copy-button").addEventListener("click", async () => {
    if (!currentOutput()) { fileMessage("Compile the current source before copying Lean.", true); return; }
    try { await navigator.clipboard.writeText(lastResult.lean); fileMessage("Algorithm definitions copied to the clipboard."); }
    catch (_) { fileMessage("Clipboard access is unavailable. Select the generated code to copy it, or Export .lean.", true); }
  });
  $("copy-points-button").addEventListener("click", async () => {
    if (!currentOutput() || !lastResult.points) { fileMessage("Compile the current source before copying the named-line interface.", true); return; }
    try { await navigator.clipboard.writeText(lastResult.points); fileMessage("Named-line interface copied to the clipboard."); }
    catch (_) { fileMessage("Clipboard access is unavailable. Select the named-line interface to copy it, or Export .lean.", true); }
  });
  async function chooseExample(example) {
    if (!example || !canReplace()) return;
    if (example.project_id) { await openProjectExample(example); return; }
    loadDocument(example.source, example.filename, "Example", { example });
    compile(false);
  }

  if (backend?.hosted) {
    $("generation-tools").hidden = false;
    $("browser-runtime-status").hidden = false;
    $("hosted-proof-notice").hidden = false;
    $("proof-workflow-step").textContent = "Explore supplied proofs or write your own Lean analysis.";
    $("check-button").textContent = "Check locally";
    $("analyze-button").title = "Lean checking requires the local editor";
    $("compilation-description").textContent = "This website runs the Python compiler in your browser. Your source and proof files stay on your device; compilation does not send them to a server. The first visit downloads the pinned compiler and Python runtime. Lean proof checking requires a local Lean installation. Save or download files for a durable copy.";
    async function generation(action, files = []) {
      generationController?.abort();
      const controller = new AbortController();
      generationController = controller;
      const snapshot = { source: source.value, filename: filename.value, revision, analysis: analysis.value, analysisRevision };
      const project = currentProject;
      const report = $("generation-status");
      const details = $("generation-details");
      report.textContent = action === "verify" ? "Compiling and comparing every selected file…" : "Preparing generation records…";
      details.textContent = "";
      try {
        const payload = { ...projectRequest(snapshot), archive: action === "archive" };
        const response = await request("/api/generation", { method: "POST", headers: requestHeaders(),
          body: JSON.stringify(payload), signal: controller.signal });
        if (!response.ok) {
          const result = await response.json();
          throw new Error(result.message || result.error || result.diagnostics?.[0]?.message || "Resolve source errors before generating a record.");
        }
        const stillCurrent = () => generationController === controller && project === currentProject &&
          snapshot.revision === revision && snapshot.analysisRevision === analysisRevision;
        if (!stillCurrent()) throw new Error("The workspace changed. Try this action again for the current source.");
        if (action === "archive") {
          const archive = await response.blob();
          if (!stillCurrent()) throw new Error("The workspace changed. Download again for the current source.");
          download(archive, "Algo2Lean-generation.zip");
          report.textContent = "Downloaded the source, generated Lean files, shared libraries, and generation manifest.";
          return;
        }
        const result = await response.json();
        if (!stillCurrent()) throw new Error("The workspace changed. Try this action again for the current source.");
        if (action === "manifest") {
          download(JSON.stringify(result.manifest, null, 2) + "\n", "generation.json");
          report.textContent = "Downloaded the compiler identity, source hashes, settings, and output hashes.";
          return;
        }
        const comparison = await window.Algo2LeanBrowserHost.compareFiles(result.files, files, result.libraries, controller.signal);
        if (!stillCurrent()) throw new Error("The workspace changed during comparison. Verify again for the current source.");
        report.textContent = comparison.exact
          ? `Exact match: all ${comparison.compared} selected generated and library files are byte-for-byte identical. This verifies generation only; it does not check a Lean proof or establish compiler correctness.`
          : "Files do not exactly match this compilation. Review the differences below.";
        details.textContent = [
          ["Missing", comparison.missing], ["Extra or unrecognized", comparison.extra],
          ["Different contents", comparison.different], ["Duplicate", comparison.duplicate],
        ].filter(([, names]) => names.length).map(([label, names]) => label + ":\n" + names.join("\n")).join("\n\n");
      } catch (error) {
        if (generationController === controller && !controller.signal.aborted && error.name !== "AbortError") {
          report.textContent = error.message;
        }
      }
    }
    $("generation-bundle-button").addEventListener("click", () => generation("archive"));
    $("generation-manifest-button").addEventListener("click", () => generation("manifest"));
    $("verify-files-button").addEventListener("click", () => $("verify-files-picker").click());
    $("verify-folder-button").addEventListener("click", () => $("verify-folder-picker").click());
    for (const id of ["verify-files-picker", "verify-folder-picker"]) {
      $(id).addEventListener("change", (event) => {
        const files = Array.from(event.target.files).filter((file) => file.name.endsWith(".lean"));
        event.target.value = "";
        if (files.length) generation("verify", files);
      });
    }
  }

  $("load-current-example").addEventListener("click", () => chooseExample(currentExample()));
  $("examples").addEventListener("change", async (event) => {
    const example = examples[Number(event.target.value)];
    const chosen = event.target.value !== "";
    event.target.value = "";
    if (chosen) await chooseExample(example);
  });
  $("drafts-button").addEventListener("click", () => {
    refreshDrafts();
    $("draft-picker").hidden = false;
    $("draft-picker").open = true;
    $("draft-picker").querySelector("summary").focus();
  });
  $("clear-drafts-button").addEventListener("click", clearDrafts);
  $("undo-clear-drafts-button").addEventListener("click", undoClearDrafts);
  $("analysis-find-button").addEventListener("click", () => analysisSearch?.open());
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key.startsWith(PROJECT_PREFIX)) {
      refreshDrafts();
      if (currentProject && !draftNeedsSaving() && !hasDraftBackup()) draftStatus("This project draft is no longer stored. Download the project to keep your edits.", true);
    }
    if (event.key === null || event.key.startsWith(Algo2LeanDrafts.PREFIX)) {
      refreshDrafts();
      if (draftStore && draftStore.activeId && !draftNeedsSaving() && !hasDraftBackup()) {
        draftStatus("This draft is no longer stored. Edit to create a new draft, or save source and analysis.", true);
      }
    }
  });
  window.addEventListener("beforeunload", (event) => {
    writeDraft();
    if (workspaceDirty() && !hasDraftBackup()) { event.preventDefault(); event.returnValue = ""; }
  });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") writeDraft(); });

  async function initialize() {
    let preferredProject = null;
    let preferredExample = null;
    try { preferredExample = window.sessionStorage.getItem(EXAMPLE_SESSION); }
    catch (_) { /* Without session storage, the draft picker remains available. */ }
    try {
      const record = JSON.parse(localStorage.getItem(PROJECT_PREFIX + window.sessionStorage.getItem(PROJECT_SESSION)));
      if (validProjectRecord(record)) preferredProject = record;
    } catch (_) { /* A folder can still be opened without browser storage. */ }
    source.value = initialSource;
    generatedModule = moduleForFilename(filename.value);
    generatedPointsModule = `${generatedModule}Points`;
    showModuleNames();
    analysis.value = starterAnalysis(generatedModule);
    savedAnalysis = analysis.value;
    draftBaseline = JSON.stringify(draftSnapshot());
    let restoredAnalysis = false;
    let restoredDocument = false;
    let migrationFailed = false;
    let legacyFallback = null;
    try {
      let session = null;
      try { session = window.sessionStorage; } catch (_) { /* Recovery still works through the picker. */ }
      draftStore = new Algo2LeanDrafts.Store(localStorage, session);
      try { draftStore.migrateLegacy(); }
      catch (_) {
        migrationFailed = true;
        // A full storage quota must not hide either half of the original draft.
        try {
          const legacy = JSON.parse(localStorage.getItem(Algo2LeanDrafts.LEGACY_KEY));
          if (legacy && typeof legacy.source === "string" && typeof legacy.filename === "string") {
            legacyFallback = { ...legacy, id: null,
              savedSource: typeof legacy.savedSource === "string" ? legacy.savedSource : "",
              savedFilename: typeof legacy.savedFilename === "string" ? legacy.savedFilename : "" };
          }
        } catch (_) { /* Leave the original record untouched. */ }
      }
      const drafts = draftStore.list();
      const preferred = draftStore.read(draftStore.preferredId());
      const draft = legacyFallback || preferred || (!preferredExample && drafts.length === 1 ? drafts[0] : null);
      if (draft) {
        restoredDocument = true;
        restoredAnalysis = typeof draft.analysis === "string";
        loadDocument(draft.source, draft.filename, "Recovered draft", { draft });
        analysisTouched = restoredAnalysis;
      }
      else {
        draftStore.start(draftSnapshot());
        renderSource();
        updateSaveState("Example");
        draftStatus(drafts.length ? "Choose a browser draft to recover" : "Draft stays in this browser");
        refreshDrafts();
        if (drafts.length > 1) $("draft-picker").open = true;
      }
      if (migrationFailed) draftStatus("Existing draft could not be migrated. Save source and analysis to keep your work.", true);
    } catch (_) {
      draftStore = null;
      renderSource();
      updateSaveState();
      draftStatus("Browser draft unavailable. Save source and analysis to keep your work.", true);
    }
    if (preferredProject) {
      loadProject(preferredProject.data, preferredProject);
      restoredAnalysis = true;
      analysisTouched = true;
    }
    const initialDocument = { source: source.value, filename: filename.value, analysis: analysis.value };
    renderAnalysis();
    updateAnalysisSaveState(restoredAnalysis ? "Restored file" : "Starter");
    compile(false);
    try {
      const response = await request("/api/examples");
      if (!response.ok) throw new Error("Examples unavailable");
      const data = await response.json();
      examples = (data.examples || []).filter((item) => typeof item.source === "string");
      proofOutline.setExamples(examples.map((example) => example.analysis).filter((text) => typeof text === "string"));
      examples.forEach((example, index) => {
        const option = document.createElement("option");
        option.value = String(index);
        option.textContent = example.name || example.filename;
        if (example.description) option.title = example.description;
        $("examples").append(option);
      });
      const restoredExample = restoredDocument && examples.find((example) => !example.project_id && example.filename === initialDocument.filename);
      if (!currentProject && restoredExample && source.value === initialDocument.source &&
          filename.value === initialDocument.filename && analysis.value === initialDocument.analysis) {
        // The public catalog opens current examples. Older copies remain in the
        // draft picker and are loaded only when the user explicitly recovers them.
        loadDocument(restoredExample.source, restoredExample.filename, "Example", { example: restoredExample });
        compile(false);
      } else if (!currentProject && !restoredAnalysis && !analysisTouched && source.value === initialDocument.source && filename.value === initialDocument.filename) {
        const selected = preferredExample && examples.find((example) => !example.project_id && example.filename === preferredExample);
        const matching = examples.find((example) => !example.project_id && example.source === source.value);
        if (selected) {
          loadDocument(selected.source, selected.filename, "Example", { example: selected });
          compile(false);
        } else if (matching) {
          loadAnalysis(analysisForExample(matching, generatedModule), "Analysis.lean", matching.analysis ? "Example" : "Starter");
          writeDraft();
        }
      }
      updateExampleNotice();
    } catch (_) { $("examples").options[0].textContent = "Examples unavailable"; $("examples").disabled = true; }
  }
  initialize();
})();
