Gatherlight becomes a **container for your planner** rather than an app with an assistant bolted on.
The agent now works inside walls the app enforces, and everything it can reach — its tools, its pages,
its own new capabilities — passes a gate you control.

### Your planner can build its own pages

The assistant can now write pages for your site — a trip dashboard, a budget view — and you approve
them by **looking at the rendered page**, not at JSON. A page that would not display cannot be
committed at all.

Pages read **live data**. A table of your trips shows what is in `plans/` when you open it, not what
was there when the page was written, so a dashboard stops quietly going stale. There are charts now
too, for the times eleven numbers in a table were the wrong answer.

### Nothing it does happens without you seeing it first

- It can **propose a new tool** for itself. You see what the tool may read, write and reach before
  deciding; approved, it runs sandboxed with no network unless you granted it.
- It can **ask to connect an external service**. That card now says plainly that such a service runs
  on your computer with your privileges — because it does, and nothing else was telling you.
- A blocked action becomes **a decision you can make**, instead of the assistant quietly working
  around it.

### It waits for you properly

A decision left open — a plan to approve, a diff to review, a question to answer — now **survives a
restart**, including the automatic ones after an update. Previously, restarting while something was
waiting threw the work away. The diff you approve is always re-read from disk, so what you approve is
what gets saved.

Past conversations are readable again, and a restart no longer empties the chat.

### It remembers what keeps proving useful

The assistant has always been able to note a verified fact — a checked price, a venue's opening hours,
a booking policy — and look it up again later. Until now every one of those ranked the same forever, so
a price you checked in March competed with one you checked yesterday.

Facts now **fade when they stop being used** and **firm up when they keep being right**. Nothing is
deleted: a faint fact still comes back when it's the best thing you have, and it tells the assistant how
faint it has become. Facts looked up together also become **linked**, so recalling one can surface a
related one you never searched for — the booking policy turning up beside the price.

### It knows what it can already do

Gatherlight ships purpose-built lookups — fares for a route across dates, room rates, whether a
restaurant actually exists and which link is really it, a hotel's address and phone, a flight number,
visa rules from official sources. **The assistant had never been told any of them existed**, so it fell
back to generic web reading and, often enough, to asking you.

The same gap explained something quieter: it had stored a handful of verified facts and never once read
them back. It now checks what it already confirmed before researching again, and reaches for the
specific tool instead of the general one. Expect fewer repeated questions about things you settled
weeks ago.

### Your privacy, tightened

Every image the app shows — map tiles, library covers, pictures inside plans — now loads **through
your own machine**. Before, opening a page could make your browser fetch directly from whatever host
an image URL named, revealing your address and what you were reading. Nothing on a page reaches the
internet on its own any more.

### Backups actually restore everything

Backups now include the external services you had connected, so restoring brings them back instead of
silently losing them. **A backup file now contains credentials** — the file itself says so — so keep
it somewhere you would keep a password.

Restoring an older backup no longer rolls back the app's own safety files. That bug showed up as a
visa PDF refusing to generate; underneath, it had quietly reverted the assistant's sandbox to an older
version until the next restart.

### Fixes worth naming

- The server refused to start when LAN access was enabled with the documented opt-in — it ignored the
  setting entirely. If you chose LAN or WAN access and the app would not launch, that was this.
- Visa itinerary forms are now described by an **editable file** rather than baked into the app, so a
  revised form no longer needs a new Gatherlight release. Any field the form does not have is
  reported by name instead of silently left blank.
- If an update failed to install, Gatherlight could **hang on startup** instead of falling back to the
  version you already had. It now starts, every time.
- The welcome page's button did nothing and looked greyed out. It opens your household file now.
- **Backup files were quietly growing** — roughly a megabyte per restore, none of it your data. It was
  unpacked version history riding along inside the archive. Gatherlight now tidies that up on its own,
  and a backup taken today is smaller than one from before the feature existed. No history is
  discarded; it is only stored properly.
