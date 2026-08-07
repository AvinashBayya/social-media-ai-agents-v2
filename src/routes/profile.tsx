import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AlertTriangle, CircleUser, LogOut, ShieldOff } from "lucide-react";

import { AppShell, PageHeader } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { useDemoSession } from "@/components/demo-session";

/**
 * Operator profile for the DEMO session.
 *
 * Everything on this page is read from a localStorage record — see
 * `src/utils/demo-session.ts`. There is no user store, so the page shows only
 * what the demo session actually holds and says plainly that the role grants
 * nothing. Inventing a last-login history, a device list or an audit trail
 * here would be exactly the fabrication the project constraints forbid.
 */

export const Route = createFileRoute("/profile")({
  head: () => ({ meta: [{ title: "Operator Profile — Sentinel AI" }] }),
  component: ProfilePage,
});

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-b border-[#1A2332] py-2.5 last:border-b-0">
      <div className="font-mono text-[10px] font-bold uppercase tracking-wider text-[#64748B]">
        {label}
      </div>
      <div className="mt-1 font-mono text-sm text-[#F3F4F6]" data-no-translate>
        {value}
      </div>
    </div>
  );
}

function ProfilePage() {
  const navigate = useNavigate();
  const { session, ready, signOut } = useDemoSession();

  const handleSignOut = () => {
    signOut();
    navigate({ to: "/login", replace: true });
  };

  return (
    <AppShell>
      <PageHeader
        title="Operator Profile"
        description="Identity and session state for the current demo sign-in."
      />

      <div className="mt-6 grid max-w-3xl gap-4">
        <div className="flex gap-2.5 rounded border border-[#C79A3A]/35 bg-[#C79A3A]/10 px-3.5 py-3 text-[12px] leading-relaxed text-[#E2CF9F]">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[#C79A3A]" />
          <span>
            <strong className="font-semibold">This is a demo session, not an account.</strong> The
            sign-in compares two constants in the browser and stores the result in localStorage. No
            credentials were verified, no server was contacted, and the role below grants no
            permissions — every page and every server function is reachable without it.
          </span>
        </div>

        {!ready ? (
          <div className="rounded border border-[#263548] bg-[#111827] p-5 font-mono text-xs text-[#64748B]">
            Reading session…
          </div>
        ) : session ? (
          <>
            <div className="rounded border border-[#263548] bg-[#111827] p-5">
              <div className="flex items-center gap-3 border-b border-[#1A2332] pb-4">
                <span className="grid size-11 place-items-center rounded border border-[#3B82F6]/20 bg-[#3B82F6]/10 text-[#3B82F6]">
                  <CircleUser className="size-5" />
                </span>
                <div>
                  <div className="text-base font-bold text-[#F3F4F6]" data-no-translate>
                    {session.displayName}
                  </div>
                  <div className="font-mono text-[11px] text-[#94A3B8]" data-no-translate>
                    {session.email}
                  </div>
                </div>
              </div>

              <div className="mt-2">
                <Field label="Operator ID" value={session.operator} />
                <Field label="Role" value={`${session.role} (not enforced)`} />
                <Field
                  label="Signed in at"
                  value={session.signedInAt.replace("T", " ").slice(0, 19) + " UTC"}
                />
                <Field
                  label="Remember this device"
                  value={session.remember ? "Yes — session persists across reloads" : "No"}
                />
              </div>
            </div>

            <div className="rounded border border-[#263548] bg-[#111827] p-5">
              <div className="flex items-start gap-2.5">
                <ShieldOff className="mt-0.5 size-4 shrink-0 text-[#64748B]" />
                <div className="text-[12px] leading-relaxed text-[#94A3B8]">
                  <div className="font-mono text-[10px] font-bold uppercase tracking-wider text-[#64748B]">
                    Not available in this build
                  </div>
                  <p className="mt-1.5">
                    Password change, multi-factor enrolment, security keys, active-device management
                    and the access audit log all require a real authentication service. None is
                    implemented, so none is shown as a setting that would do nothing.
                  </p>
                </div>
              </div>
            </div>

            <div>
              <Button
                onClick={handleSignOut}
                className="gap-2 bg-[#EF4444]/10 text-[#EF4444] border border-[#EF4444]/30 hover:bg-[#EF4444]/20 font-mono text-xs"
              >
                <LogOut className="size-3.5" />
                Sign out
              </Button>
            </div>
          </>
        ) : (
          <div className="rounded border border-[#263548] bg-[#111827] p-5">
            <p className="text-sm text-[#94A3B8]">No demo session is active.</p>
            <Button
              onClick={() => navigate({ to: "/login" })}
              className="mt-4 bg-[#10B981] font-mono text-xs font-bold text-black hover:bg-[#059669]"
            >
              Go to sign-in
            </Button>
          </div>
        )}
      </div>
    </AppShell>
  );
}
