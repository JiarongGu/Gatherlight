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
// The management console's sections live in ./console — a folder rather than nine more entries here,
// because they change together and this list is otherwise the planner's. Import them from
// '@/ui/organisms/console'; they are deliberately NOT re-exported through this barrel, so a planner
// surface reaching for a console panel has to say so.
