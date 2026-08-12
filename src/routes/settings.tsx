/**
 * Settings — credentials vault.
 *
 * This page used to be a write-only box: it saved `data/credentials.json` and
 * nothing in the system ever read it, so an operator could add a key, watch it
 * save, see it badged "Active", and collect exactly as much as before. Every
 * control here now runs against `src/utils/credential-vault.ts`, which is the
 * store the collectors actually resolve from.
 *
 * Three things the UI is required to keep honest:
 *
 *   1. A status badge reflects a measurement, not a save. "Verified" appears
 *      only after a live call to the provider returned, and the provider's own
 *      words are shown beneath it with the time of the call.
 *   2. Every provider states what it unlocks and which code path reads it. A
 *      credential nothing consumes says so in as many words.
 *   3. Instagram and Facebook are listed, because operators hold those
 *      credentials and asked to keep them, and are reported as inert. They can
 *      never reach "Verified" — see the note at the foot of credential-vault.ts
 *      for what the v1 scraper did with these exact rows.
 */

import { createFileRoute } from "@tanstack/react-router";
import { AppShell, PageHeader } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useState, useEffect, useMemo, useCallback } from "react";
import { createServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  CREDENTIAL_PROVIDERS,
  STATUS_LABELS,
  providerById,
  listCredentials,
  addCredential,
  deleteCredential,
  revealCredential,
  verifyCredential,
  readVault,
  writeVault,
  normaliseVault,
  type CredentialStatus,
  type ProviderCategory,
  type RedactedCredentialEntry,
  type CapabilityRow,
} from "@/utils/credential-vault";
import {
  Key,
  Shield,
  Plus,
  Trash2,
  Eye,
  EyeOff,
  Save,
  AlertTriangle,
  RefreshCw,
  CheckCircle2,
  XCircle,
  HelpCircle,
  Ban,
  Plug,
  ServerCog,
  Info,
} from "lucide-react";

/**
 * Backwards-compatible readers, retained because they were exported from this
 * route and other trees may import them. Both now go through the vault module
 * so there is one store and one set of rules, rather than two writers racing
 * over the same file.
 */
export const getCredentials = createServerFn({ method: "GET" }).handler(async () => readVault());

export const saveCredentials = createServerFn({ method: "POST" })
  .validator((data: any) => data)
  .handler(async ({ data }) => {
    try {
      await writeVault(normaliseVault(data));
      return { success: true };
    } catch (err: any) {
      console.error(err);
      return { success: false, error: err?.message ?? String(err) };
    }
  });

export const Route = createFileRoute("/settings")({
  head: () => ({ meta: [{ title: "Settings — Sentinel AI" }] }),
  component: SettingsPage,
});

// ─── Presentation helpers ──────────────────────────────────────────────────

const STATUS_STYLE: Record<CredentialStatus, string> = {
  verified: "border-emerald-500/30 bg-emerald-500/10 text-emerald-500",
  unverified: "border-amber-500/30 bg-amber-500/10 text-amber-500",
  rejected: "border-red-500/30 bg-red-500/10 text-red-500",
  unusable: "border-muted-foreground/30 bg-muted text-muted-foreground",
};

function StatusIcon({ status }: { status: CredentialStatus }) {
  if (status === "verified") return <CheckCircle2 className="size-3" />;
  if (status === "rejected") return <XCircle className="size-3" />;
  if (status === "unusable") return <Ban className="size-3" />;
  return <HelpCircle className="size-3" />;
}

const CATEGORY_LABELS: Record<ProviderCategory, string> = {
  social: "Social collection",
  osint: "OSINT / recon",
  gis: "GIS layers",
  llm: "Open-source LLM",
  blocked: "Not collectable",
};

/** "Never" is a display string, not data — the store keeps null. */
function formatWhen(iso: string | null): string {
  if (!iso) return "Never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "Never";
  return new Date(t).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

// ─── Page ──────────────────────────────────────────────────────────────────

function SettingsPage() {
  const [vault, setVault] = useState<Record<string, RedactedCredentialEntry[]>>({});
  const [capabilities, setCapabilities] = useState<CapabilityRow[]>([]);
  const [storagePath, setStoragePath] = useState("./data/credentials.json");
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [busyEntry, setBusyEntry] = useState<string | null>(null);
  /** Revealed secrets, fetched one at a time and held only in component state. */
  const [revealed, setRevealed] = useState<Record<string, string>>({});

  const [providerId, setProviderId] = useState(CREDENTIAL_PROVIDERS[0].id);
  const [label, setLabel] = useState("");
  const [username, setUsername] = useState("");
  const [secret, setSecret] = useState("");

  const provider = useMemo(() => providerById(providerId), [providerId]);

  const load = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const data = (await listCredentials()) as unknown as {
        vault: Record<string, RedactedCredentialEntry[]>;
        capabilities: CapabilityRow[];
        storagePath: string;
      };
      setVault(data.vault ?? {});
      setCapabilities(data.capabilities ?? []);
      setStoragePath(data.storagePath ?? "./data/credentials.json");
      // A revealed secret belongs to the row that was on screen; drop them all
      // on reload rather than risk showing a stale value against a new row.
      setRevealed({});
    } catch (err: any) {
      // Surfaced, never swallowed into an empty vault — "no credentials" and
      // "could not read the credentials" are different facts.
      setLoadError(err?.message ?? String(err));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!provider) return;
    if (!secret.trim()) {
      setFormError(`${provider.secretLabel} is required.`);
      return;
    }
    if (provider.identifierRequired && !username.trim()) {
      setFormError(`${provider.identifierLabel} is required.`);
      return;
    }

    setIsSaving(true);
    try {
      await addCredential({
        data: { provider: providerId, label: label.trim(), username: username.trim(), secret },
      });
      setLabel("");
      setUsername("");
      setSecret("");
      await load();
      toast.success(
        provider.collectable
          ? `${provider.label} credential stored as Unverified. Run Verify to test it against the provider.`
          : `${provider.label} credential stored. It is inert — no collector reads it.`,
      );
    } catch (err: any) {
      setFormError(err?.message ?? String(err));
    } finally {
      setIsSaving(false);
    }
  };

  const handleVerify = async (prov: string, id: string) => {
    setBusyEntry(id);
    try {
      const res = (await verifyCredential({ data: { provider: prov, id } })) as unknown as {
        result: { status: CredentialStatus; detail: string };
      };
      await load();
      const { status, detail } = res.result;
      if (status === "verified") toast.success(detail);
      else if (status === "rejected") toast.error(detail);
      else toast.warning(detail);
    } catch (err: any) {
      toast.error(err?.message ?? String(err));
    } finally {
      setBusyEntry(null);
    }
  };

  const handleDelete = async (prov: string, id: string) => {
    setBusyEntry(id);
    try {
      await deleteCredential({ data: { provider: prov, id } });
      await load();
      toast.success("Credential removed from the vault.");
    } catch (err: any) {
      toast.error(err?.message ?? String(err));
    } finally {
      setBusyEntry(null);
    }
  };

  const toggleReveal = async (prov: string, id: string) => {
    if (revealed[id] !== undefined) {
      setRevealed((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      return;
    }
    setBusyEntry(id);
    try {
      const res = (await revealCredential({ data: { provider: prov, id } })) as unknown as {
        secret: string;
      };
      setRevealed((prev) => ({ ...prev, [id]: res.secret }));
    } catch (err: any) {
      toast.error(err?.message ?? String(err));
    } finally {
      setBusyEntry(null);
    }
  };

  const storedGroups = useMemo(
    () =>
      Object.entries(vault)
        .filter(([, items]) => items.length > 0)
        .sort(([a], [b]) => a.localeCompare(b)),
    [vault],
  );

  const liveCount = capabilities.filter((c) => c.collectable && c.configured).length;
  const gatedCount = capabilities.filter((c) => c.collectable && !c.configured).length;

  return (
    <AppShell>
      <PageHeader
        title="Settings"
        description="Credentials vault. Keys stored here are read by the collectors listed against each provider — environment variables still take precedence."
        badge={
          <Badge variant="outline" className="gap-1.5 border-primary/30 bg-primary/5 text-primary">
            <Shield className="size-3.5" />
            Security Vault
          </Badge>
        }
      />

      {loadError && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/5 p-3 text-xs text-red-500">
          <XCircle className="mt-0.5 size-4 shrink-0" />
          <div>
            <span className="font-semibold">The vault could not be read.</span>{" "}
            <span className="text-muted-foreground">
              {loadError} — this is a read failure, not an empty vault. Nothing below should be
              taken as the configured state until it resolves.
            </span>
          </div>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        {/* ── LEFT: capability matrix + stored credentials ── */}
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Plug className="size-4 text-primary" />
                  Collection capability
                </CardTitle>
                <CardDescription className="text-xs">
                  Computed from what actually resolves, not declared. {liveCount} of{" "}
                  {liveCount + gatedCount} credential-gated collectors are configured
                  {gatedCount > 0 ? `; ${gatedCount} still blocked.` : "."}
                </CardDescription>
              </div>
              <Button
                size="icon"
                variant="ghost"
                className="size-8"
                onClick={() => void load()}
                disabled={isLoading}
                title="Re-read the vault and recompute capability"
              >
                <RefreshCw className={`size-4 ${isLoading ? "animate-spin" : ""}`} />
              </Button>
            </CardHeader>
            <CardContent className="space-y-2">
              {capabilities.length === 0 && !isLoading ? (
                <p className="py-4 text-center text-xs text-muted-foreground">
                  Capability matrix unavailable.
                </p>
              ) : (
                capabilities.map((cap) => (
                  <div
                    key={cap.providerId}
                    className="rounded-lg border border-border/60 bg-card/50 p-3 text-xs"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-foreground">{cap.label}</span>
                      <Badge
                        variant="outline"
                        className="h-4 px-1.5 text-[9px] text-muted-foreground"
                      >
                        {CATEGORY_LABELS[cap.category]}
                      </Badge>
                      {!cap.collectable ? (
                        <Badge
                          variant="outline"
                          className={`h-4 gap-1 px-1.5 text-[9px] ${STATUS_STYLE.unusable}`}
                        >
                          <Ban className="size-2.5" />
                          Not collectable
                        </Badge>
                      ) : cap.configured ? (
                        <Badge
                          variant="outline"
                          className={`h-4 gap-1 px-1.5 text-[9px] ${STATUS_STYLE.verified}`}
                        >
                          <CheckCircle2 className="size-2.5" />
                          Configured via {cap.source}
                        </Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className={`h-4 gap-1 px-1.5 text-[9px] ${STATUS_STYLE.rejected}`}
                        >
                          <XCircle className="size-2.5" />
                          No credential — collection blocked
                        </Badge>
                      )}
                    </div>
                    <p className="mt-1.5 leading-relaxed text-muted-foreground">
                      {cap.collectable ? cap.unlocks : cap.blockedReason}
                    </p>
                    <p className="mt-1 font-mono text-[10px] text-muted-foreground/70">
                      Read by: {cap.consumedBy}
                    </p>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Key className="size-4 text-primary" />
                Stored credentials
              </CardTitle>
              <CardDescription className="text-xs">
                Secrets are masked. Revealing one is a separate server call against that entry
                alone — the page never loads the full key set.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {isLoading ? (
                <div className="flex items-center justify-center py-10">
                  <RefreshCw className="size-6 animate-spin text-primary" />
                </div>
              ) : storedGroups.length === 0 ? (
                <div className="p-8 text-center text-xs text-muted-foreground">
                  No credentials in the vault. Collectors fall back to environment variables, which
                  is the durable path on the deployed container.
                </div>
              ) : (
                storedGroups.map(([prov, items]) => {
                  const def = providerById(prov);
                  return (
                    <div key={prov} className="space-y-2">
                      <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        <span
                          className={`size-1.5 rounded-full ${def?.collectable === false ? "bg-muted-foreground" : "bg-primary"}`}
                        />
                        {def?.label ?? prov} ({items.length})
                      </h4>

                      {def?.collectable === false && (
                        <p className="rounded border border-amber-500/20 bg-amber-500/5 p-2 text-[10px] leading-relaxed text-amber-600 dark:text-amber-400">
                          <AlertTriangle className="mr-1 inline size-3" />
                          {def.blockedReason}
                        </p>
                      )}

                      <div className="grid gap-2">
                        {items.map((item) => (
                          <div
                            key={item.id}
                            className="rounded-lg border border-primary/10 bg-card p-3 text-xs transition-all hover:border-primary/20"
                          >
                            <div className="flex flex-wrap items-start justify-between gap-3">
                              <div className="min-w-[220px] space-y-1">
                                <div className="flex items-center gap-1.5 font-semibold text-foreground">
                                  {item.label}
                                  <Badge
                                    variant="outline"
                                    className={`h-4 gap-1 px-1.5 text-[9px] font-medium ${STATUS_STYLE[item.status]}`}
                                  >
                                    <StatusIcon status={item.status} />
                                    {STATUS_LABELS[item.status]}
                                  </Badge>
                                </div>

                                {item.username && (
                                  <div className="text-[10px] text-muted-foreground">
                                    {def?.identifierLabel ?? "ID / Account"}:{" "}
                                    <span className="font-mono text-foreground">
                                      {item.username}
                                    </span>
                                  </div>
                                )}

                                <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                                  {def?.secretLabel ?? "Secret"}:
                                  <span className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">
                                    {revealed[item.id] !== undefined
                                      ? revealed[item.id]
                                      : `${item.secretMask}${item.secretTail ? ` …${item.secretTail}` : ""}`}
                                    <button
                                      type="button"
                                      onClick={() => void toggleReveal(item.provider, item.id)}
                                      disabled={busyEntry === item.id}
                                      className="ml-1 hover:text-primary disabled:opacity-50"
                                      title={
                                        revealed[item.id] !== undefined
                                          ? "Hide"
                                          : "Fetch and reveal this secret"
                                      }
                                    >
                                      {revealed[item.id] !== undefined ? (
                                        <EyeOff className="size-3" />
                                      ) : (
                                        <Eye className="size-3" />
                                      )}
                                    </button>
                                  </span>
                                </div>
                              </div>

                              <div className="flex items-center gap-2">
                                <div className="text-right text-[10px] leading-relaxed text-muted-foreground">
                                  <div>Last used: {formatWhen(item.lastUsed)}</div>
                                  <div>Verified: {formatWhen(item.verifiedAt)}</div>
                                </div>
                                {def?.verifiable && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-7 gap-1.5 text-[10px]"
                                    onClick={() => void handleVerify(item.provider, item.id)}
                                    disabled={busyEntry === item.id}
                                  >
                                    <ServerCog
                                      className={`size-3 ${busyEntry === item.id ? "animate-spin" : ""}`}
                                    />
                                    Verify
                                  </Button>
                                )}
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="size-8 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                  onClick={() => void handleDelete(item.provider, item.id)}
                                  disabled={busyEntry === item.id}
                                >
                                  <Trash2 className="size-4" />
                                </Button>
                              </div>
                            </div>

                            {item.verifyDetail && (
                              <p
                                className={`mt-2 border-t border-border/50 pt-2 text-[10px] leading-relaxed ${
                                  item.status === "verified"
                                    ? "text-emerald-500"
                                    : item.status === "rejected"
                                      ? "text-red-500"
                                      : "text-muted-foreground"
                                }`}
                              >
                                {item.verifyDetail}
                              </p>
                            )}
                            {!item.verifyDetail && item.status === "unverified" && (
                              <p className="mt-2 border-t border-border/50 pt-2 text-[10px] leading-relaxed text-muted-foreground">
                                Stored but never tested. Nothing here claims this credential works —
                                run Verify to make a live call to the provider.
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>
        </div>

        {/* ── RIGHT: add form + storage policy ── */}
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Plus className="size-4 text-primary" />
                Add credentials
              </CardTitle>
              <CardDescription className="text-xs">
                Register an integration target. Nothing is marked working until it is verified.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleAdd} className="space-y-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-muted-foreground">
                    Target platform
                  </label>
                  <select
                    className="flex h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    value={providerId}
                    onChange={(e) => {
                      setProviderId(e.target.value);
                      setFormError(null);
                    }}
                  >
                    {(Object.keys(CATEGORY_LABELS) as ProviderCategory[]).map((cat) => {
                      const inCat = CREDENTIAL_PROVIDERS.filter((p) => p.category === cat);
                      if (inCat.length === 0) return null;
                      return (
                        <optgroup key={cat} label={CATEGORY_LABELS[cat]}>
                          {inCat.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.label}
                            </option>
                          ))}
                        </optgroup>
                      );
                    })}
                  </select>
                </div>

                {provider && (
                  <div
                    className={`space-y-1.5 rounded-md border p-2.5 text-[10px] leading-relaxed ${
                      provider.collectable
                        ? "border-primary/20 bg-primary/5 text-muted-foreground"
                        : "border-amber-500/30 bg-amber-500/5 text-amber-600 dark:text-amber-400"
                    }`}
                  >
                    {provider.collectable ? (
                      <>
                        <p className="flex gap-1.5">
                          <Info className="mt-px size-3 shrink-0 text-primary" />
                          <span>
                            <span className="font-semibold text-foreground">Unlocks:</span>{" "}
                            {provider.unlocks}
                          </span>
                        </p>
                        <p>
                          <span className="font-semibold text-foreground">Read by:</span>{" "}
                          {provider.consumedBy}
                        </p>
                        <p>
                          <span className="font-semibold text-foreground">Obtain:</span>{" "}
                          {provider.howTo}
                        </p>
                        {(provider.envSecret || provider.envIdentifier) && (
                          <p>
                            <span className="font-semibold text-foreground">Overridden by:</span>{" "}
                            <span className="font-mono">
                              {[provider.envIdentifier, provider.envSecret]
                                .filter(Boolean)
                                .join(", ")}
                            </span>{" "}
                            — if set in the environment, that value wins over anything stored here.
                          </p>
                        )}
                      </>
                    ) : (
                      <p className="flex gap-1.5">
                        <Ban className="mt-px size-3 shrink-0" />
                        <span>{provider.blockedReason}</span>
                      </p>
                    )}
                  </div>
                )}

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-muted-foreground">
                    Identifier label
                  </label>
                  <Input
                    placeholder="e.g. Primary scraper token"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-muted-foreground">
                    {provider?.identifierLabel ?? "Username / account name"}
                    {provider && !provider.identifierRequired && (
                      <span className="ml-1 font-normal text-muted-foreground/70">(optional)</span>
                    )}
                  </label>
                  <Input
                    placeholder={provider?.identifierHint ?? "Username or key name"}
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-muted-foreground">
                    {provider?.secretLabel ?? "Secret token / password"}
                  </label>
                  <Input
                    type="password"
                    placeholder={provider?.secretHint ?? "API secret or password"}
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                  />
                </div>

                {formError && (
                  <p className="flex items-start gap-1.5 text-[11px] text-red-500">
                    <XCircle className="mt-px size-3.5 shrink-0" />
                    {formError}
                  </p>
                )}

                <Button type="submit" className="w-full gap-2 text-xs" disabled={isSaving}>
                  <Save className="size-4" />
                  {isSaving ? "Saving…" : "Save credential"}
                </Button>
              </form>
            </CardContent>
          </Card>

          <Card className="border-amber-500/20 bg-amber-500/5">
            <CardContent className="flex gap-3 p-4 text-xs text-amber-800 dark:text-amber-300">
              <AlertTriangle className="size-5 shrink-0 text-amber-600 dark:text-amber-400" />
              <div className="space-y-2">
                <span className="font-semibold">Storage policy — read this before a demo</span>
                <p className="leading-relaxed text-muted-foreground">
                  Secrets are written in cleartext to <span className="font-mono">{storagePath}</span>,
                  restricted to owner-only where the platform supports it. That directory is
                  excluded from the container build and is not a mounted volume, so{" "}
                  <span className="font-semibold text-foreground">
                    a credential added here does not survive a revision restart or a scale-to-zero
                  </span>
                  . For anything that must persist, set the environment variable named against the
                  provider — on the deployed app those arrive from Key Vault through the container
                  app's managed identity, and they take precedence over this file.
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}
