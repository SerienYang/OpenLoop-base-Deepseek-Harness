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
        // SAFETY: `path` is a live, NUL-terminated C string and the call does
        // not retain its pointer.
        let descriptor = unsafe {
            libc::open(
                path.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if descriptor < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: `descriptor` is a newly opened, owned file descriptor.
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
            libc::O_RDONLY | libc::O_NONBLOCK | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            0,
        )?;
        ensure_singly_linked_regular(&file)?;
        let mut contents = Vec::new();
        file.read_to_end(&mut contents)?;
        Ok(contents)
    }

    pub fn write(&self, relative_path: &str, contents: &[u8]) -> io::Result<()> {
        let components = validated_components(relative_path)?;
        let (parent, name) = self.open_parent(&components)?;
        validate_existing_target(parent.as_raw_fd(), name)?;

        let (mut temporary, temporary_name) = create_temporary(parent.as_raw_fd())?;
        let result = (|| {
            temporary.write_all(contents)?;
            rename_at(
                parent.as_raw_fd(),
                &temporary_name,
                parent.as_raw_fd(),
                name,
            )
        })();
        if result.is_err() {
            let _ = unlink_at(parent.as_raw_fd(), &temporary_name);
        }
        result
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

fn validate_existing_target(parent: RawFd, name: &CStr) -> io::Result<()> {
    match open_at(
        parent,
        name,
        libc::O_RDONLY | libc::O_NONBLOCK | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        0,
    ) {
        Ok(file) => ensure_singly_linked_regular(&file),
        Err(error) if error.raw_os_error() == Some(libc::ENOENT) => Ok(()),
        Err(error) => Err(error),
    }
}

fn ensure_singly_linked_regular(file: &File) -> io::Result<()> {
    let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: `metadata` points to writable storage for one `stat`, and
    // `file` keeps the descriptor valid for the duration of the call.
    let result = unsafe { libc::fstat(file.as_raw_fd(), metadata.as_mut_ptr()) };
    if result < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: a successful `fstat` initialized the complete `stat` value.
    let metadata = unsafe { metadata.assume_init() };
    if metadata.st_mode & libc::S_IFMT != libc::S_IFREG || metadata.st_nlink != 1 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "workspace target must be a singly linked regular file",
        ));
    }
    Ok(())
}

fn create_temporary(parent: RawFd) -> io::Result<(File, CString)> {
    for _ in 0..16 {
        let mut random = [0_u8; 16];
        getrandom::fill(&mut random).map_err(|error| io::Error::other(error.to_string()))?;
        let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let name = CString::new(format!(".openloop-write-{suffix}.tmp"))
            .expect("generated temporary names contain no NUL bytes");
        match open_at(
            parent,
            &name,
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            0o600,
        ) {
            Ok(file) => return Ok((file, name)),
            Err(error) if error.raw_os_error() == Some(libc::EEXIST) => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not create a unique Workspace temporary file",
    ))
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
    // SAFETY: `name` is a live, NUL-terminated C string; `parent` remains
    // borrowed; and the call does not retain either value.
    let descriptor =
        unsafe { libc::openat(parent, name.as_ptr(), flags, libc::c_uint::from(mode)) };
    if descriptor < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `descriptor` is a newly opened, owned file descriptor.
    Ok(unsafe { File::from_raw_fd(descriptor) })
}

fn rename_at(
    old_parent: RawFd,
    old_name: &CStr,
    new_parent: RawFd,
    new_name: &CStr,
) -> io::Result<()> {
    // SAFETY: both names are live, NUL-terminated C strings; both parent
    // descriptors remain valid; and `renameat` retains none of the arguments.
    let result =
        unsafe { libc::renameat(old_parent, old_name.as_ptr(), new_parent, new_name.as_ptr()) };
    if result < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn unlink_at(parent: RawFd, name: &CStr) -> io::Result<()> {
    // SAFETY: `name` is a live, NUL-terminated C string; `parent` remains
    // valid; and `unlinkat` retains neither argument.
    let result = unsafe { libc::unlinkat(parent, name.as_ptr(), 0) };
    if result < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn invalid_path() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        "workspace path must be a plain relative path without empty, dot, or encoded segments",
    )
}
