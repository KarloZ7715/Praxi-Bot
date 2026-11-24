import { Globe } from "lucide-react";
import { useEffect, useState } from "react";
import { mayFetchFavicon } from "../lib/faviconPolicy";
import { useOptionalDaemonClient } from "../state/DaemonContext";
import styles from "./SiteFavicon.module.css";

interface SiteFaviconProps {
  domain: string;
  size?: number;
  /**
   * The site is already allowed (a standing grant or an approved navigation). Only then is its
   * icon requested; otherwise (a pending approval card) the neutral tile is shown and nothing is
   * fetched.
   */
  allowed?: boolean;
}

const iconCache = new WeakMap<object, Map<string, Promise<string | null>>>();

function loadCachedFavicon(client: { faviconBlob(domain: string): Promise<Blob> }, domain: string): Promise<string | null> {
  let map = iconCache.get(client);
  if (!map) {
    map = new Map();
    iconCache.set(client, map);
  }
  const key = domain.toLowerCase();
  const existing = map.get(key);
  if (existing) return existing;
  const pending = client
    .faviconBlob(key)
    .then((blob) => (typeof URL.createObjectURL === "function" ? URL.createObjectURL(blob) : null))
    .catch(() => null);
  map.set(key, pending);
  return pending;
}

/**
 * Renders a small site badge: fetched from the daemon's local favicon cache
 * (`GET /v1/favicons/{domain}`), falling back gracefully to a crisp initial tile
 * or globe icon using theme tokens.
 */
export function SiteFavicon({ domain, size = 18, allowed = false }: SiteFaviconProps) {
  const client = useOptionalDaemonClient();
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
    if (!client || !domain || !mayFetchFavicon(allowed, domain)) {
      setSrc(null);
      return;
    }
    let active = true;
    void loadCachedFavicon(client, domain).then((url) => {
      if (active) setSrc(url);
    });
    return () => {
      active = false;
    };
  }, [client, domain, allowed]);

  const initial = domain.replace(/^www\./i, "").trim().charAt(0).toUpperCase();
  const boxStyle = { width: size, height: size };

  if (src && !failed) {
    return (
      <span className={styles.frame} style={boxStyle} aria-hidden="true">
        <img
          src={src}
          alt=""
          className={styles.img}
          width={size}
          height={size}
          draggable={false}
          onError={() => setFailed(true)}
        />
      </span>
    );
  }

  return (
    <span className={styles.fallback} style={boxStyle} aria-hidden="true">
      {initial && /[A-Z0-9]/.test(initial) ? (
        <span className={styles.letter}>{initial}</span>
      ) : (
        <Globe size={Math.max(12, size - 4)} />
      )}
    </span>
  );
}
