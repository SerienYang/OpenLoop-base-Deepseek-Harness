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
    compress(tar)
}

fn compress(mut tar: Builder<Vec<u8>>) -> Vec<u8> {
    tar.finish().expect("finish test tar");
    let bytes = tar.into_inner().expect("read test tar");
    let mut gzip = GzEncoder::new(Vec::new(), Compression::default());
    gzip.write_all(&bytes).expect("compress test tar");
    gzip.finish().expect("finish test gzip")
}

fn archive_with_component_count(component_count: usize) -> (Vec<u8>, std::path::PathBuf) {
    assert!(component_count >= 2);
    let relative = std::iter::repeat_n("d", component_count - 2)
        .chain(std::iter::once("marker"))
        .collect::<std::path::PathBuf>();
    let archive_path = Path::new("Openloop.app").join(&relative);
    let mut tar = Builder::new(Vec::new());
    append(&mut tar, b"Openloop.app/", b'5', b"");
    let mut header = Header::new_gnu();
    header.set_entry_type(EntryType::Regular);
    header.set_mode(0o644);
    header.set_size(3);
    header.set_uid(501);
    header.set_gid(20);
    header.set_mtime(0);
    header.set_cksum();
    tar.append_data(&mut header, &archive_path, Cursor::new(b"new"))
        .expect("append deep archive entry");
    (compress(tar), relative)
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

fn preserved_artifact_paths(root: &Path) -> Vec<std::path::PathBuf> {
    let mut paths = fs::read_dir(root)
        .expect("update root")
        .filter_map(Result::ok)
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            (name.starts_with(".openloop-candidate-") && name.ends_with(".app"))
                || (name.starts_with(".openloop-update-") && name.ends_with(".tmp"))
        })
        .map(|entry| fs::canonicalize(entry.path()).expect("canonical preserved artifact"))
        .collect::<Vec<_>>();
    paths.sort();
    paths
}

#[test]
fn stages_one_valid_app_root_directly_as_the_only_candidate_artifact() {
    let root = tempdir().expect("update root");
    let installed = installed_app(root.path());
    let staged = stage_verified_archive(&archive(&update_entries()), &installed)
        .expect("valid archive must stage");

    let canonical_root = fs::canonicalize(root.path()).expect("canonical update root");
    assert_eq!(staged.path().parent(), Some(canonical_root.as_path()));
    let candidate_name = staged
        .path()
        .file_name()
        .expect("candidate name")
        .to_string_lossy();
    assert!(candidate_name.starts_with(".openloop-candidate-"));
    assert!(candidate_name.ends_with(".app"));
    assert_eq!(
        fs::read_to_string(staged.path().join("Contents/marker")).expect("candidate marker"),
        "new"
    );
    assert_eq!(
        fs::read_to_string(installed.join("marker")).expect("installed marker"),
        "old"
    );
    assert_eq!(
        fs::read_dir(root.path())
            .expect("update root entries")
            .count(),
        2,
        "direct candidate staging must not create an extra temporary root"
    );
}

#[test]
fn accepts_archive_paths_with_100_total_components() {
    let root = tempdir().expect("update root");
    let installed = installed_app(root.path());
    let (bytes, relative) = archive_with_component_count(100);

    let staged =
        stage_verified_archive(&bytes, &installed).expect("100-component path must be accepted");

    assert_eq!(
        fs::read(staged.path().join(relative)).expect("deep staged file"),
        b"new"
    );
}

#[test]
fn rejects_101_component_archive_before_creating_a_candidate_directory() {
    let root = tempdir().expect("update root");
    let installed = installed_app(root.path());
    let (bytes, _) = archive_with_component_count(101);

    let error = stage_verified_archive(&bytes, &installed)
        .expect_err("101-component path must exceed the archive depth limit");

    assert!(error.to_string().contains("100"));
    assert!(error.preserved_paths().is_empty());
    assert_eq!(
        fs::read_dir(root.path()).expect("update root").count(),
        1,
        "depth rejection created a candidate directory"
    );
}

#[test]
fn rejects_extremely_deep_archive_without_creating_a_candidate_directory() {
    let root = tempdir().expect("update root");
    let installed = installed_app(root.path());
    let (bytes, _) = archive_with_component_count(10_000);

    let error = stage_verified_archive(&bytes, &installed)
        .expect_err("extremely deep path must fail without recursive processing");

    assert!(error.to_string().contains("100"));
    assert!(error.preserved_paths().is_empty());
    assert_eq!(
        fs::read_dir(root.path()).expect("update root").count(),
        1,
        "extreme depth rejection created a candidate directory"
    );
}

#[test]
fn preserved_candidate_blocks_the_next_stage_until_recovery_cleanup() {
    let root = tempdir().expect("update root");
    let installed = installed_app(root.path());
    let staged = stage_verified_archive(&archive(&update_entries()), &installed)
        .expect("valid archive must stage");
    let candidate = staged.path().to_owned();

    drop(staged);

    let error = stage_verified_archive(&archive(&update_entries()), &installed)
        .expect_err("preserved candidate must block a second stage");
    let expected = vec![fs::canonicalize(&candidate).expect("canonical preserved candidate")];
    assert!(
        error.to_string().contains("requires recovery cleanup"),
        "unexpected bounded-retention error: {error}"
    );
    assert_eq!(error.preserved_paths(), expected);
    assert!(
        error.to_string().contains(&candidate.display().to_string()),
        "preserved candidate path is absent from error: {error}"
    );
    assert_eq!(
        fs::read_to_string(candidate.join("Contents/marker")).expect("preserved candidate"),
        "new"
    );
    assert_eq!(fs::read_dir(root.path()).expect("update root").count(), 2);
}

#[test]
fn cleanup_isolation_blocks_staging_without_deleting_the_recovery_owned_artifact() {
    let root = tempdir().expect("update root");
    let installed = installed_app(root.path());
    let isolated = root.path().join(
        ".openloop-cleanup-0f40b072-8c3f-48f9-86c1-5f857d537aef-\
         5345877f-ef7b-4fd8-a6e1-35f91385848d",
    );
    fs::create_dir(&isolated).expect("cleanup isolation");
    fs::write(isolated.join("marker"), b"recovery-owned").expect("cleanup isolation marker");

    let error = stage_verified_archive(&archive(&update_entries()), &installed)
        .expect_err("cleanup isolation must block staging");

    assert!(error.to_string().contains("requires recovery cleanup"));
    assert_eq!(
        error.preserved_paths(),
        [fs::canonicalize(&isolated).expect("canonical cleanup isolation")]
    );
    assert_eq!(
        fs::read(isolated.join("marker")).expect("preserved cleanup isolation marker"),
        b"recovery-owned"
    );
    assert_eq!(fs::read_dir(root.path()).expect("update root").count(), 2);
}

#[test]
fn any_legacy_candidate_or_temporary_artifact_blocks_staging() {
    for names in [
        vec![".openloop-candidate-existing.app"],
        vec![".openloop-update-existing.tmp"],
        vec![
            ".openloop-candidate-existing.app",
            ".openloop-update-existing.tmp",
        ],
    ] {
        let root = tempdir().expect("update root");
        let installed = installed_app(root.path());
        for name in &names {
            fs::create_dir(root.path().join(name)).expect("preserved artifact");
        }

        let error = stage_verified_archive(&archive(&update_entries()), &installed)
            .expect_err("preserved artifact must block staging");
        let mut expected = names
            .iter()
            .map(|name| fs::canonicalize(root.path().join(name)).expect("canonical artifact"))
            .collect::<Vec<_>>();
        expected.sort();

        assert!(
            error.to_string().contains("requires recovery cleanup"),
            "unexpected bounded-retention error: {error}"
        );
        assert_eq!(error.preserved_paths(), expected);
        for path in &expected {
            assert!(
                error.to_string().contains(&path.display().to_string()),
                "preserved artifact path is absent from error: {error}"
            );
        }
        assert_eq!(
            fs::read_dir(root.path()).expect("update root").count(),
            names.len() + 1,
            "failed-closed staging created another artifact"
        );
    }
}

#[test]
fn rejects_tampered_or_ambiguous_archive_structure_without_recursive_cleanup() {
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
        let preserved = preserved_artifact_paths(root.path());
        assert_eq!(
            error.preserved_paths(),
            preserved,
            "{label}: error did not expose the preserved candidate path"
        );
        assert_eq!(
            preserved.len(),
            1,
            "{label}: failed staging left more than one preserved artifact"
        );
        assert!(
            error
                .to_string()
                .contains(&preserved[0].display().to_string()),
            "{label}: error did not include the full preserved candidate path: {error}"
        );
        assert!(
            error.to_string().contains("archive") || error.to_string().contains("root"),
            "{label}: unexpected error: {error}"
        );
        assert!(
            preserved[0]
                .file_name()
                .expect("preserved candidate name")
                .to_string_lossy()
                .starts_with(".openloop-candidate-"),
            "{label}: failed candidate was not preserved directly"
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
    for kind in *b"12" {
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
    for kind in *b"3467" {
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
