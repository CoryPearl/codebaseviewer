mod indexer;

use indexer::{Edge, Snapshot};
use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Job {
    id: String,
    source_kind: String,
    name: String,
    phase: String,
    completed: usize,
    total: usize,
    message: String,
    snapshot_id: Option<String>,
    error: Option<String>,
    warnings: Vec<String>,
    #[serde(skip)]
    root: PathBuf,
}

#[derive(Default)]
struct State {
    jobs: Mutex<HashMap<String, Job>>,
    snapshots: Mutex<HashMap<String, Snapshot>>,
}

#[derive(Deserialize)]
struct NewJob {
    kind: String,
    name: Option<String>,
    url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchHit<'a> {
    entity_id: u32,
    path: &'a str,
    name: String,
    line: usize,
    kind: &'static str,
    preview: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SceneFile<'a> {
    id: u32,
    path: &'a str,
    name: &'a str,
    directory: &'a str,
    extension: &'a str,
    language: &'a str,
    layer: &'a str,
    lines: usize,
    bytes: usize,
    complexity: usize,
    preview: &'a str,
    symbol_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SceneResponse<'a> {
    id: &'a str,
    name: &'a str,
    source: &'a str,
    files: Vec<SceneFile<'a>>,
    edges: &'a [Edge],
    total_lines: usize,
    definitions: usize,
    references: usize,
}

fn main() -> io::Result<()> {
    let mut port = std::env::var("PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(4177);
    let mut open = false;
    let args: Vec<String> = std::env::args().collect();
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--port" if i + 1 < args.len() => {
                port = args[i + 1].parse().unwrap_or(4177);
                i += 1;
            }
            "--open" => open = true,
            "--help" | "-h" => {
                println!("codebaseviewer [--port 4177] [--open]");
                return Ok(());
            }
            _ => {}
        }
        i += 1;
    }

    let listener = TcpListener::bind(("0.0.0.0", port))?;
    let state = Arc::new(State::default());
    println!("Codebase Viewer API started");
    if open {
        let _ = Command::new("open")
            .arg(format!("http://127.0.0.1:{port}"))
            .spawn();
    }
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let state = Arc::clone(&state);
                thread::spawn(move || {
                    if let Err(error) = handle_connection(stream, state) {
                        eprintln!("request failed: {error}");
                    }
                });
            }
            Err(error) => eprintln!("connection failed: {error}"),
        }
    }
    Ok(())
}

fn handle_connection(mut stream: TcpStream, state: Arc<State>) -> io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(30)))?;
    let cloned = stream.try_clone()?;
    let mut reader = BufReader::new(cloned);
    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("/").to_string();
    let mut headers = HashMap::new();
    loop {
        let mut line = String::new();
        reader.read_line(&mut line)?;
        if line == "\r\n" || line.is_empty() {
            break;
        }
        if let Some((key, value)) = line.split_once(':') {
            headers.insert(key.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    let length = headers
        .get("content-length")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(0)
        .min(64 * 1024 * 1024);
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body)?;
    let (path, query) = target.split_once('?').unwrap_or((&target, ""));

    match (method.as_str(), path) {
        ("OPTIONS", _) => respond(&mut stream, 204, "text/plain; charset=utf-8", &[]),
        ("GET", "/") => json_response(
            &mut stream,
            200,
            &json!({"service": "codebaseviewer-api", "health": "/api/health"}),
        ),
        ("HEAD", "/") => respond(&mut stream, 200, "application/json; charset=utf-8", &[]),
        ("GET", "/api/health") => {
            json_response(&mut stream, 200, &json!({"ok": true, "version": "0.1.0"}))
        }
        ("POST", "/api/jobs") => create_job(&mut stream, state, &body),
        _ if path.starts_with("/api/jobs/") => {
            handle_job_route(&mut stream, state, &method, path, query, &body)
        }
        _ if path.starts_with("/api/snapshots/") => {
            handle_snapshot_route(&mut stream, state, path, query)
        }
        _ => json_response(&mut stream, 404, &json!({"error": "Not found"})),
    }
}

fn create_job(stream: &mut TcpStream, state: Arc<State>, body: &[u8]) -> io::Result<()> {
    let request: NewJob = match serde_json::from_slice(body) {
        Ok(value) => value,
        Err(_) => return json_response(stream, 400, &json!({"error": "Invalid job request"})),
    };
    let id = unique_id("job");
    let root = std::env::temp_dir().join("codebaseviewer").join(&id);
    fs::create_dir_all(&root)?;
    let name = request
        .name
        .clone()
        .unwrap_or_else(|| "Local codebase".into());
    let job = Job {
        id: id.clone(),
        source_kind: request.kind.clone(),
        name,
        phase: if request.kind == "github" {
            "cloning".into()
        } else {
            "receiving".into()
        },
        completed: 0,
        total: 0,
        message: if request.kind == "github" {
            "Cloning repository…".into()
        } else {
            "Waiting for files…".into()
        },
        snapshot_id: None,
        error: None,
        warnings: vec![],
        root: root.clone(),
    };
    state.jobs.lock().unwrap().insert(id.clone(), job);

    if request.kind == "github" {
        let Some(url) = request.url else {
            return json_response(stream, 400, &json!({"error": "Missing GitHub URL"}));
        };
        if !valid_github_url(&url) {
            return json_response(
                stream,
                400,
                &json!({"error": "Use a public github.com owner/repository URL"}),
            );
        }
        let thread_state = Arc::clone(&state);
        let thread_id = id.clone();
        thread::spawn(move || {
            let checkout = root.join("repo");
            let result = Command::new("git")
                .args(["clone", "--depth=1", "--single-branch", "--quiet", &url])
                .arg(&checkout)
                .status();
            match result {
                Ok(status) if status.success() => index_job(thread_state, thread_id, checkout),
                Ok(status) => fail_job(
                    &thread_state,
                    &thread_id,
                    format!("git clone exited with {status}"),
                ),
                Err(error) => fail_job(
                    &thread_state,
                    &thread_id,
                    format!("Could not start git: {error}"),
                ),
            }
        });
    }
    json_response(stream, 201, &json!({"jobId": id}))
}

fn handle_job_route(
    stream: &mut TcpStream,
    state: Arc<State>,
    method: &str,
    path: &str,
    query: &str,
    body: &[u8],
) -> io::Result<()> {
    let suffix = path.trim_start_matches("/api/jobs/");
    let mut parts = suffix.split('/');
    let id = parts.next().unwrap_or("");
    let action = parts.next().unwrap_or("");
    match (method, action) {
        ("GET", "") => {
            let jobs = state.jobs.lock().unwrap();
            match jobs.get(id) {
                Some(job) => json_response(stream, 200, job),
                None => json_response(stream, 404, &json!({"error": "Unknown job"})),
            }
        }
        ("GET", "events") => stream_job_events(stream, state, id),
        ("POST", "files") => {
            let path_value = query_param(query, "path").unwrap_or_default();
            let decoded = percent_decode_str(&path_value).decode_utf8_lossy();
            let Some(relative) = safe_relative_path(&decoded) else {
                return json_response(stream, 400, &json!({"error": "Unsafe file path"}));
            };
            let root = {
                let jobs = state.jobs.lock().unwrap();
                match jobs.get(id) {
                    Some(job) if job.source_kind == "local" => job.root.clone(),
                    _ => return json_response(stream, 404, &json!({"error": "Unknown local job"})),
                }
            };
            let output = root.join("files").join(relative);
            if let Some(parent) = output.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(output, body)?;
            let mut jobs = state.jobs.lock().unwrap();
            if let Some(job) = jobs.get_mut(id) {
                job.completed += 1;
                job.total = job.completed;
                job.message = format!("Received {} files", job.completed);
            }
            json_response(stream, 200, &json!({"ok": true}))
        }
        ("POST", "commit") => {
            let root = {
                let mut jobs = state.jobs.lock().unwrap();
                match jobs.get_mut(id) {
                    Some(job) if job.source_kind == "local" => {
                        job.phase = "scanning".into();
                        job.message = "Scanning files…".into();
                        job.root.join("files")
                    }
                    _ => return json_response(stream, 404, &json!({"error": "Unknown local job"})),
                }
            };
            let thread_state = Arc::clone(&state);
            let thread_id = id.to_string();
            thread::spawn(move || index_job(thread_state, thread_id, root));
            json_response(stream, 202, &json!({"ok": true}))
        }
        _ => json_response(stream, 404, &json!({"error": "Unknown job route"})),
    }
}

fn handle_snapshot_route(
    stream: &mut TcpStream,
    state: Arc<State>,
    path: &str,
    query: &str,
) -> io::Result<()> {
    let suffix = path.trim_start_matches("/api/snapshots/");
    let mut parts = suffix.split('/');
    let id = parts.next().unwrap_or("");
    let action = parts.next().unwrap_or("");
    let entity = parts.next().unwrap_or("");
    let entity_action = parts.next().unwrap_or("");
    let snapshots = state.snapshots.lock().unwrap();
    let Some(snapshot) = snapshots.get(id) else {
        return json_response(stream, 404, &json!({"error": "Unknown snapshot"}));
    };
    match action {
        "" => json_response(
            stream,
            200,
            &json!({
                "id": snapshot.id,
                "name": snapshot.name,
                "source": snapshot.source,
                "fileCount": snapshot.files.len(),
                "totalLines": snapshot.total_lines,
                "definitions": snapshot.definitions,
                "references": snapshot.references,
                "edges": snapshot.edges.len(),
                "warnings": snapshot.warnings,
            }),
        ),
        "scene" => {
            let files = snapshot
                .files
                .iter()
                .map(|file| SceneFile {
                    id: file.id,
                    path: &file.path,
                    name: &file.name,
                    directory: &file.directory,
                    extension: &file.extension,
                    language: &file.language,
                    layer: &file.layer,
                    lines: file.lines,
                    bytes: file.bytes,
                    complexity: file.complexity,
                    preview: &file.preview,
                    symbol_count: file.symbols.len(),
                })
                .collect();
            json_response(
                stream,
                200,
                &SceneResponse {
                    id: &snapshot.id,
                    name: &snapshot.name,
                    source: &snapshot.source,
                    files,
                    edges: &snapshot.edges,
                    total_lines: snapshot.total_lines,
                    definitions: snapshot.definitions,
                    references: snapshot.references,
                },
            )
        }
        "search" => {
            let needle = query_param(query, "q")
                .unwrap_or_default()
                .to_ascii_lowercase();
            let mut hits: Vec<SearchHit<'_>> = Vec::new();
            if needle.len() >= 2 {
                for file in &snapshot.files {
                    if hits.len() >= 180 {
                        break;
                    }
                    if file.path.to_ascii_lowercase().contains(&needle) {
                        hits.push(SearchHit {
                            entity_id: file.id,
                            path: &file.path,
                            name: file.name.clone(),
                            line: 1,
                            kind: "file",
                            preview: file.preview.lines().next().unwrap_or("").to_string(),
                        });
                    }
                    for symbol in &file.symbols {
                        if hits.len() >= 180 {
                            break;
                        }
                        if symbol.name.to_ascii_lowercase().contains(&needle) {
                            hits.push(SearchHit {
                                entity_id: file.id,
                                path: &file.path,
                                name: symbol.name.clone(),
                                line: symbol.line,
                                kind: "definition",
                                preview: symbol.signature.clone(),
                            });
                        }
                    }
                }
            }
            json_response(stream, 200, &hits)
        }
        "entities" => match entity
            .parse::<u32>()
            .ok()
            .and_then(|entity_id| snapshot.files.iter().find(|file| file.id == entity_id))
        {
            Some(file) if entity_action == "source" => {
                let start = query_param(query, "start")
                    .and_then(|value| value.parse::<usize>().ok())
                    .unwrap_or(0)
                    .min(file.lines);
                let limit = query_param(query, "limit")
                    .and_then(|value| value.parse::<usize>().ok())
                    .unwrap_or(600)
                    .clamp(1, 4096);
                let Some(relative) = safe_relative_path(&file.path) else {
                    return json_response(stream, 400, &json!({"error": "Unsafe file path"}));
                };
                let source = match fs::File::open(snapshot.root.join(relative)) {
                    Ok(source) => source,
                    Err(_) => {
                        return json_response(stream, 404, &json!({"error": "Source unavailable"}));
                    }
                };
                let lines: Vec<String> = BufReader::new(source)
                    .lines()
                    .skip(start)
                    .take(limit)
                    .map_while(Result::ok)
                    .collect();
                json_response(
                    stream,
                    200,
                    &json!({"start": start, "lines": lines, "totalLines": file.lines}),
                )
            }
            Some(file) if entity_action.is_empty() => json_response(stream, 200, file),
            Some(_) => json_response(stream, 404, &json!({"error": "Unknown entity route"})),
            None => json_response(stream, 404, &json!({"error": "Unknown entity"})),
        },
        _ => json_response(stream, 404, &json!({"error": "Unknown snapshot route"})),
    }
}

fn stream_job_events(stream: &mut TcpStream, state: Arc<State>, id: &str) -> io::Result<()> {
    let origin = cors_origin();
    write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\nAccess-Control-Allow-Origin: {origin}\r\n\r\n"
    )?;
    stream.flush()?;
    let mut last = String::new();
    for _ in 0..1200 {
        let job = state.jobs.lock().unwrap().get(id).cloned();
        let Some(job) = job else {
            break;
        };
        let encoded = serde_json::to_string(&job).unwrap();
        if encoded != last {
            write!(stream, "event: progress\ndata: {encoded}\n\n")?;
            stream.flush()?;
            last = encoded;
        }
        if job.snapshot_id.is_some() || job.error.is_some() {
            break;
        }
        thread::sleep(Duration::from_millis(150));
    }
    Ok(())
}

fn index_job(state: Arc<State>, id: String, root: PathBuf) {
    update_job(&state, &id, "scanning", 0, 0, "Discovering source files…");
    let progress_state = Arc::clone(&state);
    let progress_id = id.clone();
    let result = indexer::index_directory(&root, move |phase, completed, total, message| {
        update_job(
            &progress_state,
            &progress_id,
            phase,
            completed,
            total,
            message,
        );
    });
    match result {
        Ok(mut snapshot) => {
            let (name, source) = {
                let jobs = state.jobs.lock().unwrap();
                let job = jobs.get(&id).unwrap();
                (job.name.clone(), job.source_kind.clone())
            };
            snapshot.id = unique_id("snapshot");
            snapshot.name = name;
            snapshot.source = source;
            let snapshot_id = snapshot.id.clone();
            state
                .snapshots
                .lock()
                .unwrap()
                .insert(snapshot_id.clone(), snapshot);
            let mut jobs = state.jobs.lock().unwrap();
            if let Some(job) = jobs.get_mut(&id) {
                job.phase = "ready".into();
                job.message = "Landscape ready".into();
                job.snapshot_id = Some(snapshot_id);
                job.completed = job.total.max(job.completed);
            }
        }
        Err(error) => fail_job(&state, &id, error),
    }
}

fn update_job(
    state: &Arc<State>,
    id: &str,
    phase: &str,
    completed: usize,
    total: usize,
    message: &str,
) {
    if let Some(job) = state.jobs.lock().unwrap().get_mut(id) {
        job.phase = phase.into();
        job.completed = completed;
        job.total = total;
        job.message = message.into();
    }
}

fn fail_job(state: &Arc<State>, id: &str, error: String) {
    if let Some(job) = state.jobs.lock().unwrap().get_mut(id) {
        job.phase = "error".into();
        job.message = "Indexing failed".into();
        job.error = Some(error);
    }
}

fn valid_github_url(value: &str) -> bool {
    let clean = value.trim().trim_end_matches('/').trim_end_matches(".git");
    let Some(rest) = clean.strip_prefix("https://github.com/") else {
        return false;
    };
    let mut parts = rest.split('/');
    matches!((parts.next(), parts.next(), parts.next()), (Some(a), Some(b), None) if !a.is_empty() && !b.is_empty() && a.chars().all(safe_slug) && b.chars().all(safe_slug))
}

fn safe_slug(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')
}

fn safe_relative_path(value: &str) -> Option<PathBuf> {
    let path = Path::new(value);
    if path.is_absolute() {
        return None;
    }
    let mut clean = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::Normal(part) => clean.push(part),
            _ => return None,
        }
    }
    if clean.as_os_str().is_empty() {
        None
    } else {
        Some(clean)
    }
}

fn query_param(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        (k == key).then(|| v.replace('+', " "))
    })
}

fn unique_id(prefix: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("{prefix}-{nanos:x}")
}

fn respond(stream: &mut TcpStream, status: u16, content_type: &str, body: &[u8]) -> io::Result<()> {
    let origin = cors_origin();
    let phrase = match status {
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        204 => "No Content",
        400 => "Bad Request",
        404 => "Not Found",
        _ => "Error",
    };
    write!(
        stream,
        "HTTP/1.1 {status} {phrase}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nAccess-Control-Allow-Origin: {origin}\r\nAccess-Control-Allow-Methods: GET, HEAD, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type, ngrok-skip-browser-warning\r\nAccess-Control-Max-Age: 86400\r\nConnection: close\r\n\r\n",
        body.len()
    )?;
    stream.write_all(body)
}

fn cors_origin() -> String {
    std::env::var("CORS_ORIGIN")
        .ok()
        .filter(|value| {
            !value.is_empty() && !value.bytes().any(|byte| matches!(byte, b'\r' | b'\n'))
        })
        .unwrap_or_else(|| "*".into())
}

fn json_response<T: Serialize>(stream: &mut TcpStream, status: u16, value: &T) -> io::Result<()> {
    let body = serde_json::to_vec(value)
        .unwrap_or_else(|_| b"{\"error\":\"serialization failed\"}".to_vec());
    respond(stream, status, "application/json; charset=utf-8", &body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn github_url_validation() {
        assert!(valid_github_url("https://github.com/makepad/makepad"));
        assert!(valid_github_url("https://github.com/a/b.git"));
        assert!(!valid_github_url("https://example.com/a/b"));
        assert!(!valid_github_url("https://github.com/a/b/tree/main"));
    }

    #[test]
    fn path_validation() {
        assert_eq!(
            safe_relative_path("src/main.rs").unwrap(),
            PathBuf::from("src/main.rs")
        );
        assert!(safe_relative_path("../secret").is_none());
        assert!(safe_relative_path("/etc/passwd").is_none());
    }
}
