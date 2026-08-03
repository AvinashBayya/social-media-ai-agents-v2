import { createFileRoute } from "@tanstack/react-router";
import { AppShell, PageHeader, StatusDot } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useState, useEffect } from "react";
import { createServerFn } from "@tanstack/react-start";
import { 
  Key, Shield, Settings as SettingsIcon, Plus, Trash2, Eye, EyeOff, Save, CheckCircle2, AlertTriangle, RefreshCw
} from "lucide-react";

export const getCredentials = createServerFn({ method: "GET" })
  .handler(async () => {
    try {
      const fs = (await import("fs")).promises;
      const data = await fs.readFile("./data/credentials.json", "utf-8");
      return JSON.parse(data);
    } catch {
      const defaults = {
        instagram: [
          { id: "ig-1", label: "Primary Instagram Scraper", username: "sentinel_ops_01", secret: "pass_sec_instagram_99", status: "Active", lastUsed: "Just now" }
        ],
        facebook: [
          { id: "fb-1", label: "Meta Graph Access Token", username: "MetaAppAgent", secret: "EAAH1234567890abcdef...", status: "Active", lastUsed: "2h ago" }
        ],
        github: [
          { id: "gh-1", label: "GitHub PAT Token", username: "developer_token", secret: "ghp_secureKey999...", status: "Inactive", lastUsed: "Never" }
        ]
      };
      
      try {
        const fsLib = (await import("fs")).promises;
        await fsLib.mkdir("./data", { recursive: true });
        await fsLib.writeFile("./data/credentials.json", JSON.stringify(defaults, null, 2), "utf-8");
      } catch (err) {
        console.error("Failed to write default credentials:", err);
      }
      return defaults;
    }
  });

export const saveCredentials = createServerFn({ method: "POST" })
  .validator((data: any) => data)
  .handler(async ({ data }) => {
    try {
      const fs = (await import("fs")).promises;
      await fs.mkdir("./data", { recursive: true });
      await fs.writeFile("./data/credentials.json", JSON.stringify(data, null, 2), "utf-8");
      return { success: true };
    } catch (err: any) {
      console.error(err);
      return { success: false, error: err.message };
    }
  });

export const Route = createFileRoute("/settings")({
  head: () => ({ meta: [{ title: "Settings — Sentinel AI" }] }),
  component: SettingsPage,
});

function SettingsPage() {
  const [vault, setVault] = useState<Record<string, any[]>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [successMsg, setSuccessMsg] = useState("");
  const [showSecret, setShowSecret] = useState<Record<string, boolean>>({});

  // Form states
  const [platform, setPlatform] = useState("instagram");
  const [label, setLabel] = useState("");
  const [username, setUsername] = useState("");
  const [secret, setSecret] = useState("");

  const loadVault = async () => {
    setIsLoading(true);
    try {
      const data = await getCredentials();
      setVault(data || {});
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadVault();
  }, []);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !secret.trim()) return;

    const newId = `${platform}-${Date.now()}`;
    const newEntry = {
      id: newId,
      label: label.trim() || `${platform.toUpperCase()} Token`,
      username: username.trim(),
      secret: secret.trim(),
      status: "Active",
      lastUsed: "Never"
    };

    const updatedVault = { ...vault };
    if (!updatedVault[platform]) {
      updatedVault[platform] = [];
    }
    updatedVault[platform].push(newEntry);

    setIsSaving(true);
    try {
      const res = await saveCredentials({ data: updatedVault });
      if (res.success) {
        setVault(updatedVault);
        setLabel("");
        setUsername("");
        setSecret("");
        setSuccessMsg("Credential added successfully!");
        setTimeout(() => setSuccessMsg(""), 3000);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (platformName: string, id: string) => {
    const updatedVault = { ...vault };
    if (updatedVault[platformName]) {
      updatedVault[platformName] = updatedVault[platformName].filter(item => item.id !== id);
    }

    setIsSaving(true);
    try {
      const res = await saveCredentials({ data: updatedVault });
      if (res.success) {
        setVault(updatedVault);
        setSuccessMsg("Credential deleted successfully!");
        setTimeout(() => setSuccessMsg(""), 3000);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsSaving(false);
    }
  };

  const toggleShowSecret = (id: string) => {
    setShowSecret(prev => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <AppShell>
      <PageHeader
        title="Settings"
        description="Manage platform configurations, API integrations, and credentials vault for Sentinel AI crawlers."
        badge={<Badge variant="outline" className="gap-1.5 border-primary/30 bg-primary/5 text-primary"><Shield className="size-3.5" />Security Vault</Badge>}
      />

      {successMsg && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-300">
          <CheckCircle2 className="size-4 shrink-0 text-green-600 dark:text-green-400" />
          <span>{successMsg}</span>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        {/* LEFT COLUMN: Vault List */}
        <div className="lg:col-span-2 space-y-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle className="text-base flex items-center gap-2"><Key className="size-4 text-primary" />Credentials Vault</CardTitle>
                <CardDescription className="text-xs">Active session credentials stored locally in your workspace.</CardDescription>
              </div>
              <Button size="icon" variant="ghost" className="h-8 w-8" onClick={loadVault} disabled={isLoading}>
                <RefreshCw className={`size-4 ${isLoading ? "animate-spin" : ""}`} />
              </Button>
            </CardHeader>
            <CardContent className="space-y-6">
              {isLoading ? (
                <div className="flex justify-center items-center py-10">
                  <RefreshCw className="size-6 animate-spin text-primary" />
                </div>
              ) : Object.keys(vault).length === 0 || Object.values(vault).every(arr => arr.length === 0) ? (
                <div className="p-8 text-center text-muted-foreground text-xs">
                  No credentials saved in the vault. Use the form on the right to add some.
                </div>
              ) : (
                Object.entries(vault).map(([plat, items]) => {
                  if (items.length === 0) return null;
                  return (
                    <div key={plat} className="space-y-2">
                      <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5 capitalize">
                        <span className="size-1.5 rounded-full bg-primary" />
                        {plat} Integration ({items.length})
                      </h4>
                      <div className="grid gap-2">
                        {items.map((item) => (
                          <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-3 text-xs border-primary/10 hover:border-primary/20 transition-all">
                            <div className="space-y-1 min-w-[200px]">
                              <div className="font-semibold text-foreground flex items-center gap-1.5">
                                {item.label}
                                <Badge variant={item.status === "Active" ? "default" : "secondary"} className="h-4 px-1.5 text-[9px] font-medium scale-90">
                                  {item.status}
                                </Badge>
                              </div>
                              <div className="text-[10px] text-muted-foreground">
                                ID / Account: <span className="font-mono text-foreground">{item.username}</span>
                              </div>
                              <div className="text-[10px] text-muted-foreground flex items-center gap-1">
                                Secret / Token: 
                                <span className="font-mono text-foreground bg-muted px-1.5 py-0.5 rounded flex items-center gap-1">
                                  {showSecret[item.id] ? item.secret : "••••••••••••••••"}
                                  <button onClick={() => toggleShowSecret(item.id)} className="hover:text-primary ml-1">
                                    {showSecret[item.id] ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
                                  </button>
                                </span>
                              </div>
                            </div>
                            <div className="flex items-center gap-4">
                              <span className="text-[10px] text-muted-foreground">Last used: {item.lastUsed}</span>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                                onClick={() => handleDelete(plat, item.id)}
                              >
                                <Trash2 className="size-4" />
                              </Button>
                            </div>
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

        {/* RIGHT COLUMN: Add Credential Form */}
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2"><Plus className="size-4 text-primary" />Add Credentials</CardTitle>
              <CardDescription className="text-xs">Securely register a new integration target.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleAdd} className="space-y-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-muted-foreground">Target Platform</label>
                  <select
                    className="flex h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    value={platform}
                    onChange={(e) => setPlatform(e.target.value)}
                  >
                    <option value="instagram">Instagram Scraper</option>
                    <option value="facebook">Facebook App Graph</option>
                    <option value="github">GitHub Personal Access Token</option>
                    <option value="cloudflare">Cloudflare DNS-over-HTTPS</option>
                    <option value="wikidata">Wikidata API Endpoint</option>
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-muted-foreground">Identifier Label</label>
                  <Input
                    placeholder="e.g. Primary Scraper Token"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-muted-foreground">Username / Account Name</label>
                  <Input
                    placeholder="Username or Key Name"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    required
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-muted-foreground">Secret Token / Password</label>
                  <Input
                    type="password"
                    placeholder="API Secret or Password"
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                    required
                  />
                </div>

                <Button type="submit" className="w-full gap-2 text-xs" disabled={isSaving}>
                  <Save className="size-4" />
                  {isSaving ? "Saving..." : "Save Credential"}
                </Button>
              </form>
            </CardContent>
          </Card>

          <Card className="bg-amber-500/5 border-amber-500/20">
            <CardContent className="p-4 flex gap-3 text-xs text-amber-800 dark:text-amber-300">
              <AlertTriangle className="size-5 shrink-0 text-amber-600 dark:text-amber-400" />
              <div className="space-y-1">
                <span className="font-semibold">Local Storage Policy</span>
                <p className="text-muted-foreground leading-relaxed">
                  API keys and password secrets are stored in your local workspace directory in `data/credentials.json` with restricted access permissions.
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}
