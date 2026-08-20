use std::{
    fs,
    io::{Cursor, Write},
    path::Path,
};

use flate2::{write::GzEncoder, Compression};
use openloop_desktop_lib::update::archive::stage_verified_archive;
use tar::{Builder, EntryType, Header};
use tempfile::tempdir;

fn append(builder: &mut Builder<Vec<u8>>, path: &[u8], kind: u8, body: &[u8]) {
    assert!(
        path.len() < 100,
        "test path must fit the old tar name field"
    );
    let mut header = Header::new_old();
    header.as_mut_bytes()[..path.len()].copy_from_slice(path);
    header.set_entry_type(EntryType::new(kind));
    header.set_mode(if kind == b'5' { 0o755 } else { 0o644 });
    header.set_size(body.len() as u64);
    header.set_uid(501);
    header.set_gid(20);
    header.set_mtime(0);
    header.set_cksum();
    builder
        .append(&header, Cursor::new(body))
        .expect("append test archive entry");
}

fn archive(entries: &[(&[u8], u8, &[u8])]) -> Vec<u8> {
    let mut tar = Builder::new(Vec::new());
    for (path, kind, body) in entries {
        append(&mut tar, path, *kind, body);
    }
    tar.finish().expect("finish test tar");
    let bytes = tar.into_inner().expect("read test tar");
    let mut gzip = GzEncoder::new(Vec::new(), Compression::default());
    gzip.write_all(&bytes).expect("compress test tar");
    gzip.finish().expect("finish test gzip")
}

fn installed_app(root: &Path) -> std::path::PathBuf {
    let installed = root.join("Openloop.app");
    fs::create_dir(&installed).expect("installed app");
    fs::write(installed.join("marker"), "old").expect("installed marker");
    installed
}

fn update_entries() -> Vec<(&'static [u8], u8, &'static [u8])> {
    vec![
        (b"Openloop.app/", b'5', b""),
        (b"Openloop.app/Contents/", b'5', b""),
        (b"Openloop.app/Contents/marker", b'0', b"new"),
    ]
}

#[test]
fn stages_one_valid_app_root_beside_the_installed_app_without_overwriting() {
    let root = tempdir().expect("update root");
    let installed = installed_app(root.path());
    let first = stage_verified_archive(&archive(&update_entries()), &installed)
        .expect("valid archive must stage");
    let second = stage_verified_archive(&archive(&update_entries()), &installed)
        .expect("candidate names must be unique");

    let canonical_root = fs::canonicalize(root.path()).expect("canonical update root");
    assert_eq!(first.path().parent(), Some(canonical_root.as_path()));
    assert_eq!(second.path().parent(), Some(canonical_root.as_path()));
    assert_ne!(first.path(), second.path());
    assert_eq!(
        first.path().extension().and_then(|value| value.to_str()),
        Some("app")
    );
    assert_eq!(
        fs::read_to_string(first.path().join("Contents/marker")).expect("candidate marker"),
        "new"
    );
    assert_eq!(
        fs::read_to_string(installed.join("marker")).expect("installed marker"),
        "old"
    );
    assert!(
        fs::read_dir(root.path())
            .expect("update root entries")
            .all(|entry| !entry
                .expect("update root entry")
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp")),
        "successful staging left a temporary extraction directory"
    );
}

#[test]
fn rejects_tampered_or_ambiguous_archive_structure_and_cleans_temporary_state() {
    let cases = [
        ("not-gzip", b"not a gzip archive".to_vec()),
        (
            "multiple-roots",
            archive(&[(b"Openloop.app/", b'5', b""), (b"Other.app/", b'5', b"")]),
        ),
        (
            "non-app-root",
            archive(&[(b"payload/", b'5', b""), (b"payload/file", b'0', b"x")]),
        ),
        (
            "duplicate-path",
            archive(&[
                (b"Openloop.app/", b'5', b""),
                (b"Openloop.app/file", b'0', b"x"),
                (b"Openloop.app/file", b'0', b"y"),
            ]),
        ),
    ];

    for (label, bytes) in cases {
        let root = tempdir().expect("update root");
        let installed = installed_app(root.path());
        let error =
            stage_verified_archive(&bytes, &installed).expect_err("tampered structure must fail");
        assert!(
            error.to_string().contains("archive") || error.to_string().contains("root"),
            "{label}: unexpected error: {error}"
        );
        assert_eq!(
            fs::read_dir(root.path()).expect("update root").count(),
            1,
            "{label}: failed staging left filesystem state"
        );
    }
}

#[test]
fn rejects_absolute_dot_parent_and_nested_traversal_paths() {
    for path in [
        b"/Openloop.app/file".as_slice(),
        b".".as_slice(),
        b"Openloop.app/./file".as_slice(),
        b"../escape".as_slice(),
        b"Openloop.app/../escape".as_slice(),
    ] {
        let root = tempdir().expect("update root");
        let installed = installed_app(root.path());
        let bytes = archive(&[(path, b'0', b"escape")]);

        let error =
            stage_verified_archive(&bytes, &installed).expect_err("traversal path must fail");

        assert!(
            error.to_string().contains("path") || error.to_string().contains("component"),
            "unexpected traversal error for {:?}: {error}",
            String::from_utf8_lossy(path)
        );
        assert!(!root.path().join("escape").exists());
    }
}

#[test]
fn rejects_symbolic_and_hard_links_before_unpacking() {
    for kind in [b'1', b'2'] {
        let root = tempdir().expect("update root");
        let installed = installed_app(root.path());
        let bytes = archive(&[
            (b"Openloop.app/", b'5', b""),
            (b"Openloop.app/escape", kind, b"../../escape"),
        ]);

        let error = stage_verified_archive(&bytes, &installed).expect_err("archive link must fail");

        assert!(error.to_string().contains("link") || error.to_string().contains("type"));
        assert!(!root.path().join("escape").exists());
    }
}

#[test]
fn rejects_special_files_before_unpacking() {
    for kind in [b'3', b'4', b'6', b'7'] {
        let root = tempdir().expect("update root");
        let installed = installed_app(root.path());
        let bytes = archive(&[
            (b"Openloop.app/", b'5', b""),
            (b"Openloop.app/special", kind, b""),
        ]);

        let error = stage_verified_archive(&bytes, &installed).expect_err("special file must fail");

        assert!(error.to_string().contains("special") || error.to_string().contains("type"));
    }
}
