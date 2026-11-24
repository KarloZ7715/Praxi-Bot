//! Site favicons: fetched directly from the target public domain via the
//! daemon's SSRF-guarded HTTP fetcher (never via any third-party favicon
//! service), validated by magic bytes / safe static SVG, cached under
//! `<data_dir>/cache/favicons/`, and served with strict `nosniff` + CSP headers.
//!
//! A favicon request is itself egress (a DNS lookup plus HTTPS requests that carry the host
//! name), so the route is an owner route and the network is touched ONLY for a host that
//! already counts as allowed for some bot (a standing or chat grant for its origin, or a
//! navigation the owner approved). Every other host is answered from the on-disk cache or with
//! `404` and no network access at all: a prompt-injected bot cannot smuggle data out in a host
//! name by getting a pending approval card rendered.
//!
//! Guarantees that live in `web-tools` (`HttpFetcher` + `DefaultUrlPolicy`) and are tested there:
//! the connection goes only to an address the policy validated (`GuardedResolver`; test
//! `hermetic::hostname_resolving_to_loopback_is_blocked_after_dns`), every redirect hop is
//! re-validated (`hermetic::redirect_to_metadata_ip_is_blocked`), IPv4-mapped / NAT64 / 6to4 /
//! decimal / hex / octal literals, private, loopback, link-local and metadata ranges and URL
//! userinfo are refused (`policy::tests::private_and_loopback_literals_blocked`,
//! `schemes_restricted`), the body is cut at `max_bytes` while streaming
//! (`hermetic::oversize_body_is_cut_and_spilled`), and the client has no gzip / brotli / deflate
//! feature, so there is no decompression to bomb.

use std::collections::{HashMap, VecDeque};
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use async_trait::async_trait;
use axum::body::Body;
use axum::extract::{Path as AxumPath, State};
use axum::http::StatusCode;
use axum::response::Response;
use parking_lot::Mutex;
use tokio::sync::Semaphore;
use url::Url;
use web_tools::{
    DefaultUrlPolicy, Fetched, GetOptions, HttpConfig, HttpFetcher, WebError, metadata,
};

use crate::AppState;
use crate::error::{ApiError, ErrorBody};

/// Largest favicon accepted and cached (96 KiB).
pub const MAX_FAVICON_BYTES: usize = 96 * 1024;
/// Maximum HTML document bytes scanned for `<link rel="icon">`.
const MAX_HTML_BYTES: usize = 256 * 1024;
/// How long cached favicons stay fresh on disk.
const CACHE_TTL: Duration = Duration::from_secs(7 * 24 * 3600);
/// How long a failed lookup is negatively cached (in memory only).
const MISS_TTL: Duration = Duration::from_secs(3600);
/// Entries kept in the in-memory negative cache.
const MAX_MISSES: usize = 1024;
/// Icons kept on disk; the least recently used go first.
const MAX_CACHE_ENTRIES: usize = 500;
/// Total bytes of icons kept on disk.
const MAX_CACHE_BYTES: u64 = 16 * 1024 * 1024;
/// Network lookups running at once, for the whole daemon.
const MAX_CONCURRENT_LOOKUPS: usize = 2;
/// Network lookups started per minute, for the whole daemon.
const MAX_LOOKUPS_PER_MINUTE: usize = 30;
/// Wall-clock budget of one lookup (`/favicon.ico`, the page and one linked icon).
const LOOKUP_BUDGET: Duration = Duration::from_secs(9);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Favicon {
    pub bytes: Vec<u8>,
    pub content_type: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FaviconError {
    TooLarge,
    NotImage,
    Unsafe,
}

/// Validate a public DNS domain name for favicon lookup.
/// Rejects IPs (including decimal / hex / octal spellings), localhost,
/// `.local`/`.internal`/`.arpa`/`.lan`, empty labels, userinfo and ports, and anything
/// outside `[a-z0-9.-]`.
pub(crate) fn check_domain(raw: &str) -> Result<String, ApiError> {
    let domain = raw.trim().trim_end_matches('.').to_ascii_lowercase();
    if domain.is_empty() || domain.len() > 253 || !domain.contains('.') {
        return Err(ApiError::bad_request("invalid domain"));
    }
    if domain.parse::<IpAddr>().is_ok() {
        return Err(ApiError::bad_request("ip address is not a domain"));
    }
    if matches!(
        domain.rsplit('.').next(),
        Some("localhost" | "local" | "internal" | "arpa" | "lan" | "corp" | "intranet" | "home")
    ) {
        return Err(ApiError::bad_request("non-public domain"));
    }
    // A final label that is not a name (`127.1`, `0x7f.1`, `2130706433`) is an IPv4 spelling the
    // URL parser would normalise to an address: refuse it here, before any lookup.
    if !domain
        .rsplit('.')
        .next()
        .is_some_and(|tld| tld.starts_with(|c: char| c.is_ascii_lowercase()))
    {
        return Err(ApiError::bad_request("invalid top-level label"));
    }
    for label in domain.split('.') {
        if label.is_empty()
            || label.len() > 63
            || label.starts_with('-')
            || label.ends_with('-')
            || !label
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        {
            return Err(ApiError::bad_request("invalid domain label"));
        }
    }
    Ok(domain)
}

/// Active/external SVG constructs that must never be served.
const FORBIDDEN_SVG: &[&str] = &[
    "<script",
    "<foreignobject",
    "<iframe",
    "<object",
    "<embed",
    "<!entity",
    "<!doctype",
    "<image",
    "<use",
    "<a ",
    "<a>",
    "<animate",
    "<set ",
    "<style",
    "javascript:",
    "data:",
    "http://",
    "https://",
    "xlink:href",
    "href=",
    "@import",
    "url(",
];

fn check_svg(bytes: &[u8]) -> Result<(), FaviconError> {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return Err(FaviconError::NotImage);
    };
    let lower = text.to_ascii_lowercase();
    if !lower.contains("<svg") {
        return Err(FaviconError::NotImage);
    }
    let stripped = lower.replace("http://www.w3.org/2000/svg", "");
    if FORBIDDEN_SVG.iter().any(|f| stripped.contains(f)) {
        return Err(FaviconError::Unsafe);
    }
    let raw = lower.as_bytes();
    for (i, w) in raw.windows(3).enumerate() {
        if w == b" on" || w == b"\non" || w == b"\ton" {
            let rest = &lower[i + 3..];
            let name: String = rest.chars().take_while(char::is_ascii_alphabetic).collect();
            let after = rest[name.len()..].trim_start();
            if !name.is_empty() && after.starts_with('=') {
                return Err(FaviconError::Unsafe);
            }
        }
    }
    Ok(())
}

/// Detect and validate favicon image bytes by their magic signature.
pub fn classify(bytes: &[u8]) -> Result<&'static str, FaviconError> {
    if bytes.len() > MAX_FAVICON_BYTES {
        return Err(FaviconError::TooLarge);
    }
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Ok("image/png");
    }
    if bytes.len() > 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Ok("image/webp");
    }
    if bytes.len() > 6 && (&bytes[..4] == b"\x00\x00\x01\x00" || &bytes[..4] == b"\x00\x00\x02\x00")
    {
        return Ok("image/x-icon");
    }
    let head = &bytes[..bytes.len().min(512)];
    let trimmed = head
        .iter()
        .position(|b| !b.is_ascii_whitespace())
        .map_or(head, |i| &head[i..]);
    if trimmed.starts_with(b"<svg") || trimmed.starts_with(b"<?xml") {
        check_svg(bytes)?;
        return Ok("image/svg+xml");
    }
    Err(FaviconError::NotImage)
}

fn extension(content_type: &str) -> &'static str {
    match content_type {
        "image/png" => "png",
        "image/webp" => "webp",
        "image/x-icon" => "ico",
        _ => "svg",
    }
}

fn cache_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("cache").join("favicons")
}

fn fresh(meta: &std::fs::Metadata, ttl: Duration) -> bool {
    meta.modified()
        .ok()
        .and_then(|m| SystemTime::now().duration_since(m).ok())
        .is_some_and(|age| age < ttl)
}

enum CacheHit {
    Icon(Favicon),
    Empty,
}

fn read_cache(data_dir: &Path, domain: &str) -> CacheHit {
    let dir = cache_dir(data_dir);
    for ext in ["png", "webp", "ico", "svg"] {
        let p = dir.join(format!("{domain}.{ext}"));
        let Ok(meta) = std::fs::symlink_metadata(&p) else {
            continue;
        };
        if !meta.is_file() || meta.file_type().is_symlink() || !fresh(&meta, CACHE_TTL) {
            continue;
        }
        if let Ok(bytes) = std::fs::read(&p)
            && let Ok(content_type) = classify(&bytes)
            && extension(content_type) == ext
        {
            // Last use, for least-recently-used eviction (the modified time stays the age).
            if let Ok(f) = std::fs::File::options().write(true).open(&p) {
                let _ = f.set_times(std::fs::FileTimes::new().set_accessed(SystemTime::now()));
            }
            return CacheHit::Icon(Favicon {
                bytes,
                content_type,
            });
        }
    }
    CacheHit::Empty
}

fn store_cache(data_dir: &Path, domain: &str, icon: &Favicon) {
    let dir = cache_dir(data_dir);
    if std::fs::create_dir_all(&dir).is_ok() {
        let _ = std::fs::write(
            dir.join(format!("{domain}.{}", extension(icon.content_type))),
            &icon.bytes,
        );
        enforce_cache_limits(&dir, MAX_CACHE_ENTRIES, MAX_CACHE_BYTES);
    }
}

/// Keep at most `max_entries` icons and `max_bytes` bytes: the least recently used go first.
/// Stray files that are not icons (older versions wrote `.miss` files) are removed.
fn enforce_cache_limits(dir: &Path, max_entries: usize, max_bytes: u64) {
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(SystemTime, u64, PathBuf)> = Vec::new();
    for entry in read.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        let icon = path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| matches!(e, "png" | "webp" | "ico" | "svg"));
        if !meta.is_file() || !icon {
            let _ = std::fs::remove_file(&path);
            continue;
        }
        let used = meta
            .accessed()
            .or_else(|_| meta.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        files.push((used, meta.len(), path));
    }
    files.sort_by_key(|(used, _, _)| *used);
    let mut total: u64 = files.iter().map(|(_, len, _)| *len).sum();
    let mut count = files.len();
    for (_, len, path) in files {
        if count <= max_entries && total <= max_bytes {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            count -= 1;
            total = total.saturating_sub(len);
        }
    }
}

fn same_site_https(candidate: &str, domain: &str) -> Option<Url> {
    let url = Url::parse(candidate).ok()?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let host = url.host_str()?.trim_end_matches('.').to_ascii_lowercase();
    if host == domain || host.ends_with(&format!(".{domain}")) {
        Some(url)
    } else {
        None
    }
}

/// The one thing a lookup needs from the network, so tests can count requests.
#[async_trait]
pub(crate) trait Fetch: Send + Sync {
    async fn get(&self, url: &str, opts: &GetOptions) -> Result<Fetched, WebError>;
}

#[async_trait]
impl Fetch for HttpFetcher {
    async fn get(&self, url: &str, opts: &GetOptions) -> Result<Fetched, WebError> {
        HttpFetcher::get(self, url, opts).await
    }
}

async fn fetch_from_origin(
    origin_base: &Url,
    domain: &str,
    fetcher: &dyn Fetch,
) -> Option<Favicon> {
    let icon_url = origin_base.join("/favicon.ico").ok()?;
    let icon_opts = GetOptions {
        max_bytes: Some(MAX_FAVICON_BYTES),
        timeout: Some(Duration::from_secs(3)),
        ..GetOptions::default()
    };
    if let Ok(resp) = fetcher.get(icon_url.as_str(), &icon_opts).await
        && (200..300).contains(&resp.status)
        && let Ok(content_type) = classify(&resp.body)
    {
        return Some(Favicon {
            bytes: resp.body,
            content_type,
        });
    }

    let html_opts = GetOptions {
        accept_types: vec!["text/html".to_owned(), "application/xhtml+xml".to_owned()],
        max_bytes: Some(MAX_HTML_BYTES),
        timeout: Some(Duration::from_secs(3)),
        ..GetOptions::default()
    };
    let page = fetcher.get(origin_base.as_str(), &html_opts).await.ok()?;
    if !(200..300).contains(&page.status) {
        return None;
    }
    let meta = metadata::extract_metadata(&page.text(), Some(&page.url));
    for candidate in meta.icons {
        let Some(url) = same_site_https(&candidate, domain) else {
            continue;
        };
        if let Ok(resp) = fetcher.get(url.as_str(), &icon_opts).await
            && (200..300).contains(&resp.status)
            && let Ok(content_type) = classify(&resp.body)
        {
            return Some(Favicon {
                bytes: resp.body,
                content_type,
            });
        }
    }
    None
}

/// Shared state of the favicon route: ONE fetcher, a global concurrency limit, a per-minute cap
/// on network lookups and a bounded in-memory negative cache.
pub(crate) struct FaviconService {
    fetcher: Arc<dyn Fetch>,
    permits: Semaphore,
    per_minute: usize,
    started: Mutex<VecDeque<Instant>>,
    misses: Mutex<HashMap<String, Instant>>,
}

impl FaviconService {
    fn new(fetcher: Arc<dyn Fetch>, concurrent: usize, per_minute: usize) -> Self {
        Self {
            fetcher,
            permits: Semaphore::new(concurrent),
            per_minute,
            started: Mutex::new(VecDeque::new()),
            misses: Mutex::new(HashMap::new()),
        }
    }

    /// The process-wide service; `None` when the HTTP client cannot be built.
    fn shared() -> Option<&'static Self> {
        static SERVICE: OnceLock<Option<FaviconService>> = OnceLock::new();
        SERVICE
            .get_or_init(|| {
                let fetcher = HttpFetcher::new(
                    Arc::new(DefaultUrlPolicy::default()),
                    HttpConfig {
                        timeout: Duration::from_secs(4),
                        connect_timeout: Duration::from_secs(3),
                        max_bytes: MAX_HTML_BYTES,
                        max_redirects: 3,
                        ..HttpConfig::default()
                    },
                )
                .ok()?;
                Some(Self::new(
                    Arc::new(fetcher),
                    MAX_CONCURRENT_LOOKUPS,
                    MAX_LOOKUPS_PER_MINUTE,
                ))
            })
            .as_ref()
    }

    fn recently_missed(&self, domain: &str) -> bool {
        let mut misses = self.misses.lock();
        match misses.get(domain) {
            Some(at) if at.elapsed() < MISS_TTL => true,
            Some(_) => {
                misses.remove(domain);
                false
            }
            None => false,
        }
    }

    fn note_miss(&self, domain: &str) {
        let mut misses = self.misses.lock();
        if misses.len() >= MAX_MISSES {
            misses.retain(|_, at| at.elapsed() < MISS_TTL);
        }
        if misses.len() >= MAX_MISSES
            && let Some(oldest) = misses
                .iter()
                .min_by_key(|(_, at)| **at)
                .map(|(k, _)| k.clone())
        {
            misses.remove(&oldest);
        }
        misses.insert(domain.to_owned(), Instant::now());
    }

    /// One more lookup this minute, or `false`.
    fn take_rate_slot(&self) -> bool {
        let mut started = self.started.lock();
        let now = Instant::now();
        while started
            .front()
            .is_some_and(|t| now.duration_since(*t) >= Duration::from_secs(60))
        {
            started.pop_front();
        }
        if started.len() >= self.per_minute {
            return false;
        }
        started.push_back(now);
        true
    }

    /// The favicon of `domain`: from the disk cache, or, only when `allowed` (the host already
    /// counts as allowed for some bot), from the network. An unapproved host never reaches the
    /// network: no DNS lookup, no request.
    async fn resolve(&self, data_dir: &Path, domain: &str, allowed: bool) -> Option<Favicon> {
        if let CacheHit::Icon(icon) = read_cache(data_dir, domain) {
            return Some(icon);
        }
        if !allowed || self.recently_missed(domain) || !self.take_rate_slot() {
            return None;
        }
        // Busy: answer "no icon" now (the UI shows its letter tile) instead of queueing.
        let _permit = self.permits.try_acquire().ok()?;
        let origin = Url::parse(&format!("https://{domain}/")).ok()?;
        let found = tokio::time::timeout(
            LOOKUP_BUDGET,
            fetch_from_origin(&origin, domain, self.fetcher.as_ref()),
        )
        .await
        .ok()
        .flatten();
        if let Some(icon) = &found {
            store_cache(data_dir, domain, icon);
        } else {
            self.note_miss(domain);
        }
        found
    }
}

/// A site's favicon, from the local cache or fetched directly from `https://<domain>` (never a
/// third-party favicon service) when that host is already allowed for a bot. Owner-only.
/// Returns `404` when unavailable or not allowed so the UI falls back to a globe or letter tile.
#[utoipa::path(
    get,
    path = "/v1/favicons/{domain}",
    tag = "favicons",
    security(("bearer" = [])),
    params(("domain" = String, Path, description = "Public site domain")),
    responses(
        (status = 200, description = "Favicon image bytes"),
        (status = 400, body = ErrorBody),
        (status = 404, body = ErrorBody)
    )
)]
pub(crate) async fn get_favicon(
    State(s): State<AppState>,
    AxumPath(domain): AxumPath<String>,
) -> Result<Response, ApiError> {
    let domain = check_domain(&domain)?;
    let service =
        FaviconService::shared().ok_or_else(|| ApiError::internal("favicon client unavailable"))?;
    let allowed = s.agent().site_allowed(&domain);
    let icon = service
        .resolve(&s.data_dir(), &domain, allowed)
        .await
        .ok_or_else(|| ApiError::not_found("favicon"))?;

    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", icon.content_type)
        .header("x-content-type-options", "nosniff")
        .header(
            "content-security-policy",
            "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        )
        .header("cache-control", "private, max-age=86400")
        .body(Body::from(icon.bytes))
        .map_err(ApiError::internal)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR";

    /// Counts every request and answers `/favicon.ico` with a PNG (or with an error).
    struct Counting {
        calls: AtomicUsize,
        inflight: AtomicUsize,
        max_inflight: AtomicUsize,
        delay: Duration,
        ok: bool,
    }

    impl Counting {
        fn new(ok: bool, delay: Duration) -> Arc<Self> {
            Arc::new(Self {
                calls: AtomicUsize::new(0),
                inflight: AtomicUsize::new(0),
                max_inflight: AtomicUsize::new(0),
                delay,
                ok,
            })
        }
        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl Fetch for Counting {
        async fn get(&self, url: &str, _: &GetOptions) -> Result<Fetched, WebError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let now = self.inflight.fetch_add(1, Ordering::SeqCst) + 1;
            self.max_inflight.fetch_max(now, Ordering::SeqCst);
            tokio::time::sleep(self.delay).await;
            self.inflight.fetch_sub(1, Ordering::SeqCst);
            if !self.ok {
                return Err(WebError::Status(404));
            }
            Ok(Fetched {
                url: Url::parse(url).unwrap(),
                status: 200,
                media_type: None,
                charset: None,
                body: PNG.to_vec(),
                truncated: false,
                redirects: 0,
            })
        }
    }

    fn service(f: &Arc<Counting>, concurrent: usize, per_minute: usize) -> FaviconService {
        FaviconService::new(Arc::clone(f) as Arc<dyn Fetch>, concurrent, per_minute)
    }

    #[test]
    fn rejects_non_public_ips_and_bad_domains() {
        assert_eq!(check_domain("Webioo.COM.TR.").unwrap(), "webioo.com.tr");
        for bad in [
            "",
            "localhost",
            "127.0.0.1",
            "::1",
            "[::1]",
            "::ffff:127.0.0.1",
            "169.254.169.254",
            "10.0.0.5",
            "2130706433",
            "0x7f000001",
            "0x7f.0.0.1",
            "0177.0.0.1",
            "127.1",
            "printer.local",
            "service.internal",
            "metadata.google.internal",
            "a..b.com",
            "-bad.com",
            "bad-.com",
            "a/b.com",
            "user@example.com",
            "example.com:8080",
            "bücher.example",
        ] {
            assert!(check_domain(bad).is_err(), "{bad}");
        }
        assert!(check_domain("xn--bcher-kva.example").is_ok());
    }

    #[test]
    fn classifies_valid_images_and_blocks_active_svg() {
        assert_eq!(classify(PNG), Ok("image/png"));
        assert_eq!(
            classify(b"\x00\x00\x01\x00\x01\x00\x10\x10\x00\x00\x01\x00\x20\x00"),
            Ok("image/x-icon")
        );
        assert_eq!(classify(b"RIFF\x10\x00\x00\x00WEBPVP8 "), Ok("image/webp"));
        assert_eq!(
            classify(br#"<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>"#),
            Ok("image/svg+xml")
        );
        assert_eq!(
            classify(br#"<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>"#),
            Err(FaviconError::Unsafe)
        );
        assert_eq!(
            classify(b"<html><body>not an icon</body></html>"),
            Err(FaviconError::NotImage)
        );
    }

    /// B1: a host that is not allowed (a pending card, a denied call, an injected name) causes
    /// ZERO outbound requests, however often it is asked for.
    #[tokio::test]
    async fn an_unapproved_host_causes_zero_outbound_requests() {
        let dir = tempfile::tempdir().unwrap();
        let fetcher = Counting::new(true, Duration::ZERO);
        let svc = service(&fetcher, 2, 1000);
        for _ in 0..3 {
            assert!(
                svc.resolve(dir.path(), "secret-abc123.attacker.com", false)
                    .await
                    .is_none()
            );
        }
        assert_eq!(fetcher.calls(), 0);
        assert!(
            !cache_dir(dir.path()).exists(),
            "no file for a refused host"
        );
    }

    /// An allowed origin is fetched once, cached on disk, and served from there afterwards.
    #[tokio::test]
    async fn an_allowed_host_fetches_once_and_is_then_served_from_the_cache() {
        let dir = tempfile::tempdir().unwrap();
        let fetcher = Counting::new(true, Duration::ZERO);
        let svc = service(&fetcher, 2, 1000);
        let first = svc
            .resolve(dir.path(), "webioo.com.tr", true)
            .await
            .unwrap();
        assert_eq!(first.content_type, "image/png");
        assert_eq!(fetcher.calls(), 1);
        // Served from disk now, even for a caller that is no longer allowed.
        let second = svc
            .resolve(dir.path(), "webioo.com.tr", false)
            .await
            .unwrap();
        assert_eq!(second, first);
        assert_eq!(fetcher.calls(), 1);

        // A tampered cache file is ignored rather than served.
        std::fs::write(
            cache_dir(dir.path()).join("webioo.com.tr.png"),
            b"<svg xmlns=\"http://www.w3.org/2000/svg\"><script/></svg>",
        )
        .unwrap();
        assert!(matches!(
            read_cache(dir.path(), "webioo.com.tr"),
            CacheHit::Empty
        ));
    }

    /// A failed lookup is remembered in memory only: no file per unique miss, bounded map.
    #[tokio::test]
    async fn misses_are_bounded_in_memory_and_write_no_files() {
        let dir = tempfile::tempdir().unwrap();
        let fetcher = Counting::new(false, Duration::ZERO);
        let svc = service(&fetcher, 2, usize::MAX);
        for i in 0..(MAX_MISSES + 50) {
            assert!(
                svc.resolve(dir.path(), &format!("n{i}.example.com"), true)
                    .await
                    .is_none()
            );
        }
        assert!(svc.misses.lock().len() <= MAX_MISSES);
        assert!(!cache_dir(dir.path()).exists());
        // A remembered miss is not looked up again.
        let before = fetcher.calls();
        let _ = svc
            .resolve(
                dir.path(),
                &format!("n{}.example.com", MAX_MISSES + 49),
                true,
            )
            .await;
        assert_eq!(fetcher.calls(), before);
    }

    /// One shared service: at most N lookups in flight and at most M lookups per minute.
    #[tokio::test]
    async fn lookups_are_limited_in_concurrency_and_per_minute() {
        let dir = tempfile::tempdir().unwrap();
        let fetcher = Counting::new(true, Duration::from_millis(60));
        let svc = Arc::new(service(&fetcher, 2, 1000));
        let mut tasks = Vec::new();
        for i in 0..8 {
            let svc = Arc::clone(&svc);
            let path = dir.path().to_path_buf();
            tasks.push(tokio::spawn(async move {
                svc.resolve(&path, &format!("site{i}.example.com"), true)
                    .await
            }));
        }
        for t in tasks {
            let _ = t.await;
        }
        assert!(fetcher.max_inflight.load(Ordering::SeqCst) <= 2);

        let counting = Counting::new(true, Duration::ZERO);
        let capped = service(&counting, 2, 3);
        let dir2 = tempfile::tempdir().unwrap();
        for i in 0..6 {
            let _ = capped
                .resolve(dir2.path(), &format!("cap{i}.example.com"), true)
                .await;
        }
        assert_eq!(counting.calls(), 3, "only 3 lookups started this minute");
    }

    /// The disk cache keeps at most N icons and M bytes; the least recently used go first.
    #[test]
    fn the_cache_is_capped_by_entries_and_bytes_with_lru_eviction() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path();
        let old = SystemTime::now() - Duration::from_secs(3600);
        for i in 0..8 {
            let p = cache.join(format!("s{i}.example.com.png"));
            std::fs::write(&p, PNG).unwrap();
            // s0 is the least recently used; s1 was used again just now.
            let used = if i == 1 {
                SystemTime::now()
            } else {
                old + Duration::from_secs(i)
            };
            let f = std::fs::File::options().write(true).open(&p).unwrap();
            f.set_times(std::fs::FileTimes::new().set_accessed(used))
                .unwrap();
        }
        std::fs::write(cache.join("old.example.com.miss"), b"").unwrap();
        enforce_cache_limits(cache, 5, u64::MAX);
        let left: Vec<String> = std::fs::read_dir(cache)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(left.len(), 5, "{left:?}");
        assert!(
            left.contains(&"s1.example.com.png".to_owned()),
            "recently used stays"
        );
        assert!(!left.contains(&"s0.example.com.png".to_owned()));
        enforce_cache_limits(cache, 500, 2 * PNG.len() as u64);
        assert_eq!(std::fs::read_dir(cache).unwrap().count(), 2, "byte cap");
    }

    #[test]
    fn same_site_filter_blocks_third_party_icon_urls() {
        assert!(same_site_https("https://webioo.com.tr/icon.png", "webioo.com.tr").is_some());
        assert!(same_site_https("https://cdn.webioo.com.tr/icon.png", "webioo.com.tr").is_some());
        assert!(
            same_site_https(
                "https://www.google.com/s2/favicons?domain=webioo.com.tr",
                "webioo.com.tr"
            )
            .is_none()
        );
        assert!(same_site_https("http://webioo.com.tr/icon.png", "webioo.com.tr").is_none());
    }
}
