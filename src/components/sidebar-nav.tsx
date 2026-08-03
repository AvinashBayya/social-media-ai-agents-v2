import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { useT } from "@/i18n/i18n-context";

export interface NavItem {
  title: string;
  to: string;
  icon: ComponentType<{ className?: string }>;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

const STORAGE_KEY = "sentinel_nav_groups";

/**
 * Hover timings. The open delay stops groups cascading open as the cursor
 * travels down the rail; the (longer) close delay gives you time to move
 * diagonally from a header into its items without it snapping shut.
 */
const HOVER_OPEN_DELAY = 140;
const HOVER_CLOSE_DELAY = 240;

/**
 * Collapsible module navigation.
 *
 * A group opens in three ways: clicking its header pins it (and the choice is
 * remembered), hovering peeks it open until the cursor leaves, and navigating
 * into a route auto-opens whichever module owns it.
 */
export function SidebarNav({ groups, pathname }: { groups: NavGroup[]; pathname: string }) {
  const t = useT();
  const { state, isMobile } = useSidebar();
  // In the icon-only rail there are no labels to click, so nothing collapses.
  const railCollapsed = state === "collapsed" && !isMobile;

  const [pinned, setPinned] = useState<Record<string, boolean>>({});
  const [peeked, setPeeked] = useState<string | null>(null);

  const openTimer = useRef<number | undefined>(undefined);
  const closeTimer = useRef<number | undefined>(undefined);
  const hydrated = useRef(false);

  const isActive = useCallback(
    (to: string) => (to === "/" ? pathname === "/" : pathname.startsWith(to)),
    [pathname],
  );

  const activeGroup = useMemo(
    () => groups.find((g) => g.items.some((i) => isActive(i.to)))?.label ?? null,
    [groups, isActive],
  );

  // Restore the saved open/closed state once on the client. Rendering starts
  // from `{}` so the server markup and first client render agree.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === "object") setPinned(parsed as Record<string, boolean>);
      }
    } catch {
      /* unreadable storage — fall back to everything collapsed */
    }
  }, []);

  // Whichever module owns the current route opens itself, on first paint and on
  // every navigation, so the active item is never hidden inside a closed group.
  useEffect(() => {
    if (!activeGroup) return;
    setPinned((prev) => (prev[activeGroup] ? prev : { ...prev, [activeGroup]: true }));
  }, [activeGroup]);

  useEffect(() => {
    // Skip the first pass so we don't overwrite saved state before it loads.
    if (!hydrated.current) {
      hydrated.current = true;
      return;
    }
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(pinned));
    } catch {
      /* storage unavailable — the choice just won't persist */
    }
  }, [pinned]);

  useEffect(
    () => () => {
      window.clearTimeout(openTimer.current);
      window.clearTimeout(closeTimer.current);
    },
    [],
  );

  const handleEnter = useCallback(
    (label: string) => {
      if (railCollapsed) return;
      window.clearTimeout(closeTimer.current);
      window.clearTimeout(openTimer.current);
      openTimer.current = window.setTimeout(() => setPeeked(label), HOVER_OPEN_DELAY);
    },
    [railCollapsed],
  );

  const handleLeave = useCallback((label: string) => {
    window.clearTimeout(openTimer.current);
    closeTimer.current = window.setTimeout(
      () => setPeeked((current) => (current === label ? null : current)),
      HOVER_CLOSE_DELAY,
    );
  }, []);

  // Clicking commits the current visual state: a peeked-open group becomes
  // pinned open, a pinned group closes.
  const toggle = useCallback((label: string) => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
    setPeeked(null);
    setPinned((prev) => ({ ...prev, [label]: !prev[label] }));
  }, []);

  return (
    <>
      {groups.map((group) => {
        const open = railCollapsed || Boolean(pinned[group.label]) || peeked === group.label;
        const holdsActive = activeGroup === group.label;

        return (
          <Collapsible key={group.label} open={open} onOpenChange={() => toggle(group.label)}>
            <SidebarGroup
              className="py-1"
              onMouseEnter={() => handleEnter(group.label)}
              onMouseLeave={() => handleLeave(group.label)}
            >
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  onFocus={() => handleEnter(group.label)}
                  className="flex w-full items-center gap-1.5 rounded px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-widest text-[#94A3B8]/60 transition-colors hover:bg-[#111827]/60 hover:text-[#94A3B8] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#3B82F6] group-data-[collapsible=icon]:hidden"
                >
                  <ChevronRight
                    className={`size-3 shrink-0 transition-transform duration-200 ${open ? "rotate-90" : ""}`}
                  />
                  <span className="flex-1 text-left">{t(group.label)}</span>
                  {/* Marks the module you're currently inside when it's closed. */}
                  {holdsActive && !open && (
                    <span className="size-1.5 shrink-0 rounded-full bg-[#06B6D4]" />
                  )}
                </button>
              </CollapsibleTrigger>

              <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
                <SidebarGroupContent>
                  <SidebarMenu>
                    {group.items.map((item) => {
                      const active = isActive(item.to);
                      return (
                        <SidebarMenuItem key={item.to} className="my-0.5">
                          <SidebarMenuButton
                            asChild
                            isActive={active}
                            tooltip={t(item.title)}
                            className={`h-8 rounded border transition-colors ${
                              active
                                ? "border-[#3B82F6] bg-[#1A2332] font-medium text-[#F3F4F6]"
                                : "border-transparent text-[#94A3B8] hover:bg-[#111827]/60 hover:text-[#F3F4F6]"
                            }`}
                          >
                            <Link to={item.to} className="flex items-center gap-2">
                              <item.icon
                                className={`size-4 ${active ? "text-[#06B6D4]" : "text-[#94A3B8]"}`}
                              />
                              <span className="text-xs tracking-tight">{t(item.title)}</span>
                            </Link>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      );
                    })}
                  </SidebarMenu>
                </SidebarGroupContent>
              </CollapsibleContent>
            </SidebarGroup>
          </Collapsible>
        );
      })}
    </>
  );
}
