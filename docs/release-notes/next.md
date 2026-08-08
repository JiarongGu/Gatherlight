A repair release. Everything here is about backups being restorable and the app staying inside its own
folder — **if you are on 1.1.0, update before you rely on a backup.**

### Backups taken on 1.1.0 could fail to restore

1.1.0 began tidying its version history automatically, which was the right idea and shipped without the
other half. Tidying moves some internal bookkeeping into a compressed form, and a zip cannot carry the
empty folders that leaves behind — so a restore could produce a data folder the app refused to open,
reporting a git error on startup.

**Nothing was ever lost.** The history was intact the whole time; the folder was simply missing an empty
directory. This version rebuilds it during restore, so **archives already taken on 1.1.0 restore
correctly** once you are on 1.1.1 — you do not need to re-export anything. Newly written backups carry
the structure themselves, so they also survive being unzipped by hand.

### Restoring no longer loses your pages, or forgets what you approved

Two things were quietly missing from every backup:

- **Your site pages.** Any page the assistant built for you — a trip dashboard, a budget view — was not
  in the archive, so a restore lost it. This was easy to miss: the welcome page reappears on its own,
  so the section looked intact while your own pages were gone.
- **Which capabilities you had approved.** A restore silently reset those to none, along with any
  customisation of which folders the assistant may write to. The app came back working and simply
  forgot what it was allowed to do.

Both now travel with the backup.

### Gatherlight stays inside its own folder

If your data folder happened to sit inside another version-controlled project, a restore could write a
commit into **that** project instead of Gatherlight's own history. It now refuses to reach outside its
folder, and says so plainly rather than succeeding in the wrong place.

### Fixes worth naming

- The PDF and document tools now use the Node runtime **Gatherlight downloads and manages**, rather
  than whichever one happens to be installed on the machine. Same behaviour on every install, and one
  less thing to have set up — matching how git and the sandbox already worked.
