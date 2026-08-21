// The management console's sections. Each is an organism: a feature block with its own fetching and
// state, composed from atoms and molecules, mounted by screens/Manage.tsx against a tab.
//
// THEY SHARE A FOLDER because they change together and for nothing else. `ui/organisms` had become a
// flat mix of planner surfaces (TripMap, ChatPanel, Sidebar) and console surfaces, and adding eight
// more would have made the console the silent majority of a directory named after neither. A reader
// asking "what is in the 资源 tab" now has one place to look, and a change to the console cannot
// scatter across a list where TripDayNav sits between two of its panels.
//
// A panel owns its own types and formatters. That is deliberate, and it was verified rather than
// assumed: at the split, every helper in Manage.tsx was used by exactly ONE of these, so nothing was
// hoisted into a shared module that would have had a single consumer. The one real overlap — a count
// with an em-dash for "not loaded yet" — went to lib/format.ts as `formatCount`, because two modules
// need it. Apply that rule to the next one: two consumers, then lib.
export { EvalPanel } from './EvalPanel';
export { UpdateCard } from './UpdateCard';
export { CortexPanel } from './CortexPanel';
export { ResourcesPanel } from './ResourcesPanel';
export { LogsPanel } from './LogsPanel';
export { SettingsPanel } from './SettingsPanel';
export { JobsPanel } from './JobsPanel';
export { McpPanel } from './McpPanel';
// The first-run wizard: a modal Manage raises when settings.json reports setupCompleted=false. It sat
// in screens/ and was never in that barrel — Manage imported it by path — which was the file system
// admitting it is not a screen while the folder still claimed it was.
export { SetupWizard } from './SetupWizard';
// Mounted by CortexPanel / ResourcesPanel rather than by a tab of their own.
export { MemoryRecallPanel } from './MemoryRecallPanel';
export { LocalModelsPanel, type BuiltInModelRow } from './LocalModelsPanel';
