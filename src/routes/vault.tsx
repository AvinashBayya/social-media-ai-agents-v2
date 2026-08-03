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
  FolderLock
} from "lucide-react";

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
  hash: string;
  geo: string;
  entities: string[];
  caseId: string;
  risk: number;
  tags: string[];
  fileSize?: string;
  previewUrl?: string;
}

const DEFAULT_EVIDENCE: EvidenceItem[] = [
  {
    id: "EVID-0402",
    title: "Surveillance drone photo Vector-17",
    type: "Image",
    timestamp: "2026-07-24 09:31:02 UTC",
    source: "Telegram · channel_9821",
    hash: "8f7c22a1b90dbf539e6a9f43003058ef51ef404e3415c9a01e3b6a95f9c46ee0",
    geo: "35.6892° N, 51.3890° E",
    entities: ["Vector-17", "Drone"],
    caseId: "INV-2041",
    risk: 85,
    tags: ["surveillance", "exif", "dossier"],
    fileSize: "4.2 MB"
  },
  {
    id: "EVID-0405",
    title: "Redacted Surveillance memo PDF",
    type: "PDF",
    timestamp: "2026-07-24 08:58:14 UTC",
    source: "Anonfiles leak link",
    hash: "3c98f821d0a5e8ef492c10b7a8123ef9c4e2098d7ac210bc94e3cd9081e289df",
    geo: "Global / Tor Network",
    entities: ["Vector-17", "Fintech vendor"],
    caseId: "INV-2041",
    risk: 72,
    tags: ["confidential", "memo", "leak"],
    fileSize: "1.8 MB"
  },
  {
    id: "EVID-0391",
    title: "#ElectionIntegrity bot networks tweet log",
    type: "Social",
    timestamp: "2026-07-23 14:12:00 UTC",
    source: "Twitter feed watch",
    hash: "f4a9b8219c0de82ff492cb10b8923ef89c4e21a7dfcc210ab94e2cd9081e289aa",
    geo: "United States",
    entities: ["CIB cluster", "Election narrative"],
    caseId: "INV-2038",
    risk: 61,
    tags: ["social", "cib", "disinfo"],
    fileSize: "245 KB"
  }
];

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

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      const file = files[0];
      const type = file.type.includes("pdf") ? "PDF" : file.type.includes("video") ? "Video" : "Image";
      addFileEvidence(file.name, type, `${(file.size / 1024 / 1024).toFixed(1)} MB`);
    }
  };

  const addFileEvidence = (name: string, type: string, size: string) => {
    const list = [...evidenceList];
    const newId = `EVID-0${400 + list.length + 1}`;
    const hexHash = Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
    
    const newItem: EvidenceItem = {
      id: newId,
      title: name,
      type: type,
      timestamp: new Date().toISOString().replace("T", " ").substring(0, 19) + " UTC",
      source: "Local drag & drop upload",
      hash: hexHash,
      geo: uploadGeo || "Global",
      entities: ["General Subject"],
      caseId: uploadCaseId,
      risk: Math.round(50 + Math.random() * 40),
      tags: uploadTags ? uploadTags.split(",").map(t => t.trim()) : ["uploaded", type.toLowerCase()],
      fileSize: size
    };

    list.unshift(newItem);
    saveEvidence(list);
    
    // Automatically pin evidence to related investigation if assigned
    if (uploadCaseId) {
      pinToInvestigation(
        uploadCaseId,
        type,
        "Evidence Vault Upload",
        `Evidence node attached: ${name} (${size})`,
        newItem.risk > 70 ? "high" : "medium",
        newItem
      );
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
    addFileEvidence(uploadTitle, uploadType, "1.4 MB");
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
        description="Tamper-proof cryptographic evidence locker. Pin files, documents, and media telemetry directly to active investigations."
      />

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
            <h3 className="text-white text-xs font-bold uppercase tracking-wider">Drag & Drop Cryptographic Node</h3>
            <p className="text-[10px] text-[#94A3B8]/60 mt-1">Supports Images, Videos, PDFs, and Document telemetry up to 50MB</p>
            
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
                    <option key={c.id} value={c.id}>{c.id}</option>
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
                <Badge onClick={() => setSelectedTag("")} className="bg-[#ef4444]/20 text-[#ef4444] border-[#ef4444]/30 text-[9px] rounded-none hover:bg-red-900/40 cursor-pointer">
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
                  item.type === "Image" ? ImageIcon :
                  item.type === "Video" ? VideoIcon :
                  item.type === "PDF" ? FileText :
                  Link2;

                return (
                  <Card
                    key={item.id}
                    onClick={() => setSelectedItem(item)}
                    className={`bg-[#111827] border cursor-pointer rounded transition-all select-none ${isSelected ? "border-[#3B82F6] shadow-md shadow-[#3B82F6]/5 bg-[#3B82F6]/5" : "border-[#263548] hover:border-[#3B82F6]/50"}`}
                  >
                    <CardContent className="p-3 space-y-2">
                      <div className="flex items-center justify-between text-[8px] text-[#94A3B8]/60">
                        <span className="font-bold text-[#06B6D4] flex items-center gap-1"><IconComponent className="size-3" /> {item.id}</span>
                        <span>{item.fileSize || "N/A"}</span>
                      </div>
                      <h4 className="font-semibold text-white text-[11px] line-clamp-1">{item.title}</h4>
                      
                      <div className="flex justify-between text-[8px] border-t border-[#263548]/30 pt-1.5">
                        <span className="text-[#94A3B8]/70 truncate max-w-[140px]">{item.source}</span>
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
                      <div className="text-[8px] text-[#06B6D4] font-bold font-mono">{selectedItem.id} ({selectedItem.type})</div>
                      <h3 className="text-white text-xs font-bold leading-snug mt-0.5">{selectedItem.title}</h3>
                    </div>

                    <div className="border border-[#263548]/40 rounded bg-[#0B1220] p-2 space-y-2 text-[9px] font-mono leading-normal">
                      <div className="flex justify-between">
                        <span className="text-[#94A3B8]/60">TIMETAG:</span>
                        <span className="text-white truncate max-w-[150px]">{selectedItem.timestamp}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-[#94A3B8]/60">SOURCE:</span>
                        <span className="text-white truncate max-w-[150px]">{selectedItem.source}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-[#94A3B8]/60">GEOPOINT:</span>
                        <span className="text-white truncate max-w-[150px]">{selectedItem.geo}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-[#94A3B8]/60">LINK CASE:</span>
                        <Link to="/investigations" className="text-[#3B82F6] hover:underline font-bold">{selectedItem.caseId}</Link>
                      </div>
                      <div className="space-y-0.5 border-t border-[#263548]/30 pt-1.5 mt-1.5">
                        <div className="text-[#94A3B8]/50 uppercase text-[8px]">SHA-256 Checksum:</div>
                        <div className="text-[8px] text-[#06B6D4] select-all break-all leading-normal">{selectedItem.hash}</div>
                      </div>
                    </div>

                    {selectedItem.tags?.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {selectedItem.tags.map((t, idx) => (
                          <Badge key={idx} variant="outline" className="border-[#263548] text-[#94A3B8] text-[8px] bg-[#0B1220]/60 rounded-none h-4">
                            #{t}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="pt-3 border-t border-[#263548]/30 mt-auto">
                    <Button className="w-full h-8 bg-[#3B82F6] hover:bg-[#3B82F6]/90 text-white font-mono text-[9px] uppercase tracking-wider gap-1.5">
                      <Download className="size-3.5" /> Download Checked Payload
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center text-center text-[#94A3B8]/40 py-12">
                  <Shield className="size-8 text-[#263548] mb-2 animate-pulse" />
                  Select an evidence node in the grid to display its cryptographic properties and preview payload contents.
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}
