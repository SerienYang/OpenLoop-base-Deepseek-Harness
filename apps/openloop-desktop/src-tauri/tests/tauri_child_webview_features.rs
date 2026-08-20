#[cfg(target_os = "macos")]
#[test]
fn compiles_the_child_webview_proxy_configuration_path() {
    let proxy = openloop_desktop_lib::browser::network_policy_proxy::NetworkPolicyProxy::start(
        openloop_desktop_lib::browser::policy::BrowserPolicy::new(43_127),
    )
    .expect("policy proxy");
    let builder: tauri::WebviewBuilder<tauri::Wry> = openloop_desktop_lib::build_browser_webview(
        "openloop-browser-spike",
        tauri::Url::parse("https://example.com/").expect("fixture URL"),
        &proxy,
    );

    let _ = builder;
}

#[cfg(not(target_os = "macos"))]
#[test]
fn child_webview_proxy_path_is_macOS_only() {}
