import { Globe, Terminal, Wrench } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { BotAvatar, Button } from "ui";
import type { Bot, Grant, GrantTarget } from "../../api/types";
import { SiteFavicon } from "../../components/SiteFavicon";
import { botView } from "../../lib/botProfile";
import { humanLine } from "../../lib/humanError";
import { hostOf } from "../../lib/toolLabels";
import { useDaemon } from "../../state/DaemonContext";
import formStyles from "../../components/Form.module.css";
import styles from "./AllowedGrantsCard.module.css";

interface BotGrantRow {
  bot: Bot;
  grants: Grant[];
}

function siteDomain(target: GrantTarget): string | null {
  if (target.kind !== "scoped" || target.scope !== "origin") return null;
  return hostOf(target.pattern) ?? target.pattern.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
}

function GrantIcon({ target }: { target: GrantTarget }) {
  const domain = siteDomain(target);
  if (domain) {
    return <SiteFavicon domain={domain} size={18} allowed />;
  }
  if (target.kind === "scoped" && target.scope === "command") {
    return <Terminal size={16} aria-hidden="true" className={styles.kindIcon} />;
  }
  if (target.kind === "scoped") {
    return <Globe size={16} aria-hidden="true" className={styles.kindIcon} />;
  }
  return <Wrench size={16} aria-hidden="true" className={styles.kindIcon} />;
}

/**
 * Per-bot standing "Always allow" rules listed directly under Settings > Safety & permissions
 * so users can review or revoke any allowed site or action without enabling Advanced settings.
 */
export function AllowedGrantsCard() {
  const { t } = useTranslation();
  const { bots, client } = useDaemon();
  const [rows, setRows] = useState<BotGrantRow[]>([]);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!client) {
      setRows([]);
      return;
    }
    try {
      const next = await Promise.all(
        bots.map(async (bot) => ({
          bot,
          grants: await client.listGrants(bot.id)
        }))
      );
      setRows(next);
      setError(null);
    } catch (e) {
      setError(humanLine(e));
    }
  }, [client, bots]);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (botId: string, target: GrantTarget, key: string) => {
    if (!client) return;
    setBusyKey(key);
    setError(null);
    try {
      await client.revokeGrant(botId, target);
      await load();
    } catch (e) {
      setError(humanLine(e));
    } finally {
      setBusyKey(null);
    }
  };

  const describeGrant = (target: GrantTarget): string => {
    const domain = siteDomain(target);
    if (domain) {
      return t("settings.permissions.grantSite", { site: domain });
    }
    if (target.kind === "scoped") {
      return t("settings.permissions.grantScoped", {
        tool: target.tool,
        scope: t(`chat.approval.memory.target.${target.scope}`, {
          value: target.pattern,
          defaultValue: target.pattern
        })
      });
    }
    if (target.kind === "category") {
      return t("settings.permissions.grantCategory", { name: target.name });
    }
    return t("settings.permissions.grantTool", { name: target.name });
  };

  const anyGrants = rows.some((r) => r.grants.length > 0);

  return (
    <div className={styles.wrap} data-testid="allowed-grants-card">
      {error ? (
        <p className={formStyles.error} role="alert">
          {error}
        </p>
      ) : null}
      {!anyGrants ? (
        <p className={formStyles.hint} data-testid="allowed-grants-empty">
          {t("settingsModal.safety.allowedGrants.empty")}
        </p>
      ) : (
        rows
          .filter((r) => r.grants.length > 0)
          .map(({ bot, grants }) => {
            const view = botView(bot);
            return (
              <section key={bot.id} className={styles.botGroup} aria-label={view.name}>
                <header className={styles.botHead}>
                  <BotAvatar bot={view} size="sm" decorative />
                  <span className={styles.botName}>{view.name}</span>
                </header>
                <ul className={styles.list}>
                  {grants.map((g, idx) => {
                    const key = `${bot.id}:${idx}:${JSON.stringify(g.target)}`;
                    const label = describeGrant(g.target);
                    return (
                      <li key={key} className={styles.item}>
                        <div className={styles.itemMain}>
                          <GrantIcon target={g.target} />
                          <div className={styles.itemText}>
                            <span className={styles.itemTitle}>{label}</span>
                            <span className={styles.itemMeta}>
                              {[
                                g.computer ?? null,
                                g.inert ? t("settings.permissions.inertGrant") : null,
                                new Date(g.granted_at_ms).toLocaleDateString()
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </span>
                          </div>
                        </div>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busyKey === key}
                          aria-label={`${t("settings.permissions.revoke")} ${label}`}
                          data-testid="allowed-grant-revoke"
                          onClick={() => void revoke(bot.id, g.target, key)}
                        >
                          {t("settings.permissions.revoke")}
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })
      )}
    </div>
  );
}
