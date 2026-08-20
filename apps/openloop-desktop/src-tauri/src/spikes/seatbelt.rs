use std::{
    ffi::OsStr,
    fs, io,
    os::unix::ffi::OsStrExt,
    path::{Path, PathBuf},
    process::{Command, Output},
};

#[derive(Debug, Clone)]
pub struct SeatbeltProfile {
    source: String,
    working_directory: PathBuf,
}

impl SeatbeltProfile {
    pub fn new(workspace: &Path, task_temp: &Path) -> io::Result<Self> {
        if !workspace.is_absolute() || !task_temp.is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Seatbelt paths must be absolute",
            ));
        }
        // Seatbelt matches kernel-resolved paths. This normalization only
        // renders the profile; Workspace I/O remains descriptor-relative.
        let working_directory = fs::canonicalize(workspace)?;
        let workspace = seatbelt_string(&working_directory)?;
        let task_temp = seatbelt_string(&fs::canonicalize(task_temp)?)?;
        let source = format!(
            r#"(version 1)
(deny default)
(allow process-exec
    (literal "/bin/sh" "/bin/bash"))
(allow sysctl-read
    (sysctl-name "security.mac.lockdown_mode_state" "kern.bootargs"))
(allow file-read-metadata
    (literal "/var" "/bin/bash" "/private/var/select/sh")
    (subpath "{workspace}")
    (subpath "{task_temp}"))
(allow file-read-data
    (literal "/" "/bin/sh" "/bin/bash")
    (subpath "{workspace}")
    (subpath "{task_temp}"))
(allow file-write*
    (subpath "{workspace}")
    (subpath "{task_temp}"))
"#
        );
        Ok(Self {
            source,
            working_directory,
        })
    }

    pub fn as_str(&self) -> &str {
        &self.source
    }

    pub fn run<I, S>(&self, program: &Path, args: I) -> io::Result<Output>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        Command::new("/usr/bin/sandbox-exec")
            .arg("-p")
            .arg(&self.source)
            .arg(program)
            .args(args)
            .current_dir(&self.working_directory)
            .output()
    }
}

fn seatbelt_string(path: &Path) -> io::Result<String> {
    let bytes = path.as_os_str().as_bytes();
    let value = std::str::from_utf8(bytes).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "Seatbelt spike paths must be valid UTF-8",
        )
    })?;
    if value.bytes().any(|byte| byte.is_ascii_control()) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Seatbelt spike paths cannot contain control characters",
        ));
    }
    Ok(value.replace('\\', "\\\\").replace('"', "\\\""))
}
