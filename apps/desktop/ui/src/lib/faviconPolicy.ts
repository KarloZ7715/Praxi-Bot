/**
 * A favicon is fetched from the network only for a site the owner already allowed (a standing
 * grant listed in Settings, or a navigation they approved). The host of a pending approval card
 * is chosen by the model, so it must never trigger a lookup: the daemon would resolve and request
 * a name an injected prompt can fill with data. Pending cards show the neutral letter / globe tile.
 */
export function mayFetchFavicon(allowed: boolean | undefined, domain: string): boolean {
  return allowed === true && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain.trim());
}
