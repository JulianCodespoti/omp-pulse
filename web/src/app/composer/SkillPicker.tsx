import { BookOpenIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { OmpCommand } from "../commands/command-registry";
import { availableSkills } from "../../domain/skill-insertion";
import { SearchField } from "../ui/SearchField";
import { BottomSheet, SheetEmpty, SheetGroup, SheetRow } from "../ui/Sheet";

/** Selection edits the current draft; it never dispatches a command. */
export function SkillPicker({ open, onOpenChange, commands, onPick, returnFocus }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commands: OmpCommand[] | undefined;
  onPick: (command: OmpCommand) => void;
  returnFocus: () => HTMLElement | false;
}) {
  const [query, setQuery] = useState("");
  useEffect(() => { if (open) setQuery(""); }, [open]);
  const skills = useMemo(() => {
    const q = query.trim().toLowerCase();
    return availableSkills(commands).filter(skill => !q
      || `${skill.name} ${skill.description ?? ""}`.toLowerCase().includes(q));
  }, [commands, query]);
  return (
    <BottomSheet open={open} onOpenChange={onOpenChange} title="Insert skill" testId="skill-picker" returnFocus={returnFocus}>
      <SearchField value={query} onChange={setQuery} placeholder="Find a skill" testId="skill-search" className="mb-2" />
      <p className="mb-2 text-meta text-muted-foreground">Insert at your caret. Your draft and photos stay editable until you send.</p>
      {skills.length === 0 ? <SheetEmpty icon={<BookOpenIcon />} title={query ? "No matching skills" : "No skills in this command list"} /> : (
        <SheetGroup testId="skill-list">
          {skills.map(skill => <SheetRow key={skill.name} testId="skill-row" title={`/${skill.name}`} meta={skill.description} onClick={() => onPick(skill)} />)}
        </SheetGroup>
      )}
    </BottomSheet>
  );
}
