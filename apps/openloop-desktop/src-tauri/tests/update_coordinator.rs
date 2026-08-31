use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    net::{Shutdown, TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    thread,
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use openloop_desktop_lib::update::{
    channel::ReleaseChannel,
    coordinator::{
        check_update, install_checked_update, install_checked_update_with_observer,
        validate_download_url, DownloadStatus, DownloadUrlPolicy, InstallPublication,
    },
    recovery::{CandidateHealth, HealthStatus},
    state::{UpdateInstallObserver, UpdateStateError},
};
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
use tauri_plugin_updater::{Update, Updater, UpdaterExt};
use tempfile::tempdir;

const SIGNED_TEST_PUBLIC_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXkgRTc2MjBGMTg0MkI0RTgxRgpSV1FmNkxSQ0dBOWk1M21sWWVjTzRJelQ1MVRHUHB2V3VjTlNDaDFDQk0wUVRhTG43M1k3R0ZPMwo=";
const TEST_SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIG1pbmlzaWduIHNlY3JldCBrZXkKUldRZjZMUkNHQTlpNTlTTE9GeHo2Tnh2QVNYREplUnR1Wnlrd1FlcGJERUd0ODdpZzFCTnBXYVZXdU5ybTczWWlJaUpicTcxV2krZFA5ZUtMOE9DMzUxdndJYXNTU2JYeHdBPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNTU1Nzc5OTY2CWZpbGU6dGVzdApRdEtNWFd5WWN3ZHBaQWxQRjd0RTJFTkprUmQxdWp2S2psajFtOVJ0SFRCblpQYTVXS1U1dVdSczVHb1A1TS9WcUU4MVFGdU1LSTVrL1NmTlFVYU9BQT09";

const VALID_ARCHIVE_PUBLIC_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEIwQ0VCRkI0MEFFQzA2QUEKUldTcUJ1d0t0TC9Pc1BhcXN0aXNtRXEreWtjY0o0VTV5YkU5R3hWbWxKRE1WcFoyVHZPcVZlVjAK";
const VALID_ARCHIVE: &str = "H4sIACbGhmoAA+3RQQ7CIBAFUI7CCXSAGXqMngF1ulEpwRrj7SW2MWq0qzaNcd7mbyYw8OvE8dC2aRVSWqt5AEBFpO/p+wSLfQ60IYuG0AF6DQbJkdI00z4vzqcu5LLK5trxLsQtf5krY00zcs7wjkf+iPq5/2PIe86T31H+wyOO9e/e+qfKWaVh8k0++PP+I1+WXkEIIcQCbu254eEACgAA";
const VALID_ARCHIVE_SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTcUJ1d0t0TC9Pc0JVOUQzL1owNTc4bUNPMC9KWmNWYng0VklnK3c4TUZka0o2SnVHTGFqclc0M1FRRytCclc0UVYzekpKUGRRNFBZODJic1U0WTFzWHdnbCtDaCt5bWdzPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzg3MjE3NDQ2CWZpbGU6dXBkYXRlLnRhci5negp1OENHNjJDQ3NvZ0lQRU9xdUFCK2RUMjhCU1BySEoxVmhHM0JiQzR2cUtQUFdhUHFadDRBVzlSdlR4dVRTVHZqMkxuaGdMNVVPK0Z1MWhFYzFKQ1hCQT09Cg==";

// Mock updater apps share process-level HTTP/runtime state on macOS CI.
static UPDATE_FIXTURE_LOCK: Mutex<()> = Mutex::new(());

struct UpdateFixtureGuard {
    _guard: MutexGuard<'static, ()>,
}

fn update_fixture_guard() -> UpdateFixtureGuard {
    let guard = UPDATE_FIXTURE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    UpdateFixtureGuard { _guard: guard }
}

#[derive(Clone)]
struct Response {
    status: &'static str,
    content_type: &'static str,
    body: Vec<u8>,
    declared_length: Option<usize>,
}

struct TestServer<'fixture> {
    base_url: String,
    thread: Option<thread::JoinHandle<Result<(), String>>>,
    _guard: &'fixture UpdateFixtureGuard,
}

impl<'fixture> TestServer<'fixture> {
    fn new(
        guard: &'fixture UpdateFixtureGuard,
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
            _guard: guard,
        }
    }

    fn url(&self, path: &str) -> tauri::Url {
        format!("{}{path}", self.base_url)
            .parse()
            .expect("fixture URL")
    }
}

impl Drop for TestServer<'_> {
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
        response.declared_length.unwrap_or(response.body.len())
    )
    .map_err(|error| error.to_string())?;
    stream
        .write_all(&response.body)
        .and_then(|()| stream.flush())
        .map_err(|error| error.to_string())?;
    stream
        .shutdown(Shutdown::Write)
        .map_err(|error| format!("finish update response: {error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_millis(100)))
        .map_err(|error| error.to_string())?;
    let mut drain = [0_u8; 1024];
    loop {
        match stream.read(&mut drain) {
            Ok(0) => break,
            Ok(_) => {}
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                break;
            }
            Err(error) => return Err(format!("drain update request: {error}")),
        }
    }
    Ok(())
}

#[test]
fn fixture_server_finishes_its_response_before_closing_the_socket() {
    let fixture = update_fixture_guard();
    let server = TestServer::new(&fixture, 1, |_| {
        HashMap::from([(
            "/manifest",
            Response {
                status: "200 OK",
                content_type: "text/plain",
                body: b"complete fixture response".to_vec(),
                declared_length: None,
            },
        )])
    });
    let endpoint = server.url("/manifest");
    let mut stream = TcpStream::connect((
        endpoint.host_str().expect("fixture host"),
        endpoint.port().expect("fixture port"),
    ))
    .expect("connect fixture server");
    let trailing_request = vec![b'x'; 8192];
    write!(
        stream,
        "GET /manifest HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: {}\r\n\r\n",
        trailing_request.len()
    )
    .expect("write fixture request headers");
    stream
        .write_all(&trailing_request)
        .expect("write trailing fixture request bytes");
    stream.flush().expect("flush fixture request");

    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .expect("read complete fixture response");
    assert!(
        response.ends_with(b"complete fixture response"),
        "fixture response was truncated: {}",
        String::from_utf8_lossy(&response)
    );
}

fn no_content() -> Response {
    Response {
        status: "204 No Content",
        content_type: "application/json",
        body: Vec::new(),
        declared_length: None,
    }
}

fn manifest(base_url: &str, version: &str, signature: &str) -> Response {
    manifest_with_url(version, signature, &format!("{base_url}/archive"))
}

fn manifest_with_url(version: &str, signature: &str, url: &str) -> Response {
    Response {
        status: "200 OK",
        content_type: "application/json",
        body: serde_json::to_vec(&serde_json::json!({
            "version": version,
            "notes": "dynamic Cargo updater fixture",
            "pub_date": "2026-08-20T12:00:00Z",
            "platforms": {
                "darwin-aarch64": {
                    "url": url,
                    "signature": signature,
                }
            }
        }))
        .expect("manifest JSON"),
        declared_length: None,
    }
}

fn archive(body: Vec<u8>) -> Response {
    Response {
        status: "200 OK",
        content_type: "application/octet-stream",
        body,
        declared_length: None,
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

fn fixture_updater_with_openloop_target(
    public_key: &str,
    endpoint: tauri::Url,
) -> (tauri::App<MockRuntime>, Updater) {
    let mut context = mock_context(noop_assets());
    context.config_mut().plugins.0.insert(
        "updater".to_owned(),
        serde_json::json!({
            "pubkey": public_key,
            "endpoints": [endpoint.as_str()],
            "dangerousInsecureTransportProtocol": true,
        }),
    );
    let app = mock_builder()
        .plugin(
            tauri_plugin_updater::Builder::new()
                .target("darwin-aarch64")
                .pubkey(public_key)
                .build(),
        )
        .build(context)
        .expect("mock Tauri updater app");
    let updater = app.handle().updater().expect("fixture updater");
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

fn checked_update(server: &TestServer<'_>, public_key: &str) -> (tauri::App<MockRuntime>, Update) {
    let (app, updater) = fixture_updater(public_key, server.url("/manifest"));
    let policy =
        DownloadUrlPolicy::local_test_fixture(&server.url("/archive")).expect("fixture policy");
    let (_report, update) =
        tauri::async_runtime::block_on(check_update(&updater, "0.1.0", &policy))
            .expect("check update");
    (app, update.expect("available update"))
}

#[test]
fn coordinator_check_reports_no_update_and_detected_update() {
    let fixture = update_fixture_guard();
    let no_update_server = TestServer::new(&fixture, 1, |_| {
        HashMap::from([("/manifest", no_content())])
    });
    let (_app, updater) =
        fixture_updater(SIGNED_TEST_PUBLIC_KEY, no_update_server.url("/manifest"));
    let policy = DownloadUrlPolicy::local_test_fixture(&no_update_server.url("/archive"))
        .expect("fixture policy");

    let (report, update) = tauri::async_runtime::block_on(check_update(&updater, "0.1.0", &policy))
        .expect("check no update");

    assert_eq!(report.current, "0.1.0");
    assert_eq!(report.available, None);
    assert!(update.is_none());
    drop(no_update_server);

    let update_server = TestServer::new(&fixture, 1, |base_url| {
        HashMap::from([("/manifest", manifest(base_url, "0.2.0", TEST_SIGNATURE))])
    });
    let (_app, updater) = fixture_updater(SIGNED_TEST_PUBLIC_KEY, update_server.url("/manifest"));
    let policy = DownloadUrlPolicy::local_test_fixture(&update_server.url("/archive"))
        .expect("fixture policy");

    let (report, update) = tauri::async_runtime::block_on(check_update(&updater, "0.1.0", &policy))
        .expect("check update");

    assert_eq!(report.current, "0.1.0");
    assert_eq!(report.available.as_deref(), Some("0.2.0"));
    assert!(update.is_some());
}

#[test]
fn coordinator_pins_tauri_to_the_static_openloop_platform_target() {
    let fixture = update_fixture_guard();
    let server = TestServer::new(&fixture, 1, |base_url| {
        HashMap::from([("/manifest", manifest(base_url, "0.2.0", TEST_SIGNATURE))])
    });
    let (_app, updater) =
        fixture_updater_with_openloop_target(SIGNED_TEST_PUBLIC_KEY, server.url("/manifest"));
    let policy =
        DownloadUrlPolicy::local_test_fixture(&server.url("/archive")).expect("fixture policy");

    let (report, update) = tauri::async_runtime::block_on(check_update(&updater, "0.1.0", &policy))
        .expect("Openloop target must retain the selected raw platform URL");

    assert_eq!(report.available.as_deref(), Some("0.2.0"));
    assert_eq!(update.expect("available update").target, "darwin-aarch64");
}

#[test]
fn production_download_policy_accepts_only_immutable_repository_release_assets() {
    let accepted = [
        (
            ReleaseChannel::Test,
            "https://github.com/SerienYang/OpenLoop-base-Deepseek-Harness/releases/download/openloop-test-a-v1.2.3/Openloop.app.tar.gz",
        ),
        (
            ReleaseChannel::Test,
            "https://github.com/SerienYang/OpenLoop-base-Deepseek-Harness/releases/download/openloop-test-b-v1.2.3/Openloop.app.tar.gz",
        ),
        (
            ReleaseChannel::Stable,
            "https://github.com/SerienYang/OpenLoop-base-Deepseek-Harness/releases/download/openloop-stable-v1.2.3/Openloop.app.tar.gz",
        ),
    ];
    for (channel, value) in accepted {
        let url = value.parse().expect("accepted URL");
        validate_download_url(value, &url, "1.2.3", channel).expect(value);
    }

    let rejected = [
        "http://github.com/SerienYang/OpenLoop-base-Deepseek-Harness/releases/download/openloop-test-a-v1.2.3/Openloop.app.tar.gz",
        "https://example.com/SerienYang/OpenLoop-base-Deepseek-Harness/releases/download/openloop-test-a-v1.2.3/Openloop.app.tar.gz",
        "https://localhost/SerienYang/OpenLoop-base-Deepseek-Harness/releases/download/openloop-test-a-v1.2.3/Openloop.app.tar.gz",
        "https://user:pass@github.com/SerienYang/OpenLoop-base-Deepseek-Harness/releases/download/openloop-test-a-v1.2.3/Openloop.app.tar.gz",
        "https://github.com:443/SerienYang/OpenLoop-base-Deepseek-Harness/releases/download/openloop-test-a-v1.2.3/Openloop.app.tar.gz",
        "https://github.com:444/SerienYang/OpenLoop-base-Deepseek-Harness/releases/download/openloop-test-a-v1.2.3/Openloop.app.tar.gz",
        "https://github.com/SerienYang/OpenLoop-base-Deepseek-Harness/releases/download/openloop-test-a-v1.2.3/Openloop.app.tar.gz?redirect=https://example.com",
        "https://github.com/SerienYang/OpenLoop-base-Deepseek-Harness/releases/download/openloop-test-a-v1.2.3/Openloop.app.tar.gz#fragment",
        "https://github.com/SerienYang/OpenLoop-base-Deepseek-Harness/releases/download/openloop-test-a-v1.2.3/Openloop.app.tar.gz/redirect",
        "https://github.com/SerienYang/OpenLoop-base-Deepseek-Harness/releases/download/openloop-test-a-v1.2.3%2Fignored/Openloop.app.tar.gz",
        "https://github.com/SerienYang/OpenLoop-base-Deepseek-Harness/releases/download/openloop-test-a-v9.9.9/Openloop.app.tar.gz",
        "https://github.com/SerienYang/OpenLoop-base-Deepseek-Harness/releases/download/openloop-test-rolling/Openloop.app.tar.gz",
    ];
    for value in rejected {
        let url = value.parse().expect("syntactically valid rejected URL");
        assert!(
            validate_download_url(value, &url, "1.2.3", ReleaseChannel::Test).is_err(),
            "accepted unsafe download URL {value}"
        );
    }
    let test_asset = accepted[0].1.parse().expect("test asset URL");
    assert!(
        validate_download_url(accepted[0].1, &test_asset, "1.2.3", ReleaseChannel::Stable).is_err(),
        "stable channel accepted a test release tag"
    );
}

#[test]
fn production_policy_validates_the_raw_platform_url_before_download() {
    let fixture = update_fixture_guard();
    let cases = [
        "https://github.com:443/SerienYang/OpenLoop-base-Deepseek-Harness/releases/download/openloop-test-a-v0.2.0/Openloop.app.tar.gz",
        "https://GITHUB.com/SerienYang/OpenLoop-base-Deepseek-Harness/releases/download/openloop-test-a-v0.2.0/Openloop.app.tar.gz",
        "https://github.com/%53erienYang/OpenLoop-base-Deepseek-Harness/releases/download/openloop-test-a-v0.2.0/Openloop.app.tar.gz",
        "https://github.com/SerienYang/OpenLoop-base-Deepseek-Harness/releases/download/openloop-test-a-v0.2.0/Openloop.app.tar%2Egz",
    ];
    for raw_url in cases {
        let server = TestServer::new(&fixture, 1, |_| {
            HashMap::from([(
                "/manifest",
                manifest_with_url("0.2.0", TEST_SIGNATURE, raw_url),
            )])
        });
        let (_app, updater) = fixture_updater(SIGNED_TEST_PUBLIC_KEY, server.url("/manifest"));
        let policy = DownloadUrlPolicy::production(ReleaseChannel::Test);

        let error = match tauri::async_runtime::block_on(check_update(&updater, "0.1.0", &policy)) {
            Ok(_) => panic!("raw URL normalization bypass must fail before download"),
            Err(error) => error,
        };

        assert!(
            error.to_string().contains("unsafe update download URL"),
            "unexpected raw URL error for {raw_url}: {error}"
        );
    }
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
        preserved_backup: None,
        failed_candidate: None,
    };
    assert_eq!(
        install.json_line().expect("install JSON"),
        "{\"current\":\"0.1.0\",\"available\":null,\"download\":\"notStarted\",\"publication\":{\"result\":\"noUpdate\"},\"preservedBackup\":null,\"failedCandidate\":null}\n"
    );
}

#[test]
fn signature_failure_never_stages_or_publishes_a_candidate() {
    let fixture = update_fixture_guard();
    let server = TestServer::new(&fixture, 2, |base_url| {
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
    let policy =
        DownloadUrlPolicy::local_test_fixture(&server.url("/archive")).expect("fixture policy");

    let error = tauri::async_runtime::block_on(install_checked_update(
        update,
        &installed,
        &mut health,
        &policy,
    ))
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
fn interrupted_download_never_stages_or_publishes_a_candidate() {
    let fixture = update_fixture_guard();
    let server = TestServer::new(&fixture, 2, |base_url| {
        HashMap::from([
            ("/manifest", manifest(base_url, "0.2.0", TEST_SIGNATURE)),
            (
                "/archive",
                Response {
                    status: "200 OK",
                    content_type: "application/octet-stream",
                    body: b"partial".to_vec(),
                    declared_length: Some(1024),
                },
            ),
        ])
    });
    let (_app, update) = checked_update(&server, SIGNED_TEST_PUBLIC_KEY);
    let root = tempdir().expect("update root");
    let installed = installed_app(root.path());
    let mut health =
        HealthProbe(|_: &Path, _: Duration| panic!("health must not run after interruption"));
    let policy =
        DownloadUrlPolicy::local_test_fixture(&server.url("/archive")).expect("fixture policy");

    let error = tauri::async_runtime::block_on(install_checked_update(
        update,
        &installed,
        &mut health,
        &policy,
    ))
    .expect_err("truncated response must fail");

    assert!(matches!(
        error,
        openloop_desktop_lib::update::coordinator::CoordinatorError::Download(_)
    ));
    assert_eq!(
        fs::read_dir(root.path()).expect("update root").count(),
        1,
        "interrupted download left a staged candidate"
    );
}

#[test]
fn verified_download_commits_healthy_candidate_and_rolls_back_failed_health() {
    let fixture = update_fixture_guard();
    for expected_publication in [
        InstallPublication::Committed,
        InstallPublication::RolledBack(HealthStatus::Failed("injected failure".into())),
    ] {
        let server = TestServer::new(&fixture, 2, |base_url| {
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
        let policy =
            DownloadUrlPolicy::local_test_fixture(&server.url("/archive")).expect("fixture policy");

        let report = tauri::async_runtime::block_on(install_checked_update(
            update,
            &installed,
            &mut health,
            &policy,
        ))
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
        match report.publication {
            InstallPublication::Committed => {
                let backup = report.preserved_backup.as_ref().expect("committed backup");
                assert_eq!(
                    fs::read_to_string(backup.join("marker")).expect("backup marker"),
                    "old"
                );
                assert!(backup
                    .file_name()
                    .expect("backup name")
                    .to_string_lossy()
                    .starts_with(".openloop-candidate-"));
                assert!(report.failed_candidate.is_none());
            }
            InstallPublication::RolledBack(_) => {
                let failed = report.failed_candidate.as_ref().expect("failed candidate");
                assert_eq!(
                    fs::read_to_string(failed.join("marker")).expect("failed candidate marker"),
                    "new"
                );
                assert!(failed
                    .file_name()
                    .expect("failed candidate name")
                    .to_string_lossy()
                    .starts_with(".openloop-candidate-"));
                assert!(report.preserved_backup.is_none());
            }
            InstallPublication::NoUpdate => unreachable!("fixture always provides an update"),
        }
        assert_eq!(
            fs::read_dir(root.path()).expect("update root").count(),
            2,
            "one update must leave only installed and one preserved candidate"
        );
    }
}

#[derive(Default)]
struct RecordingInstallObserver {
    events: Mutex<Vec<&'static str>>,
}

impl UpdateInstallObserver for RecordingInstallObserver {
    fn download_progress(
        &self,
        downloaded: u64,
        total: Option<u64>,
    ) -> Result<(), UpdateStateError> {
        assert!(downloaded > 0);
        assert!(total.is_some_and(|total| downloaded <= total));
        self.events
            .lock()
            .expect("observer events")
            .push("downloading");
        Ok(())
    }

    fn verifying(&self) -> Result<(), UpdateStateError> {
        self.events
            .lock()
            .expect("observer events")
            .push("verifying");
        Ok(())
    }

    fn ready_to_install(&self) -> Result<(), UpdateStateError> {
        self.events
            .lock()
            .expect("observer events")
            .push("ready-to-install");
        Ok(())
    }

    fn installing(&self) -> Result<(), UpdateStateError> {
        self.events
            .lock()
            .expect("observer events")
            .push("installing");
        Ok(())
    }
}

#[test]
fn coordinator_reports_download_verification_and_install_phases() {
    let fixture = update_fixture_guard();
    let server = TestServer::new(&fixture, 2, |base_url| {
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
    let mut health = HealthProbe(|_: &Path, _: Duration| HealthStatus::Healthy);
    let policy =
        DownloadUrlPolicy::local_test_fixture(&server.url("/archive")).expect("fixture policy");
    let observer = RecordingInstallObserver::default();

    let report = tauri::async_runtime::block_on(install_checked_update_with_observer(
        update,
        &installed,
        &mut health,
        &policy,
        &observer,
    ))
    .expect("observed install");

    assert_eq!(report.publication, InstallPublication::Committed);
    let events = observer.events.lock().expect("observer events");
    assert_eq!(events.first(), Some(&"downloading"));
    assert_eq!(
        events
            .iter()
            .copied()
            .filter(|event| *event != "downloading")
            .collect::<Vec<_>>(),
        ["verifying", "ready-to-install", "installing"]
    );
}

#[test]
fn a_second_update_is_rejected_while_the_first_preserved_artifact_requires_cleanup() {
    let fixture = update_fixture_guard();
    let root = tempdir().expect("update root");
    let installed = installed_app(root.path());

    let first_server = TestServer::new(&fixture, 2, |base_url| {
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
    let (_first_app, first_update) = checked_update(&first_server, VALID_ARCHIVE_PUBLIC_KEY);
    let first_policy = DownloadUrlPolicy::local_test_fixture(&first_server.url("/archive"))
        .expect("first fixture policy");
    let mut first_health = HealthProbe(|_: &Path, _: Duration| HealthStatus::Healthy);
    let first_report = tauri::async_runtime::block_on(install_checked_update(
        first_update,
        &installed,
        &mut first_health,
        &first_policy,
    ))
    .expect("first update");
    assert_eq!(first_report.publication, InstallPublication::Committed);
    drop(first_server);

    let second_server = TestServer::new(&fixture, 2, |base_url| {
        HashMap::from([
            (
                "/manifest",
                manifest(base_url, "0.3.0", VALID_ARCHIVE_SIGNATURE),
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
    let (_second_app, second_update) = checked_update(&second_server, VALID_ARCHIVE_PUBLIC_KEY);
    let second_policy = DownloadUrlPolicy::local_test_fixture(&second_server.url("/archive"))
        .expect("second fixture policy");
    let mut second_health =
        HealthProbe(|_: &Path, _: Duration| panic!("blocked update must not run health"));

    let error = tauri::async_runtime::block_on(install_checked_update(
        second_update,
        &installed,
        &mut second_health,
        &second_policy,
    ))
    .expect_err("preserved backup must block a second update");

    assert!(
        error.to_string().contains("requires recovery cleanup"),
        "unexpected second-update error: {error}"
    );
    assert_eq!(
        fs::read_dir(root.path()).expect("update root").count(),
        2,
        "blocked update created another preserved artifact"
    );
}
