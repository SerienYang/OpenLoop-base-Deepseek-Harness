use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use openloop_desktop_lib::browser::policy::{BrowserPolicy, BrowserPolicyError};

fn public_ip() -> IpAddr {
    IpAddr::V4(Ipv4Addr::new(93, 184, 216, 34))
}

#[test]
fn rejects_non_web_schemes_and_internal_hosts() {
    let policy = BrowserPolicy::new(43_127);

    for url in [
        "file:///Users/test/file.html",
        "javascript:alert(1)",
        "openloop://internal",
        "http://localhost/",
        "http://127.0.0.1/",
        "http://[::1]/",
    ] {
        let result = policy.validate(url, &[public_ip()]);
        assert!(
            matches!(
                result,
                Err(BrowserPolicyError::SchemeNotAllowed)
                    | Err(BrowserPolicyError::HostNotAllowed)
                    | Err(BrowserPolicyError::AddressNotAllowed)
            ),
            "{url}: {result:?}"
        );
    }
}

#[test]
fn rejects_private_link_local_and_dsh_port_targets() {
    let policy = BrowserPolicy::new(43_127);

    for ip in [
        IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1)),
        IpAddr::V4(Ipv4Addr::new(172, 16, 0, 1)),
        IpAddr::V4(Ipv4Addr::new(192, 168, 0, 1)),
        IpAddr::V4(Ipv4Addr::new(169, 254, 1, 1)),
        IpAddr::V6(Ipv6Addr::LOCALHOST),
        IpAddr::V6(Ipv6Addr::UNSPECIFIED),
        IpAddr::V6(Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 1)),
    ] {
        let result = policy.validate("https://public.example/", &[ip]);
        assert!(
            matches!(result, Err(BrowserPolicyError::AddressNotAllowed)),
            "{ip}: {result:?}"
        );
    }

    let result = policy.validate("https://public.example:43127/", &[public_ip()]);
    assert!(matches!(result, Err(BrowserPolicyError::PortNotAllowed)));
}

#[test]
fn allows_public_http_https_and_websocket_targets() {
    let policy = BrowserPolicy::new(43_127);

    for url in [
        "http://public.example/",
        "https://public.example:443/path",
        "ws://public.example/socket",
        "wss://public.example/socket",
    ] {
        assert!(policy.validate(url, &[public_ip()]).is_ok(), "{url}");
    }
}

#[test]
fn pins_dns_answer_and_rejects_rebinding() {
    let policy = BrowserPolicy::new(43_127);
    let approved = policy
        .validate("https://public.example/", &[public_ip()])
        .expect("public URL should be approved");

    assert!(policy
        .validate_resolution_pin(&approved, &[public_ip()])
        .is_ok());
    assert!(matches!(
        policy.validate_resolution_pin(&approved, &[IpAddr::V4(Ipv4Addr::new(93, 184, 216, 35))]),
        Err(BrowserPolicyError::DnsRebinding)
    ));
    assert!(matches!(
        policy.validate_resolution_pin(&approved, &[IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1))]),
        Err(BrowserPolicyError::AddressNotAllowed)
    ));
}
