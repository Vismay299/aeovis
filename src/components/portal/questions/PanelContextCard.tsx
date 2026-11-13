"use client";

import * as React from "react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";
import type { QuestionsState } from "./hooks/useQuestions";
import { useQuestionMutations, isRevisionConflict } from "./hooks/useQuestionMutations";

const COUNTRIES = [
  { value: "in", label: "India" },
  { value: "us", label: "United States" },
  { value: "gb", label: "United Kingdom" },
  { value: "sg", label: "Singapore" },
  { value: "ae", label: "United Arab Emirates" },
  { value: "ca", label: "Canada" },
  { value: "au", label: "Australia" },
];

export function PanelContextCard({
  brandKey,
  state,
  onConflict,
}: {
  brandKey: string;
  state: QuestionsState;
  onConflict: () => void;
}) {
  const mutations = useQuestionMutations(brandKey);
  const [open, setOpen] = useState(false);
  const [persona, setPersona] = useState(state.settings.persona || "");
  const [country, setCountry] = useState(state.settings.country || "in");
  const [language, setLanguage] = useState(state.settings.language || "en");

  React.useEffect(() => {
    setPersona(state.settings.persona || "");
    setCountry(state.settings.country || "in");
    setLanguage(state.settings.language || "en");
  }, [state.settings.persona, state.settings.country, state.settings.language, state.revision]);

  async function save() {
    try {
      await mutations.patch.mutateAsync({
        expectedRevision: state.revision,
        settings: { persona: persona.trim() || undefined, country, language },
      });
      setOpen(false);
    } catch (e) {
      if (isRevisionConflict(e)) onConflict();
      else toast.error((e as any)?.message || "Could not save settings.");
    }
  }

  return (
    <div className="rounded-lg border">
      <button
        type="button"
        className="flex w-full items-center justify-between p-3 text-left font-medium"
        onClick={() => setOpen((o) => !o)}
      >
        Audience and market
        <span className="text-sm text-muted-foreground">{open ? "Hide" : "Show"}</span>
      </button>
      {open ? (
        <div className="space-y-4 border-t p-4">
          <div className="space-y-1.5">
            <Label htmlFor="panel-persona">Who asks these questions</Label>
            <Input id="panel-persona" value={persona} onChange={(e) => setPersona(e.target.value)} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Country</Label>
              <Select value={country} onValueChange={(v) => setCountry(v ?? "in")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {COUNTRIES.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="panel-language">Language</Label>
              <Input id="panel-language" value={language} onChange={(e) => setLanguage(e.target.value)} />
              <p className="text-xs text-muted-foreground">Language code, e.g. en</p>
            </div>
          </div>
          <div>
            <Button onClick={save} disabled={mutations.patch.isPending}>Save</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
