import { useEffect, useState } from "react";
import { Check, Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getThemePreference, setThemePreference, THEME_EVENT, type ThemePreference } from "@/utils/theme";

const OPTIONS: Array<{ value: ThemePreference; label: string; icon: typeof Sun }> = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

/**
 * Global theme selector, styled to match the notification bell it sits next
 * to in the top bar. Initial render uses the fixed SSR-safe default
 * ("dark", matching theme.ts's own default and this app's pre-toggle
 * behavior) and corrects to the real stored preference in an effect —
 * mirrors demo-session.tsx's established pattern for this exact class of
 * problem, accepting the same one-frame flash rather than reading
 * localStorage during the initial render, which would mismatch whatever the
 * server rendered.
 */
export function ThemeToggle() {
  const [pref, setPref] = useState<ThemePreference>("dark");

  useEffect(() => {
    setPref(getThemePreference());
    const handleChange = (e: Event) => setPref((e as CustomEvent<ThemePreference>).detail);
    window.addEventListener(THEME_EVENT, handleChange);

    // Live-updates when pref === "system" and the OS theme flips while the
    // app is open — setThemePreference re-resolves and re-applies .dark, so
    // just re-running it with the current stored preference is enough.
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handleSystemChange = () => {
      if (getThemePreference() === "system") setThemePreference("system");
    };
    media.addEventListener("change", handleSystemChange);

    return () => {
      window.removeEventListener(THEME_EVENT, handleChange);
      media.removeEventListener("change", handleSystemChange);
    };
  }, []);

  const ActiveIcon = OPTIONS.find((o) => o.value === pref)?.icon ?? Moon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 rounded border border-console-border bg-console-surface text-console-muted hover:text-console-text"
          aria-label="Theme"
        >
          <ActiveIcon className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-40 rounded border-console-border bg-console-surface text-console-text"
      >
        <DropdownMenuLabel className="font-mono text-[10px] font-bold uppercase tracking-widest text-console-muted">
          Theme
        </DropdownMenuLabel>
        <DropdownMenuSeparator className="bg-console-border" />
        {OPTIONS.map((option) => {
          const Icon = option.icon;
          const selected = option.value === pref;
          return (
            <DropdownMenuItem
              key={option.value}
              onSelect={() => setThemePreference(option.value)}
              className={`gap-2 text-xs hover:bg-console-elevated focus:bg-console-elevated ${
                selected ? "text-console-cyan" : "text-console-text"
              }`}
            >
              <Icon className="size-3.5 shrink-0" />
              <span className="flex-1">{option.label}</span>
              {selected && <Check className="size-3.5 shrink-0 text-console-cyan" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
