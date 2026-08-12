import { createFileRoute, Link } from "@tanstack/react-router";
import { AppShell, PageHeader, Tone } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useState, useEffect, useMemo } from "react";
import { toast } from "sonner";
import { getInvestigations, pinToInvestigation } from "@/utils/investigations-store";
import { EmptyState } from "@/components/workspace-ui";
import {
  FileArchive,
  Search,
  Plus,
  UploadCloud,
  FileText,
  ImageIcon,
  Video as VideoIcon,
  Link2,
  Share2,
  Calendar,
  MapPin,
  Shield,
  Tag,
  Download,
  AlertTriangle,
  FolderLock,
} from "lucide-react";
import { SampleDataBanner } from "@/components/sample-data-banner";

export const Route = createFileRoute("/vault")({
  head: () => ({ meta: [{ title: "Evidence Vault — Sentinel AI" }] }),
  component: VaultPage,
});

interface EvidenceItem {
  id: string;
  title: string;
  type: "Image" | "Video" | "PDF" | "Screenshot" | "URL" | "Document" | "Social" | "News" | string;
  timestamp: string;
  source: string;
  /** Real SHA-256 of the file bytes; null for manual records with no file. */
  hash: string | null;
  geo: string;
  entities: string[];
  caseId: string;
  /** Null when no analyst has rated this item. Never auto-generated. */
  risk: number | null;
  tags: string[];
  /** Null for manually-entered records where no file was supplied. */
  fileSize?: string | null;
  previewUrl?: string;
  /**
   * True for the demonstration records seeded on first load.
   *
   * The SampleDataBanner labels the VIEW, not the RECORDS. Once a real upload
   * was unshifted onto the same array, the seeded items and analyst evidence
   * were separable only by eyeballing the id or source string - and they sit in
   * the same localStorage key. A flag on the record itself survives into
   * storage, into anything pinned to a case, and into an export.
   */
  seeded?: true;
}

const DEFAULT_EVIDENCE: EvidenceItem[] = [
  {
    id: "EVID-0402",
    title: "Surveillance drone photo Vector-17",
    type: "Image",
    timestamp: "2026-07-24 09:31:02 UTC",
    source: "Telegram · channel_9821",
    // Seeded record: no file was ever hashed, so there is no digest.
    hash: null,
    geo: "35.6892° N, 51.3890° E",
    entities: ["Vector-17", "Drone"],
    caseId: "INV-2041",
    risk: null,
    tags: ["surveillance", "exif", "dossier"],
    fileSize: "4.2 MB",
    seeded: true,
  },
  {
    id: "EVID-0405",
    title: "Redacted Surveillance memo PDF",
    type: "PDF",
    timestamp: "2026-07-24 08:58:14 UTC",
    source: "Anonfiles leak link",
    // Seeded record: no file was ever hashed, so there is no digest.
    hash: null,
    geo: "Global / Tor Network",
    entities: ["Vector-17", "Fintech vendor"],
    caseId: "INV-2041",
    risk: null,
    tags: ["confidential", "memo", "leak"],
    fileSize: "1.8 MB",
    seeded: true,
  },
  {
    id: "EVID-0391",
    title: "#ElectionIntegrity bot networks tweet log",
    type: "Social",
    timestamp: "2026-07-23 14:12:00 UTC",
    source: "Twitter feed watch",
    // Seeded record: no file was ever hashed, so there is no digest.
    //
    // The literal that stood here was 66 hex characters — not a SHA-256 at all,
    // which no reader would ever have noticed. That is the argument against
    // fabricating this field in particular: the digest is the one value this
    // page exists to guarantee, and an invented one is unfalsifiable by eye.
    hash: null,
    geo: "United States",
    entities: ["CIB cluster", "Election narrative"],
    caseId: "INV-2038",
    risk: null,
    tags: ["social", "cib", "disinfo"],
    fileSize: "245 KB",
    seeded: true,
  },
];

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
  const [cases, setCases] = useState<any[]>([]);
  const [uploadCaseId, setUploadCaseId] = useState("");
  const [uploadTitle, setUploadTitle] = useState("");
  const [uploadType, setUploadType] = useState("Image");
  const [uploadGeo, setUploadGeo] = useState("Global");
  const [uploadTags, setUploadTags] = useState("");

  // Load evidence from localStorage
  useEffect(() => {
    if (typeof window !== "undefined") {
      const store = localStorage.getItem("sentinel_evidence");
      if (store) {
        try {
          setEvidenceList(JSON.parse(store));
        } catch {
          setEvidenceList(DEFAULT_EVIDENCE);
        }
      } else {
        localStorage.setItem("sentinel_evidence", JSON.stringify(DEFAULT_EVIDENCE));
        setEvidenceList(DEFAULT_EVIDENCE);
      }

      // Load cases
      const caseList = getInvestigations();
      setCases(caseList);
      if (caseList.length > 0) {
        setUploadCaseId(caseList[0].id);
      }
    }
  }, []);

  const saveEvidence = (list: EvidenceItem[]) => {
    setEvidenceList(list);
    localStorage.setItem("sentinel_evidence", JSON.stringify(list));
  };

  // Drag and drop handlers
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  /**
   * Compute a real SHA-256 over the file bytes.
   *
   * The hash was previously 64 random hex characters. An evidence integrity hash
   * that is not derived from the evidence defeats the entire purpose of recording
   * one — two identical files would hash differently, and a tampered file would
   * still "verify". This uses SubtleCrypto, which needs a secure context; over
   * plain HTTP on a non-localhost origin it is unavailable, and we report that
   * rather than falling back to something that looks like a hash.
   */
  const sha256OfFile = async (file: File): Promise<string> => {
    if (!globalThis.crypto?.subtle) {
      throw new Error(
        "SubtleCrypto unavailable — a secure context (HTTPS) is required to hash evidence.",
      );
    }
    const buf = await file.arrayBuffer();
    const digest = await globalThis.crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  };

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
    const newId = `EVID-0${400 + list.length + 1}`;

    const newItem: EvidenceItem = {
      id: newId,
      title: name,
      type: type,
      timestamp: new Date().toISOString().replace("T", " ").substring(0, 19) + " UTC",
      source: "Local drag & drop upload",
      // Real SHA-256 of the uploaded bytes.
      hash,
      geo: uploadGeo || "Global",
      entities: ["General Subject"],
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

    list.unshift(newItem);
    saveEvidence(list);

    // Automatically pin evidence to related investigation if assigned
    if (uploadCaseId) {
      pinToInvestigation(uploadCaseId, {
        kind: "note",
        title: name,
        source: "Evidence vault upload",
        publishedAt: new Date().toISOString(),
        excerpt: `${type} attached to the evidence vault (${size}).`,
        credibility: null,
        credibilityRationale:
          "Analyst-supplied file. Its SHA-256 is recorded in the vault; nothing about its " +
          "contents has been assessed.",
        data: newItem,
      });
    }

    toast.success(`Evidence node ${newId} initialized and linked to case ${uploadCaseId}`);

    // Clear inputs
    setUploadTitle("");
    setUploadTags("");
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
      <SampleDataBanner detail="Records badged SEEDED are demonstration entries that carry no digest - no file was ever hashed for them. Anything you drop in is hashed for real." />

      <div className="grid gap-4 lg:grid-cols-[1fr_300px] font-mono text-xs text-[#94A3B8]">
        {/* Main Vault Workspace */}
        <div className="space-y-4">
          {/* Drag & Drop Upload Zone */}
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-all flex flex-col items-center justify-center min-h-[160px] ${isDragging ? "border-[#3B82F6] bg-[#3B82F6]/5" : "border-[#263548] bg-[#111827] hover:border-[#3B82F6]/50"}`}
          >
            <UploadCloud className="size-8 text-[#3B82F6] animate-bounce mb-2" />
            <h3 className="text-white text-xs font-bold uppercase tracking-wider">
              Drag & Drop Cryptographic Node
            </h3>
            <p className="text-[10px] text-[#94A3B8]/60 mt-1">
              Supports Images, Videos, PDFs, and Document telemetry up to 50MB
            </p>

            <div className="mt-4 flex flex-wrap justify-center gap-4 items-center border-t border-[#263548]/30 pt-3 text-[9px] w-full max-w-lg">
              <div className="flex items-center gap-1">
                <span className="text-white">LINK CASE:</span>
                <select
                  value={uploadCaseId}
                  onChange={(e) => setUploadCaseId(e.target.value)}
                  className="px-1 border border-[#263548] bg-[#0B1220] rounded h-5 text-[9px] text-[#06B6D4]"
                >
                  <option value="">-- No Case Link --</option>
                  {cases.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.id}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-1">
                <span className="text-white">TAGS:</span>
                <input
                  type="text"
                  value={uploadTags}
                  onChange={(e) => setUploadTags(e.target.value)}
                  placeholder="confidential, leak"
                  className="px-1 border border-[#263548] bg-[#0B1220] rounded h-5 text-[9px] text-white max-w-[100px]"
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
            className="space-y-2 rounded border border-[#263548] bg-[#111827] p-3"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-[10px] font-bold uppercase tracking-wider text-white">
                Record without a file
              </h3>
              <span className="text-[9px] text-[#64748B]">No file = no SHA-256</span>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <input
                type="text"
                value={uploadTitle}
                onChange={(e) => setUploadTitle(e.target.value)}
                placeholder="Title, e.g. Observed channel post"
                aria-label="Evidence title"
                className="h-6 rounded border border-[#263548] bg-[#0B1220] px-1.5 text-[9px] text-white"
              />
              <select
                value={uploadType}
                onChange={(e) => setUploadType(e.target.value)}
                aria-label="Evidence type"
                className="h-6 rounded border border-[#263548] bg-[#0B1220] px-1.5 text-[9px] text-[#06B6D4]"
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
                className="h-6 rounded border border-[#263548] bg-[#0B1220] px-1.5 text-[9px] text-white"
              />
            </div>
            <Button
              type="submit"
              className="h-6 bg-[#263548] px-3 font-mono text-[9px] uppercase tracking-wider text-white hover:bg-[#3B82F6]"
            >
              Add record
            </Button>
          </form>

          {/* Filtering and search console */}
          <div className="flex flex-wrap gap-2 items-center justify-between border-b border-[#263548]/40 pb-3">
            <div className="relative w-full max-w-sm">
              <Search className="absolute left-2.5 top-2 size-3.5 text-[#94A3B8]" />
              <Input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search index by id, title, or source..."
                className="pl-8 h-8 text-[11px] border-[#263548] bg-[#111827] text-white rounded"
              />
            </div>
            <div className="flex gap-1.5 flex-wrap items-center">
              <span className="text-[10px]">Filter Tag:</span>
              {selectedTag && (
                <Badge
                  onClick={() => setSelectedTag("")}
                  className="bg-[#ef4444]/20 text-[#ef4444] border-[#ef4444]/30 text-[9px] rounded-none hover:bg-red-900/40 cursor-pointer"
                >
                  [Clear: #{selectedTag}]
                </Badge>
              )}
              {allTags.slice(0, 5).map(([t, count]) => (
                <Badge
                  key={t}
                  onClick={() => setSelectedTag(t)}
                  variant={selectedTag === t ? "default" : "outline"}
                  className={`text-[9px] rounded-none cursor-pointer border-[#263548] ${selectedTag === t ? "bg-[#3B82F6] text-white" : "text-[#94A3B8]/80 hover:text-white bg-[#0B1220]"}`}
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
                    className={`bg-[#111827] border cursor-pointer rounded transition-all select-none ${isSelected ? "border-[#3B82F6] shadow-md shadow-[#3B82F6]/5 bg-[#3B82F6]/5" : "border-[#263548] hover:border-[#3B82F6]/50"}`}
                  >
                    <CardContent className="p-3 space-y-2">
                      <div className="flex items-center justify-between text-[8px] text-[#94A3B8]/60">
                        <span className="font-bold text-[#06B6D4] flex items-center gap-1">
                          <IconComponent className="size-3" /> {item.id}
                        </span>
                        <span>{item.fileSize || "no file"}</span>
                        {item.seeded && (
                          <Badge className="ml-1 h-4 rounded-none border-[#F59E0B]/30 bg-[#F59E0B]/10 text-[8px] text-[#F59E0B]">
                            SEEDED
                          </Badge>
                        )}
                      </div>
                      <h4 className="font-semibold text-white text-[11px] line-clamp-1">
                        {item.title}
                      </h4>

                      <div className="flex justify-between text-[8px] border-t border-[#263548]/30 pt-1.5">
                        <span className="text-[#94A3B8]/70 truncate max-w-[140px]">
                          {item.source}
                        </span>
                        <span className="text-[#3B82F6] font-bold">{item.caseId}</span>
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
          <Card className="bg-[#111827] border-[#263548] rounded min-h-[300px] flex flex-col relative overflow-hidden">
            <div className="absolute top-0 left-0 h-full w-0.5 bg-[#3B82F6]" />
            <CardHeader className="p-3 border-b border-[#263548] bg-[#0B1220]/20 pb-2">
              <CardTitle className="text-[10px] font-bold uppercase tracking-widest text-[#94A3B8] flex items-center gap-1.5">
                <FolderLock className="size-3.5 text-[#3B82F6]" /> Evidence Preview
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 flex-1 flex flex-col justify-between space-y-4">
              {selectedItem ? (
                <div className="space-y-4 flex-1 flex flex-col justify-between">
                  <div className="space-y-3">
                    <div>
                      <div className="text-[8px] text-[#06B6D4] font-bold font-mono">
                        {selectedItem.id} ({selectedItem.type})
                      </div>
                      <h3 className="text-white text-xs font-bold leading-snug mt-0.5">
                        {selectedItem.title}
                      </h3>
                    </div>

                    <div className="border border-[#263548]/40 rounded bg-[#0B1220] p-2 space-y-2 text-[9px] font-mono leading-normal">
                      <div className="flex justify-between">
                        <span className="text-[#94A3B8]/60">TIMETAG:</span>
                        <span className="text-white truncate max-w-[150px]">
                          {selectedItem.timestamp}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-[#94A3B8]/60">SOURCE:</span>
                        <span className="text-white truncate max-w-[150px]">
                          {selectedItem.source}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-[#94A3B8]/60">GEOPOINT:</span>
                        <span className="text-white truncate max-w-[150px]">
                          {selectedItem.geo}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-[#94A3B8]/60">LINK CASE:</span>
                        <Link
                          to="/investigations"
                          className="text-[#3B82F6] hover:underline font-bold"
                        >
                          {selectedItem.caseId}
                        </Link>
                      </div>
                      <div className="space-y-0.5 border-t border-[#263548]/30 pt-1.5 mt-1.5">
                        <div className="text-[#94A3B8]/50 uppercase text-[8px]">
                          SHA-256 Checksum:
                        </div>
                        <div className="text-[8px] text-[#06B6D4] select-all break-all leading-normal">
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
                            className="border-[#263548] text-[#94A3B8] text-[8px] bg-[#0B1220]/60 rounded-none h-4"
                          >
                            #{t}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="pt-3 border-t border-[#263548]/30 mt-auto">
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
                      className="h-8 w-full gap-1.5 bg-[#3B82F6] font-mono text-[9px] uppercase tracking-wider text-white hover:bg-[#3B82F6]/90"
                    >
                      <Download className="size-3.5" /> Export record (JSON)
                    </Button>
                    <p className="mt-2 text-[9px] leading-relaxed text-[#64748B]">
                      Exports this record and its SHA-256. The original file is not held by this
                      system, so it cannot be re-downloaded from here.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center text-center text-[#94A3B8]/40 py-12">
                  <Shield className="size-8 text-[#263548] mb-2 animate-pulse" />
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
