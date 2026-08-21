// Organisms — feature blocks built from atoms (+ molecules) + business logic.
export { MarkdownView } from './MarkdownView';
export { TripDayNav } from './TripDayNav';
export { TOC } from './TOC';
export { Sidebar } from './Sidebar';
// Home is a screen (routed surface) — re-exported here so legacy barrel imports keep working.
export { Home } from '@/screens';
export { TopBar } from './TopBar';
export { NotificationBell } from './NotificationBell';
export { CommandPalette } from './CommandPalette';
export { ChatPanel } from './ChatPanel';
export { ChatHistory } from './ChatHistory';
export { TripAssets } from './TripAssets';
export { PlanActionsMenu, type ActionTarget } from './PlanActionsMenu';
export { TripMap } from './TripMap';
export { CityMap } from './CityMap';
export { MigrationOverlay } from './MigrationOverlay';
// Sections of the management console, not routed screens — they used to live in screens/ purely because
// that is where they were first written. A screen is a surface you navigate TO; these render inside one.
export { MemoryRecallPanel } from './MemoryRecallPanel';
export { LocalModelsPanel, type BuiltInModelRow } from './LocalModelsPanel';
