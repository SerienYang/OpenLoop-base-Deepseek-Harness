use std::{
    ffi::OsStr,
    fs::{self, File},
    io::{self, BufRead, BufReader},
    os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

use sha2::{Digest, Sha256};

use super::{
    parse_readiness_line, write_launch_secrets_frame, LaunchReadinessExpectation, LaunchSecrets,
    RuntimeReadiness,
};

const CHILD_SECRET_FD: RawFd = 3;
const FD_CLOEXEC: libc::c_int = 1;
const DROP_REAP_TIMEOUT: Duration = Duration::from_millis(100);
const REAP_POLL_INTERVAL: Duration = Duration::from_millis(5);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessIdentity {
    pub pid: u32,
    pub start_time: u64,
    pub executable_sha256: String,
}

pub fn process_identity_matches(expected: &ProcessIdentity, actual: &ProcessIdentity) -> bool {
    expected == actual
}

fn executable_sha256(path: &Path) -> io::Result<String> {
    let bytes = fs::read(path)?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

#[cfg(target_os = "macos")]
fn process_start_time(pid: u32) -> io::Result<u64> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>();
    let result = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            size as libc::c_int,
        )
    };
    if result != size as libc::c_int {
        return Err(io::Error::last_os_error());
    }
    Ok(info.pbi_start_tvsec.saturating_mul(1_000_000) + info.pbi_start_tvusec)
}

#[cfg(target_os = "linux")]
fn process_start_time(pid: u32) -> io::Result<u64> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat"))?;
    let after_name = stat.rfind(") ").ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "process stat has no command field",
        )
    })?;
    stat[after_name + 2..]
        .split_whitespace()
        .nth(19)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "process stat has no start time"))
        .and_then(|value| {
            value
                .parse()
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
        })
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn process_start_time(_pid: u32) -> io::Result<u64> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "process start-time identity is unsupported on this platform",
    ))
}

pub fn capture_process_identity(pid: u32, executable: &Path) -> io::Result<ProcessIdentity> {
    Ok(ProcessIdentity {
        pid,
        start_time: process_start_time(pid)?,
        executable_sha256: executable_sha256(executable)?,
    })
}

fn set_close_on_exec(fd: RawFd, enabled: bool) -> io::Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }
    let next = if enabled {
        flags | FD_CLOEXEC
    } else {
        flags & !FD_CLOEXEC
    };
    if unsafe { libc::fcntl(fd, libc::F_SETFD, next) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn anonymous_pipe() -> io::Result<(OwnedFd, OwnedFd)> {
    let mut descriptors = [-1; 2];
    if unsafe { libc::pipe(descriptors.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let read = unsafe { OwnedFd::from_raw_fd(descriptors[0]) };
    let write = unsafe { OwnedFd::from_raw_fd(descriptors[1]) };
    set_close_on_exec(read.as_raw_fd(), true)?;
    set_close_on_exec(write.as_raw_fd(), true)?;
    Ok((read, write))
}

#[derive(Debug)]
pub enum StartupError {
    Io(io::Error),
    Timeout,
    Protocol(io::Error),
    StaleChild,
}

impl std::fmt::Display for StartupError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "runtime startup I/O failed: {error}"),
            Self::Timeout => formatter.write_str("runtime startup exceeded its bounded timeout"),
            Self::Protocol(error) => {
                write!(formatter, "runtime readiness protocol failed: {error}")
            }
            Self::StaleChild => {
                formatter.write_str("runtime child identity changed; refusing PID-only termination")
            }
        }
    }
}

impl std::error::Error for StartupError {}

pub struct SupervisedChild {
    child: Child,
    identity: ProcessIdentity,
    executable: PathBuf,
}

impl SupervisedChild {
    pub fn spawn(executable: &Path, secrets: &LaunchSecrets) -> Result<Self, StartupError> {
        Self::spawn_with_args(executable, std::iter::empty::<&OsStr>(), secrets)
    }

    pub fn spawn_with_args<I, S>(
        executable: &Path,
        args: I,
        secrets: &LaunchSecrets,
    ) -> Result<Self, StartupError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        Self::spawn_command(executable, args, secrets, None)
    }

    pub fn spawn_with_dsh_home(
        executable: &Path,
        secrets: &LaunchSecrets,
        dsh_home: &Path,
    ) -> Result<Self, StartupError> {
        Self::spawn_with_args_and_dsh_home(
            executable,
            std::iter::empty::<&OsStr>(),
            secrets,
            dsh_home,
        )
    }

    pub fn spawn_with_args_and_dsh_home<I, S>(
        executable: &Path,
        args: I,
        secrets: &LaunchSecrets,
        dsh_home: &Path,
    ) -> Result<Self, StartupError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        Self::spawn_command(executable, args, secrets, Some(dsh_home))
    }

    fn spawn_command<I, S>(
        executable: &Path,
        args: I,
        secrets: &LaunchSecrets,
        dsh_home: Option<&Path>,
    ) -> Result<Self, StartupError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let (read_fd, write_fd) = anonymous_pipe().map_err(StartupError::Io)?;
        let inherited_fd = read_fd.as_raw_fd();
        let mut command = Command::new(executable);
        command
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped());
        #[cfg(feature = "openloop-e2e")]
        command.stderr(Stdio::inherit());
        #[cfg(not(feature = "openloop-e2e"))]
        command.stderr(Stdio::piped());
        if let Some(dsh_home) = dsh_home {
            command.env("DSH_HOME", dsh_home);
        }
        unsafe {
            command.pre_exec(move || {
                if libc::dup2(inherited_fd, CHILD_SECRET_FD) < 0 {
                    return Err(io::Error::last_os_error());
                }
                set_close_on_exec(CHILD_SECRET_FD, false)?;
                if inherited_fd != CHILD_SECRET_FD {
                    libc::close(inherited_fd);
                }
                Ok(())
            });
        }
        let mut child = command.spawn().map_err(StartupError::Io)?;
        drop(read_fd);
        let mut writer = File::from(write_fd);
        if let Err(error) = write_launch_secrets_frame(&mut writer, secrets) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(StartupError::Io(error));
        }
        drop(writer);
        let identity = match capture_process_identity(child.id(), executable) {
            Ok(identity) => identity,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(StartupError::Io(error));
            }
        };
        Ok(Self {
            child,
            identity,
            executable: executable.to_path_buf(),
        })
    }

    pub fn identity(&self) -> &ProcessIdentity {
        &self.identity
    }

    pub fn try_wait(&mut self) -> io::Result<Option<std::process::ExitStatus>> {
        self.child.try_wait()
    }

    pub fn wait_readiness(
        &mut self,
        expected: &LaunchReadinessExpectation,
        timeout: Duration,
    ) -> Result<RuntimeReadiness, StartupError> {
        let stdout = self.child.stdout.take().ok_or_else(|| {
            StartupError::Io(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "runtime stdout is unavailable",
            ))
        })?;
        let expected = expected.clone();
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let result = read_bounded_line(&mut reader)
                .map_err(StartupError::Io)
                .and_then(|line| {
                    parse_readiness_line(&line, &expected).map_err(StartupError::Protocol)
                });
            let _ = sender.send(result);
        });
        match receiver.recv_timeout(timeout) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.terminate_if_verified().map_err(|error| match error {
                    StartupError::StaleChild => StartupError::StaleChild,
                    other => other,
                })?;
                Err(StartupError::Timeout)
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Err(StartupError::Protocol(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "readiness reader disconnected",
                )))
            }
        }
    }

    pub fn terminate_if_verified(&mut self) -> Result<(), StartupError> {
        let current = capture_process_identity(self.identity.pid, &self.executable)
            .map_err(StartupError::Io)?;
        if !process_identity_matches(&self.identity, &current) {
            return Err(StartupError::StaleChild);
        }
        self.child.kill().map_err(StartupError::Io)
    }
}

fn read_bounded_line<R: BufRead>(reader: &mut R) -> io::Result<Vec<u8>> {
    let mut line = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            if line.is_empty() {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "runtime exited before readiness",
                ));
            }
            return Ok(line);
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let take = newline.map_or(available.len(), |index| index + 1);
        if line.len() + take > super::MAX_READINESS_LINE_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "readiness line is oversized",
            ));
        }
        line.extend_from_slice(&available[..take]);
        reader.consume(take);
        if newline.is_some() {
            return Ok(line);
        }
    }
}

fn reap_child_bounded(child: &mut Child, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => return,
            Ok(None) if Instant::now() >= deadline => return,
            Ok(None) => thread::sleep(REAP_POLL_INTERVAL),
        }
    }
}

impl Drop for SupervisedChild {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.terminate_if_verified();
            reap_child_bounded(&mut self.child, DROP_REAP_TIMEOUT);
        }
    }
}
