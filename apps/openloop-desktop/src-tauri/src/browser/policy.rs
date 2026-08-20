use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use url::Url;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BrowserPolicyError {
    MalformedUrl,
    SchemeNotAllowed,
    HostNotAllowed,
    CredentialsNotAllowed,
    PortNotAllowed,
    ResolutionEmpty,
    AddressNotAllowed,
    DnsRebinding,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedUrl {
    pub normalized: String,
    pub scheme: String,
    pub host: String,
    pub port: u16,
    pub resolved_ips: Vec<IpAddr>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BrowserPolicy {
    dsh_port: u16,
}

impl BrowserPolicy {
    pub const fn new(dsh_port: u16) -> Self {
        Self { dsh_port }
    }

    pub fn validate_navigation(&self, raw_url: &str) -> Result<(), BrowserPolicyError> {
        let url = Url::parse(raw_url).map_err(|_| BrowserPolicyError::MalformedUrl)?;
        self.validate_url_shape(&url)
    }

    pub fn validate(
        &self,
        raw_url: &str,
        resolved_ips: &[IpAddr],
    ) -> Result<ValidatedUrl, BrowserPolicyError> {
        let url = Url::parse(raw_url).map_err(|_| BrowserPolicyError::MalformedUrl)?;
        self.validate_url_shape(&url)?;
        let scheme = url.scheme();
        let host = url.host_str().ok_or(BrowserPolicyError::HostNotAllowed)?;
        let port = url
            .port_or_known_default()
            .ok_or(BrowserPolicyError::PortNotAllowed)?;
        let pinned = canonical_addresses(resolved_ips)?;
        if pinned.iter().any(is_forbidden_address) {
            return Err(BrowserPolicyError::AddressNotAllowed);
        }
        Ok(ValidatedUrl {
            normalized: url.to_string(),
            scheme: scheme.to_owned(),
            host: host.to_owned(),
            port,
            resolved_ips: pinned,
        })
    }

    fn validate_url_shape(&self, url: &Url) -> Result<(), BrowserPolicyError> {
        if !matches!(url.scheme(), "http" | "https" | "ws" | "wss") {
            return Err(BrowserPolicyError::SchemeNotAllowed);
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err(BrowserPolicyError::CredentialsNotAllowed);
        }
        let host = url.host_str().ok_or(BrowserPolicyError::HostNotAllowed)?;
        if is_local_hostname(host) {
            return Err(BrowserPolicyError::HostNotAllowed);
        }
        let host_for_ip = host
            .strip_prefix('[')
            .and_then(|value| value.strip_suffix(']'))
            .unwrap_or(host);
        if host_for_ip
            .parse::<IpAddr>()
            .map(|ip| is_forbidden_address(&ip))
            .unwrap_or(false)
        {
            return Err(BrowserPolicyError::AddressNotAllowed);
        }
        if url.port_or_known_default() == Some(self.dsh_port) {
            return Err(BrowserPolicyError::PortNotAllowed);
        }
        Ok(())
    }

    pub fn validate_resolution_pin(
        &self,
        approved: &ValidatedUrl,
        resolved_ips: &[IpAddr],
    ) -> Result<(), BrowserPolicyError> {
        let next = canonical_addresses(resolved_ips)?;
        if next.iter().any(is_forbidden_address) {
            return Err(BrowserPolicyError::AddressNotAllowed);
        }
        if next != approved.resolved_ips {
            return Err(BrowserPolicyError::DnsRebinding);
        }
        Ok(())
    }
}

fn canonical_addresses(addresses: &[IpAddr]) -> Result<Vec<IpAddr>, BrowserPolicyError> {
    if addresses.is_empty() {
        return Err(BrowserPolicyError::ResolutionEmpty);
    }
    let mut result = addresses.to_vec();
    result.sort_unstable();
    result.dedup();
    Ok(result)
}

fn is_local_hostname(host: &str) -> bool {
    let normalized = host.trim_end_matches('.').to_ascii_lowercase();
    normalized == "localhost" || normalized.ends_with(".localhost")
}

fn is_forbidden_address(address: &IpAddr) -> bool {
    match address {
        IpAddr::V4(ip) => is_forbidden_ipv4(*ip),
        IpAddr::V6(ip) => is_forbidden_ipv6(*ip),
    }
}

fn is_forbidden_ipv4(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || (octets[0] == 100 && (64..=127).contains(&octets[1]))
        || (octets[0] == 192 && octets[1] == 0 && octets[2] == 0)
        || (octets[0] == 192 && octets[1] == 0 && octets[2] == 2)
        || (octets[0] == 198 && octets[1] == 18)
        || (octets[0] == 198 && octets[1] == 19)
        || (octets[0] == 198 && octets[1] == 51 && octets[2] == 100)
        || (octets[0] == 203 && octets[1] == 0 && octets[2] == 113)
        || (224..=255).contains(&octets[0])
}

fn is_forbidden_ipv6(ip: Ipv6Addr) -> bool {
    let segments = ip.segments();
    ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_unique_local()
        || ip.is_unicast_link_local()
        || ip.is_multicast()
        || (segments[0] == 0x2001 && segments[1] == 0x0db8)
}
