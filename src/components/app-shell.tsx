import { useState, useEffect, useRef, ReactNode } from "react";
import { useRouterState } from "@tanstack/react-router";
import {
  LayoutDashboard,
  Radio,
  Search,
  Users,
  Bookmark,
  Share2,
  Newspaper,
  Globe2,
  Image as ImageIcon,
  Video,
  UserSearch,
  Network,
  GitBranch,
  Clock,
  LineChart,
  TrendingUp,
  User,
  FileBarChart,
  Bell,
  ShieldAlert,
  Map,
  Database,
  Bot,
  Cpu,
  ListChecks,
  Download,
  Settings as SettingsIcon,
  Command as CommandIcon,
  Sparkles,
  ChevronDown,
  CircleUser,
  FolderLock,
  Radar,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarProvider,
  SidebarTrigger,
  SidebarInset,
  SidebarFooter,
} from "@/components/ui/sidebar";
import { LanguageSwitcher } from "@/components/language-switcher";
import { SidebarNav, type NavGroup } from "@/components/sidebar-nav";
import { useT } from "@/i18n/i18n-context";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getActiveTarget, setActiveTarget } from "@/utils/active-target";


const NAV_GROUPS: NavGroup[] = [
  {
    label: "Module 1",
    items: [
      { title: "Dashboard", to: "/", icon: LayoutDashboard },
      { title: "Tasks", to: "/tasks", icon: ListChecks },
      { title: "Subjects", to: "/subjects", icon: Users },
      { title: "Data Sources", to: "/sources", icon: Database },
      { title: "AI Agents", to: "/agents", icon: Bot },
      { title: "Settings", to: "/settings", icon: SettingsIcon },
    ],
  },
  {
    label: "Module 2",
    items: [
      { title: "OSINT Intelligence", to: "/osint", icon: Globe2 },
      { title: "Recon & Dorks", to: "/recon", icon: Radar },
      { title: "News Intelligence", to: "/news", icon: Newspaper },
      { title: "Knowledge Graph", to: "/graph", icon: Network },
      { title: "Network Analysis", to: "/network", icon: GitBranch },
      { title: "Timeline Explorer", to: "/timeline", icon: Clock },
      { title: "Entity Explorer", to: "/entities", icon: UserSearch },
    ],
  },
  {
    label: "Module 3",
    items: [
      { title: "Social Intelligence", to: "/social", icon: Share2 },
      { title: "Live Monitoring", to: "/live", icon: Radio },
      { title: "Watchlists", to: "/watchlists", icon: Bookmark },
      { title: "Crawler Status", to: "/crawlers", icon: Cpu },
      { title: "Sentiment", to: "/sentiment", icon: LineChart },
      { title: "Trends", to: "/trends", icon: TrendingUp },
    ],
  },
  {
    label: "Module 4",
    items: [
      { title: "Image Intelligence", to: "/images", icon: ImageIcon },
      { title: "Video Intelligence", to: "/videos", icon: Video },
    ],
  },
  {
    label: "Module 5",
    items: [
      { title: "GIS Intelligence", to: "/gis", icon: Map },
      { title: "AI Investigations", to: "/investigations", icon: Search },
      { title: "Evidence Vault", to: "/vault", icon: FolderLock },
      { title: "Reports", to: "/reports", icon: FileBarChart },
      { title: "Alert Center", to: "/alerts", icon: Bell },
      { title: "Threat Intel", to: "/threats", icon: ShieldAlert },
      { title: "Exports", to: "/exports", icon: Download },
    ],
  },
];

function AppSidebar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const t = useT();
  return (
    <Sidebar collapsible="icon" className="border-r border-[#263548] bg-[#0F172A]">
      <SidebarHeader className="border-b border-[#263548] bg-[#0F172A]/50 py-3">
        <div className="flex items-center gap-2 px-2 py-1.5">
          <div className="grid size-8 place-items-center rounded bg-[#1A2332] text-[#06B6D4] border border-[#263548]">
            <ShieldAlert className="size-4" />
          </div>
          <div className="flex flex-col leading-none group-data-[collapsible=icon]:hidden">
            <span
              data-no-translate
              className="text-xs font-bold uppercase tracking-wider text-[#F3F4F6]"
            >
              Sentinel AI
            </span>
            <span className="text-[9px] uppercase tracking-widest text-[#94A3B8] font-mono mt-0.5">
              {t("Defence Command Center")}
            </span>
          </div>
        </div>
        <div
          className="mx-2 mt-1.5 flex items-center justify-between rounded border border-[#263548] bg-[#111827] px-2 py-1 text-[10px] text-[#94A3B8] font-mono group-data-[collapsible=icon]:hidden"
        >
          <span className="flex items-center gap-1.5">
            <span className="size-1.5 rounded-full bg-[#22C55E] animate-pulse" />
            {t("Global Ops · Tier 1")}
          </span>
          <span className="text-[#3B82F6] font-bold">{t("Secure").toUpperCase()}</span>
        </div>
      </SidebarHeader>
      <SidebarContent className="bg-[#0F172A] px-2 py-2">
        <SidebarNav groups={NAV_GROUPS} pathname={pathname} />
      </SidebarContent>
      <SidebarFooter className="border-t border-[#263548] bg-[#0F172A] px-2 py-2">
        <LanguageSwitcher />
      </SidebarFooter>
    </Sidebar>
  );
}

function TopBar() {
  const [timeStr, setTimeStr] = useState("");
  const [searchVal, setSearchVal] = useState("");
  const [activeTarget, setActiveTargetState] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const t = useT();

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      setTimeStr(now.toISOString().replace("T", " ").substring(0, 19) + " UTC");
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);

    const initialTarget = getActiveTarget();
    setActiveTargetState(initialTarget);
    setSearchVal(initialTarget);

    const handleTargetChange = (e: any) => {
      if (e.detail) {
        setActiveTargetState(e.detail);
        setSearchVal(e.detail);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };

    window.addEventListener("sentinel_target_changed", handleTargetChange);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      clearInterval(interval);
      window.removeEventListener("sentinel_target_changed", handleTargetChange);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  const handleGlobalSearch = () => {
    if (searchVal.trim()) {
      setActiveTarget(searchVal.trim());
    }
  };

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-[#263548] bg-[#0B1220] px-4 font-mono text-xs text-[#F3F4F6]">
      <div className="flex items-center gap-3">
        <SidebarTrigger className="text-[#94A3B8] hover:text-[#F3F4F6] border border-[#263548] bg-[#111827] size-8 rounded" />

        <div className="hidden lg:flex items-center gap-2 border-r border-[#263548] pr-4 text-[11px]">
          <span className="text-[#94A3B8]">{t("System").toUpperCase()}:</span>
          <span className="flex items-center gap-1 font-bold text-[#22C55E]">
            <span className="size-1.5 rounded-full bg-[#22C55E] animate-pulse" />
            {t("Nominal").toUpperCase()}
          </span>
        </div>
      </div>

      {/* Global Target Acquisition Search Bar */}
      <div className="flex items-center gap-2 flex-1 max-w-xl mx-2">
        <div className="relative w-full flex items-center">
          <Search className="absolute left-2.5 size-3.5 text-[#10B981]" />
          <Input
            ref={inputRef}
            value={searchVal}
            onChange={(e) => setSearchVal(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleGlobalSearch()}
            placeholder={t("Global Target Acquisition (Ctrl+K)...").toUpperCase()}
            className="h-8 pl-8 pr-20 bg-[#111827] border-[#263548] text-xs font-mono text-[#F3F4F6] placeholder:text-[#64748B] focus:border-[#10B981] rounded"
          />
          <Button
            size="sm"
            onClick={handleGlobalSearch}
            className="absolute right-1 h-6 px-2.5 text-[10px] font-mono bg-[#10B981] hover:bg-[#059669] text-black font-bold rounded"
          >
            {t("Execute").toUpperCase()}
          </Button>
        </div>
        {activeTarget && (
          <Badge className="hidden md:flex items-center gap-1.5 bg-[#10B981]/10 text-[#10B981] border-[#10B981]/30 font-mono text-[10px] shrink-0 h-7 px-2">
            <span className="size-1.5 rounded-full bg-[#10B981] animate-ping" />
            {t("Target").toUpperCase()}:{" "}
            <span data-no-translate>{activeTarget.toUpperCase()}</span>
          </Badge>
        )}
      </div>

      {/* Live UTC Clock */}
      <div className="ml-auto hidden sm:flex items-center gap-3 text-[11px] font-mono text-[#94A3B8] border-r border-[#263548] pr-4 shrink-0">
        <span data-no-translate>{timeStr}</span>
      </div>

      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" className="relative size-8 text-[#94A3B8] hover:text-[#F3F4F6] border border-[#263548] bg-[#111827] rounded">
          <Bell className="size-3.5" />
          <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-[#EF4444] animate-pulse" />
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-8 gap-2 pr-2 border border-[#263548] bg-[#111827] hover:bg-[#1A2332] text-[#F3F4F6] rounded">
              <span className="grid size-5 place-items-center rounded bg-[#3B82F6]/10 text-[#3B82F6] border border-[#3B82F6]/20">
                <CircleUser className="size-3" />
              </span>
              <span className="hidden text-left leading-none sm:block" data-no-translate>
                <span className="block text-[10px] font-bold uppercase tracking-wider">Not signed in</span>
              </span>
              <ChevronDown className="size-3 text-[#94A3B8]" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48 bg-[#111827] border-[#263548] text-[#F3F4F6] rounded">
            <DropdownMenuLabel className="text-[10px] font-bold text-[#94A3B8] uppercase font-mono">{t("Operations Command")}</DropdownMenuLabel>
            <DropdownMenuItem className="text-xs font-mono text-[#94A3B8]" data-no-translate>
              a.chen@sentinel.io
            </DropdownMenuItem>
            <DropdownMenuSeparator className="bg-[#263548]" />
            <DropdownMenuItem className="text-xs hover:bg-[#1A2332] focus:bg-[#1A2332]">{t("Profile")}</DropdownMenuItem>
            <DropdownMenuItem className="text-xs hover:bg-[#1A2332] focus:bg-[#1A2332]">{t("Preferences")}</DropdownMenuItem>
            <DropdownMenuItem className="text-xs hover:bg-[#1A2332] focus:bg-[#1A2332]">{t("Security Keys")}</DropdownMenuItem>
            <DropdownMenuSeparator className="bg-[#263548]" />
            <DropdownMenuItem className="text-xs text-[#EF4444] hover:bg-[#EF4444]/10 focus:bg-[#EF4444]/10">{t("Log Out")}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <TopBar />
        <main className="flex-1 p-6">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  badge,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  badge?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {badge}
        </div>
        {description && (
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function StatusDot({
  tone = "success",
}: {
  tone?: "success" | "warning" | "danger" | "info" | "muted";
}) {
  const map: Record<string, string> = {
    success: "bg-[#22C55E]",
    warning: "bg-[#F59E0B]",
    danger: "bg-[#EF4444]",
    info: "bg-[#06B6D4]",
    muted: "bg-[#94A3B8]/40",
  };
  return (
    <span className="relative inline-flex">
      <span className={`size-2 rounded-full ${map[tone]}`} />
      <span className={`absolute inset-0 animate-ping rounded-full opacity-60 ${map[tone]}`} />
    </span>
  );
}

export function toneBadge(
  tone:
    | "positive"
    | "negative"
    | "neutral"
    | "critical"
    | "high"
    | "medium"
    | "low"
    | "verified"
    | "unverified",
): {
  variant: "default" | "secondary" | "destructive" | "outline";
  className: string;
  label: string;
} {
  const map = {
    positive: {
      className:
        "bg-[#22C55E]/10 text-[#22C55E] border-[#22C55E]/20",
      label: "Positive",
    },
    negative: {
      className: "bg-[#EF4444]/10 text-[#EF4444] border-[#EF4444]/20",
      label: "Negative",
    },
    neutral: { className: "bg-[#1A2332] text-[#94A3B8] border-[#263548]", label: "Neutral" },
    critical: {
      className: "bg-[#EF4444]/15 text-[#EF4444] border-[#EF4444]/25",
      label: "Critical",
    },
    high: {
      className:
        "bg-[#F59E0B]/15 text-[#F59E0B] border-[#F59E0B]/25",
      label: "High",
    },
    medium: {
      className:
        "bg-[#3B82F6]/15 text-[#3B82F6] border-[#3B82F6]/25",
      label: "Medium",
    },
    low: {
      className:
        "bg-[#06B6D4]/15 text-[#06B6D4] border-[#06B6D4]/25",
      label: "Low",
    },
    verified: {
      className:
        "bg-[#22C55E]/10 text-[#22C55E] border-[#22C55E]/20",
      label: "Verified",
    },
    unverified: { className: "bg-[#1A2332] text-[#94A3B8] border-[#263548]", label: "Unverified" },
  } as const;
  return { variant: "outline", ...map[tone] };
}

export function Tone({
  tone,
  children,
}: {
  tone: Parameters<typeof toneBadge>[0];
  children?: ReactNode;
}) {
  const t = toneBadge(tone);
  return (
    <Badge variant="outline" className={`font-medium ${t.className}`}>
      {children ?? t.label}
    </Badge>
  );
}
