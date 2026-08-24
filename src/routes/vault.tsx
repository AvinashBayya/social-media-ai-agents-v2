import { createFileRoute, Link } from "@tanstack/react-router";
import { AppShell, PageHeader, Tone } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useState, useEffect, useMemo } from "react";
import { toast } from "sonner";
import {
  getInvestigations,
  pinToInvestigationWithId,
  removeEvidence,
  INVESTIGATIONS_CHANGED_EVENT,
  type Investigation,
} from "@/utils/investigations-store";
import { sha256OfFile } from "@/utils/evidence";
import {
  appendEvidence,
  deleteEvidence,
  getEvidence,
  nextEvidenceId,
  saveEvidence,
  setEvidenceCase,
  type EvidenceRecord,
} from "@/utils/evidence-store";
import { EmptyState } from "@/components/workspace-ui";
import {
  Search,
  UploadCloud,
  FileText,
  ImageIcon,
  Video as VideoIcon,
  Link2,
  Shield,
  Tag,
  Download,
  Trash2,
  Unlink,
  FolderLock,
} from "lucide-react";

export const Route = createFileRoute("/vault")({
  head: () => ({ meta: [{ title: "Evidence Vault — Sentinel AI" }] }),
  component: VaultPage,
});

/**
 * The record shape now lives in utils/evidence-store.ts, which is the single
 * owner of the `sentinel_evidence` key. This alias keeps the existing local
 * name working.
 */
type EvidenceItem = EvidenceRecord;

/*
 * DEFAULT_EVIDENCE is gone.
 *
 * It seeded three demonstration records — "Surveillance drone photo Vector-17",
 * a redacted memo, and an #ElectionIntegrity bot log — and every one of them
 * carried a caseId of INV-2041 or INV-2038. `createInvestigation` numbers cases
 * from INV-1001 upward, so those ids could never exist; combined with the v2
 * investigations wipe that guarantees a fresh browser holds zero cases, the
 * LINK CASE row on every seeded card rendered a bold blue case reference that
 * resolved to nothing at all.
 *
 * One of them also used to carry a fabricated 66-character "SHA-256" — not a
 * SHA-256 at all, and unnoticed for months. That is the argument against seeding
 * this store in particular: the digest is the one value this page exists to
 * guarantee, and an invented one is unfalsifiable by eye.
 *
 * The vault now starts empty. `withoutSeeded` in the store removes any seeded
 * rows left in a browser that loaded the old build, without touching real
 * uploads or attested captures sharing the same key.
 */

/**
 * Human file size that does not round small files to "0.0 MB".
 *
 * Every file under about 50 KB displayed as "0.0 MB", which reads as an empty
 * or failed upload.
 */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function VaultPage() {
  const [evidenceList, setEvidenceList] = useState<EvidenceItem[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTag, setSelectedTag] = useState<string>("");
  const [selectedItem, setSelectedItem] = useState<EvidenceItem | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Upload Form state
  const [cases, setCases] = useState<Investigation[]>([]);
  const [uploadCaseId, setUploadCaseId] = useState("");
  const [uploadTitle, setUploadTitle] = useState("");
  const [uploadType, setUploadType] = useState("Image");
  const [uploadGeo, setUploadGeo] = useState("");
  const [uploadTags, setUploadTags] = useState("");

  useEffect(() => {
    setEvidenceList(getEvidence());
  }, []);

  /**
   * Keep the case list live.
   *
   * `getInvestigations()` used to run once inside a mount-only effect, so a case
   * created on /investigations — or by PinButton on any other page, or in
   * another tab — was invisible to the LINK CASE dropdown until a full reload.
   * `saveInvestigations` now announces itself, and `storage` covers other tabs.
   */
  useEffect(() => {
    const load = () => setCases(getInvestigations());
    load();
    window.addEventListener(INVESTIGATIONS_CHANGED_EVENT, load);
    window.addEventListener("storage", load);
    window.addEventListener("focus", load);
    return () => {
      window.removeEventListener(INVESTIGATIONS_CHANGED_EVENT, load);
      window.removeEventListener("storage", load);
      window.removeEventListener("focus", load);
    };
  }, []);

  // A case that vanished while this page was open must not stay selected.
  useEffect(() => {
    if (uploadCaseId && !cases.some((c) => c.id === uploadCaseId)) setUploadCaseId("");
  }, [cases, uploadCaseId]);

  const caseExists = (id: string) => cases.some((c) => c.id === id);

  const persist = (list: EvidenceItem[]) => {
    setEvidenceList(list);
    saveEvidence(list);
  };

  // Drag and drop handlers
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  // The real SHA-256 now lives in utils/evidence.ts, unchanged in behaviour and
  // still refusing to fall back. It moved because the manual capture panel on
  // /social needs the identical hash under the identical secure-context rules,
  // and two copies is how two evidence records end up disagreeing about what
  // "the same file" means. See the history note in that module: this digest was
  // once 64 random hex characters.

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = e.dataTransfer.files;
    if (files.length === 0) return;

    const file = files[0];
    const type = file.type.includes("pdf")
      ? "PDF"
      : file.type.includes("video")
        ? "Video"
        : "Image";

    let hash: string;
    try {
      hash = await sha256OfFile(file);
    } catch (err: any) {
      toast.error(`Evidence not added: ${err?.message ?? err}`);
      return;
    }

    addFileEvidence(file.name, type, formatBytes(file.size), hash);
  };

  /** Serialise one evidence record to a file the analyst can keep. */
  const exportRecord = (item: EvidenceItem) => {
    try {
      const blob = new Blob([JSON.stringify(item, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${item.id}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(`Exported ${item.id}.`);
    } catch (err: any) {
      toast.error(`Export failed: ${err?.message ?? err}`);
    }
  };

  const addFileEvidence = (
    name: string,
    type: string,
    size: string | null,
    hash: string | null,
  ) => {
    const list = [...evidenceList];
    // Was `EVID-0${400 + list.length + 1}`, which reuses an id the moment
    // anything is deleted — two different exhibits under one identifier, in the
    // one store whose purpose is identifying exhibits.
    const newId = nextEvidenceId(list);

    const newItem: EvidenceItem = {
      id: newId,
      title: name,
      type: type,
      timestamp: new Date().toISOString().replace("T", " ").substring(0, 19) + " UTC",
      source: "Local drag & drop upload",
      // Real SHA-256 of the uploaded bytes.
      hash,
      // `|| "Global"` rendered under a GEOPOINT label, so an analyst who typed
      // no location saw a location. "Global" is not a coordinate.
      geo: uploadGeo.trim() || "not recorded",
      entities: [],
      caseId: uploadCaseId,
      // Risk was Math.round(50 + Math.random() * 40) — an invented score that then
      // drove the high/medium tone on the pinned investigation entry. There is no
      // basis to score an arbitrary upload, so it is unset until an analyst rates it.
      risk: null,
      tags: uploadTags
        ? uploadTags.split(",").map((t) => t.trim())
        : ["uploaded", type.toLowerCase()],
      fileSize: size,
    };

    /*
     * The pin result is now honoured.
     *
     * This block ignored `pinToInvestigation`'s return value and then toasted
     * "…linked to case ${uploadCaseId}" unconditionally — including when
     * uploadCaseId was the empty string, which produced "linked to case " and
     * claimed a link that had not been made. The function returns null both when
     * the case is gone and when this URL is already pinned to it.
     */
    if (uploadCaseId) {
      const evidenceId = pinToInvestigationWithId(uploadCaseId, {
        kind: "note",
        title: name,
        source: "Evidence vault upload",
        // A real event time: this is when the analyst added the file, not an
        // invented publication date for its contents.
        publishedAt: new Date().toISOString(),
        excerpt: `${type} attached to the evidence vault${size ? ` (${size})` : ""}.`,
        credibility: null,
        credibilityRationale:
          "Analyst-supplied file. Its SHA-256 is recorded in the vault; nothing about its " +
          "contents has been assessed.",
        data: newItem,
      });

      if (evidenceId) {
        newItem.pinnedEvidenceId = evidenceId;
        list.unshift(newItem);
        persist(list);
        toast.success(`Evidence ${newId} recorded and pinned to ${uploadCaseId}.`);
      } else {
        list.unshift(newItem);
        persist(list);
        toast.info(
          `Evidence ${newId} recorded, but not pinned — ${uploadCaseId} no longer exists or ` +
            `already holds this item.`,
        );
      }
    } else {
      list.unshift(newItem);
      persist(list);
      toast.success(`Evidence ${newId} recorded. No case linked.`);
    }

    // Clear inputs
    setUploadTitle("");
    setUploadTags("");
  };

  /**
   * Delete a record, and the copy inside its case.
   *
   * Removing only the vault row would leave the case citing an exhibit that no
   * longer exists — and `sourcesFromEvidence` feeds pinned evidence straight
   * into Module 5's citation validator, so the dangling entry would surface as a
   * numbered source in a generated product.
   */
  const removeRecord = (item: EvidenceItem, e: React.MouseEvent) => {
    // Required: the card itself has an onClick that selects the record, so
    // without this the delete button would also select what it just removed.
    e.stopPropagation();
    if (item.caseId && item.pinnedEvidenceId) {
      removeEvidence(item.caseId, item.pinnedEvidenceId);
    }
    const next = deleteEvidence(item.id);
    setEvidenceList(next);
    if (selectedItem?.id === item.id) setSelectedItem(null);
    toast.success(
      item.caseId && item.pinnedEvidenceId
        ? `${item.id} deleted, and removed from ${item.caseId}.`
        : `${item.id} deleted.`,
    );
  };

  /** Break the case link without deleting the evidence record. */
  const unlinkCase = (item: EvidenceItem) => {
    if (item.caseId && item.pinnedEvidenceId) {
      removeEvidence(item.caseId, item.pinnedEvidenceId);
    }
    const next = setEvidenceCase(item.id, "", null);
    setEvidenceList(next);
    setSelectedItem(next.find((e) => e.id === item.id) ?? null);
    toast.success(`${item.id} unlinked from ${item.caseId || "its case"}.`);
  };

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!uploadTitle.trim()) {
      toast.error("Please provide an evidence title.");
      return;
    }
    // Manual entry: no file supplied, so there is no size and nothing to hash.
    addFileEvidence(uploadTitle, uploadType, null, null);
  };

  // Tag list count helper
  const allTags = useMemo(() => {
    const tagsMap: Record<string, number> = {};
    evidenceList.forEach((e) => {
      e.tags?.forEach((t) => {
        tagsMap[t] = (tagsMap[t] || 0) + 1;
      });
    });
    return Object.entries(tagsMap);
  }, [evidenceList]);

  // Filter evidence list based on tag and query
  const filteredEvidenceList = useMemo(() => {
    return evidenceList.filter((e) => {
      const matchesSearch =
        e.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        e.source.toLowerCase().includes(searchQuery.toLowerCase()) ||
        e.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
        e.caseId.toLowerCase().includes(searchQuery.toLowerCase());

      const matchesTag = !selectedTag || e.tags?.includes(selectedTag);
      return matchesSearch && matchesTag;
    });
  }, [evidenceList, searchQuery, selectedTag]);

  return (
    <AppShell>
      <PageHeader
        title="Evidence Vault"
        description="Files dropped here are hashed with SHA-256 in your browser and the digest is recorded. The bytes are not stored, and this is not tamper-proof storage - records live in this browser only."
      />
      {/*
        The SampleDataBanner is gone with the records it described. Nothing in
        this vault is seeded any more — every record here was put here by an
        analyst, and every digest is a real SHA-256 of real bytes.
      */}

      <div className="grid gap-4 lg:grid-cols-[1fr_300px] font-mono text-xs text-console-muted">
        {/* Main Vault Workspace */}
        <div className="space-y-4">
          {/* Drag & Drop Upload Zone */}
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-all flex flex-col items-center justify-center min-h-[160px] ${isDragging ? "border-console-blue bg-console-blue/5" : "border-console-border bg-console-surface hover:border-console-blue/50"}`}
          >
            <UploadCloud className="size-8 text-console-blue animate-bounce mb-2" />
            <h3 className="text-console-text text-xs font-bold uppercase tracking-wider">
              Drag & Drop Cryptographic Node
            </h3>
            <p className="text-[10px] text-console-muted/60 mt-1">
              Supports Images, Videos, PDFs, and Document telemetry up to 50MB
            </p>

            <div className="mt-4 flex flex-wrap justify-center gap-4 items-center border-t border-console-border/30 pt-3 text-[9px] w-full max-w-lg">
              <div className="flex items-center gap-1">
                <span className="text-console-text">LINK CASE:</span>
                <select
                  value={uploadCaseId}
                  onChange={(e) => setUploadCaseId(e.target.value)}
                  aria-label="Link uploaded evidence to a case"
                  className="px-1 border border-console-border bg-console-deep rounded h-5 text-[9px] text-console-cyan"
                >
                  <option value="">-- No Case Link --</option>
                  {/* Was the bare id. The title is what an analyst recognises. */}
                  {cases.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.id} · {c.title}
                    </option>
                  ))}
                </select>
                {cases.length === 0 && (
                  <Link to="/investigations" className="text-[#3B82F6] hover:underline">
                    no cases yet — create one
                  </Link>
                )}
              </div>
              <div className="flex items-center gap-1">
                <span className="text-console-text">TAGS:</span>
                <input
                  type="text"
                  value={uploadTags}
                  onChange={(e) => setUploadTags(e.target.value)}
                  placeholder="confidential, leak"
                  className="px-1 border border-console-border bg-console-deep rounded h-5 text-[9px] text-console-text max-w-[100px]"
                />
              </div>
            </div>
          </div>

          {/*
            MANUAL ENTRY was unreachable dead code. handleFormSubmit had no call
            site, a DOM query on the hydrated page found ZERO form elements in
            main, and setUploadGeo was never called anywhere - so geo was
            permanently "Global" on every record, and the only way to add
            evidence at all was drag-and-drop.

            It is wired now, and it states plainly that a record with no file
            carries no digest. That distinction is the whole point of the page:
            a hashed record attests to specific bytes, a manual note does not.
          */}
          <form
            onSubmit={handleFormSubmit}
            className="space-y-2 rounded border border-console-border bg-console-surface p-3"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-[10px] font-bold uppercase tracking-wider text-console-text">
                Record without a file
              </h3>
              <span className="text-[9px] text-console-label">No file = no SHA-256</span>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <input
                type="text"
                value={uploadTitle}
                onChange={(e) => setUploadTitle(e.target.value)}
                placeholder="Title, e.g. Observed channel post"
                aria-label="Evidence title"
                className="h-6 rounded border border-console-border bg-console-deep px-1.5 text-[9px] text-console-text"
              />
              <select
                value={uploadType}
                onChange={(e) => setUploadType(e.target.value)}
                aria-label="Evidence type"
                className="h-6 rounded border border-console-border bg-console-deep px-1.5 text-[9px] text-console-cyan"
              >
                <option value="Image">Image</option>
                <option value="PDF">PDF</option>
                <option value="Social">Social</option>
                <option value="Note">Note</option>
              </select>
              <input
                type="text"
                value={uploadGeo}
                onChange={(e) => setUploadGeo(e.target.value)}
                placeholder="Location, if known"
                aria-label="Location"
                className="h-6 rounded border border-console-border bg-console-deep px-1.5 text-[9px] text-console-text"
              />
            </div>
            <Button
              type="submit"
              className="h-6 bg-console-border px-3 font-mono text-[9px] uppercase tracking-wider text-console-text hover:bg-console-blue"
            >
              Add record
            </Button>
          </form>

          {/* Filtering and search console */}
          <div className="flex flex-wrap gap-2 items-center justify-between border-b border-console-border/40 pb-3">
            <div className="relative w-full max-w-sm">
              <Search className="absolute left-2.5 top-2 size-3.5 text-console-muted" />
              <Input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search index by id, title, or source..."
                className="pl-8 h-8 text-[11px] border-console-border bg-console-surface text-console-text rounded"
              />
            </div>
            <div className="flex gap-1.5 flex-wrap items-center">
              <span className="text-[10px]">Filter Tag:</span>
              {selectedTag && (
                <Badge
                  onClick={() => setSelectedTag("")}
                  className="bg-console-red/20 text-console-red border-console-red/30 text-[9px] rounded-none hover:bg-red-900/40 cursor-pointer"
                >
                  [Clear: #{selectedTag}]
                </Badge>
              )}
              {allTags.slice(0, 5).map(([t, count]) => (
                <Badge
                  key={t}
                  onClick={() => setSelectedTag(t)}
                  variant={selectedTag === t ? "default" : "outline"}
                  className={`text-[9px] rounded-none cursor-pointer border-console-border ${selectedTag === t ? "bg-console-blue text-console-text" : "text-console-muted/80 hover:text-console-text bg-console-deep"}`}
                >
                  #{t} ({count})
                </Badge>
              ))}
            </div>
          </div>

          {/* Evidence Grid */}
          <div className="grid gap-3 sm:grid-cols-2">
            {filteredEvidenceList.length === 0 ? (
              <EmptyState
                className="sm:col-span-2"
                title="No Matching Blocks"
                message="No cryptographic evidence blocks match the active search or tag filters."
              />
            ) : (
              filteredEvidenceList.map((item) => {
                const isSelected = selectedItem?.id === item.id;
                const IconComponent =
                  item.type === "Image"
                    ? ImageIcon
                    : item.type === "Video"
                      ? VideoIcon
                      : item.type === "PDF"
                        ? FileText
                        : Link2;

                return (
                  <Card
                    key={item.id}
                    onClick={() => setSelectedItem(item)}
                    className={`bg-console-surface border cursor-pointer rounded transition-all select-none ${isSelected ? "border-console-blue shadow-md shadow-console-blue/5 bg-console-blue/5" : "border-console-border hover:border-console-blue/50"}`}
                  >
                    <CardContent className="p-3 space-y-2">
                      <div className="flex items-center justify-between text-[8px] text-console-muted/60">
                        <span className="font-bold text-console-cyan flex items-center gap-1">
                          <IconComponent className="size-3" /> {item.id}
                        </span>
                        <span className="ml-auto">{item.fileSize || "no file"}</span>
                        <button
                          onClick={(e) => removeRecord(item, e)}
                          aria-label={`Delete evidence record ${item.id}`}
                          title="Delete this record"
                          className="shrink-0 text-console-label hover:text-console-red"
                        >
                          <Trash2 className="size-3" />
                        </button>
                      </div>
                      <h4 className="line-clamp-1 text-[11px] font-semibold text-console-text">
                        {item.title}
                      </h4>

                      <div className="flex justify-between border-t border-console-border/30 pt-1.5 text-[8px]">
                        <span className="max-w-[140px] truncate text-console-muted/70">
                          {item.source}
                        </span>
                        {/*
                          An unlinked record used to render an empty span here,
                          and a record pointing at a deleted case rendered its id
                          in the same confident blue as a live one.
                        */}
                        {!item.caseId ? (
                          <span className="text-console-label">no case</span>
                        ) : caseExists(item.caseId) ? (
                          <span className="font-bold text-console-blue">{item.caseId}</span>
                        ) : (
                          <span className="text-console-amber">{item.caseId} (missing)</span>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                );
              })
            )}
          </div>
        </div>

        {/* Right Preview Side panel */}
        <div className="space-y-4">
          <Card className="bg-console-surface border-console-border rounded min-h-[300px] flex flex-col relative overflow-hidden">
            <div className="absolute top-0 left-0 h-full w-0.5 bg-console-blue" />
            <CardHeader className="p-3 border-b border-console-border bg-console-deep/20 pb-2">
              <CardTitle className="text-[10px] font-bold uppercase tracking-widest text-console-muted flex items-center gap-1.5">
                <FolderLock className="size-3.5 text-console-blue" /> Evidence Preview
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 flex-1 flex flex-col justify-between space-y-4">
              {selectedItem ? (
                <div className="space-y-4 flex-1 flex flex-col justify-between">
                  <div className="space-y-3">
                    <div>
                      <div className="text-[8px] text-console-cyan font-bold font-mono">
                        {selectedItem.id} ({selectedItem.type})
                      </div>
                      <h3 className="text-console-text text-xs font-bold leading-snug mt-0.5">
                        {selectedItem.title}
                      </h3>
                    </div>

                    <div className="border border-console-border/40 rounded bg-console-deep p-2 space-y-2 text-[9px] font-mono leading-normal">
                      <div className="flex justify-between">
                        <span className="text-console-muted/60">TIMETAG:</span>
                        <span className="text-console-text truncate max-w-[150px]">
                          {selectedItem.timestamp}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-console-muted/60">SOURCE:</span>
                        <span className="text-console-text truncate max-w-[150px]">
                          {selectedItem.source}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-console-muted/60">GEOPOINT:</span>
                        <span className="text-console-text truncate max-w-[150px]">
                          {selectedItem.geo}
                        </span>
                      </div>
                      {/*
                        This rendered `<Link to="/investigations">{caseId}</Link>`
                        with no search param, so clicking a case reference landed
                        on the case list with an arbitrary case selected. The id
                        also went unchecked, and the seeded records pointed at
                        INV-2041 / INV-2038 — ids the store can never mint — so
                        the link was frequently to a case that cannot exist.
                      */}
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-console-muted/60">LINK CASE:</span>
                        {!selectedItem.caseId ? (
                          <span className="text-console-label">not linked</span>
                        ) : caseExists(selectedItem.caseId) ? (
                          <span className="flex items-center gap-1.5">
                            <Link
                              to="/investigations"
                              search={{ case: selectedItem.caseId }}
                              className="font-bold text-console-blue hover:underline"
                            >
                              {selectedItem.caseId}
                            </Link>
                            <button
                              onClick={() => unlinkCase(selectedItem)}
                              aria-label="Unlink this evidence from its case"
                              title="Unlink from case"
                              className="text-console-label hover:text-console-red"
                            >
                              <Unlink className="size-3" />
                            </button>
                          </span>
                        ) : (
                          <span className="text-right text-console-amber">
                            {selectedItem.caseId} no longer exists
                          </span>
                        )}
                      </div>
                      <div className="space-y-0.5 border-t border-console-border/30 pt-1.5 mt-1.5">
                        <div className="text-console-muted/50 uppercase text-[8px]">
                          SHA-256 Checksum:
                        </div>
                        <div className="text-[8px] text-console-cyan select-all break-all leading-normal">
                          {selectedItem.hash ?? "No file supplied — nothing to hash."}
                        </div>
                      </div>
                    </div>

                    {selectedItem.tags?.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {selectedItem.tags.map((t, idx) => (
                          <Badge
                            key={idx}
                            variant="outline"
                            className="border-console-border text-console-muted text-[8px] bg-console-deep/60 rounded-none h-4"
                          >
                            #{t}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="pt-3 border-t border-console-border/30 mt-auto">
                    {/*
                      This button had NO onClick at all - confirmed by reading
                      the React props off the live DOM node, which returned
                      onClick: undefined. Clicking it produced no download, no
                      navigation and no error.

                      "Download Checked Payload" also could not have worked as
                      named: the vault stores metadata and a digest in
                      localStorage, never the file bytes. So the honest control
                      exports the RECORD, and says so.
                    */}
                    <Button
                      onClick={() => exportRecord(selectedItem)}
                      className="h-8 w-full gap-1.5 bg-console-blue font-mono text-[9px] uppercase tracking-wider text-console-text hover:bg-console-blue/90"
                    >
                      <Download className="size-3.5" /> Export record (JSON)
                    </Button>
                    <p className="mt-2 text-[9px] leading-relaxed text-console-label">
                      Exports this record and its SHA-256. The original file is not held by this
                      system, so it cannot be re-downloaded from here.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center text-center text-console-muted/40 py-12">
                  <Shield className="size-8 text-console-border mb-2 animate-pulse" />
                  Select an evidence node in the grid to display its cryptographic properties and
                  preview payload contents.
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}
