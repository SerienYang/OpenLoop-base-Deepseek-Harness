use std::{
    collections::HashMap,
    fs,
    io::{self, Write},
    os::{
        fd::AsRawFd,
        unix::{
            fs::{FileTypeExt, MetadataExt, PermissionsExt},
            net::{UnixListener, UnixStream},
        },
    },
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Condvar, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use serde_json::Value;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::launcher::{capture_process_identity, process_identity_matches, ProcessIdentity};

use super::protocol::{
    decode_nonce, read_json_frame, sign_response, write_frame, AuthenticatedBridgeRequest,
    AuthenticatedBridgeResponse, BridgeResponse, NonceReplayGuard,
};

const MAX_BRIDGE_CONNECTIONS: usize = 16;

pub const BROWSER_SAFE_METHODS: [&str; 13] = [
    "getAppInfo",
    "getUpdateStatus",
    "checkForUpdate",
    "installUpdateAndRestart",
    "describeCredential",
    "openCredentialReplacement",
    "unsetCredential",
    "getCredentialMigrationStatus",
    "listWorkspaceGrants",
    "authorizeWorkspace",
    "reauthorizeWorkspace",
    "revokeWorkspace",
    "revealWorkspace",
];

pub const HOST_ONLY_METHODS: [&str; 6] = [
    "resolveCredential",
    "beginWorkspaceAuthorization",
    "commitWorkspaceAuthorization",
    "abortWorkspaceAuthorization",
    "openWorkspaceFile",
    "spawnWorkspaceProcess",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PeerIdentity {
    pub uid: libc::uid_t,
    pub pid: u32,
}

#[derive(Clone)]
pub struct CancellationToken {
    state: Arc<(Mutex<bool>, Condvar)>,
}

impl CancellationToken {
    fn new() -> Self {
        Self {
            state: Arc::new((Mutex::new(false), Condvar::new())),
        }
    }

    pub fn cancel(&self) {
        let (cancelled, wake) = &*self.state;
        if let Ok(mut cancelled) = cancelled.lock() {
            *cancelled = true;
            wake.notify_all();
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.state
            .0
            .lock()
            .map(|cancelled| *cancelled)
            .unwrap_or(true)
    }

    pub fn wait(&self) {
        let (cancelled, wake) = &*self.state;
        if let Ok(mut cancelled) = cancelled.lock() {
            while !*cancelled {
                match wake.wait(cancelled) {
                    Ok(next) => cancelled = next,
                    Err(_) => return,
                }
            }
        }
    }
}

#[derive(Debug)]
pub struct BridgeHandlerError {
    code: &'static str,
    message: &'static str,
}

impl BridgeHandlerError {
    pub fn unavailable() -> Self {
        Self {
            code: "not_implemented",
            message: "desktop capability is not implemented in this release",
        }
    }
}

pub type BridgeHandler = Arc<
    dyn Fn(Value, CancellationToken) -> Result<Value, BridgeHandlerError> + Send + Sync + 'static,
>;

pub struct BridgeDispatchTables {
    browser_safe: HashMap<String, BridgeHandler>,
    host_only: HashMap<String, BridgeHandler>,
}

impl BridgeDispatchTables {
    pub fn new(
        browser_safe: HashMap<String, BridgeHandler>,
        host_only: HashMap<String, BridgeHandler>,
    ) -> io::Result<Self> {
        if browser_safe
            .keys()
            .any(|method| !BROWSER_SAFE_METHODS.contains(&method.as_str()))
            || host_only
                .keys()
                .any(|method| !HOST_ONLY_METHODS.contains(&method.as_str()))
            || browser_safe
                .keys()
                .any(|method| host_only.contains_key(method))
        {
            return Err(invalid("bridge dispatch table contains an invalid method"));
        }
        Ok(Self {
            browser_safe,
            host_only,
        })
    }

    pub fn unavailable() -> Self {
        let unavailable: BridgeHandler =
            Arc::new(|_payload, _cancellation| Err(BridgeHandlerError::unavailable()));
        let browser_safe = BROWSER_SAFE_METHODS
            .into_iter()
            .map(|method| (method.to_owned(), unavailable.clone()))
            .collect();
        let host_only = HOST_ONLY_METHODS
            .into_iter()
            .map(|method| (method.to_owned(), unavailable.clone()))
            .collect();
        Self {
            browser_safe,
            host_only,
        }
    }

    fn handler(&self, method: &str) -> Option<BridgeHandler> {
        self.browser_safe
            .get(method)
            .or_else(|| self.host_only.get(method))
            .cloned()
    }
}

struct DispatcherInner {
    expected_uid: libc::uid_t,
    expected_process: ProcessIdentity,
    expected_executable: PathBuf,
    launch_id: Uuid,
    secret: Zeroizing<Vec<u8>>,
    nonces: NonceReplayGuard,
    tables: BridgeDispatchTables,
    requests: Mutex<RequestRegistry>,
}

#[derive(Default)]
struct RequestRegistry {
    active: HashMap<String, CancellationToken>,
    pre_cancelled: HashMap<String, Instant>,
}

struct ActiveRequestGuard<'a> {
    inner: &'a DispatcherInner,
    request_id: String,
}

impl Drop for ActiveRequestGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut requests) = self.inner.requests.lock() {
            requests.active.remove(&self.request_id);
        }
    }
}

#[derive(Clone)]
pub struct AuthenticatedBridgeDispatcher {
    inner: Arc<DispatcherInner>,
}

impl AuthenticatedBridgeDispatcher {
    pub fn new(
        expected_uid: libc::uid_t,
        expected_process: ProcessIdentity,
        expected_executable: PathBuf,
        launch_id: Uuid,
        secret: Vec<u8>,
        tables: BridgeDispatchTables,
    ) -> io::Result<Self> {
        if secret.len() < 32 {
            return Err(invalid("bridge secret must contain at least 32 bytes"));
        }
        Ok(Self {
            inner: Arc::new(DispatcherInner {
                expected_uid,
                expected_process,
                expected_executable,
                launch_id,
                secret: Zeroizing::new(secret),
                nonces: NonceReplayGuard::default(),
                tables,
                requests: Mutex::new(RequestRegistry::default()),
            }),
        })
    }

    pub fn dispatch(
        &self,
        peer: PeerIdentity,
        envelope: AuthenticatedBridgeRequest,
    ) -> io::Result<BridgeResponse> {
        self.authorize_peer(peer)?;
        let request = super::protocol::verify_request(
            &envelope,
            &self.inner.launch_id,
            &self.inner.secret,
            &self.inner.nonces,
        )?;
        if request.method == "$cancel" {
            return self.cancel(request.request_id.clone(), &request.payload);
        }
        let Some(handler) = self.inner.tables.handler(&request.method) else {
            return Ok(BridgeResponse::failure(
                &request.request_id,
                "method_not_found",
                "desktop bridge method is unavailable",
            ));
        };
        let cancellation = CancellationToken::new();
        {
            let mut requests = self
                .inner
                .requests
                .lock()
                .map_err(|_| invalid("bridge active-request lock is poisoned"))?;
            if requests.active.contains_key(&request.request_id) {
                return Ok(BridgeResponse::failure(
                    &request.request_id,
                    "duplicate_request",
                    "desktop bridge request id is already active",
                ));
            }
            requests
                .pre_cancelled
                .retain(|_, created| created.elapsed() <= Duration::from_secs(10));
            if requests.pre_cancelled.remove(&request.request_id).is_some() {
                cancellation.cancel();
            }
            requests
                .active
                .insert(request.request_id.clone(), cancellation.clone());
        }
        let _active = ActiveRequestGuard {
            inner: &self.inner,
            request_id: request.request_id.clone(),
        };
        let result = handler(request.payload.clone(), cancellation);
        Ok(match result {
            Ok(value) => BridgeResponse::success(&request.request_id, value),
            Err(error) => BridgeResponse::failure(&request.request_id, error.code, error.message),
        })
    }

    fn authorize_peer(&self, peer: PeerIdentity) -> io::Result<()> {
        authorize_peer(
            peer,
            self.inner.expected_uid,
            &self.inner.expected_process,
            &self.inner.expected_executable,
        )
    }

    fn dispatch_signed(
        &self,
        peer: PeerIdentity,
        envelope: AuthenticatedBridgeRequest,
    ) -> io::Result<AuthenticatedBridgeResponse> {
        let nonce = decode_nonce(&envelope.nonce)?;
        let response = self.dispatch(peer, envelope)?;
        sign_response(response, nonce, &self.inner.secret)
    }

    fn cancel(&self, request_id: String, payload: &Value) -> io::Result<BridgeResponse> {
        let target = payload
            .as_object()
            .filter(|record| record.len() == 1)
            .and_then(|record| record.get("requestId"))
            .and_then(Value::as_str);
        let Some(target) = target else {
            return Ok(BridgeResponse::failure(
                request_id,
                "invalid_request",
                "desktop bridge cancellation payload is invalid",
            ));
        };
        let cancellation = {
            let mut requests = self
                .inner
                .requests
                .lock()
                .map_err(|_| invalid("bridge active-request lock is poisoned"))?;
            let cancellation = requests.active.get(target).cloned();
            if cancellation.is_none() {
                requests
                    .pre_cancelled
                    .retain(|_, created| created.elapsed() <= Duration::from_secs(10));
                if requests.pre_cancelled.len() >= 4096 {
                    return Ok(BridgeResponse::failure(
                        request_id,
                        "cancellation_capacity",
                        "desktop bridge cancellation capacity is exhausted",
                    ));
                }
                requests
                    .pre_cancelled
                    .insert(target.to_owned(), Instant::now());
            }
            cancellation
        };
        if let Some(cancellation) = cancellation {
            cancellation.cancel();
        }
        Ok(BridgeResponse::success(request_id, Value::Null))
    }

    fn cancel_all(&self) {
        if let Ok(requests) = self.inner.requests.lock() {
            for cancellation in requests.active.values() {
                cancellation.cancel();
            }
        }
    }
}

pub fn authorize_peer(
    actual: PeerIdentity,
    expected_uid: libc::uid_t,
    expected_process: &ProcessIdentity,
    expected_executable: &Path,
) -> io::Result<()> {
    if actual.uid != expected_uid || actual.pid != expected_process.pid {
        return Err(permission_denied(
            "desktop bridge peer is not the supervised runtime",
        ));
    }
    let actual_process =
        capture_process_identity(actual.pid, expected_executable).map_err(|_| {
            permission_denied("desktop bridge peer process identity cannot be verified")
        })?;
    if !process_identity_matches(expected_process, &actual_process) {
        return Err(permission_denied(
            "desktop bridge peer is not the supervised runtime",
        ));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn peer_identity(stream: &UnixStream) -> io::Result<PeerIdentity> {
    let descriptor = stream.as_raw_fd();
    let mut uid: libc::uid_t = 0;
    let mut gid: libc::gid_t = 0;
    if unsafe { libc::getpeereid(descriptor, &mut uid, &mut gid) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let mut pid: libc::pid_t = 0;
    let mut length = std::mem::size_of::<libc::pid_t>() as libc::socklen_t;
    if unsafe {
        libc::getsockopt(
            descriptor,
            libc::SOL_LOCAL,
            libc::LOCAL_PEERPID,
            (&mut pid as *mut libc::pid_t).cast(),
            &mut length,
        )
    } != 0
        || length as usize != std::mem::size_of::<libc::pid_t>()
        || pid <= 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(PeerIdentity {
        uid,
        pid: pid as u32,
    })
}

#[cfg(target_os = "linux")]
pub fn peer_identity(stream: &UnixStream) -> io::Result<PeerIdentity> {
    let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
    let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    if unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut credentials as *mut libc::ucred).cast(),
            &mut length,
        )
    } != 0
        || length as usize != std::mem::size_of::<libc::ucred>()
        || credentials.pid <= 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(PeerIdentity {
        uid: credentials.uid,
        pid: credentials.pid as u32,
    })
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn peer_identity(_stream: &UnixStream) -> io::Result<PeerIdentity> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "desktop bridge peer credentials are unsupported on this platform",
    ))
}

pub struct BridgeListener {
    listener: UnixListener,
    path: PathBuf,
    device: u64,
    inode: u64,
}

impl BridgeListener {
    pub fn bind(path: &Path) -> io::Result<Self> {
        if !path.is_absolute() {
            return Err(invalid("desktop bridge socket path must be absolute"));
        }
        let parent = path
            .parent()
            .ok_or_else(|| invalid("desktop bridge socket has no parent"))?;
        let parent_metadata = fs::symlink_metadata(parent)?;
        if !parent_metadata.is_dir()
            || parent_metadata.file_type().is_symlink()
            || parent_metadata.uid() != unsafe { libc::geteuid() }
            || parent_metadata.mode() & 0o077 != 0
        {
            return Err(permission_denied(
                "desktop bridge socket parent is not a private owned directory",
            ));
        }
        remove_stale_socket(path)?;
        let listener = UnixListener::bind(path)?;
        if let Err(error) = fs::set_permissions(path, fs::Permissions::from_mode(0o600)) {
            let _ = fs::remove_file(path);
            return Err(error);
        }
        let metadata = fs::symlink_metadata(path)?;
        Ok(Self {
            listener,
            path: path.to_path_buf(),
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }

    pub fn accept_peer(&self) -> io::Result<(UnixStream, PeerIdentity)> {
        let (stream, _) = self.listener.accept()?;
        let peer = peer_identity(&stream)?;
        Ok((stream, peer))
    }

    pub fn serve(self, dispatcher: AuthenticatedBridgeDispatcher) -> io::Result<BridgeServer> {
        self.serve_with_connection_limit(dispatcher, MAX_BRIDGE_CONNECTIONS)
    }

    fn serve_with_connection_limit(
        self,
        dispatcher: AuthenticatedBridgeDispatcher,
        maximum_connections: usize,
    ) -> io::Result<BridgeServer> {
        if maximum_connections == 0 {
            return Err(invalid("desktop bridge connection limit must be positive"));
        }
        self.listener.set_nonblocking(true)?;
        let stop = Arc::new(AtomicBool::new(false));
        let workers: Arc<Mutex<Vec<JoinHandle<()>>>> = Arc::new(Mutex::new(Vec::new()));
        let connections = ConnectionLimiter::new(maximum_connections);
        let server_stop = stop.clone();
        let server_workers = workers.clone();
        let server_dispatcher = dispatcher.clone();
        let server_connections = connections.clone();
        let thread = thread::Builder::new()
            .name("openloop-desktop-bridge".to_owned())
            .spawn(move || {
                while !server_stop.load(Ordering::Acquire) {
                    match self.listener.accept() {
                        Ok((stream, _)) => {
                            let peer = match peer_identity(&stream) {
                                Ok(peer) => peer,
                                Err(_) => continue,
                            };
                            let Some(permit) = server_connections.try_acquire() else {
                                continue;
                            };
                            if server_dispatcher.authorize_peer(peer).is_err() {
                                continue;
                            }
                            let dispatcher = server_dispatcher.clone();
                            if let Ok(mut workers) = server_workers.lock() {
                                workers.retain(|worker| !worker.is_finished());
                                if let Ok(worker) = thread::Builder::new()
                                    .name("openloop-desktop-bridge-worker".to_owned())
                                    .spawn(move || {
                                        let _permit = permit;
                                        let _ = serve_connection(stream, peer, &dispatcher);
                                    })
                                {
                                    workers.push(worker);
                                }
                            }
                        }
                        Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(5));
                        }
                        Err(_) => break,
                    }
                }
            })?;
        Ok(BridgeServer {
            stop,
            dispatcher,
            workers,
            #[cfg(test)]
            connections,
            thread: Some(thread),
        })
    }
}

impl Drop for BridgeListener {
    fn drop(&mut self) {
        if let Ok(metadata) = fs::symlink_metadata(&self.path) {
            if metadata.file_type().is_socket()
                && metadata.dev() == self.device
                && metadata.ino() == self.inode
            {
                let _ = fs::remove_file(&self.path);
            }
        }
    }
}

pub struct BridgeServer {
    stop: Arc<AtomicBool>,
    dispatcher: AuthenticatedBridgeDispatcher,
    workers: Arc<Mutex<Vec<JoinHandle<()>>>>,
    #[cfg(test)]
    connections: ConnectionLimiter,
    thread: Option<JoinHandle<()>>,
}

impl BridgeServer {
    #[cfg(test)]
    fn active_connection_count(&self) -> usize {
        self.connections.active()
    }
}

impl Drop for BridgeServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        self.dispatcher.cancel_all();
        if let Ok(mut workers) = self.workers.lock() {
            // Cancellation is cooperative; detaching prevents a faulty handler
            // from blocking application shutdown indefinitely.
            workers.clear();
        }
    }
}

fn serve_connection(
    mut stream: UnixStream,
    peer: PeerIdentity,
    dispatcher: &AuthenticatedBridgeDispatcher,
) -> io::Result<()> {
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    let envelope: AuthenticatedBridgeRequest = read_json_frame(&mut stream)?;
    let response = dispatcher.dispatch_signed(peer, envelope)?;
    write_frame(&mut stream, &response)?;
    stream.flush()
}

#[derive(Clone)]
struct ConnectionLimiter {
    active: Arc<AtomicUsize>,
    maximum: usize,
}

impl ConnectionLimiter {
    fn new(maximum: usize) -> Self {
        Self {
            active: Arc::new(AtomicUsize::new(0)),
            maximum,
        }
    }

    fn try_acquire(&self) -> Option<ConnectionPermit> {
        self.active
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |active| {
                (active < self.maximum).then_some(active + 1)
            })
            .ok()
            .map(|_| ConnectionPermit {
                active: self.active.clone(),
            })
    }

    #[cfg(test)]
    fn active(&self) -> usize {
        self.active.load(Ordering::Acquire)
    }
}

struct ConnectionPermit {
    active: Arc<AtomicUsize>,
}

impl Drop for ConnectionPermit {
    fn drop(&mut self) {
        self.active.fetch_sub(1, Ordering::AcqRel);
    }
}

fn remove_stale_socket(path: &Path) -> io::Result<()> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if !metadata.file_type().is_socket() || metadata.uid() != unsafe { libc::geteuid() } {
        return Err(permission_denied(
            "desktop bridge path is not an owned Unix socket",
        ));
    }
    match UnixStream::connect(path) {
        Ok(_) => Err(io::Error::new(
            io::ErrorKind::AddrInUse,
            "desktop bridge socket already has a listener",
        )),
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::ConnectionRefused | io::ErrorKind::NotFound
            ) =>
        {
            let current = fs::symlink_metadata(path)?;
            if !current.file_type().is_socket()
                || current.uid() != metadata.uid()
                || current.dev() != metadata.dev()
                || current.ino() != metadata.ino()
            {
                return Err(permission_denied(
                    "desktop bridge stale socket identity changed",
                ));
            }
            fs::remove_file(path)
        }
        Err(error) => Err(error),
    }
}

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

fn permission_denied(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, message.into())
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        io::Read,
        os::unix::fs::PermissionsExt,
        os::unix::net::UnixStream,
        path::Path,
        thread,
        time::{Duration, Instant},
    };

    use tempfile::TempDir;
    use uuid::Uuid;

    use super::{
        capture_process_identity, AuthenticatedBridgeDispatcher, BridgeDispatchTables,
        BridgeListener, ProcessIdentity,
    };

    fn current_process() -> (ProcessIdentity, std::path::PathBuf) {
        let executable = std::env::current_exe().expect("current test executable");
        let identity = capture_process_identity(std::process::id(), &executable)
            .expect("current process identity");
        (identity, executable)
    }

    fn dispatcher(
        expected_process: ProcessIdentity,
        executable: &Path,
    ) -> AuthenticatedBridgeDispatcher {
        AuthenticatedBridgeDispatcher::new(
            unsafe { libc::geteuid() },
            expected_process,
            executable.to_path_buf(),
            Uuid::new_v4(),
            vec![7; 32],
            BridgeDispatchTables::unavailable(),
        )
        .expect("bridge dispatcher")
    }

    fn socket_path(directory: &TempDir) -> std::path::PathBuf {
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700))
            .expect("private socket directory permissions");
        directory.path().join("bridge.sock")
    }

    fn wait_until(timeout: Duration, predicate: impl Fn() -> bool) {
        let deadline = Instant::now() + timeout;
        while !predicate() {
            assert!(
                Instant::now() < deadline,
                "condition was not met before timeout"
            );
            thread::sleep(Duration::from_millis(5));
        }
    }

    fn assert_closed_promptly(mut stream: UnixStream) {
        stream
            .set_read_timeout(Some(Duration::from_millis(250)))
            .expect("read timeout");
        let mut byte = [0_u8; 1];
        match stream.read(&mut byte) {
            Ok(0) => {}
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::BrokenPipe
                ) => {}
            result => panic!("rejected bridge socket remained open: {result:?}"),
        }
    }

    #[test]
    fn rejects_an_unexpected_peer_before_allocating_a_worker() {
        let directory = tempfile::tempdir().expect("private socket directory");
        let path = socket_path(&directory);
        let listener = BridgeListener::bind(&path).expect("bridge listener");
        let (mut identity, executable) = current_process();
        identity.pid = if identity.pid == 1 {
            2
        } else {
            identity.pid - 1
        };
        let server = listener
            .serve_with_connection_limit(dispatcher(identity, &executable), 1)
            .expect("bridge server");

        let client = UnixStream::connect(&path).expect("bridge client");

        assert_closed_promptly(client);
        assert_eq!(server.active_connection_count(), 0);
    }

    #[test]
    fn caps_idle_connections_and_releases_capacity_on_worker_exit() {
        let directory = tempfile::tempdir().expect("private socket directory");
        let path = socket_path(&directory);
        let listener = BridgeListener::bind(&path).expect("bridge listener");
        let (identity, executable) = current_process();
        let server = listener
            .serve_with_connection_limit(dispatcher(identity, &executable), 2)
            .expect("bridge server");
        let first = UnixStream::connect(&path).expect("first bridge client");
        let second = UnixStream::connect(&path).expect("second bridge client");
        wait_until(Duration::from_secs(1), || {
            server.active_connection_count() == 2
        });

        let excess = UnixStream::connect(&path).expect("excess bridge client");
        assert_closed_promptly(excess);

        drop(first);
        wait_until(Duration::from_secs(1), || {
            server.active_connection_count() == 1
        });
        let replacement = UnixStream::connect(&path).expect("replacement bridge client");
        wait_until(Duration::from_secs(1), || {
            server.active_connection_count() == 2
        });

        drop(second);
        drop(replacement);
        wait_until(Duration::from_secs(1), || {
            server.active_connection_count() == 0
        });
    }

    #[test]
    fn shutdown_finishes_with_an_idle_connection() {
        let directory = tempfile::tempdir().expect("private socket directory");
        let path = socket_path(&directory);
        let listener = BridgeListener::bind(&path).expect("bridge listener");
        let (identity, executable) = current_process();
        let server = listener
            .serve_with_connection_limit(dispatcher(identity, &executable), 1)
            .expect("bridge server");
        let _client = UnixStream::connect(&path).expect("bridge client");
        wait_until(Duration::from_secs(1), || {
            server.active_connection_count() == 1
        });
        let (dropped, completed) = std::sync::mpsc::channel();

        thread::spawn(move || {
            drop(server);
            dropped.send(()).expect("report server shutdown");
        });

        completed
            .recv_timeout(Duration::from_secs(3))
            .expect("bridge shutdown must remain bounded");
    }

    #[test]
    fn shutdown_does_not_wait_for_a_non_cooperative_worker() {
        let (release, blocked) = std::sync::mpsc::channel();
        let worker = thread::spawn(move || {
            blocked.recv().expect("release blocked worker");
        });
        let (identity, executable) = current_process();
        let server = super::BridgeServer {
            stop: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            dispatcher: dispatcher(identity, &executable),
            workers: std::sync::Arc::new(std::sync::Mutex::new(vec![worker])),
            connections: super::ConnectionLimiter::new(1),
            thread: Some(thread::spawn(|| {})),
        };
        let (dropped, completed) = std::sync::mpsc::channel();
        let shutdown = thread::spawn(move || {
            drop(server);
            dropped.send(()).expect("report server shutdown");
        });

        let result = completed.recv_timeout(Duration::from_millis(250));
        release.send(()).expect("release blocked worker");
        shutdown.join().expect("join shutdown probe");

        result.expect("bridge shutdown must not wait for a non-cooperative worker");
    }
}
