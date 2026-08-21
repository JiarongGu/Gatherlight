### You choose how the assistant's memory search works

Finding things in the assistant's memory now has three switches, in the **校准 · Cortex** panel alongside
the models each part of the assistant uses:

- **公式 · Formula** — always on, costs nothing, needs no setup. Everything else builds on it.
- **Claude CLI 增强** — labels each fact as it is saved and checks which results actually answered your
  question. Noticeably better recall, but it **costs one model call every time a fact is saved and every
  time memory is searched**. This has been running since the last release with no way to turn it off; it
  stays on by default, but now you can decline it, and the switch takes effect immediately.
- **本地模型** — uses a model running on your own computer to search by *meaning*, so a question worded
  completely differently from the note still finds it: asking for "places where you must take off your
  shoes" finds a note that says *remove their shoes at the gate*. Costs disk space and your own computer's
  time rather than tokens, and **nothing leaves the machine**. Off unless you turn it on; the panel
  recommends a model for your computer and explains why, and you can pick a different one.

They sit in 校准 · Cortex rather than in a panel of their own because the model the Claude CLI enrichment
uses is a row in that same panel — the switch and the model it drives belong together. That model is now
adjustable there like the others; it was always meant to be, and simply wasn't listed.

The only memory-related item in **资源 · Resources** is the Ollama download itself, which belongs there
with the other large files fetched onto your computer.

The first start after updating rebuilds the fact index, and the startup screen shows it under 补全事实索引.
You don't need to do anything, but on a large collection of facts that step takes a little longer than
usual, once. Your facts are never touched by a rebuild; what resets is the ranking weight the index had
built up from use.

### The assistant installs its own engine

Chat is powered by the Claude command-line tool, and until now Gatherlight simply expected to find one
already on the computer. On a machine that had never had it, every conversation failed with
「计划阶段未能完成(CLI 报告错误),请重试」 — a message that named neither the cause nor the cure, and
invited you to retry something that could never work.

Now it is listed in **设置 · 资源 · Resources** alongside Chromium and Git: one click installs it
(about 265 MB, once, into your data folder so app updates never wipe it), and the panel tells you when
a newer version is out so you can update on your own schedule. The app checks the download's fingerprint
against Anthropic's published checksum before it will run it.

Two things worth knowing:

- **The app still comes up when the tool is missing.** Only chat is affected — settings, your plans,
  browsing and imports all work — because the panel that installs it has to stay reachable.
- **Signing in is the one step we cannot do for you.** After installing, run `claude auth login` once
  on the computer running Gatherlight. Until you do, the app now says exactly that — which tool,
  which command — instead of a generic error, and the 资源 panel shows the account once you are in.
