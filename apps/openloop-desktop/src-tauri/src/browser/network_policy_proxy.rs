use std::{
    collections::HashMap,
    io::{self, BufRead, BufReader, Write},
    net::{IpAddr, Shutdown, SocketAddr, TcpListener, TcpStream, ToSocketAddrs},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use url::Url;

use super::policy::{BrowserPolicy, BrowserPolicyError, ValidatedUrl};

const MAX_HEADER_BYTES: usize = 64 * 1024;
const PROXY_POLL_INTERVAL: Duration = Duration::from_millis(25);

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct OriginKey {
    scheme: String,
    host: String,
    port: u16,
}

#[derive(Debug)]
pub struct NetworkPolicyProxy {
    policy: BrowserPolicy,
    pins: Mutex<HashMap<OriginKey, Vec<IpAddr>>>,
}

impl NetworkPolicyProxy {
    pub fn new(policy: BrowserPolicy) -> Self {
        Self {
            policy,
            pins: Mutex::new(HashMap::new()),
        }
    }

    pub fn authorize(
        &self,
        raw_url: &str,
        resolved_ips: &[IpAddr],
    ) -> Result<ValidatedUrl, BrowserPolicyError> {
        let validated = self.policy.validate(raw_url, resolved_ips)?;
        let key = OriginKey {
            scheme: validated.scheme.clone(),
            host: validated.host.clone(),
            port: validated.port,
        };
        let mut pins = self.pins.lock().expect("network proxy pin mutex");
        if let Some(previous) = pins.get(&key) {
            if previous != &validated.resolved_ips {
                return Err(BrowserPolicyError::DnsRebinding);
            }
        } else {
            pins.insert(key, validated.resolved_ips.clone());
        }
        Ok(validated)
    }

    pub fn navigation_policy(&self) -> BrowserPolicy {
        self.policy
    }

    pub fn start(policy: BrowserPolicy) -> io::Result<RunningNetworkPolicyProxy> {
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        listener.set_nonblocking(true)?;
        let address = listener.local_addr()?;
        let proxy = Arc::new(Self::new(policy));
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let thread_proxy = Arc::clone(&proxy);
        let thread = thread::spawn(move || {
            while !thread_stop.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let proxy = Arc::clone(&thread_proxy);
                        thread::spawn(move || serve_connection(proxy, stream));
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        thread::sleep(PROXY_POLL_INTERVAL);
                    }
                    Err(_) => break,
                }
            }
        });
        Ok(RunningNetworkPolicyProxy {
            proxy,
            address,
            stop,
            thread: Some(thread),
        })
    }
}

#[derive(Debug)]
pub struct RunningNetworkPolicyProxy {
    proxy: Arc<NetworkPolicyProxy>,
    address: SocketAddr,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl RunningNetworkPolicyProxy {
    pub fn address(&self) -> SocketAddr {
        self.address
    }

    pub fn proxy_url(&self) -> Url {
        Url::parse(&format!("http://{}", self.address)).expect("proxy listener URL")
    }

    pub fn policy(&self) -> &NetworkPolicyProxy {
        &self.proxy
    }

    pub fn navigation_policy(&self) -> BrowserPolicy {
        self.proxy.navigation_policy()
    }
}

impl Drop for RunningNetworkPolicyProxy {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn serve_connection(proxy: Arc<NetworkPolicyProxy>, mut client: TcpStream) {
    let mut reader = BufReader::new(match client.try_clone() {
        Ok(stream) => stream,
        Err(_) => return,
    });
    let mut request_line = String::new();
    if read_bounded_line(&mut reader, &mut request_line).is_err() {
        return;
    }
    let mut headers = Vec::new();
    let mut header_bytes = request_line.len();
    loop {
        let mut line = String::new();
        if read_bounded_line(&mut reader, &mut line).is_err() {
            return;
        }
        header_bytes += line.len();
        if header_bytes > MAX_HEADER_BYTES {
            write_status(&mut client, 431);
            return;
        }
        if line == "\r\n" {
            break;
        }
        headers.push(line);
    }
    let parts: Vec<&str> = request_line.split_whitespace().collect();
    if parts.len() < 3 {
        write_status(&mut client, 400);
        return;
    }
    if parts[0].eq_ignore_ascii_case("CONNECT") {
        serve_connect(proxy, reader, parts[1]);
    } else {
        serve_http(proxy, client, reader, parts[0], parts[1], &headers);
    }
}

fn serve_connect(proxy: Arc<NetworkPolicyProxy>, reader: BufReader<TcpStream>, authority: &str) {
    let target = format!("https://{authority}/");
    let Ok(url) = Url::parse(&target) else {
        let mut client = reader.into_inner();
        write_status(&mut client, 400);
        return;
    };
    let Some(host) = url.host_str() else {
        let mut client = reader.into_inner();
        write_status(&mut client, 400);
        return;
    };
    let port = url.port_or_known_default().unwrap_or(443);
    let Ok(addresses) = resolve(host, port) else {
        let mut client = reader.into_inner();
        write_status(&mut client, 502);
        return;
    };
    let Ok(approved) = proxy.authorize(&target, &addresses) else {
        let mut client = reader.into_inner();
        write_status(&mut client, 403);
        return;
    };
    let Some(address) = approved.resolved_ips.first().copied() else {
        let mut client = reader.into_inner();
        write_status(&mut client, 502);
        return;
    };
    let Ok(mut upstream) = TcpStream::connect(SocketAddr::new(address, approved.port)) else {
        let mut client = reader.into_inner();
        write_status(&mut client, 502);
        return;
    };
    let buffered = reader.buffer().to_vec();
    let mut client = reader.into_inner();
    if client
        .write_all(b"HTTP/1.1 200 Connection Established\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return;
    }
    if upstream.write_all(&buffered).is_err() {
        return;
    }
    let mut upstream_writer = match upstream.try_clone() {
        Ok(stream) => stream,
        Err(_) => return,
    };
    let mut client_reader = match client.try_clone() {
        Ok(stream) => stream,
        Err(_) => return,
    };
    let copy_up = thread::spawn(move || {
        let _ = io::copy(&mut client_reader, &mut upstream_writer);
        let _ = upstream_writer.shutdown(Shutdown::Write);
    });
    let _ = io::copy(&mut upstream, &mut client);
    let _ = client.shutdown(Shutdown::Write);
    let _ = copy_up.join();
}

fn serve_http(
    proxy: Arc<NetworkPolicyProxy>,
    mut client: TcpStream,
    reader: BufReader<TcpStream>,
    method: &str,
    target: &str,
    headers: &[String],
) {
    let host_header = headers.iter().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("host").then_some(value.trim())
    });
    let raw_url = if target.starts_with("http://") || target.starts_with("https://") {
        target.to_owned()
    } else {
        let Some(host) = host_header else {
            write_status(&mut client, 400);
            return;
        };
        format!("http://{host}{target}")
    };
    let Ok(url) = Url::parse(&raw_url) else {
        write_status(&mut client, 400);
        return;
    };
    let Some(host) = url.host_str() else {
        write_status(&mut client, 400);
        return;
    };
    let port = url.port_or_known_default().unwrap_or(80);
    let Ok(addresses) = resolve(host, port) else {
        write_status(&mut client, 502);
        return;
    };
    let Ok(approved) = proxy.authorize(&raw_url, &addresses) else {
        write_status(&mut client, 403);
        return;
    };
    let Some(address) = approved.resolved_ips.first().copied() else {
        write_status(&mut client, 502);
        return;
    };
    let Ok(mut upstream) = TcpStream::connect(SocketAddr::new(address, approved.port)) else {
        write_status(&mut client, 502);
        return;
    };
    let path = match url.query() {
        Some(query) => format!("{}?{query}", url.path()),
        None => url.path().to_owned(),
    };
    if write!(upstream, "{method} {path} HTTP/1.1\r\n").is_err() {
        return;
    }
    for header in headers {
        let name = header
            .split_once(':')
            .map(|(name, _)| name)
            .unwrap_or_default();
        if name.eq_ignore_ascii_case("proxy-connection") || name.eq_ignore_ascii_case("connection")
        {
            continue;
        }
        if upstream.write_all(header.as_bytes()).is_err() {
            return;
        }
    }
    if upstream.write_all(b"Connection: close\r\n\r\n").is_err() {
        return;
    }
    let buffered = reader.buffer().to_vec();
    if upstream.write_all(&buffered).is_err() {
        return;
    }
    let mut client = reader.into_inner();
    let _ = io::copy(&mut client, &mut upstream);
    let _ = upstream.shutdown(Shutdown::Write);
    let _ = io::copy(&mut upstream, &mut client);
}

fn read_bounded_line(reader: &mut BufReader<TcpStream>, line: &mut String) -> io::Result<()> {
    line.clear();
    reader.read_line(line)?;
    if line.len() > MAX_HEADER_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "proxy header is oversized",
        ));
    }
    Ok(())
}

fn resolve(host: &str, port: u16) -> io::Result<Vec<IpAddr>> {
    (host, port)
        .to_socket_addrs()
        .map(|addresses| addresses.map(|address| address.ip()).collect())
}

fn write_status(stream: &mut TcpStream, status: u16) {
    let reason = match status {
        400 => "Bad Request",
        403 => "Forbidden",
        431 => "Request Header Fields Too Large",
        502 => "Bad Gateway",
        _ => "Proxy Error",
    };
    let _ = write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
    );
}
