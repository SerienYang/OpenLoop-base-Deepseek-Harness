include!("../build.rs");

#[cfg(test)]
mod updater_key_tests {
    use super::*;
    use std::ffi::OsString;
    use std::os::unix::ffi::OsStringExt;

    const VALID_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDg2QzhGMThDMUVFRkUzRUYKUldUdjQrOGVqUEhJaHNKdlgrNVE4REtTYTRENXpzL0VEVi9pb2pmTVJiR2MrRHl3Wnowdy9Lay8K";

    #[test]
    fn test_channel_uses_repository_key_as_the_no_environment_fallback() {
        let selected = select_updater_public_key("test", None, None)
            .expect("test channel fallback must be valid");

        assert_eq!(selected.environment, "OPENLOOP_UPDATER_PUBLIC_KEY");
        assert_eq!(selected.value, VALID_KEY);
        assert_eq!(selected.value, TEST_UPDATER_PUBLIC_KEY_FALLBACK);
    }

    #[test]
    fn stable_channel_requires_its_dedicated_environment_key() {
        let missing = select_updater_public_key("stable", Some(VALID_KEY), None)
            .expect_err("stable key must not fall back to the test key");
        assert!(missing
            .to_string()
            .contains("OPENLOOP_STABLE_UPDATER_PUBLIC_KEY"));

        let selected =
            select_updater_public_key("stable", None, Some(VALID_KEY)).expect("stable key");
        assert_eq!(selected.environment, "OPENLOOP_STABLE_UPDATER_PUBLIC_KEY");
        assert_eq!(selected.value, VALID_KEY);
    }

    #[test]
    fn selected_updater_key_must_be_nonempty_single_line_canonical_base64() {
        for key in ["", " ", "YQ==\n", "not-base64", "YQ="] {
            let error = select_updater_public_key("test", Some(key), None)
                .expect_err("invalid updater key must fail the build");
            assert!(
                error.to_string().contains("valid Tauri updater public key"),
                "unexpected updater key error for {key:?}: {error}"
            );
        }
    }

    #[test]
    fn present_non_utf8_updater_environment_is_not_treated_as_missing() {
        let error = updater_environment_value(
            "OPENLOOP_UPDATER_PUBLIC_KEY",
            Err(env::VarError::NotUnicode(OsString::from_vec(vec![0xff]))),
        )
        .expect_err("non-UTF-8 updater key must fail");

        assert!(error.to_string().contains("valid Tauri updater public key"));
    }
}
