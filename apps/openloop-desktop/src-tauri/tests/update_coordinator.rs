use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::Arc,
    thread,
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use openloop_desktop_lib::update::{
    coordinator::{check_update, install_checked_update, DownloadStatus, InstallPublication},
    recovery::{CandidateHealth, HealthStatus},
};
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
use tauri_plugin_updater::{Update, Updater, UpdaterExt};
use tempfile::tempdir;

const SIGNED_TEST_PUBLIC_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXkgRTc2MjBGMTg0MkI0RTgxRgpSV1FmNkxSQ0dBOWk1M21sWWVjTzRJelQ1MVRHUHB2V3VjTlNDaDFDQk0wUVRhTG43M1k3R0ZPMwo=";
const TEST_SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIG1pbmlzaWduIHNlY3JldCBrZXkKUldRZjZMUkNHQTlpNTlTTE9GeHo2Tnh2QVNYREplUnR1Wnlrd1FlcGJERUd0ODdpZzFCTnBXYVZXdU5ybTczWWlJaUpicTcxV2krZFA5ZUtMOE9DMzUxdndJYXNTU2JYeHdBPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNTU1Nzc5OTY2CWZpbGU6dGVzdApRdEtNWFd5WWN3ZHBaQWxQRjd0RTJFTkprUmQxdWp2S2psajFtOVJ0SFRCblpQYTVXS1U1dVdSczVHb1A1TS9WcUU4MVFGdU1LSTVrL1NmTlFVYU9BQT09";

const VALID_ARCHIVE_PUBLIC_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEIwQ0VCRkI0MEFFQzA2QUEKUldTcUJ1d0t0TC9Pc1BhcXN0aXNtRXEreWtjY0o0VTV5YkU5R3hWbWxKRE1WcFoyVHZPcVZlVjAK";
const VALID_ARCHIVE: &str = "H4sIACbGhmoAA+3RQQ7CIBAFUI7CCXSAGXqMngF1ulEpwRrj7SW2MWq0qzaNcd7mbyYw8OvE8dC2aRVSWqt5AEBFpO/p+wSLfQ60IYuG0AF6DQbJkdI00z4vzqcu5LLK5trxLsQtf5krY00zcs7wjkf+iPq5/2PIe86T31H+wyOO9e/e+qfKWaVh8k0++PP+I1+WXkEIIcQCbu254eEACgAA";
const VALID_ARCHIVE_SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTcUJ1d0t0TC9Pc0JVOUQzL1owNTc4bUNPMC9KWmNWYng0VklnK3c4TUZka0o2SnVHTGFqclc0M1FRRytCclc0UVYzekpKUGRRNFBZODJic1U0WTFzWHdnbCtDaCt5bWdzPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzg3MjE3NDQ2CWZpbGU6dXBkYXRlLnRhci5negp1OENHNjJDQ3NvZ0lQRU9xdUFCK2RUMjhCU1BySEoxVmhHM0JiQzR2cUtQUFdhUHFadDRBVzlSdlR4dVRTVHZqMkxuaGdMNVVPK0Z1MWhFYzFKQ1hCQT09Cg==";

#[derive(Clone)]
struct Response {
    status: &'static str,
    content_type: &'static str,
    body: Vec<u8>,
}

struct TestServer {
    base_url: String,
    thread: Option<thread::JoinHandle<Result<(), String>>>,
}

impl TestServer {
    fn new(
        expected_requests: usize,
        routes: impl FnOnce(&str) -> HashMap<&'static str, Response>,
    ) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind update fixture server");
        listener
            .set_nonblocking(true)
            .expect("nonblocking fixture server");
        let address = listener.local_addr().expect("fixture server address");
        let base_url = format!("http://{address}");
        let routes = Arc::new(routes(&base_url));
        let thread = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut served = 0;
            while served < expected_requests && Instant::now() < deadline {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        serve(&mut stream, &routes)?;
                        served += 1;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => return Err(format!("accept update request: {error}")),
                }
            }
            if served != expected_requests {
                return Err(format!(
                    "expected {expected_requests} update requests, served {served}"
                ));
            }
            Ok(())
        });
        Self {
            base_url,
            thread: Some(thread),
        }
    }

    fn url(&self, path: &str) -> tauri::Url {
        format!("{}{path}", self.base_url)
            .parse()
            .expect("fixture URL")
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        let result = self
            .thread
            .take()
            .expect("fixture server thread")
            .join()
            .expect("fixture server did not panic");
        if !thread::panicking() {
            result.expect("fixture server completed");
        }
    }
}

fn serve(stream: &mut TcpStream, routes: &HashMap<&str, Response>) -> Result<(), String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|error| error.to_string())?;
    let mut request = Vec::new();
    while !request.windows(4).any(|window| window == b"\r\n\r\n") {
        let mut chunk = [0_u8; 1024];
        let count = stream
            .read(&mut chunk)
            .map_err(|error| format!("read update request: {error}"))?;
        if count == 0 || request.len() + count > 8192 {
            return Err("incomplete or oversized update request".to_owned());
        }
        request.extend_from_slice(&chunk[..count]);
    }
    let line = std::str::from_utf8(&request)
        .map_err(|error| error.to_string())?
        .lines()
        .next()
        .ok_or_else(|| "empty HTTP request".to_owned())?;
    let path = line
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| format!("invalid HTTP request line {line:?}"))?;
    let response = routes
        .get(path)
        .ok_or_else(|| format!("unexpected update request path {path:?}"))?;
    write!(
        stream,
        "HTTP/1.1 {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        response.status,
        response.content_type,
        response.body.len()
    )
    .map_err(|error| error.to_string())?;
    stream
        .write_all(&response.body)
        .and_then(|()| stream.flush())
        .map_err(|error| error.to_string())
}

fn no_content() -> Response {
    Response {
        status: "204 No Content",
        content_type: "application/json",
        body: Vec::new(),
    }
}

fn manifest(base_url: &str, version: &str, signature: &str) -> Response {
    Response {
        status: "200 OK",
        content_type: "application/json",
        body: serde_json::to_vec(&serde_json::json!({
            "version": version,
            "notes": "dynamic Cargo updater fixture",
            "pub_date": "2026-08-20T12:00:00Z",
            "platforms": {
                "darwin-aarch64": {
                    "url": format!("{base_url}/archive"),
                    "signature": signature,
                }
            }
        }))
        .expect("manifest JSON"),
    }
}

fn archive(body: Vec<u8>) -> Response {
    Response {
        status: "200 OK",
        content_type: "application/octet-stream",
        body,
    }
}

fn fixture_updater(public_key: &str, endpoint: tauri::Url) -> (tauri::App<MockRuntime>, Updater) {
    let mut context = mock_context(noop_assets());
    context.config_mut().plugins.0.insert(
        "updater".to_owned(),
        serde_json::json!({
            "pubkey": public_key,
            "endpoints": ["https://example.invalid/latest.json"],
        }),
    );
    let app = mock_builder()
        .plugin(
            tauri_plugin_updater::Builder::new()
                .pubkey(public_key)
                .build(),
        )
        .build(context)
        .expect("mock Tauri updater app");
    let updater = app
        .handle()
        .updater_builder()
        .endpoints(vec![endpoint])
        .expect("fixture endpoint")
        .target("darwin-aarch64")
        .build()
        .expect("fixture updater");
    (app, updater)
}

struct HealthProbe<F>(F);

impl<F> CandidateHealth for HealthProbe<F>
where
    F: FnMut(&Path, Duration) -> HealthStatus,
{
    fn await_health(&mut self, candidate: &Path, timeout: Duration) -> HealthStatus {
        (self.0)(candidate, timeout)
    }
}

fn installed_app(root: &Path) -> PathBuf {
    let installed = root.join("Openloop.app");
    fs::create_dir(&installed).expect("installed app");
    fs::write(installed.join("marker"), "old").expect("installed marker");
    installed
}

fn checked_update(server: &TestServer, public_key: &str) -> (tauri::App<MockRuntime>, Update) {
    let (app, updater) = fixture_updater(public_key, server.url("/manifest"));
    let (_report, update) =
        tauri::async_runtime::block_on(check_update(&updater, "0.1.0")).expect("check update");
    (app, update.expect("available update"))
}

#[test]
fn coordinator_check_reports_no_update_and_detected_update() {
    let no_update_server = TestServer::new(1, |_| HashMap::from([("/manifest", no_content())]));
    let (_app, updater) =
        fixture_updater(SIGNED_TEST_PUBLIC_KEY, no_update_server.url("/manifest"));

    let (report, update) =
        tauri::async_runtime::block_on(check_update(&updater, "0.1.0")).expect("check no update");

    assert_eq!(report.current, "0.1.0");
    assert_eq!(report.available, None);
    assert!(update.is_none());
    drop(no_update_server);

    let update_server = TestServer::new(1, |base_url| {
        HashMap::from([("/manifest", manifest(base_url, "0.2.0", TEST_SIGNATURE))])
    });
    let (_app, updater) = fixture_updater(SIGNED_TEST_PUBLIC_KEY, update_server.url("/manifest"));

    let (report, update) =
        tauri::async_runtime::block_on(check_update(&updater, "0.1.0")).expect("check update");

    assert_eq!(report.current, "0.1.0");
    assert_eq!(report.available.as_deref(), Some("0.2.0"));
    assert!(update.is_some());
}

#[test]
fn spike_reports_are_one_line_and_install_no_update_is_unambiguous() {
    let check = openloop_desktop_lib::update::coordinator::CheckReport {
        current: "0.1.0".into(),
        available: None,
    };
    assert_eq!(
        check.json_line().expect("check JSON"),
        "{\"current\":\"0.1.0\",\"available\":null}\n"
    );

    let install = openloop_desktop_lib::update::coordinator::InstallReport {
        current: "0.1.0".into(),
        available: None,
        download: DownloadStatus::NotStarted,
        publication: InstallPublication::NoUpdate,
    };
    assert_eq!(
        install.json_line().expect("install JSON"),
        "{\"current\":\"0.1.0\",\"available\":null,\"download\":\"notStarted\",\"publication\":{\"result\":\"noUpdate\"}}\n"
    );
}

#[test]
fn signature_failure_never_stages_or_publishes_a_candidate() {
    let server = TestServer::new(2, |base_url| {
        HashMap::from([
            ("/manifest", manifest(base_url, "0.2.0", TEST_SIGNATURE)),
            ("/archive", archive(b"Test".to_vec())),
        ])
    });
    let (_app, update) = checked_update(&server, SIGNED_TEST_PUBLIC_KEY);
    let root = tempdir().expect("update root");
    let installed = installed_app(root.path());
    let mut health =
        HealthProbe(|_: &Path, _: Duration| panic!("health must not run for a signature failure"));

    let error =
        tauri::async_runtime::block_on(install_checked_update(update, &installed, &mut health))
            .expect_err("tampered download must fail");

    assert!(
        error.to_string().contains("signature") || error.to_string().contains("verify"),
        "unexpected verification error: {error}"
    );
    assert_eq!(
        fs::read_dir(root.path()).expect("update root").count(),
        1,
        "signature failure left a staged candidate"
    );
    assert_eq!(
        fs::read_to_string(installed.join("marker")).expect("installed marker"),
        "old"
    );
}

#[test]
fn verified_download_commits_healthy_candidate_and_rolls_back_failed_health() {
    for expected_publication in [
        InstallPublication::Committed,
        InstallPublication::RolledBack(HealthStatus::Failed("injected failure".into())),
    ] {
        let server = TestServer::new(2, |base_url| {
            HashMap::from([
                (
                    "/manifest",
                    manifest(base_url, "0.2.0", VALID_ARCHIVE_SIGNATURE),
                ),
                (
                    "/archive",
                    archive(
                        STANDARD
                            .decode(VALID_ARCHIVE)
                            .expect("valid archive base64"),
                    ),
                ),
            ])
        });
        let (_app, update) = checked_update(&server, VALID_ARCHIVE_PUBLIC_KEY);
        let root = tempdir().expect("update root");
        let installed = installed_app(root.path());
        let status = match &expected_publication {
            InstallPublication::Committed => HealthStatus::Healthy,
            InstallPublication::RolledBack(status) => status.clone(),
            InstallPublication::NoUpdate => unreachable!("fixture always provides an update"),
        };
        let mut health = HealthProbe(move |published: &Path, timeout: Duration| {
            assert_eq!(timeout, Duration::from_secs(60));
            assert_eq!(
                fs::read_to_string(published.join("marker")).expect("published marker"),
                "new"
            );
            status.clone()
        });

        let report =
            tauri::async_runtime::block_on(install_checked_update(update, &installed, &mut health))
                .expect("verified install transaction");

        assert_eq!(report.download, DownloadStatus::Verified);
        assert_eq!(report.publication, expected_publication);
        let expected_marker = if report.publication == InstallPublication::Committed {
            "new"
        } else {
            "old"
        };
        assert_eq!(
            fs::read_to_string(installed.join("marker")).expect("final installed marker"),
            expected_marker
        );
        assert_eq!(
            fs::read_dir(root.path()).expect("update root").count(),
            1,
            "completed transaction left candidate or recovery markers"
        );
    }
}
