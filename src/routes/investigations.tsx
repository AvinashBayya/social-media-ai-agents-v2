import { createFileRoute } from "@tanstack/react-router";
import { AppShell, PageHeader, Tone } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { useState, useEffect } from "react";
import { toast } from "sonner";
import { llmCaseSummary } from "@/utils/llm";
import {
  getInvestigations,
  createInvestigation,
  updateAnalystNotes,
  type Investigation,
  type PinnedEvidence
} from "@/utils/investigations-store";
import {
  FolderOpen,
  Plus,
  Paperclip,
  FileText,
  ImageIcon,
  Link2,
  Users2,
  Clock,
  Sparkles,
  MessageSquare,
  ShieldCheck,
  RefreshCw,
  Tag,
  AlertTriangle
} from "lucide-react";
import { SampleDataBanner } from "@/components/sample-data-banner";

export const Route = createFileRoute("/investigations")({
  head: () => ({ meta: [{ title: "AI Investigations — Sentinel AI" }] }),
  component: InvestigationsPage,
});

function InvestigationsPage() {
  const [casesList, setCasesList] = useState<Investigation[]>([]);
  const [selectedCaseId, setSelectedCaseId] = useState<string>("");
  const [showCreateForm, setShowCreateForm] = useState(false);

  // New Case Form State
  const [newTarget, setNewTarget] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newKeywords, setNewKeywords] = useState("");
  const [newOwner, setNewOwner] = useState("Unassigned");

  // Notes state
  const [noteInput, setNoteInput] = useState("");

  // Load cases on mount
  useEffect(() => {
    const list = getInvestigations();
    setCasesList(list);
    if (list.length > 0) {
      setSelectedCaseId(list[0].id);
    }
  }, []);

  const refreshList = () => {
    const list = getInvestigations();
    setCasesList(list);
  };

  const handleCreateCase = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTarget.trim() || !newTitle.trim()) {
      toast.error("Please provide a target and a case title.");
      return;
    }
    const keywordsArray = newKeywords.split(",").map(k => k.trim()).filter(Boolean);
    const newCase = createInvestigation(newTarget, newTitle, newDesc, keywordsArray, newOwner);
    toast.success(`Investigation ${newCase.id} created successfully!`);
    
    // Reset form
    setNewTarget("");
    setNewTitle("");
    setNewDesc("");
    setNewKeywords("");
    setShowCreateForm(false);
    
    // Refresh lists and select the new case
    const list = getInvestigations();
    setCasesList(list);
    setSelectedCaseId(newCase.id);
  };

  const handlePostNote = () => {
    if (!activeCase) return;
    if (!noteInput.trim()) {
      toast.error("Note text cannot be empty.");
      return;
    }
    
    const now = new Date();
    const timeStr = `${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}`;
    
    // We can append this note to the evidence timeline of the case
    const updatedNotes = activeCase.notes 
      ? `${activeCase.notes}\n[${timeStr} - ${activeCase.owner}]: ${noteInput}`
      : `[${timeStr} - ${activeCase.owner}]: ${noteInput}`;
      
    updateAnalystNotes(activeCase.id, updatedNotes);
    toast.success("Analyst notes updated.");
    setNoteInput("");
    refreshList();
  };

  const activeCase = casesList.find((c) => c.id === selectedCaseId) || casesList[0];

  return (
    <AppShell>
      <PageHeader
        title="AI Investigations"
        description="Structured case workspaces — evidence, relationships, and analyst notes, guided by AI."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => refreshList()} className="font-mono text-xs gap-1.5 border-[#263548] text-[#94A3B8] hover:bg-[#1A2332]">
              <RefreshCw className="size-3.5" />
      <SampleDataBanner detail="Seeded case dossiers." /> Refresh List
            </Button>
            <Button size="sm" onClick={() => setShowCreateForm(!showCreateForm)} className="gap-1.5 font-mono text-xs bg-[#3B82F6] hover:bg-[#3B82F6]/90 text-white">
              <Plus className="size-3.5" /> New Investigation
            </Button>
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[300px_1fr] font-mono text-xs">
        {/* Left Side cases list */}
        <div className="space-y-4">
          {showCreateForm && (
            <Card className="bg-[#111827] border-[#263548] rounded relative overflow-hidden">
              <div className="absolute top-0 left-0 h-full w-0.5 bg-[#3B82F6]" />
              <CardHeader className="p-3 border-b border-[#263548] bg-[#0B1220]/20 pb-2">
                <CardTitle className="text-[10px] font-bold uppercase tracking-widest text-[#06B6D4]">Initialize Intel Case</CardTitle>
              </CardHeader>
              <CardContent className="p-3">
                <form onSubmit={handleCreateCase} className="space-y-3 text-[10px]">
                  <div className="space-y-1">
                    <label className="text-[#94A3B8] uppercase">Target Subject</label>
                    <Input value={newTarget} onChange={(e) => setNewTarget(e.target.value)} placeholder="e.g. Vector-17, Tesla" className="h-7 text-[10px] border-[#263548] bg-[#0B1220] text-white" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[#94A3B8] uppercase">Case Title</label>
                    <Input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="e.g. Surveillance Leak dossier" className="h-7 text-[10px] border-[#263548] bg-[#0B1220] text-white" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[#94A3B8] uppercase">Description</label>
                    <Textarea value={newDesc} onChange={(e) => setNewDesc(e.target.value)} placeholder="Provide short case description..." className="min-h-12 text-[10px] border-[#263548] bg-[#0B1220] text-white" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[#94A3B8] uppercase">Keywords (comma separated)</label>
                    <Input value={newKeywords} onChange={(e) => setNewKeywords(e.target.value)} placeholder="e.g. leak, malware, drone" className="h-7 text-[10px] border-[#263548] bg-[#0B1220] text-white" />
                  </div>
                  <div className="flex gap-2 pt-1.5">
                    <Button type="submit" size="sm" className="h-7 bg-[#3B82F6] hover:bg-[#3B82F6]/90 text-white font-mono text-[9px] uppercase px-2">Create</Button>
                    <Button type="button" onClick={() => setShowCreateForm(false)} variant="outline" className="h-7 text-[9px] font-mono border-[#263548] text-[#94A3B8] hover:bg-[#1A2332] px-2 uppercase">Cancel</Button>
                  </div>
                </form>
              </CardContent>
            </Card>
          )}

          <Card className="bg-[#111827] border-[#263548] rounded">
            <CardHeader className="pb-2 border-b border-[#263548] p-3 bg-[#0B1220]/20">
              <CardTitle className="flex items-center gap-2 text-xs font-bold uppercase text-[#94A3B8]">
                <FolderOpen className="size-4 text-[#3B82F6]" /> Open Cases
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5 p-2 max-h-[70vh] overflow-y-auto">
              {casesList.map((c) => {
                const isActive = c.id === selectedCaseId;
                return (
                  <button
                    key={c.id}
                    onClick={() => setSelectedCaseId(c.id)}
                    className={`w-full rounded border px-3 py-2 text-left transition text-[10px] ${isActive ? "border-[#3B82F6]/50 bg-[#3B82F6]/10 text-white" : "border-[#263548]/40 bg-[#111827] text-[#94A3B8] hover:bg-[#1A2332]"}`}
                  >
                    <div className="flex items-center justify-between text-[8px] text-[#94A3B8]/60">
                      <span className="font-mono text-[#06B6D4] font-bold">{c.id}</span>
                      <Badge variant="outline" className="h-4 px-1.5 text-[8px] border-[#263548] uppercase bg-[#0B1220] rounded-none">
                        {c.status}
                      </Badge>
                    </div>
                    <div className="mt-1 font-semibold text-white leading-tight uppercase tracking-wide truncate">{c.title}</div>
                    <div className="mt-2 flex items-center justify-between text-[8px]">
                      <span>{c.owner}</span>
                      <span className="text-[#EF4444] font-bold font-mono">RISK: {c.risk}</span>
                    </div>
                  </button>
                );
              })}
            </CardContent>
          </Card>
        </div>

        {/* Case workspace */}
        {activeCase ? (
          <div className="space-y-4">
            {/* Header Telemetry Card */}
            <Card className="bg-[#111827] border-[#263548] rounded relative overflow-hidden">
              <div className="absolute top-0 left-0 h-full w-0.5 bg-[#EF4444]" />
              <CardContent className="p-5 space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1 flex-1 min-w-[280px]">
                    <div className="flex items-center gap-2 text-[10px] text-[#94A3B8]">
                      <span className="font-mono text-[#06B6D4] font-bold">{activeCase.id}</span>
                      <Badge variant="outline" className="text-[#3B82F6] border-[#3B82F6]/20 bg-[#3B82F6]/5 uppercase text-[9px]">{activeCase.status}</Badge>
                      <Tone tone={activeCase.risk > 70 ? "critical" : "high"} />
                    </div>
                    <h2 className="text-base font-bold text-white uppercase tracking-wider">{activeCase.title}</h2>
                    <p className="text-[#94A3B8] text-[11px] leading-relaxed max-w-2xl">{activeCase.description}</p>
                    {activeCase.keywords?.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 pt-1.5">
                        {activeCase.keywords.map((k, idx) => (
                          <Badge key={idx} variant="outline" className="border-[#263548] text-[#94A3B8] text-[8px] bg-[#0B1220]/40 rounded-none h-4 uppercase">
                            <Tag className="size-2 text-[#3B82F6] mr-1 inline" /> {k}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 font-mono">
                    <div className="rounded border border-[#263548] bg-[#0B1220]/60 px-3 py-2 text-center">
                      <div className="text-[8px] uppercase tracking-wider text-[#94A3B8]">Evidence Count</div>
                      <div className="text-base font-bold text-white mt-0.5">{activeCase.evidence?.length || 0}</div>
                    </div>
                    <div className="rounded border border-[#263548] bg-[#0B1220]/60 px-3 py-2 text-center">
                      <div className="text-[8px] uppercase tracking-wider text-[#94A3B8]">Risk Level</div>
                      <div className="text-base font-bold text-[#EF4444] mt-0.5">{activeCase.risk}%</div>
                      <Progress value={activeCase.risk} className="mt-1 h-1 bg-[#263548]" />
                    </div>
                    <div className="rounded border border-[#263548] bg-[#0B1220]/60 px-3 py-2 text-center">
                      <div className="text-[8px] uppercase tracking-wider text-[#94A3B8]">Threat Score</div>
                      <div className="text-base font-bold text-[#F59E0B] mt-0.5">{activeCase.threatScore}/100</div>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
              {/* Evidence timeline */}
              <Card className="bg-[#111827] border-[#263548] rounded">
                <CardHeader className="pb-2 border-b border-[#263548] p-3 bg-[#0B1220]/20">
                  <CardTitle className="flex items-center gap-2 text-xs font-bold uppercase text-[#94A3B8]">
                    <Clock className="size-4 text-[#3B82F6]" /> Evidence Timeline
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-4 space-y-4 max-h-[50vh] overflow-y-auto">
                  {activeCase.evidence?.length === 0 ? (
                    <div className="text-center text-[#94A3B8]/60 py-6">
                      <AlertTriangle className="size-5 text-[#F59E0B] mx-auto mb-2" />
                      No evidence pinned yet. Pin details from news feeds, social wires, or OSINT indices to compile this case.
                    </div>
                  ) : (
                    activeCase.evidence.map((e, i) => (
                      <div key={e.id || i} className="relative pl-6">
                        <span className="absolute left-1.5 top-1.5 size-2 rounded-full bg-[#3B82F6]" />
                        {i < activeCase.evidence.length - 1 && (
                          <span className="absolute left-[9px] top-4 h-full w-px bg-[#263548]" />
                        )}
                        <div className="flex flex-wrap items-center gap-2 text-[9px] text-[#94A3B8]">
                          <span className="font-mono text-[#06B6D4] font-bold">{e.t}</span>
                          <Badge variant="secondary" className="h-4 px-1.5 text-[8px] bg-[#1A2332] text-white border-[#263548] rounded-none uppercase">
                            {e.type}
                          </Badge>
                          <span className="truncate text-[#94A3B8]/60 font-semibold">{e.src}</span>
                          <Tone tone={e.tone} />
                        </div>
                        <p className="mt-1 text-white text-[11px] leading-relaxed">{e.note}</p>
                      </div>
                    ))
                  )}
                </CardContent>
              </Card>

              <div className="space-y-4">
                {/* Relationships Card */}
                <Card className="bg-[#111827] border-[#263548] rounded">
                  <CardHeader className="pb-2 border-b border-[#263548] p-3 bg-[#0B1220]/20">
                    <CardTitle className="flex items-center gap-2 text-xs font-bold uppercase text-[#94A3B8]">
                      <Users2 className="size-4 text-[#3B82F6]" /> Target Entities
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-3 space-y-1.5 text-[10px] text-[#94A3B8]">
                    {activeCase.entities?.map((ent, idx) => (
                      <div key={idx} className="rounded border border-[#263548]/30 bg-[#0B1220]/30 p-2 flex items-center justify-between">
                        <span className="text-white font-bold uppercase">{ent}</span>
                        <Badge variant="outline" className="text-[8px] uppercase tracking-wider text-[#3B82F6] border-[#3B82F6]/20 bg-[#3B82F6]/5 rounded-none">Active Target</Badge>
                      </div>
                    ))}
                    <div className="rounded border border-[#263548]/30 bg-[#0B1220]/30 p-2 flex items-center justify-between">
                      <span className="text-white font-bold uppercase">{activeCase.target}</span>
                      <Badge variant="outline" className="text-[8px] uppercase tracking-wider text-[#EF4444] border-[#EF4444]/20 bg-[#EF4444]/5 rounded-none">Anchor Entity</Badge>
                    </div>
                  </CardContent>
                </Card>

                {/* Real-Time AI Case Triage Analysis */}
                <AICaseAnalysisCard activeCase={activeCase} />
              </div>
            </div>

            {/* Analyst comments card */}
            <Card className="bg-[#111827] border-[#263548] rounded">
              <CardHeader className="pb-2 border-b border-[#263548] p-3 bg-[#0B1220]/20">
                <CardTitle className="flex items-center gap-2 text-xs font-bold uppercase text-[#94A3B8]">
                  <MessageSquare className="size-4 text-[#3B82F6]" /> Analyst notes logs
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4 space-y-4">
                <div className="space-y-3">
                  {activeCase.notes ? (
                    activeCase.notes.split("\n").map((nLine, idx) => {
                      if (!nLine.trim()) return null;
                      return (
                        <div key={idx} className="flex gap-3 text-[10px]">
                          <span className="grid size-7 shrink-0 place-items-center rounded bg-[#1A2332] font-semibold text-white">
                            AC
                          </span>
                          <div className="min-w-0 flex-1 rounded border border-[#263548]/40 bg-[#0B1220]/30 p-2.5">
                            <p className="text-white text-[11px] leading-relaxed whitespace-pre-wrap">{nLine}</p>
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <div className="text-center text-[#94A3B8]/40 py-2">No analyst notes recorded yet.</div>
                  )}
                </div>
                <div className="space-y-3 pt-2">
                  <Textarea 
                    value={noteInput}
                    onChange={(e) => setNoteInput(e.target.value)}
                    placeholder="Enter analyst updates or investigation notes..." 
                    className="min-h-16 text-xs border-[#263548] bg-[#0B1220] text-white rounded font-mono" 
                  />
                  <div className="flex justify-between items-center">
                    <div className="flex gap-1.5 text-[9px] text-[#94A3B8]">
                      <span className="flex items-center gap-1"><Paperclip className="size-3" /> persistence: local</span>
                    </div>
                    <Button size="sm" onClick={handlePostNote} className="h-7 bg-[#3B82F6] hover:bg-[#3B82F6]/90 text-white uppercase text-[9px] font-mono px-3 rounded">Save Note</Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        ) : (
          <Card className="bg-[#111827] border-[#263548] rounded text-center p-8 text-[#94A3B8]/60 flex flex-col items-center justify-center">
            <AlertTriangle className="size-8 text-[#F59E0B] mb-2" />
            No investigation loaded. Create a new investigation in the sidebar to initialize case files.
          </Card>
        )}
      </div>
    </AppShell>
  );
}

// Dynamic Real-Time AI Case Triage Component
function AICaseAnalysisCard({ activeCase }: { activeCase: Investigation }) {
  const [aiAnalysis, setAiAnalysis] = useState<string>("");
  const [model, setModel] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleRunAnalysis = async () => {
    if (!activeCase) return;
    setLoading(true);
    setError("");
    try {
      const res = await llmCaseSummary({
        data: {
          title: activeCase.title,
          target: activeCase.target,
          description:
            activeCase.description ||
            "No description has been recorded for this case. Say so rather than inferring one.",
          // The analyst's own score. `|| 70` used to substitute a number nobody
          // assigned and then fed it to the model as "Analyst-assigned Risk
          // Score", which the brief would then reason from as if it were real.
          risk: typeof activeCase.risk === "number" ? activeCase.risk : -1,
        }
      });
      setAiAnalysis(res.text);
      setModel(res.model);
    } catch (err: any) {
      // The real upstream cause. A bare `catch {}` discarded it entirely, so a
      // revoked key and a truncated response looked identical.
      setError(err?.message ?? String(err));
    } finally {
      setLoading(false);
    }
  };

  // Deliberately NOT run on mount. This used to fire a model call every time the
  // analyst selected a case — clicking through eight cases spent eight calls of
  // a request-limited free tier without anyone asking for analysis.
  useEffect(() => {
    setAiAnalysis("");
    setError("");
    setModel("");
  }, [activeCase.id]);

  return (
    <Card className="bg-[#111827] border-[#263548] rounded">
      <CardHeader className="pb-2 border-b border-[#263548] p-3 bg-[#0B1220]/20 flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-xs font-bold uppercase text-[#94A3B8]">
          <Sparkles className="size-4 text-[#10B981]" /> Real-Time AI Case Triage
        </CardTitle>
        <Button
          size="sm"
          variant="ghost"
          onClick={handleRunAnalysis}
          className="h-6 px-2 text-[9px] font-mono text-[#10B981] hover:bg-[#10B981]/10 gap-1"
        >
          <RefreshCw className={`size-3 ${loading ? "animate-spin" : ""}`} />
          {aiAnalysis ? "Re-Analyze" : "Analyze"}
        </Button>
      </CardHeader>
      <CardContent className="p-3 space-y-2">
        {loading ? (
          <div className="py-4 text-center text-[10px] text-[#94A3B8] font-mono">
            <RefreshCw className="size-4 animate-spin mx-auto text-[#10B981] mb-1" />
            Analysing case evidence with the configured LLM...
          </div>
        ) : error ? (
          <div className="flex items-start gap-2 rounded border border-[#EF4444]/30 bg-[#EF4444]/5 p-2">
            <AlertTriangle className="size-3.5 shrink-0 text-[#EF4444]" />
            <div className="font-mono text-[10px] leading-relaxed text-[#EF4444]">
              <span className="font-bold">AI unavailable.</span> No analysis was produced.
              <div className="pt-0.5 opacity-80">{error}</div>
            </div>
          </div>
        ) : aiAnalysis ? (
          <>
            <div className="rounded border border-[#10B981]/20 bg-[#10B981]/5 p-3 text-[10px] text-[#CBD5E1] font-mono leading-relaxed whitespace-pre-wrap">
              {aiAnalysis}
            </div>
            <div className="font-mono text-[9px] text-[#64748B]">AI-generated · {model}</div>
          </>
        ) : (
          <div className="rounded border border-[#263548] bg-[#0B1220]/60 p-3 font-mono text-[10px] leading-relaxed text-[#94A3B8]">
            No analysis run for "{activeCase.target}". Press Analyze — this is a model call, so
            it runs only when asked rather than on every case you click.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

