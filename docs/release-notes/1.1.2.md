### A fresh install starts on a brand-new PC

Gatherlight keeps your plans in a private version history, and the engine for that is Git. On a
computer that had never had Git installed, the very first launch stopped at
「初始化数据仓库」 with a message about a file it could not find — and the panel that offered to
install Git was itself unreachable until startup finished, so there was no way forward.

Now the app **installs the portable Git it needs by itself** on first launch (about 37 MB, once,
into your data folder) and carries on starting. Nothing to click, nothing to install first. If the
machine already has Git, nothing is downloaded. If there is no internet at that moment, the message
says so in one sentence and 「重试」 picks up where it left off.

### The assistant remembers your facts better

The memory engine underneath the assistant's fact recall was upgraded to a research-grade
forgetting model. What you will notice:

- **Recall now works properly in Chinese.** Before, a question in Chinese only found a fact when
  the fact contained the exact same phrase; now it matches the way search should.
- **Facts you actually use stay fresh — without self-reinforcing bias.** Looking a fact up keeps
  it from fading, but no longer permanently entrenches whatever the engine happened to surface.
- **Ranking is smarter**, using the same rank-fusion method search engines use to combine signals.
- **A second opinion on every lookup.** When the assistant searches its memory, a small model now
  double-checks which of the results actually answer the question — so the best answer stops
  hiding behind merely-similar ones.
- **Facts about the same person or place find each other.** New facts are labelled with what they
  are *about*, so "the visa appointment" and "the embassy's address" connect even when neither
  mentions the other.

Nothing to do on your side: existing memory carries over as-is on first start.
