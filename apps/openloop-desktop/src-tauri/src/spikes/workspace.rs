use std::{
    ffi::{CStr, CString},
    fs::File,
    io::{self, Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd, RawFd},
        unix::ffi::OsStrExt,
    },
    path::Path,
};

#[derive(Debug)]
pub struct WorkspaceRoot {
    root: File,
}

impl WorkspaceRoot {
    pub fn open(path: &Path) -> io::Result<Self> {
        let path = CString::new(path.as_os_str().as_bytes()).map_err(|_| invalid_path())?;
        let descriptor = unsafe {
            libc::open(
                path.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if descriptor < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self {
            root: unsafe { File::from_raw_fd(descriptor) },
        })
    }

    pub fn read(&self, relative_path: &str) -> io::Result<Vec<u8>> {
        let components = validated_components(relative_path)?;
        let (parent, name) = self.open_parent(&components)?;
        let mut file = open_at(
            parent.as_raw_fd(),
            name,
            libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            0,
        )?;
        let mut contents = Vec::new();
        file.read_to_end(&mut contents)?;
        Ok(contents)
    }

    pub fn write(&self, relative_path: &str, contents: &[u8]) -> io::Result<()> {
        let components = validated_components(relative_path)?;
        let (parent, name) = self.open_parent(&components)?;
        let mut file = open_at(
            parent.as_raw_fd(),
            name,
            libc::O_WRONLY | libc::O_CREAT | libc::O_TRUNC | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            0o600,
        )?;
        file.write_all(contents)
    }

    fn open_parent<'a>(&self, components: &'a [CString]) -> io::Result<(File, &'a CStr)> {
        let (name, parents) = components
            .split_last()
            .expect("validated paths contain a final component");
        let mut current = self.root.try_clone()?;
        for component in parents {
            current = open_at(
                current.as_raw_fd(),
                component,
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
                0,
            )?;
        }
        Ok((current, name))
    }
}

fn validated_components(relative_path: &str) -> io::Result<Vec<CString>> {
    if relative_path.is_empty() || relative_path.starts_with('/') {
        return Err(invalid_path());
    }
    let lowercase = relative_path.to_ascii_lowercase();
    if ["%2e", "%2f", "%5c"]
        .iter()
        .any(|encoded| lowercase.contains(encoded))
    {
        return Err(invalid_path());
    }

    relative_path
        .split('/')
        .map(|component| {
            if component.is_empty() || component == "." || component == ".." {
                return Err(invalid_path());
            }
            CString::new(component).map_err(|_| invalid_path())
        })
        .collect()
}

fn open_at(parent: RawFd, name: &CStr, flags: libc::c_int, mode: libc::mode_t) -> io::Result<File> {
    let descriptor =
        unsafe { libc::openat(parent, name.as_ptr(), flags, libc::c_uint::from(mode)) };
    if descriptor < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { File::from_raw_fd(descriptor) })
}

fn invalid_path() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        "workspace path must be a plain relative path without empty, dot, or encoded segments",
    )
}
