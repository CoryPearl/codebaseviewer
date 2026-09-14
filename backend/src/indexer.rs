use ignore::WalkBuilder;
use regex::Regex;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Symbol {
    pub name: String,
    pub kind: String,
    pub line: usize,
    pub signature: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRecord {
    pub id: u32,
    pub path: String,
    pub name: String,
    pub directory: String,
    pub extension: String,
    pub language: String,
    pub layer: String,
    pub lines: usize,
    pub bytes: usize,
    pub complexity: usize,
    pub preview: String,
    pub symbols: Vec<Symbol>,
    pub imports: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Edge {
    pub from: u32,
    pub to: u32,
    pub kind: String,
    pub confidence: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub version: &'static str,
    pub id: String,
    pub name: String,
    pub source: String,
    pub files: Vec<FileRecord>,
    pub edges: Vec<Edge>,
    pub total_lines: usize,
    pub definitions: usize,
    pub references: usize,
    pub warnings: Vec<String>,
    #[serde(skip)]
    pub root: PathBuf,
}

pub fn index_directory<F>(root: &Path, mut progress: F) -> Result<Snapshot, String>
where
    F: FnMut(&str, usize, usize, &str),
{
    let mut paths = Vec::new();
    let walker = WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .filter_entry(|entry| {
            let name = entry.file_name().to_string_lossy();
            !matches!(
                name.as_ref(),
                ".git" | "target" | "node_modules" | ".next" | "dist" | "build"
            )
        })
        .build();
    for entry in walker.flatten() {
        if entry
            .file_type()
            .map(|kind| kind.is_file())
            .unwrap_or(false)
        {
            paths.push(entry.into_path());
        }
    }
    if paths.is_empty() {
        return Err("No readable files were found".into());
    }

    let definitions = definition_patterns();
    let import_patterns = import_patterns();
    let total = paths.len();
    let mut files = Vec::new();
    let mut warnings = Vec::new();
    for (index, path) in paths.iter().enumerate() {
        if index % 20 == 0 {
            progress(
                "parsing",
                index,
                total,
                &format!("Parsing {} of {total}", index + 1),
            );
        }
        let bytes = match fs::read(path) {
            Ok(value) => value,
            Err(error) => {
                warnings.push(format!("{}: {error}", path.display()));
                continue;
            }
        };
        if bytes.len() > 8 * 1024 * 1024 || bytes.iter().take(4096).any(|b| *b == 0) {
            continue;
        }
        let text = String::from_utf8_lossy(&bytes);
        let relative = path
            .strip_prefix(root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        let extension = path
            .extension()
            .and_then(|v| v.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let language = language_for(&extension).to_string();
        let layer = layer_for(&relative).to_string();
        let mut symbols = Vec::new();
        let mut imports = Vec::new();
        let mut complexity = 1usize;
        let mut lines = 0usize;
        let mut preview_lines = Vec::with_capacity(60);
        for (line_index, line) in text.lines().enumerate() {
            lines = line_index + 1;
            if line_index < 60 {
                preview_lines.push(line);
            }
            complexity += [
                " if ", " for ", " while ", " match ", " switch ", "&&", "||",
            ]
            .iter()
            .filter(|token| line.contains(*token))
            .count();
            if line.contains("class ")
                || line.contains("struct ")
                || line.contains("enum ")
                || line.contains("interface ")
                || line.contains("fn ")
                || line.contains("func ")
                || line.contains("def ")
                || line.contains("function ")
                || line.contains('(')
            {
                for (kind, pattern) in &definitions {
                    if let Some(captures) = pattern.captures(line)
                        && let Some(found) = captures.get(1)
                    {
                        symbols.push(Symbol {
                            name: found.as_str().into(),
                            kind: (*kind).into(),
                            line: line_index + 1,
                            signature: line.trim().chars().take(180).collect(),
                        });
                        break;
                    }
                }
            }
            if line.contains("import")
                || line.contains("from ")
                || line.contains("require")
                || line.contains("#include")
                || line.contains("use ")
                || line.contains("mod ")
                || line.contains("using ")
            {
                for pattern in &import_patterns {
                    if let Some(captures) = pattern.captures(line)
                        && let Some(found) = captures.get(1)
                    {
                        imports.push(found.as_str().into());
                    }
                }
            }
        }
        let lines = lines.max(1);
        // Enough source for zoomed-in tiles without copying whole repositories
        // into the initial scene response.
        let preview = preview_lines.join("\n");
        let name = path
            .file_name()
            .and_then(|v| v.to_str())
            .unwrap_or(&relative)
            .to_string();
        let directory = relative
            .rsplit_once('/')
            .map(|(dir, _)| dir)
            .unwrap_or("")
            .to_string();
        files.push(FileRecord {
            id: files.len() as u32 + 1,
            path: relative,
            name,
            directory,
            extension,
            language,
            layer,
            lines,
            bytes: bytes.len(),
            complexity,
            preview,
            symbols,
            imports,
        });
    }
    progress(
        "linking",
        files.len(),
        files.len(),
        "Linking files and symbols…",
    );
    const PREVIEW_BUDGET: usize = 48 * 1024 * 1024;
    let preview_bytes: usize = files.iter().map(|file| file.preview.len()).sum();
    if preview_bytes > PREVIEW_BUDGET {
        let per_file = (PREVIEW_BUDGET / files.len().max(1)).max(32);
        for file in &mut files {
            if file.preview.len() > per_file {
                let mut end = per_file;
                while !file.preview.is_char_boundary(end) {
                    end -= 1;
                }
                file.preview.truncate(end);
            }
        }
    }
    let edges = link_files(&files);
    let total_lines = files.iter().map(|f| f.lines).sum();
    let definition_count = files.iter().map(|f| f.symbols.len()).sum();
    let references = edges.len();
    Ok(Snapshot {
        version: "CBV1",
        id: String::new(),
        name: String::new(),
        source: String::new(),
        files,
        edges,
        total_lines,
        definitions: definition_count,
        references,
        warnings,
        root: root.to_path_buf(),
    })
}

fn definition_patterns() -> Vec<(&'static str, Regex)> {
    [
        ("class", r"(?:class|struct|enum|trait|interface|record)\s+([A-Za-z_][A-Za-z0-9_]*)"),
        ("function", r"(?:fn|func|def|function)\s+([A-Za-z_][A-Za-z0-9_]*)"),
        ("function", r"(?:public|private|protected|static|async|export|const|let|var|unsafe|pub|virtual|override|inline|final|synchronized|abstract|extern|\s)+\s*([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*(?:\{|=>|throws)"),
    ].into_iter().map(|(kind, source)| (kind, Regex::new(source).unwrap())).collect()
}

fn import_patterns() -> Vec<Regex> {
    [
        r#"from\s+[\"']?([^\"';\s]+)"#,
        r#"import\s*[\"']([^\"']+)"#,
        r#"^\s*import\s+([A-Za-z_][A-Za-z0-9_.]*)\s*(?:;|$|\bas\b)"#,
        r#"import\s*\(\s*[\"']([^\"']+)"#,
        r#"require\s*\(\s*[\"']([^\"']+)"#,
        r#"#include\s*[<\"]([^>\"]+)"#,
        r#"(?:use|mod)\s+([A-Za-z_][A-Za-z0-9_:]*)"#,
        r#"using\s+([A-Za-z_][A-Za-z0-9_.]*)"#,
    ]
    .into_iter()
    .map(|source| Regex::new(source).unwrap())
    .collect()
}

fn link_files(files: &[FileRecord]) -> Vec<Edge> {
    fn normalize(path: &str) -> String {
        let mut parts = Vec::new();
        for part in path.split('/') {
            match part {
                "" | "." => {}
                ".." => {
                    parts.pop();
                }
                _ => parts.push(part),
            }
        }
        parts.join("/")
    }
    let mut exact = HashMap::new();
    let mut lookup: HashMap<String, Option<u32>> = HashMap::new();
    let mut add = |key: String, id: u32| {
        lookup
            .entry(key)
            .and_modify(|value| {
                if *value != Some(id) {
                    *value = None;
                }
            })
            .or_insert(Some(id));
    };
    for file in files {
        let path = file.path.replace('\\', "/");
        exact.insert(path.clone(), file.id);
        add(path.clone(), file.id);
        add(file.name.clone(), file.id);
        let extensionless = Path::new(&path)
            .with_extension("")
            .to_string_lossy()
            .replace('\\', "/");
        add(extensionless.clone(), file.id);
        if let Some(directory) = extensionless.strip_suffix("/index") {
            add(directory.to_string(), file.id);
        }
        for (index, _) in path.match_indices('/') {
            add(path[index + 1..].to_string(), file.id);
        }
        for (index, _) in extensionless.match_indices('/') {
            add(extensionless[index + 1..].to_string(), file.id);
        }
        if let Some(stem) = Path::new(&file.name).file_stem().and_then(|v| v.to_str()) {
            add(stem.to_string(), file.id);
        }
    }
    let mut seen = HashSet::new();
    let mut edges = Vec::new();
    for file in files {
        for import in &file.imports {
            let import = import.replace('\\', "/");
            let relative = normalize(&format!("{}/{}", file.directory, import));
            let normalized = normalize(&import);
            let resolve = |key: &str| {
                exact
                    .get(key)
                    .copied()
                    .or_else(|| lookup.get(key).copied().flatten())
            };
            let direct = resolve(&relative).or_else(|| {
                if import.starts_with('.') {
                    None
                } else {
                    resolve(&normalized)
                }
            });
            let module = import.replace("::", "/");
            let module = if matches!(file.language.as_str(), "Python" | "Java" | "C#") {
                module.replace('.', "/")
            } else {
                module
            };
            let target = direct.or_else(|| {
                if import.starts_with('.') {
                    return None;
                }
                resolve(&module).or_else(|| {
                    lookup
                        .get(module.rsplit('/').next().unwrap_or(&module))
                        .copied()
                        .flatten()
                })
            });
            if let Some(to) = target
                && to != file.id
                && seen.insert((file.id, to))
            {
                edges.push(Edge {
                    from: file.id,
                    to,
                    kind: "import".into(),
                    confidence: if direct.is_some() {
                        "known".into()
                    } else {
                        "inferred".into()
                    },
                });
            }
        }
    }
    edges
}

fn language_for(extension: &str) -> &'static str {
    match extension {
        "js" | "jsx" | "mjs" | "cjs" => "JavaScript",
        "ts" | "tsx" => "TypeScript",
        "py" | "pyi" => "Python",
        "rs" => "Rust",
        "go" => "Go",
        "c" | "h" => "C",
        "cc" | "cpp" | "cxx" | "hpp" | "hh" => "C++",
        "java" => "Java",
        "cs" => "C#",
        "fs" | "fsx" => "F#",
        "kt" | "kts" => "Kotlin",
        "swift" => "Swift",
        "scala" | "sc" => "Scala",
        "dart" => "Dart",
        "php" => "PHP",
        "rb" => "Ruby",
        "r" => "R",
        "pl" | "pm" => "Perl",
        "lua" => "Lua",
        "sql" => "SQL",
        "ex" | "exs" => "Elixir",
        "erl" | "hrl" => "Erlang",
        "hs" | "lhs" => "Haskell",
        "ml" | "mli" => "OCaml",
        "clj" | "cljs" | "cljc" | "edn" => "Clojure",
        "zig" => "Zig",
        "nim" => "Nim",
        "sol" => "Solidity",
        "groovy" | "gradle" => "Groovy",
        "html" | "htm" => "HTML",
        "xml" | "svg" | "vue" | "svelte" => "Markup",
        "css" | "scss" | "sass" | "less" => "CSS",
        "json" | "jsonc" | "toml" | "yaml" | "yml" | "ini" | "properties" => "Data",
        "md" | "mdx" | "txt" | "rst" => "Docs",
        "sh" | "zsh" | "bash" | "fish" => "Shell",
        _ => "Other",
    }
}

fn layer_for(path: &str) -> &'static str {
    let lower = path.to_ascii_lowercase();
    if lower.contains("test") || lower.contains("spec") || lower.contains("fixture") {
        "test"
    } else if lower.contains("vendor")
        || lower.contains("third_party")
        || lower.contains("external")
    {
        "vendor"
    } else if lower.contains("generated") || lower.contains("gen/") || lower.ends_with(".min.js") {
        "generated"
    } else if lower.contains("platform")
        || lower.contains("windows")
        || lower.contains("linux")
        || lower.contains("darwin")
    {
        "platform"
    } else if lower.contains("lib/") || lower.contains("libs/") || lower.contains("packages/") {
        "library"
    } else if lower.contains("docs/") || lower.ends_with(".md") {
        "docs"
    } else {
        "application"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(id: u32, path: &str, imports: &[&str]) -> FileRecord {
        let (directory, name) = path.rsplit_once('/').unwrap_or(("", path));
        FileRecord {
            id,
            path: path.into(),
            name: name.into(),
            directory: directory.into(),
            extension: "js".into(),
            language: "JavaScript".into(),
            layer: "application".into(),
            lines: 1,
            bytes: 1,
            complexity: 1,
            preview: String::new(),
            symbols: vec![],
            imports: imports.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn resolves_relative_imports_includes_and_index_files() {
        let files = vec![
            record(
                1,
                "src/main.js",
                &[
                    "./utils.js",
                    "../include/config.h",
                    "./widgets",
                    "./utils.js",
                ],
            ),
            record(2, "src/utils.js", &[]),
            record(3, "include/config.h", &[]),
            record(4, "src/widgets/index.ts", &[]),
            record(5, "elsewhere/utils.js", &[]),
        ];
        let edges = link_files(&files);
        assert_eq!(
            edges.iter().map(|e| (e.from, e.to)).collect::<Vec<_>>(),
            vec![(1, 2), (1, 3), (1, 4)]
        );
    }

    #[test]
    fn resolves_header_suffix_without_guessing_ambiguous_names() {
        let files = vec![
            record(1, "main.c", &["config.h", "utils.js", "missing.js"]),
            record(2, "include/config.h", &[]),
            record(3, "a/utils.js", &[]),
            record(4, "b/utils.js", &[]),
        ];
        let edges = link_files(&files);
        assert_eq!(
            edges.iter().map(|e| (e.from, e.to)).collect::<Vec<_>>(),
            vec![(1, 2)]
        );
    }

    #[test]
    fn extracts_named_javascript_import_target() {
        let imports: Vec<_> = import_patterns()
            .iter()
            .filter_map(|re| {
                re.captures("import { render } from './renderer.js';")
                    .map(|c| c[1].to_string())
            })
            .collect();
        assert_eq!(imports, vec!["./renderer.js"]);
    }

    #[test]
    fn classifies_languages_and_layers() {
        assert_eq!(language_for("rs"), "Rust");
        assert_eq!(language_for("tsx"), "TypeScript");
        assert_eq!(layer_for("src/widget.test.ts"), "test");
        assert_eq!(layer_for("vendor/lib.c"), "vendor");
    }

    #[test]
    fn extracts_common_symbols() {
        let patterns = definition_patterns();
        assert!(
            patterns
                .iter()
                .any(|(_, re)| re.is_match("pub fn render_scene() {"))
        );
        assert!(
            patterns
                .iter()
                .any(|(_, re)| re.is_match("class WindowManager {"))
        );
    }
}
