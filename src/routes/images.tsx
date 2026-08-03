import { createFileRoute } from "@tanstack/react-router";
import { AppShell, PageHeader, Tone } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { ScanFace, MapPin, Camera, Tag, FileImage } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/images")({
  head: () => ({ meta: [{ title: "Image Intelligence — Sentinel AI" }] }),
  component: Page,
});

const gallery = Array.from({ length: 12 }).map((_, i) => ({
  id: i + 1,
  hue: `oklch(${0.6 + (i % 4) * 0.08} 0.15 ${(i * 43) % 360})`,
  caption: [
    "Convoy near restricted checkpoint",
    "Public rally in city square",
    "Product keynote stage close-up",
    "Server-room screenshot from forum",
    "Press briefing wide shot",
    "Aerial shot of border region",
    "Corporate campus signage",
    "Damaged vehicle roadside",
    "Political poster on wall",
    "Group photo from event",
    "Leaked document photograph",
    "Satellite composite of area",
  ][i],
  tone: (
    [
      "negative",
      "neutral",
      "positive",
      "negative",
      "neutral",
      "negative",
      "neutral",
      "negative",
      "neutral",
      "positive",
      "negative",
      "neutral",
    ] as const
  )[i],
  faces: (i % 3) + 0,
}));

function Page() {
  return (
    <AppShell>
      <PageHeader
        title="Image Intelligence"
        description="Object detection, OCR, faces, logos, EXIF, and geolocation — AI-captioned and searchable."
        actions={<Button size="sm">Upload image</Button>}
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <div>
          <div className="mb-3 flex items-center gap-1.5">
            {["All", "Faces", "Logos", "Documents", "Weapons", "Vehicles", "Landmarks"].map(
              (f, i) => (
                <Badge
                  key={f}
                  variant={i === 0 ? "default" : "outline"}
                  className="cursor-pointer font-normal"
                >
                  {f}
                </Badge>
              ),
            )}
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {gallery.map((g) => (
              <Card key={g.id} className="overflow-hidden">
                <div
                  className="relative h-32"
                  style={{ background: `linear-gradient(135deg, ${g.hue}, oklch(0.95 0.02 240))` }}
                >
                  <span className="absolute right-1.5 top-1.5">
                    <Tone tone={g.tone} />
                  </span>
                  {g.faces > 0 && (
                    <div className="absolute left-1.5 bottom-1.5 rounded-full border bg-background/90 px-1.5 py-0.5 text-[10px]">
                      <ScanFace className="mr-1 inline size-3" />
                      {g.faces} face{g.faces > 1 ? "s" : ""}
                    </div>
                  )}
                </div>
                <div className="p-2">
                  <p className="line-clamp-2 text-xs">{g.caption}</p>
                  <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground">
                    <span className="flex items-center gap-0.5">
                      <MapPin className="size-3" />
                      GEO
                    </span>
                    <span>2025-11-{String((g.id % 28) + 1).padStart(2, "0")}</span>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </div>

        <Card>
          <CardContent className="p-0">
            <div
              className="h-56 rounded-t-lg"
              style={{
                background: "linear-gradient(135deg, oklch(0.75 0.14 30), oklch(0.9 0.05 250))",
              }}
            />
            <div className="p-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">Selected · IMG-482</h3>
                <Tone tone="negative" />
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Convoy near restricted checkpoint
              </p>

              <div className="mt-3 space-y-3">
                <Row icon={<Tag className="size-3.5" />} label="AI caption">
                  "Group of vehicles moving through arid landscape, dusk lighting, uniformed
                  personnel visible."
                </Row>
                <Row icon={<ScanFace className="size-3.5" />} label="Faces">
                  2 detected · watchlist hit on Vector-17 (71%)
                </Row>
                <Row icon={<Camera className="size-3.5" />} label="EXIF">
                  Canon EOS · 2025-11-19 17:42 UTC · f/2.8 · ISO 400
                </Row>
                <Row icon={<MapPin className="size-3.5" />} label="Geolocation">
                  33.512°N, 36.291°E · Damascus, SY · ±180m
                </Row>
                <Row icon={<FileImage className="size-3.5" />} label="OCR">
                  Sign reads "المنطقة العسكرية — ممنوع الاقتراب"
                </Row>
              </div>

              <div className="mt-4 space-y-2">
                <div className="mb-1 flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Deepfake probability</span>
                  <span className="font-semibold">8%</span>
                </div>
                <Progress value={8} className="h-1.5" />
              </div>

              <div className="mt-4 pt-3 border-t">
                {/*
                  Module 4 (image / deepfake analysis) is NOT implemented.
                  The previous button sent a hardcoded caption string to a
                  text-only model and presented the reply as visual forensics —
                  no image was ever read. There is no vision model configured,
                  so the honest state is a disabled control.
                */}
                <Button
                  size="sm"
                  disabled
                  title="Requires a vision-capable model — not yet configured"
                  className="w-full bg-[#1A2332] text-[#64748B] font-semibold text-xs flex items-center justify-center gap-2 cursor-not-allowed"
                >
                  <ScanFace className="size-4" /> Visual analysis — not yet implemented
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}

function Row({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border bg-card p-2.5">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {icon}
        {label}
      </div>
      <p className="mt-0.5 text-xs">{children}</p>
    </div>
  );
}
