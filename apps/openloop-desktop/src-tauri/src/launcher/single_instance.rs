use std::{
    fs,
    io::{self, Read, Write},
    os::unix::net::{UnixListener, UnixStream},
    path::{Path, PathBuf},
    thread,
};

const OPEN_REQUEST: &[u8] = b"{\"type\":\"openloop.open\"}\n";
const MAX_OPEN_REQUEST_BYTES: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstanceAction {
    Primary,
    Forwarded,
}

pub struct SingleInstance {
    socket_path: PathBuf,
    listener: Option<UnixListener>,
    action: InstanceAction,
}

impl SingleInstance {
    pub fn acquire(socket_path: &Path) -> io::Result<Self> {
        if let Some(parent) = socket_path.parent() {
            fs::create_dir_all(parent)?;
        }
        match UnixListener::bind(socket_path) {
            Ok(listener) => Ok(Self {
                socket_path: socket_path.to_path_buf(),
                listener: Some(listener),
                action: InstanceAction::Primary,
            }),
            Err(bind_error) => {
                match UnixStream::connect(socket_path) {
                    Ok(mut stream) => {
                        stream.write_all(OPEN_REQUEST)?;
                        stream.shutdown(std::net::Shutdown::Write)?;
                        Ok(Self {
                            socket_path: socket_path.to_path_buf(),
                            listener: None,
                            action: InstanceAction::Forwarded,
                        })
                    }
                    Err(_) => {
                        // A dead owner leaves only a socket pathname. It is
                        // safe to remove that pathname because connect failed;
                        // a live owner is never removed based on PID alone.
                        fs::remove_file(socket_path).or_else(|error| {
                            if error.kind() == io::ErrorKind::NotFound {
                                Ok(())
                            } else {
                                Err(error)
                            }
                        })?;
                        UnixListener::bind(socket_path)
                            .map(|listener| Self {
                                socket_path: socket_path.to_path_buf(),
                                listener: Some(listener),
                                action: InstanceAction::Primary,
                            })
                            .map_err(|error| io::Error::new(
                                error.kind(),
                                format!("single-instance bind failed after stale socket cleanup: {error}; initial error: {bind_error}"),
                            ))
                    }
                }
            }
        }
    }

    pub fn action(&self) -> InstanceAction {
        self.action
    }

    pub fn accept_open_request(&self) -> io::Result<Vec<u8>> {
        let listener = self.listener.as_ref().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotConnected,
                "forwarded instance has no listener",
            )
        })?;
        let (stream, _) = listener.accept()?;
        let mut request = Vec::new();
        stream
            .take((MAX_OPEN_REQUEST_BYTES + 1) as u64)
            .read_to_end(&mut request)?;
        if request.len() > MAX_OPEN_REQUEST_BYTES || !request.ends_with(b"\n") {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "open request is oversized or not one line",
            ));
        }
        Ok(request)
    }

    pub fn spawn_open_request_forwarder<F>(&self, forward: F) -> io::Result<()>
    where
        F: Fn() + Send + 'static,
    {
        let listener = self
            .listener
            .as_ref()
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::NotConnected,
                    "forwarded instance has no listener",
                )
            })?
            .try_clone()?;
        thread::spawn(move || {
            while let Ok((mut stream, _)) = listener.accept() {
                let mut request = Vec::new();
                if stream.read_to_end(&mut request).is_ok()
                    && request.len() <= MAX_OPEN_REQUEST_BYTES
                    && request == OPEN_REQUEST
                {
                    forward();
                }
            }
        });
        Ok(())
    }
}

impl Drop for SingleInstance {
    fn drop(&mut self) {
        if self.listener.is_some() {
            let _ = fs::remove_file(&self.socket_path);
        }
    }
}
