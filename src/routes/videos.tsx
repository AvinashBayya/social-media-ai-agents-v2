import { createFileRoute } from "@tanstack/react-router";
import { AppShell, PageHeader, Tone } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Play, Pause, SkipBack, SkipForward, Volume2, MapPin } from "lucide-react";

export const Route = createFileRoute("/videos")({
  head: () => ({ meta: [{ title: "Video Intelligence — Sentinel AI" }] }),
  component: Page,
});

const scenes = [
  {
    t: "00:02",
    label: "Press pool wide shot",
    objs: ["podium", "microphones"],
    tone: "neutral" as const,
  },
  { t: "00:34", label: "Close-up · speaker", objs: ["face", "flag"], tone: "neutral" as const },
  {
    t: "01:12",
    label: "Cutaway · reporters",
    objs: ["camera", "notebook"],
    tone: "neutral" as const,
  },
  {
    t: "02:08",
    label: "Q&A · aggressive tone",
    objs: ["face", "gesture"],
    tone: "negative" as const,
  },
  { t: "03:41", label: "Exit montage", objs: ["door", "vehicle"], tone: "neutral" as const },
];

const transcript = [
  {
    t: "00:00",
    s: "Anchor",
    text: "Officials arrive at the press briefing amid rising speculation about the surveillance program.",
  },
  {
    t: "00:34",
    s: "Minister",
    text: "We categorically deny any unauthorized access to citizen data. Our systems are secure.",
  },
  {
    t: "01:22",
    s: "Reporter A",
    text: "Yet three independent researchers have published overlapping indicators — how do you respond?",
  },
  {
    t: "02:08",
    s: "Minister",
    text: "We will not comment on unverified material. The ministry stands by its earlier statement.",
  },
  {
    t: "03:15",
    s: "Anchor",
    text: "The briefing ended after eleven minutes without further questions being taken.",
  },
];

function Page() {
  return (
    <AppShell>
      <PageHeader
        title="Video Intelligence"
        description="Timeline analysis with detected objects, transcripts, scene changes, and deepfake scoring."
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <Card>
          <CardContent className="p-0">
            <div
              className="relative aspect-video overflow-hidden rounded-t-lg"
              style={{
                background: "linear-gradient(120deg, oklch(0.4 0.05 250), oklch(0.7 0.1 240))",
              }}
            >
              <div className="absolute inset-0 grid place-items-center">
                <button className="grid size-16 place-items-center rounded-full bg-white/90 text-primary shadow-xl">
                  <Play className="size-7 pl-1" />
                </button>
              </div>
              <div className="absolute left-3 top-3 rounded-md bg-black/50 px-2 py-1 text-[11px] font-medium text-white">
                LIVE · GlobalNews · 03:41
              </div>
              <div className="absolute right-3 top-3">
                <Tone tone="medium" />
              </div>
            </div>

            {/* Controls */}
            <div className="px-4 py-2">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="tabular-nums">00:47</span>
                <div className="relative flex-1">
                  <div className="h-1 rounded-full bg-muted" />
                  <div
                    className="absolute left-0 top-0 h-1 rounded-full bg-primary"
                    style={{ width: "22%" }}
                  />
                  {scenes.map((s, i) => (
                    <span
                      key={i}
                      className="absolute top-0 h-1 w-0.5 bg-foreground/60"
                      style={{ left: `${(i + 1) * 18}%` }}
                    />
                  ))}
                </div>
                <span className="tabular-nums">03:41</span>
              </div>
              <div className="mt-1.5 flex items-center gap-1">
                <Button variant="ghost" size="icon" className="size-8">
                  <SkipBack className="size-4" />
                </Button>
                <Button variant="ghost" size="icon" className="size-8">
                  <Pause className="size-4" />
                </Button>
                <Button variant="ghost" size="icon" className="size-8">
                  <SkipForward className="size-4" />
                </Button>
                <Button variant="ghost" size="icon" className="size-8">
                  <Volume2 className="size-4" />
                </Button>
                <span className="ml-auto text-[11px] text-muted-foreground flex items-center gap-1">
                  <MapPin className="size-3" />
                  Washington, US · 2025-11-19
                </span>
              </div>
            </div>

            {/* Scenes */}
            <div className="border-t p-4">
              <h3 className="mb-2 text-sm font-semibold">Scene changes</h3>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                {scenes.map((s, i) => (
                  <div key={i} className="rounded-md border bg-card p-2">
                    <div
                      className="mb-1.5 h-14 rounded"
                      style={{ background: `oklch(0.7 0.1 ${(i * 70) % 360})` }}
                    />
                    <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                      <span className="font-mono">{s.t}</span>
                      <Tone tone={s.tone} />
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-xs">{s.label}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Transcript */}
            <div className="border-t p-4">
              <h3 className="mb-2 text-sm font-semibold">Audio transcript</h3>
              <div className="space-y-2">
                {transcript.map((r, i) => (
                  <div
                    key={i}
                    className={`flex gap-3 rounded-md p-2 ${i === 1 ? "bg-primary/5" : ""}`}
                  >
                    <span className="w-12 shrink-0 font-mono text-[11px] text-muted-foreground">
                      {r.t}
                    </span>
                    <span className="w-20 shrink-0 text-xs font-medium">{r.s}</span>
                    <p className="min-w-0 flex-1 text-sm">{r.text}</p>
                  </div>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardContent className="p-4">
              <h3 className="text-sm font-semibold">Detected objects</h3>
              <div className="mt-3 space-y-2">
                {[
                  { l: "Faces", n: 4, p: 92 },
                  { l: "Text overlays", n: 6, p: 88 },
                  { l: "Logos (news chyron)", n: 2, p: 96 },
                  { l: "Weapons", n: 0, p: 0 },
                  { l: "Vehicles", n: 3, p: 74 },
                ].map((o) => (
                  <div key={o.l} className="flex items-center justify-between text-xs">
                    <span>{o.l}</span>
                    <div className="flex items-center gap-2">
                      <Progress value={o.p} className="h-1 w-24" />
                      <span className="w-8 text-right tabular-nums">{o.n}</span>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <h3 className="text-sm font-semibold">Deepfake analysis</h3>
              <div className="mt-2 flex items-baseline justify-between">
                <span className="text-3xl font-semibold">14%</span>
                <Tone tone="low" />
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Facial artifact and audio-sync analysis suggest authentic capture with light
                editing.
              </p>
              <Progress value={14} className="mt-3 h-1.5" />
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <h3 className="text-sm font-semibold">Sentiment · rolling</h3>
              <div className="mt-2 space-y-1.5 text-xs">
                <SentBar label="00:00-01:00" pos={30} neu={60} neg={10} />
                <SentBar label="01:00-02:00" pos={20} neu={55} neg={25} />
                <SentBar label="02:00-03:00" pos={10} neu={40} neg={50} />
                <SentBar label="03:00-03:41" pos={22} neu={58} neg={20} />
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}

function SentBar({
  label,
  pos,
  neu,
  neg,
}: {
  label: string;
  pos: number;
  neu: number;
  neg: number;
}) {
  return (
    <div>
      <div className="mb-0.5 flex justify-between text-[10px] text-muted-foreground">
        <span>{label}</span>
        <span>
          {pos}/{neu}/{neg}
        </span>
      </div>
      <div className="flex h-1.5 overflow-hidden rounded-full">
        <span style={{ width: `${pos}%`, background: "oklch(0.68 0.17 145)" }} />
        <span style={{ width: `${neu}%`, background: "oklch(0.6 0.19 255)" }} />
        <span style={{ width: `${neg}%`, background: "oklch(0.62 0.23 27)" }} />
      </div>
    </div>
  );
}
