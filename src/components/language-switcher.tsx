import { Check, Globe, ChevronsUpDown } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { useI18n } from "@/i18n/i18n-context";
import { LANGUAGES } from "@/i18n/languages";

/**
 * Sidebar language selector. Switching swaps the whole interface into the
 * chosen language and persists the choice to localStorage.
 */
export function LanguageSwitcher() {
  const { lang, meta, setLang, t } = useI18n();

  return (
    <SidebarGroup className="py-1">
      <SidebarGroupLabel className="px-2 font-mono text-[10px] font-bold uppercase tracking-widest text-console-muted/60">
        {t("Language")}
      </SidebarGroupLabel>
      <SidebarMenu>
        <SidebarMenuItem className="my-0.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton
                tooltip={`${t("Interface Language")} — ${meta.native}`}
                className="h-8 rounded border border-console-border bg-console-surface text-console-muted transition-colors hover:bg-console-elevated hover:text-console-text data-[state=open]:border-console-blue data-[state=open]:text-console-text"
              >
                <Globe className="size-4 text-console-cyan" />
                <span
                  data-no-translate
                  dir={meta.rtl ? "rtl" : "ltr"}
                  className="flex-1 truncate text-left text-xs tracking-tight"
                >
                  {meta.native}
                </span>
                <span
                  data-no-translate
                  className="font-mono text-[9px] font-bold tracking-widest text-console-blue group-data-[collapsible=icon]:hidden"
                >
                  {meta.short}
                </span>
                <ChevronsUpDown className="size-3 shrink-0 text-console-muted group-data-[collapsible=icon]:hidden" />
              </SidebarMenuButton>
            </DropdownMenuTrigger>

            <DropdownMenuContent
              side="right"
              align="end"
              sideOffset={8}
              className="max-h-[min(70vh,28rem)] w-60 overflow-y-auto rounded border-console-border bg-console-surface text-console-text"
            >
              <DropdownMenuLabel className="font-mono text-[10px] font-bold uppercase tracking-widest text-console-muted">
                {t("Select Language")}
              </DropdownMenuLabel>
              <DropdownMenuSeparator className="bg-console-border" />

              {LANGUAGES.map((option) => {
                const selected = option.code === lang;
                return (
                  <DropdownMenuItem
                    key={option.code}
                    onSelect={() => setLang(option.code)}
                    className={`gap-2 text-xs hover:bg-console-elevated focus:bg-console-elevated ${
                      selected ? "text-console-cyan" : "text-console-text"
                    }`}
                  >
                    <span
                      data-no-translate
                      className="grid size-5 shrink-0 place-items-center rounded border border-console-border bg-[#0F172A] font-mono text-[9px] font-bold text-console-blue"
                    >
                      {option.short}
                    </span>
                    <span
                      data-no-translate
                      dir={option.rtl ? "rtl" : "ltr"}
                      className="flex-1"
                      style={{ fontFamily: option.fontStack || undefined }}
                    >
                      {option.native}
                    </span>
                    <span data-no-translate className="font-mono text-[10px] text-console-label">
                      {option.label}
                    </span>
                    {selected && <Check className="size-3.5 shrink-0 text-console-cyan" />}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarGroup>
  );
}
