use std::{
    io::{Read, Write},
    net::{IpAddr, Ipv4Addr, TcpListener, TcpStream},
    thread,
    time::Duration,
};

use openloop_desktop_lib::browser::{
    network_policy_proxy::NetworkPolicyProxy,
    policy::{BrowserPolicy, BrowserPolicyError},
};

#[test]
fn blocks_loopback_target_before_fixture_receives_a_connection() {
    let fixture = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("fixture listener");
    let fixture_address = fixture.local_addr().expect("fixture address");
    fixture.set_nonblocking(true).expect("nonblocking fixture");
    let proxy = NetworkPolicyProxy::start(BrowserPolicy::new(fixture_address.port()))
        .expect("policy proxy");

    let mut client = TcpStream::connect(proxy.address()).expect("proxy connection");
    write!(
        client,
        "GET http://127.0.0.1:{}/ HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
        fixture_address.port(),
        fixture_address.port()
    )
    .expect("proxy request");
    client
        .set_read_timeout(Some(Duration::from_secs(2)))
        .expect("client timeout");
    let mut response = String::new();
    client
        .read_to_string(&mut response)
        .expect("proxy response");

    assert!(response.starts_with("HTTP/1.1 403"), "{response}");
    thread::sleep(Duration::from_millis(50));
    assert!(
        matches!(fixture.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock)
    );
}

#[test]
fn rejects_dns_rebinding_before_opening_the_second_target_connection() {
    let proxy = NetworkPolicyProxy::new(BrowserPolicy::new(43_127));
    let public_one = IpAddr::V4(Ipv4Addr::new(93, 184, 216, 34));
    let public_two = IpAddr::V4(Ipv4Addr::new(93, 184, 216, 35));

    proxy
        .authorize("https://public.example/", &[public_one])
        .expect("first answer");
    assert!(matches!(
        proxy.authorize("https://public.example/redirect", &[public_two]),
        Err(BrowserPolicyError::DnsRebinding)
    ));
}
